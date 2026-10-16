import { createHash } from 'node:crypto';
import type { AdminUser, Outbox, PrismaClient } from '@prisma/client';
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
} from './admin-auth.js';
import { hashPassword, verifyPassword } from './password.js';
import { TOKEN_TTL_SECONDS, passwordFingerprint, verifyAdminToken } from './token.js';

/**
 * Login, lockout and password reset (plan.md Task 7, spec §6.23), called
 * directly against real PostgreSQL. The clock is injected and mutable, so a lock
 * or a token expiry is crossed by moving `clock`, never by waiting.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let deps: AuthDeps;
/** Argon2id of PASSWORD, computed once: every seeded admin reuses it. */
let passwordHash: string;
let clock: Date;

const SECRET = 'admin-auth-test-secret-at-least-32-characters-long';
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

function seedAdmin(email = EMAIL): Promise<AdminUser> {
  return prisma.adminUser.create({ data: { email, passwordHash } });
}

function reload(admin: AdminUser): Promise<AdminUser> {
  return prisma.adminUser.findUniqueOrThrow({ where: { id: admin.id } });
}

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function lockedUntilMs(admin: AdminUser): number {
  if (admin.lockedUntil === null) throw new Error('Expected the admin to be locked');
  return admin.lockedUntil.getTime();
}

async function failLogins(times: number, email = EMAIL): Promise<void> {
  for (let i = 0; i < times; i++) {
    await expect(attemptLogin(deps, email, WRONG)).resolves.toEqual({
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

async function outboxRows(variant: 'login_lockout' | 'password_reset'): Promise<Outbox[]> {
  const rows = await prisma.outbox.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.filter((row) => payloadOf(row).variant === variant);
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
  it('issues a bearer token bound to the current password hash, expiring in 8 hours', async () => {
    const admin = await seedAdmin();

    const result = signedIn(await attemptLogin(deps, EMAIL, PASSWORD));

    expect(result.expiresAt.getTime()).toBe(START.getTime() + TOKEN_TTL_SECONDS * 1000);
    await expect(verifyAdminToken(SECRET, result.token, START)).resolves.toEqual({
      adminId: admin.id,
      passwordFingerprint: passwordFingerprint(SECRET, admin.passwordHash),
    });
  });

  it('puts neither the password hash nor anything cookie- or CSRF-shaped in the result', async () => {
    const admin = await seedAdmin();

    const result = signedIn(await attemptLogin(deps, EMAIL, PASSWORD));

    expect(Object.keys(result).sort()).toEqual(['admin', 'expiresAt', 'status', 'token']);
    const [, payload] = result.token.split('.');
    expect(Buffer.from(payload ?? '', 'base64url').toString()).not.toContain(admin.passwordHash);
  });

  it('records last_login_at from the injected clock', async () => {
    const admin = await seedAdmin();

    const result = signedIn(await attemptLogin(deps, EMAIL, PASSWORD));

    expect(result.admin.lastLoginAt?.toISOString()).toBe(START.toISOString());
    await expect(reload(admin)).resolves.toMatchObject({ lastLoginAt: START });
  });

  it.each(['PHOTOGRAPHER@BOOKLY.EXAMPLE', 'Photographer@Bookly.Example'])(
    'matches the email case-insensitively (%s)',
    async (casing) => {
      const admin = await seedAdmin();

      const result = signedIn(await attemptLogin(deps, casing, PASSWORD));

      expect(result.admin.id).toBe(admin.id);
    },
  );

  it('matches a mixed-case stored email from a lower-case attempt', async () => {
    await seedAdmin('Photographer@Bookly.Example');

    await expect(attemptLogin(deps, EMAIL, PASSWORD)).resolves.toMatchObject({ status: 'ok' });
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

    await expect(attemptLogin(deps, 'someone@else.example', PASSWORD)).resolves.toEqual({
      status: 'invalid_credentials',
    });

    await expect(reload(admin)).resolves.toEqual(admin);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('gives one result for unknown email, wrong password and a locked account', async () => {
    await seedAdmin();

    const unknown = await attemptLogin(deps, 'someone@else.example', PASSWORD);
    const wrong = await attemptLogin(deps, EMAIL, WRONG);
    await failLogins(LOCKOUT_THRESHOLD - 1);
    const locked = await attemptLogin(deps, EMAIL, PASSWORD);

    expect(unknown).toEqual({ status: 'invalid_credentials' });
    expect(wrong).toEqual(unknown);
    expect(locked).toEqual(unknown);
  });

  it('does not issue a session for a refused attempt', async () => {
    await seedAdmin();

    const result = await attemptLogin(deps, EMAIL, WRONG);

    expect(Object.keys(result)).toEqual(['status']);
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
    await expect(attemptLogin(deps, EMAIL, PASSWORD)).resolves.toEqual({
      status: 'invalid_credentials',
    });

    clock = new Date(until + 1);
    await expect(attemptLogin(deps, EMAIL, PASSWORD)).resolves.toMatchObject({ status: 'ok' });
  });

  it('does not count attempts made while locked, right or wrong', async () => {
    const admin = await seedAdmin();
    await failLogins(LOCKOUT_THRESHOLD);
    const before = await reload(admin);

    advance(30_000);
    await failLogins(3);
    await expect(attemptLogin(deps, EMAIL, PASSWORD)).resolves.toEqual({
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
    await expect(attemptLogin(deps, EMAIL, PASSWORD)).resolves.toMatchObject({ status: 'ok' });
  }, 30_000);

  it('zeroes the count and clears the lock on success', async () => {
    const admin = await seedAdmin();
    await failLogins(LOCKOUT_THRESHOLD - 1);

    signedIn(await attemptLogin(deps, EMAIL, PASSWORD));

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
    signedIn(await attemptLogin(deps, EMAIL, PASSWORD));

    const lockedAt = clock.getTime();
    await failLogins(LOCKOUT_THRESHOLD);

    expect(lockedUntilMs(await reload(admin))).toBe(lockedAt + MINUTE_MS);
  }, 30_000);

  it('enqueues exactly one admin_alert per lock, addressed to the stored email', async () => {
    const admin = await seedAdmin('Photographer@Bookly.Example');
    await failLogins(LOCKOUT_THRESHOLD);
    await failLogins(2); // locked: not counted, no second email

    const rows = await prisma.outbox.findMany();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) return;
    expect(row).toMatchObject({
      kind: 'email',
      template: 'admin_alert',
      recipient: 'Photographer@Bookly.Example',
      bookingId: null,
      status: 'pending',
    });
    const until = lockedUntilMs(await reload(admin));
    expect(payloadOf(row)).toEqual({
      variant: 'login_lockout',
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
    await Promise.all(Array.from({ length: 10 }, () => prisma.adminUser.count()));
  });

  it('counts one lock worth of failures from a simultaneous burst of 10', async () => {
    const admin = await seedAdmin();

    await Promise.all(Array.from({ length: 10 }, () => attemptLogin(deps, EMAIL, WRONG)));

    const row = await reload(admin);
    expect(row.failedLoginCount).toBe(LOCKOUT_THRESHOLD);
    expect(lockedUntilMs(row)).toBe(START.getTime() + MINUTE_MS);
    await expect(outboxRows('login_lockout')).resolves.toHaveLength(1);
  }, 30_000);

  it('never throws on a simultaneous burst of 20 wrong passwords', async () => {
    await seedAdmin();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => attemptLogin(deps, EMAIL, WRONG)),
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

      await expect(attemptLogin(deps, pattern, PASSWORD)).resolves.toEqual({
        status: 'invalid_credentials',
      });
    },
  );

  it('does not count a wildcard-email failure against the admin', async () => {
    const admin = await seedAdmin();

    await attemptLogin(deps, '%', WRONG);

    await expect(reload(admin)).resolves.toMatchObject({ failedLoginCount: 0 });
  });

  it.each(['\\', 'photographer@bookly.example\\', '\\%'])(
    'resolves rather than throws for the email %j',
    async (email) => {
      await seedAdmin();

      await expect(attemptLogin(deps, email, PASSWORD)).resolves.toEqual({
        status: 'invalid_credentials',
      });
    },
  );

  it('sends no reset link for a wildcard email', async () => {
    await seedAdmin();

    await requestPasswordReset(deps, '%');

    await expect(prisma.outbox.count()).resolves.toBe(0);
  });
});

// --- Password reset: request ---------------------------------------------------

describe('requestPasswordReset', () => {
  it('stores only the SHA-256 hex of the token, never the token', async () => {
    const admin = await seedAdmin();

    await requestPasswordReset(deps, EMAIL);

    const token = await latestResetToken();
    const row = await reload(admin);
    expect(row.passwordResetTokenHash).not.toBe(token);
    expect(row.passwordResetTokenHash).toBe(sha256(token));
    expect(row.passwordResetTokenHash).toMatch(/^[0-9a-f]{64}$/);

    // Nowhere in the row at all, in any column.
    const all = await raw.query<{ row: string }>(
      'SELECT row_to_json(a)::text AS row FROM admin_user a WHERE id = $1',
      [admin.id],
    );
    expect(firstRow(all).row).not.toContain(token);
  });

  it('issues a high-entropy base64url token', async () => {
    await seedAdmin();

    await requestPasswordReset(deps, EMAIL);

    const token = await latestResetToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(32);
  });

  it('expires the token 30 minutes after the request', async () => {
    const admin = await seedAdmin();

    await requestPasswordReset(deps, EMAIL);

    const row = await reload(admin);
    expect(row.passwordResetExpiresAt?.getTime()).toBe(START.getTime() + RESET_TTL_MS);
  });

  it('enqueues an admin_alert whose link is a #token= fragment on the web origin', async () => {
    await seedAdmin();

    await requestPasswordReset(deps, EMAIL);

    const rows = await outboxRows('password_reset');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) return;
    expect(row).toMatchObject({
      kind: 'email',
      template: 'admin_alert',
      recipient: EMAIL,
      bookingId: null,
    });
    const payload = payloadOf(row);
    expect(payload.expiresAt).toBe(new Date(START.getTime() + RESET_TTL_MS).toISOString());

    const url = new URL(String(payload.resetUrl));
    expect(url.origin).toBe(WEB_ORIGIN);
    expect(url.pathname).toBe('/admin/reset-password');
    // A fragment, never a query string: no server log or Referer sees it.
    expect(url.search).toBe('');
    expect(url.hash).toMatch(/^#token=[A-Za-z0-9_-]+$/);
  });

  it('addresses the link to the stored email, not the casing that was typed', async () => {
    await seedAdmin('Photographer@Bookly.Example');

    await requestPasswordReset(deps, 'PHOTOGRAPHER@BOOKLY.EXAMPLE');

    const rows = await outboxRows('password_reset');
    expect(rows.map((row) => row.recipient)).toEqual(['Photographer@Bookly.Example']);
  });

  it('does nothing for an unknown email: no outbox row, no change to the admin', async () => {
    const admin = await seedAdmin();

    await expect(requestPasswordReset(deps, 'someone@else.example')).resolves.toBeUndefined();

    await expect(prisma.outbox.count()).resolves.toBe(0);
    await expect(reload(admin)).resolves.toEqual(admin);
  });

  it('replaces the first token with the second, so only the newest link works', async () => {
    const admin = await seedAdmin();
    await requestPasswordReset(deps, EMAIL);
    const first = await latestResetToken();
    advance(MINUTE_MS);
    await requestPasswordReset(deps, EMAIL);
    const second = await latestResetToken();

    expect(second).not.toBe(first);
    await expect(reload(admin)).resolves.toMatchObject({ passwordResetTokenHash: sha256(second) });
    await expect(confirmPasswordReset(deps, first, NEW_PASSWORD)).resolves.toBe(
      'invalid_or_expired_token',
    );
    await expect(confirmPasswordReset(deps, second, NEW_PASSWORD)).resolves.toBe('ok');
  });

  it('works for a locked account', async () => {
    await seedAdmin();
    await failLogins(LOCKOUT_THRESHOLD);

    await requestPasswordReset(deps, EMAIL);

    await expect(outboxRows('password_reset')).resolves.toHaveLength(1);
  });
});

// --- Password reset: confirm ---------------------------------------------------

describe('confirmPasswordReset', () => {
  it('sets the new password and clears the token', async () => {
    const admin = await seedAdmin();
    await requestPasswordReset(deps, EMAIL);

    await expect(confirmPasswordReset(deps, await latestResetToken(), NEW_PASSWORD)).resolves.toBe(
      'ok',
    );

    const row = await reload(admin);
    await expect(verifyPassword(row.passwordHash, NEW_PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(row.passwordHash, PASSWORD)).resolves.toBe(false);
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordResetTokenHash).toBeNull();
    expect(row.passwordResetExpiresAt).toBeNull();
  });

  it('accepts a token once and refuses it on reuse', async () => {
    const admin = await seedAdmin();
    await requestPasswordReset(deps, EMAIL);
    const token = await latestResetToken();

    await expect(confirmPasswordReset(deps, token, NEW_PASSWORD)).resolves.toBe('ok');
    await expect(confirmPasswordReset(deps, token, 'a second attempt at a password')).resolves.toBe(
      'invalid_or_expired_token',
    );

    const row = await reload(admin);
    await expect(verifyPassword(row.passwordHash, NEW_PASSWORD)).resolves.toBe(true);
  });

  it('accepts the token 1 ms before it expires', async () => {
    await seedAdmin();
    await requestPasswordReset(deps, EMAIL);

    advance(RESET_TTL_MS - 1);

    await expect(confirmPasswordReset(deps, await latestResetToken(), NEW_PASSWORD)).resolves.toBe(
      'ok',
    );
  });

  it.each([0, 1, MINUTE_MS])(
    'refuses the token %i ms after its 30 minutes are up, leaving the password alone',
    async (past) => {
      const admin = await seedAdmin();
      await requestPasswordReset(deps, EMAIL);

      advance(RESET_TTL_MS + past);

      await expect(
        confirmPasswordReset(deps, await latestResetToken(), NEW_PASSWORD),
      ).resolves.toBe('invalid_or_expired_token');
      await expect(reload(admin)).resolves.toMatchObject({ passwordHash });
    },
  );

  it.each<[string, (pending: AdminUser) => string]>([
    ['an unknown token', () => 'x'.repeat(43)],
    // Someone who can read the column must still not be able to use it.
    ['the stored hash submitted as the token', (pending) => String(pending.passwordResetTokenHash)],
  ])('refuses %s and leaves the pending reset untouched', async (_label, forge) => {
    const admin = await seedAdmin();
    await requestPasswordReset(deps, EMAIL);
    const pending = await reload(admin);

    await expect(confirmPasswordReset(deps, forge(pending), NEW_PASSWORD)).resolves.toBe(
      'invalid_or_expired_token',
    );
    await expect(reload(admin)).resolves.toEqual(pending);
  });

  it('refuses any token when no reset was ever requested', async () => {
    const admin = await seedAdmin();

    await expect(confirmPasswordReset(deps, 'anything-at-all', NEW_PASSWORD)).resolves.toBe(
      'invalid_or_expired_token',
    );
    await expect(reload(admin)).resolves.toEqual(admin);
  });

  it('lets exactly one of two simultaneous confirmations of one token win', async () => {
    const admin = await seedAdmin();
    await requestPasswordReset(deps, EMAIL);
    const token = await latestResetToken();
    const passwords = ['first racing new password', 'second racing new password'];

    const results = await Promise.all(
      passwords.map((password) => confirmPasswordReset(deps, token, password)),
    );

    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'invalid_or_expired_token')).toHaveLength(1);
    const row = await reload(admin);
    const matches = await Promise.all(passwords.map((p) => verifyPassword(row.passwordHash, p)));
    expect(matches.filter(Boolean)).toHaveLength(1);
  });

  it('clears a lockout, so the new password works at once', async () => {
    const admin = await seedAdmin();
    await failLogins(LOCKOUT_THRESHOLD);
    await requestPasswordReset(deps, EMAIL);

    await expect(confirmPasswordReset(deps, await latestResetToken(), NEW_PASSWORD)).resolves.toBe(
      'ok',
    );

    await expect(reload(admin)).resolves.toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    // Same instant as the lock: without the reset this would still be refused.
    await expect(attemptLogin(deps, EMAIL, NEW_PASSWORD)).resolves.toMatchObject({ status: 'ok' });
  }, 30_000);

  it('invalidates a bearer token issued before the change', async () => {
    const admin = await seedAdmin();
    const { token } = signedIn(await attemptLogin(deps, EMAIL, PASSWORD));
    const claims = await verifyAdminToken(SECRET, token, START);
    if (claims === null) throw new Error('Login issued a token that does not verify');
    await requestPasswordReset(deps, EMAIL);

    await confirmPasswordReset(deps, await latestResetToken(), NEW_PASSWORD);

    const row = await reload(admin);
    // The signature still verifies -- nothing about the JWT itself changed. What
    // no longer matches is the fingerprint `requireAdmin` compares it against.
    expect(claims.passwordFingerprint).toBe(passwordFingerprint(SECRET, admin.passwordHash));
    expect(claims.passwordFingerprint).not.toBe(passwordFingerprint(SECRET, row.passwordHash));
  });
});
