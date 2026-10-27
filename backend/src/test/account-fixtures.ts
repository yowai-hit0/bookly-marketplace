import type { AppUser, PrismaClient } from '@prisma/client';
import { hashPassword } from '../auth/password.js';
import { issueToken } from '../auth/token.js';
import { linkClientRows } from '../booking/client.js';

/**
 * Client accounts for the dashboard suites (marketplace-spec.md Phase 8).
 * Imported by tests only.
 *
 * A verified account is linked to the client rows under its address, as
 * verification links them (marketplace-data-model.md §2.8); an unverified one
 * is linked to nothing.
 */

/** The password every fixture account with one is given. */
export const ACCOUNT_PASSWORD = 'a long enough client password';

let hashed: Promise<string> | undefined;

/** One real Argon2id hash of ACCOUNT_PASSWORD, computed once per suite file. */
export function accountPasswordHash(): Promise<string> {
  hashed ??= hashPassword(ACCOUNT_PASSWORD);
  return hashed;
}

export type AccountSeed = {
  email: string;
  fullName?: string | null;
  /** Default: ACCOUNT_PASSWORD. Null for a Google-only account (give it a `googleSub`). */
  password?: string | null;
  googleSub?: string | null;
  /** Default true. */
  verified?: boolean;
  phone?: string | null;
};

export async function createClientAccount(prisma: PrismaClient, seed: AccountSeed): Promise<AppUser> {
  const password = seed.password === undefined ? ACCOUNT_PASSWORD : seed.password;
  const passwordHash = password === null ? null : password === ACCOUNT_PASSWORD ? await accountPasswordHash() : await hashPassword(password);
  const verified = seed.verified ?? true;
  const user = await prisma.appUser.create({
    data: {
      email: seed.email,
      role: 'client',
      fullName: seed.fullName === undefined ? 'Aline Uwase' : seed.fullName,
      passwordHash,
      googleSub: seed.googleSub ?? null,
      phone: seed.phone ?? null,
      emailVerifiedAt: verified ? new Date('2026-09-01T06:00:00Z') : null,
    },
  });
  if (verified) await linkClientRows(prisma, user.id, user.email);
  return user;
}

/** A bearer token for the account area, as login would issue it. */
export async function accountToken(secret: string, prisma: PrismaClient, userId: string, now: Date): Promise<string> {
  const user = await prisma.appUser.findUniqueOrThrow({ where: { id: userId } });
  return (await issueToken(secret, 'account', user, now)).token;
}
