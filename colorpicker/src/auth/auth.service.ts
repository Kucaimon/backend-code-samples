import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthProvider, EmailTokenType, Prisma } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { hasSavedPaymentMethod, toPublicPaymentMethod } from '../billing/payment-method';
import { localeFromAcceptLanguage, normalizeLocale } from '../common/locale';

const ACCESS_TTL_SECONDS = 900;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
// A rotated token presented again within this window is treated as a parallel refresh
// (two tabs), not theft, so the chain is not revoked.
const REFRESH_REUSE_GRACE_MS = 10_000;
const INVALID_CREDENTIALS = { code: 'invalid_credentials', message: 'Email or password is invalid' };
// bcrypt (cost 12) of a random value nobody knows. Comparing against it when there is no
// password hash keeps login timing the same whether or not the email is registered.
const DUMMY_PASSWORD_HASH = '$2b$12$1y7C3p09xOjOFsfrDZ3FI.NOv04VPNzOALePyEPWZfE2jUn1.QslG';

type PublicUserRow = Prisma.UserGetPayload<{ include: { identities: true; subscription: true } }>;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
  ) {}

  async register(input: { email: string; password: string; locale?: string; acceptLanguage?: string }) {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new ConflictException({ code: 'email_taken', message: 'Email is already registered' });

    const passwordHash = await bcrypt.hash(input.password, 12);
    const locale = normalizeLocale(input.locale) ?? localeFromAcceptLanguage(input.acceptLanguage) ?? 'en';
    let user: PublicUserRow;
    try {
      user = await this.prisma.user.create({
        data: {
          email,
          locale,
          identities: { create: { provider: AuthProvider.PASSWORD, providerUserId: email, passwordHash } },
        },
        include: { identities: true, subscription: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'email_taken', message: 'Email is already registered' });
      }
      throw error;
    }
    await this.createAndSendEmailToken(user, EmailTokenType.VERIFY_EMAIL);
    const session = await this.createSession(user.id, user.email);
    return { user: this.toPublicUser(user), ...session };
  }

  async login(emailInput: string, password: string) {
    const email = emailInput.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email }, include: { identities: true, subscription: true },
    });
    const identity = user?.identities.find((item) => item.provider === AuthProvider.PASSWORD);
    const valid = await bcrypt.compare(password, identity?.passwordHash ?? DUMMY_PASSWORD_HASH) && Boolean(identity?.passwordHash);
    if (!user || !valid) throw new UnauthorizedException(INVALID_CREDENTIALS);
    const session = await this.createSession(user.id, user.email);
    return { user: this.toPublicUser(user), ...session };
  }

  async refresh(rawToken?: string) {
    if (!rawToken) throw new UnauthorizedException({ code: 'invalid_refresh_token', message: 'Refresh token is invalid or expired' });
    const tokenHash = this.hashToken(rawToken);
    const current = await this.prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
    const now = new Date();
    if (!current || current.revokedAt || current.expiresAt <= now) {
      if (current?.revokedAt && current.replacedBy && now.getTime() - current.revokedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
        await this.revokeDescendants(current.replacedBy, current.userId, now);
      }
      throw new UnauthorizedException({ code: 'invalid_refresh_token', message: 'Refresh token is invalid or expired' });
    }

    const rawNext = randomBytes(32).toString('base64url');
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: {
          userId: current.userId,
          tokenHash: this.hashToken(rawNext),
          expiresAt: new Date(now.getTime() + REFRESH_TTL_SECONDS * 1000),
        },
      });
      const claimed = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now, replacedBy: created.id },
      });
      if (claimed.count !== 1) {
        throw new UnauthorizedException({ code: 'invalid_refresh_token', message: 'Refresh token is invalid or expired' });
      }
    });
    const accessToken = await this.jwt.signAsync(
      { sub: current.userId, email: current.user.email, type: 'access' },
      { expiresIn: ACCESS_TTL_SECONDS },
    );
    return { accessToken, refreshToken: rawNext, expiresIn: ACCESS_TTL_SECONDS };
  }

  async logout(rawToken?: string): Promise<void> {
    if (!rawToken) return;
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async loginSocial(provider: AuthProvider, providerUserId: string, emailInput: string, emailVerified: boolean) {
    const email = emailInput.trim().toLowerCase();
    const existingIdentity = await this.prisma.authIdentity.findUnique({
      where: { provider_providerUserId: { provider, providerUserId } },
      include: { user: { include: { identities: true, subscription: true } } },
    });
    if (existingIdentity) {
      let existingUser = existingIdentity.user;
      if (
        !existingUser.emailVerified &&
        (provider === AuthProvider.GOOGLE || provider === AuthProvider.APPLE)
      ) {
        existingUser = await this.prisma.user.update({
          where: { id: existingUser.id },
          data: { emailVerified: true },
          include: { identities: true, subscription: true },
        });
      }
      const session = await this.createSession(existingUser.id, existingUser.email);
      return { user: this.toPublicUser(existingUser), ...session };
    }

    let user = await this.prisma.user.findUnique({ where: { email }, include: { identities: true, subscription: true } });
    if (user) {
      // Do not link an OAuth identity to an existing account using an email
      // the provider has not verified. Facebook's Graph /me email field does
      // not include a trusted email_verified claim in this integration.
      if (!emailVerified) {
        throw new UnauthorizedException({
          code: 'oauth_failed',
          message: 'Cannot link an OAuth identity using an unverified provider email',
        });
      }
      if (!user.emailVerified) {
        // Pre-account-takeover protection: whoever registered this email with a
        // password never proved they own it, while the provider just did. Drop
        // that password and every session it created before linking.
        const userId = user.id;
        await this.prisma.$transaction(async (tx) => {
          await tx.authIdentity.deleteMany({ where: { userId, provider: AuthProvider.PASSWORD } });
          await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        });
      }
      try {
        await this.prisma.authIdentity.create({ data: { userId: user.id, provider, providerUserId } });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        const concurrentIdentity = await this.prisma.authIdentity.findUnique({
          where: { provider_providerUserId: { provider, providerUserId } },
          include: { user: { include: { identities: true, subscription: true } } },
        });
        if (concurrentIdentity) {
          let concurrentUser = concurrentIdentity.user;
          if (
            !concurrentUser.emailVerified &&
            (provider === AuthProvider.GOOGLE || provider === AuthProvider.APPLE)
          ) {
            concurrentUser = await this.prisma.user.update({
              where: { id: concurrentUser.id },
              data: { emailVerified: true },
              include: { identities: true, subscription: true },
            });
          }
          const session = await this.createSession(concurrentUser.id, concurrentUser.email);
          return { user: this.toPublicUser(concurrentUser), ...session };
        }
        throw error;
      }
      if (emailVerified && !user.emailVerified) {
        await this.prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
      }
      user = await this.prisma.user.findUniqueOrThrow({
        where: { id: user.id }, include: { identities: true, subscription: true },
      });
    } else {
      try {
        user = await this.prisma.user.create({
          data: {
            email,
            emailVerified,
            locale: 'en',
            identities: { create: { provider, providerUserId } },
          },
          include: { identities: true, subscription: true },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const concurrentIdentity = await this.prisma.authIdentity.findUnique({
            where: { provider_providerUserId: { provider, providerUserId } },
            include: { user: { include: { identities: true, subscription: true } } },
          });
          if (concurrentIdentity) user = concurrentIdentity.user;
          else throw error;
        } else throw error;
      }
    }

    if (!emailVerified && !user.emailVerified) {
      await this.createAndSendEmailToken(user, EmailTokenType.VERIFY_EMAIL);
    }
    const session = await this.createSession(user.id, user.email);
    return { user: this.toPublicUser(user), ...session };
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId }, include: { identities: true, subscription: true },
    });
    if (!user) throw new UnauthorizedException({ code: 'unauthorized', message: 'User is not available' });
    return this.toPublicUser(user);
  }

  async updateLocale(userId: string, locale: string) {
    const user = await this.prisma.user.update({
      where: { id: userId }, data: { locale }, include: { identities: true, subscription: true },
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException({ code: 'not_found', message: 'User was not found' });
      }
      throw error;
    });
    return this.toPublicUser(user);
  }

  async verifyEmail(rawToken: string): Promise<void> {
    const item = await this.findActionToken(rawToken, EmailTokenType.VERIFY_EMAIL);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.emailActionToken.updateMany({
        where: { id: item.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new UnprocessableEntityException({ code: 'invalid_token', message: 'Token is invalid or expired' });
      }
      await tx.user.update({ where: { id: item.userId }, data: { emailVerified: true } });
    });
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.emailVerified) return;
    await this.createAndSendEmailToken(user, EmailTokenType.VERIFY_EMAIL);
  }

  async forgotPassword(emailInput: string): Promise<void> {
    const email = emailInput.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Always returns the same public response whether or not the account exists.
    if (!user) return;
    await this.createAndSendEmailToken(user, EmailTokenType.RESET_PASSWORD);
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const item = await this.findActionToken(rawToken, EmailTokenType.RESET_PASSWORD);
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.emailActionToken.updateMany({
        where: { id: item.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new UnprocessableEntityException({ code: 'invalid_token', message: 'Token is invalid or expired' });
      }
      await tx.emailActionToken.updateMany({
        where: { userId: item.userId, type: EmailTokenType.RESET_PASSWORD, usedAt: null, id: { not: item.id } },
        data: { usedAt: new Date() },
      });
      await tx.authIdentity.upsert({
        where: { userId_provider: { userId: item.userId, provider: AuthProvider.PASSWORD } },
        create: { userId: item.userId, provider: AuthProvider.PASSWORD, providerUserId: item.user.email, passwordHash },
        update: { providerUserId: item.user.email, passwordHash },
      });
      await tx.user.update({ where: { id: item.userId }, data: { emailVerified: true } });
      await tx.refreshToken.updateMany({ where: { userId: item.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
  }

  /** A rotated refresh token was used again: whoever holds its successors may have stolen it. */
  private async revokeDescendants(firstId: string, userId: string, now: Date): Promise<void> {
    const ids: string[] = [];
    let next: string | null = firstId;
    while (next && ids.length < 1000 && !ids.includes(next)) {
      ids.push(next);
      const row: { replacedBy: string | null } | null = await this.prisma.refreshToken.findUnique({ where: { id: next }, select: { replacedBy: true } });
      next = row?.replacedBy ?? null;
    }
    await this.prisma.refreshToken.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: now } });
    this.logger.warn(`Refresh token reuse detected for user ${userId}; revoked ${ids.length} descendant token(s)`);
  }

  private async createSession(userId: string, email: string) {
    const rawRefreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(rawRefreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
      },
    });
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email, type: 'access' },
      { expiresIn: ACCESS_TTL_SECONDS },
    );
    return { accessToken, refreshToken: rawRefreshToken, expiresIn: ACCESS_TTL_SECONDS };
  }

  private async createAndSendEmailToken(user: { id: string; email: string; locale: string }, type: EmailTokenType) {
    const rawToken = randomBytes(32).toString('base64url');
    const validityMs = type === EmailTokenType.VERIFY_EMAIL ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
    await this.prisma.$transaction(async (tx) => {
      await tx.emailActionToken.updateMany({
        where: { userId: user.id, type, usedAt: null }, data: { usedAt: new Date() },
      });
      await tx.emailActionToken.create({
        data: {
          userId: user.id, type, tokenHash: this.hashToken(rawToken),
          expiresAt: new Date(Date.now() + validityMs),
        },
      });
    });
    try {
      await this.mail.sendActionLink({ to: user.email, locale: user.locale, type, token: rawToken });
    } catch (error) {
      // Do not turn a successfully created account/reset request into a different public result.
      // A production outbox/retry worker should handle delivery retries.
      this.logger.error(`Failed to send ${type} email to ${user.email}`, error instanceof Error ? error.stack : String(error));
    }
  }

  private async findActionToken(rawToken: string, type: EmailTokenType) {
    // Issued tokens are 43 characters; anything far outside that is a broken link.
    if (rawToken.length < 20 || rawToken.length > 512) {
      throw new UnprocessableEntityException({ code: 'invalid_token', message: 'Token is invalid or expired' });
    }
    const item = await this.prisma.emailActionToken.findUnique({
      where: { tokenHash: this.hashToken(rawToken) }, include: { user: true },
    });
    if (!item || item.type !== type || item.usedAt || item.expiresAt <= new Date()) {
      throw new UnprocessableEntityException({ code: 'invalid_token', message: 'Token is invalid or expired' });
    }
    return item;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toPublicUser(user: PublicUserRow) {
    const subscription = user.subscription;
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      providers: user.identities.map((identity) => identity.provider.toLowerCase()),
      locale: user.locale,
      subscription: subscription ? {
        status: subscription.status.toLowerCase(),
        provider: subscription.provider.toLowerCase(),
        planId: subscription.planId,
        trialEnd: subscription.trialEnd?.toISOString() ?? null,
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        hasPaymentMethod: hasSavedPaymentMethod(subscription),
        paymentMethod: toPublicPaymentMethod(subscription),
      } : null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
