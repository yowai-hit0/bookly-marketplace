import type { AppUser, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
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
 * The account area (`/api/account/*`, clients) is built by a later unit of
 * Phase 2. Its column is in the table as a pending slot: when its route
 * exists, fill in `ROUTES.account` and the matrix covers it with no other
 * change.
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

/** One route per family, all GETs that change nothing. `null`: the area has no route yet. */
const ROUTES: Record<'public' | AuthArea, string | null> = {
  public: `/api/photographers/${PHOTOGRAPHER_HANDLE}`,
  studio: '/api/studio/me',
  platform: '/api/platform/me',
  // Pending: `/api/account/me` arrives with the account area (Phase 2, a later unit).
  account: null,
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
  { label: 'a photographer signed for the retired bookly-admin audience', bearer: () => signed(users.photographer, 'bookly-admin', 'photographer'), admittedTo: null },
];

const FAMILIES = Object.keys(ROUTES) as (keyof typeof ROUTES)[];

/** Every caller against every family with a route; the pending account slot is the `it.todo` below. */
const MATRIX = CALLERS.flatMap((caller) => FAMILIES.filter((family) => ROUTES[family] !== null).map((family) => [caller.label, family, caller] as const));

describe('the role matrix (T2.1)', () => {
  it.each(MATRIX)('%s against the %s route', async (_label, family, caller) => {
    const path = ROUTES[family] ?? '';

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

  it.todo('covers the account route once `/api/account/*` exists (fill in ROUTES.account)');

  it('gives every signed-in area exactly one admitted caller', () => {
    for (const area of ['studio', 'platform', 'account'] as const) {
      expect(CALLERS.filter((caller) => caller.admittedTo === area)).toHaveLength(1);
    }
  });
});
