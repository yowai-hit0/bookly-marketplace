import type { AppUser, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { revokeTokens } from '../auth/account-auth.js';
import { type AuthArea } from '../auth/roles.js';
import { TOKEN_AUDIENCES, TOKEN_ISSUER, credentialFingerprint, issueToken } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { PHOTOGRAPHER_HANDLE, type PaymentWorld, seedWorld } from '../test/payment-fixtures.js';

/**
 * The role matrix (marketplace-spec.md T2.1; Phase 2 decisions 1-2): a token
 * for every role, no token, and tokens signed for the wrong audience, each
 * against one route of every area. Only the area's own role gets a 2xx; every
 * other caller of a signed-in area gets a 401. A public route serves everyone.
 *
 * Then revocation, through each area's real middleware (T2.5): a password
 * change, `revokeTokens` and disabling the login each turn a working token
 * into a 401 on the very next request, for every role -- a Google-only client
 * included, who has no password to change.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let world: PaymentWorld;
let users: Record<'photographer' | 'platform_admin' | 'client', AppUser>;

const SECRET = 'role-matrix-test-secret-at-least-32-characters-long';
const WEB_ORIGIN = 'https://bookly.example';
const NOW = new Date('2026-10-17T07:00:00Z');

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
});

afterAll(async () => {
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  world = await seedWorld(prisma);
  users = {
    photographer: await prisma.appUser.findUniqueOrThrow({ where: { id: world.photographerUserId } }),
    platform_admin: await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } }),
    client: await prisma.appUser.create({ data: { email: 'client.account@bookly.example', role: 'client', passwordHash: 'not-a-real-hash', emailVerifiedAt: NOW } }),
  };
  app = createApp({
    corsOrigin: WEB_ORIGIN,
    auth: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => NOW },
    publicApi: { prisma, now: () => NOW },
  });
});

/** One route per family, all GETs that change nothing. */
const ROUTES: Record<'public' | AuthArea, string> = {
  public: `/api/photographers/${PHOTOGRAPHER_HANDLE}`,
  studio: '/api/studio/me',
  platform: '/api/platform/me',
  account: '/api/account/me',
};

/** A correctly signed token with the user's real credential fingerprint, for any audience and role. */
async function signed(user: AppUser, aud: string, role: string): Promise<string> {
  const now = Math.floor(NOW.getTime() / 1000);
  return new SignJWT({ role, cred_fp: credentialFingerprint(SECRET, user) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(aud)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(SECRET));
}

type Caller = {
  label: string;
  bearer: () => Promise<string | null>;
  /** The one signed-in area this caller may use, if any. */
  admittedTo: AuthArea | null;
};

const CALLERS: Caller[] = [
  { label: 'no token', bearer: () => Promise.resolve(null), admittedTo: null },
  { label: 'a photographer (studio token)', bearer: async () => (await issueToken(SECRET, 'studio', users.photographer, NOW)).token, admittedTo: 'studio' },
  { label: 'a platform admin (platform token)', bearer: async () => (await issueToken(SECRET, 'platform', users.platform_admin, NOW)).token, admittedTo: 'platform' },
  { label: 'a client (account token)', bearer: async () => (await issueToken(SECRET, 'account', users.client, NOW)).token, admittedTo: 'account' },
  // Wrong audience: real users, real fingerprints, signed with the real secret -- for another area.
  { label: 'a photographer signed for the platform audience', bearer: () => signed(users.photographer, TOKEN_AUDIENCES.platform, 'photographer'), admittedTo: null },
  { label: 'a platform admin signed for the studio audience', bearer: () => signed(users.platform_admin, TOKEN_AUDIENCES.studio, 'platform_admin'), admittedTo: null },
  { label: 'a client signed for the studio audience', bearer: () => signed(users.client, TOKEN_AUDIENCES.studio, 'client'), admittedTo: null },
  { label: 'a client signed for the platform audience', bearer: () => signed(users.client, TOKEN_AUDIENCES.platform, 'client'), admittedTo: null },
  { label: 'a photographer signed for the account audience', bearer: () => signed(users.photographer, TOKEN_AUDIENCES.account, 'photographer'), admittedTo: null },
  { label: 'a platform admin signed for the account audience', bearer: () => signed(users.platform_admin, TOKEN_AUDIENCES.account, 'platform_admin'), admittedTo: null },
  { label: 'a photographer signed for the retired bookly-admin audience', bearer: () => signed(users.photographer, 'bookly-admin', 'photographer'), admittedTo: null },
];

const FAMILIES = Object.keys(ROUTES) as (keyof typeof ROUTES)[];

/** Every caller against every family. */
const MATRIX = CALLERS.flatMap((caller) => FAMILIES.map((family) => [caller.label, family, caller] as const));

describe('the role matrix (T2.1)', () => {
  it.each(MATRIX)('%s against the %s route', async (_label, family, caller) => {
    const path = ROUTES[family];

    const bearer = await caller.bearer();
    const req = request(app).get(path);
    const res = await (bearer === null ? req : req.set('Authorization', `Bearer ${bearer}`));

    if (family === 'public' || caller.admittedTo === family) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    } else {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthenticated' });
      expect(String(res.headers['www-authenticate'])).toMatch(new RegExp(`^Bearer realm="${TOKEN_AUDIENCES[family]}"`));
    }
  });

  it('gives every signed-in area exactly one admitted caller', () => {
    for (const area of ['studio', 'platform', 'account'] as const) {
      expect(CALLERS.filter((caller) => caller.admittedTo === area)).toHaveLength(1);
    }
  });
});

// --- Revocation, for every role (T2.5) -------------------------------------------

/** Each area, the user it admits, and its `/me`. */
const AREA_USERS = [
  ['studio', 'photographer'],
  ['platform', 'platform_admin'],
  ['account', 'client'],
] as const satisfies readonly (readonly [AuthArea, keyof typeof users])[];

async function meStatus(area: AuthArea, token: string): Promise<number> {
  return (await request(app).get(ROUTES[area]).set('Authorization', `Bearer ${token}`)).status;
}

describe.each(AREA_USERS)('revoking a %s token (T2.5)', (area, role) => {
  it(`refuses a ${role}'s token once the password changes`, async () => {
    const { token } = await issueToken(SECRET, area, users[role], NOW);
    expect(await meStatus(area, token)).toBe(200);

    await prisma.appUser.update({ where: { id: users[role].id }, data: { passwordHash: 'another-not-real-hash' } });

    expect(await meStatus(area, token)).toBe(401);
  });

  it(`refuses a ${role}'s token after revokeTokens`, async () => {
    const { token } = await issueToken(SECRET, area, users[role], NOW);

    await revokeTokens(prisma, users[role].id);

    expect(await meStatus(area, token)).toBe(401);
    const fresh = await issueToken(SECRET, area, await prisma.appUser.findUniqueOrThrow({ where: { id: users[role].id } }), NOW);
    expect(await meStatus(area, fresh.token)).toBe(200);
  });

  it(`refuses a disabled ${role}'s token`, async () => {
    const { token } = await issueToken(SECRET, area, users[role], NOW);

    await prisma.appUser.update({ where: { id: users[role].id }, data: { disabledAt: NOW } });

    expect(await meStatus(area, token)).toBe(401);
  });
});

describe('revoking a Google-only client (T2.5)', () => {
  it('refuses its token after revokeTokens, and once it links a password', async () => {
    const google = await prisma.appUser.create({
      data: { email: 'google.only@bookly.example', role: 'client', googleSub: 'google-sub-matrix', emailVerifiedAt: NOW },
    });
    const first = await issueToken(SECRET, 'account', google, NOW);
    expect(await meStatus('account', first.token)).toBe(200);

    await revokeTokens(prisma, google.id);
    expect(await meStatus('account', first.token)).toBe(401);

    const second = await issueToken(SECRET, 'account', await prisma.appUser.findUniqueOrThrow({ where: { id: google.id } }), NOW);
    expect(await meStatus('account', second.token)).toBe(200);
    await prisma.appUser.update({ where: { id: google.id }, data: { passwordHash: 'added-through-a-reset' } });
    expect(await meStatus('account', second.token)).toBe(401);
  });
});
