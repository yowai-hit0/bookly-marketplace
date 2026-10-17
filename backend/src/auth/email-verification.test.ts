import { createHash } from 'node:crypto';
import type { AppUser, Outbox, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertClient } from '../booking/client.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type AuthDeps, LOCKOUT_THRESHOLD, attemptLogin, confirmPasswordReset, requestPasswordReset } from './account-auth.js';
import { EMAIL_VERIFY_TTL_HOURS, confirmEmailVerification, issueVerification, requestVerificationResend } from './email-verification.js';
import { hashPassword } from './password.js';
import { AREA_ROLE, AREA_WEB_PATHS, AUTH_AREAS, type AuthArea } from './roles.js';
import { signUpClient } from './signup.js';
import { verifyToken } from './token.js';

/**
 * Email verification (Phase 2 decision 3; marketplace-spec.md R2.1c), called
 * directly against real PostgreSQL with an injected clock:
 *
 * - the link: 24 hours, SHA-256 at rest, single-use, newest only;
 * - (a) confirming needs the token AND the account's password, one refusal for
 *   either, counted toward the lockout;
 * - (b) a completed password reset verifies the address;
 * - the pre-registration hijack these close, end to end;
 * - a client's bookings are linked on verification, never before (T2.2).
 */

let prisma: PrismaClient;
let raw: pg.Client;
let deps: AuthDeps;
let passwordHash: string;
let clock: Date;

const SECRET = 'email-verification-test-secret-at-least-32-chars';
const WEB_ORIGIN = 'https://bookly.example';
const EMAIL = 'victim@bookly.example';
const PASSWORD = 'the password chosen at signup';
const WRONG = 'not the password chosen at signup';
const ATTACKER_PASSWORD = 'the attacker chose this one';
const VICTIM_PASSWORD = 'the victim sets this one by reset';
const START = new Date('2026-10-17T07:00:00Z');
const HOUR_MS = 60 * 60_000;

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
  deps = { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock };
  passwordHash = await hashPassword(PASSWORD);
});

afterAll(async () => {
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  clock = START;
});

// --- Fixtures ---------------------------------------------------------------

let handleCounter = 0;

/** An UNVERIFIED login of `role` with PASSWORD, and its photographer row when it is a photographer. */
function seedUnverified(role: (typeof AREA_ROLE)[AuthArea], email = EMAIL): Promise<AppUser> {
  handleCounter += 1;
  return prisma.appUser.create({
    data: {
      email,
      role,
      passwordHash,
      ...(role === 'photographer' ? { photographer: { create: { handle: `verify-${handleCounter}`, displayName: 'Kigali Lens' } } } : {}),
    },
  });
}

function reload(user: AppUser): Promise<AppUser> {
  return prisma.appUser.findUniqueOrThrow({ where: { id: user.id } });
}

function payloadOf(row: Outbox): Record<string, unknown> {
  return row.payload as Record<string, unknown>;
}

function verificationEmails(): Promise<Outbox[]> {
  return prisma.outbox.findMany({ where: { template: 'account_verify_email' }, orderBy: { createdAt: 'asc' } });
}

/** The plaintext token, from the only place it lives: the newest verification email. */
async function latestVerifyToken(): Promise<string> {
  const row = (await verificationEmails()).at(-1);
  if (row === undefined) throw new Error('Expected an account_verify_email row');
  return String(payloadOf(row).token);
}

async function latestResetToken(): Promise<string> {
  const rows = await prisma.outbox.findMany({ where: { template: 'account_password_reset' }, orderBy: { createdAt: 'asc' } });
  const row = rows.at(-1);
  if (row === undefined) throw new Error('Expected an account_password_reset row');
  return new URL(String(payloadOf(row).resetUrl)).hash.slice('#token='.length);
}

async function issueFor(area: AuthArea, user: AppUser): Promise<string> {
  await prisma.$transaction((tx) => issueVerification(tx, deps, area, user));
  return latestVerifyToken();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A client row with one booking-less record under `email`: what a guest booking leaves behind. */
async function guestClientRow(email = EMAIL): Promise<string> {
  return prisma.$transaction((tx) => upsertClient(tx, { fullName: 'Aline Uwase', email, phone: '+250788000000' }));
}

async function clientRowUser(id: string): Promise<string | null> {
  return (await prisma.client.findUniqueOrThrow({ where: { id } })).userId;
}

// --- The link ------------------------------------------------------------------

describe('issueVerification', () => {
  it('stores only the SHA-256 of a 256-bit token, expiring in 24 hours, and emails the area page', async () => {
    const user = await seedUnverified('client');

    const token = await issueFor('account', user);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await reload(user);
    expect(row.emailVerifyTokenHash).toBe(sha256(token));
    expect(row.emailVerifyExpiresAt?.getTime()).toBe(START.getTime() + EMAIL_VERIFY_TTL_HOURS * HOUR_MS);
    const [email] = await verificationEmails();
    expect(email).toMatchObject({ recipient: EMAIL, photographerId: null, bookingId: null });
    expect(payloadOf(email!)).toEqual({ area: 'account', token, expiresAt: new Date(START.getTime() + 24 * HOUR_MS).toISOString() });
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('replaces the first link with the second: only the newest works', async () => {
    const user = await seedUnverified('client');
    const first = await issueFor('account', user);
    const second = await issueFor('account', user);

    await expect(confirmEmailVerification(deps, 'account', first, PASSWORD)).resolves.toEqual({ status: 'invalid' });
    await expect(confirmEmailVerification(deps, 'account', second, PASSWORD)).resolves.toMatchObject({ status: 'ok' });
  });
});

// --- (a) token AND password ---------------------------------------------------------

describe.each(AUTH_AREAS.map((area) => [area, AREA_ROLE[area]] as const))('confirmEmailVerification in the %s area', (area, role) => {
  it(`verifies a ${role} with the token and the password, spends the token, and signs them in`, async () => {
    const user = await seedUnverified(role);
    const token = await issueFor(area, user);

    const result = await confirmEmailVerification(deps, area, token, PASSWORD);

    if (result.status !== 'ok') throw new Error('Expected ok');
    expect(result.user.id).toBe(user.id);
    await expect(verifyToken(SECRET, area, result.token, START)).resolves.toMatchObject({ userId: user.id });
    await expect(reload(user)).resolves.toMatchObject({ emailVerifiedAt: START, emailVerifyTokenHash: null, emailVerifyExpiresAt: null, lastLoginAt: START });
    await expect(attemptLogin(deps, area, EMAIL, PASSWORD)).resolves.toMatchObject({ status: 'ok' });
    await expect(confirmEmailVerification(deps, area, token, PASSWORD)).resolves.toEqual({ status: 'invalid' });
  });

  it(`refuses a ${role}'s token with the wrong password exactly like a bad token, and counts the attempt`, async () => {
    const user = await seedUnverified(role);
    const token = await issueFor(area, user);

    const wrongPassword = await confirmEmailVerification(deps, area, token, WRONG);
    const badToken = await confirmEmailVerification(deps, area, 'x'.repeat(43), PASSWORD);

    expect(wrongPassword).toEqual(badToken);
    expect(wrongPassword).toEqual({ status: 'invalid' });
    await expect(reload(user)).resolves.toMatchObject({ emailVerifiedAt: null, failedLoginCount: 1, emailVerifyTokenHash: sha256(token) });
  });

  it.each(AUTH_AREAS.filter((other) => other !== area))(`refuses a ${role}'s token at the %s area`, async (other) => {
    const user = await seedUnverified(role);
    const token = await issueFor(area, user);

    await expect(confirmEmailVerification(deps, other, token, PASSWORD)).resolves.toEqual({ status: 'invalid' });
    await expect(reload(user)).resolves.toMatchObject({ emailVerifiedAt: null, failedLoginCount: 0 });
  });
});

describe('confirmEmailVerification refusals', () => {
  it('accepts the token 1 ms before 24 hours and refuses it at 24 hours', async () => {
    const user = await seedUnverified('client');
    const token = await issueFor('account', user);

    clock = new Date(START.getTime() + 24 * HOUR_MS);
    await expect(confirmEmailVerification(deps, 'account', token, PASSWORD)).resolves.toEqual({ status: 'invalid' });
    clock = new Date(START.getTime() + 24 * HOUR_MS - 1);
    await expect(confirmEmailVerification(deps, 'account', token, PASSWORD)).resolves.toMatchObject({ status: 'ok' });
  });

  it('refuses a login disabled since the link went out', async () => {
    const user = await seedUnverified('client');
    const token = await issueFor('account', user);
    await prisma.appUser.update({ where: { id: user.id }, data: { disabledAt: START } });

    await expect(confirmEmailVerification(deps, 'account', token, PASSWORD)).resolves.toEqual({ status: 'invalid' });
  });

  it('locks the account after five wrong passwords, and then refuses even the right one until the lock ends', async () => {
    const user = await seedUnverified('client');
    const token = await issueFor('account', user);

    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) await confirmEmailVerification(deps, 'account', token, WRONG);

    await expect(confirmEmailVerification(deps, 'account', token, PASSWORD)).resolves.toEqual({ status: 'invalid' });
    clock = new Date(START.getTime() + 60_000);
    await expect(confirmEmailVerification(deps, 'account', token, PASSWORD)).resolves.toMatchObject({ status: 'ok' });
    // No lockout alert to an address nobody had verified.
    await expect(prisma.outbox.count({ where: { template: 'account_security_alert' } })).resolves.toBe(0);
  }, 30_000);

  it('lets exactly one of two simultaneous confirmations win', async () => {
    const user = await seedUnverified('client');
    const token = await issueFor('account', user);

    const results = await Promise.all([confirmEmailVerification(deps, 'account', token, PASSWORD), confirmEmailVerification(deps, 'account', token, PASSWORD)]);

    expect(results.map((r) => r.status).sort()).toEqual(['invalid', 'ok']);
  });
});

// --- Resend ------------------------------------------------------------------------

describe('requestVerificationResend', () => {
  it('sends an unverified login of the area a new link', async () => {
    const user = await seedUnverified('photographer');

    await requestVerificationResend(deps, 'studio', EMAIL.toUpperCase());

    const [email] = await verificationEmails();
    expect(payloadOf(email!)).toMatchObject({ area: 'studio' });
    expect((await reload(user)).emailVerifyTokenHash).toBe(sha256(await latestVerifyToken()));
  });

  it.each([
    ['an unknown address', async () => undefined],
    ['a verified login', async () => prisma.appUser.update({ where: { id: (await seedUnverified('client')).id }, data: { emailVerifiedAt: START } })],
    ['another area login', async () => seedUnverified('photographer')],
    ['a disabled login', async () => prisma.appUser.update({ where: { id: (await seedUnverified('client')).id }, data: { disabledAt: START } })],
    ['a wildcard', async () => seedUnverified('client', 'someone@bookly.example')],
  ])('sends nothing for %s', async (label, seed) => {
    await seed();

    await expect(requestVerificationResend(deps, 'account', label === 'a wildcard' ? '%' : EMAIL)).resolves.toBeUndefined();

    await expect(prisma.outbox.count()).resolves.toBe(0);
  });
});

// --- (b) a completed reset verifies -----------------------------------------------------

describe('a completed password reset (R2.1c (b))', () => {
  it.each(AUTH_AREAS.map((area) => [area, AREA_ROLE[area]] as const))('verifies an unverified %s address and voids its verification link', async (area, role) => {
    const user = await seedUnverified(role);
    const verifyLink = await issueFor(area, user);

    await requestPasswordReset(deps, area, EMAIL);
    await expect(confirmPasswordReset(deps, area, await latestResetToken(), VICTIM_PASSWORD)).resolves.toBe('ok');

    await expect(reload(user)).resolves.toMatchObject({ emailVerifiedAt: START, emailVerifyTokenHash: null, emailVerifyExpiresAt: null });
    await expect(attemptLogin(deps, area, EMAIL, VICTIM_PASSWORD)).resolves.toMatchObject({ status: 'ok' });
    await expect(confirmEmailVerification(deps, area, verifyLink, VICTIM_PASSWORD)).resolves.toEqual({ status: 'invalid' });
  });

  it('keeps the original verification time of an address already verified', async () => {
    const verifiedAt = new Date('2026-09-01T06:00:00Z');
    const user = await prisma.appUser.update({ where: { id: (await seedUnverified('client')).id }, data: { emailVerifiedAt: verifiedAt } });

    await requestPasswordReset(deps, 'account', EMAIL);
    await confirmPasswordReset(deps, 'account', await latestResetToken(), VICTIM_PASSWORD);

    await expect(reload(user)).resolves.toMatchObject({ emailVerifiedAt: verifiedAt });
  });

  it("links an unverified client's bookings as it verifies them", async () => {
    const row = await guestClientRow();
    const user = await seedUnverified('client');

    await requestPasswordReset(deps, 'account', EMAIL);
    await confirmPasswordReset(deps, 'account', await latestResetToken(), VICTIM_PASSWORD);

    expect(await clientRowUser(row)).toBe(user.id);
  });
});

// --- The pre-registration hijack, end to end ---------------------------------------------

describe('someone signs up with another person’s address (R2.1c)', () => {
  async function attackerSignsUp(): Promise<AppUser> {
    await signUpClient(deps, { email: EMAIL, password: ATTACKER_PASSWORD, fullName: 'Not the owner' });
    return prisma.appUser.findFirstOrThrow({ where: { email: EMAIL } });
  }

  it('gives the attacker nothing before verification: no login, no bookings', async () => {
    const row = await guestClientRow();
    await attackerSignsUp();

    await expect(attemptLogin(deps, 'account', EMAIL, ATTACKER_PASSWORD)).resolves.toEqual({ status: 'invalid_credentials' });
    expect(await clientRowUser(row)).toBeNull();
  });

  it('cannot be verified by the attacker without the inbox: the token is never theirs to guess', async () => {
    const user = await attackerSignsUp();

    // The attacker has the password but not the emailed token.
    await expect(confirmEmailVerification(deps, 'account', 'A'.repeat(43), ATTACKER_PASSWORD)).resolves.toEqual({ status: 'invalid' });
    // And asking for another link sends it to the victim's inbox, not to them.
    await requestVerificationResend(deps, 'account', EMAIL);
    expect((await verificationEmails()).map((email) => email.recipient)).toEqual([EMAIL, EMAIL]);
    await expect(reload(user)).resolves.toMatchObject({ emailVerifiedAt: null });
  });

  it('is not verified when the victim clicks the link: it needs a password the victim never chose', async () => {
    const user = await attackerSignsUp();
    const token = await latestVerifyToken();

    await expect(confirmEmailVerification(deps, 'account', token, VICTIM_PASSWORD)).resolves.toEqual({ status: 'invalid' });

    await expect(reload(user)).resolves.toMatchObject({ emailVerifiedAt: null });
    await expect(attemptLogin(deps, 'account', EMAIL, ATTACKER_PASSWORD)).resolves.toEqual({ status: 'invalid_credentials' });
  });

  it("is the victim's after a reset: their password works, the attacker's never will, and the bookings are theirs", async () => {
    const row = await guestClientRow();
    const user = await attackerSignsUp();

    await requestPasswordReset(deps, 'account', EMAIL);
    await confirmPasswordReset(deps, 'account', await latestResetToken(), VICTIM_PASSWORD);

    await expect(attemptLogin(deps, 'account', EMAIL, ATTACKER_PASSWORD)).resolves.toEqual({ status: 'invalid_credentials' });
    await expect(attemptLogin(deps, 'account', EMAIL, VICTIM_PASSWORD)).resolves.toMatchObject({ status: 'ok' });
    expect(await clientRowUser(row)).toBe(user.id);
  });

  it("does not let the attacker's second signup replace the stored password", async () => {
    const user = await attackerSignsUp();

    await signUpClient(deps, { email: EMAIL, password: 'a third password entirely', fullName: 'Again' });

    await expect(reload(user)).resolves.toMatchObject({ passwordHash: user.passwordHash, fullName: 'Not the owner' });
  });
});

// --- Client linking (T2.2) --------------------------------------------------------------------

describe('linking a client account to its bookings (marketplace-data-model.md §2.8)', () => {
  it('links on verification, never before, and leaves a row another account owns alone', async () => {
    const mine = await guestClientRow();
    const other = await prisma.appUser.create({ data: { email: 'someone.else@bookly.example', role: 'client', passwordHash, emailVerifiedAt: START } });
    const owned = await prisma.client.create({ data: { fullName: 'Owned', email: 'owned@bookly.example', phone: null, userId: other.id } });
    const user = await seedUnverified('client');
    const token = await issueFor('account', user);
    expect(await clientRowUser(mine)).toBeNull();

    await confirmEmailVerification(deps, 'account', token, PASSWORD);

    expect(await clientRowUser(mine)).toBe(user.id);
    expect(await clientRowUser(owned.id)).toBe(other.id);
  });

  it("links a new guest booking's client row to a verified client account, and not to an unverified one", async () => {
    const unverified = await seedUnverified('client', 'pending@bookly.example');
    const verified = await prisma.appUser.create({ data: { email: 'Verified@Bookly.example', role: 'client', passwordHash, emailVerifiedAt: START } });

    const pendingRow = await guestClientRow('pending@bookly.example');
    const verifiedRow = await guestClientRow('verified@bookly.example');

    expect(await clientRowUser(pendingRow)).toBeNull();
    expect(await clientRowUser(verifiedRow)).toBe(verified.id);
    expect(unverified.emailVerifiedAt).toBeNull();
  });

  it('keeps the account a client row already has when a later booking upserts it (COALESCE)', async () => {
    const row = await guestClientRow();
    const owner = await prisma.appUser.create({ data: { email: 'owner@bookly.example', role: 'client', passwordHash, emailVerifiedAt: START } });
    await prisma.client.update({ where: { id: row }, data: { userId: owner.id } });
    await prisma.appUser.create({ data: { email: EMAIL, role: 'client', passwordHash, emailVerifiedAt: START } });

    await guestClientRow();

    expect(await clientRowUser(row)).toBe(owner.id);
  });

  it('never links a booking to a photographer or a platform admin with the same address', async () => {
    await prisma.appUser.create({ data: { email: EMAIL, role: 'platform_admin', passwordHash, emailVerifiedAt: START } });

    expect(await clientRowUser(await guestClientRow())).toBeNull();
  });

  it('writes the web page of each area into the link', () => {
    expect(AUTH_AREAS.map((area) => AREA_WEB_PATHS[area].verify)).toEqual(['/studio/verify', '/platform/verify', '/account/verify']);
  });
});
