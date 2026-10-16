import type { AdminUser, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { issueAdminToken } from '../auth/token.js';
import { findBookingByToken } from '../booking/access.js';
import { clientBookingView } from '../booking/client-view.js';
import { type AdminBooking, adminBookingView, findAdminBooking } from '../booking/admin-view.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  type PaymentWorld,
  CLIENT,
  insertBooking,
  insertBookingWithToken,
  insertPayment,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';

/**
 * `/api/admin/bookings` and `/api/admin/payments/:id/refund` over HTTP (plan.md
 * Task 19; spec §3.6, §6.11, §6.12, §6.16, §6.21, §7), against real PostgreSQL.
 *
 * The behaviour of each action is proven in booking/admin-actions.test.ts and
 * payments/refund.test.ts. What is proven here is the HTTP contract: every
 * route sits behind `requireAdmin`, so no token, a forged one or an expired one
 * is 401 and nothing else; the list's query is parsed by the one admin rule
 * (400 for a malformed request, 422 for a value outside its range) and pages
 * are numbered with a total (2026-09-27); an unknown booking is 404 and a malformed
 * id is 400, not 404; and every answer -- including every refusal -- is the
 * booking as `adminBookingView` renders it. Completing is `409 balance_due`
 * while anything is owed -- "completed" means paid (2026-09-27) -- and the
 * post-shoot add-ons routes are open on a `confirmed` booking whose shoot has
 * begun, and shut once it is `completed`.
 *
 * That last part is the point of the 409s. A screen that acted on a stale view
 * gets back what is true, not only that it was wrong, so it can correct itself
 * without a second request.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let admin: AdminUser;
let token: string;
let clock: Date;
let app: Express;
/** The same app with a payment provider configured (plan.md Task 20). */
let paidApp: Express;

const SECRET = 'admin-bookings-test-secret-at-least-32-characters';
const OTHER_SECRET = 'a-different-secret-that-is-also-at-least-32-chars';
const WEB_ORIGIN = 'https://admin.bookly.example';
/** Long before every fixture shoot (January 2027). */
const START = new Date('2026-10-01T06:00:00Z');
/** After every fixture shoot, for the actions that need one to have started. */
const AFTER_THE_SHOOT = new Date('2027-06-01T06:00:00Z');
const HOUR_MS = 3_600_000;

const BOOKINGS = '/api/admin/bookings';
const UNKNOWN_ID = '3f1b9c2a-0000-4000-8000-00000000abcd';
/** The external host's link, as Task 21's routes take it (spec A-7). */
const DELIVERY_LINK = 'https://photos.example-host.com/s/abc123';

const WEDNESDAY_0900 = new Date('2027-01-06T07:00:00Z');
const WEDNESDAY_1400 = new Date('2027-01-06T12:00:00Z');
const THURSDAY_0900 = new Date('2027-01-07T07:00:00Z');

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
  clock = START;
  world = await seedWorld(prisma);
  admin = await prisma.adminUser.findFirstOrThrow();
  token = (await issueAdminToken(SECRET, admin, START)).token;
  app = createApp({
    corsOrigin: WEB_ORIGIN,
    admin: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock },
  });
  // The same app with a payment provider configured, which is what mounts the
  // session-fee route (plan.md Task 20): without one there is nothing for the
  // client to pay through, so the route does not exist.
  paidApp = createApp({
    corsOrigin: WEB_ORIGIN,
    admin: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock },
    publicApi: { prisma, now: () => clock, payments: { provider: stubProvider(), secret: SECRET } },
  });
});

// --- Helpers ----------------------------------------------------------------------------

function get(path: string, bearer: string | null = token) {
  const call = request(app).get(path);
  return bearer === null ? call : call.set('Authorization', `Bearer ${bearer}`);
}

function post(path: string, body: unknown = {}, bearer: string | null = token) {
  const call = request(app).post(path).send(body as object);
  return bearer === null ? call : call.set('Authorization', `Bearer ${bearer}`);
}

function del(path: string, bearer: string | null = token) {
  const call = request(app).delete(path);
  return bearer === null ? call : call.set('Authorization', `Bearer ${bearer}`);
}

function put(path: string, body: unknown = {}, bearer: string | null = token) {
  const call = request(app).put(path).send(body as object);
  return bearer === null ? call : call.set('Authorization', `Bearer ${bearer}`);
}

/** A POST to the app that has a payment provider, where the session-fee route lives. */
function postPaid(path: string, body: unknown = {}, bearer: string | null = token) {
  const call = request(paidApp).post(path).send(body as object);
  return bearer === null ? call : call.set('Authorization', `Bearer ${bearer}`);
}

/** Moves the injected clock, re-issuing the bearer token so it is still live. */
async function travelTo(at: Date): Promise<void> {
  clock = at;
  token = (await issueAdminToken(SECRET, admin, at)).token;
}

async function adminBooking(id: string): Promise<AdminBooking> {
  const booking = await findAdminBooking(prisma, id);
  if (booking === null) throw new Error('No such booking');
  return booking;
}

/** The booking exactly as the route renders it, for a whole-body comparison. */
async function renderedBooking(id: string, at: Date = clock): Promise<unknown> {
  return JSON.parse(JSON.stringify(adminBookingView(await adminBooking(id), at)));
}

/** A confirmed booking with a live link and a settled booking fee. */
async function confirmedBooking(startsAt: Date = WEDNESDAY_0900) {
  const { booking } = await insertBookingWithToken(prisma, world, { startsAt });
  const payment = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
  return { booking, payment };
}

// --- Authentication ---------------------------------------------------------------------

describe('every route is behind requireAdmin (spec §2.2)', () => {
  async function everyRoute(): Promise<{ label: string; call: (bearer: string | null) => request.Test }[]> {
    const { booking, payment } = await confirmedBooking();
    return [
      { label: 'GET /bookings', call: (bearer) => get(BOOKINGS, bearer) },
      { label: 'GET /bookings/:id', call: (bearer) => get(`${BOOKINGS}/${booking.id}`, bearer) },
      {
        label: 'POST /bookings/:id/reschedule',
        call: (bearer) => post(`${BOOKINGS}/${booking.id}/reschedule`, { startsAt: THURSDAY_0900.toISOString() }, bearer),
      },
      { label: 'POST /bookings/:id/cancel', call: (bearer) => post(`${BOOKINGS}/${booking.id}/cancel`, {}, bearer) },
      { label: 'POST /bookings/:id/complete', call: (bearer) => post(`${BOOKINGS}/${booking.id}/complete`, {}, bearer) },
      { label: 'POST /bookings/:id/no-show', call: (bearer) => post(`${BOOKINGS}/${booking.id}/no-show`, {}, bearer) },
      { label: 'POST /bookings/:id/resend-link', call: (bearer) => post(`${BOOKINGS}/${booking.id}/resend-link`, {}, bearer) },
      // Task 20. The session-fee route is asked of the app that mounts it, so
      // its 401 is the guard's and not the absence of a route.
      {
        label: 'POST /bookings/:id/addons',
        call: (bearer) => post(`${BOOKINGS}/${booking.id}/addons`, { addonId: world.sharedAddonId }, bearer),
      },
      { label: 'DELETE /bookings/:id/addons/:addonId', call: (bearer) => del(`${BOOKINGS}/${booking.id}/addons/${UNKNOWN_ID}`, bearer) },
      { label: 'POST /bookings/:id/notes', call: (bearer) => post(`${BOOKINGS}/${booking.id}/notes`, { body: 'Hello' }, bearer) },
      { label: 'DELETE /bookings/:id/notes/:noteId', call: (bearer) => del(`${BOOKINGS}/${booking.id}/notes/${UNKNOWN_ID}`, bearer) },
      { label: 'POST /bookings/:id/session-fee', call: (bearer) => postPaid(`${BOOKINGS}/${booking.id}/session-fee`, {}, bearer) },
      {
        label: 'POST /bookings/:id/payments/cash',
        call: (bearer) => post(`${BOOKINGS}/${booking.id}/payments/cash`, { amountRwf: 1_000 }, bearer),
      },
      // Task 21.
      {
        label: 'PUT /bookings/:id/delivery',
        call: (bearer) => put(`${BOOKINGS}/${booking.id}/delivery`, { url: DELIVERY_LINK }, bearer),
      },
      { label: 'POST /bookings/:id/delivery/send', call: (bearer) => post(`${BOOKINGS}/${booking.id}/delivery/send`, {}, bearer) },
      {
        label: 'POST /payments/:id/refund',
        call: (bearer) => post(`/api/admin/payments/${payment.id}/refund`, { reference: 'MOMO-1' }, bearer),
      },
    ];
  }

  it('answers 401 with no token at all, and changes nothing', async () => {
    for (const route of await everyRoute()) {
      const res = await route.call(null);
      expect([route.label, res.status, res.body]).toEqual([route.label, 401, { error: 'unauthenticated' }]);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="bookly-admin"');
    }
  });

  it('answers 401 for a token that is not one of ours', async () => {
    const forged = (await issueAdminToken(OTHER_SECRET, admin, START)).token;

    for (const route of await everyRoute()) {
      for (const bearer of ['not-a-jwt', forged]) {
        const res = await route.call(bearer);
        expect([route.label, bearer, res.status]).toEqual([route.label, bearer, 401]);
      }
    }
  });

  it('answers 401 for a token that has expired', async () => {
    const stale = (await issueAdminToken(SECRET, admin, new Date(START.getTime() - 9 * HOUR_MS))).token;

    for (const route of await everyRoute()) {
      const res = await route.call(stale);
      expect([route.label, res.status, res.headers['www-authenticate']]).toEqual([
        route.label,
        401,
        'Bearer realm="bookly-admin", error="invalid_token"',
      ]);
    }
  });

  it('leaves the booking untouched when the token is refused', async () => {
    const { booking } = await confirmedBooking();

    await post(`${BOOKINGS}/${booking.id}/cancel`, { reason: 'nope' }, null);

    expect((await adminBooking(booking.id)).status).toBe('confirmed');
  });

  it('answers 401, not 404, for a path under /api/admin that does not exist', async () => {
    const res = await get('/api/admin/bookings/nope/nope/nope', null);

    expect(res.status).toBe(401);
  });
});

// --- The list ---------------------------------------------------------------------------

describe('GET /bookings', () => {
  it('answers every booking, newest shoot first, as page 1 of 1 with the total', async () => {
    const early = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    const late = await insertBooking(prisma, world, { status: 'confirmed', startsAt: THURSDAY_0900 });

    const res = await get(BOOKINGS);

    expect(res.status).toBe(200);
    expect(res.body.bookings.map((row: { reference: string }) => row.reference)).toEqual([late.reference, early.reference]);
    expect(res.body).toMatchObject({ total: 2, page: 1, pageSize: 25, pageCount: 1 });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('carries each row’s money, derived and not stored', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    const res = await get(BOOKINGS);

    expect(res.body.bookings[0]).toMatchObject({
      reference: booking.reference,
      contactName: CLIENT.name,
      grandTotalRwf: 50_000,
      collectedRwf: 20_000,
      outstandingRwf: 30_000,
      refundDueRwf: 0,
      hasRefundDue: false,
    });
  });

  it('filters by one status', async () => {
    const confirmed = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertBooking(prisma, world, { status: 'cancelled_by_admin', startsAt: THURSDAY_0900 });

    const res = await get(`${BOOKINGS}?status=confirmed`);

    expect(res.body.bookings.map((row: { reference: string }) => row.reference)).toEqual([confirmed.reference]);
  });

  it('takes status repeated, as ?status=a&status=b', async () => {
    const confirmed = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    const cancelled = await insertBooking(prisma, world, { status: 'cancelled_by_admin', startsAt: THURSDAY_0900 });
    await insertBooking(prisma, world, { status: 'expired', startsAt: new Date('2027-01-08T07:00:00Z') });

    const res = await get(`${BOOKINGS}?status=confirmed&status=cancelled_by_admin`);

    expect(res.body.bookings.map((row: { reference: string }) => row.reference).sort()).toEqual(
      [confirmed.reference, cancelled.reference].sort(),
    );
  });

  it('filters by display stage, on the API clock, and stages every row (2026-09-25)', async () => {
    const ahead = await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null, startsAt: WEDNESDAY_0900 });
    // Before START: over, and never marked completed or no-show.
    const unreviewed = await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null, startsAt: new Date('2026-09-01T07:00:00Z') });

    const review = await get(`${BOOKINGS}?stage=needs_review`);
    const both = await get(`${BOOKINGS}?stage=needs_review&stage=confirmed`);

    expect(review.body.bookings.map((row: { reference: string }) => row.reference)).toEqual([unreviewed.reference]);
    expect(review.body.bookings[0].stage).toBe('needs_review');
    expect(both.body.bookings.map((row: { reference: string; stage: string }) => [row.reference, row.stage]).sort()).toEqual(
      [
        [ahead.reference, 'confirmed'],
        [unreviewed.reference, 'needs_review'],
      ].sort(),
    );
  });

  it('refuses a stage it does not know', async () => {
    const res = await get(`${BOOKINGS}?stage=almost_done`);

    expect(res.status).toBe(400);
  });

  it('filters by a Kigali date range, inclusive at both ends', async () => {
    const inside = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertBooking(prisma, world, { status: 'confirmed', startsAt: new Date('2027-01-20T07:00:00Z') });

    const res = await get(`${BOOKINGS}?from=2027-01-06&to=2027-01-06`);

    expect(res.body.bookings.map((row: { reference: string }) => row.reference)).toEqual([inside.reference]);
  });

  it('searches reference, name, email and phone', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await prisma.booking.update({ where: { id: booking.id }, data: { contactName: 'Grace Mukamana' } });
    await insertBooking(prisma, world, { status: 'confirmed', startsAt: THURSDAY_0900 });

    const res = await get(`${BOOKINGS}?search=mukamana`);

    expect(res.body.bookings.map((row: { reference: string }) => row.reference)).toEqual([booking.reference]);
  });

  it('pages by number, with the total and the page count', async () => {
    const early = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    const late = await insertBooking(prisma, world, { status: 'confirmed', startsAt: THURSDAY_0900 });

    const first = await get(`${BOOKINGS}?page=1&pageSize=1`);
    expect(first.body.bookings.map((row: { reference: string }) => row.reference)).toEqual([late.reference]);
    expect(first.body).toMatchObject({ total: 2, page: 1, pageSize: 1, pageCount: 2 });

    const second = await get(`${BOOKINGS}?page=2&pageSize=1`);
    expect(second.body.bookings.map((row: { reference: string }) => row.reference)).toEqual([early.reference]);
    expect(second.body).toMatchObject({ total: 2, page: 2, pageCount: 2 });
  });

  it('answers the last page for a page past the end', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    const res = await get(`${BOOKINGS}?page=7`);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.bookings.map((row: { reference: string }) => row.reference)).toEqual([booking.reference]);
  });

  it.each([
    ['a status outside the vocabulary', 'status=declined', 400],
    ['a malformed date', 'from=2026-13-40', 400],
    ['a date the engine refuses', 'from=0050-01-01', 422],
    ['a page that is not a number', 'page=plenty', 400],
    ['a page of zero', 'page=0', 422],
    ['a page size of zero', 'pageSize=0', 422],
    ['a page size past the maximum', 'pageSize=101', 422],
    ['an unknown query key', 'sort=price', 400],
    ['a search longer than 200 characters', `search=${'x'.repeat(201)}`, 422],
    // Paging is by number since 2026-09-27: a cursor is an unknown key now.
    ['a cursor, which the list no longer takes', 'cursor=abc', 400],
  ])('refuses %s with %s', async (_case, query, status) => {
    const res = await get(`${BOOKINGS}?${query}`);

    expect([res.status, res.body.error]).toEqual([status, status === 400 ? 'invalid_request' : 'validation_failed']);
  });
});

// --- One booking ------------------------------------------------------------------------

describe('GET /bookings/:id', () => {
  it('answers the booking exactly as adminBookingView renders it', async () => {
    const { booking } = await confirmedBooking();

    const res = await get(`${BOOKINGS}/${booking.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ booking: await renderedBooking(booking.id) });
    expect(res.body.booking).toMatchObject({
      id: booking.id,
      reference: booking.reference,
      status: 'confirmed',
      contact: { name: CLIENT.name, email: CLIENT.email, phone: CLIENT.phone },
      actions: { canReschedule: true, canCancel: true, canComplete: false, canMarkNoShow: false, canResendLink: true },
    });
  });

  it('carries the payments, the messages and the money, and never the access token', async () => {
    const { booking } = await confirmedBooking();

    const res = await get(`${BOOKINGS}/${booking.id}`);

    expect(res.body.booking.payments).toHaveLength(1);
    expect(res.body.booking.payments[0]).toMatchObject({ kind: 'booking_fee', status: 'succeeded', canRecordRefund: false });
    expect(res.body.booking.money.totals).toMatchObject({ grandTotalRwf: 50_000, collectedRwf: 20_000, outstandingRwf: 30_000 });
    expect(res.body.booking.access).toMatchObject({ hasLink: true });
    expect(JSON.stringify(res.body)).not.toMatch(/accessToken|access_token|Hash/i);
  });

  it('answers 404 for a booking that does not exist', async () => {
    const res = await get(`${BOOKINGS}/${UNKNOWN_ID}`);

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });

  it('answers 400 for an id that is not a uuid: a malformed request, not a missing row', async () => {
    const res = await get(`${BOOKINGS}/not-a-uuid`);

    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
  });
});

// --- Reschedule --------------------------------------------------------------------------

describe('POST /bookings/:id/reschedule', () => {
  it('moves the booking and answers it at its new time', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/reschedule`, { startsAt: THURSDAY_0900.toISOString() });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ booking: await renderedBooking(booking.id) });
    expect(res.body.booking.schedule).toMatchObject({
      startsAt: THURSDAY_0900.toISOString(),
      originalStartsAt: WEDNESDAY_0900.toISOString(),
      rescheduledAt: START.toISOString(),
    });
  });

  it('accepts a Kigali wall time with its +02:00 offset, as the admin screen sends it', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/reschedule`, { startsAt: '2027-01-07T09:00:00+02:00' });

    expect(res.status).toBe(200);
    expect(res.body.booking.schedule.startsAt).toBe(THURSDAY_0900.toISOString());
  });

  it('answers 409 slot_taken carrying the booking as it still stands', async () => {
    const { booking } = await confirmedBooking();
    await insertBooking(prisma, world, { status: 'confirmed', startsAt: THURSDAY_0900 });

    const res = await post(`${BOOKINGS}/${booking.id}/reschedule`, { startsAt: THURSDAY_0900.toISOString() });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('slot_taken');
    expect(res.body.booking).toStrictEqual(await renderedBooking(booking.id));
    expect(res.body.booking.schedule.startsAt).toBe(WEDNESDAY_0900.toISOString());
  });

  it('answers 409 unchanged for the time the booking already has', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/reschedule`, { startsAt: WEDNESDAY_0900.toISOString() });

    expect([res.status, res.body.error]).toEqual([409, 'unchanged']);
    expect(res.body.booking.schedule.startsAt).toBe(WEDNESDAY_0900.toISOString());
  });

  it('answers 409 not_allowed carrying the booking, so a stale screen corrects itself', async () => {
    const { booking } = await confirmedBooking();
    // Cancelled in another tab while this screen still showed it confirmed.
    await post(`${BOOKINGS}/${booking.id}/cancel`, { reason: 'Studio flooded.' });

    const res = await post(`${BOOKINGS}/${booking.id}/reschedule`, { startsAt: THURSDAY_0900.toISOString() });

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(res.body.booking).toMatchObject({
      status: 'cancelled_by_admin',
      lifecycle: { cancellationReason: 'Studio flooded.' },
      actions: { canReschedule: false, canCancel: false },
    });
  });

  it('answers 404 for a booking that does not exist', async () => {
    const res = await post(`${BOOKINGS}/${UNKNOWN_ID}/reschedule`, { startsAt: THURSDAY_0900.toISOString() });

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });

  it.each([
    ['no body at all', {}],
    ['a startsAt with no offset', { startsAt: '2027-01-07T07:00:00' }],
    ['a startsAt that is not a date', { startsAt: 'tomorrow' }],
    ['a startsAt that is not a string', { startsAt: 1_767_769_200_000 }],
    ['an unknown key beside it', { startsAt: '2027-01-07T07:00:00Z', force: true }],
  ])('refuses %s with 400', async (_case, body) => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/reschedule`, body);

    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
    expect((await adminBooking(booking.id)).startsAt).toStrictEqual(WEDNESDAY_0900);
  });
});

// --- Cancel ------------------------------------------------------------------------------

describe('POST /bookings/:id/cancel', () => {
  it('cancels with a reason and answers the cancelled booking with its refund flagged', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/cancel`, { reason: 'The photographer is unwell.' });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ booking: await renderedBooking(booking.id) });
    expect(res.body.booking).toMatchObject({
      status: 'cancelled_by_admin',
      lifecycle: { cancelledAt: START.toISOString(), cancellationReason: 'The photographer is unwell.' },
      money: { totals: { collectedRwf: 0, refundDueRwf: 20_000, outstandingRwf: 0 } },
    });
    expect(res.body.booking.payments[0]).toMatchObject({ status: 'refund_due', canRecordRefund: true });
  });

  it('cancels with no reason at all', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/cancel`, {});

    expect([res.status, res.body.booking.status]).toEqual([200, 'cancelled_by_admin']);
    expect(res.body.booking.lifecycle.cancellationReason).toBeNull();
  });

  it('takes an explicit null reason', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/cancel`, { reason: null });

    expect([res.status, res.body.booking.lifecycle.cancellationReason]).toEqual([200, null]);
  });

  it('trims the reason before storing it', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/cancel`, { reason: '  Studio flooded.  ' });

    expect(res.body.booking.lifecycle.cancellationReason).toBe('Studio flooded.');
  });

  it('refuses a reason carrying a NUL character, which the text column cannot store', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/cancel`, { reason: `Studio${String.fromCharCode(0)}flooded` });

    expect([res.status, res.body]).toEqual([422, { error: 'validation_failed', fields: ['reason'] }]);
    expect((await adminBooking(booking.id)).status).toBe('confirmed');
  });

  it.each([
    ['an empty reason', { reason: '' }, 422],
    ['a reason that is only whitespace', { reason: '   ' }, 422],
    ['a reason past 1000 characters', { reason: 'x'.repeat(1001) }, 422],
    ['a reason that is not a string', { reason: 42 }, 400],
    ['an unknown key', { reason: 'ok', notify: false }, 400],
  ])('refuses %s', async (_case, body, status) => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/cancel`, body);

    expect(res.status).toBe(status);
    expect((await adminBooking(booking.id)).status).toBe('confirmed');
  });

  it('answers 409 not_allowed with the booking when it is already cancelled', async () => {
    const { booking } = await confirmedBooking();
    await post(`${BOOKINGS}/${booking.id}/cancel`, {});

    const res = await post(`${BOOKINGS}/${booking.id}/cancel`, {});

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(res.body.booking).toStrictEqual(await renderedBooking(booking.id));
  });

  it('answers 404 for a booking that does not exist', async () => {
    const res = await post(`${BOOKINGS}/${UNKNOWN_ID}/cancel`, {});

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });
});

// --- Complete and no-show -------------------------------------------------------------------

describe('POST /bookings/:id/complete and /no-show', () => {
  it.each(['complete', 'no-show'] as const)('answers 409 not_allowed before the shoot has started: %s', async (action) => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/${action}`, {});

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(res.body.booking).toMatchObject({ status: 'confirmed', actions: { canComplete: false, canMarkNoShow: false } });
  });

  it('completes once the shoot has begun and answers the completed booking', async () => {
    const { booking } = await confirmedBooking();
    await travelTo(AFTER_THE_SHOOT);
    // (2026-09-27: completed means paid) settle what confirmedBooking() leaves owing.
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 60 });

    const res = await post(`${BOOKINGS}/${booking.id}/complete`, {});

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ booking: await renderedBooking(booking.id) });
    expect(res.body.booking).toMatchObject({
      status: 'completed',
      lifecycle: { completedAt: AFTER_THE_SHOOT.toISOString() },
      actions: { canReschedule: false, canCancel: false, canComplete: false, canMarkNoShow: false, canResendLink: true },
    });
  });

  it('answers 409 balance_due carrying the booking while the session fee is still owed (2026-09-27: completed means paid)', async () => {
    const { booking } = await confirmedBooking();
    await travelTo(AFTER_THE_SHOOT);

    const res = await post(`${BOOKINGS}/${booking.id}/complete`, {});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('balance_due');
    expect(res.body).toStrictEqual({ error: 'balance_due', booking: await renderedBooking(booking.id) });
    expect(res.body.booking).toMatchObject({ status: 'confirmed', money: { totals: { outstandingRwf: 30_000 } } });
  });

  it('marks a no-show once the shoot has begun, owing nothing further (spec §6.12)', async () => {
    const { booking } = await confirmedBooking();
    await travelTo(AFTER_THE_SHOOT);

    const res = await post(`${BOOKINGS}/${booking.id}/no-show`, {});

    expect(res.status).toBe(200);
    expect(res.body.booking).toMatchObject({
      status: 'no_show',
      lifecycle: { completedAt: null },
      money: { totals: { collectedRwf: 20_000, outstandingRwf: 0, refundDueRwf: 0 } },
    });
    expect(res.body.booking.payments[0]).toMatchObject({ status: 'succeeded' });
  });

  it.each(['complete', 'no-show'] as const)('answers 409 not_allowed for a cancelled booking: %s', async (action) => {
    const { booking } = await confirmedBooking();
    await post(`${BOOKINGS}/${booking.id}/cancel`, {});
    await travelTo(AFTER_THE_SHOOT);

    const res = await post(`${BOOKINGS}/${booking.id}/${action}`, {});

    expect([res.status, res.body.error, res.body.booking.status]).toEqual([409, 'not_allowed', 'cancelled_by_admin']);
  });

  it.each(['complete', 'no-show'] as const)('answers 404 for a booking that does not exist: %s', async (action) => {
    const res = await post(`${BOOKINGS}/${UNKNOWN_ID}/${action}`, {});

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });
});

// --- Resend the link ---------------------------------------------------------------------

describe('POST /bookings/:id/resend-link', () => {
  it('issues a new link and answers the booking with a fresh expiry and no last use', async () => {
    const { booking } = await confirmedBooking();
    const before = await get(`${BOOKINGS}/${booking.id}`);

    const res = await post(`${BOOKINGS}/${booking.id}/resend-link`, {});

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ booking: await renderedBooking(booking.id) });
    expect(res.body.booking.access).toMatchObject({ hasLink: true, lastUsedAt: null });
    expect(res.body.booking.access.expiresAt).not.toBe(before.body.booking.access.expiresAt);
  });

  it('records the message in the booking’s own history, and leaks no token through the API', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/resend-link`, {});

    expect(res.body.booking.messages.map((message: { template: string }) => message.template)).toEqual(['access_link_resend']);
    const queued = await prisma.outbox.findFirstOrThrow({ where: { bookingId: booking.id } });
    const plaintext = (queued.payload as { accessToken: string }).accessToken;
    expect(JSON.stringify(res.body)).not.toContain(plaintext);
  });

  it('answers 409 not_allowed for a booking that was never confirmed', async () => {
    const booking = await insertBooking(prisma, world, { status: 'pending_payment', startsAt: WEDNESDAY_0900 });

    const res = await post(`${BOOKINGS}/${booking.id}/resend-link`, {});

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(res.body.booking).toMatchObject({ actions: { canResendLink: false } });
  });

  it('answers 404 for a booking that does not exist', async () => {
    const res = await post(`${BOOKINGS}/${UNKNOWN_ID}/resend-link`, {});

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });
});

// --- Recording a refund --------------------------------------------------------------------

describe('POST /payments/:id/refund', () => {
  /** A cancelled booking whose booking fee is flagged for refund. */
  async function flagged() {
    const { booking, payment } = await confirmedBooking();
    await post(`${BOOKINGS}/${booking.id}/cancel`, { reason: 'Studio flooded.' });
    return { booking, payment };
  }

  it('records it and answers the booking the payment belongs to', async () => {
    const { booking, payment } = await flagged();

    const res = await post(`/api/admin/payments/${payment.id}/refund`, { reference: 'MOMO-REF-7781' });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ booking: await renderedBooking(booking.id) });
    expect(res.body.booking.payments[0]).toMatchObject({
      status: 'refunded',
      refundReference: 'MOMO-REF-7781',
      refundedAt: START.toISOString(),
      canRecordRefund: false,
    });
    expect(res.body.booking.money.totals).toMatchObject({ refundDueRwf: 0, collectedRwf: 0 });
  });

  it('takes the date the photographer says he sent it', async () => {
    const { payment } = await flagged();

    const res = await post(`/api/admin/payments/${payment.id}/refund`, {
      reference: 'BANK-0001',
      refundedAt: '2026-09-28T16:30:00+02:00',
    });

    expect([res.status, res.body.booking.payments[0].refundedAt]).toEqual([200, '2026-09-28T14:30:00.000Z']);
  });

  it('answers 409 not_refundable carrying the booking, for a payment that is not flagged', async () => {
    const { booking, payment } = await confirmedBooking();

    const res = await post(`/api/admin/payments/${payment.id}/refund`, { reference: 'MOMO-REF-7781' });

    expect([res.status, res.body.error]).toEqual([409, 'not_refundable']);
    expect(res.body.booking).toStrictEqual(await renderedBooking(booking.id));
    expect(res.body.booking.payments[0]).toMatchObject({ status: 'succeeded' });
  });

  it('answers 409 not_refundable on a second recording', async () => {
    const { payment } = await flagged();
    await post(`/api/admin/payments/${payment.id}/refund`, { reference: 'MOMO-REF-7781' });

    const res = await post(`/api/admin/payments/${payment.id}/refund`, { reference: 'ANOTHER' });

    expect([res.status, res.body.error]).toEqual([409, 'not_refundable']);
    expect(res.body.booking.payments[0].refundReference).toBe('MOMO-REF-7781');
  });

  it('answers 404 for a payment that does not exist', async () => {
    const res = await post(`/api/admin/payments/${UNKNOWN_ID}/refund`, { reference: 'MOMO-REF-7781' });

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });

  it('answers 400 for a payment id that is not a uuid', async () => {
    const res = await post('/api/admin/payments/not-a-uuid/refund', { reference: 'MOMO-REF-7781' });

    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
  });

  it.each([
    ['no reference at all', {}, 400],
    ['a reference that is not a string', { reference: 42 }, 400],
    ['an empty reference', { reference: '' }, 422],
    ['a reference of only whitespace', { reference: '   ' }, 422],
    ['a reference past 100 characters', { reference: 'x'.repeat(101) }, 422],
    ['a reference carrying a NUL character', { reference: `MOMO${String.fromCharCode(0)}1` }, 422],
    ['a refundedAt with no offset', { reference: 'MOMO-1', refundedAt: '2026-09-28T16:30:00' }, 400],
    ['an unknown key', { reference: 'MOMO-1', amountRwf: 20_000 }, 400],
  ])('refuses %s and records nothing', async (_case, body, status) => {
    const { payment } = await flagged();

    const res = await post(`/api/admin/payments/${payment.id}/refund`, body);

    expect(res.status).toBe(status);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('refund_due');
  });
});

// --- The shape every answer shares ------------------------------------------------------------

describe('every answer is the same booking shape', () => {
  it('renders the same view from the list’s detail route and from every action', async () => {
    const { booking } = await confirmedBooking(WEDNESDAY_1400);
    const keys = Object.keys(await get(`${BOOKINGS}/${booking.id}`).then((res) => res.body.booking)).sort();

    const answers = [
      await post(`${BOOKINGS}/${booking.id}/reschedule`, { startsAt: THURSDAY_0900.toISOString() }),
      await post(`${BOOKINGS}/${booking.id}/resend-link`, {}),
      await post(`${BOOKINGS}/${booking.id}/cancel`, { reason: 'Studio flooded.' }),
      // And a refusal, which carries the booking too.
      await post(`${BOOKINGS}/${booking.id}/complete`, {}),
    ];

    for (const res of answers) {
      expect([res.status, Object.keys(res.body.booking).sort()]).toEqual([res.status, keys]);
    }
    expect(answers.map((res) => res.status)).toEqual([200, 200, 200, 409]);
  });
});

// --- Post-shoot add-ons (plan.md Task 20) ----------------------------------------------------

/**
 * The HTTP contract of the three post-shoot routes (spec §3.5 steps 2-3,
 * §6.15). What each does is proven in booking/addons.test.ts and
 * payments/session-fee.test.ts; what is proven here is the shape: the body is
 * parsed by the one admin rule (400 for a malformed request, 422 for a value
 * outside its range), an unknown row is 404 and a malformed id is 400, every
 * refusal is a 409 carrying the booking as it now stands, and every success is
 * the whole `adminBookingView`.
 */
describe('POST /bookings/:id/addons', () => {
  /**
   * A confirmed booking whose shoot has begun, with a live link and a settled
   * booking fee: 50,000 owed, 20,000 paid (2026-09-27: add-ons are editable
   * then, not once the booking is `completed`).
   */
  async function shootBegunBooking(startsAt: Date = WEDNESDAY_0900) {
    const { booking } = await confirmedBooking(startsAt);
    await travelTo(AFTER_THE_SHOOT);
    return booking;
  }

  it('adds the add-on and answers the whole booking as adminBookingView renders it', async () => {
    const booking = await shootBegunBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/addons`, { addonId: world.sharedAddonId, quantity: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ booking: await renderedBooking(booking.id) });
    expect(res.body.booking.addons.at(-1)).toMatchObject({
      name: 'Rush edit',
      unitPriceRwf: 5_000,
      quantity: 2,
      amountRwf: 10_000,
      stage: 'post_shoot',
      canRemove: true,
    });
    expect(res.body.booking.money.totals).toMatchObject({ quotedTotalRwf: 50_000, grandTotalRwf: 60_000, outstandingRwf: 40_000 });
  });

  it('defaults the quantity to one when the body leaves it out', async () => {
    const booking = await shootBegunBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/addons`, { addonId: world.ownAddonId });

    expect(res.status).toBe(200);
    expect(res.body.booking.addons.at(-1)).toMatchObject({ quantity: 1, amountRwf: 10_000, stage: 'post_shoot' });
  });

  it.each([
    ['no body at all', {}, 400],
    ['an addonId that is not a uuid', { addonId: 'extra-hour' }, 400],
    ['an addonId that is not a string', { addonId: 42 }, 400],
    ['an unknown key beside it', { addonId: UNKNOWN_ID, note: 'free' }, 400],
    ['a price the caller invented', { addonId: UNKNOWN_ID, amountRwf: 1 }, 400],
    ['a quantity that is not a number', { addonId: UNKNOWN_ID, quantity: 'two' }, 400],
    ['a quantity that is not an integer', { addonId: UNKNOWN_ID, quantity: 1.5 }, 400],
    ['a quantity of zero', { addonId: UNKNOWN_ID, quantity: 0 }, 422],
    ['a negative quantity', { addonId: UNKNOWN_ID, quantity: -1 }, 422],
    ['a quantity of 100', { addonId: UNKNOWN_ID, quantity: 100 }, 422],
  ])('refuses %s and adds nothing', async (_case, body, status) => {
    const booking = await shootBegunBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/addons`, body);

    expect([res.status, res.body.error]).toEqual([status, status === 400 ? 'invalid_request' : 'validation_failed']);
    expect((await adminBooking(booking.id)).addons.filter((addon) => addon.stage === 'post_shoot')).toEqual([]);
  });

  it('answers 404 for a booking that does not exist', async () => {
    const res = await post(`${BOOKINGS}/${UNKNOWN_ID}/addons`, { addonId: world.sharedAddonId });

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });

  it('answers 404 for an add-on that does not exist', async () => {
    const booking = await shootBegunBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/addons`, { addonId: UNKNOWN_ID });

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });

  it('answers 400 for a booking id that is not a uuid: a malformed request, not a missing row', async () => {
    const res = await post(`${BOOKINGS}/not-a-uuid/addons`, { addonId: world.sharedAddonId });

    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
  });

  it('answers 409 not_allowed carrying the booking before the shoot has begun (2026-09-27: add-ons open once it has)', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/addons`, { addonId: world.sharedAddonId });

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(res.body.booking).toStrictEqual(await renderedBooking(booking.id));
    expect(res.body.booking).toMatchObject({ status: 'confirmed', actions: { canEditAddons: false } });
  });

  it('answers 409 not_allowed for an add-on of another service', async () => {
    const booking = await shootBegunBooking();
    const other = await prisma.service.create({ data: { slug: 'weddings', nameEn: 'Weddings' } });
    const theirs = await prisma.addon.create({ data: { serviceId: other.id, nameEn: 'Second shooter', priceRwf: 20_000 } });

    const res = await post(`${BOOKINGS}/${booking.id}/addons`, { addonId: theirs.id });

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(res.body.booking.money.totals.grandTotalRwf).toBe(50_000);
  });
});

describe('DELETE /bookings/:id/addons/:addonId', () => {
  /** A confirmed booking whose shoot has begun, with one post-shoot line already on it. */
  async function shootBegunWithLine(startsAt: Date = WEDNESDAY_0900) {
    const { booking } = await confirmedBooking(startsAt);
    await travelTo(AFTER_THE_SHOOT);
    const added = await post(`${BOOKINGS}/${booking.id}/addons`, { addonId: world.sharedAddonId, quantity: 3 });
    const line = added.body.booking.addons.find((addon: { stage: string }) => addon.stage === 'post_shoot');
    return { booking, lineId: line.id as string };
  }

  it('removes the line and answers the whole booking, both totals down', async () => {
    const { booking, lineId } = await shootBegunWithLine();

    const res = await del(`${BOOKINGS}/${booking.id}/addons/${lineId}`);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ booking: await renderedBooking(booking.id) });
    expect(res.body.booking.addons.map((addon: { stage: string }) => addon.stage)).toEqual(['at_booking']);
    expect(res.body.booking.money.totals).toMatchObject({ grandTotalRwf: 50_000, outstandingRwf: 30_000 });
  });

  it('answers 404 for an add-on row that does not exist', async () => {
    const { booking } = await shootBegunWithLine();

    const res = await del(`${BOOKINGS}/${booking.id}/addons/${UNKNOWN_ID}`);

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });

  it('answers 404 for a line belonging to another booking, and leaves that booking alone', async () => {
    const mine = await shootBegunWithLine();
    const theirs = await shootBegunWithLine(THURSDAY_0900);

    const res = await del(`${BOOKINGS}/${mine.booking.id}/addons/${theirs.lineId}`);

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
    expect((await adminBooking(theirs.booking.id)).addons).toHaveLength(2);
  });

  it.each([
    ['the booking id', (_bookingId: string, lineId: string) => `${BOOKINGS}/not-a-uuid/addons/${lineId}`],
    ['the add-on id', (bookingId: string) => `${BOOKINGS}/${bookingId}/addons/not-a-uuid`],
  ])('answers 400 when %s is not a uuid', async (_case, path) => {
    const { booking, lineId } = await shootBegunWithLine();

    const res = await del(path(booking.id, lineId));

    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
    expect((await adminBooking(booking.id)).addons).toHaveLength(2);
  });

  it('answers 409 not_allowed carrying the booking for an at_booking line', async () => {
    const { booking } = await shootBegunWithLine();
    const quoted = (await adminBooking(booking.id)).addons.find((addon) => addon.stage === 'at_booking');

    const res = await del(`${BOOKINGS}/${booking.id}/addons/${quoted?.id}`);

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(res.body.booking).toStrictEqual(await renderedBooking(booking.id));
    expect(res.body.booking.addons).toHaveLength(2);
  });

  it('answers 409 not_allowed on a booking whose editor is shut', async () => {
    const { booking, lineId } = await shootBegunWithLine();
    // (2026-09-27: add-ons lock once the booking is completed, not before)
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'completed', completedAt: START } });

    const res = await del(`${BOOKINGS}/${booking.id}/addons/${lineId}`);

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(res.body.booking).toMatchObject({ status: 'completed', actions: { canEditAddons: false } });
  });

  it('answers 409 already_paid carrying the booking once the client has paid for it', async () => {
    const { booking, lineId } = await shootBegunWithLine();
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 45_000, ageSeconds: 300 });

    const res = await del(`${BOOKINGS}/${booking.id}/addons/${lineId}`);

    expect([res.status, res.body.error]).toEqual([409, 'already_paid']);
    expect(res.body.booking).toStrictEqual(await renderedBooking(booking.id));
    expect(res.body.booking.money.totals).toMatchObject({ grandTotalRwf: 65_000, collectedRwf: 65_000, outstandingRwf: 0 });
    expect(res.body.booking.addons.every((addon: { canRemove: boolean }) => !addon.canRemove)).toBe(true);
  });
});

describe('POST /bookings/:id/payments/cash (item 7, 2026-09-27)', () => {
  it('records the cash and answers the whole booking, the payment listed as cash with its note', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/payments/cash`, { amountRwf: 30_000, note: 'Paid at the studio.' });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ booking: await renderedBooking(booking.id) });
    expect(res.body.booking.payments.at(-1)).toMatchObject({
      kind: 'session_fee',
      provider: 'cash',
      amountRwf: 30_000,
      status: 'succeeded',
      note: 'Paid at the studio.',
      canRecordRefund: false,
    });
    expect(res.body.booking).toMatchObject({ money: { totals: { outstandingRwf: 0 } }, actions: { canRequestSessionFee: false } });
  });

  it('completes a booking whose shoot has begun once the cash clears it', async () => {
    const { booking } = await confirmedBooking();
    await travelTo(AFTER_THE_SHOOT);

    const res = await post(`${BOOKINGS}/${booking.id}/payments/cash`, { amountRwf: 30_000 });

    expect(res.body.booking).toMatchObject({ status: 'completed', lifecycle: { completedAt: AFTER_THE_SHOOT.toISOString() } });
  });

  it('answers 409 over_outstanding carrying the booking for more than is owed', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/payments/cash`, { amountRwf: 30_001 });

    expect([res.status, res.body.error]).toEqual([409, 'over_outstanding']);
    expect(res.body.booking).toStrictEqual(await renderedBooking(booking.id));
  });

  it('answers 409 in_progress while the client is paying online', async () => {
    const { booking } = await confirmedBooking();
    await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 10 });

    const res = await post(`${BOOKINGS}/${booking.id}/payments/cash`, { amountRwf: 30_000 });

    expect([res.status, res.body.error]).toEqual([409, 'in_progress']);
  });

  it.each([
    ['no amount', {}],
    ['zero', { amountRwf: 0 }],
    ['a fraction', { amountRwf: 10.5 }],
    ['a string', { amountRwf: '30000' }],
    ['an empty note', { amountRwf: 1_000, note: '' }],
    ['a note over 500 characters', { amountRwf: 1_000, note: 'x'.repeat(501) }],
    ['an unknown field', { amountRwf: 1_000, provider: 'mtn_momo_direct' }],
  ])('refuses %s, and writes nothing', async (_case, body) => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/payments/cash`, body);

    expect([400, 422]).toContain(res.status);
    expect(await prisma.payment.count({ where: { bookingId: booking.id, provider: 'cash' } })).toBe(0);
  });

  it('answers 404 for a booking that does not exist', async () => {
    const res = await post(`${BOOKINGS}/${UNKNOWN_ID}/payments/cash`, { amountRwf: 1_000 });

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });
});

describe('POST /bookings/:id/session-fee', () => {
  async function completedBooking() {
    const { booking } = await confirmedBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'completed', completedAt: START } });
    return booking;
  }

  it('opens the request and answers the whole booking, the new payment listed', async () => {
    const booking = await completedBooking();

    const res = await postPaid(`${BOOKINGS}/${booking.id}/session-fee`, {});

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ booking: await renderedBooking(booking.id) });
    expect(res.body.booking.payments.at(-1)).toMatchObject({
      kind: 'session_fee',
      provider: 'mtn_momo_direct',
      amountRwf: 30_000,
      status: 'initiated',
      canRecordRefund: false,
    });
    expect(res.body.booking.messages.map((message: { template: string }) => message.template)).toContain('session_fee_request');
  });

  it('leaks no access token through the API, though the email carries one', async () => {
    const booking = await completedBooking();

    const res = await postPaid(`${BOOKINGS}/${booking.id}/session-fee`, {});

    const queued = await prisma.outbox.findFirstOrThrow({ where: { bookingId: booking.id, template: 'session_fee_request' } });
    const plaintext = (queued.payload as { accessToken: string }).accessToken;
    expect(plaintext).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toContain(plaintext);
  });

  it('answers 409 nothing_to_pay carrying the booking when it is paid in full', async () => {
    const booking = await completedBooking();
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 500 });

    const res = await postPaid(`${BOOKINGS}/${booking.id}/session-fee`, {});

    expect([res.status, res.body.error]).toEqual([409, 'nothing_to_pay']);
    expect(res.body.booking).toStrictEqual(await renderedBooking(booking.id));
    expect(res.body.booking).toMatchObject({ actions: { canRequestSessionFee: false } });
  });

  it('answers 409 not_allowed carrying the booking once it has been cancelled', async () => {
    const booking = await completedBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'cancelled_by_admin', cancelledAt: START } });

    const res = await postPaid(`${BOOKINGS}/${booking.id}/session-fee`, {});

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(res.body.booking).toMatchObject({ status: 'cancelled_by_admin', actions: { canRequestSessionFee: false } });
  });

  it('answers 409 in_progress carrying the booking while the client is paying', async () => {
    const booking = await completedBooking();
    await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 10 });

    const res = await postPaid(`${BOOKINGS}/${booking.id}/session-fee`, {});

    expect([res.status, res.body.error]).toEqual([409, 'in_progress']);
    expect(res.body.booking).toStrictEqual(await renderedBooking(booking.id));
    expect(res.body.booking.payments.filter((payment: { kind: string }) => payment.kind === 'session_fee')).toHaveLength(1);
  });

  it('answers 404 for a booking that does not exist', async () => {
    const res = await postPaid(`${BOOKINGS}/${UNKNOWN_ID}/session-fee`, {});

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });

  it('answers 400 for a booking id that is not a uuid', async () => {
    const res = await postPaid(`${BOOKINGS}/not-a-uuid/session-fee`, {});

    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
  });

  it('does not exist at all where no payment provider is configured', async () => {
    const booking = await completedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/session-fee`, {});

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
    expect(await prisma.payment.count({ where: { bookingId: booking.id, kind: 'session_fee' } })).toBe(0);
    expect(await prisma.outbox.count({ where: { template: 'session_fee_request' } })).toBe(0);
  });
});

// --- The post-shoot journey over HTTP ----------------------------------------------------------

describe('the whole post-shoot sequence (spec §3.5 steps 1-3)', () => {
  it('adds an add-on once the shoot has begun, asks for the new total, and completes once it is settled', async () => {
    // (2026-09-27: add-ons are for a confirmed booking whose shoot has begun,
    // not a completed one, and completing needs nothing left owing.)
    const { booking } = await confirmedBooking();
    await travelTo(AFTER_THE_SHOOT);

    const added = await postPaid(`${BOOKINGS}/${booking.id}/addons`, { addonId: world.sharedAddonId, quantity: 3 });
    expect(added.body.booking).toMatchObject({ status: 'confirmed', actions: { canEditAddons: true } });
    expect(added.body.booking.money.totals).toMatchObject({ grandTotalRwf: 65_000, outstandingRwf: 45_000 });

    const asked = await postPaid(`${BOOKINGS}/${booking.id}/session-fee`, {});
    expect(asked.status).toBe(200);
    expect(asked.body.booking.payments.at(-1)).toMatchObject({ kind: 'session_fee', amountRwf: 45_000, status: 'initiated' });

    // Settling stands in for what a webhook would do elsewhere, so completion
    // can be proven on its own.
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 45_000, ageSeconds: 60 });

    const completed = await postPaid(`${BOOKINGS}/${booking.id}/complete`, {});
    expect(completed.status).toBe(200);
    expect(completed.body.booking).toMatchObject({
      status: 'completed',
      actions: { canEditAddons: false, canRequestSessionFee: false },
    });

    // Every answer along the way is the same booking shape.
    const keys = Object.keys(completed.body.booking).sort();
    for (const res of [added, asked]) expect(Object.keys(res.body.booking).sort()).toEqual(keys);
  });
});

// --- A price and a quantity the column cannot hold ---------------------------------------------

describe('POST /bookings/:id/addons with a product larger than an integer', () => {
  /** The ceiling the catalogue itself allows for an add-on price (routes/validation.ts). */
  const INT4_MAX = 2_147_483_647;

  /**
   * The catalogue accepts a price up to `INT4_MAX` and the editor a quantity up
   * to 99, so a legal pair can multiply past what `booking_addon.amount_rwf`
   * holds. That is a value outside its rules, and the rule of this API is that
   * such a value is answered, never left to surface as a 500 from the database
   * (routes/validation.ts).
   */
  it('answers a 4xx rather than a 500', async () => {
    const { booking } = await confirmedBooking();
    // (2026-09-27: add-ons are for a confirmed booking whose shoot has begun)
    await travelTo(AFTER_THE_SHOOT);
    const expensive = await prisma.addon.create({
      data: { serviceId: world.serviceId, nameEn: 'A price the catalogue allows', priceRwf: INT4_MAX },
    });

    const res = await post(`${BOOKINGS}/${booking.id}/addons`, { addonId: expensive.id, quantity: 2 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'too_large' });
    // And the refusal carries the booking, as every other refusal does.
    expect(res.body.booking.addons.filter((a: { stage: string }) => a.stage === 'post_shoot')).toEqual([]);
  });
});

// --- Asking before the shoot has happened ---------------------------------------------------

/**
 * Tested as the code behaves, and flagged rather than "fixed". Spec §3.5 runs
 * complete → add-ons → request, and plan.md Task 20 frames the session fee as
 * the post-shoot half. `adminBookingView` gates the button on
 * `outstandingRwf > 0 && (confirmed || completed)` with no reference to the
 * shoot date, so a booking confirmed months in advance already offers
 * "Request … session fee" -- and the route grants it.
 *
 * That agrees with the client's own side, which lets a `confirmed` booking pay
 * its session fee (payments/initiate.ts, spec §3.9), so it may well be intended.
 * It is recorded here so the disagreement with §3.5's sequence is visible.
 */
describe('the session fee before the shoot', () => {
  it('is offered and granted on a booking whose shoot is still months away', async () => {
    const { booking } = await confirmedBooking();
    // The clock is October 2026; the shoot is January 2027.
    const before = await get(`${BOOKINGS}/${booking.id}`);
    expect(before.body.booking).toMatchObject({
      status: 'confirmed',
      actions: { canComplete: false, canEditAddons: false, canRequestSessionFee: true },
    });

    const res = await postPaid(`${BOOKINGS}/${booking.id}/session-fee`, {});

    expect(res.status).toBe(200);
    expect(res.body.booking.payments.at(-1)).toMatchObject({ kind: 'session_fee', amountRwf: 30_000, status: 'initiated' });
  });

  it('is not offered on a booking still waiting for its booking fee', async () => {
    const booking = await insertBooking(prisma, world, { status: 'pending_payment', startsAt: THURSDAY_0900 });

    const res = await postPaid(`${BOOKINGS}/${booking.id}/session-fee`, {});

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(res.body.booking).toMatchObject({ actions: { canRequestSessionFee: false } });
  });
});

// --- Photo delivery (plan.md Task 21) -----------------------------------------------------------

/**
 * The HTTP contract of the two delivery routes (spec §3.5 steps 5-7, §6.20,
 * A-7, A-8). What each does is proven in booking/delivery.test.ts; what is
 * proven here is the shape: the body is parsed by the one admin rule (400 for a
 * malformed request, 422 for a value outside its rules), an unknown booking is
 * 404 and a malformed id is 400, every refusal is a 409 carrying the booking as
 * it now stands, and every success is the whole `adminBookingView` with the
 * delivery block and the two new action flags on it.
 */
describe('PUT /bookings/:id/delivery', () => {
  /** A completed shoot with a live link and a settled booking fee. */
  async function completedBooking() {
    const { booking } = await confirmedBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'completed', completedAt: START } });
    return booking;
  }

  it('saves the link and answers the whole booking as adminBookingView renders it', async () => {
    const booking = await completedBooking();

    const res = await put(`${BOOKINGS}/${booking.id}/delivery`, { url: DELIVERY_LINK, note: 'Thank you!' });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ booking: await renderedBooking(booking.id) });
    expect(res.body.booking.delivery).toStrictEqual({
      url: DELIVERY_LINK,
      // START is 1 October 2026 in Kigali; spec A-8's ninety days land here.
      expiresOn: '2026-12-30',
      sentAt: null,
      note: 'Thank you!',
    });
    expect(res.body.booking.actions).toMatchObject({ canEditDelivery: true, canSendDelivery: true });
  });

  it('takes the date he typed, and leaves the note out when the body omits it', async () => {
    const booking = await completedBooking();

    const res = await put(`${BOOKINGS}/${booking.id}/delivery`, { url: DELIVERY_LINK, expiresOn: '2027-03-15' });

    expect(res.status).toBe(200);
    expect(res.body.booking.delivery).toMatchObject({ expiresOn: '2027-03-15', note: null });
  });

  it('clears the note when the body sends null for it', async () => {
    const booking = await completedBooking();
    await put(`${BOOKINGS}/${booking.id}/delivery`, { url: DELIVERY_LINK, note: 'Thank you!' });

    const res = await put(`${BOOKINGS}/${booking.id}/delivery`, { url: DELIVERY_LINK, note: null });

    expect(res.status).toBe(200);
    expect(res.body.booking.delivery.note).toBeNull();
  });

  it('sends nothing: saving a link is not writing to the client', async () => {
    const booking = await completedBooking();

    await put(`${BOOKINGS}/${booking.id}/delivery`, { url: DELIVERY_LINK });

    expect(await prisma.outbox.count({ where: { template: 'photo_delivery' } })).toBe(0);
    expect((await adminBooking(booking.id)).deliverySentAt).toBeNull();
  });

  it.each([
    ['no body at all', {}, 400],
    ['a url that is not a URL at all', { url: 'photos.example-host.com/s/abc' }, 400],
    ['a url that is not a string', { url: 42 }, 400],
    ['an unknown key beside it', { url: DELIVERY_LINK, host: 'Drive' }, 400],
    ['an expiresOn that is not a date at all', { url: DELIVERY_LINK, expiresOn: '01-01-2027' }, 400],
    ['an expiresOn that is an instant', { url: DELIVERY_LINK, expiresOn: '2027-01-01T00:00:00Z' }, 400],
    ['an expiresOn that is not a string', { url: DELIVERY_LINK, expiresOn: 20_270_101 }, 400],
    ['a note that is not a string', { url: DELIVERY_LINK, note: 42 }, 400],
    ['a plain http link', { url: 'http://photos.example-host.com/s/abc' }, 422],
    ['a javascript: link', { url: 'javascript:alert(1)' }, 422],
    ['an ftp link', { url: 'ftp://photos.example-host.com/s/abc' }, 422],
    ['a year the engine refuses', { url: DELIVERY_LINK, expiresOn: '0050-01-01' }, 422],
    ['an empty note', { url: DELIVERY_LINK, note: '   ' }, 422],
  ])('refuses %s and saves nothing', async (_case, body, status) => {
    const booking = await completedBooking();

    const res = await put(`${BOOKINGS}/${booking.id}/delivery`, body);

    expect([res.status, res.body.error]).toEqual([status, status === 400 ? 'invalid_request' : 'validation_failed']);
    expect((await adminBooking(booking.id)).deliveryUrl).toBeNull();
  });

  it('refuses a URL longer than the column allows, naming the field', async () => {
    const booking = await completedBooking();
    const tooLong = `https://photos.example-host.com/s/${'a'.repeat(2_000)}`;
    expect(tooLong.length).toBeGreaterThan(2_000);

    const res = await put(`${BOOKINGS}/${booking.id}/delivery`, { url: tooLong });

    expect([res.status, res.body.error]).toEqual([422, 'validation_failed']);
    expect(res.body.fields).toEqual(['url']);
    expect((await adminBooking(booking.id)).deliveryUrl).toBeNull();
  });

  it('takes a URL right on the length cap', async () => {
    const booking = await completedBooking();
    const head = 'https://photos.example-host.com/s/';
    const exactly = head + 'a'.repeat(2_000 - head.length);

    const res = await put(`${BOOKINGS}/${booking.id}/delivery`, { url: exactly });

    expect(res.status).toBe(200);
    expect(res.body.booking.delivery.url).toBe(exactly);
  });

  it('answers 404 for a booking that does not exist', async () => {
    const res = await put(`${BOOKINGS}/${UNKNOWN_ID}/delivery`, { url: DELIVERY_LINK });

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });

  it('answers 400 for a booking id that is not a uuid: a malformed request, not a missing row', async () => {
    const res = await put(`${BOOKINGS}/not-a-uuid/delivery`, { url: DELIVERY_LINK });

    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
  });

  it('answers 409 not_allowed carrying the booking when the shoot is not completed', async () => {
    const { booking } = await confirmedBooking();

    const res = await put(`${BOOKINGS}/${booking.id}/delivery`, { url: DELIVERY_LINK });

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(res.body.booking).toStrictEqual(await renderedBooking(booking.id));
    expect(res.body.booking).toMatchObject({
      status: 'confirmed',
      delivery: { url: null, expiresOn: null, sentAt: null, note: null },
      actions: { canEditDelivery: false, canSendDelivery: false },
    });
  });

  /**
   * The schema reads the scheme through `new URL()`, so `HTTPS://` parses as
   * https; the column's CHECK is the literal regex `^https://`, which does not.
   * A link that is https by every reasonable reading is therefore stored in the
   * spelling the column insists on, rather than handed back as a 422 for a rule
   * it does not break -- or, worse, reaching the CHECK as a 500
   * (routes/validation.ts).
   */
  it('normalises a scheme the CHECK spells differently, rather than answering 500', async () => {
    const booking = await completedBooking();

    const res = await put(`${BOOKINGS}/${booking.id}/delivery`, { url: 'HTTPS://photos.example-host.com/s/abc123' });

    expect(res.status).toBe(200);
    expect(res.body.booking.delivery.url).toBe('https://photos.example-host.com/s/abc123');
    expect((await adminBooking(booking.id)).deliveryUrl).toBe('https://photos.example-host.com/s/abc123');
  });
});

describe('POST /bookings/:id/delivery/send', () => {
  async function completedBooking() {
    const { booking } = await confirmedBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'completed', completedAt: START } });
    return booking;
  }

  async function withLink() {
    const booking = await completedBooking();
    const saved = await put(`${BOOKINGS}/${booking.id}/delivery`, {
      url: DELIVERY_LINK,
      expiresOn: '2027-01-01',
      note: 'Thank you!',
    });
    expect(saved.status).toBe(200);
    return booking;
  }

  it('sends the email and answers the whole booking, now stamped', async () => {
    const booking = await withLink();

    const res = await post(`${BOOKINGS}/${booking.id}/delivery/send`, {});

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ booking: await renderedBooking(booking.id) });
    expect(res.body.booking.delivery).toStrictEqual({
      url: DELIVERY_LINK,
      expiresOn: '2027-01-01',
      sentAt: START.toISOString(),
      note: 'Thank you!',
    });
    expect(res.body.booking.messages.map((message: { template: string }) => message.template)).toContain('photo_delivery');
  });

  it('puts the link and the expiry on the outbox, addressed to the client', async () => {
    const booking = await withLink();

    await post(`${BOOKINGS}/${booking.id}/delivery/send`, {});

    const queued = await prisma.outbox.findFirstOrThrow({ where: { bookingId: booking.id, template: 'photo_delivery' } });
    expect(queued.recipient).toBe(CLIENT.email);
    expect(queued.payload).toMatchObject({ deliveryUrl: DELIVERY_LINK, expiresOn: '2027-01-01' });
  });

  it('sends to another address for this one email when given, leaving the booking’s own email alone (2026-09-25)', async () => {
    const booking = await withLink();

    const res = await post(`${BOOKINGS}/${booking.id}/delivery/send`, { recipient: '  Other.Address@Example.com ' });

    expect(res.status, res.text).toBe(200);
    const queued = await prisma.outbox.findFirstOrThrow({ where: { bookingId: booking.id, template: 'photo_delivery' } });
    expect(queued.recipient).toBe('Other.Address@Example.com');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).contactEmail).toBe(CLIENT.email);
    expect(res.body.booking.contact.email).toBe(CLIENT.email);
    expect(res.body.booking.messages).toContainEqual(expect.objectContaining({ template: 'photo_delivery', recipient: 'Other.Address@Example.com' }));
  });

  it('sends to the client with no body at all, as before', async () => {
    const booking = await withLink();

    const res = await request(app).post(`${BOOKINGS}/${booking.id}/delivery/send`).set('Authorization', `Bearer ${token}`);

    expect(res.status, res.text).toBe(200);
    const queued = await prisma.outbox.findFirstOrThrow({ where: { bookingId: booking.id, template: 'photo_delivery' } });
    expect(queued.recipient).toBe(CLIENT.email);
  });

  it.each([['not an email', 'not-an-email'], ['empty', '   '], ['too long', `${'a'.repeat(250)}@example.com`]])(
    'answers 422 for a recipient that is %s, and sends nothing',
    async (_label, recipient) => {
      const booking = await withLink();

      const res = await post(`${BOOKINGS}/${booking.id}/delivery/send`, { recipient });

      expect([res.status, res.body]).toEqual([422, { error: 'validation_failed', fields: ['recipient'] }]);
      expect(await prisma.outbox.count({ where: { template: 'photo_delivery' } })).toBe(0);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).deliverySentAt).toBeNull();
    },
  );

  it('refuses fields it does not know, sending nothing', async () => {
    const booking = await withLink();

    const res = await post(`${BOOKINGS}/${booking.id}/delivery/send`, { recipient: 'a@example.com', contactEmail: 'b@example.com' });

    expect(res.status).toBe(400);
    expect(await prisma.outbox.count({ where: { template: 'photo_delivery' } })).toBe(0);
  });

  it('answers 409 no_link carrying the booking when nothing has been saved', async () => {
    const booking = await completedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/delivery/send`, {});

    expect([res.status, res.body.error]).toEqual([409, 'no_link']);
    expect(res.body.booking).toStrictEqual(await renderedBooking(booking.id));
    expect(res.body.booking.actions).toMatchObject({ canEditDelivery: true, canSendDelivery: false });
    expect(await prisma.outbox.count({ where: { template: 'photo_delivery' } })).toBe(0);
  });

  it('answers 409 not_allowed carrying the booking once it has been cancelled', async () => {
    const booking = await withLink();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'cancelled_by_admin', cancelledAt: START } });

    const res = await post(`${BOOKINGS}/${booking.id}/delivery/send`, {});

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(res.body.booking).toMatchObject({
      status: 'cancelled_by_admin',
      actions: { canEditDelivery: false, canSendDelivery: false },
    });
    expect(await prisma.outbox.count({ where: { template: 'photo_delivery' } })).toBe(0);
  });

  it('answers 404 for a booking that does not exist', async () => {
    const res = await post(`${BOOKINGS}/${UNKNOWN_ID}/delivery/send`, {});

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });

  it('answers 400 for a booking id that is not a uuid', async () => {
    const res = await post(`${BOOKINGS}/not-a-uuid/delivery/send`, {});

    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
  });

  it('sends again on a second call, a second message with its own key (spec §6.20)', async () => {
    const booking = await withLink();

    await post(`${BOOKINGS}/${booking.id}/delivery/send`, {});
    await travelTo(new Date(START.getTime() + HOUR_MS));
    const again = await post(`${BOOKINGS}/${booking.id}/delivery/send`, {});

    expect(again.status).toBe(200);
    const queued = await prisma.outbox.findMany({ where: { bookingId: booking.id, template: 'photo_delivery' } });
    expect(queued).toHaveLength(2);
    expect(new Set(queued.map((row) => row.dedupeKey)).size).toBe(2);
    expect(again.body.booking.delivery.sentAt).toBe(new Date(START.getTime() + HOUR_MS).toISOString());
  });
});

// --- The delivery half of the post-shoot journey, over HTTP ----------------------------------------

describe('the whole delivery sequence (spec §3.5 steps 5-7)', () => {
  it('completes the shoot, saves the link, sends it, and never reports a download count', async () => {
    const { booking } = await confirmedBooking();
    await travelTo(AFTER_THE_SHOOT);
    // (2026-09-27: completed means paid) settle what confirmedBooking() leaves owing.
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 60 });

    const completed = await post(`${BOOKINGS}/${booking.id}/complete`, {});
    expect(completed.status).toBe(200);
    expect(completed.body.booking.actions).toMatchObject({ canEditDelivery: true, canSendDelivery: false });

    const saved = await put(`${BOOKINGS}/${booking.id}/delivery`, { url: DELIVERY_LINK });
    expect(saved.body.booking.actions).toMatchObject({ canEditDelivery: true, canSendDelivery: true });
    expect(saved.body.booking.delivery.sentAt).toBeNull();

    const sent = await post(`${BOOKINGS}/${booking.id}/delivery/send`, {});
    expect(sent.status).toBe(200);
    expect(sent.body.booking.delivery.sentAt).toBe(AFTER_THE_SHOOT.toISOString());

    // Every answer along the way is the same booking shape.
    const keys = Object.keys(completed.body.booking).sort();
    for (const res of [saved, sent]) expect(Object.keys(res.body.booking).sort()).toEqual(keys);

    // plan.md Task 21: no download count exists -- the files sit on someone
    // else's host (A-7), so the site cannot know (data-model_v2.md §5.9).
    expect(JSON.stringify(sent.body)).not.toMatch(/download/i);
    expect(Object.keys(sent.body.booking.delivery).sort()).toEqual(['expiresOn', 'note', 'sentAt', 'url']);
  });

  it('offers no route that would report one', async () => {
    const { booking } = await confirmedBooking();

    for (const path of [`${BOOKINGS}/${booking.id}/delivery`, `${BOOKINGS}/${booking.id}/delivery/downloads`]) {
      const res = await get(path);
      expect([path, res.status]).toEqual([path, 404]);
    }
  });
});

// --- Notes to the client (2026-09-25) -----------------------------------------------------

describe('notes to the client', () => {
  it('adds a note, emails it by default, and answers the booking with it', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/notes`, { body: 'Bring a jacket.\nIt gets cold.' });

    expect(res.status, res.text).toBe(200);
    expect(res.body.booking.notes).toEqual([{ id: expect.any(String), body: 'Bring a jacket.\nIt gets cold.', emailed: true, createdAt: START.toISOString() }]);
    const sent = await prisma.outbox.findMany({ where: { template: 'client_note' } });
    expect(sent.map((row) => [row.recipient, (row.payload as { body: string }).body])).toEqual([[CLIENT.email, 'Bring a jacket.\nIt gets cold.']]);
  });

  it('keeps it to the page when the photographer unticks the email', async () => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/notes`, { body: 'Just so you know.', email: false });

    expect(res.body.booking.notes[0]).toMatchObject({ emailed: false });
    expect(await prisma.outbox.count({ where: { template: 'client_note' } })).toBe(0);
  });

  it.each([
    ['empty', { body: '' }, 422],
    ['over 1000 characters', { body: 'x'.repeat(1001) }, 422],
    ['missing', {}, 400],
    ['carrying another field', { body: 'Hi', bookingId: 'x' }, 400],
  ])('refuses a note that is %s, adding nothing', async (_label, body, status) => {
    const { booking } = await confirmedBooking();

    const res = await post(`${BOOKINGS}/${booking.id}/notes`, body);

    expect(res.status).toBe(status);
    expect(await prisma.bookingNote.count()).toBe(0);
  });

  it('takes exactly 1000 characters', async () => {
    const { booking } = await confirmedBooking();

    expect((await post(`${BOOKINGS}/${booking.id}/notes`, { body: 'x'.repeat(1000), email: false })).status).toBe(200);
  });

  it('refuses a booking no client was ever confirmed on, and one that does not exist', async () => {
    const waiting = await insertBooking(prisma, world, { status: 'pending_payment', startsAt: WEDNESDAY_0900 });

    expect([(await post(`${BOOKINGS}/${waiting.id}/notes`, { body: 'Hi' })).status, (await post(`${BOOKINGS}/${UNKNOWN_ID}/notes`, { body: 'Hi' })).status]).toEqual([409, 404]);
    expect(await prisma.bookingNote.count()).toBe(0);
  });

  it('deletes a note: gone from both pages, kept in the table, and a second delete is a 404', async () => {
    const { booking, token: clientToken } = await insertBookingWithToken(prisma, world, { startsAt: WEDNESDAY_0900 });
    const added = await post(`${BOOKINGS}/${booking.id}/notes`, { body: 'Withdrawn soon.', email: false });
    const noteId = added.body.booking.notes[0].id as string;

    const res = await del(`${BOOKINGS}/${booking.id}/notes/${noteId}`);

    expect(res.status, res.text).toBe(200);
    expect(res.body.booking.notes).toEqual([]);
    expect((await prisma.bookingNote.findUniqueOrThrow({ where: { id: noteId } })).deletedAt).toEqual(START);
    const accessed = await findBookingByToken(prisma, clientToken);
    expect(clientBookingView(accessed as NonNullable<typeof accessed>, START).notices).toEqual([]);
    expect((await del(`${BOOKINGS}/${booking.id}/notes/${noteId}`)).status).toBe(404);
  });

  it('will not delete a note through another booking', async () => {
    const { booking } = await confirmedBooking();
    const other = await confirmedBooking(THURSDAY_0900);
    const added = await post(`${BOOKINGS}/${booking.id}/notes`, { body: 'Mine.', email: false });

    const res = await del(`${BOOKINGS}/${other.booking.id}/notes/${added.body.booking.notes[0].id as string}`);

    expect(res.status).toBe(404);
    expect(await prisma.bookingNote.count({ where: { deletedAt: null } })).toBe(1);
  });

  it('shows the note on the client\u2019s page, among notices that carry no token', async () => {
    const { booking, token: clientToken } = await insertBookingWithToken(prisma, world, { startsAt: WEDNESDAY_0900 });
    await post(`${BOOKINGS}/${booking.id}/notes`, { body: 'See you soon.' });
    await post(`${BOOKINGS}/${booking.id}/resend-link`, {});

    const accessed = await findBookingByToken(prisma, clientToken);
    const fresh = await prisma.outbox.findFirstOrThrow({ where: { template: 'access_link_resend' } });
    const view = clientBookingView(
      (await findBookingByToken(prisma, (fresh.payload as { accessToken: string }).accessToken)) ?? (accessed as NonNullable<typeof accessed>),
      START,
    );

    expect(view.notices.map((notice) => notice.kind)).toEqual(['note']);
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain((fresh.payload as { accessToken: string }).accessToken);
    expect(serialised).not.toContain(clientToken);
  });
});
