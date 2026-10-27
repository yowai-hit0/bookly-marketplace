import type { AppUser, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createPrismaClient } from '../db/client.js';
import { ACCOUNT_PASSWORD, accountToken, createClientAccount } from '../test/account-fixtures.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { loadSpec, scanRoutes, specOperations } from '../test/openapi.js';
import {
  CLIENT,
  type PaymentWorld,
  TEST_SECRET,
  insertBooking,
  insertPayment,
  routeTo,
  seedSecondPhotographer,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';

/**
 * The client dashboard's isolation sweep (marketplace-spec.md T8.1; Phase 8
 * unit B10), the account area's twin of the studio's (studio-isolation.test.ts,
 * T1.2): client X, signed in, names client Y's booking reference or payment
 * `our_ref` on every account route that takes one, and every other account
 * route is exercised too.
 *
 * An id-taking request is a **404** -- the very answer for a reference that
 * names nothing, so it does not even confirm that Y's booking exists, and never
 * the `409 no_receipt` X's own pending payment would get -- and for EVERY route,
 * **every row of Y's is left exactly as it was**: Y's login, client row,
 * bookings, add-on lines, notes and payments, compared column by column, and
 * no message is queued to Y or about Y's bookings.
 *
 * Y's rows are in the states that would let each action succeed -- a confirmed
 * booking whose shoot is ahead, cancellable, that still owes money, with a
 * succeeded booking fee (a receipt) and a waiting session fee -- so a scope that
 * leaked would show as a 200 and a changed row, not hide behind a 409.
 *
 * The table is checked against the routes themselves: every `/api/account/*`
 * operation but the unauthenticated `/auth/*` ones, from the OpenAPI spec and
 * from the routes the code mounts (test/openapi.ts). A route on either list that
 * the table does not cover fails the sweep, so a new account route cannot ship
 * without being proven here; an entry for a route that is gone fails it too.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let tokenX: string;
let x: AppUser;
let y: AppUser;
let a: PaymentWorld;
let theirs: TheirIds;
let mine: { reference: string; pendingOurRef: string };

const NOW = new Date('2027-06-01T06:00:00Z');
const DAY_MS = 86_400_000;
const ACCOUNT_PREFIX = '/api/account/';
const AUTH_PREFIX = '/api/account/auth/';
const Y_EMAIL = 'yvonne.private@example.com';
const Y_NAME = 'Yvonne Private-Name';
const Y_PHONE = '+250788777666';

type TheirIds = { reference: string; receiptOurRef: string; pendingOurRef: string; noteBody: string };

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
  a = await seedWorld(prisma);
  const b = await seedSecondPhotographer(prisma, a);
  x = await createClientAccount(prisma, { email: CLIENT.email });
  const yClient = await prisma.client.create({ data: { fullName: Y_NAME, email: Y_EMAIL, phone: Y_PHONE } });
  y = await createClientAccount(prisma, { email: Y_EMAIL, fullName: Y_NAME, phone: Y_PHONE });
  theirs = await seedTheirs({ ...b, clientId: yClient.id });
  mine = await seedMine();
  tokenX = await accountToken(TEST_SECRET, prisma, x.id, NOW);
  app = createApp({
    auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: 'https://bookly.example', now: () => NOW },
    publicApi: { prisma, now: () => NOW, payments: { routing: routeTo(stubProvider()), secret: TEST_SECRET } },
  });
});

async function seedTheirs(world: PaymentWorld): Promise<TheirIds> {
  const inserted = await insertBooking(prisma, world, { status: 'confirmed', startsAt: new Date(NOW.getTime() + 5 * DAY_MS), addons: ['own', 'shared'], bookingFeeRefundableOnClientCancel: true });
  // The fixture snapshots CLIENT's contact on every booking; Y's booking carries Y's.
  const booking = await prisma.booking.update({ where: { id: inserted.id }, data: { contactName: Y_NAME, contactEmail: Y_EMAIL, contactPhone: Y_PHONE } });
  const receipt = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
  const pending = await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 5_000 });
  await prisma.bookingNote.create({ data: { bookingId: booking.id, body: 'THEIR-NOTE' } });
  return { reference: booking.reference, receiptOurRef: receipt.ourRef, pendingOurRef: pending.ourRef, noteBody: 'THEIR-NOTE' };
}

async function seedMine() {
  const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: new Date(NOW.getTime() + 3 * DAY_MS) });
  const pending = await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 5_000 });
  return { reference: booking.reference, pendingOurRef: pending.ourRef };
}

/**
 * Everything of Y's, read through the raw driver rather than the client under
 * test, compared whole: a single changed column anywhere fails.
 */
async function rowsOfY(): Promise<Record<string, unknown[]>> {
  const throughBooking = (table: string) =>
    `SELECT t.* FROM ${table} t JOIN booking b ON b.id = t.booking_id JOIN client c ON c.id = b.client_id WHERE c.user_id = $1 ORDER BY t.id`;
  const queries: Record<string, string> = {
    app_user: 'SELECT * FROM app_user WHERE id = $1',
    client: 'SELECT * FROM client WHERE user_id = $1 ORDER BY id',
    booking: 'SELECT b.* FROM booking b JOIN client c ON c.id = b.client_id WHERE c.user_id = $1 ORDER BY b.id',
    booking_addon: throughBooking('booking_addon'),
    booking_note: throughBooking('booking_note'),
    payment: throughBooking('payment'),
    outbox_about_y: throughBooking('outbox'),
  };
  const rows: Record<string, unknown[]> = {};
  for (const [table, sql] of Object.entries(queries)) rows[table] = (await raw.query(sql, [y.id])).rows;
  rows.outbox_to_y = (await raw.query('SELECT * FROM outbox WHERE lower(recipient) = lower($1) ORDER BY id', [Y_EMAIL])).rows;
  return rows;
}

/** Everything of Y's a response could leak. */
function theirMarks(): string[] {
  return [theirs.reference, theirs.receiptOurRef, theirs.pendingOurRef, theirs.noteBody, y.id, Y_EMAIL, Y_NAME, Y_PHONE];
}

// --- The table ------------------------------------------------------------------

type Method = 'get' | 'post' | 'patch';

type Case = {
  label: string;
  /** Path parameters naming Y's records. Absent: the route takes none. */
  params?: (ids: TheirIds) => Record<string, string>;
  /** A body valid enough to reach the lookup, so the answer is the scope's, never validation's. */
  body?: object | ((ids: TheirIds) => object);
  /** No session: the address change's confirmation. */
  anonymous?: boolean;
  query?: string;
};

const THEIR_BOOKING = { label: 'their booking', params: (ids: TheirIds) => ({ reference: ids.reference }) };

/**
 * Every account operation but `/auth/*`, keyed `METHOD /path` as Express writes
 * it. An id-taking one must answer 404; every one must leave Y's rows alone.
 */
const SWEEP: Record<string, Case[]> = {
  'GET /api/account/me': [{ label: 'my own account' }],
  'GET /api/account/bookings': [{ label: 'upcoming' }, { label: 'past', query: '?scope=past' }],
  'GET /api/account/bookings/:reference': [THEIR_BOOKING],
  'POST /api/account/bookings/:reference/cancel': [THEIR_BOOKING],
  'POST /api/account/bookings/:reference/payments': [{ ...THEIR_BOOKING, body: { method: 'momo_mtn', phone: '0788123456' } }],
  'GET /api/account/payments': [{ label: 'my payments' }],
  'GET /api/account/payments/:ourRef': [
    { label: 'their receipt', params: (ids) => ({ ourRef: ids.receiptOurRef }) },
    // Not the 409 no_receipt my own pending payment gets: that would confirm theirs exists.
    { label: 'their pending payment', params: (ids) => ({ ourRef: ids.pendingOurRef }) },
  ],
  'GET /api/account/profile': [{ label: 'my profile' }],
  'PATCH /api/account/profile': [{ label: 'my profile', body: { fullName: 'X Renamed', phone: '0788000111' } }],
  'POST /api/account/password': [{ label: 'my password', body: { currentPassword: ACCOUNT_PASSWORD, newPassword: 'a brand new password for x' } }],
  'POST /api/account/password/set': [{ label: 'a password I already have', body: { newPassword: 'a brand new password for x' } }],
  'POST /api/account/email': [{ label: 'their address as my new one', body: { newEmail: Y_EMAIL, password: ACCOUNT_PASSWORD } }],
  'POST /api/account/email/confirm': [{ label: 'a token naming nothing, their password', anonymous: true, body: { token: 'Vf3rT0k3n_aB9cD8eF7gH6iJ5kL4mN3oP2qR1sT0uVw', password: 'not anybody’s password' } }],
  'GET /api/account/export': [{ label: 'my export' }],
  'POST /api/account/delete': [{ label: 'my own account', body: { password: ACCOUNT_PASSWORD } }],
};

function fill(path: string, params: Record<string, string>): string {
  return path.replace(/:(\w+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`No value for :${name} in ${path}`);
    return value;
  });
}

/** Every account operation but the unauthenticated auth ones: from the spec, and from the routes the code mounts. */
async function accountOperations(): Promise<string[]> {
  const spec = specOperations(await loadSpec()).map((op) => ({ method: op.method, path: op.path }));
  const code = scanRoutes().routes.map((route) => ({ method: route.method, path: route.path }));
  const keys = [...spec, ...code]
    .filter((op) => op.path.startsWith(ACCOUNT_PREFIX) && !op.path.startsWith(AUTH_PREFIX))
    .map((op) => `${op.method.toUpperCase()} ${op.path}`);
  return [...new Set(keys)].sort();
}

const CASES = Object.entries(SWEEP).flatMap(([key, cases]) => cases.map((testCase) => [key, testCase.label, testCase] as const));

// --- The sweep ------------------------------------------------------------------

describe('the sweep covers every account route', () => {
  it('has a case for every route in the spec and in the code, and none for a route that is gone', async () => {
    const operations = await accountOperations();
    expect(operations.length).toBeGreaterThanOrEqual(15);

    const uncovered = operations.filter((key) => (SWEEP[key]?.length ?? 0) === 0);
    const stale = Object.keys(SWEEP).filter((key) => !operations.includes(key));

    expect(uncovered, `account routes that are not in the isolation sweep:\n${uncovered.join('\n')}`).toEqual([]);
    expect(stale, `sweep entries for routes that no longer exist:\n${stale.join('\n')}`).toEqual([]);
  });
});

describe('client X on every account route, naming client Y’s records where a route takes one (T8.1)', () => {
  it.each(CASES)('%s with %s leaves every row of Y’s as it was, and shows none of it', async (key, _label, testCase) => {
    const [method, path] = key.split(' ') as [string, string];
    const takesId = path.includes('/:');
    const url = (takesId ? fill(path, testCase.params?.(theirs) ?? {}) : path) + (testCase.query ?? '');
    const body = typeof testCase.body === 'function' ? testCase.body(theirs) : testCase.body;
    const before = await rowsOfY();

    let call = request(app)[method.toLowerCase() as Method](url);
    if (testCase.anonymous !== true) call = call.set('Authorization', `Bearer ${tokenX}`);
    if (body !== undefined) call = call.send(body);
    const res = await call;

    if (takesId) expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
    // Never a server error: every case is a request the route accepts the shape of.
    expect(res.status).toBeLessThan(500);
    for (const mark of theirMarks()) expect(res.text, mark).not.toContain(mark);
    expect(await rowsOfY()).toEqual(before);
  });

  it('answers Y’s reference exactly as a reference that names nothing', async () => {
    const named = await request(app).get(`/api/account/bookings/${theirs.reference}`).set('Authorization', `Bearer ${tokenX}`);
    const nothing = await request(app).get('/api/account/bookings/BKY-2706-ZZZZZ').set('Authorization', `Bearer ${tokenX}`);

    expect([named.status, named.body, named.headers['content-length']]).toEqual([nothing.status, nothing.body, nothing.headers['content-length']]);
  });

  it('and the routes do answer X’s own records, so the checks above are not vacuous', async () => {
    const get = (path: string) => request(app).get(path).set('Authorization', `Bearer ${tokenX}`);

    expect((await get(`/api/account/bookings/${mine.reference}`)).status).toBe(200);
    expect((await get('/api/account/bookings')).text).toContain(mine.reference);
    expect((await get('/api/account/payments')).text).toContain(mine.pendingOurRef);
    expect((await get(`/api/account/payments/${mine.pendingOurRef}`)).status).toBe(409);
    expect((await get('/api/account/export')).text).toContain(mine.reference);
  });

  it('Y’s own session sees Y’s records, and none of X’s', async () => {
    const tokenY = await accountToken(TEST_SECRET, prisma, y.id, NOW);
    const get = (path: string) => request(app).get(path).set('Authorization', `Bearer ${tokenY}`);

    expect((await get(`/api/account/bookings/${theirs.reference}`)).status).toBe(200);
    expect((await get(`/api/account/payments/${theirs.receiptOurRef}`)).status).toBe(200);
    for (const path of ['/api/account/bookings', '/api/account/payments', '/api/account/export']) {
      const text = (await get(path)).text;
      expect(text).not.toContain(mine.reference);
      expect(text).not.toContain(mine.pendingOurRef);
      expect(text).not.toContain(CLIENT.email);
    }
  });
});
