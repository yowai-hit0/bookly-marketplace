import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { issueToken } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { loadSpec, scanRoutes, specOperations } from '../test/openapi.js';
import {
  type PaymentWorld,
  TEST_SECRET,
  insertBooking,
  insertPayment,
  seedSecondPhotographer,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';

/**
 * The isolation sweep (marketplace-spec.md T1.2, R1.4): photographer A, signed
 * in, names photographer B's ids on every studio route that takes one.
 *
 * Every such request is a **404** -- exactly the answer for an id that names
 * nothing, so the response does not even confirm that B's row exists -- and
 * **every row of B's is left exactly as it was**: bookings, their add-on lines,
 * payments and notes, the catalogue, the calendar and the settings, compared
 * column by column before and after each request. Nothing is queued in the
 * outbox either.
 *
 * The table of requests is checked against the routes themselves. The id-taking
 * operations are derived from the OpenAPI spec and from the routes the code
 * mounts (`test/openapi.ts`), and a route on either list that this table does
 * not cover fails the sweep: a new studio route cannot ship without being
 * proven here. A table entry for a route that no longer exists fails it too.
 *
 * B's rows are in the states that would let each action succeed -- a confirmed
 * booking whose shoot has begun and which still owes money, a completed one
 * with a delivery link, a payment flagged `refund_due`, a removable post-shoot
 * line -- so a scope that leaked would show up as a 200 and a changed row, not
 * hide behind a 409.
 *
 * The list endpoints are swept the other way: A's bookings, calendar, blocks,
 * hours and catalogue hold A's rows and none of B's.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let token: string;
/** Photographer A, who is signed in. */
let a: PaymentWorld;
/** Photographer B, whose ids A names. */
let b: PaymentWorld;
let theirs: TheirIds;
let mine: { bookingId: string; reference: string; blockId: string; hoursId: string };

const WEB_ORIGIN = 'https://admin.bookly.example';
/** After every fixture shoot below has begun. */
const NOW = new Date('2027-06-01T06:00:00Z');
const STUDIO_PREFIX = '/api/studio/';

/** Everything of B's an id-taking route could name. */
type TheirIds = {
  /** Confirmed, its shoot begun, money still owed: every lifecycle action would apply. */
  bookingId: string;
  reference: string;
  /** Completed, with a delivery link: the delivery routes would apply. */
  completedBookingId: string;
  /** A post-shoot line nobody has paid for: removable. */
  bookingAddonId: string;
  noteId: string;
  /** Flagged `refund_due`: refundable. */
  paymentId: string;
  serviceId: string;
  packageId: string;
  ownAddonId: string;
  sharedAddonId: string;
  blockId: string;
  hoursId: string;
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
  await truncateAll(raw);
  a = await seedWorld(prisma);
  b = await seedSecondPhotographer(prisma, a);
  theirs = await seedTheirs(b);
  mine = await seedMine(a);

  const user = await prisma.appUser.findUniqueOrThrow({ where: { id: a.photographerUserId } });
  token = (await issueToken(TEST_SECRET, 'studio', user, NOW)).token;
  // With a payment provider, so the session-fee route is mounted and swept too.
  app = createApp({
    corsOrigin: WEB_ORIGIN,
    auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: WEB_ORIGIN, now: () => NOW },
    publicApi: { prisma, now: () => NOW, payments: { provider: stubProvider(), secret: TEST_SECRET } },
  });
});

// --- Fixtures ---------------------------------------------------------------------

async function seedTheirs(world: PaymentWorld): Promise<TheirIds> {
  const owner = { photographerId: world.photographerId };
  const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: new Date('2027-05-03T07:00:00Z'), addons: ['own', 'shared'] });
  const completed = await insertBooking(prisma, world, { status: 'completed', startsAt: new Date('2027-05-04T07:00:00Z') });
  await prisma.booking.update({
    where: { id: completed.id },
    data: { deliveryUrl: 'https://photos.example-host.com/s/theirs', deliveryExpiresOn: new Date('2027-09-01T00:00:00Z') },
  });
  await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
  const payment = await insertPayment(prisma, completed.id, { status: 'refund_due', amountRwf: 20_000 });
  const line = await prisma.bookingAddon.create({
    data: { bookingId: booking.id, addonId: world.ownAddonId, nameSnapshot: 'Extra hour', unitPriceRwf: 10_000, amountRwf: 10_000, stage: 'post_shoot' },
  });
  const note = await prisma.bookingNote.create({ data: { bookingId: booking.id, body: 'THEIR-NOTE' } });
  const block = await prisma.availabilityBlock.create({
    data: { ...owner, startsAt: new Date('2027-06-02T07:00:00Z'), endsAt: new Date('2027-06-02T09:00:00Z'), reason: 'THEIR-BLOCK' },
  });
  const hours = await prisma.workingHours.create({ data: { ...owner, weekday: 2, opensMinute: 540, closesMinute: 1020 } });
  return {
    bookingId: booking.id,
    reference: booking.reference,
    completedBookingId: completed.id,
    bookingAddonId: line.id,
    noteId: note.id,
    paymentId: payment.id,
    serviceId: world.serviceId,
    packageId: world.packageId,
    ownAddonId: world.ownAddonId,
    sharedAddonId: world.sharedAddonId,
    blockId: block.id,
    hoursId: hours.id,
  };
}

async function seedMine(world: PaymentWorld) {
  const owner = { photographerId: world.photographerId };
  const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: new Date('2027-05-03T07:00:00Z') });
  const block = await prisma.availabilityBlock.create({
    data: { ...owner, startsAt: new Date('2027-05-03T12:00:00Z'), endsAt: new Date('2027-05-03T14:00:00Z') },
  });
  const hours = await prisma.workingHours.create({ data: { ...owner, weekday: 1, opensMinute: 540, closesMinute: 1020 } });
  return { bookingId: booking.id, reference: booking.reference, blockId: block.id, hoursId: hours.id };
}

/**
 * Every row of one photographer's, in every table a studio route writes, read
 * through the raw driver rather than the client under test. Compared whole, so
 * a single changed column anywhere fails.
 */
async function rowsOf(photographerId: string): Promise<Record<string, unknown[]>> {
  const owned = (table: string) => `SELECT * FROM ${table} WHERE photographer_id = $1 ORDER BY id`;
  const throughBooking = (table: string) =>
    `SELECT t.* FROM ${table} t JOIN booking b ON b.id = t.booking_id WHERE b.photographer_id = $1 ORDER BY t.id`;
  const queries: Record<string, string> = {
    booking: owned('booking'),
    booking_addon: throughBooking('booking_addon'),
    payment: throughBooking('payment'),
    booking_note: throughBooking('booking_note'),
    service: owned('service'),
    package: owned('package'),
    addon: owned('addon'),
    working_hours: owned('working_hours'),
    availability_block: owned('availability_block'),
    photographer_setting: 'SELECT * FROM photographer_setting WHERE photographer_id = $1',
  };
  const rows: Record<string, unknown[]> = {};
  for (const [table, sql] of Object.entries(queries)) rows[table] = (await raw.query(sql, [photographerId])).rows;
  return rows;
}

async function outboxCount(): Promise<number> {
  return Number((await raw.query<{ n: string }>('SELECT count(*) AS n FROM outbox')).rows[0]?.n);
}

// --- The table ------------------------------------------------------------------

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** One request naming B's ids: which path parameters, and a body valid enough to reach the lookup. */
type Case = { label: string; params: (ids: TheirIds) => Record<string, string>; body?: object | ((ids: TheirIds) => object) };

const THEIR_BOOKING = { label: 'their booking', params: (ids: TheirIds) => ({ id: ids.bookingId }) };

/**
 * Every id-taking studio operation, keyed `METHOD /path` as Express writes it.
 * A body is always one the route would accept, so the answer is decided by the
 * lookup, never by validation: a 400 or 422 here would be a failure, not a pass.
 */
const SWEEP: Record<string, Case[]> = {
  'PUT /api/studio/working-hours/:id': [{ label: 'their hours', params: (ids) => ({ id: ids.hoursId }), body: { weekday: 6, isOpen: false } }],
  'DELETE /api/studio/working-hours/:id': [{ label: 'their hours', params: (ids) => ({ id: ids.hoursId }) }],
  'PUT /api/studio/blocks/:id': [
    {
      label: 'their block',
      params: (ids) => ({ id: ids.blockId }),
      body: { isAllDay: true, startDate: '2027-07-01', endDate: '2027-07-01', confirm: true },
    },
  ],
  'DELETE /api/studio/blocks/:id': [{ label: 'their block', params: (ids) => ({ id: ids.blockId }) }],
  'GET /api/studio/bookings/:id': [THEIR_BOOKING],
  'POST /api/studio/bookings/:id/reschedule': [{ ...THEIR_BOOKING, body: { startsAt: '2027-07-05T09:00:00+02:00' } }],
  'POST /api/studio/bookings/:id/cancel': [{ ...THEIR_BOOKING, body: { reason: 'Not mine to cancel' } }],
  'POST /api/studio/bookings/:id/complete': [THEIR_BOOKING],
  'POST /api/studio/bookings/:id/no-show': [THEIR_BOOKING],
  'POST /api/studio/bookings/:id/resend-link': [THEIR_BOOKING],
  'POST /api/studio/bookings/:id/addons': [
    { ...THEIR_BOOKING, label: 'their booking, their add-on', body: (ids) => ({ addonId: ids.sharedAddonId }) },
    { label: 'my booking, their add-on', params: () => ({ id: mine.bookingId }), body: (ids) => ({ addonId: ids.sharedAddonId }) },
  ],
  'DELETE /api/studio/bookings/:id/addons/:addonId': [
    { label: 'their booking and line', params: (ids) => ({ id: ids.bookingId, addonId: ids.bookingAddonId }) },
    { label: 'my booking, their line', params: (ids) => ({ id: mine.bookingId, addonId: ids.bookingAddonId }) },
  ],
  'POST /api/studio/bookings/:id/session-fee': [THEIR_BOOKING],
  'POST /api/studio/bookings/:id/payments/cash': [{ ...THEIR_BOOKING, body: { amountRwf: 1_000 } }],
  'PUT /api/studio/bookings/:id/delivery': [
    { label: 'their completed booking', params: (ids) => ({ id: ids.completedBookingId }), body: { url: 'https://photos.example-host.com/s/mine' } },
  ],
  'POST /api/studio/bookings/:id/delivery/send': [{ label: 'their completed booking', params: (ids) => ({ id: ids.completedBookingId }), body: {} }],
  'POST /api/studio/bookings/:id/notes': [{ ...THEIR_BOOKING, body: { body: 'A note from the wrong studio', email: true } }],
  'DELETE /api/studio/bookings/:id/notes/:noteId': [
    { label: 'their booking and note', params: (ids) => ({ id: ids.bookingId, noteId: ids.noteId }) },
    { label: 'my booking, their note', params: (ids) => ({ id: mine.bookingId, noteId: ids.noteId }) },
  ],
  'POST /api/studio/payments/:id/refund': [{ label: 'their payment', params: (ids) => ({ id: ids.paymentId }), body: { reference: 'MOMO-123456' } }],
  'PATCH /api/studio/services/:id': [{ label: 'their service', params: (ids) => ({ id: ids.serviceId }), body: { nameEn: 'Mine now', isActive: false } }],
  'DELETE /api/studio/services/:id': [{ label: 'their service', params: (ids) => ({ id: ids.serviceId }) }],
  'PATCH /api/studio/packages/:id': [{ label: 'their package', params: (ids) => ({ id: ids.packageId }), body: { priceRwf: 1 } }],
  'DELETE /api/studio/packages/:id': [{ label: 'their package', params: (ids) => ({ id: ids.packageId }) }],
  'PATCH /api/studio/addons/:id': [
    { label: 'their own add-on', params: (ids) => ({ id: ids.ownAddonId }), body: { priceRwf: 1 } },
    { label: 'their shared add-on', params: (ids) => ({ id: ids.sharedAddonId }), body: { isActive: false } },
  ],
  'DELETE /api/studio/addons/:id': [
    { label: 'their own add-on', params: (ids) => ({ id: ids.ownAddonId }) },
    { label: 'their shared add-on', params: (ids) => ({ id: ids.sharedAddonId }) },
  ],
};

/** `/api/studio/bookings/:id/addons/:addonId` with its parameters filled in. */
function fill(path: string, params: Record<string, string>): string {
  return path.replace(/:(\w+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`No value for :${name} in ${path}`);
    return value;
  });
}

/**
 * Every studio operation that takes an id in its path: from the spec, and from
 * the routes the code mounts, so one missing from either still counts.
 */
async function idTakingOperations(): Promise<string[]> {
  const spec = specOperations(await loadSpec()).map((op) => ({ method: op.method, path: op.path }));
  const code = scanRoutes().routes.map((route) => ({ method: route.method, path: route.path }));
  const keys = [...spec, ...code]
    .filter((op) => op.path.startsWith(STUDIO_PREFIX) && op.path.includes('/:'))
    .map((op) => `${op.method.toUpperCase()} ${op.path}`);
  return [...new Set(keys)].sort();
}

const CASES = Object.entries(SWEEP).flatMap(([key, cases]) => cases.map((testCase) => [key, testCase.label, testCase] as const));

// --- The sweep ------------------------------------------------------------------

describe('the sweep covers every id-taking studio route', () => {
  it('has a case for every route in the spec and in the code, and none for a route that is gone', async () => {
    const operations = await idTakingOperations();
    // Not vacuous: the studio has a few dozen of these.
    expect(operations.length).toBeGreaterThan(20);

    const uncovered = operations.filter((key) => (SWEEP[key]?.length ?? 0) === 0);
    const stale = Object.keys(SWEEP).filter((key) => !operations.includes(key));

    expect(uncovered, `studio routes that take an id but are not in the isolation sweep:\n${uncovered.join('\n')}`).toEqual([]);
    expect(stale, `sweep entries for routes that no longer exist:\n${stale.join('\n')}`).toEqual([]);
  });
});

describe('photographer A naming photographer B’s ids (T1.2)', () => {
  it.each(CASES)('%s with %s answers 404 and changes nothing of B’s', async (key, _label, testCase) => {
    const [method, path] = key.split(' ') as [string, string];
    const url = fill(path, testCase.params(theirs));
    const body = typeof testCase.body === 'function' ? testCase.body(theirs) : testCase.body;
    const before = await rowsOf(b.photographerId);
    const outboxBefore = await outboxCount();

    let call = request(app)[method.toLowerCase() as Method](url).set('Authorization', `Bearer ${token}`);
    if (body !== undefined) call = call.send(body);
    const res = await call;

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
    expect(await rowsOf(b.photographerId)).toEqual(before);
    expect(await outboxCount()).toBe(outboxBefore);
  });

  it('answers B’s ids exactly as it answers ids that name nothing', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    const named = await request(app).get(`/api/studio/bookings/${theirs.bookingId}`).set('Authorization', `Bearer ${token}`);
    const nothing = await request(app).get(`/api/studio/bookings/${unknown}`).set('Authorization', `Bearer ${token}`);

    expect([named.status, named.body, named.headers['content-length']]).toEqual([nothing.status, nothing.body, nothing.headers['content-length']]);
  });
});

// --- The lists ------------------------------------------------------------------

describe('A’s lists never hold B’s rows', () => {
  /** Every id and reference of B's that a list could leak. */
  function theirMarks(): string[] {
    return [
      theirs.bookingId,
      theirs.reference,
      theirs.completedBookingId,
      theirs.bookingAddonId,
      theirs.noteId,
      theirs.paymentId,
      theirs.serviceId,
      theirs.packageId,
      theirs.ownAddonId,
      theirs.sharedAddonId,
      theirs.blockId,
      theirs.hoursId,
      'THEIR-NOTE',
      'THEIR-BLOCK',
    ];
  }

  function get(path: string) {
    return request(app).get(path).set('Authorization', `Bearer ${token}`);
  }

  it.each([
    ['the bookings list', '/api/studio/bookings?pageSize=100'],
    ['the bookings list, every stage', '/api/studio/bookings?pageSize=100&stage=confirmed&stage=in_progress&stage=needs_review&stage=completed&stage=closed'],
    ['the calendar', '/api/studio/calendar?from=2027-05-01&to=2027-06-30'],
    ['the blocks', '/api/studio/blocks'],
    ['the working hours', '/api/studio/working-hours'],
    ['the catalogue', '/api/studio/catalogue'],
  ])('%s', async (_label, path) => {
    const res = await get(path);

    expect(res.status).toBe(200);
    for (const mark of theirMarks()) expect(res.text).not.toContain(mark);
  });

  it('and they do hold A’s own, so the checks above are not vacuous', async () => {
    expect((await get('/api/studio/bookings?pageSize=100')).text).toContain(mine.reference);
    expect((await get('/api/studio/calendar?from=2027-05-01&to=2027-06-30')).text).toContain(mine.reference);
    expect((await get('/api/studio/blocks')).text).toContain(mine.blockId);
    expect((await get('/api/studio/working-hours')).text).toContain(mine.hoursId);
    const catalogue = (await get('/api/studio/catalogue')).text;
    for (const id of [a.serviceId, a.packageId, a.ownAddonId, a.sharedAddonId]) expect(catalogue).toContain(id);
  });

  it('never finds B’s booking by searching for it, by reference or by the client both share', async () => {
    for (const search of [theirs.reference, theirs.reference.slice(-5).toLowerCase()]) {
      const res = await get(`/api/studio/bookings?search=${encodeURIComponent(search)}`);
      expect([res.status, (res.body as { total: number }).total]).toEqual([200, 0]);
    }
    // The client row is shared by both photographers: the search finds A's booking only.
    const shared = await get(`/api/studio/bookings?search=${encodeURIComponent('aline.private@example.com')}`);
    expect((shared.body as { bookings: { reference: string }[] }).bookings.map((row) => row.reference)).toEqual([mine.reference]);
  });
});
