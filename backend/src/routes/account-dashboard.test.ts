import type { AppUser, Booking, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT_PAGE_SIZE } from '../account/bookings.js';
import { createApp } from '../app.js';
import { upsertClient } from '../booking/client.js';
import { bookingTotals } from '../booking/totals.js';
import { createPrismaClient } from '../db/client.js';
import { verifyCheckoutToken } from '../payments/checkout-link.js';
import { accountToken, createClientAccount } from '../test/account-fixtures.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  CLIENT,
  type PaymentWorld,
  PHOTOGRAPHER_HANDLE,
  PHOTOGRAPHER_NAME,
  SECOND_PHOTOGRAPHER_HANDLE,
  TEST_SECRET,
  type StubProvider,
  grantAccessToken,
  insertBooking,
  insertPayment,
  routeTo,
  seedSecondPhotographer,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';

/**
 * The client dashboard's reads and its booking actions over HTTP
 * (marketplace-spec.md Phase 8: R8.1, R8.2, R8.4; units B1-B4, B7, B9; T8.2,
 * T8.4). The credential routes (password, address, deletion) are in
 * account-credentials.test.ts, the isolation sweep in account-isolation.test.ts.
 *
 * The world: photographers A (`kigali-lens`) and B (`hills-and-light`), the
 * client row both share (CLIENT.email), and the verified account X with that
 * address, so every booking on that row is X's. Account Y has a client row and
 * bookings of its own, which X must never see.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let a: PaymentWorld;
let b: PaymentWorld;
let x: AppUser;
let y: AppUser;
let yWorld: PaymentWorld;
let provider: StubProvider;
let tokenX: string;

/** Monday 1 June 2027, 08:00 in Kigali. */
const NOW = new Date('2027-06-01T06:00:00Z');
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const Y_EMAIL = 'yvonne.other@example.com';

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
  x = await createClientAccount(prisma, { email: CLIENT.email, fullName: 'Aline Uwase' });
  const yClient = await prisma.client.create({ data: { fullName: 'Yvonne Other', email: Y_EMAIL, phone: '+250788999000' } });
  yWorld = { ...a, clientId: yClient.id };
  y = await createClientAccount(prisma, { email: Y_EMAIL, fullName: 'Yvonne Other' });
  provider = stubProvider();
  tokenX = await accountToken(TEST_SECRET, prisma, x.id, NOW);
});

function app(options: { payments?: boolean; now?: Date } = {}): Express {
  const now = options.now ?? NOW;
  return createApp({
    auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: 'https://bookly.example', now: () => now },
    publicApi: {
      prisma,
      now: () => now,
      ...(options.payments === false ? {} : { payments: { routing: routeTo(provider), secret: TEST_SECRET } }),
    },
  });
}

function get(path: string, token = tokenX, server = app()) {
  return request(server).get(path).set('Authorization', `Bearer ${token}`);
}

function post(path: string, body: object = {}, token = tokenX, server = app()) {
  return request(server).post(path).set('Authorization', `Bearer ${token}`).send(body);
}

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

type Row = { reference: string; status: string; stage: string; photographer: { handle: string; displayName: string }; checkoutPath: string | null; holdExpiresAt: string | null; amounts: Record<string, number> };

function references(body: unknown): string[] {
  return (body as { bookings: Row[] }).bookings.map((row) => row.reference);
}

// --- B1: the bookings list ------------------------------------------------------------

describe('GET /api/account/bookings (B1, R8.1)', () => {
  /** One booking of X's in every situation the two lists sort, with A and B. */
  async function everySituation() {
    const s = {
      soonB: await insertBooking(prisma, b, { status: 'confirmed', startsAt: at(2 * DAY_MS) }),
      laterA: await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(9 * DAY_MS) }),
      inProgress: await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(-HOUR_MS) }),
      hold: await insertBooking(prisma, a, { status: 'pending_payment', startsAt: at(5 * DAY_MS) }),
      lapsedHold: await insertBooking(prisma, b, { status: 'pending_payment', holdMinutes: -5, startsAt: at(6 * DAY_MS) }),
      expired: await insertBooking(prisma, a, { status: 'expired', startsAt: at(7 * DAY_MS) }),
      overUnmarked: await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(-3 * DAY_MS) }),
      completed: await insertBooking(prisma, b, { status: 'completed', startsAt: at(-10 * DAY_MS) }),
      noShow: await insertBooking(prisma, a, { status: 'no_show', startsAt: at(-20 * DAY_MS) }),
      cancelledFuture: await insertBooking(prisma, a, { status: 'cancelled_by_client', startsAt: at(12 * DAY_MS) }),
      cancelledByPhotographer: await insertBooking(prisma, b, { status: 'cancelled_by_photographer', startsAt: at(-5 * DAY_MS) }),
      cancelledByPlatform: await insertBooking(prisma, a, { status: 'cancelled_by_platform', startsAt: at(-6 * DAY_MS) }),
    };
    return s;
  }

  it('upcoming: confirmed not yet over and live holds, across photographers, soonest first', async () => {
    const s = await everySituation();
    const res = await get('/api/account/bookings?scope=upcoming');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(references(res.body)).toEqual([s.inProgress, s.soonB, s.hold, s.laterA].map((booking) => booking.reference));
    expect(res.body).toMatchObject({ scope: 'upcoming', total: 4, page: 1, pageSize: ACCOUNT_PAGE_SIZE, pageCount: 1 });
    const rows = (res.body as { bookings: Row[] }).bookings;
    expect(rows.map((row) => row.photographer)).toEqual([
      { handle: PHOTOGRAPHER_HANDLE, displayName: PHOTOGRAPHER_NAME },
      { handle: SECOND_PHOTOGRAPHER_HANDLE, displayName: 'Hills & Light' },
      { handle: PHOTOGRAPHER_HANDLE, displayName: PHOTOGRAPHER_NAME },
      { handle: PHOTOGRAPHER_HANDLE, displayName: PHOTOGRAPHER_NAME },
    ]);
    expect(rows.map((row) => row.stage)).toEqual(['in_progress', 'confirmed', 'awaiting_payment', 'confirmed']);
  });

  it('past: completed, no-show, every cancellation and a shoot over but unmarked, latest first', async () => {
    const s = await everySituation();
    const res = await get('/api/account/bookings?scope=past');

    expect(res.status).toBe(200);
    expect(references(res.body)).toEqual(
      [s.cancelledFuture, s.overUnmarked, s.cancelledByPhotographer, s.cancelledByPlatform, s.completed, s.noShow].map((booking) => booking.reference),
    );
    // The client never sees `needs_review`: an unmarked shoot is `completed` to them.
    const stages = Object.fromEntries((res.body as { bookings: Row[] }).bookings.map((row) => [row.reference, row.stage]));
    expect(stages[s.overUnmarked.reference]).toBe('completed');
  });

  it('lists an expired hold, or a lapsed one the sweeper has not caught, in neither list', async () => {
    const s = await everySituation();
    const all = [...references((await get('/api/account/bookings?scope=upcoming')).body), ...references((await get('/api/account/bookings?scope=past')).body)];

    expect(all).not.toContain(s.expired.reference);
    expect(all).not.toContain(s.lapsedHold.reference);
    // Every other booking is in exactly one list.
    expect(all.length).toBe(new Set(all).size);
    expect(all.length).toBe(Object.keys(s).length - 2);
  });

  it('defaults to upcoming', async () => {
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(DAY_MS) });
    const res = await get('/api/account/bookings');

    expect([res.status, references(res.body), (res.body as { scope: string }).scope]).toEqual([200, [booking.reference], 'upcoming']);
  });

  it('gives a live hold its checkout link and hold end, and nothing else one', async () => {
    const hold = await insertBooking(prisma, a, { status: 'pending_payment', startsAt: at(3 * DAY_MS) });
    const confirmed = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(4 * DAY_MS) });
    const rows = (await get('/api/account/bookings')).body.bookings as Row[];
    const holdRow = rows.find((row) => row.reference === hold.reference);
    const confirmedRow = rows.find((row) => row.reference === confirmed.reference);

    const [, path, reference, token] = /^\/(checkout)\/([^/]+)\/([^/]+)$/.exec(holdRow?.checkoutPath ?? '') ?? [];
    expect(path).toBe('checkout');
    expect(reference).toBe(hold.reference);
    expect(verifyCheckoutToken(TEST_SECRET, hold.reference, token ?? '')).toBe(true);
    const stored = await prisma.booking.findUniqueOrThrow({ where: { id: hold.id } });
    expect(holdRow?.holdExpiresAt).toBe(stored.holdExpiresAt?.toISOString());
    expect([confirmedRow?.checkoutPath, confirmedRow?.holdExpiresAt]).toEqual([null, null]);
  });

  it('gives no checkout link when payments are off, though the hold is still listed', async () => {
    const hold = await insertBooking(prisma, a, { status: 'pending_payment', startsAt: at(3 * DAY_MS) });
    const rows = (await get('/api/account/bookings', tokenX, app({ payments: false }))).body.bookings as Row[];

    expect(rows.map((row) => [row.reference, row.checkoutPath])).toEqual([[hold.reference, null]]);
  });

  it('answers the amounts from bookingTotals: total, paid, due and owed back', async () => {
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(2 * DAY_MS), addons: ['own', 'shared'] });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
    await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', amountRwf: 5_000 });
    const row = ((await get('/api/account/bookings')).body.bookings as Row[])[0];
    const stored = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id }, include: { addons: true, payments: true } });
    const totals = bookingTotals(stored, stored.addons, stored.payments);

    expect(row?.amounts).toEqual({ totalRwf: totals.grandTotalRwf, paidRwf: totals.collectedRwf, dueRwf: totals.outstandingRwf, refundDueRwf: totals.refundDueRwf });
    expect(row?.amounts).toEqual({ totalRwf: 55_000, paidRwf: 20_000, dueRwf: 35_000, refundDueRwf: 5_000 });
  });

  it('pages by 20 with a total, and answers the last page for one past the end', async () => {
    const made: Booking[] = [];
    for (let i = 0; i < ACCOUNT_PAGE_SIZE + 5; i++) made.push(await insertBooking(prisma, i % 2 === 0 ? a : b, { status: 'confirmed', startsAt: at((i + 1) * DAY_MS) }));
    const first = await get('/api/account/bookings?page=1');
    const second = await get('/api/account/bookings?page=2');
    const beyond = await get('/api/account/bookings?page=99');

    expect(first.body).toMatchObject({ total: 25, page: 1, pageCount: 2 });
    expect(references(first.body)).toEqual(made.slice(0, 20).map((booking) => booking.reference));
    expect(second.body).toMatchObject({ total: 25, page: 2, pageCount: 2 });
    expect(references(second.body)).toEqual(made.slice(20).map((booking) => booking.reference));
    expect(beyond.body).toEqual(second.body);
  });

  it('answers an empty list as page 1 of 1', async () => {
    const res = await get('/api/account/bookings?scope=past');
    expect(res.body).toEqual({ scope: 'past', bookings: [], total: 0, page: 1, pageSize: ACCOUNT_PAGE_SIZE, pageCount: 1 });
  });

  it.each([
    ['an unknown scope', '?scope=all'],
    ['a repeated scope', '?scope=upcoming&scope=past'],
    ['a page that is not a number', '?page=two'],
    ['a fractional page', '?page=1.5'],
    ['an unknown key', '?clientId=00000000-0000-4000-8000-000000000000'],
  ])('refuses %s with 400', async (_label, query) => {
    const res = await get(`/api/account/bookings${query}`);
    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
  });

  it.each([
    ['page 0', '?page=0'],
    ['a page past a million', '?page=1000001'],
  ])('refuses %s with 422 naming the page: a number, out of its rule', async (_label, query) => {
    const res = await get(`/api/account/bookings${query}`);
    expect([res.status, res.body]).toEqual([422, { error: 'validation_failed', fields: ['page'] }]);
  });

  it('holds only the account’s bookings: Y’s are never among X’s, and Y sees only Y’s', async () => {
    const mine = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(DAY_MS) });
    const theirs = await insertBooking(prisma, yWorld, { status: 'confirmed', startsAt: at(2 * DAY_MS) });

    expect(references((await get('/api/account/bookings')).body)).toEqual([mine.reference]);
    const tokenY = await accountToken(TEST_SECRET, prisma, y.id, NOW);
    expect(references((await get('/api/account/bookings', tokenY)).body)).toEqual([theirs.reference]);
  });

  it('answers 401 without a token, and for a studio token', async () => {
    expect((await request(app()).get('/api/account/bookings')).status).toBe(401);
    const studioUser = await prisma.appUser.findUniqueOrThrow({ where: { id: a.photographerUserId } });
    const { issueToken } = await import('../auth/token.js');
    const studio = (await issueToken(TEST_SECRET, 'studio', studioUser, NOW)).token;
    expect((await get('/api/account/bookings', studio)).status).toBe(401);
  });
});

// --- B2: one booking, cancelling it, paying its session fee -----------------------------

describe('GET /api/account/bookings/:reference (B2)', () => {
  it('answers exactly the guest page’s view, with the photographer’s contact details beside it', async () => {
    await prisma.photographer.update({
      where: { id: b.photographerId },
      data: { contactPhone: '+250788000321', whatsappPhone: '+250788000322', contactEmail: 'hello@hills.example' },
    });
    const booking = await insertBooking(prisma, b, { status: 'confirmed', startsAt: at(2 * DAY_MS) });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
    await prisma.bookingNote.create({ data: { bookingId: booking.id, body: 'See you at the gate.' } });
    const accessToken = await grantAccessToken(prisma, booking.id);

    const mine = await get(`/api/account/bookings/${booking.reference}`);
    const guest = await request(app()).get(`/api/booking/${accessToken}`);

    expect(mine.status).toBe(200);
    expect(mine.headers['cache-control']).toBe('no-store');
    expect(mine.body.booking).toEqual(guest.body.booking);
    expect(mine.body.photographer).toEqual({
      handle: SECOND_PHOTOGRAPHER_HANDLE,
      displayName: 'Hills & Light',
      contactPhone: '+250788000321',
      whatsappPhone: '+250788000322',
      email: 'hello@hills.example',
    });
    expect([mine.body.checkoutPath, mine.body.holdExpiresAt]).toEqual([null, null]);
    // Never the login of the photographer, never the booking's id.
    expect(mine.text).not.toContain('second.photographer@bookly.example');
    expect(mine.text).not.toContain(booking.id);
  });

  it('gives a live hold its checkout link, and a lapsed one none', async () => {
    const live = await insertBooking(prisma, a, { status: 'pending_payment', startsAt: at(2 * DAY_MS) });
    const lapsed = await insertBooking(prisma, a, { status: 'pending_payment', holdMinutes: -1, startsAt: at(3 * DAY_MS) });

    const liveRes = await get(`/api/account/bookings/${live.reference}`);
    expect(liveRes.body.checkoutPath).toMatch(new RegExp(`^/checkout/${live.reference}/[A-Za-z0-9_-]{43}$`));
    // The hold's end beside its link, so the page can say until when.
    const stored = await prisma.booking.findUniqueOrThrow({ where: { id: live.id }, select: { holdExpiresAt: true } });
    expect(liveRes.body.holdExpiresAt).toBe(stored.holdExpiresAt?.toISOString());
    // Its page still opens: the reference is the account's.
    const res = await get(`/api/account/bookings/${lapsed.reference}`);
    expect([res.status, res.body.checkoutPath, res.body.holdExpiresAt]).toEqual([200, null, null]);
  });

  it.each([
    ['another account’s booking', async () => (await insertBooking(prisma, yWorld, { status: 'confirmed' })).reference],
    ['a reference that names nothing', async () => 'BKY-2706-ZZZZZ'],
    ['a malformed reference', async () => 'bky-2706-zzzzz'],
    ['a guest booking under an address nobody has proven', async () => {
      const guest = await prisma.client.create({ data: { fullName: 'Guest', email: 'guest@example.com', phone: null } });
      return (await insertBooking(prisma, { ...a, clientId: guest.id }, { status: 'confirmed' })).reference;
    }],
  ])('answers 404 for %s', async (_label, reference) => {
    const res = await get(`/api/account/bookings/${await reference()}`);
    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });
});

describe('POST /api/account/bookings/:reference/cancel (B2, T8.2)', () => {
  /** What was queued: the client's cancellation (filed under the booking) and the photographer's alerts (under the studio). */
  async function outboxTemplates(): Promise<string[]> {
    return (await prisma.outbox.findMany({ orderBy: { createdAt: 'asc' } })).map((row) => String(row.template)).sort();
  }

  it('before the cut-off: cancels, and keeps the booking fee where the policy says it is not refundable', async () => {
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(3 * DAY_MS), clientCancelCutoffHours: 48, bookingFeeRefundableOnClientCancel: false });
    const fee = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
    const session = await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 10_000 });

    const res = await post(`/api/account/bookings/${booking.reference}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.booking).toMatchObject({ reference: booking.reference, status: 'cancelled_by_client', canCancel: false });
    expect(res.body.photographer.handle).toBe(PHOTOGRAPHER_HANDLE);
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fee.id } })).resolves.toMatchObject({ status: 'succeeded' });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: session.id } })).resolves.toMatchObject({ status: 'refund_due' });
    expect(await outboxTemplates()).toEqual(['cancellation', 'photographer_alert', 'photographer_alert']);
  });

  it('before the cut-off: refunds the booking fee too where the policy says so', async () => {
    const booking = await insertBooking(prisma, b, { status: 'confirmed', startsAt: at(3 * DAY_MS), clientCancelCutoffHours: 24, bookingFeeRefundableOnClientCancel: true });
    const fee = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    const res = await post(`/api/account/bookings/${booking.reference}/cancel`);

    expect([res.status, res.body.booking.status]).toEqual([200, 'cancelled_by_client']);
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fee.id } })).resolves.toMatchObject({ status: 'refund_due' });
    const cancellation = await prisma.outbox.findFirstOrThrow({ where: { bookingId: booking.id, template: 'cancellation' } });
    expect(cancellation.payload).toMatchObject({ bookingFeeRefunded: true, refundRwf: 20_000, cancelledBy: 'client' });
  });

  it('past the cut-off: 409 not_cancellable with the booking as it stands, and nothing changes', async () => {
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(20 * HOUR_MS), clientCancelCutoffHours: 24, bookingFeeRefundableOnClientCancel: true });
    const fee = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    const res = await post(`/api/account/bookings/${booking.reference}/cancel`);

    expect([res.status, res.body.error, res.body.booking.status, res.body.booking.canCancel]).toEqual([409, 'not_cancellable', 'confirmed', false]);
    await expect(prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).resolves.toMatchObject({ status: 'confirmed', cancelledAt: null });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fee.id } })).resolves.toMatchObject({ status: 'succeeded' });
    expect(await prisma.outbox.count()).toBe(0);
  });

  it.each([
    ['already cancelled', 'cancelled_by_client'],
    ['a hold not yet paid', 'pending_payment'],
    ['completed', 'completed'],
  ])('answers 409 for a booking %s', async (_label, status) => {
    const booking = await insertBooking(prisma, a, { status, startsAt: at(3 * DAY_MS) });
    const res = await post(`/api/account/bookings/${booking.reference}/cancel`);

    expect([res.status, res.body.error]).toEqual([409, 'not_cancellable']);
    await expect(prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).resolves.toMatchObject({ status });
  });

  it('answers 404 for another account’s booking, and cancels nothing of it', async () => {
    const theirs = await insertBooking(prisma, yWorld, { status: 'confirmed', startsAt: at(3 * DAY_MS) });
    const res = await post(`/api/account/bookings/${theirs.reference}/cancel`);

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
    await expect(prisma.booking.findUniqueOrThrow({ where: { id: theirs.id } })).resolves.toMatchObject({ status: 'confirmed' });
    expect(await prisma.outbox.count()).toBe(0);
  });

  it('cancels once when two cancellations race', async () => {
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(3 * DAY_MS) });
    const server = app();
    const results = await Promise.all([1, 2].map(() => post(`/api/account/bookings/${booking.reference}/cancel`, {}, tokenX, server)));

    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await prisma.outbox.count({ where: { bookingId: booking.id, template: 'cancellation' } })).toBe(1);
  });
});

describe('POST /api/account/bookings/:reference/payments (B2)', () => {
  const body = { method: 'momo_mtn', phone: '0788123456' };

  it('starts a session-fee payment for what is outstanding, prompting the normalised number', async () => {
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(2 * DAY_MS) });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    const res = await post(`/api/account/bookings/${booking.reference}/payments`, body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ payment: { ourRef: expect.any(String), status: 'pending' } });
    await expect(prisma.payment.findUniqueOrThrow({ where: { ourRef: res.body.payment.ourRef } })).resolves.toMatchObject({
      bookingId: booking.id,
      kind: 'session_fee',
      amountRwf: 30_000,
      method: 'momo_mtn',
      status: 'pending',
    });
    expect(provider.initiated).toMatchObject([{ amountRwf: 30_000, payerPhone: '+250788123456', kind: 'session_fee', bookingReference: booking.reference }]);
  });

  it('answers a second tap 409 payment_in_progress, prompting nobody again', async () => {
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(2 * DAY_MS) });
    const first = await post(`/api/account/bookings/${booking.reference}/payments`, body);
    const second = await post(`/api/account/bookings/${booking.reference}/payments`, body);

    expect([second.status, second.body]).toEqual([409, { error: 'payment_in_progress', payment: { ourRef: first.body.payment.ourRef } }]);
    expect(provider.initiated).toHaveLength(1);
  });

  it('answers 409 nothing_to_pay with the booking page for a booking that owes nothing', async () => {
    const booking = await insertBooking(prisma, a, { status: 'cancelled_by_client', startsAt: at(2 * DAY_MS) });
    const res = await post(`/api/account/bookings/${booking.reference}/payments`, body);

    expect([res.status, res.body.error, res.body.booking.reference]).toEqual([409, 'nothing_to_pay', booking.reference]);
    expect(res.body.photographer.handle).toBe(PHOTOGRAPHER_HANDLE);
    expect(provider.initiated).toHaveLength(0);
  });

  it('answers 502 payment_not_started when the provider refuses, recording the attempt failed', async () => {
    provider = stubProvider({ initiate: async () => ({ outcome: 'rejected', reason: 'payer_not_found' }) });
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(2 * DAY_MS) });
    const res = await post(`/api/account/bookings/${booking.reference}/payments`, body);

    expect([res.status, res.body.error, res.body.reason, res.body.payment.status]).toEqual([502, 'payment_not_started', 'rejected', 'failed']);
    await expect(prisma.payment.findUniqueOrThrow({ where: { ourRef: res.body.payment.ourRef } })).resolves.toMatchObject({ status: 'failed' });
  });

  it.each([
    ['a method not on offer', { method: 'momo_airtel', phone: '0788123456' }, ['method']],
    ['a phone that is not one', { method: 'momo_mtn', phone: 'call me' }, ['phone']],
  ])('answers 422 for %s, prompting nobody', async (_label, payload, fields) => {
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(2 * DAY_MS) });
    const res = await post(`/api/account/bookings/${booking.reference}/payments`, payload);

    expect([res.status, res.body]).toEqual([422, { error: 'validation_failed', fields }]);
    expect(provider.initiated).toHaveLength(0);
  });

  it('answers 404 for another account’s booking before reading the body, prompting nobody', async () => {
    const theirs = await insertBooking(prisma, yWorld, { status: 'confirmed', startsAt: at(2 * DAY_MS) });
    const res = await post(`/api/account/bookings/${theirs.reference}/payments`, { method: 'nope' });

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
    expect(await prisma.payment.count({ where: { bookingId: theirs.id } })).toBe(0);
  });

  it('is not mounted when payments are off', async () => {
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(2 * DAY_MS) });
    const res = await post(`/api/account/bookings/${booking.reference}/payments`, body, tokenX, app({ payments: false }));
    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });
});

// --- B3: payments and receipts -----------------------------------------------------------

describe('GET /api/account/payments and /payments/:ourRef (B3, R8.2)', () => {
  type PaymentRow = { ourRef: string; status: string; method: string | null; refund: unknown; overpayment: unknown; hasReceipt: boolean; failure: string | null; booking: { reference: string } };

  async function rawPayment(bookingId: string, fields: Record<string, unknown>): Promise<string> {
    const columns = Object.keys(fields);
    const result = await raw.query<{ our_ref: string }>(
      `INSERT INTO payment (booking_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING our_ref::text`,
      [bookingId, ...Object.values(fields)],
    );
    return result.rows[0]?.our_ref ?? '';
  }

  it('lists every payment that moved money or tried to, newest first, never an initiated row', async () => {
    const one = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(2 * DAY_MS) });
    const two = await insertBooking(prisma, b, { status: 'completed', startsAt: at(-2 * DAY_MS) });
    const base = { kind: 'session_fee', provider: 'mtn_momo_direct', amount_rwf: 1_000 };
    const refs = {
      pending: await rawPayment(one.id, { ...base, status: 'pending', method: 'momo_mtn', initiated_at: at(-1 * HOUR_MS) }),
      failed: await rawPayment(one.id, { ...base, status: 'failed', method: 'momo_mtn', failure_reason: 'provider_timeout', initiated_at: at(-2 * HOUR_MS) }),
      declined: await rawPayment(one.id, { ...base, status: 'failed', method: 'momo_mtn', failure_reason: 'PAYER_NOT_FOUND', initiated_at: at(-3 * HOUR_MS) }),
      initiated: await rawPayment(one.id, { ...base, status: 'initiated', initiated_at: at(-4 * HOUR_MS) }),
      succeeded: await rawPayment(two.id, { kind: 'booking_fee', provider: 'mtn_momo_direct', method: 'momo_airtel', amount_rwf: 20_000, status: 'succeeded', settled_at: at(-5 * DAY_MS), initiated_at: at(-5 * DAY_MS) }),
      cash: await rawPayment(two.id, { ...base, provider: 'cash', status: 'refund_due', note: 'PRIVATE-CASH-NOTE', settled_at: at(-6 * DAY_MS), initiated_at: at(-6 * DAY_MS) }),
      refunded: await rawPayment(two.id, {
        ...base,
        method: 'momo_mtn',
        status: 'refunded',
        provider_ref: 'PROVIDER-REF-INTERNAL',
        settled_at: at(-7 * DAY_MS),
        initiated_at: at(-7 * DAY_MS),
        refunded_at: at(-1 * DAY_MS),
        refund_reference: 'MOMO-REFUND-77',
      }),
    };

    const res = await get('/api/account/payments');
    const rows = res.body.payments as PaymentRow[];

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 6, page: 1, pageSize: ACCOUNT_PAGE_SIZE, pageCount: 1 });
    expect(rows.map((row) => row.ourRef)).toEqual([refs.pending, refs.failed, refs.declined, refs.succeeded, refs.cash, refs.refunded]);
    const byRef = Object.fromEntries(rows.map((row) => [row.ourRef, row]));
    expect(byRef[refs.failed]).toMatchObject({ failure: 'unavailable', hasReceipt: false });
    expect(byRef[refs.declined]).toMatchObject({ failure: 'declined', hasReceipt: false });
    expect(byRef[refs.succeeded]).toMatchObject({ method: 'momo_airtel', hasReceipt: true, refund: { state: 'none' }, overpayment: null, failure: null });
    expect(byRef[refs.cash]).toMatchObject({ method: 'cash', hasReceipt: true, refund: { state: 'due', amountRwf: 1_000 } });
    expect(byRef[refs.refunded]).toMatchObject({
      hasReceipt: true,
      refund: { state: 'refunded', amountRwf: 1_000, refundedAt: at(-DAY_MS).toISOString(), reference: 'MOMO-REFUND-77' },
      booking: { reference: two.reference, photographer: { handle: SECOND_PHOTOGRAPHER_HANDLE } },
    });
    // Nothing internal: the photographer's cash note, the provider's own reference and failure text.
    for (const secret of ['PRIVATE-CASH-NOTE', 'PROVIDER-REF-INTERNAL', 'PAYER_NOT_FOUND', 'provider_timeout', 'mtn_momo_direct']) expect(res.text).not.toContain(secret);
  });

  it('shows an overpayment and whether it went back', async () => {
    const booking = await insertBooking(prisma, a, { status: 'completed', startsAt: at(-2 * DAY_MS) });
    await rawPayment(booking.id, {
      kind: 'session_fee',
      provider: 'mtn_momo_direct',
      method: 'momo_mtn',
      amount_rwf: 35_000,
      overpaid_rwf: 5_000,
      status: 'succeeded',
      settled_at: at(-DAY_MS),
      overpayment_refunded_at: at(-HOUR_MS),
      overpayment_refund_reference: 'OVER-REF-1',
      overpayment_refunded_by_user_id: (await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } })).id,
    });
    const row = ((await get('/api/account/payments')).body.payments as PaymentRow[])[0];

    expect(row?.overpayment).toEqual({ amountRwf: 5_000, refundedAt: at(-HOUR_MS).toISOString(), reference: 'OVER-REF-1' });
  });

  it('pages by 20', async () => {
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(2 * DAY_MS) });
    for (let i = 0; i < 23; i++) await rawPayment(booking.id, { kind: 'session_fee', provider: 'mtn_momo_direct', amount_rwf: 1_000 + i, status: 'failed', initiated_at: at(-i * HOUR_MS) });

    const second = await get('/api/account/payments?page=2');
    expect(second.body).toMatchObject({ total: 23, page: 2, pageCount: 2 });
    expect((second.body.payments as PaymentRow[]).length).toBe(3);
    expect((await get('/api/account/payments?page=0')).status).toBe(422);
    expect((await get('/api/account/payments?scope=past')).status).toBe(400);
  });

  it('never lists another account’s payments, nor a photographer’s subscription payment', async () => {
    const theirs = await insertBooking(prisma, yWorld, { status: 'confirmed', startsAt: at(2 * DAY_MS) });
    const theirRef = (await insertPayment(prisma, theirs.id, { status: 'succeeded' })).ourRef;
    const res = await get('/api/account/payments');

    expect(res.body.payments).toEqual([]);
    expect(res.text).not.toContain(theirRef);
  });

  it('answers a receipt with the photographer, the booking, its add-on lines and the money', async () => {
    const booking = await insertBooking(prisma, b, { status: 'completed', startsAt: at(-2 * DAY_MS), addons: ['own', 'shared'] });
    const { ourRef } = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    const res = await get(`/api/account/payments/${ourRef}`);

    expect(res.status).toBe(200);
    expect(res.body.receipt).toMatchObject({
      ourRef,
      kind: 'booking_fee',
      method: 'momo_mtn',
      amountRwf: 20_000,
      status: 'succeeded',
      refund: { state: 'none' },
      billedTo: CLIENT.name,
      photographer: { handle: SECOND_PHOTOGRAPHER_HANDLE, displayName: 'Hills & Light' },
      booking: {
        reference: booking.reference,
        startsAt: booking.startsAt.toISOString(),
        serviceName: 'Portraits',
        packageName: 'Standard',
        packagePriceRwf: 40_000,
        bookingFeeRwf: 20_000,
        addons: [
          { name: 'Extra hour', quantity: 1, unitPriceRwf: 10_000, amountRwf: 10_000, stage: 'at_booking' },
          { name: 'Rush edit', quantity: 1, unitPriceRwf: 5_000, amountRwf: 5_000, stage: 'at_booking' },
        ],
      },
    });
    expect(res.body.receipt.settledAt).toEqual(expect.any(String));
  });

  it('answers a refunded payment’s receipt with its refund', async () => {
    const booking = await insertBooking(prisma, a, { status: 'cancelled_by_client', startsAt: at(2 * DAY_MS) });
    const ourRef = await rawPayment(booking.id, { kind: 'booking_fee', provider: 'mtn_momo_direct', method: 'momo_mtn', amount_rwf: 20_000, status: 'refunded', settled_at: at(-2 * DAY_MS), refunded_at: at(-DAY_MS), refund_reference: 'MOMO-R-1' });

    const res = await get(`/api/account/payments/${ourRef.toUpperCase()}`);
    expect([res.status, res.body.receipt.refund]).toEqual([200, { state: 'refunded', amountRwf: 20_000, refundedAt: at(-DAY_MS).toISOString(), reference: 'MOMO-R-1' }]);
  });

  it.each(['pending', 'failed', 'initiated'])('answers the account’s own %s payment 409 no_receipt', async (status) => {
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(2 * DAY_MS) });
    const ourRef = await rawPayment(booking.id, { kind: 'session_fee', provider: 'mtn_momo_direct', amount_rwf: 1_000, status });

    const res = await get(`/api/account/payments/${ourRef}`);
    expect([res.status, res.body]).toEqual([409, { error: 'no_receipt', payment: { status } }]);
  });

  it.each([
    ['another account’s payment', async () => (await insertPayment(prisma, (await insertBooking(prisma, yWorld, { status: 'confirmed' })).id, { status: 'succeeded' })).ourRef],
    ['an ourRef that names nothing', async () => '00000000-0000-4000-8000-000000000000'],
    ['a malformed ourRef', async () => 'not-a-uuid'],
    ['a photographer’s subscription payment', async () => {
      const subscription = await prisma.subscription.findUniqueOrThrow({ where: { photographerId: a.photographerId } });
      const rows = await raw.query<{ our_ref: string }>(
        `INSERT INTO payment (subscription_id, kind, provider, method, amount_rwf, plan_interval, status) VALUES ($1, 'subscription', 'mtn_momo_direct', 'momo_mtn', 10000, 'monthly', 'succeeded') RETURNING our_ref::text`,
        [subscription.id],
      );
      return rows.rows[0]?.our_ref ?? '';
    }],
  ])('answers 404 for %s', async (_label, ourRef) => {
    const res = await get(`/api/account/payments/${await ourRef()}`);
    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });
});

// --- B4: profile and /me ----------------------------------------------------------------

describe('the profile and /me (B4, decision 1)', () => {
  function patch(body: unknown, token = tokenX) {
    return request(app()).patch('/api/account/profile').set('Authorization', `Bearer ${token}`).send(body as object);
  }

  it('reads the name and phone', async () => {
    await prisma.appUser.update({ where: { id: x.id }, data: { phone: '+250788111222' } });
    const res = await get('/api/account/profile');
    expect([res.status, res.body]).toEqual([200, { profile: { fullName: 'Aline Uwase', phone: '+250788111222' } }]);
  });

  it('saves a name and a Rwandan local number as E.164, changing only what was sent', async () => {
    expect((await patch({ phone: '078 811 1222' })).body).toEqual({ profile: { fullName: 'Aline Uwase', phone: '+250788111222' } });
    expect((await patch({ fullName: '  Aline U.  ' })).body).toEqual({ profile: { fullName: 'Aline U.', phone: '+250788111222' } });
    expect((await patch({})).body).toEqual({ profile: { fullName: 'Aline U.', phone: '+250788111222' } });
  });

  it.each([
    ['250788111222', '+250788111222'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('reads %j as %s', async (typed, stored) => {
    expect((await patch({ phone: typed })).body.profile.phone).toBe(stored);
  });

  it.each([null, '', '   '])('clears the phone with %j', async (phone) => {
    await prisma.appUser.update({ where: { id: x.id }, data: { phone: '+250788111222' } });
    expect((await patch({ phone })).body.profile.phone).toBeNull();
    await expect(prisma.appUser.findUniqueOrThrow({ where: { id: x.id } })).resolves.toMatchObject({ phone: null });
  });

  it.each([
    ['a phone that is not one', { phone: 'call me maybe' }, ['phone']],
    ['a foreign number without its +', { phone: '2079460958' }, ['phone']],
    ['a blank name', { fullName: '   ' }, ['fullName']],
    ['a name past 200 characters', { fullName: 'a'.repeat(201) }, ['fullName']],
    ['a name with a NUL', { fullName: `Aline${String.fromCharCode(0)}` }, ['fullName']],
  ])('answers 422 for %s, naming it, and saves nothing', async (_label, body, fields) => {
    const res = await patch(body);
    expect([res.status, res.body]).toEqual([422, { error: 'validation_failed', fields }]);
    await expect(prisma.appUser.findUniqueOrThrow({ where: { id: x.id } })).resolves.toMatchObject({ fullName: 'Aline Uwase', phone: null });
  });

  it('counts the name in characters, as the database does: 200 emoji fit', async () => {
    const name = '\u{1F4F7}'.repeat(200);
    expect((await patch({ fullName: name })).body.profile.fullName).toBe(name);
  });

  it.each([
    ['a null name', { fullName: null }],
    ['a number for a phone', { phone: 788111222 }],
    ['an unknown key', { email: 'new@example.com' }],
    ['not an object', ['fullName']],
  ])('answers 400 for %s', async (_label, body) => {
    expect((await patch(body)).status).toBe(400);
  });

  it('never touches a booking’s contact snapshot, nor the client row', async () => {
    const booking = await insertBooking(prisma, a, { status: 'confirmed', startsAt: at(2 * DAY_MS) });
    await patch({ fullName: 'Someone Else', phone: '0788000000' });

    await expect(prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).resolves.toMatchObject({ contactName: CLIENT.name, contactPhone: CLIENT.phone });
    await expect(prisma.client.findUniqueOrThrow({ where: { id: a.clientId } })).resolves.toMatchObject({ fullName: CLIENT.name, phone: CLIENT.phone });
  });

  it('/me carries the phone, which credentials the account holds, and a live pending address', async () => {
    await prisma.appUser.update({
      where: { id: x.id },
      data: { phone: '+250788111222', pendingEmail: 'new@example.com', pendingEmailTokenHash: 'h', pendingEmailExpiresAt: at(HOUR_MS) },
    });
    const res = await get('/api/account/me');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      user: { id: x.id, email: CLIENT.email, lastLoginAt: null, fullName: 'Aline Uwase', phone: '+250788111222', hasPassword: true, hasGoogle: false, pendingEmail: 'new@example.com' },
    });
  });

  it('/me drops a pending address once its link has lapsed, and says so of a Google-only account', async () => {
    const google = await createClientAccount(prisma, { email: 'g.only@example.com', password: null, googleSub: 'google-sub-me' });
    await prisma.appUser.update({ where: { id: google.id }, data: { pendingEmail: 'n@example.com', pendingEmailTokenHash: 'h2', pendingEmailExpiresAt: at(-1) } });
    const res = await get('/api/account/me', await accountToken(TEST_SECRET, prisma, google.id, NOW));

    expect(res.body.user).toMatchObject({ hasPassword: false, hasGoogle: true, pendingEmail: null });
    // Whether, never what.
    expect(res.text).not.toContain('google-sub-me');
  });
});

// --- B7: export ----------------------------------------------------------------------------

describe('GET /api/account/export (B7, T8.4)', () => {
  it('is an attachment holding exactly the account’s own records, and nothing private', async () => {
    const mineA = await insertBooking(prisma, a, { status: 'completed', startsAt: at(-3 * DAY_MS), addons: ['own', 'shared'] });
    const mineB = await insertBooking(prisma, b, { status: 'confirmed', startsAt: at(3 * DAY_MS) });
    const expired = await insertBooking(prisma, a, { status: 'expired', startsAt: at(4 * DAY_MS) });
    await prisma.booking.update({
      where: { id: mineA.id },
      data: { deliveryUrl: 'https://photos.example-host.com/s/mine', deliveryExpiresOn: new Date('2027-09-01T00:00:00Z'), deliverySentAt: at(-DAY_MS), deliveryNote: 'Enjoy!' },
    });
    await prisma.bookingNote.create({ data: { bookingId: mineA.id, body: 'SHOWN-NOTE' } });
    await prisma.bookingNote.create({ data: { bookingId: mineA.id, body: 'DELETED-NOTE', deletedAt: at(-HOUR_MS) } });
    const fee = await insertPayment(prisma, mineA.id, { status: 'succeeded', amountRwf: 20_000, providerRef: 'PROVIDER-REF-SECRET' });
    await raw.query(`INSERT INTO payment (booking_id, kind, provider, amount_rwf, status, note, settled_at) VALUES ($1, 'session_fee', 'cash', 5000, 'succeeded', 'CASH-NOTE-PRIVATE', now())`, [mineA.id]);
    const attempt = await insertPayment(prisma, mineB.id, { status: 'failed', kind: 'session_fee', failureReason: 'FAILURE-TEXT-INTERNAL' });
    await grantAccessToken(prisma, mineB.id);
    await prisma.appUser.update({ where: { id: x.id }, data: { phone: '+250788111222', googleSub: 'GOOGLE-SUB-SECRET', passwordResetTokenHash: 'RESET-HASH-SECRET', passwordResetExpiresAt: at(HOUR_MS) } });
    const theirs = await insertBooking(prisma, yWorld, { status: 'confirmed', startsAt: at(5 * DAY_MS) });
    const theirPayment = await insertPayment(prisma, theirs.id, { status: 'succeeded' });
    const token = await accountToken(TEST_SECRET, prisma, x.id, NOW);

    const res = await get('/api/account/export', token);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="bookly-account-2027-06-01.json"');
    expect(res.headers['cache-control']).toBe('no-store');
    const document = JSON.parse(res.text) as {
      format: string;
      account: Record<string, unknown>;
      contacts: unknown[];
      bookings: { reference: string; notes: { body: string }[]; delivery: unknown; addons: unknown[]; contact: unknown }[];
      payments: { ourRef: string }[];
    };
    expect(document.format).toBe('bookly-account-export');
    expect(document.account).toEqual({
      email: CLIENT.email,
      fullName: 'Aline Uwase',
      phone: '+250788111222',
      emailVerifiedAt: '2026-09-01T06:00:00.000Z',
      createdAt: expect.any(String),
      lastLoginAt: null,
      hasPassword: true,
      hasGoogle: true,
      pendingEmail: null,
    });
    expect(document.contacts).toEqual([{ fullName: CLIENT.name, email: CLIENT.email, phone: CLIENT.phone }]);

    // Exactly the account's bookings and payments: every one, and no one else's.
    const expected = await prisma.booking.findMany({ where: { client: { userId: x.id } }, select: { reference: true } });
    expect(document.bookings.map((booking) => booking.reference).sort()).toEqual(expected.map((booking) => booking.reference).sort());
    expect(document.bookings.map((booking) => booking.reference)).toContain(expired.reference);
    const expectedPayments = await prisma.payment.findMany({ where: { booking: { client: { userId: x.id } } }, select: { ourRef: true } });
    expect(document.payments.map((payment) => payment.ourRef).sort()).toEqual(expectedPayments.map((payment) => payment.ourRef).sort());
    expect(document.payments.map((payment) => payment.ourRef)).toEqual(expect.arrayContaining([fee.ourRef, attempt.ourRef]));

    const completed = document.bookings.find((booking) => booking.reference === mineA.reference);
    expect(completed?.contact).toEqual({ name: CLIENT.name, email: CLIENT.email, phone: CLIENT.phone });
    expect(completed?.notes.map((note) => note.body)).toEqual(['SHOWN-NOTE']);
    expect(completed?.delivery).toMatchObject({ url: 'https://photos.example-host.com/s/mine', expiresOn: '2027-09-01', expired: false, note: 'Enjoy!' });
    expect(completed?.addons).toHaveLength(2);

    for (const absent of [
      theirs.reference,
      theirPayment.ourRef,
      Y_EMAIL,
      'DELETED-NOTE',
      'CASH-NOTE-PRIVATE',
      'PROVIDER-REF-SECRET',
      'FAILURE-TEXT-INTERNAL',
      'GOOGLE-SUB-SECRET',
      'RESET-HASH-SECRET',
      String(x.passwordHash),
      x.id,
      mineA.id,
      a.photographerId,
      'second.photographer@bookly.example',
      'photographer@bookly.example',
      'tokenVersion',
      'failedLoginCount',
      'accessToken',
    ]) {
      expect(res.text, absent).not.toContain(absent);
    }
    const accessHash = (await prisma.booking.findUniqueOrThrow({ where: { id: mineB.id } })).accessTokenHash;
    expect(res.text).not.toContain(String(accessHash));
  });

  it('answers an account with nothing booked with an empty document, not an error', async () => {
    const token = await accountToken(TEST_SECRET, prisma, y.id, NOW);
    await prisma.booking.deleteMany({});
    const document = JSON.parse((await get('/api/account/export', token)).text) as { bookings: unknown[]; payments: unknown[]; contacts: unknown[] };
    expect([document.bookings, document.payments]).toEqual([[], []]);
    expect(document.contacts).toHaveLength(1);
  });

  it('leaves out a delivery the photographer has saved but not sent', async () => {
    const booking = await insertBooking(prisma, a, { status: 'completed', startsAt: at(-3 * DAY_MS) });
    await prisma.booking.update({ where: { id: booking.id }, data: { deliveryUrl: 'https://photos.example-host.com/s/draft' } });
    const res = await get('/api/account/export');

    expect(res.text).not.toContain('/s/draft');
  });

  it('answers 401 without a token', async () => {
    expect((await request(app()).get('/api/account/export')).status).toBe(401);
  });
});

// --- B9: linking (R8.4) ---------------------------------------------------------------------

describe('a guest booking made later with the verified address (B9, R8.4)', () => {
  /** Monday-to-Friday hours, so the public booking route has a slot to claim. */
  async function weekdayHours(photographerId: string): Promise<void> {
    await prisma.workingHours.createMany({ data: [1, 2, 3, 4, 5].map((weekday) => ({ photographerId, weekday, opensMinute: 540, closesMinute: 1020 })) });
  }

  it('appears in the dashboard by itself, through the public booking route, even under a new client row', async () => {
    await weekdayHours(a.photographerId);
    const fresh = await createClientAccount(prisma, { email: 'later.booker@example.com' });
    const token = await accountToken(TEST_SECRET, prisma, fresh.id, NOW);

    const created = await request(app())
      .post('/api/bookings')
      .send({
        packageId: a.packageId,
        addonIds: [],
        startsAt: '2027-06-02T09:00:00+02:00',
        fullName: 'Later Booker',
        email: 'Later.Booker@Example.com',
        phone: '0788123000',
        location: 'Kigali',
        consent: true,
      });
    expect(created.status).toBe(201);

    const rows = (await get('/api/account/bookings', token)).body.bookings as Row[];
    expect(rows.map((row) => [row.reference, row.status])).toEqual([[created.body.booking.reference, 'pending_payment']]);
    expect(rows[0]?.checkoutPath).toMatch(/^\/checkout\//);
  });

  it('links a new client row to a verified account in upsertClient, and an existing row keeps its account', async () => {
    const fresh = await createClientAccount(prisma, { email: 'upsert.verified@example.com' });
    const id = await prisma.$transaction((tx) => upsertClient(tx, { fullName: 'U', email: 'upsert.verified@example.com', phone: '+250788000001' }));
    await expect(prisma.client.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({ userId: fresh.id });

    // X's row, booked again under X's address: still X's.
    const again = await prisma.$transaction((tx) => upsertClient(tx, { fullName: 'Again', email: CLIENT.email, phone: CLIENT.phone }));
    expect(again).toBe(a.clientId);
    await expect(prisma.client.findUniqueOrThrow({ where: { id: again } })).resolves.toMatchObject({ userId: x.id });
  });

  it('never links a booking to an UNVERIFIED account, and the account sees nothing', async () => {
    const unverified = await createClientAccount(prisma, { email: 'not.yet@example.com', verified: false });
    const id = await prisma.$transaction((tx) => upsertClient(tx, { fullName: 'N', email: 'not.yet@example.com', phone: '+250788000002' }));
    await insertBooking(prisma, { ...a, clientId: id }, { status: 'confirmed', startsAt: at(2 * DAY_MS) });

    await expect(prisma.client.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({ userId: null });
    expect(await prisma.booking.count({ where: { client: { userId: unverified.id } } })).toBe(0);
    // And it holds no token any route accepts: the middleware refuses an unverified address.
    const { issueToken } = await import('../auth/token.js');
    const token = (await issueToken(TEST_SECRET, 'account', unverified, NOW)).token;
    expect((await get('/api/account/bookings', token)).status).toBe(401);
  });

  it('never links to an erased account', async () => {
    const erased = await createClientAccount(prisma, { email: 'erased.one@example.com' });
    await prisma.appUser.update({ where: { id: erased.id }, data: { anonymizedAt: NOW } });
    const id = await prisma.$transaction((tx) => upsertClient(tx, { fullName: 'E', email: 'erased.one@example.com', phone: '+250788000003' }));
    await expect(prisma.client.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({ userId: null });
  });

});
