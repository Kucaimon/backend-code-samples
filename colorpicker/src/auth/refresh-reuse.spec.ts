import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

describe('Low-2: reusing a rotated refresh token revokes the tokens issued after it', () => {
  // Chain: t1 (presented again) → t2 → t3 (the live token, possibly held by an attacker).
  const rows: Record<string, { id: string; userId: string; revokedAt: Date | null; replacedBy: string | null; expiresAt: Date }> = {};
  const prisma = {
    refreshToken: {
      findUnique: jest.fn(async ({ where }: { where: { tokenHash?: string; id?: string } }) => (where.tokenHash ? rows.t1 : rows[where.id!]) ?? null),
      updateMany: jest.fn(),
    },
  };
  const service = new AuthService(prisma as unknown as PrismaService, {} as JwtService, {} as MailService);
  function chain(rotatedMsAgo: number) {
    const future = new Date(Date.now() + 86_400_000);
    rows.t1 = { id: 't1', userId: 'u', revokedAt: new Date(Date.now() - rotatedMsAgo), replacedBy: 't2', expiresAt: future };
    rows.t2 = { id: 't2', userId: 'u', revokedAt: new Date(Date.now() - rotatedMsAgo / 2), replacedBy: 't3', expiresAt: future };
    rows.t3 = { id: 't3', userId: 'u', revokedAt: null, replacedBy: null, expiresAt: future };
    prisma.refreshToken.updateMany.mockClear();
  }

  it('reuse after the grace window revokes every descendant and answers invalid_refresh_token', async () => {
    chain(60_000);
    await expect(service.refresh('stolen-old-token')).rejects.toMatchObject({ response: { code: 'invalid_refresh_token' } });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['t2', 't3'] }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('reuse within 10 s of rotation (parallel tabs) does not revoke the chain', async () => {
    chain(2_000);
    await expect(service.refresh('raced-token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});
