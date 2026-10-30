import type { AppUser, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { TOKEN_AUDIENCES, TOKEN_ISSUER, credentialFingerprint, issueToken } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { recordEarning } from '../payouts/ledger.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { seedStarterCategories } from '../test/directory-fixtures.js';
import { loadSpec, scanRoutes, specOperations } from '../test/openapi.js';
import { type PaymentWorld, createPhotographer, insertBooking, insertPayment, seedSecondPhotographer, seedWorld } from '../test/payment-fixtures.js';

/**
 * The platform console's access sweep (marketplace-spec.md T9.1; Phase 9 unit
 * P5), the platform's twin of the studio's isolation sweep
 * (studio-isolation.test.ts, T1.2): EVERY `/api/platform/*` operation but the
 * unauthenticated `/auth/*` ones (login, reset and verification, which take no
 * token by design and admit only a platform admin's credentials), each with
 * path parameters naming real rows and a body valid enough to act:
 *
 *   - a photographer's studio token, a client's account token, and a
 *     photographer's real credentials signed for the platform's own audience
 *     are each refused (401 or 403), and every platform-relevant row in the
 *     database is left exactly as it was, with nothing queued in the outbox
 *     and nothing written to the audit trail;
 *   - a platform admin's token is NOT refused (neither 401 nor 403, and never
 *     a 500), so the refusals above are not a route that refuses everyone.
 *
 * The table is checked against the routes themselves: the operations come
 * from the OpenAPI spec and from the routes the code mounts (test/openapi.ts),
 * and a route on either list that the table does not cover fails the sweep, so
 * a new platform route cannot ship without being proven here; an entry for a
 * route that is gone fails it too.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let world: PaymentWorld;
let ids: Ids;
let users: { photographer: AppUser; client: AppUser; admin: AppUser };

const SECRET = 'platform-access-test-secret-at-least-32-characters';
const WEB_ORIGIN = 'https://bookly.example';
/** After every fixture shoot (January 2027 onwards) has ended. */
const NOW = new Date('2027-12-01T08:00:00.000Z');
const PLATFORM_PREFIX = '/api/platform/';
const AUTH_PREFIX = '/api/platform/auth/';

/** Real rows every id-taking route can name, in states that let each action succeed. */
type Ids = {
  /** Pending and submitted for review: approvable, suspendable. */
  pendingPhotographerId: string;
  /** A draft payout of the world photographer's: payable, cancellable. */
  draftPayoutId: string;
  /** A second photographer with a payable balance and a method: a payout can be built. */
  secondPhotographerId: string;
  /** An online payment owed back. */
  refundDuePaymentId: string;
  /** A category nobody has: renamable and deletable. */
  unusedCategoryId: string;
  categoryIds: string[];
};

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
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await truncateAll(raw);
  world = await seedWorld(prisma);
  const second = await seedSecondPhotographer(prisma, world);
  const pending = await createPhotographer(prisma, {
    email: 'pending.access@bookly.example',
    handle: 'pending-access',
    displayName: 'Pending Access',
    status: 'pending',
    submittedAt: new Date('2027-11-30T09:00:00Z'),
  });
  for (const of of [world, second]) {
    await prisma.payoutMethod.create({
      data: { photographerId: of.photographerId, kind: 'momo', momoNetwork: 'mtn', momoNumber: '+250788123456', accountName: 'Account', createdAt: new Date('2027-10-01T00:00:00Z') },
    });
    const booking = await insertBooking(prisma, of, { status: 'confirmed' });
    const payment = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
    await prisma.$transaction((tx) => recordEarning(tx, payment.id));
  }
  users = {
    photographer: await prisma.appUser.findUniqueOrThrow({ where: { id: world.photographerUserId } }),
    client: await prisma.appUser.create({ data: { email: 'client.access@bookly.example', role: 'client', passwordHash: 'x', emailVerifiedAt: NOW } }),
    admin: await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } }),
  };
  const draft = await prisma.payout.create({
    data: {
      photographerId: world.photographerId,
      amountRwf: 20_000,
      payoutMethodId: (await prisma.payoutMethod.findFirstOrThrow({ where: { photographerId: world.photographerId } })).id,
      createdByUserId: users.admin.id,
    },
  });
  await prisma.payoutItem.updateMany({ where: { photographerId: world.photographerId }, data: { payoutId: draft.id } });
  const cancelled = await insertBooking(prisma, world, { status: 'cancelled_by_client' });
  const refundDue = await insertPayment(prisma, cancelled.id, { status: 'refund_due', amountRwf: 20_000 });
  const categories = await seedStarterCategories(prisma);
  await prisma.photographerCategory.create({ data: { photographerId: world.photographerId, categoryId: categories.get('wedding') ?? '' } });
  ids = {
    pendingPhotographerId: pending.photographerId,
    draftPayoutId: draft.id,
    secondPhotographerId: second.photographerId,
    refundDuePaymentId: refundDue.id,
    unusedCategoryId: categories.get('fashion') ?? '',
    categoryIds: [...categories.values()].sort(),
  };
  app = createApp({ corsOrigin: WEB_ORIGIN, auth: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => NOW } });
});

// --- The table ------------------------------------------------------------------

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Case = {
  /** Path parameters naming real rows. Absent: the route takes none. */
  params?: (ids: Ids) => Record<string, string>;
  /** A body valid enough that a platform admin's request acts. */
  body?: (ids: Ids) => object;
  query?: string;
};

const PENDING = { params: (i: Ids) => ({ id: i.pendingPhotographerId }) };
const DRAFT = { params: (i: Ids) => ({ id: i.draftPayoutId }) };
const UNUSED_CATEGORY = { params: (i: Ids) => ({ id: i.unusedCategoryId }) };

/** Every platform operation but `/auth/*`, keyed `METHOD /path` as Express writes it. */
const SWEEP: Record<string, Case> = {
  'GET /api/platform/me': {},
  'GET /api/platform/photographers': { query: '?review=awaiting' },
  'GET /api/platform/photographers/:id': PENDING,
  'POST /api/platform/photographers/:id/approve': PENDING,
  'POST /api/platform/photographers/:id/suspend': { ...PENDING, body: () => ({ reason: 'Sweeping the console' }) },
  'POST /api/platform/photographers/:id/reactivate': PENDING,
  'GET /api/platform/payouts/due': {},
  'GET /api/platform/payouts': { query: '?status=draft' },
  'POST /api/platform/payouts': { body: (i) => ({ photographerId: i.secondPhotographerId }) },
  'GET /api/platform/payouts/:id': DRAFT,
  'POST /api/platform/payouts/:id/mark-paid': { ...DRAFT, body: () => ({ transferReference: 'SWEEP-TX-1' }) },
  'POST /api/platform/payouts/:id/cancel': DRAFT,
  'GET /api/platform/refunds': {},
  'POST /api/platform/refunds/:paymentId': { params: (i) => ({ paymentId: i.refundDuePaymentId }), body: () => ({ reference: 'SWEEP-REF-1' }) },
  'GET /api/platform/settings': {},
  'PATCH /api/platform/settings': { body: () => ({ trialDays: 14 }) },
  'GET /api/platform/subscriptions': {},
  'GET /api/platform/audit': {},
  'GET /api/platform/categories': {},
  'POST /api/platform/categories': { body: () => ({ slug: 'drone', nameEn: 'Drone' }) },
  'PUT /api/platform/categories/order': { body: (i) => ({ ids: i.categoryIds }) },
  'PATCH /api/platform/categories/:id': { ...UNUSED_CATEGORY, body: () => ({ nameEn: 'Fashion & style', isActive: false }) },
  'DELETE /api/platform/categories/:id': UNUSED_CATEGORY,
};

function fill(path: string, params: Record<string, string>): string {
  return path.replace(/:(\w+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`No value for :${name} in ${path}`);
    return value;
  });
}

/** Every platform operation but the unauthenticated auth ones: from the spec, and from the routes the code mounts. */
async function platformOperations(): Promise<string[]> {
  const spec = specOperations(await loadSpec()).map((op) => ({ method: op.method, path: op.path }));
  const code = scanRoutes().routes.map((route) => ({ method: route.method, path: route.path }));
  const keys = [...spec, ...code]
    .filter((op) => op.path.startsWith(PLATFORM_PREFIX) && !op.path.startsWith(AUTH_PREFIX))
    .map((op) => `${op.method.toUpperCase()} ${op.path}`);
  return [...new Set(keys)].sort();
}

/** A correctly signed token with the user's real credential fingerprint, for any audience and role. */
async function forged(user: AppUser, aud: string, role: string): Promise<string> {
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

const REFUSED_CALLERS: [string, () => Promise<string>][] = [
  ['a photographer’s studio token', async () => (await issueToken(SECRET, 'studio', users.photographer, NOW)).token],
  ['a client’s account token', async () => (await issueToken(SECRET, 'account', users.client, NOW)).token],
  ['a photographer’s credentials signed for the platform audience, claiming platform_admin', () => forged(users.photographer, TOKEN_AUDIENCES.platform, 'platform_admin')],
  ['a client’s credentials signed for the platform audience', () => forged(users.client, TOKEN_AUDIENCES.platform, 'client')],
];

/**
 * Every row a platform route reads or writes, through the raw driver rather
 * than the client under test, compared whole: a single changed column fails.
 */
async function platformRows(): Promise<Record<string, unknown[]>> {
  const tables = [
    'app_user',
    'photographer',
    'photographer_category',
    'category',
    'subscription',
    'subscription_period',
    'payout_method',
    'payout',
    'payout_item',
    'payment',
    'platform_setting',
    'outbox',
    'platform_audit',
  ];
  const rows: Record<string, unknown[]> = {};
  for (const table of tables) rows[table] = (await raw.query(`SELECT * FROM ${table} t ORDER BY t::text`)).rows;
  return rows;
}

function send(key: string, testCase: Case, bearer: string): request.Test {
  const [method, path] = key.split(' ') as [string, string];
  const url = fill(path, testCase.params?.(ids) ?? {}) + (testCase.query ?? '');
  const call = request(app)[method.toLowerCase() as Method](url).set('Authorization', `Bearer ${bearer}`);
  return testCase.body === undefined ? call : call.send(testCase.body(ids));
}

const KEYS = Object.keys(SWEEP);

// --- The sweep ------------------------------------------------------------------

describe('the sweep covers every platform route', () => {
  it('has a case for every route in the spec and in the code, and none for a route that is gone', async () => {
    const operations = await platformOperations();
    expect(operations.length).toBeGreaterThanOrEqual(23);

    const uncovered = operations.filter((key) => SWEEP[key] === undefined);
    const stale = KEYS.filter((key) => !operations.includes(key));

    expect(uncovered, `platform routes that are not in the access sweep:\n${uncovered.join('\n')}`).toEqual([]);
    expect(stale, `sweep entries for routes that no longer exist:\n${stale.join('\n')}`).toEqual([]);
  });
});

describe.each(REFUSED_CALLERS)('%s on every platform route (T9.1)', (_label, bearer) => {
  it.each(KEYS)('%s is refused, changing nothing', async (key) => {
    const before = await platformRows();

    const res = await send(key, SWEEP[key] ?? {}, await bearer());

    expect([401, 403], `${key} answered ${res.status} ${res.text}`).toContain(res.status);
    expect(res.body).toEqual({ error: 'unauthenticated' });
    expect(await platformRows()).toEqual(before);
  });
});

describe('a platform admin on every platform route', () => {
  it.each(KEYS)('%s is not refused', async (key) => {
    const res = await send(key, SWEEP[key] ?? {}, (await issueToken(SECRET, 'platform', users.admin, NOW)).token);

    expect([401, 403], `${key} answered ${res.status} ${res.text}`).not.toContain(res.status);
    expect(res.status, `${key} answered ${res.status} ${res.text}`).toBeLessThan(500);
  });

  it('and each write case really acts, so the refusals above are not vacuous', async () => {
    const admin = (await issueToken(SECRET, 'platform', users.admin, NOW)).token;
    const writes = KEYS.filter((key) => !key.startsWith('GET '));
    const statuses: Record<string, number> = {};
    for (const key of writes) {
      // Each against a fresh copy of the rows would need a reseed; one pass in table order acts on each in turn.
      statuses[key] = (await send(key, SWEEP[key] ?? {}, admin)).status;
    }
    expect(statuses).toEqual({
      'POST /api/platform/photographers/:id/approve': 200,
      'POST /api/platform/photographers/:id/suspend': 200,
      'POST /api/platform/photographers/:id/reactivate': 200,
      'POST /api/platform/payouts': 201,
      'POST /api/platform/payouts/:id/mark-paid': 200,
      // Paid by the line before: only a draft can be cancelled.
      'POST /api/platform/payouts/:id/cancel': 409,
      'POST /api/platform/refunds/:paymentId': 200,
      'PATCH /api/platform/settings': 200,
      'POST /api/platform/categories': 201,
      // The new category joined the set after this case's ids were read: not the full set any more.
      'PUT /api/platform/categories/order': 422,
      'PATCH /api/platform/categories/:id': 200,
      'DELETE /api/platform/categories/:id': 204,
    });
  });
});
