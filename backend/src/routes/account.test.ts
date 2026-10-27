import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { GoogleIdentityProvider } from '../auth/google.js';
import { hashPassword } from '../auth/password.js';
import { AUTH_AREAS } from '../auth/roles.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { CLIENT, type PaymentWorld, insertBooking, seedWorld } from '../test/payment-fixtures.js';

/**
 * The account area and every area's signup and verification over HTTP (Phase 2
 * decisions 3-6; marketplace-spec.md R2.2-R2.4): the routes, their status codes
 * and bodies, and the two criteria that are about what a caller can SEE:
 *
 * - T2.2: someone who signs up with a victim's address but does not verify it
 *   is linked to none of the victim's bookings; once the address is verified,
 *   the bookings are the account's.
 * - T2.4: signup, reset and resend answer an existing address exactly as they
 *   answer a new one: same status, same body.
 */

/** The private half of a test RS256 key pair, whatever jose's runtime makes it. */
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let googleKey: SigningKey;
let jwks: GoogleIdentityProvider['jwks'];

const SECRET = 'account-routes-test-secret-at-least-32-characters';
const WEB_ORIGIN = 'https://bookly.example';
const NOW = new Date('2026-10-17T07:00:00Z');
const PASSWORD = 'a long enough account password';
const CLIENT_ID = 'bookly-routes.apps.googleusercontent.com';

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
});

/** The fake identity provider answers every code with an id_token for `claims`, carrying the nonce it is given. */
function fakeGoogle(claims: () => Record<string, unknown>, nonce: { value: string }): GoogleIdentityProvider {
  return {
    clientId: CLIENT_ID,
    authorizationEndpoint: 'https://accounts.google.example/auth',
    jwks,
    async exchangeCode() {
      const iat = Math.floor(NOW.getTime() / 1000);
      return new SignJWT({ nonce: nonce.value, email_verified: true, ...claims() })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer('https://accounts.google.com')
        .setAudience(CLIENT_ID)
        .setSubject('google-subject-routes')
        .setIssuedAt(iat)
        .setExpirationTime(iat + 600)
        .sign(googleKey);
    },
  };
}

function app(options: { google?: GoogleIdentityProvider } = {}): Express {
  return createApp({
    corsOrigin: WEB_ORIGIN,
    auth: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => NOW },
    publicApi: { prisma, now: () => NOW },
    ...options,
  });
}

async function verifyTokenSentTo(recipient: string): Promise<string> {
  const row = await prisma.outbox.findFirstOrThrow({ where: { template: 'account_verify_email', recipient }, orderBy: { createdAt: 'desc' } });
  return String((row.payload as Record<string, unknown>).token);
}

/** The bookings an account owns, through client.user_id: what the Phase 8 dashboard will list. */
function bookingsOf(userId: string): Promise<number> {
  return prisma.booking.count({ where: { client: { userId } } });
}

// --- Signup ----------------------------------------------------------------------

describe('POST /api/studio/auth/signup', () => {
  const body = { email: 'new.studio@bookly.example', password: PASSWORD, displayName: 'Hills & Light', handle: 'hills-light' };

  it('answers 202 { ok: true } and creates a pending photographer', async () => {
    const res = await request(app()).post('/api/studio/auth/signup').send(body);

    expect([res.status, res.body]).toEqual([202, { ok: true }]);
    await expect(prisma.photographer.findUnique({ where: { handle: 'hills-light' } })).resolves.toMatchObject({ status: 'pending' });
  });

  it('answers 409 handle_taken for a taken or a reserved handle', async () => {
    for (const handle of ['kigali-lens', 'studio', 'Account']) {
      const res = await request(app()).post('/api/studio/auth/signup').send({ ...body, handle });
      expect([res.status, res.body]).toEqual([409, { error: 'handle_taken' }]);
    }
  });

  it.each([
    ['a malformed handle', { handle: '-bad-' }, 400, { error: 'invalid_request' }],
    ['a handle with a space', { handle: 'two words' }, 400, { error: 'invalid_request' }],
    ['a malformed email', { email: 'not-an-address' }, 400, { error: 'invalid_request' }],
    ['an unknown key', { role: 'platform_admin' }, 400, { error: 'invalid_request' }],
    ['a short password', { password: 'too short' }, 422, { error: 'validation_failed', fields: ['password'] }],
    ['an empty name', { displayName: '   ' }, 422, { error: 'validation_failed', fields: ['displayName'] }],
  ])('refuses %s', async (_label, change, status, expected) => {
    const res = await request(app()).post('/api/studio/auth/signup').send({ ...body, ...change });

    expect([res.status, res.body]).toEqual([status, expected]);
    await expect(prisma.photographer.count()).resolves.toBe(1);
  });
});

describe('POST /api/account/auth/signup', () => {
  it('answers 202 { ok: true } and creates an unverified client', async () => {
    const res = await request(app()).post('/api/account/auth/signup').send({ email: 'new.client@bookly.example', password: PASSWORD, fullName: 'Aline' });

    expect([res.status, res.body]).toEqual([202, { ok: true }]);
    await expect(prisma.appUser.findFirst({ where: { email: 'new.client@bookly.example' } })).resolves.toMatchObject({ role: 'client', emailVerifiedAt: null });
  });

  it('refuses a short password with the field named', async () => {
    const res = await request(app()).post('/api/account/auth/signup').send({ email: 'x@bookly.example', password: 'short', fullName: 'A' });

    expect([res.status, res.body]).toEqual([422, { error: 'validation_failed', fields: ['password'] }]);
  });

  it('has no platform signup: the platform admins are seeded', async () => {
    expect((await request(app()).post('/api/platform/auth/signup').send({})).status).toBe(401);
  });
});

// --- Verification -------------------------------------------------------------------

describe('POST /api/{area}/auth/verify', () => {
  it('verifies with the token and the password, and answers like a login', async () => {
    await request(app()).post('/api/account/auth/signup').send({ email: 'new.client@bookly.example', password: PASSWORD, fullName: 'Aline' });
    const token = await verifyTokenSentTo('new.client@bookly.example');

    const res = await request(app()).post('/api/account/auth/verify').send({ token, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ tokenType: 'Bearer', user: { email: 'new.client@bookly.example' } });
    const me = await request(app()).get('/api/account/me').set('Authorization', `Bearer ${(res.body as { token: string }).token}`);
    // Phase 8 adds the phone, which credentials the account holds, and a pending address change.
    expect([me.status, me.body]).toEqual([
      200,
      {
        user: {
          id: expect.any(String),
          email: 'new.client@bookly.example',
          fullName: 'Aline',
          lastLoginAt: NOW.toISOString(),
          phone: null,
          hasPassword: true,
          hasGoogle: false,
          pendingEmail: null,
        },
      },
    ]);
  });

  it.each(AUTH_AREAS)('answers one 400 invalid_verification in the %s area for a bad token or a wrong password', async (area) => {
    await request(app()).post('/api/account/auth/signup').send({ email: 'new.client@bookly.example', password: PASSWORD, fullName: 'Aline' });
    const token = await verifyTokenSentTo('new.client@bookly.example');

    const wrongPassword = await request(app()).post(`/api/${area}/auth/verify`).send({ token, password: 'not the password' });
    const badToken = await request(app()).post(`/api/${area}/auth/verify`).send({ token: 'x'.repeat(43), password: PASSWORD });

    for (const res of [wrongPassword, badToken]) expect([res.status, res.body]).toEqual([400, { error: 'invalid_verification' }]);
  });

  it('refuses a body without the password', async () => {
    const res = await request(app()).post('/api/studio/auth/verify').send({ token: 'x'.repeat(43) });

    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
  });
});

// --- T2.2 -------------------------------------------------------------------------------

describe("signing up with a victim's address (T2.2)", () => {
  it('links none of their bookings until the address is verified, and all of them after', async () => {
    await insertBooking(prisma, world);
    await insertBooking(prisma, world, { status: 'confirmed' });

    await request(app()).post('/api/account/auth/signup').send({ email: CLIENT.email.toUpperCase(), password: PASSWORD, fullName: 'Not the owner' });
    const user = await prisma.appUser.findFirstOrThrow({ where: { role: 'client' } });
    expect(await bookingsOf(user.id)).toBe(0);
    // Signing in is refused too: there is nothing to see the bookings with.
    expect((await request(app()).post('/api/account/auth/login').send({ email: CLIENT.email, password: PASSWORD })).status).toBe(401);

    await request(app()).post('/api/account/auth/verify').send({ token: await verifyTokenSentTo(CLIENT.email), password: PASSWORD });

    expect(await bookingsOf(user.id)).toBe(2);
  });
});

// --- T2.4 ---------------------------------------------------------------------------------

describe('an existing address answers exactly as a new one (T2.4)', () => {
  async function seedExisting() {
    const passwordHash = await hashPassword(PASSWORD);
    await prisma.appUser.create({ data: { email: 'verified.client@bookly.example', role: 'client', passwordHash, emailVerifiedAt: NOW } });
    await prisma.appUser.create({ data: { email: 'pending.client@bookly.example', role: 'client', passwordHash } });
  }

  const existing = [
    ['a verified client', 'verified.client@bookly.example'],
    ['an unverified client', 'pending.client@bookly.example'],
    ['a photographer', 'photographer@bookly.example'],
    ['a platform admin', 'platform@bookly.example'],
  ] as const;

  const endpoints: [path: string, body: (email: string) => object][] = [
    ['/api/studio/auth/signup', (email) => ({ email, password: PASSWORD, displayName: 'Name', handle: `h-${email.length}-${Math.random().toString(36).slice(2, 8)}` })],
    ['/api/account/auth/signup', (email) => ({ email, password: PASSWORD, fullName: 'Name' })],
    ...AUTH_AREAS.flatMap((area): [string, (email: string) => object][] => [
      [`/api/${area}/auth/password-reset/request`, (email) => ({ email })],
      [`/api/${area}/auth/verify/resend`, (email) => ({ email })],
    ]),
  ];

  it.each(endpoints.flatMap(([path, body]) => existing.map(([label, email]) => [path, label, email, body] as const)))(
    'POST %s for %s',
    async (path, _label, email, body) => {
      await seedExisting();

      const fresh = await request(app()).post(path).send(body('nobody.yet@bookly.example'));
      const taken = await request(app()).post(path).send(body(email));

      expect([taken.status, taken.body]).toEqual([fresh.status, fresh.body]);
      expect(taken.status).toBe(202);
    },
    30_000,
  );
});

// --- Google over HTTP ------------------------------------------------------------------------

describe('Google sign-in routes', () => {
  it('reports the provider off, and answers its endpoints 404, when it is not configured', async () => {
    const off = app();

    expect((await request(off).get('/api/account/auth/providers')).body).toEqual({ google: false });
    expect((await request(off).post('/api/account/auth/google/start')).status).toBe(404);
    expect((await request(off).post('/api/account/auth/google/callback').send({ code: 'c', state: 's' })).status).toBe(404);
  });

  it('starts, then completes, and signs the client in', async () => {
    const nonce = { value: '' };
    const on = app({ google: fakeGoogle(() => ({ email: 'aline@gmail.example', name: 'Aline' }), nonce) });
    expect((await request(on).get('/api/account/auth/providers')).body).toEqual({ google: true });

    const started = await request(on).post('/api/account/auth/google/start');
    expect(started.status).toBe(200);
    expect(started.headers['cache-control']).toBe('no-store');
    const { authorizationUrl, state } = started.body as { authorizationUrl: string; state: string };
    nonce.value = new URL(authorizationUrl).searchParams.get('nonce') ?? '';

    const done = await request(on).post('/api/account/auth/google/callback').send({ code: 'code', state });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ tokenType: 'Bearer', user: { email: 'aline@gmail.example' } });
    const me = await request(on).get('/api/account/me').set('Authorization', `Bearer ${(done.body as { token: string }).token}`);
    expect(me.body).toMatchObject({ user: { fullName: 'Aline' } });

    const again = await request(on).post('/api/account/auth/google/callback').send({ code: 'code', state });
    expect([again.status, again.body]).toEqual([400, { error: 'invalid_state' }]);
  });

  it.each([
    ['a photographer address', () => ({ email: 'photographer@bookly.example' }), 409, 'account_conflict'],
    ['an address Google has not verified', () => ({ email: 'x@gmail.example', email_verified: false }), 400, 'google_email_unverified'],
  ])('answers %s with %i %s', async (_label, claims, status, error) => {
    const nonce = { value: '' };
    const on = app({ google: fakeGoogle(claims, nonce) });
    const { authorizationUrl, state } = (await request(on).post('/api/account/auth/google/start')).body as { authorizationUrl: string; state: string };
    nonce.value = new URL(authorizationUrl).searchParams.get('nonce') ?? '';

    const res = await request(on).post('/api/account/auth/google/callback').send({ code: 'code', state });

    expect([res.status, res.body]).toEqual([status, { error }]);
  });

  it('answers a refused identity with 400 google_sign_in_failed', async () => {
    const on = app({ google: fakeGoogle(() => ({ email: 'x@gmail.example' }), { value: 'not-the-flow-nonce-at-all-0123456789' }) });
    const { state } = (await request(on).post('/api/account/auth/google/start')).body as { state: string };

    const res = await request(on).post('/api/account/auth/google/callback').send({ code: 'code', state });

    expect([res.status, res.body]).toEqual([400, { error: 'google_sign_in_failed' }]);
  });

  it('refuses a callback without a state', async () => {
    const on = app({ google: fakeGoogle(() => ({}), { value: '' }) });

    expect((await request(on).post('/api/account/auth/google/callback').send({ code: 'c' })).body).toEqual({ error: 'invalid_request' });
  });
});

// --- The guard ---------------------------------------------------------------------------------

describe('/api/account/* behind requireClient', () => {
  it('answers 401 for /me and for a path that does not exist, without a token', async () => {
    for (const path of ['/api/account/me', '/api/account/bookings']) {
      const res = await request(app()).get(path);
      expect([res.status, res.body]).toEqual([401, { error: 'unauthenticated' }]);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="bookly-account"');
    }
  });
});
