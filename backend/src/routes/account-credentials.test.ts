import type { AppUser, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT_EMAIL_CHANGE_TTL_HOURS, deletedEmailOf } from '../account/credentials.js';
import { createApp } from '../app.js';
import { LOCKOUT_THRESHOLD } from '../auth/account-auth.js';
import type { GoogleIdentityProvider } from '../auth/google.js';
import { issueToken, sha256Hex } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { processNext } from '../outbox/worker.js';
import { ACCOUNT_PASSWORD, accountToken, createClientAccount } from '../test/account-fixtures.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { CLIENT, type PaymentWorld, TEST_SECRET, grantAccessToken, insertBooking, seedWorld } from '../test/payment-fixtures.js';

/**
 * What a signed-in client changes about their login, over HTTP
 * (marketplace-spec.md Phase 8, R8.3; units B5, B6, B8; T8.3; user decisions
 * 2026-10-27, 2 to 4): the password (changed, or added to a Google-only
 * account), the address (asked for with the password, confirmed from the new
 * inbox with the token and the password), and the account itself (deleted:
 * anonymised, its bookings unlinked and kept).
 */

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let x: AppUser;
let tokenX: string;
let googleKey: SigningKey;
let jwks: GoogleIdentityProvider['jwks'];

/** Monday 1 June 2027, 08:00 in Kigali. */
const NOW = new Date('2027-06-01T06:00:00Z');
const HOUR_MS = 3_600_000;
const WEB_ORIGIN = 'https://bookly.example';
const NEW_PASSWORD = 'an entirely new client password';
const NEW_EMAIL = 'aline.new@example.com';
const CLIENT_ID = 'bookly-credentials.apps.googleusercontent.com';
const GOOGLE_SUB = 'google-subject-credentials';

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
  const pair = await generateKeyPair('RS256', { extractable: true });
  googleKey = pair.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] });
});

afterAll(async () => {
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  world = await seedWorld(prisma);
  x = await createClientAccount(prisma, { email: CLIENT.email });
  tokenX = await accountToken(TEST_SECRET, prisma, x.id, NOW);
});

/** The fake identity provider: every code is an id_token for `email` under `sub`, carrying the flow's nonce. */
function fakeGoogle(identity: { sub: string; email: string }, nonce: { value: string }): GoogleIdentityProvider {
  return {
    clientId: CLIENT_ID,
    authorizationEndpoint: 'https://accounts.google.example/auth',
    jwks,
    async exchangeCode() {
      const iat = Math.floor(NOW.getTime() / 1000);
      return new SignJWT({ nonce: nonce.value, email: identity.email, email_verified: true, name: 'From Google' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer('https://accounts.google.com')
        .setAudience(CLIENT_ID)
        .setSubject(identity.sub)
        .setIssuedAt(iat)
        .setExpirationTime(iat + 600)
        .sign(googleKey);
    },
  };
}

function app(options: { now?: Date; google?: GoogleIdentityProvider } = {}): Express {
  const now = options.now ?? NOW;
  return createApp({
    auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: WEB_ORIGIN, now: () => now },
    publicApi: { prisma, now: () => now },
    ...(options.google === undefined ? {} : { google: options.google }),
  });
}

function post(path: string, body: object, token: string | null = tokenX, server = app()) {
  const call = request(server).post(path);
  return (token === null ? call : call.set('Authorization', `Bearer ${token}`)).send(body);
}

function me(token: string, server = app()) {
  return request(server).get('/api/account/me').set('Authorization', `Bearer ${token}`);
}

function login(email: string, password: string, server = app()) {
  return request(server).post('/api/account/auth/login').send({ email, password });
}

/** Signs in with the fake Google, through the real start and callback routes. */
async function googleSignIn(identity: { sub: string; email: string }) {
  const nonce = { value: '' };
  const server = app({ google: fakeGoogle(identity, nonce) });
  const started = await request(server).post('/api/account/auth/google/start');
  nonce.value = new URL(started.body.authorizationUrl).searchParams.get('nonce') ?? '';
  return request(server).post('/api/account/auth/google/callback').send({ code: 'a-code', state: started.body.state });
}

async function securityAlerts(recipient: string) {
  return prisma.outbox.findMany({ where: { template: 'account_security_alert', recipient }, orderBy: { createdAt: 'asc' } });
}

async function reload(user: AppUser): Promise<AppUser> {
  return prisma.appUser.findUniqueOrThrow({ where: { id: user.id } });
}

async function googleOnly(email = 'g.only@example.com'): Promise<{ user: AppUser; token: string }> {
  const user = await createClientAccount(prisma, { email, password: null, googleSub: GOOGLE_SUB });
  return { user, token: await accountToken(TEST_SECRET, prisma, user.id, NOW) };
}

// --- B5: changing the password -------------------------------------------------------------

describe('POST /api/account/password (B5)', () => {
  it('changes it: a fresh token works, every other is revoked, the new password signs in, the alert goes', async () => {
    const other = await accountToken(TEST_SECRET, prisma, x.id, NOW);
    await prisma.appUser.update({ where: { id: x.id }, data: { passwordResetTokenHash: 'pending-reset', passwordResetExpiresAt: new Date(NOW.getTime() + HOUR_MS), failedLoginCount: 2 } });

    const res = await post('/api/account/password', { currentPassword: ACCOUNT_PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ user: { id: x.id, email: CLIENT.email, lastLoginAt: null }, token: expect.any(String), tokenType: 'Bearer', expiresAt: expect.any(String) });
    expect((await me(res.body.token)).status).toBe(200);
    expect((await me(tokenX)).status).toBe(401);
    expect((await me(other)).status).toBe(401);
    expect((await login(CLIENT.email, NEW_PASSWORD)).status).toBe(200);
    expect((await login(CLIENT.email, ACCOUNT_PASSWORD)).status).toBe(401);
    // A reset link emailed before the change dies with the old password.
    await expect(reload(x)).resolves.toMatchObject({ passwordResetTokenHash: null, passwordResetExpiresAt: null });
    const alerts = await securityAlerts(CLIENT.email);
    expect(alerts.map((row) => row.payload)).toEqual([{ variant: 'password_changed', area: 'account', added: false, changedAt: NOW.toISOString() }]);
    expect(alerts[0]?.photographerId).toBeNull();
  });

  it('answers a wrong current password 403 invalid_password, counting it toward the lockout, and changes nothing', async () => {
    const res = await post('/api/account/password', { currentPassword: 'not the password at all', newPassword: NEW_PASSWORD });

    expect([res.status, res.body]).toEqual([403, { error: 'invalid_password' }]);
    await expect(reload(x)).resolves.toMatchObject({ passwordHash: x.passwordHash, failedLoginCount: 1 });
    expect((await me(tokenX)).status).toBe(200);
    expect(await securityAlerts(CLIENT.email)).toEqual([]);
  });

  it('locks after the login’s threshold, alerts once, and then answers password_locked without checking', async () => {
    const server = app();
    const answers: string[] = [];
    for (let i = 0; i < LOCKOUT_THRESHOLD + 1; i++) {
      answers.push((await post('/api/account/password', { currentPassword: `wrong guess ${i}`, newPassword: NEW_PASSWORD }, tokenX, server)).body.error);
    }

    expect(answers).toEqual([...Array<string>(LOCKOUT_THRESHOLD).fill('invalid_password'), 'password_locked']);
    // Even the right password is refused while locked: a stolen token is no licence to guess.
    const right = await post('/api/account/password', { currentPassword: ACCOUNT_PASSWORD, newPassword: NEW_PASSWORD }, tokenX, server);
    expect([right.status, right.body]).toEqual([403, { error: 'password_locked' }]);
    expect((await securityAlerts(CLIENT.email)).map((row) => (row.payload as { variant: string }).variant)).toEqual(['login_lockout']);
    await expect(reload(x)).resolves.toMatchObject({ passwordHash: x.passwordHash });
  });

  it('answers a Google-only account 409 no_password: there is none to change', async () => {
    const { user, token } = await googleOnly();
    const res = await post('/api/account/password', { currentPassword: 'anything at all', newPassword: NEW_PASSWORD }, token);

    expect([res.status, res.body]).toEqual([409, { error: 'no_password' }]);
    await expect(reload(user)).resolves.toMatchObject({ passwordHash: null, failedLoginCount: 0 });
  });

  it.each([
    ['a new password under 12 characters', { currentPassword: ACCOUNT_PASSWORD, newPassword: 'too short' }, 422],
    ['a new password over 1,024 characters', { currentPassword: ACCOUNT_PASSWORD, newPassword: 'x'.repeat(1025) }, 422],
    ['an empty current password', { currentPassword: '', newPassword: NEW_PASSWORD }, 422],
    ['no current password', { newPassword: NEW_PASSWORD }, 400],
    ['an unknown key', { currentPassword: ACCOUNT_PASSWORD, newPassword: NEW_PASSWORD, userId: 'x' }, 400],
  ])('refuses %s before checking anything', async (_label, body, status) => {
    const res = await post('/api/account/password', body);
    expect(res.status).toBe(status);
    await expect(reload(x)).resolves.toMatchObject({ passwordHash: x.passwordHash, failedLoginCount: 0 });
  });

  it('answers 401 without a token', async () => {
    expect((await post('/api/account/password', { currentPassword: ACCOUNT_PASSWORD, newPassword: NEW_PASSWORD }, null)).status).toBe(401);
  });
});

describe('POST /api/account/password/set (B5, decision 2)', () => {
  it('adds a first password to a Google-only account: both sign-ins work, other tokens are revoked, the alert says added', async () => {
    const { user, token } = await googleOnly();

    const res = await post('/api/account/password/set', { newPassword: NEW_PASSWORD }, token);

    expect(res.status).toBe(200);
    expect((await me(res.body.token)).body.user).toMatchObject({ hasPassword: true, hasGoogle: true });
    expect((await me(token)).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    expect((await googleSignIn({ sub: GOOGLE_SUB, email: user.email })).body.user.id).toBe(user.id);
    expect((await securityAlerts(user.email)).map((row) => row.payload)).toEqual([{ variant: 'password_changed', area: 'account', added: true, changedAt: NOW.toISOString() }]);
  });

  it('answers an account that has a password 409 password_exists, changing nothing', async () => {
    const res = await post('/api/account/password/set', { newPassword: NEW_PASSWORD });

    expect([res.status, res.body]).toEqual([409, { error: 'password_exists' }]);
    await expect(reload(x)).resolves.toMatchObject({ passwordHash: x.passwordHash });
    expect((await me(tokenX)).status).toBe(200);
  });

  it('adds one password when two additions race: the other is password_exists', async () => {
    const { user, token } = await googleOnly();
    const server = app();
    const results = await Promise.all(['the first new password', 'the second new password'].map((newPassword) => post('/api/account/password/set', { newPassword }, token, server)));

    // The loser finds the password there (409), or its token already revoked by the winner (401).
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    for (const res of results) expect([200, 401, 409]).toContain(res.status);
    expect(await securityAlerts(user.email)).toHaveLength(1);
  });

  it('refuses a short password with 422 naming it', async () => {
    const { token } = await googleOnly();
    const res = await post('/api/account/password/set', { newPassword: 'short' }, token);
    expect([res.status, res.body]).toEqual([422, { error: 'validation_failed', fields: ['newPassword'] }]);
  });
});

// --- B6: changing the address -----------------------------------------------------------------

describe('POST /api/account/email (B6: asking)', () => {
  async function confirmLink(recipient: string) {
    const row = await prisma.outbox.findFirstOrThrow({ where: { template: 'account_verify_email', recipient } });
    return row.payload as { variant: string; area: string; token: string; expiresAt: string };
  }

  it('stores the address as pending with the hash of a 24-hour token, and emails the link to the NEW address', async () => {
    const res = await post('/api/account/email', { newEmail: '  Aline.New@Example.com ', password: ACCOUNT_PASSWORD });

    expect([res.status, res.body]).toEqual([202, { ok: true }]);
    const link = await confirmLink(NEW_EMAIL);
    expect(link).toEqual({ variant: 'email_change', area: 'account', token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: new Date(NOW.getTime() + ACCOUNT_EMAIL_CHANGE_TTL_HOURS * HOUR_MS).toISOString() });
    await expect(reload(x)).resolves.toMatchObject({
      email: CLIENT.email,
      pendingEmail: NEW_EMAIL,
      pendingEmailTokenHash: sha256Hex(link.token),
      pendingEmailExpiresAt: new Date(link.expiresAt),
    });
    expect((await me(tokenX)).body.user).toMatchObject({ email: CLIENT.email, pendingEmail: NEW_EMAIL });
    // Nothing is sent to the current address until the change is confirmed.
    expect(await prisma.outbox.count({ where: { recipient: CLIENT.email } })).toBe(0);
  });

  it('answers an address another account holds exactly as a free one, stores it pending, and sends it nothing', async () => {
    await createClientAccount(prisma, { email: 'taken@example.com' });
    const free = await post('/api/account/email', { newEmail: 'free@example.com', password: ACCOUNT_PASSWORD });
    const taken = await post('/api/account/email', { newEmail: 'taken@example.com', password: ACCOUNT_PASSWORD });

    expect([taken.status, taken.body, taken.headers['content-length']]).toEqual([free.status, free.body, free.headers['content-length']]);
    expect((await me(tokenX)).body.user.pendingEmail).toBe('taken@example.com');
    expect(await prisma.outbox.count({ where: { recipient: 'taken@example.com' } })).toBe(0);
  });

  it('a new request replaces the earlier one, whose link stops working', async () => {
    await post('/api/account/email', { newEmail: 'first@example.com', password: ACCOUNT_PASSWORD });
    const first = await confirmLink('first@example.com');
    await post('/api/account/email', { newEmail: NEW_EMAIL, password: ACCOUNT_PASSWORD });

    const res = await post('/api/account/email/confirm', { token: first.token, password: ACCOUNT_PASSWORD }, null);
    expect([res.status, res.body]).toEqual([400, { error: 'invalid_confirmation' }]);
    await expect(reload(x)).resolves.toMatchObject({ email: CLIENT.email, pendingEmail: NEW_EMAIL });
  });

  it('answers a Google-only account 409 password_required, storing nothing (decision 2)', async () => {
    const { user, token } = await googleOnly();
    const res = await post('/api/account/email', { newEmail: NEW_EMAIL, password: 'whatever it is' }, token);

    expect([res.status, res.body]).toEqual([409, { error: 'password_required' }]);
    await expect(reload(user)).resolves.toMatchObject({ pendingEmail: null });
    expect(await prisma.outbox.count()).toBe(0);
  });

  it('answers the account’s own address 422 naming newEmail, in any case', async () => {
    const res = await post('/api/account/email', { newEmail: CLIENT.email.toUpperCase(), password: ACCOUNT_PASSWORD });
    expect([res.status, res.body]).toEqual([422, { error: 'validation_failed', fields: ['newEmail'] }]);
  });

  it('answers a wrong password 403, counted, storing and sending nothing', async () => {
    const res = await post('/api/account/email', { newEmail: NEW_EMAIL, password: 'not the password at all' });

    expect([res.status, res.body]).toEqual([403, { error: 'invalid_password' }]);
    await expect(reload(x)).resolves.toMatchObject({ pendingEmail: null, failedLoginCount: 1 });
    expect(await prisma.outbox.count()).toBe(0);
  });

  it.each([
    ['a malformed address', { newEmail: 'not an address', password: ACCOUNT_PASSWORD }],
    ['no password', { newEmail: NEW_EMAIL }],
    ['an unknown key', { newEmail: NEW_EMAIL, password: ACCOUNT_PASSWORD, email: NEW_EMAIL }],
  ])('answers 400 for %s', async (_label, body) => {
    expect((await post('/api/account/email', body)).status).toBe(400);
  });
});

describe('POST /api/account/email/confirm (B6: confirming)', () => {
  async function ask(newEmail = NEW_EMAIL): Promise<string> {
    await post('/api/account/email', { newEmail, password: ACCOUNT_PASSWORD });
    const row = await prisma.outbox.findFirstOrThrow({ where: { template: 'account_verify_email', recipient: newEmail }, orderBy: { createdAt: 'desc' } });
    return (row.payload as { token: string }).token;
  }

  it('moves the login to the new address, verified, signs the caller in, and tells the OLD address, masked', async () => {
    const token = await ask();
    const res = await post('/api/account/email/confirm', { token, password: ACCOUNT_PASSWORD }, null);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: x.id, email: NEW_EMAIL, lastLoginAt: NOW.toISOString() });
    expect(res.headers['cache-control']).toBe('no-store');
    await expect(reload(x)).resolves.toMatchObject({ email: NEW_EMAIL, emailVerifiedAt: NOW, pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null });
    const notice = await securityAlerts(CLIENT.email);
    expect(notice.map((row) => row.payload)).toEqual([{ variant: 'email_changed', area: 'account', changedAt: NOW.toISOString(), newEmail: 'a•••••@example.com' }]);
    // The new address signs in; the old one is nobody's now.
    expect((await login(NEW_EMAIL, ACCOUNT_PASSWORD)).status).toBe(200);
    expect((await login(CLIENT.email, ACCOUNT_PASSWORD)).status).toBe(401);
    // The fingerprint does not cover the address: the sessions already open carry on.
    expect((await me(tokenX)).body.user.email).toBe(NEW_EMAIL);
    expect((await me(res.body.token)).status).toBe(200);
  });

  it('keeps the bookings already linked, and links the unclaimed ones under the new address (decision 3)', async () => {
    const old = await insertBooking(prisma, world, { status: 'confirmed' });
    const guest = await prisma.client.create({ data: { fullName: 'Aline New', email: NEW_EMAIL, phone: null } });
    const later = await insertBooking(prisma, { ...world, clientId: guest.id }, { status: 'confirmed' });
    const someoneElses = await createClientAccount(prisma, { email: 'someone@example.com' });
    const claimed = await prisma.client.create({ data: { fullName: 'Claimed', email: 'claimed@example.com', phone: null, userId: someoneElses.id } });

    await post('/api/account/email/confirm', { token: await ask(), password: ACCOUNT_PASSWORD }, null);

    const mine = await prisma.booking.findMany({ where: { client: { userId: x.id } }, select: { reference: true } });
    expect(mine.map((booking) => booking.reference).sort()).toEqual([old.reference, later.reference].sort());
    await expect(prisma.client.findUniqueOrThrow({ where: { id: claimed.id } })).resolves.toMatchObject({ userId: someoneElses.id });
  });

  it('voids a reset link emailed to the old inbox', async () => {
    const token = await ask();
    await prisma.appUser.update({ where: { id: x.id }, data: { passwordResetTokenHash: 'old-inbox-reset', passwordResetExpiresAt: new Date(NOW.getTime() + HOUR_MS) } });
    await post('/api/account/email/confirm', { token, password: ACCOUNT_PASSWORD }, null);

    await expect(reload(x)).resolves.toMatchObject({ passwordResetTokenHash: null, passwordResetExpiresAt: null });
  });

  it('keeps Google sign-in working after the change: the account is found by its Google subject', async () => {
    await prisma.appUser.update({ where: { id: x.id }, data: { googleSub: GOOGLE_SUB } });
    // Linking Google changed the fingerprint: a token issued after it.
    tokenX = await accountToken(TEST_SECRET, prisma, x.id, NOW);
    await post('/api/account/email/confirm', { token: await ask(), password: ACCOUNT_PASSWORD }, null);

    // Google still reports the old address for this subject.
    const res = await googleSignIn({ sub: GOOGLE_SUB, email: CLIENT.email });
    expect([res.status, res.body.user.id, res.body.user.email]).toEqual([200, x.id, NEW_EMAIL]);
    expect(await prisma.appUser.count({ where: { role: 'client' } })).toBe(1);
  });

  it('answers a wrong password 400 invalid_confirmation, counted, changing nothing', async () => {
    const token = await ask();
    const res = await post('/api/account/email/confirm', { token, password: 'not the password at all' }, null);

    expect([res.status, res.body]).toEqual([400, { error: 'invalid_confirmation' }]);
    await expect(reload(x)).resolves.toMatchObject({ email: CLIENT.email, pendingEmail: NEW_EMAIL, failedLoginCount: 1 });
  });

  it('refuses every confirmation once the account is locked, even with the right password', async () => {
    const token = await ask();
    await prisma.appUser.update({ where: { id: x.id }, data: { lockedUntil: new Date(NOW.getTime() + HOUR_MS) } });
    const res = await post('/api/account/email/confirm', { token, password: ACCOUNT_PASSWORD }, null);

    expect([res.status, res.body]).toEqual([400, { error: 'invalid_confirmation' }]);
    await expect(reload(x)).resolves.toMatchObject({ email: CLIENT.email });
  });

  it('answers a lapsed link 400, as an unknown one', async () => {
    const token = await ask();
    const later = app({ now: new Date(NOW.getTime() + ACCOUNT_EMAIL_CHANGE_TTL_HOURS * HOUR_MS + 1) });
    const lapsed = await post('/api/account/email/confirm', { token, password: ACCOUNT_PASSWORD }, null, later);
    const unknown = await post('/api/account/email/confirm', { token: 'Vf3rT0k3n_aB9cD8eF7gH6iJ5kL4mN3oP2qR1sT0uVw', password: ACCOUNT_PASSWORD }, null);

    expect([lapsed.status, lapsed.body]).toEqual([400, { error: 'invalid_confirmation' }]);
    expect([unknown.status, unknown.body]).toEqual([lapsed.status, lapsed.body]);
    await expect(reload(x)).resolves.toMatchObject({ email: CLIENT.email });
  });

  it('works once: a second use of the link is 400', async () => {
    const token = await ask();
    expect((await post('/api/account/email/confirm', { token, password: ACCOUNT_PASSWORD }, null)).status).toBe(200);
    expect((await post('/api/account/email/confirm', { token, password: ACCOUNT_PASSWORD }, null)).status).toBe(400);
  });

  it('answers 409 email_taken when another account took the address since, and withdraws the change', async () => {
    const token = await ask();
    await createClientAccount(prisma, { email: 'ALINE.NEW@example.com', verified: false });

    const res = await post('/api/account/email/confirm', { token, password: ACCOUNT_PASSWORD }, null);

    expect([res.status, res.body]).toEqual([409, { error: 'email_taken' }]);
    await expect(reload(x)).resolves.toMatchObject({ email: CLIENT.email, pendingEmail: null, pendingEmailTokenHash: null });
    expect(await securityAlerts(CLIENT.email)).toEqual([]);
  });

  it('never completes a change to an address that was taken when it was asked (no link was sent)', async () => {
    await createClientAccount(prisma, { email: 'taken@example.com' });
    await post('/api/account/email', { newEmail: 'taken@example.com', password: ACCOUNT_PASSWORD });
    const stored = await reload(x);

    expect(stored.pendingEmailTokenHash).not.toBeNull();
    expect(await prisma.outbox.count({ where: { template: 'account_verify_email' } })).toBe(0);
  });

  it('refuses a link for an account erased since', async () => {
    const token = await ask();
    await post('/api/account/delete', { password: ACCOUNT_PASSWORD });

    const res = await post('/api/account/email/confirm', { token, password: ACCOUNT_PASSWORD }, null);
    expect([res.status, res.body]).toEqual([400, { error: 'invalid_confirmation' }]);
  });

  it.each([
    ['no token', { password: ACCOUNT_PASSWORD }],
    ['no password', { token: 'a-token' }],
    ['an empty token', { token: '', password: ACCOUNT_PASSWORD }],
  ])('answers 400 invalid_request for %s', async (_label, body) => {
    const res = await post('/api/account/email/confirm', body, null);
    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
  });
});

// --- B8: deleting the account (T8.3) -------------------------------------------------------------

describe('POST /api/account/delete (B8, T8.3, decision 4)', () => {
  it('anonymises the login, unlinks its client rows and keeps every booking snapshot', async () => {
    const upcoming = await insertBooking(prisma, world, { status: 'confirmed', startsAt: new Date(NOW.getTime() + 72 * HOUR_MS) });
    const guestLink = await grantAccessToken(prisma, upcoming.id);
    await prisma.appUser.update({ where: { id: x.id }, data: { phone: '+250788111222', pendingEmail: 'p@example.com', pendingEmailTokenHash: 'p', pendingEmailExpiresAt: NOW } });
    const server = createApp({
      auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: WEB_ORIGIN, now: () => NOW },
      publicApi: { prisma, now: () => NOW },
    });

    const res = await post('/api/account/delete', { password: ACCOUNT_PASSWORD }, tokenX, server);

    expect(res.status).toBe(204);
    const erased = await reload(x);
    expect(erased).toMatchObject({
      email: deletedEmailOf(x.id),
      fullName: null,
      phone: null,
      passwordHash: null,
      googleSub: null,
      emailVerifiedAt: null,
      emailVerifyTokenHash: null,
      passwordResetTokenHash: null,
      pendingEmail: null,
      pendingEmailTokenHash: null,
      lastLoginAt: null,
      anonymizedAt: NOW,
      disabledAt: null,
      tokenVersion: x.tokenVersion + 1,
    });
    // The client row and the booking stay, linked to no account.
    await expect(prisma.client.findUniqueOrThrow({ where: { id: world.clientId } })).resolves.toMatchObject({ userId: null, email: CLIENT.email });
    await expect(prisma.booking.findUniqueOrThrow({ where: { id: upcoming.id } })).resolves.toMatchObject({
      contactName: CLIENT.name,
      contactEmail: CLIENT.email,
      contactPhone: CLIENT.phone,
      status: 'confirmed',
    });

    // T8.3: login fails, the old token is a 401 everywhere (the export too).
    expect((await login(CLIENT.email, ACCOUNT_PASSWORD)).status).toBe(401);
    expect((await me(tokenX)).status).toBe(401);
    expect((await request(server).get('/api/account/export').set('Authorization', `Bearer ${tokenX}`)).status).toBe(401);
    // The photographer still sees the booking's snapshot.
    const photographer = await prisma.appUser.findUniqueOrThrow({ where: { id: world.photographerUserId } });
    const studioToken = (await issueToken(TEST_SECRET, 'studio', photographer, NOW)).token;
    const studio = await request(server).get(`/api/studio/bookings/${upcoming.id}`).set('Authorization', `Bearer ${studioToken}`);
    expect(studio.status).toBe(200);
    expect(studio.text).toContain(CLIENT.name);
    // The upcoming booking carries on through the guest link already emailed.
    expect((await request(server).get(`/api/booking/${guestLink}`)).status).toBe(200);
  });

  it('logs who and when, never the erased address', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => lines.push(String(line));
    try {
      await post('/api/account/delete', { password: ACCOUNT_PASSWORD });
    } finally {
      console.log = original;
    }
    const entry = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((parsed) => parsed.event === 'account_deleted');
    expect(entry).toEqual({ level: 'info', event: 'account_deleted', userId: x.id, at: NOW.toISOString(), unlinkedClients: 1, erasedMail: 0 });
    expect(lines.join('\n')).not.toContain(CLIENT.email);
  });

  it('a later signup with the freed address is a new account, which links the unclaimed bookings once verified, like any signup', async () => {
    const upcoming = await insertBooking(prisma, world, { status: 'confirmed', startsAt: new Date(NOW.getTime() + 72 * HOUR_MS) });
    await post('/api/account/delete', { password: ACCOUNT_PASSWORD });
    const server = app();
    const res = await request(server).post('/api/account/auth/signup').send({ email: CLIENT.email, password: NEW_PASSWORD, fullName: 'Aline Again' });

    expect(res.status).toBe(202);
    const fresh = await prisma.appUser.findFirstOrThrow({ where: { email: CLIENT.email } });
    expect(fresh.id).not.toBe(x.id);
    // Not before the address is proven (T2.2)...
    await expect(prisma.client.findUniqueOrThrow({ where: { id: world.clientId } })).resolves.toMatchObject({ userId: null });

    // ...and all of them once it is.
    const link = await prisma.outbox.findFirstOrThrow({ where: { template: 'account_verify_email', recipient: CLIENT.email } });
    const verified = await request(server).post('/api/account/auth/verify').send({ token: (link.payload as { token: string }).token, password: NEW_PASSWORD });
    expect(verified.status).toBe(200);
    await expect(prisma.client.findUniqueOrThrow({ where: { id: world.clientId } })).resolves.toMatchObject({ userId: fresh.id });
    const listed = await request(server).get('/api/account/bookings').set('Authorization', `Bearer ${verified.body.token}`);
    expect((listed.body as { bookings: { reference: string }[] }).bookings.map((row) => row.reference)).toEqual([upcoming.reference]);
  });

  it('erases the account’s mail from the outbox, wherever it went, and leaves booking mail and other people’s mail alone', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: new Date(NOW.getTime() + 72 * HOUR_MS) });
    const other = await createClientAccount(prisma, { email: 'other.client@example.com' });
    const accountRow = (template: string, recipient: string, dedupeKey: string, status = 'done') =>
      prisma.outbox.create({ data: { kind: 'email', template, recipient, dedupeKey, payload: { token: `SECRET-${dedupeKey}` }, status } });
    const mine = [
      await accountRow('account_verify_email', CLIENT.email, `email:account_verify_email:${x.id}:h1`),
      await accountRow('account_password_reset', CLIENT.email, `email:account_password_reset:${x.id}:h2`, 'pending'),
      await accountRow('account_security_alert', CLIENT.email, `email:account_security_alert:login_lockout:${x.id}:5:t`),
      // An address change: the link to the pending address, and the notice to an address the account has left.
      await accountRow('account_verify_email', 'pending.new@example.com', `email:account_verify_email:email_change:${x.id}:h3`, 'pending'),
      await accountRow('account_security_alert', 'an.old.address@example.com', `email:account_security_alert:email_changed:${x.id}:h4`),
      // Addressed to the account under a key naming nobody: matched by address, in any case.
      await accountRow('account_security_alert', CLIENT.email.toUpperCase(), 'email:account_security_alert:account_exists:legacy'),
    ];
    const theirs = await accountRow('account_security_alert', other.email, `email:account_security_alert:login_lockout:${other.id}:5:t`);
    const bookingMail = await prisma.outbox.create({
      data: {
        kind: 'email',
        template: 'cancellation',
        recipient: CLIENT.email,
        bookingId: booking.id,
        photographerId: world.photographerId,
        dedupeKey: `email:cancellation:${booking.id}`,
        payload: { reference: booking.reference },
        status: 'done',
      },
    });
    await prisma.appUser.update({ where: { id: x.id }, data: { pendingEmail: 'pending.new@example.com', pendingEmailTokenHash: 'pending-hash', pendingEmailExpiresAt: new Date(NOW.getTime() + HOUR_MS) } });

    expect((await post('/api/account/delete', { password: ACCOUNT_PASSWORD })).status).toBe(204);

    for (const row of mine) {
      const after = await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
      expect(after, row.dedupeKey).toMatchObject({ recipient: '[erased]', payload: null, template: row.template, dedupeKey: row.dedupeKey });
      // Undelivered mail is withdrawn: its payload is gone, and its link is dead with the account.
      expect(after.status, row.dedupeKey).toBe(row.status === 'pending' ? 'cancelled' : row.status);
    }
    await expect(prisma.outbox.findUniqueOrThrow({ where: { id: theirs.id } })).resolves.toMatchObject({ recipient: other.email, payload: theirs.payload });
    await expect(prisma.outbox.findUniqueOrThrow({ where: { id: bookingMail.id } })).resolves.toMatchObject({ recipient: CLIENT.email, payload: { reference: booking.reference } });
  });

  it('sends one notice to the erased address, which keeps it only until the worker is done with it', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => lines.push(String(line));
    try {
      await prisma.outbox.create({
        data: { kind: 'email', template: 'account_password_reset', recipient: CLIENT.email, dedupeKey: `email:account_password_reset:${x.id}:h`, payload: { resetUrl: 'x' }, status: 'done' },
      });
      expect((await post('/api/account/delete', { password: ACCOUNT_PASSWORD })).status).toBe(204);
    } finally {
      console.log = original;
    }

    const notices = await prisma.outbox.findMany({ where: { dedupeKey: { startsWith: 'email:account_security_alert:account_deleted:' } } });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      template: 'account_security_alert',
      recipient: CLIENT.email,
      dedupeKey: `email:account_security_alert:account_deleted:${x.id}`,
      payload: { variant: 'account_deleted', area: 'account', deletedAt: NOW.toISOString() },
      status: 'pending',
      eraseOnCompletion: true,
      bookingId: null,
      photographerId: null,
    });
    const entry = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((parsed) => parsed.event === 'account_deleted');
    expect(entry).toMatchObject({ erasedMail: 1, unlinkedClients: 1 });

    // The worker delivers it with the address; then the row keeps neither.
    const delivered: (string | null)[] = [];
    await processNext({ prisma, handlers: { email: async (row) => (delivered.push(row.recipient), { providerMessageId: 'sent' }) }, log: () => undefined });
    expect(delivered).toEqual([CLIENT.email]);
    await expect(prisma.outbox.findUniqueOrThrow({ where: { id: notices[0]?.id ?? '' } })).resolves.toMatchObject({ recipient: '[erased]', payload: null, status: 'done' });
    // Nothing in the outbox holds the address now but booking mail.
    expect(await prisma.outbox.count({ where: { recipient: { equals: CLIENT.email, mode: 'insensitive' }, bookingId: null } })).toBe(0);
  });

  it('sends no second notice when two deletions race', async () => {
    const server = app();
    await Promise.all([1, 2].map(() => post('/api/account/delete', { password: ACCOUNT_PASSWORD }, tokenX, server)));

    expect(await prisma.outbox.count({ where: { dedupeKey: `email:account_security_alert:account_deleted:${x.id}` } })).toBe(1);
  });

  it('answers a wrong password 403 invalid_password, counted, and deletes nothing', async () => {
    const res = await post('/api/account/delete', { password: 'not the password at all' });

    expect([res.status, res.body]).toEqual([403, { error: 'invalid_password' }]);
    await expect(reload(x)).resolves.toMatchObject({ email: CLIENT.email, anonymizedAt: null, failedLoginCount: 1 });
    await expect(prisma.client.findUniqueOrThrow({ where: { id: world.clientId } })).resolves.toMatchObject({ userId: x.id });
  });

  it('answers a password account that typed its address instead 403 invalid_password', async () => {
    const res = await post('/api/account/delete', { confirmEmail: CLIENT.email });
    expect([res.status, res.body]).toEqual([403, { error: 'invalid_password' }]);
    await expect(reload(x)).resolves.toMatchObject({ anonymizedAt: null });
  });

  it('answers 403 password_locked while the account is locked', async () => {
    await prisma.appUser.update({ where: { id: x.id }, data: { lockedUntil: new Date(NOW.getTime() + HOUR_MS) } });
    const res = await post('/api/account/delete', { password: ACCOUNT_PASSWORD });
    expect([res.status, res.body]).toEqual([403, { error: 'password_locked' }]);
  });

  it('deletes a Google-only account confirmed by its address typed again, in any case; a later Google sign-in is a fresh account', async () => {
    const { user, token } = await googleOnly(CLIENT.email.replace('aline', 'gina'));

    const wrong = await post('/api/account/delete', { confirmEmail: 'someone.else@example.com' }, token);
    expect([wrong.status, wrong.body]).toEqual([403, { error: 'invalid_confirmation' }]);
    const password = await post('/api/account/delete', { password: 'there is no password' }, token);
    expect([password.status, password.body]).toEqual([403, { error: 'invalid_confirmation' }]);
    await expect(reload(user)).resolves.toMatchObject({ anonymizedAt: null });

    const res = await post('/api/account/delete', { confirmEmail: `  ${user.email.toUpperCase()} ` }, token);
    expect(res.status).toBe(204);
    await expect(reload(user)).resolves.toMatchObject({ googleSub: null, passwordHash: null, anonymizedAt: NOW });
    expect((await me(token)).status).toBe(401);

    const again = await googleSignIn({ sub: GOOGLE_SUB, email: user.email });
    expect(again.status).toBe(200);
    expect(again.body.user.id).not.toBe(user.id);
    await expect(prisma.appUser.findUniqueOrThrow({ where: { id: again.body.user.id } })).resolves.toMatchObject({ googleSub: GOOGLE_SUB, email: user.email });
  });

  it.each([
    ['both confirmations', { password: ACCOUNT_PASSWORD, confirmEmail: CLIENT.email }],
    ['neither', {}],
    ['an unknown key', { password: ACCOUNT_PASSWORD, userId: 'x' }],
  ])('answers 400 for %s, deleting nothing', async (_label, body) => {
    const res = await post('/api/account/delete', body);
    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
    await expect(reload(x)).resolves.toMatchObject({ anonymizedAt: null });
  });

  it('answers an empty password 422 naming it, deleting nothing', async () => {
    const res = await post('/api/account/delete', { password: '' });
    expect([res.status, res.body]).toEqual([422, { error: 'validation_failed', fields: ['password'] }]);
    await expect(reload(x)).resolves.toMatchObject({ anonymizedAt: null, failedLoginCount: 0 });
  });

  it('deletes once when two deletions race', async () => {
    const server = app();
    const results = await Promise.all([1, 2].map(() => post('/api/account/delete', { password: ACCOUNT_PASSWORD }, tokenX, server)));

    // The second either found the row erased (204, nothing left to do) or the token already dead (401).
    expect(results.map((res) => res.status)).toContain(204);
    for (const res of results) expect([204, 401]).toContain(res.status);
    await expect(reload(x)).resolves.toMatchObject({ anonymizedAt: NOW, tokenVersion: x.tokenVersion + 1 });
  });

  it('answers 401 without a token', async () => {
    expect((await post('/api/account/delete', { password: ACCOUNT_PASSWORD }, null)).status).toBe(401);
  });
});
