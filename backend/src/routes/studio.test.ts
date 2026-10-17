import { createHash } from 'node:crypto';
import type { AppUser, Outbox, PrismaClient } from '@prisma/client';
import express, { type Express } from 'express';
import { SignJWT } from 'jose';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { LOCKOUT_THRESHOLD, revokeTokens } from '../auth/account-auth.js';
import { photographerLocals, requirePhotographer } from '../auth/middleware.js';
import { hashPassword } from '../auth/password.js';
import { toPublicUser } from '../auth/public-user.js';
import {
  TOKEN_AUDIENCES,
  TOKEN_ISSUER,
  TOKEN_TTL_SECONDS,
  credentialFingerprint,
  issueToken,
} from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';

/**
 * `/api/studio/*` over HTTP, against real PostgreSQL (plan.md Task 7, rev 2.3):
 * the photographer's studio, under the admin prefix until Phase 2 renamed it (decision
 * 1). Only a verified `photographer` login with a photographer row gets in.
 *
 * Studio auth is a JWT in `Authorization: Bearer`. No cookie is set, read or
 * honoured, and there is no CSRF token -- several tests below exist to prove
 * those absences, because a stray `Set-Cookie` or a cookie fallback would quietly
 * reintroduce the attack surface this design removed.
 *
 * The router's order is its security model, so these tests go through the whole
 * app: body parsing, CORS, the error handler and the 404 fallback included. The
 * clock is injected and mutable; lockout and expiry are crossed by moving it.
 */

let prisma: PrismaClient;
let raw: pg.Client;
/** Argon2id of PASSWORD, computed once: every seeded user reuses it. */
let passwordHash: string;
let clock: Date;
let app: Express;

const SECRET = 'admin-routes-test-secret-at-least-32-characters-long';
const OTHER_SECRET = 'a-different-secret-also-at-least-32-characters-long';
const WEB_ORIGIN = 'https://admin.bookly.example';
const FOREIGN_ORIGIN = 'https://attacker.example';
const EMAIL = 'photographer@bookly.example';
const OTHER_EMAIL = 'someone-else@bookly.example';
const PASSWORD = 'correct horse battery staple';
const WRONG = 'Tr0ub4dor&3 is not the password';
const NEW_PASSWORD = 'a brand new passphrase for the photographer';
const START = new Date('2026-10-07T07:00:00Z');
const MINUTE_MS = 60_000;
const RESET_TTL_MS = 30 * MINUTE_MS;
const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
  passwordHash = await hashPassword(PASSWORD);
});

afterAll(async () => {
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  clock = START;
  app = createApp({
    corsOrigin: WEB_ORIGIN,
    auth: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock },
  });
});

// --- Fixtures ---------------------------------------------------------------

let handleCounter = 0;

/** A photographer's verified login and their approved photographer row: what the studio admits. */
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

/** A login of another role, with no photographer row. */
function seedUser(role: 'platform_admin' | 'client', email = EMAIL): Promise<AppUser> {
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

function lockedUntilMs(admin: AppUser): number {
  if (admin.lockedUntil === null) throw new Error('Expected the admin to be locked');
  return admin.lockedUntil.getTime();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Every Set-Cookie line. Admin auth must never produce one. */
function setCookies(res: Response): string[] {
  const header: unknown = res.headers['set-cookie'];
  if (header === undefined) return [];
  if (!Array.isArray(header)) throw new Error(`Unexpected Set-Cookie: ${String(header)}`);
  return header.map(String);
}

/** A token exactly as login would issue it, without spending Argon2. */
async function mint(admin: AppUser, now = clock): Promise<string> {
  return (await issueToken(SECRET, 'studio', admin, now)).token;
}

type ForgeOptions = {
  alg?: string;
  secret?: string;
  sub?: string;
  aud?: string;
  iss?: string;
  expSeconds?: number;
  role?: string;
  fingerprint?: string;
};

/** A token with its claims under the test's control, for forgery cases. */
async function forge(admin: AppUser, options: ForgeOptions = {}): Promise<string> {
  const nowSeconds = Math.floor(clock.getTime() / 1000);
  return new SignJWT({
    role: options.role ?? admin.role,
    cred_fp: options.fingerprint ?? credentialFingerprint(SECRET, admin),
  })
    .setProtectedHeader({ alg: options.alg ?? 'HS256', typ: 'JWT' })
    .setSubject(options.sub ?? admin.id)
    .setIssuer(options.iss ?? TOKEN_ISSUER)
    .setAudience(options.aud ?? TOKEN_AUDIENCES.studio)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(options.expSeconds ?? nowSeconds + TOKEN_TTL_SECONDS.studio)
    .sign(new TextEncoder().encode(options.secret ?? SECRET));
}

function login(email = EMAIL, password = PASSWORD): Promise<Response> {
  return request(app).post('/api/studio/auth/login').send({ email, password });
}

/** A real login over HTTP, returning the token the admin UI now holds. */
async function signIn(): Promise<string> {
  const res = await login();
  expect(res.status).toBe(200);
  return (res.body as { token: string }).token;
}

function me(token?: string): request.Test {
  const req = request(app).get('/api/studio/me');
  return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
}

function requestReset(email: string): request.Test {
  return request(app).post('/api/studio/auth/password-reset/request').send({ email });
}

function confirmReset(token: string, newPassword: string): request.Test {
  return request(app)
    .post('/api/studio/auth/password-reset/confirm')
    .send({ token, newPassword });
}

function payloadOf(row: Outbox): Record<string, unknown> {
  const payload = row.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Outbox row ${row.id} has no object payload`);
  }
  return payload;
}

/** The plaintext token, from the only place it lives: the reset email's payload. */
async function latestResetToken(): Promise<string> {
  const rows = await prisma.outbox.findMany({ where: { template: 'account_password_reset' }, orderBy: { createdAt: 'asc' } });
  const row = rows.at(-1);
  if (row === undefined) throw new Error('No account_password_reset email was enqueued');
  const hash = new URL(String(payloadOf(row).resetUrl)).hash;
  if (!hash.startsWith('#token=')) throw new Error(`No #token= fragment: ${hash}`);
  return hash.slice('#token='.length);
}

/** 401 as RFC 6750 shapes it: JSON body, a Bearer challenge, no redirect, no cookie. */
function expectUnauthenticated(res: Response, error?: 'invalid_token'): void {
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'unauthenticated' });
  expect(res.headers.location).toBeUndefined();
  expect(setCookies(res)).toEqual([]);
  const challenge = String(res.headers['www-authenticate']);
  expect(challenge).toMatch(/^Bearer realm="bookly-studio"/);
  if (error === undefined) expect(challenge).not.toContain('error=');
  else expect(challenge).toContain(`error="${error}"`);
}

// --- Login ----------------------------------------------------------------------

describe('POST /api/studio/auth/login', () => {
  it('returns a bearer token, its expiry and the public user -- and nothing else', async () => {
    const admin = await seedAdmin();

    const res = await login();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: admin.id, email: EMAIL, lastLoginAt: START.toISOString() },
      token: expect.stringMatching(/^[\w-]+\.[\w-]+\.[\w-]+$/),
      tokenType: 'Bearer',
      expiresAt: new Date(START.getTime() + TOKEN_TTL_SECONDS.studio * 1000).toISOString(),
    });
  });

  it('issues byte-for-byte the token `mint` builds, so minted tokens below are faithful', async () => {
    const admin = await seedAdmin();

    const res = await login();

    expect((res.body as { token: string }).token).toBe(await mint(await reload(admin)));
  });

  it('sets no cookie of any kind', async () => {
    await seedAdmin();

    const res = await login();

    expect(res.status).toBe(200);
    expect(setCookies(res)).toEqual([]);
  });

  it('forbids caching the response that carries the credential', async () => {
    await seedAdmin();

    const res = await login();

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns no CSRF token, because there is no CSRF token flow', async () => {
    await seedAdmin();

    const res = await login();

    expect(res.text.toLowerCase()).not.toContain('csrf');
  });

  it('matches the email case-insensitively and ignores surrounding whitespace', async () => {
    await seedAdmin();

    const res = await login('  PHOTOGRAPHER@Bookly.Example  ');

    expect(res.status).toBe(200);
  });

  it('counts wrong passwords and refuses correct ones until the lock passes', async () => {
    const admin = await seedAdmin();

    for (let n = 1; n <= LOCKOUT_THRESHOLD; n++) {
      const res = await login(EMAIL, WRONG);
      expect(res.status).toBe(401);
      await expect(reload(admin)).resolves.toMatchObject({ failedLoginCount: n });
    }
    const until = lockedUntilMs(await reload(admin));
    expect(until).toBe(START.getTime() + MINUTE_MS);

    const refused = await login();
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: 'invalid_credentials' });

    clock = new Date(until + 1);
    const accepted = await login();
    expect(accepted.status).toBe(200);
    expect((accepted.body as { token: string }).token).toEqual(expect.any(String));
  }, 30_000);

  it('answers unknown email, wrong password and a locked account identically', async () => {
    await seedAdmin();

    const unknown = await login('nobody@bookly.example', PASSWORD);
    const wrong = await login(EMAIL, WRONG);
    for (let i = 1; i < LOCKOUT_THRESHOLD; i++) await login(EMAIL, WRONG);
    const locked = await login(EMAIL, PASSWORD);

    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({ error: 'invalid_credentials' });
    for (const res of [wrong, locked]) {
      expect(res.status).toBe(unknown.status);
      expect(res.text).toBe(unknown.text);
      expect(res.headers['content-type']).toBe(unknown.headers['content-type']);
    }
  }, 30_000);

  it.each<[string, unknown]>([
    ['an empty object', {}],
    ['no password', { email: EMAIL }],
    ['no email', { password: PASSWORD }],
    ['a numeric email', { email: 42, password: PASSWORD }],
    ['a numeric password', { email: EMAIL, password: 12345678901234 }],
    ['a boolean password', { email: EMAIL, password: true }],
    ['null fields', { email: null, password: null }],
    ['an array email', { email: [EMAIL], password: PASSWORD }],
    ['an operator-object email', { email: { contains: '@' }, password: PASSWORD }],
    ['an object password', { email: EMAIL, password: { length: 12 } }],
    ['an empty email', { email: '', password: PASSWORD }],
    ['a whitespace-only email', { email: '   ', password: PASSWORD }],
    ['an empty password', { email: EMAIL, password: '' }],
    ['a 1025-character password', { email: EMAIL, password: 'x'.repeat(1025) }],
    ['a 321-character email', { email: `${'a'.repeat(309)}@example.com`, password: PASSWORD }],
    ['a JSON array body', [EMAIL, PASSWORD]],
  ])('answers %s with 400, spending no failed attempt', async (_label, body) => {
    const admin = await seedAdmin();

    const res = await request(app)
      .post('/api/studio/auth/login')
      .send(body as object);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    await expect(reload(admin)).resolves.toMatchObject({ failedLoginCount: 0 });
  });

  it.each<[string, string, string]>([
    ['malformed JSON', 'application/json', `{"email": "${EMAIL}", "password":`],
    ['a JSON string literal', 'application/json', '"just a string"'],
    ['a JSON null', 'application/json', 'null'],
    ['an empty JSON body', 'application/json', ''],
    ['a form-encoded body', 'application/x-www-form-urlencoded', `email=${EMAIL}&password=x`],
    ['JSON sent as text/plain', 'text/plain', JSON.stringify({ email: EMAIL, password: PASSWORD })],
  ])('answers %s with 400, never 500, without echoing it', async (_label, type, body) => {
    await seedAdmin();

    const res = await request(app)
      .post('/api/studio/auth/login')
      .set('Content-Type', type)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    expect(res.text).not.toContain(PASSWORD);
  });

  it('answers an oversized password with 400 before counting it as a failure', async () => {
    const admin = await seedAdmin();

    const res = await login(EMAIL, 'p'.repeat(100_000));

    expect(res.status).toBe(400);
    await expect(reload(admin)).resolves.toMatchObject({ failedLoginCount: 0 });
  });

  it.each(['%', '_%', 'PHOTOGRAPHER@%'])(
    'refuses the correct password under the LIKE-wildcard email %j',
    async (email) => {
      await seedAdmin();

      const res = await login(email, PASSWORD);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_credentials' });
    },
  );

  it('answers an email ending in a backslash with 401, not 500', async () => {
    await seedAdmin();

    const res = await login('\\', PASSWORD);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
  });

  it('answers a simultaneous burst of wrong passwords with 401 every time, never 500', async () => {
    await seedAdmin();
    // Open the pool first, so the burst measures the race, not connection setup.
    await Promise.all(Array.from({ length: 10 }, () => prisma.appUser.count()));
    // 20 from one IP: this measures the lockout's race, not the request limit.
    app = createApp({
      corsOrigin: WEB_ORIGIN,
      auth: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock },
      rateLimits: { loginPerIp: { limit: 100, windowMs: 15 * 60_000 } },
    });

    const results = await Promise.all(Array.from({ length: 20 }, () => login(EMAIL, WRONG)));

    expect(results.map((res) => res.status)).toEqual(Array<number>(20).fill(401));
  }, 30_000);

  it.each(['platform_admin', 'client'] as const)(
    'refuses a %s with the right password exactly as it refuses an unknown email, counting nothing',
    async (role) => {
      const user = await seedUser(role);

      const unknown = await login('nobody@bookly.example', PASSWORD);
      const refused = await login(EMAIL, PASSWORD);

      expect(refused.status).toBe(401);
      expect(refused.text).toBe(unknown.text);
      expect(refused.headers['content-type']).toBe(unknown.headers['content-type']);
      await expect(reload(user)).resolves.toEqual(user);
    },
  );

  it('refuses a photographer whose login a platform admin disabled', async () => {
    const admin = await seedAdmin();
    await prisma.appUser.update({ where: { id: admin.id }, data: { disabledAt: START } });

    const res = await login();

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
  });

  it('refuses the right password for an unverified address exactly as a wrong one, counting it (decision 3)', async () => {
    const admin = await seedAdmin();
    await prisma.appUser.update({ where: { id: admin.id }, data: { emailVerifiedAt: null } });

    const wrong = await login(EMAIL, WRONG);
    const right = await login();

    for (const res of [wrong, right]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_credentials' });
    }
    expect(right.text).toBe(wrong.text);
    await expect(reload(admin)).resolves.toMatchObject({ failedLoginCount: 2, lastLoginAt: null });
  });
});

// --- The bearer token -------------------------------------------------------------

describe('the bearer token', () => {
  it('admits the token login returned, answering /me with the public user and their photographer', async () => {
    const admin = await seedAdmin();
    const token = await signIn();

    const res = await me(token);

    expect(res.status).toBe(200);
    const photographer = await prisma.photographer.findUniqueOrThrow({ where: { userId: admin.id } });
    expect(res.body).toEqual({
      user: { id: admin.id, email: EMAIL, lastLoginAt: START.toISOString() },
      photographer: { id: photographer.id, handle: photographer.handle, displayName: 'Kigali Lens', status: 'approved' },
    });
    expect(setCookies(res)).toEqual([]);
  });

  it('admits the unforged token every forgery below starts from', async () => {
    const admin = await seedAdmin();
    expect((await me(await forge(admin))).status).toBe(200);
  });

  it('refuses an issued token on the next request once the password hash changes', async () => {
    const admin = await seedAdmin();
    const token = await mint(admin);
    expect((await me(token)).status).toBe(200);

    await prisma.appUser.update({
      where: { id: admin.id },
      data: { passwordHash: await hashPassword(NEW_PASSWORD) },
    });

    expectUnauthenticated(await me(token), 'invalid_token');
  });

  it('admits a token one second before expiry and refuses it at and after', async () => {
    const admin = await seedAdmin();
    const token = await mint(admin);
    const expiresAtMs = START.getTime() + TOKEN_TTL_SECONDS.studio * 1000;

    clock = new Date(expiresAtMs - 1000);
    expect((await me(token)).status).toBe(200);

    clock = new Date(expiresAtMs);
    expectUnauthenticated(await me(token), 'invalid_token');

    clock = new Date(expiresAtMs + 24 * 60 * MINUTE_MS);
    expectUnauthenticated(await me(token), 'invalid_token');
  });

  it.each<[string, (admin: AppUser) => Promise<string>]>([
    ['a token signed with another secret', (a) => forge(a, { secret: OTHER_SECRET })],
    ['an HS512 token signed with the right secret', (a) => forge(a, { alg: 'HS512' })],
    ['a token for another audience', (a) => forge(a, { aud: 'bookly-client' })],
    ['a token for the platform audience', (a) => forge(a, { aud: TOKEN_AUDIENCES.platform })],
    ['a token for the account audience', (a) => forge(a, { aud: TOKEN_AUDIENCES.account })],
    ['a token for the retired Phase 1 audience', (a) => forge(a, { aud: 'bookly-admin' })],
    ['a token from another issuer', (a) => forge(a, { iss: 'someone-else' })],
    ['a token for a nonexistent user', (a) => forge(a, { sub: NONEXISTENT_ID })],
    ['a token claiming the platform_admin role', (a) => forge(a, { role: 'platform_admin' })],
    ['a token claiming the client role', (a) => forge(a, { role: 'client' })],
    ['a token claiming a role outside the vocabulary', (a) => forge(a, { role: 'admin' })],
    ['a token whose subject is not a UUID', (a) => forge(a, { sub: 'not-a-uuid' })],
    ['a token with a stale fingerprint', (a) => forge(a, { fingerprint: 'stale' })],
    [
      'a token that expired an hour ago',
      (a) => forge(a, { expSeconds: Math.floor(clock.getTime() / 1000) - 3600 }),
    ],
    [
      'an alg "none" token',
      async (a) => {
        const [, payload] = (await forge(a)).split('.');
        const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
        return `${none}.${payload ?? ''}.`;
      },
    ],
    [
      'a token whose payload was edited to extend its expiry',
      async (a) => {
        const [header, payload, signature] = (await forge(a)).split('.');
        const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as {
          exp: number;
        };
        const extended = Buffer.from(
          JSON.stringify({ ...claims, exp: claims.exp + 365 * 24 * 3600 }),
        ).toString('base64url');
        return `${header ?? ''}.${extended}.${signature ?? ''}`;
      },
    ],
    ['three nonsense segments', () => Promise.resolve('abc.def.ghi')],
  ])('refuses %s with 401 invalid_token, never 500', async (_label, build) => {
    const admin = await seedAdmin();

    expectUnauthenticated(await me(await build(admin)), 'invalid_token');
  });

  it('refuses a token for a user that has since been deleted', async () => {
    const admin = await seedAdmin();
    const token = await mint(admin);
    await prisma.photographer.delete({ where: { userId: admin.id } });
    await prisma.appUser.delete({ where: { id: admin.id } });

    expectUnauthenticated(await me(token), 'invalid_token');
  });

  it('refuses a token for a photographer whose row has since been removed', async () => {
    const admin = await seedAdmin();
    const token = await mint(admin);
    await prisma.photographer.delete({ where: { userId: admin.id } });

    expectUnauthenticated(await me(token), 'invalid_token');
  });

  it('refuses a token, on the very next request, once a platform admin disables the login', async () => {
    const admin = await seedAdmin();
    const token = await mint(admin);
    expect((await me(token)).status).toBe(200);

    await prisma.appUser.update({ where: { id: admin.id }, data: { disabledAt: START } });

    expectUnauthenticated(await me(token), 'invalid_token');
  });

  it('refuses a token, on the very next request, once revokeTokens bumps the token version (T2.5)', async () => {
    const admin = await seedAdmin();
    const token = await mint(admin);
    expect((await me(token)).status).toBe(200);

    await revokeTokens(prisma, admin.id);

    expectUnauthenticated(await me(token), 'invalid_token');
    // A token issued after the revocation works.
    expect((await me(await mint(await reload(admin)))).status).toBe(200);
  });

  it('refuses a token once the address stops being verified', async () => {
    const admin = await seedAdmin();
    const token = await mint(admin);

    await prisma.appUser.update({ where: { id: admin.id }, data: { emailVerifiedAt: null } });

    expectUnauthenticated(await me(token), 'invalid_token');
  });

  it('refuses a token once the login is erased', async () => {
    const admin = await seedAdmin();
    const token = await mint(admin);

    await prisma.appUser.update({ where: { id: admin.id }, data: { anonymizedAt: START } });

    expectUnauthenticated(await me(token), 'invalid_token');
  });

  it('decides on the role stored now, not the one in the token', async () => {
    const admin = await seedAdmin();
    const token = await mint(admin);

    await prisma.appUser.update({ where: { id: admin.id }, data: { role: 'client' } });

    expectUnauthenticated(await me(token), 'invalid_token');
  });

  it.each([
    ['platform_admin', 'platform'],
    ['client', 'account'],
  ] as const)('refuses a correctly issued token for a %s, from its own area', async (role, area) => {
    const user = await seedUser(role);

    expectUnauthenticated(await me((await issueToken(SECRET, area, user, clock)).token), 'invalid_token');
  });

  it.each(['pending', 'suspended'])('admits a %s photographer, whose studio stays open', async (status) => {
    const admin = await seedAdmin();
    await prisma.photographer.update({
      where: { userId: admin.id },
      data: { status, approvedAt: null, ...(status === 'suspended' ? { suspendedAt: START } : {}) },
    });

    expect((await me(await mint(admin))).status).toBe(200);
  });

  it("answers /me with each photographer's own login", async () => {
    const first = await seedAdmin();
    const second = await seedAdmin(OTHER_EMAIL);

    expect((await me(await mint(first))).body).toMatchObject({ user: toPublicUser(first), photographer: { id: await photographerIdOf(first) } });
    expect((await me(await mint(second))).body).toMatchObject({ user: toPublicUser(second), photographer: { id: await photographerIdOf(second) } });
  });

  it("refuses one photographer's token after the other's password changes only if it is theirs", async () => {
    const first = await seedAdmin();
    const second = await seedAdmin(OTHER_EMAIL);
    const firstToken = await mint(first);
    const secondToken = await mint(second);

    await prisma.appUser.update({
      where: { id: second.id },
      data: { passwordHash: await hashPassword(NEW_PASSWORD) },
    });

    expect((await me(firstToken)).status).toBe(200);
    expectUnauthenticated(await me(secondToken), 'invalid_token');
  });

  it.each(['bearer', 'BEARER', 'Bearer'])('accepts the %s scheme in any casing', async (scheme) => {
    const admin = await seedAdmin();
    const token = await mint(admin);

    const res = await request(app).get('/api/studio/me').set('Authorization', `${scheme} ${token}`);

    expect(res.status).toBe(200);
  });
});

// --- Where the token is NOT read from ---------------------------------------------

describe('a token anywhere but the Authorization header', () => {
  it.each<[string, (req: request.Test, token: string) => request.Test]>([
    ['a Cookie header', (req, t) => req.set('Cookie', `token=${t}; access_token=${t}`)],
    ['the old session cookie name', (req, t) => req.set('Cookie', `bookly_admin_session=${t}`)],
    ['a custom X-Access-Token header', (req, t) => req.set('X-Access-Token', t)],
    ['the Authorization header with the Basic scheme', (req, t) => req.set('Authorization', `Basic ${t}`)],
    ['the Authorization header with no scheme', (req, t) => req.set('Authorization', t)],
  ])('is ignored when sent in %s -- a 401', async (_label, attach) => {
    const admin = await seedAdmin();
    const token = await mint(admin);

    expectUnauthenticated(await attach(request(app).get('/api/studio/me'), token));
  });

  it('is ignored in the query string', async () => {
    const admin = await seedAdmin();
    const token = await mint(admin);

    expectUnauthenticated(await request(app).get(`/api/studio/me?token=${token}&access_token=${token}`));
  });
});

// --- Without a token --------------------------------------------------------------------

describe('/api/studio/* without a token', () => {
  it.each(['/api/studio/me', '/api/studio/does-not-exist', '/api/studio/', '/api/studio/auth/logout'])(
    'GET %s answers 401 with a Bearer challenge and no redirect',
    async (path) => {
      expectUnauthenticated(await request(app).get(path));
    },
  );

  it('HEAD /api/studio/me answers 401 with no redirect', async () => {
    const res = await request(app).head('/api/studio/me');
    expect(res.status).toBe(401);
    expect(res.headers.location).toBeUndefined();
    expect(String(res.headers['www-authenticate'])).toMatch(/^Bearer /);
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)(
    '%s on a protected path answers 401 before any handler runs',
    async (method) => {
      expectUnauthenticated(await request(app)[method]('/api/studio/me').send({}));
    },
  );

  it('answers an unknown path with 404 only once authenticated', async () => {
    const admin = await seedAdmin();

    expectUnauthenticated(await request(app).get('/api/studio/nope'));
    const res = await request(app)
      .get('/api/studio/nope')
      .set('Authorization', `Bearer ${await mint(admin)}`);
    expect(res.status).toBe(404);
  });
});

// --- Cross-site requests -----------------------------------------------------------------

describe('a cross-site request', () => {
  it('cannot authenticate by riding along with anything the browser attaches on its own', async () => {
    // What a forged cross-site form post or fetch actually carries: a foreign
    // Origin and whatever cookies the browser holds for the API host. With
    // bearer auth there is no ambient credential among them, so it is a 401 --
    // no CSRF token required.
    const admin = await seedAdmin();
    const token = await mint(admin);

    const res = await request(app)
      .post('/api/studio/me')
      .set('Origin', FOREIGN_ORIGIN)
      .set('Cookie', `bookly_admin_session=${token}; bookly_admin_csrf=x`)
      .type('form')
      .send('anything=1');

    expectUnauthenticated(res);
  });

  it('with a valid token and a foreign Origin is still served -- the token is the credential', async () => {
    // The server does not gate on Origin. A page on another site cannot read or
    // obtain the token, and without it has nothing to send; if it HAS the token,
    // Origin checks would not stop it either. CORS decides what that page may
    // read back, which the next tests cover.
    const admin = await seedAdmin();

    const res = await me(await mint(admin)).set('Origin', FOREIGN_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS for bearer auth', () => {
  function preflight(origin: string): request.Test {
    return request(app)
      .options('/api/studio/me')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization, content-type');
  }

  it('approves a preflight from the admin UI that asks to send Authorization', async () => {
    const res = await preflight(WEB_ORIGIN);

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization',
    );
  });

  it('never allows credentials, because admin auth uses none', async () => {
    const pre = await preflight(WEB_ORIGIN);
    const admin = await seedAdmin();
    const actual = await me(await mint(admin)).set('Origin', WEB_ORIGIN);

    for (const res of [pre, actual]) {
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('gives a foreign origin no Allow-Origin on the preflight or the response', async () => {
    const pre = await preflight(FOREIGN_ORIGIN);
    const admin = await seedAdmin();
    const actual = await me(await mint(admin)).set('Origin', FOREIGN_ORIGIN);

    for (const res of [pre, actual]) {
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});

describe('the endpoints the cookie design had and this one does not', () => {
  it('has no logout endpoint: signing out is the client discarding its token', async () => {
    const admin = await seedAdmin();

    const res = await request(app)
      .post('/api/studio/auth/logout')
      .set('Authorization', `Bearer ${await mint(admin)}`);

    expect(res.status).toBe(404);
    expect(setCookies(res)).toEqual([]);
  });

  it('a token still works after a would-be logout, because nothing server-side revoked it', async () => {
    const admin = await seedAdmin();
    const token = await mint(admin);

    await request(app).post('/api/studio/auth/logout').set('Authorization', `Bearer ${token}`);

    expect((await me(token)).status).toBe(200);
  });
});

// --- Password reset ---------------------------------------------------------------

describe('password reset over HTTP', () => {
  it('answers 202 alike for a photographer and an unknown email, emailing only the photographer', async () => {
    const admin = await seedAdmin();

    const unknown = await requestReset('nobody@bookly.example');
    expect(unknown.status).toBe(202);
    await expect(prisma.outbox.count()).resolves.toBe(0);
    await expect(reload(admin)).resolves.toEqual(admin);

    const known = await requestReset(EMAIL);
    expect(known.status).toBe(202);
    expect(known.body).toEqual({ ok: true });
    expect(known.text).toBe(unknown.text);
    await expect(prisma.outbox.count()).resolves.toBe(1);
    expect(known.text).not.toContain(await latestResetToken());
  });

  it('stores only the token hash, and the emailed token works exactly once', async () => {
    const admin = await seedAdmin();
    expect((await requestReset(EMAIL)).status).toBe(202);
    const token = await latestResetToken();

    const pending = await reload(admin);
    expect(pending.passwordResetTokenHash).not.toBe(token);
    expect(pending.passwordResetTokenHash).toBe(sha256(token));

    const first = await confirmReset(token, NEW_PASSWORD);
    expect(first.status).toBe(204);
    expect(first.text).toBe('');

    const reused = await confirmReset(token, 'yet another new passphrase');
    expect(reused.status).toBe(400);
    expect(reused.body).toEqual({ error: 'invalid_or_expired_token' });

    expect((await login(EMAIL, PASSWORD)).status).toBe(401);
    expect((await login(EMAIL, NEW_PASSWORD)).status).toBe(200);
  }, 30_000);

  it('points the emailed link at the web origin with a #token= fragment', async () => {
    await seedAdmin();
    await requestReset(EMAIL);

    const [row] = await prisma.outbox.findMany();
    if (row === undefined) throw new Error('No reset email was enqueued');
    const url = new URL(String(payloadOf(row).resetUrl));

    expect(url.origin).toBe(WEB_ORIGIN);
    expect(url.pathname).toBe('/studio/reset-password');
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#token=${await latestResetToken()}`);
  });

  it('refuses the token once 30 minutes have passed, leaving the password unchanged', async () => {
    const admin = await seedAdmin();
    await requestReset(EMAIL);
    const token = await latestResetToken();

    clock = new Date(START.getTime() + RESET_TTL_MS + 1);
    const res = await confirmReset(token, NEW_PASSWORD);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_or_expired_token' });
    await expect(reload(admin)).resolves.toMatchObject({ passwordHash });
  });

  it('invalidates a bearer token issued before the reset, on the very next request', async () => {
    await seedAdmin();
    const token = await signIn();
    expect((await me(token)).status).toBe(200);
    await requestReset(EMAIL);

    expect((await confirmReset(await latestResetToken(), NEW_PASSWORD)).status).toBe(204);

    expectUnauthenticated(await me(token), 'invalid_token');
  });

  it('refuses a too-short new password with 400, leaving password and link intact', async () => {
    const admin = await seedAdmin();
    await requestReset(EMAIL);
    const token = await latestResetToken();
    const pending = await reload(admin);

    const short = await confirmReset(token, 'elevenchars');
    expect(short.status).toBe(400);
    expect(short.body).toEqual({ error: 'invalid_request' });
    await expect(reload(admin)).resolves.toEqual(pending);

    expect((await confirmReset(token, 'twelve chars')).status).toBe(204);
  });

  it('honours only the newest link when a reset is requested twice', async () => {
    await seedAdmin();
    await requestReset(EMAIL);
    const first = await latestResetToken();
    clock = new Date(START.getTime() + MINUTE_MS);
    await requestReset(EMAIL);
    const second = await latestResetToken();

    expect((await confirmReset(first, NEW_PASSWORD)).status).toBe(400);
    expect((await confirmReset(second, NEW_PASSWORD)).status).toBe(204);
  });

  it('clears a lockout, so the new password logs in at once', async () => {
    const admin = await seedAdmin();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) await login(EMAIL, WRONG);
    expect((await reload(admin)).lockedUntil).not.toBeNull();
    await requestReset(EMAIL);

    expect((await confirmReset(await latestResetToken(), NEW_PASSWORD)).status).toBe(204);

    // The same instant the lock was set: only the reset can explain a 200.
    expect((await login(EMAIL, NEW_PASSWORD)).status).toBe(200);
  }, 30_000);

  it('lets exactly one of two simultaneous confirmations of one token win', async () => {
    await seedAdmin();
    await requestReset(EMAIL);
    const token = await latestResetToken();

    const results = await Promise.all([
      confirmReset(token, 'first racing passphrase'),
      confirmReset(token, 'second racing passphrase'),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([204, 400]);
  });

  it.each<[string, unknown]>([
    ['an empty object', {}],
    ['a numeric email', { email: 42 }],
    ['a null email', { email: null }],
    ['an array email', { email: [EMAIL] }],
    ['an empty email', { email: '' }],
    ['a whitespace-only email', { email: '   ' }],
    ['a 321-character email', { email: `${'a'.repeat(309)}@example.com` }],
  ])('answers a reset request with %s with 400', async (_label, body) => {
    await seedAdmin();

    const res = await request(app)
      .post('/api/studio/auth/password-reset/request')
      .send(body as object);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('answers a malformed JSON reset request with 400', async () => {
    const res = await request(app)
      .post('/api/studio/auth/password-reset/request')
      .set('Content-Type', 'application/json')
      .send('{"email":');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
  });

  it.each(['%', '\\'])('answers a reset request for %j with 202, sending nothing', async (email) => {
    await seedAdmin();

    const res = await requestReset(email);

    expect(res.status).toBe(202);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it.each(['platform_admin', 'client'] as const)('answers a reset request for a %s with the same 202, sending nothing', async (role) => {
    const user = await seedUser(role);

    const unknown = await requestReset('nobody@bookly.example');
    const res = await requestReset(EMAIL);

    expect(res.status).toBe(202);
    expect(res.text).toBe(unknown.text);
    await expect(prisma.outbox.count()).resolves.toBe(0);
    await expect(reload(user)).resolves.toEqual(user);
  });

  it.each<[string, (token: string) => unknown]>([
    ['an empty object', () => ({})],
    ['no new password', (token) => ({ token })],
    ['no token', () => ({ newPassword: NEW_PASSWORD })],
    ['an empty token', () => ({ token: '', newPassword: NEW_PASSWORD })],
    ['a numeric token', () => ({ token: 1, newPassword: NEW_PASSWORD })],
    ['a 513-character token', () => ({ token: 't'.repeat(513), newPassword: NEW_PASSWORD })],
    ['an 11-character new password', (token) => ({ token, newPassword: '12345678901' })],
    ['a numeric new password', (token) => ({ token, newPassword: 123456789012345 })],
    ['a 1025-character new password', (token) => ({ token, newPassword: 'n'.repeat(1025) })],
    ['null fields', () => ({ token: null, newPassword: null })],
  ])('answers a reset confirmation with %s with 400, changing nothing', async (_label, body) => {
    const admin = await seedAdmin();
    await requestReset(EMAIL);
    const pending = await reload(admin);

    const res = await request(app)
      .post('/api/studio/auth/password-reset/confirm')
      .send(body(await latestResetToken()) as object);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    await expect(reload(admin)).resolves.toEqual(pending);
  });

  it('answers a malformed JSON reset confirmation with 400', async () => {
    const res = await request(app)
      .post('/api/studio/auth/password-reset/confirm')
      .set('Content-Type', 'application/json')
      .send('{"token": "abc", ');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
  });
});

// --- password_hash never leaves the API -------------------------------------------

describe('password_hash never leaves the API', () => {
  const PRIVATE_NAMES = [
    'passwordHash',
    'password_hash',
    'argon2',
    'failedLoginCount',
    'lockedUntil',
    'passwordReset',
    'emailVerify',
    'googleSub',
    'disabledAt',
    'tokenVersion',
    'token_version',
    'role',
  ];

  it('toPublicUser exposes exactly id, email and lastLoginAt from a fully set row', async () => {
    const resetHash = sha256('a pending reset token');
    const verifyHash = sha256('a pending verification token');
    const admin = await prisma.appUser.create({
      data: {
        email: EMAIL,
        role: 'photographer',
        fullName: 'Aline Photographer',
        passwordHash,
        emailVerifiedAt: START,
        emailVerifyTokenHash: verifyHash,
        emailVerifyExpiresAt: START,
        failedLoginCount: 3,
        lockedUntil: START,
        passwordResetTokenHash: resetHash,
        passwordResetExpiresAt: START,
        lastLoginAt: START,
      },
    });

    const shown = toPublicUser(admin);

    expect(Object.keys(shown).sort()).toEqual(['email', 'id', 'lastLoginAt']);
    expect(shown).toEqual({ id: admin.id, email: EMAIL, lastLoginAt: START.toISOString() });
    const json = JSON.stringify(shown);
    for (const secret of [passwordHash, resetHash, verifyHash, ...PRIVATE_NAMES]) {
      expect(json).not.toContain(secret);
    }
  });

  it('toPublicUser renders a never-logged-in user with lastLoginAt null', async () => {
    const admin = await seedAdmin();

    expect(toPublicUser(admin)).toEqual({ id: admin.id, email: EMAIL, lastLoginAt: null });
  });

  it('is absent from the text of login, /me, a refused login and a reset request', async () => {
    const admin = await seedAdmin();
    await requestReset(EMAIL);
    const { passwordResetTokenHash } = await reload(admin);
    if (passwordResetTokenHash === null) throw new Error('Reset request stored no hash');

    const ok = await login();
    const responses = [
      ok,
      await me((ok.body as { token: string }).token),
      await login(EMAIL, WRONG),
      await requestReset(EMAIL),
    ];

    expect(ok.status).toBe(200);
    for (const res of responses) {
      for (const secret of [hashOf(admin), passwordResetTokenHash, ...PRIVATE_NAMES]) {
        expect(res.text).not.toContain(secret);
      }
    }
  });
});

// --- What requirePhotographer hands the routes behind it ---------------------------------

describe('requirePhotographer', () => {
  // Every studio router reads the photographer to scope to from here
  // (marketplace-spec.md R1.4), so this pins exactly what it carries.

  function probe(): Express {
    const probeApp = express();
    probeApp.use(requirePhotographer({ prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock }));
    probeApp.get('/probe', (_req, res) => {
      const { user, photographerId } = photographerLocals(res);
      res.json({ userId: user.id, role: user.role, photographerId, keys: Object.keys(user).sort() });
    });
    return probeApp;
  }

  it("puts the user and their own photographerId on res.locals, from the token's user only", async () => {
    const first = await seedAdmin();
    const second = await seedAdmin(OTHER_EMAIL);

    for (const user of [first, second]) {
      const res = await request(probe())
        .get(`/probe?photographerId=${await photographerIdOf(first === user ? second : first)}`)
        .set('Authorization', `Bearer ${await mint(user)}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ userId: user.id, role: 'photographer', photographerId: await photographerIdOf(user) });
    }
  });

  it('carries the app_user row alone, not the photographer relation it was loaded with', async () => {
    const admin = await seedAdmin();

    const res = await request(probe()).get('/probe').set('Authorization', `Bearer ${await mint(admin)}`);

    expect((res.body as { keys: string[] }).keys).toEqual(Object.keys(admin).sort());
  });
});

// --- Mounting -----------------------------------------------------------------------

describe('mounting', () => {
  it('keeps no alias at the old admin prefix: 404 with or without a valid token (Phase 2 decision 1)', async () => {
    const admin = await seedAdmin();
    // Built, so the old prefix appears nowhere in the source as a path.
    const old = ['', 'api', 'admin'].join('/');

    for (const path of [`${old}/me`, `${old}/auth/login`, `${old}/bookings`]) {
      expect((await request(app).get(path).set('Authorization', `Bearer ${await mint(admin)}`)).status).toBe(404);
    }
    expect((await request(app).post(`${old}/auth/login`).send({ email: EMAIL, password: PASSWORD })).status).toBe(404);
  });

  it('404s /api/studio/* when createApp is given no admin deps -- closed, not open', async () => {
    const bare = createApp();

    const meRes = await request(bare).get('/api/studio/me');
    expect(meRes.status).toBe(404);
    expect(meRes.body).toEqual({ error: 'not_found' });

    const loginRes = await request(bare)
      .post('/api/studio/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    expect(loginRes.status).toBe(404);
  });
});
