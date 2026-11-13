jest.mock('bcryptjs', () => ({ hash: jest.fn(), compare: jest.fn() }));

import { UnauthorizedException } from '@nestjs/common';
import { AuthProvider } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { JwtService } from '@nestjs/jwt';

describe('AuthService', () => {
  const tx = {
    refreshToken: { create: jest.fn(), updateMany: jest.fn() },
    emailActionToken: { updateMany: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
    user: { update: jest.fn() },
    authIdentity: { upsert: jest.fn() },
  };
  const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
  const prisma = {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    refreshToken: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
    emailActionToken: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    authIdentity: { findUnique: jest.fn(), create: jest.fn(), upsert: jest.fn() },
    $transaction: transaction,
  } as unknown as PrismaService;
  const jwt = { signAsync: jest.fn() } as unknown as JwtService;
  const mail = { sendActionLink: jest.fn() } as unknown as MailService;
  let service: AuthService;

  beforeEach(() => {
    for (const model of [
      prisma.user as unknown as Record<string, jest.Mock>,
      prisma.refreshToken as unknown as Record<string, jest.Mock>,
      prisma.emailActionToken as unknown as Record<string, jest.Mock>,
      prisma.authIdentity as unknown as Record<string, jest.Mock>,
      tx.refreshToken,
      tx.emailActionToken,
      tx.user,
      tx.authIdentity,
    ]) Object.values(model).forEach((mock) => mock.mockReset());
    transaction.mockReset();
    transaction.mockImplementation((callback) => callback(tx));
    (jwt.signAsync as jest.Mock).mockReset();
    (mail.sendActionLink as jest.Mock).mockReset();
    (bcrypt.compare as jest.Mock).mockReset();
    (bcrypt.hash as jest.Mock).mockReset();
    service = new AuthService(prisma, jwt, mail);
  });

  it('normalizes email on login, verifies the password and creates a session', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user-1', email: 'user@example.com', emailVerified: true, locale: 'en',
      createdAt: new Date('2026-10-10T09:00:00.000Z'), identities: [{ provider: AuthProvider.PASSWORD, passwordHash: 'stored-hash' }],
      subscription: null,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (prisma.refreshToken.create as jest.Mock).mockResolvedValue({ id: 'refresh-1' });
    (jwt.signAsync as jest.Mock).mockResolvedValue('access-token');

    const result = await service.login(' User@Example.com ', 'correct-password');

    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'user@example.com' } }));
    expect(bcrypt.compare).toHaveBeenCalledWith('correct-password', 'stored-hash');
    expect(result).toMatchObject({
      user: { id: 'user-1', email: 'user@example.com', providers: ['password'], emailVerified: true },
      accessToken: 'access-token', expiresIn: 900,
    });
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(prisma.refreshToken.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user-1', tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    }));
  });

  it('returns the same invalid-credentials error for a wrong password', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user-1', email: 'user@example.com', emailVerified: true, locale: 'en', createdAt: new Date(),
      identities: [{ provider: AuthProvider.PASSWORD, passwordHash: 'stored-hash' }], subscription: null,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(service.login('user@example.com', 'wrong-password')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('does not disclose whether an email exists during password recovery', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(service.forgotPassword(' Missing@Example.com ')).resolves.toBeUndefined();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'missing@example.com' } });
    expect(transaction).not.toHaveBeenCalled();
    expect(mail.sendActionLink).not.toHaveBeenCalled();
  });

  it('rotates a valid refresh token inside a transaction', async () => {
    const current = {
      id: 'refresh-old', userId: 'user-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'user-1', email: 'user@example.com' },
    };
    (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValue(current);
    tx.refreshToken.create.mockResolvedValue({ id: 'refresh-next' });
    tx.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    (jwt.signAsync as jest.Mock).mockResolvedValue('rotated-access-token');

    const result = await service.refresh('old-raw-refresh-token');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'refresh-old', revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: expect.objectContaining({ revokedAt: expect.any(Date), replacedBy: 'refresh-next' }),
    }));
    expect(result).toMatchObject({ accessToken: 'rotated-access-token', expiresIn: 900 });
    expect(result.refreshToken).toEqual(expect.any(String));
  });


  it('returns display-safe saved-card details from GET /me without exposing the provider method ID', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      emailVerified: true,
      locale: 'en',
      createdAt: new Date('2026-10-10T09:00:00.000Z'),
      identities: [{ provider: AuthProvider.PASSWORD, passwordHash: 'stored-hash' }],
      subscription: {
        status: 'ACTIVE',
        provider: 'YOOKASSA',
        planId: 'weekly',
        trialEnd: null,
        currentPeriodEnd: new Date('2026-10-27T09:00:00.000Z'),
        cancelAtPeriodEnd: false,
        providerRef: 'provider-private-payment-method-id',
        paymentMethodType: 'bank_card',
        paymentMethodCardType: 'Visa',
        paymentMethodLast4: '4444',
        paymentMethodExpiryMonth: '12',
        paymentMethodExpiryYear: '2030',
      },
    });

    const result = await service.getMe('user-1');

    expect(result.subscription).toMatchObject({
      provider: 'yookassa',
      hasPaymentMethod: true,
      paymentMethod: { type: 'bank_card', cardType: 'Visa', last4: '4444', expiryMonth: '12', expiryYear: '2030' },
    });
    expect(JSON.stringify(result)).not.toContain('provider-private-payment-method-id');
  });

  it('reports legacy saved tokens even when card display metadata is missing', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      emailVerified: true,
      locale: 'en',
      createdAt: new Date('2026-10-10T09:00:00.000Z'),
      identities: [],
      subscription: {
        status: 'ACTIVE',
        provider: 'YOOKASSA',
        planId: 'weekly',
        trialEnd: null,
        currentPeriodEnd: new Date('2026-10-27T09:00:00.000Z'),
        cancelAtPeriodEnd: false,
        providerRef: 'legacy-saved-method-id',
        paymentMethodType: null,
        paymentMethodCardType: null,
        paymentMethodLast4: null,
        paymentMethodExpiryMonth: null,
        paymentMethodExpiryYear: null,
      },
    });

    const result = await service.getMe('user-1');

    expect(result.subscription).toMatchObject({ hasPaymentMethod: true, paymentMethod: null });
    expect(JSON.stringify(result)).not.toContain('legacy-saved-method-id');
  });

  it('rejects refresh replay when the old token was claimed by another request', async () => {
    (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValue({
      id: 'refresh-old', userId: 'user-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'user-1', email: 'user@example.com' },
    });
    tx.refreshToken.create.mockResolvedValue({ id: 'refresh-next' });
    tx.refreshToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.refresh('old-raw-refresh-token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });
});
