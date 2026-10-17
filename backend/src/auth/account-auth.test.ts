import { createHash } from 'node:crypto';
import type { AppUser, Outbox, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  type AuthDeps,
  type LoginResult,
  LOCKOUT_MINUTES,
  LOCKOUT_THRESHOLD,
  PASSWORD_RESET_TTL_MINUTES,
  attemptLogin,
  confirmPasswordReset,
  lockoutMinutesFor,
  requestPasswordReset,
  revokeTokens,
} from './account-auth.js';
import { hashPassword, verifyPassword } from './password.js';
import { AREA_ROLE, AREA_WEB_PATHS, AUTH_AREAS, type AuthArea } from './roles.js';
import { TOKEN_AUDIENCES, TOKEN_TTL_SECONDS, credentialFingerprint, verifyToken } from './token.js';

/**
 * Login, lockout and password reset (plan.md Task 7, spec §6.23), per
 * `app_user` (marketplace-spec.md R2.5), called directly against real
 * PostgreSQL. Most of the suite drives the studio area; the last sections run
 * every area -- studio, platform, account -- through the same checks (Phase 2
 * decisions 1-3, T2.4, T2.5). The clock is injected and mutable, so a lock or a
 * token expiry is crossed by moving `clock`, never by waiting.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let deps: AuthDeps;
/** Argon2id of PASSWORD, computed once: every seeded user reuses it. */
let passwordHash: string;
let clock: Date;

const SECRET = 'account-auth-test-secret-at-least-32-characters-long';
const WEB_ORIGIN = 'https://admin.bookly.example';
const EMAIL = 'photographer@bookly.example';
const PASSWORD = 'correct horse battery staple';
const WRONG = 'Tr0ub4dor&3 is not the password';
const NEW_PASSWORD = 'a brand new passphrase for the photographer';
const START = new Date('2026-10-07T07:00:00Z');
const MINUTE_MS = 60_000;
const RESET_TTL_MS = PASSWORD_RESET_TTL_MINUTES * MINUTE_MS;

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
  deps = { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock };
  passwordHash = await hashPassword(PASSWORD);
});

afterAll(async () => {
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  clock = START;
});

// --- Fixtures ---------------------------------------------------------------

let handleCounter = 0;

/** A photographer's verified login with its approved photographer row: what the studio admits. */
function seedAdmin(email = EMAIL): Promise<AppUser> {
  handleCounter += 1;
  return prisma.appUser.create({
    data: {
      email,
      role: 'photographer',
      passwordHash,
      emailVerifiedAt: START,
      photographer: {
        create: { handle: `studio-${handleCounter}`, displayName: 'Kigali Lens', status: 'approved', approvedAt: START },
      },
    },
  });
}

/** A verified login with no photographer row: a platform admin, a client, or a photographer whose row is missing. */
function seedUser(role: 'platform_admin' | 'client' | 'photographer', email = EMAIL): Promise<AppUser> {
  return prisma.appUser.create({ data: { email, role, passwordHash, emailVerifiedAt: START } });
}

function reload(admin: AppUser): Promise<AppUser> {
  return prisma.appUser.findUniqueOrThrow({ where: { id: admin.id } });
}

/** The stored password hash, which every seeded user has. */
function hashOf(user: AppUser): string {
  if (user.passwordHash === null) throw new Error('Expected a password hash');
  return user.passwordHash;
}

async function photographerIdOf(user: AppUser): Promise<string> {
  return (await prisma.photographer.findUniqueOrThrow({ where: { userId: user.id } })).id;
}

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function lockedUntilMs(admin: AppUser): number {
  if (admin.lockedUntil === null) throw new Error('Expected the admin to be locked');
  return admin.lockedUntil.getTime();
}

async function failLogins(times: number, email = EMAIL): Promise<void> {
  for (let i = 0; i < times; i++) {
    await expect(attemptLogin(deps, 'studio', email, WRONG)).resolves.toEqual({
      status: 'invalid_credentials',
    });
  }
}

function signedIn(result: LoginResult): Extract<LoginResult, { status: 'ok' }> {
  if (result.status !== 'ok') throw new Error(`Expected 'ok', got '${result.status}'`);
  return result;
}

function payloadOf(row: Outbox): Record<string, unknown> {
  const payload = row.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Outbox row ${row.id} has no object payload`);
  }
  return payload;
}

const TEMPLATE_OF = { login_lockout: 'account_security_alert', password_reset: 'account_password_reset' } as const;

async function outboxRows(event: keyof typeof TEMPLATE_OF): Promise<Outbox[]> {
  return prisma.outbox.findMany({ where: { template: TEMPLATE_OF[event] }, orderBy: { createdAt: 'asc' } });
}

/** The plaintext token, recovered from the only place it lives: the email payload. */
function tokenFrom(row: Outbox | undefined): string {
  if (row === undefined) throw new Error('Expected a password_reset outbox row');
  const url = new URL(String(payloadOf(row).resetUrl));
  const prefix = '#token=';
  if (!url.hash.startsWith(prefix)) throw new Error(`No #token= fragment in ${url.href}`);
  return url.hash.slice(prefix.length);
}

async function latestResetToken(): Promise<string> {
  const rows = await outboxRows('password_reset');
  return tokenFrom(rows.at(-1));
}

/** An independent SHA-256, so the assertion does not trust sha256Hex. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// --- lockoutMinutesFor (pure) ---------------------------------------------------

describe('lockoutMinutesFor', () => {
  it('uses the plan defaults: every 5th failure, 1 then 5 then 15 minutes', () => {
    expect(LOCKOUT_THRESHOLD).toBe(5);
    expect(LOCKOUT_MINUTES).toEqual([1, 5, 15]);
  });

  it.each([
    [0, null],
    [-1, null],
    [-5, null],
    [1, null],
    [2, null],
    [3, null],
    [4, null],
    [5, 1],
    [6, null],
    [9, null],
    [10, 5],
    [15, 15],
    [20, 15],
    [25, 15],
    [100, 15],
  ])('locks %i consecutive failures for %s minutes', (count, minutes) => {
    expect(lockoutMinutesFor(count)).toBe(minutes);
  });

  it.each([Number.NaN, 5.5, Number.POSITIVE_INFINITY])('does not lock on %s', (count) => {
    expect(lockoutMinutesFor(count)).toBeNull();
  });
});

// --- Successful login ---------------------------------------------------------

describe('attemptLogin with correct credentials', () => {
  it('issues a bearer token for the user and role, bound to the current password hash, expiring in 8 hours', async () => {
    const admin = await seedAdmin();

    const result = signedIn(await attemptLogin(deps, 'studio', EMAIL, PASSWORD));

    expect(result.expiresAt.getTime()).toBe(START.getTime() + TOKEN_TTL_SECONDS.studio * 1000);
    await expect(verifyToken(SECRET, 'studio', result.token, START)).resolves.toEqual({
      userId: admin.id,
      role: 'photographer',
      credentialFingerprint: credentialFingerprint(SECRET, admin),
    });
  });

  it('returns the user who signed in, not another photographer', async () => {
    const admin = await seedAdmin();
    await seedAdmin('second.photographer@bookly.example');

    const result = signedIn(await attemptLogin(deps, 'studio', EMAIL, PASSWORD));

    expect(result.user.id).toBe(admin.id);
    expect(await photographerIdOf(result.user)).toBe(await photographerIdOf(admin));
  });

  it.each(['pending', 'suspended'])('admits a %s photographer: setting up, or keeping the bookings they have', async (status) => {
    const admin = await seedAdmin();
    await prisma.photographer.update({
      where: { userId: admin.id },
      data: { status, approvedAt: null, ...(status === 'suspended' ? { suspendedAt: START } : {}) },
    });

    await expect(attemptLogin(deps, 'studio', EMAIL, PASSWORD)).resolves.toMatchObject({ status: 'ok' });
  });

  it('puts neither the password hash nor anything cookie- or CSRF-shaped in the result', async () => {
    const admin = await seedAdmin();

    const result = signedIn(await attemptLogin(deps, 'studio', EMAIL, PASSWORD));

    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'status', 'token', 'user']);
    const [, payload] = result.token.split('.');
    expect(Buffer.from(payload ?? '', 'base64url').toString()).not.toContain(hashOf(admin));
  });

  it('records last_login_at from the injected clock', async () => {
    const admin = await seedAdmin();

    const result = signedIn(await attemptLogin(deps, 'studio', EMAIL, PASSWORD));

    expect(result.user.lastLoginAt?.toISOString()).toBe(START.toISOString());
    await expect(reload(admin)).resolves.toMatchObject({ lastLoginAt: START });
  });

  it.each(['PHOTOGRAPHER@BOOKLY.EXAMPLE', 'Photographer@Bookly.Example'])(
    'matches the email case-insensitively (%s)',
    async (casing) => {
      const admin = await seedAdmin();

      const result = signedIn(await attemptLogin(deps, 'studio', casing, PASSWORD));

      expect(result.user.id).toBe(admin.id);
    },
  );

  it('matches a mixed-case stored email from a lower-case attempt', async () => {
    await seedAdmin('Photographer@Bookly.Example');

    await expect(attemptLogin(deps, 'studio', EMAIL, PASSWORD)).resolves.toMatchObject({ status: 'ok' });
  });
});

// --- Refused login --------------------------------------------------------------

describe('attemptLogin refusals', () => {
  it('increments failed_login_count on each wrong password', async () => {
    const admin = await seedAdmin();

    for (let expected = 1; expected < LOCKOUT_THRESHOLD; expected++) {
      await failLogins(1);
      const row = await reload(admin);
      expect(row.failedLoginCount).toBe(expected);
      expect(row.lockedUntil).toBeNull();
    }
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('counts a wrong password under different email casing against the account', async () => {
    const admin = await seedAdmin();

    await failLogins(1, 'PHOTOGRAPHER@bookly.example');

    await expect(reload(admin)).resolves.toMatchObject({ failedLoginCount: 1 });
  });

  it('refuses an unknown email without touching the admin row or the outbox', async () => {
    const admin = await seedAdmin();

    await expect(attemptLogin(deps, 'studio', 'someone@else.example', PASSWORD)).resolves.toEqual({
      status: 'invalid_credentials',
    });

    await expect(reload(admin)).resolves.toEqual(admin);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('gives one result for unknown email, wrong password and a locked account', async () => {
    await seedAdmin();

    const unknown = await attemptLogin(deps, 'studio', 'someone@else.example', PASSWORD);
    const wrong = await attemptLogin(deps, 'studio', EMAIL, WRONG);
    await failLogins(LOCKOUT_THRESHOLD - 1);
    const locked = await attemptLogin(deps, 'studio', EMAIL, PASSWORD);

    expect(unknown).toEqual({ status: 'invalid_credentials' });
    expect(wrong).toEqual(unknown);
    expect(locked).toEqual(unknown);
  });

  it('does not issue a session for a refused attempt', async () => {
    await seedAdmin();

    const result = await attemptLogin(deps, 'studio', EMAIL, WRONG);

    expect(Object.keys(result)).toEqual(['status']);
  });
});

// --- Who the studio admits ------------------------------------------------------------

describe('attemptLogin for a login that is not a photographer studio', () => {
  // The studio admits photographers only (Phase 2 decision 1). Every other kind
  // of account gets exactly what an unknown email gets: the same result, nothing
  // counted against it, and no email -- the studio login must not become a way
  // to probe for, or lock out, a platform admin or a client.

  const refusals: [string, () => Promise<AppUser>][] = [
    ['a platform admin', () => seedUser('platform_admin')],
    ['a client', () => seedUser('client')],
    ['a photographer login with no photographer row', () => seedUser('photographer')],
    [
      'a photographer whose login was disabled',
      async () => prisma.appUser.update({ where: { id: (await seedAdmin()).id }, data: { disabledAt: START } }),
    ],
    [
      'an erased photographer login',
      async () => prisma.appUser.update({ where: { id: (await seedAdmin()).id }, data: { anonymizedAt: START } }),
    ],
  ];

  it.each(refusals)('refuses %s with the right password, as invalid_credentials', async (_label, seed) => {
    await seed();

    await expect(attemptLogin(deps, 'studio', EMAIL, PASSWORD)).resolves.toEqual({ status: 'invalid_credentials' });
  });

  it.each(refusals)('counts nothing against %s and sends nothing, even past the lockout threshold', async (_label, seed) => {
    const user = await seed();

    await failLogins(LOCKOUT_THRESHOLD);

    await expect(reload(user)).resolves.toEqual(user);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  }, 30_000);

  it.each(refusals)('sends %s no reset link and leaves the row alone', async (_label, seed) => {
    const user = await seed();

    await expect(requestPasswordReset(deps, 'studio', EMAIL)).resolves.toBeUndefined();

    await expect(prisma.outbox.count()).resolves.toBe(0);
    await expect(reload(user)).resolves.toEqual(user);
  });
});

// --- Lockout ----------------------------------------------------------------------

describe('lockout', () => {
  it('locks for 1 minute on the 5th consecutive failure', async () => {
    const admin = await seedAdmin();

    await failLogins(LOCKOUT_THRESHOLD);

    const row = await reload(admin);
    expect(row.failedLoginCount).toBe(LOCKOUT_THRESHOLD);
    expect(lockedUntilMs(row)).toBe(START.getTime() + MINUTE_MS);
  });

  it('refuses correct credentials 1 ms before the lock passes and accepts them after', async () => {
    const admin = await seedAdmin();
    await failLogins(LOCKOUT_THRESHOLD);
    const until = lockedUntilMs(await reload(admin));

    clock = new Date(until - 1);
    await expect(attemptLogin(deps, 'studio', EMAIL, PASSWORD)).resolves.toEqual({
      status: 'invalid_credentials',
    });

    clock = new Date(until + 1);
    await expect(attemptLogin(deps, 'studio', EMAIL, PASSWORD)).resolves.toMatchObject({ status: 'ok' });
  });

  it('does not count attempts made while locked, right or wrong', async () => {
    const admin = await seedAdmin();
    await failLogins(LOCKOUT_THRESHOLD);
    const before = await reload(admin);

    advance(30_000);
    await failLogins(3);
    await expect(attemptLogin(deps, 'studio', EMAIL, PASSWORD)).resolves.toEqual({
      status: 'invalid_credentials',
    });

    const after = await reload(admin);
    expect(after.failedLoginCount).toBe(LOCKOUT_THRESHOLD);
    expect(after.lockedUntil).toEqual(before.lockedUntil);
    expect(after.lastLoginAt).toBeNull();
    await expect(outboxRows('login_lockout')).resolves.toHaveLength(1);
  }, 30_000);

  it('escalates 1 -> 5 -> 15 minutes and caps at 15', async () => {
    const admin = await seedAdmin();

    for (const [i, minutes] of [1, 5, 15, 15].entries()) {
      const lockedAt = clock.getTime();
      await failLogins(LOCKOUT_THRESHOLD);

      const row = await reload(admin);
      expect(row.failedLoginCount).toBe((i + 1) * LOCKOUT_THRESHOLD);
      expect(lockedUntilMs(row)).toBe(lockedAt + minutes * MINUTE_MS);

      clock = new Date(lockedUntilMs(row) + 1);
    }

    const alerts = await outboxRows('login_lockout');
    expect(alerts.map((row) => payloadOf(row).failedLoginCount)).toEqual([5, 10, 15, 20]);
  }, 60_000);

  it('does not lock on the failures between thresholds', async () => {
    const admin = await seedAdmin();
    await failLogins(LOCKOUT_THRESHOLD);
    clock = new Date(lockedUntilMs(await reload(admin)) + 1);

    await failLogins(LOCKOUT_THRESHOLD - 1);

    // Still carrying the lapsed first lock, but not re-locked by failures 6-9.
    const row = await reload(admin);
    expect(row.failedLoginCount).toBe(2 * LOCKOUT_THRESHOLD - 1);
    expect(lockedUntilMs(row)).toBeLessThan(clock.getTime());
    await expect(attemptLogin(deps, 'studio', EMAIL, PASSWORD)).resolves.toMatchObject({ status: 'ok' });
  }, 30_000);

  it('zeroes the count and clears the lock on success', async () => {
    const admin = await seedAdmin();
    await failLogins(LOCKOUT_THRESHOLD - 1);

    signedIn(await attemptLogin(deps, 'studio', EMAIL, PASSWORD));

    const row = await reload(admin);
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();

    // Proof the count really restarted: four more failures do not lock.
    await failLogins(LOCKOUT_THRESHOLD - 1);
    await expect(reload(admin)).resolves.toMatchObject({
      failedLoginCount: LOCKOUT_THRESHOLD - 1,
      lockedUntil: null,
    });
  }, 30_000);

  it('starts escalation over after a success: the next lock is 1 minute again', async () => {
    const admin = await seedAdmin();
    await failLogins(LOCKOUT_THRESHOLD);
    clock = new Date(lockedUntilMs(await reload(admin)) + 1);
    signedIn(await attemptLogin(deps, 'studio', EMAIL, PASSWORD));

    const lockedAt = clock.getTime();
    await failLogins(LOCKOUT_THRESHOLD);

    expect(lockedUntilMs(await reload(admin))).toBe(lockedAt + MINUTE_MS);
  }, 30_000);

  it('enqueues exactly one account_security_alert per lock, addressed to the stored email', async () => {
    const admin = await seedAdmin('Photographer@Bookly.Example');
    await failLogins(LOCKOUT_THRESHOLD);
    await failLogins(2); // locked: not counted, no second email

    const rows = await prisma.outbox.findMany();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) return;
    expect(row).toMatchObject({
      kind: 'email',
      template: 'account_security_alert',
      recipient: 'Photographer@Bookly.Example',
      bookingId: null,
      // Account mail concerns a person, not a studio.
      photographerId: null,
      status: 'pending',
    });
    const until = lockedUntilMs(await reload(admin));
    expect(payloadOf(row)).toEqual({
      variant: 'login_lockout',
      area: 'studio',
      failedLoginCount: LOCKOUT_THRESHOLD,
      lockedUntil: new Date(until).toISOString(),
    });
  }, 30_000);
});

describe('lockout under concurrency', () => {
  // A burst of simultaneous guesses all read the account before any failure is
  // recorded. The lock exists to cap guesses per window; these pin that it does
  // so under concurrency too, not only for one attempt at a time.

  beforeEach(async () => {
    // Open the pool's connections first, so the burst measures the race rather
    // than connection setup spreading the attempts apart.
    await Promise.all(Array.from({ length: 10 }, () => prisma.appUser.count()));
  });

  it('counts one lock worth of failures from a simultaneous burst of 10', async () => {
    const admin = await seedAdmin();

    await Promise.all(Array.from({ length: 10 }, () => attemptLogin(deps, 'studio', EMAIL, WRONG)));

    const row = await reload(admin);
    expect(row.failedLoginCount).toBe(LOCKOUT_THRESHOLD);
    expect(lockedUntilMs(row)).toBe(START.getTime() + MINUTE_MS);
    await expect(outboxRows('login_lockout')).resolves.toHaveLength(1);
  }, 30_000);

  it('never throws on a simultaneous burst of 20 wrong passwords', async () => {
    await seedAdmin();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => attemptLogin(deps, 'studio', EMAIL, WRONG)),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    // Joined into one string so a failure prints the reason, not `[ Array(1) ]`.
    expect(rejected.map((r) => String(r.reason)).join('\n')).toBe('');
  }, 30_000);
});

// --- Email matching is exact ---------------------------------------------------

describe('email matching', () => {
  // Case-insensitive equality, not a pattern: an attacker who does not know the
  // admin address must not be able to match it with LIKE wildcards.

  it.each(['%', '%@%', '_%', 'photographer@bookly_example', 'PHOTOGRAPHER@%'])(
    'refuses correct password under the wildcard email %j',
    async (pattern) => {
      await seedAdmin();

      await expect(attemptLogin(deps, 'studio', pattern, PASSWORD)).resolves.toEqual({
        status: 'invalid_credentials',
      });
    },
  );

  it('does not count a wildcard-email failure against the admin', async () => {
    const admin = await seedAdmin();

    await attemptLogin(deps, 'studio', '%', WRONG);

    await expect(reload(admin)).resolves.toMatchObject({ failedLoginCount: 0 });
  });

  it.each(['\\', 'photographer@bookly.example\\', '\\%'])(
    'resolves rather than throws for the email %j',
    async (email) => {
      await seedAdmin();

      await expect(attemptLogin(deps, 'studio', email, PASSWORD)).resolves.toEqual({
        status: 'invalid_credentials',
      });
    },
  );

  it('sends no reset link for a wildcard email', async () => {
    await seedAdmin();

    await requestPasswordReset(deps, 'studio', '%');

    await expect(prisma.outbox.count()).resolves.toBe(0);
  });
});

// --- Password reset: request ---------------------------------------------------

describe('requestPasswordReset', () => {
  it('stores only the SHA-256 hex of the token, never the token', async () => {
    const admin = await seedAdmin();

    await requestPasswordReset(deps, 'studio', EMAIL);

    const token = await latestResetToken();
    const row = await reload(admin);
    expect(row.passwordResetTokenHash).not.toBe(token);
    expect(row.passwordResetTokenHash).toBe(sha256(token));
    expect(row.passwordResetTokenHash).toMatch(/^[0-9a-f]{64}$/);

    // Nowhere in the row at all, in any column.
    const all = await raw.query<{ row: string }>(
      'SELECT row_to_json(a)::text AS row FROM app_user a WHERE id = $1',
      [admin.id],
    );
    expect(firstRow(all).row).not.toContain(token);
  });

  it('issues a high-entropy base64url token', async () => {
    await seedAdmin();

    await requestPasswordReset(deps, 'studio', EMAIL);

    const token = await latestResetToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(32);
  });

  it('expires the token 30 minutes after the request', async () => {
    const admin = await seedAdmin();

    await requestPasswordReset(deps, 'studio', EMAIL);

    const row = await reload(admin);
    expect(row.passwordResetExpiresAt?.getTime()).toBe(START.getTime() + RESET_TTL_MS);
  });

  it('enqueues an account_password_reset whose link is a #token= fragment on the web origin', async () => {
    await seedAdmin();

    await requestPasswordReset(deps, 'studio', EMAIL);

    const rows = await outboxRows('password_reset');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) return;
    expect(row).toMatchObject({
      kind: 'email',
      template: 'account_password_reset',
      recipient: EMAIL,
      bookingId: null,
      photographerId: null,
    });
    const payload = payloadOf(row);
    expect(Object.keys(payload).sort()).toEqual(['expiresAt', 'resetUrl']);
    expect(payload.expiresAt).toBe(new Date(START.getTime() + RESET_TTL_MS).toISOString());

    const url = new URL(String(payload.resetUrl));
    expect(url.origin).toBe(WEB_ORIGIN);
    expect(url.pathname).toBe('/studio/reset-password');
    // A fragment, never a query string: no server log or Referer sees it.
    expect(url.search).toBe('');
    expect(url.hash).toMatch(/^#token=[A-Za-z0-9_-]+$/);
  });

  it('addresses the link to the stored email, not the casing that was typed', async () => {
    await seedAdmin('Photographer@Bookly.Example');

    await requestPasswordReset(deps, 'studio', 'PHOTOGRAPHER@BOOKLY.EXAMPLE');

    const rows = await outboxRows('password_reset');
    expect(rows.map((row) => row.recipient)).toEqual(['Photographer@Bookly.Example']);
  });

  it('does nothing for an unknown email: no outbox row, no change to the admin', async () => {
    const admin = await seedAdmin();

    await expect(requestPasswordReset(deps, 'studio', 'someone@else.example')).resolves.toBeUndefined();

    await expect(prisma.outbox.count()).resolves.toBe(0);
    await expect(reload(admin)).resolves.toEqual(admin);
  });

  it('replaces the first token with the second, so only the newest link works', async () => {
    const admin = await seedAdmin();
    await requestPasswordReset(deps, 'studio', EMAIL);
    const first = await latestResetToken();
    advance(MINUTE_MS);
    await requestPasswordReset(deps, 'studio', EMAIL);
    const second = await latestResetToken();

    expect(second).not.toBe(first);
    await expect(reload(admin)).resolves.toMatchObject({ passwordResetTokenHash: sha256(second) });
    await expect(confirmPasswordReset(deps, 'studio', first, NEW_PASSWORD)).resolves.toBe(
      'invalid_or_expired_token',
    );
    await expect(confirmPasswordReset(deps, 'studio', second, NEW_PASSWORD)).resolves.toBe('ok');
  });

  it('works for a locked account', async () => {
    await seedAdmin();
    await failLogins(LOCKOUT_THRESHOLD);

    await requestPasswordReset(deps, 'studio', EMAIL);

    await expect(outboxRows('password_reset')).resolves.toHaveLength(1);
  });

  it('keeps each reset to its own user: a second photographer requesting one leaves the first working', async () => {
    const first = await seedAdmin();
    const second = await seedAdmin('second.photographer@bookly.example');
    await requestPasswordReset(deps, 'studio', EMAIL);
    const firstToken = await latestResetToken();
    await requestPasswordReset(deps, 'studio', 'second.photographer@bookly.example');
    const secondToken = await latestResetToken();

    await expect(reload(first)).resolves.toMatchObject({ passwordResetTokenHash: sha256(firstToken) });
    await expect(reload(second)).resolves.toMatchObject({ passwordResetTokenHash: sha256(secondToken) });

    await expect(confirmPasswordReset(deps, 'studio', secondToken, NEW_PASSWORD)).resolves.toBe('ok');
    // Only the holder of the token changed password.
    await expect(verifyPassword(hashOf(await reload(second)), NEW_PASSWORD)).resolves.toBe(true);
    await expect(reload(first)).resolves.toMatchObject({ passwordHash, passwordResetTokenHash: sha256(firstToken) });
    await expect(confirmPasswordReset(deps, 'studio', firstToken, 'the first photographer, resetting')).resolves.toBe('ok');
  });
});

// --- Password reset: confirm ---------------------------------------------------

describe('confirmPasswordReset', () => {
  it('sets the new password and clears the token', async () => {
    const admin = await seedAdmin();
    await requestPasswordReset(deps, 'studio', EMAIL);

    await expect(confirmPasswordReset(deps, 'studio', await latestResetToken(), NEW_PASSWORD)).resolves.toBe(
      'ok',
    );

    const row = await reload(admin);
    await expect(verifyPassword(hashOf(row), NEW_PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(hashOf(row), PASSWORD)).resolves.toBe(false);
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordResetTokenHash).toBeNull();
    expect(row.passwordResetExpiresAt).toBeNull();
  });

  it('accepts a token once and refuses it on reuse', async () => {
    const admin = await seedAdmin();
    await requestPasswordReset(deps, 'studio', EMAIL);
    const token = await latestResetToken();

    await expect(confirmPasswordReset(deps, 'studio', token, NEW_PASSWORD)).resolves.toBe('ok');
    await expect(confirmPasswordReset(deps, 'studio', token, 'a second attempt at a password')).resolves.toBe(
      'invalid_or_expired_token',
    );

    const row = await reload(admin);
    await expect(verifyPassword(hashOf(row), NEW_PASSWORD)).resolves.toBe(true);
  });

  it('accepts the token 1 ms before it expires', async () => {
    await seedAdmin();
    await requestPasswordReset(deps, 'studio', EMAIL);

    advance(RESET_TTL_MS - 1);

    await expect(confirmPasswordReset(deps, 'studio', await latestResetToken(), NEW_PASSWORD)).resolves.toBe(
      'ok',
    );
  });

  it.each([0, 1, MINUTE_MS])(
    'refuses the token %i ms after its 30 minutes are up, leaving the password alone',
    async (past) => {
      const admin = await seedAdmin();
      await requestPasswordReset(deps, 'studio', EMAIL);

      advance(RESET_TTL_MS + past);

      await expect(
        confirmPasswordReset(deps, 'studio', await latestResetToken(), NEW_PASSWORD),
      ).resolves.toBe('invalid_or_expired_token');
      await expect(reload(admin)).resolves.toMatchObject({ passwordHash });
    },
  );

  it.each<[string, (pending: AppUser) => string]>([
    ['an unknown token', () => 'x'.repeat(43)],
    // Someone who can read the column must still not be able to use it.
    ['the stored hash submitted as the token', (pending) => String(pending.passwordResetTokenHash)],
  ])('refuses %s and leaves the pending reset untouched', async (_label, forge) => {
    const admin = await seedAdmin();
    await requestPasswordReset(deps, 'studio', EMAIL);
    const pending = await reload(admin);

    await expect(confirmPasswordReset(deps, 'studio', forge(pending), NEW_PASSWORD)).resolves.toBe(
      'invalid_or_expired_token',
    );
    await expect(reload(admin)).resolves.toEqual(pending);
  });

  it('refuses any token when no reset was ever requested', async () => {
    const admin = await seedAdmin();

    await expect(confirmPasswordReset(deps, 'studio', 'anything-at-all', NEW_PASSWORD)).resolves.toBe(
      'invalid_or_expired_token',
    );
    await expect(reload(admin)).resolves.toEqual(admin);
  });

  it('lets exactly one of two simultaneous confirmations of one token win', async () => {
    const admin = await seedAdmin();
    await requestPasswordReset(deps, 'studio', EMAIL);
    const token = await latestResetToken();
    const passwords = ['first racing new password', 'second racing new password'];

    const results = await Promise.all(
      passwords.map((password) => confirmPasswordReset(deps, 'studio', token, password)),
    );

    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'invalid_or_expired_token')).toHaveLength(1);
    const row = await reload(admin);
    const matches = await Promise.all(passwords.map((p) => verifyPassword(hashOf(row), p)));
    expect(matches.filter(Boolean)).toHaveLength(1);
  });

  it('clears a lockout, so the new password works at once', async () => {
    const admin = await seedAdmin();
    await failLogins(LOCKOUT_THRESHOLD);
    await requestPasswordReset(deps, 'studio', EMAIL);

    await expect(confirmPasswordReset(deps, 'studio', await latestResetToken(), NEW_PASSWORD)).resolves.toBe(
      'ok',
    );

    await expect(reload(admin)).resolves.toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    // Same instant as the lock: without the reset this would still be refused.
    await expect(attemptLogin(deps, 'studio', EMAIL, NEW_PASSWORD)).resolves.toMatchObject({ status: 'ok' });
  }, 30_000);

  it('invalidates a bearer token issued before the change', async () => {
    const admin = await seedAdmin();
    const { token } = signedIn(await attemptLogin(deps, 'studio', EMAIL, PASSWORD));
    const claims = await verifyToken(SECRET, 'studio', token, START);
    if (claims === null) throw new Error('Login issued a token that does not verify');
    await requestPasswordReset(deps, 'studio', EMAIL);

    await confirmPasswordReset(deps, 'studio', await latestResetToken(), NEW_PASSWORD);

    const row = await reload(admin);
    // The signature still verifies -- nothing about the JWT itself changed. What
    // no longer matches is the fingerprint `requirePhotographer` compares it against.
    expect(claims.credentialFingerprint).toBe(credentialFingerprint(SECRET, admin));
    expect(claims.credentialFingerprint).not.toBe(credentialFingerprint(SECRET, row));
  });
});

// --- Every area (Phase 2 decisions 1-3; T2.4, T2.5) -------------------------------

/** A verified login of `role`, with a photographer row when it is a photographer: what that role's area admits. */
async function seedRole(role: (typeof AREA_ROLE)[AuthArea], email = EMAIL): Promise<AppUser> {
  if (role === 'photographer') return seedAdmin(email);
  return seedUser(role, email);
}

async function failLoginsIn(area: AuthArea, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await expect(attemptLogin(deps, area, EMAIL, WRONG)).resolves.toEqual({ status: 'invalid_credentials' });
  }
}

/** Each area, its role, and the areas it does not belong to. */
const ROLE_AREAS = AUTH_AREAS.map((area) => [area, AREA_ROLE[area], AUTH_AREAS.filter((other) => other !== area)] as const);

describe.each(ROLE_AREAS)('the %s area', (area, role, otherAreas) => {
  it(`signs in a verified ${role} with a token for its own audience and lifetime`, async () => {
    const user = await seedRole(role);

    const result = signedIn(await attemptLogin(deps, area, EMAIL, PASSWORD));

    expect(result.user.id).toBe(user.id);
    expect(result.expiresAt.getTime()).toBe(START.getTime() + TOKEN_TTL_SECONDS[area] * 1000);
    await expect(verifyToken(SECRET, area, result.token, START)).resolves.toMatchObject({ userId: user.id, role });
    const [, payload] = result.token.split('.');
    expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())).toMatchObject({ aud: TOKEN_AUDIENCES[area] });
    for (const other of otherAreas) await expect(verifyToken(SECRET, other, result.token, START)).resolves.toBeNull();
  });

  it.each(otherAreas)(`refuses its ${role} at the %s login exactly like an unknown email, counting nothing`, async (other) => {
    const user = await seedRole(role);

    const unknown = await attemptLogin(deps, other, 'nobody@bookly.example', PASSWORD);
    const refused = await attemptLogin(deps, other, EMAIL, PASSWORD);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) await attemptLogin(deps, other, EMAIL, WRONG);

    expect(refused).toEqual(unknown);
    expect(refused).toEqual({ status: 'invalid_credentials' });
    await expect(reload(user)).resolves.toEqual(user);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  }, 30_000);

  it(`refuses the right password for an unverified ${role} exactly as a wrong one: same result, attempt counted`, async () => {
    const user = await prisma.appUser.update({ where: { id: (await seedRole(role)).id }, data: { emailVerifiedAt: null } });

    const wrong = await attemptLogin(deps, area, EMAIL, WRONG);
    const right = await attemptLogin(deps, area, EMAIL, PASSWORD);

    expect(right).toEqual(wrong);
    expect(right).toEqual({ status: 'invalid_credentials' });
    await expect(reload(user)).resolves.toMatchObject({ failedLoginCount: 2, lastLoginAt: null });
  });

  it(`locks an unverified ${role} like any other, but sends the lockout alert only to a verified address`, async () => {
    const user = await prisma.appUser.update({ where: { id: (await seedRole(role)).id }, data: { emailVerifiedAt: null } });

    await failLoginsIn(area, LOCKOUT_THRESHOLD);

    expect(lockedUntilMs(await reload(user))).toBe(START.getTime() + MINUTE_MS);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  }, 30_000);

  it(`alerts a locked-out ${role} with the ${area} area in the payload, for its sign-in button`, async () => {
    await seedRole(role);

    await failLoginsIn(area, LOCKOUT_THRESHOLD);

    const alerts = await outboxRows('login_lockout');
    expect(alerts.map(payloadOf)).toEqual([expect.objectContaining({ variant: 'login_lockout', area })]);
  }, 30_000);

  it(`refuses a disabled ${role} like an unknown email`, async () => {
    const user = await prisma.appUser.update({ where: { id: (await seedRole(role)).id }, data: { disabledAt: START } });

    await expect(attemptLogin(deps, area, EMAIL, PASSWORD)).resolves.toEqual({ status: 'invalid_credentials' });
    await expect(reload(user)).resolves.toEqual(user);
  });

  it(`emails a ${role} a reset link to ${AREA_WEB_PATHS[area].resetPassword}, which works in this area only`, async () => {
    const user = await seedRole(role);

    await requestPasswordReset(deps, area, EMAIL);

    const token = await latestResetToken();
    const rows = await outboxRows('password_reset');
    expect(rows.map((row) => new URL(String(payloadOf(row).resetUrl)).pathname)).toEqual([AREA_WEB_PATHS[area].resetPassword]);
    for (const other of otherAreas) await expect(confirmPasswordReset(deps, other, token, NEW_PASSWORD)).resolves.toBe('invalid_or_expired_token');
    await expect(reload(user)).resolves.toMatchObject({ passwordHash, passwordResetTokenHash: sha256(token) });
    await expect(confirmPasswordReset(deps, area, token, NEW_PASSWORD)).resolves.toBe('ok');
  });

  it.each(otherAreas)(`sends a ${role} no reset link from the %s area, and answers the same`, async (other) => {
    const user = await seedRole(role);

    await expect(requestPasswordReset(deps, other, EMAIL)).resolves.toBeUndefined();

    await expect(prisma.outbox.count()).resolves.toBe(0);
    await expect(reload(user)).resolves.toEqual(user);
  });

  it(`refuses a ${role}'s reset link once the login has been disabled`, async () => {
    const user = await seedRole(role);
    await requestPasswordReset(deps, area, EMAIL);
    await prisma.appUser.update({ where: { id: user.id }, data: { disabledAt: START } });

    await expect(confirmPasswordReset(deps, area, await latestResetToken(), NEW_PASSWORD)).resolves.toBe('invalid_or_expired_token');
    await expect(reload(user)).resolves.toMatchObject({ passwordHash });
  });

  it(`moves a ${role}'s credential fingerprint on revokeTokens and on a password reset (T2.5)`, async () => {
    const user = await seedRole(role);
    const { token } = signedIn(await attemptLogin(deps, area, EMAIL, PASSWORD));
    const claims = await verifyToken(SECRET, area, token, START);
    expect(claims?.credentialFingerprint).toBe(credentialFingerprint(SECRET, await reload(user)));

    await revokeTokens(prisma, user.id);
    const revoked = await reload(user);
    expect(revoked.tokenVersion).toBe(user.tokenVersion + 1);
    expect(claims?.credentialFingerprint).not.toBe(credentialFingerprint(SECRET, revoked));

    await requestPasswordReset(deps, area, EMAIL);
    await confirmPasswordReset(deps, area, await latestResetToken(), NEW_PASSWORD);
    const reset = await reload(user);
    const fresh = signedIn(await attemptLogin(deps, area, EMAIL, NEW_PASSWORD));
    expect((await verifyToken(SECRET, area, fresh.token, START))?.credentialFingerprint).toBe(credentialFingerprint(SECRET, reset));
    expect(credentialFingerprint(SECRET, reset)).not.toBe(credentialFingerprint(SECRET, revoked));
  }, 30_000);
});

describe('a Google-only client', () => {
  // No password (R2.4): at a password login it is an unknown email.
  function seedGoogleClient(): Promise<AppUser> {
    return prisma.appUser.create({ data: { email: EMAIL, role: 'client', googleSub: 'google-sub-1', emailVerifiedAt: START } });
  }

  it('is refused at the account password login like an unknown email, counting nothing', async () => {
    const user = await seedGoogleClient();

    await expect(attemptLogin(deps, 'account', EMAIL, PASSWORD)).resolves.toEqual({ status: 'invalid_credentials' });
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) await attemptLogin(deps, 'account', EMAIL, WRONG);

    await expect(reload(user)).resolves.toEqual(user);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  }, 30_000);

  it('may add a password through the reset link, and then sign in with it', async () => {
    const user = await seedGoogleClient();

    await requestPasswordReset(deps, 'account', EMAIL);
    await expect(confirmPasswordReset(deps, 'account', await latestResetToken(), NEW_PASSWORD)).resolves.toBe('ok');

    await expect(reload(user)).resolves.toMatchObject({ googleSub: 'google-sub-1' });
    await expect(attemptLogin(deps, 'account', EMAIL, NEW_PASSWORD)).resolves.toMatchObject({ status: 'ok' });
  });

  it('is revoked by revokeTokens alone: its fingerprint covers the token version', async () => {
    const user = await seedGoogleClient();
    const before = credentialFingerprint(SECRET, user);

    await revokeTokens(prisma, user.id);

    expect(credentialFingerprint(SECRET, await reload(user))).not.toBe(before);
  });
});
