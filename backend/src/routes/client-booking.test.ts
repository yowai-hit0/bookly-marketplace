import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createPrismaClient } from '../db/client.js';
import type { PaymentProvider } from '../payments/provider.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  CLIENT,
  type PaymentWorld,
  TEST_SECRET,
  grantAccessToken,
  insertBooking,
  insertBookingWithToken,
  insertPayment,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';

/**
 * The client's own booking over HTTP (plan.md Task 18; spec §2.2 P-07 to P-12,
 * §3.9, §6.10), against real PostgreSQL with the provider stubbed.
 *
 * What is proven: `GET /api/booking/:token` answers that booking's view and
 * stamps the token's use. Every token that does not resolve -- unknown, expired,
 * superseded by a resend, malformed, missing -- is the same **404**, never a 403
 * that would confirm a booking exists. Scope is the token and nothing else:
 * another booking's id, reference or email in the query or the body changes
 * nothing on any of the three routes, and the answer is still the token's own
 * booking. Cancelling is 200 with the cancelled view, or 409 `not_cancellable`
 * carrying the booking as it stands. Paying the session fee is 201 with the new
 * `our_ref`, 409 for an attempt already waiting or nothing left to owe, 422
 * naming the field for a method not on offer or an unusable number, and 502
 * when the provider will not start it. Everything is `no-store`, all of it is
 * anonymous, the payments route does not exist without a provider, and none of
 * it exists unless the public API is mounted.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;

const NOW = new Date('2026-10-01T06:00:00Z');

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
});

// --- Helpers ----------------------------------------------------------------------------

function appWith(provider: PaymentProvider = stubProvider(), providerTimeoutMs?: number): Express {
  return createApp({
    publicApi: {
      prisma,
      now: () => NOW,
      payments: { provider, secret: TEST_SECRET, ...(providerTimeoutMs === undefined ? {} : { providerTimeoutMs }) },
    },
  });
}

/** The same app with no payment provider: the page works, the payment control does not exist. */
function appWithoutPayments(): Express {
  return createApp({ publicApi: { prisma, now: () => NOW } });
}

function bookingUrl(token: string): string {
  return `/api/booking/${token}`;
}

function payBody(over: Record<string, unknown> = {}) {
  return { method: 'momo_mtn', phone: '078 812 3456', ...over };
}

function expectNoStore(res: Response): void {
  expect(res.headers['cache-control']).toBe('no-store');
}

function expectNotFound(res: Response): void {
  expect(res.status, res.text).toBe(404);
  expect(res.body).toStrictEqual({ error: 'not_found' });
}

async function paymentRows(): Promise<{ our_ref: string; kind: string; status: string; amount_rwf: number }[]> {
  const result = await raw.query<{ our_ref: string; kind: string; status: string; amount_rwf: number }>(
    'SELECT our_ref::text, kind, status, amount_rwf FROM payment ORDER BY initiated_at, amount_rwf',
  );
  return result.rows;
}

async function lastUsed(bookingId: string): Promise<Date | null> {
  const result = await raw.query<{ last_used: Date | null }>('SELECT access_token_last_used_at AS last_used FROM booking WHERE id = $1', [
    bookingId,
  ]);
  return result.rows[0]?.last_used ?? null;
}

/** A confirmed booking, its fee paid, 30,000 still owed on the shoot. */
async function payableBooking(seed: { status?: string } = {}) {
  const made = await insertBookingWithToken(prisma, world, { status: seed.status ?? 'confirmed', bookingFeeRwf: 20_000 });
  await insertPayment(prisma, made.booking.id, { status: 'succeeded', amountRwf: 20_000 });
  return made;
}

// --- Reading the booking ------------------------------------------------------------------

describe('GET /api/booking/:token', () => {
  it('answers that booking’s view, no-store, and records the token’s use', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world, { bookingFeeRwf: 20_000 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    const res = await request(appWith()).get(bookingUrl(token));

    expect(res.status, res.text).toBe(200);
    expectNoStore(res);
    expect(res.body.booking).toMatchObject({
      reference: booking.reference,
      status: 'confirmed',
      clientName: CLIENT.name,
      serviceName: 'Portraits',
      packageName: 'Standard',
      bookingFeeRwf: 20_000,
      totals: { quotedTotalRwf: 50_000, grandTotalRwf: 50_000, collectedRwf: 20_000, refundDueRwf: 0, outstandingRwf: 30_000 },
      sessionFee: { outstandingRwf: 30_000, waitingPayment: null },
      canCancel: true,
      delivery: null,
    });
    expect(await lastUsed(booking.id)).not.toBeNull();
  });

  it('carries no token, no id and no hash back to the browser', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);

    const res = await request(appWith()).get(bookingUrl(token));

    const hash = await raw.query<{ hash: string }>('SELECT access_token_hash AS hash FROM booking WHERE id = $1', [booking.id]);
    for (const secret of [token, hash.rows[0]?.hash, booking.id, world.clientId, CLIENT.email, CLIENT.phone]) {
      expect(res.text).not.toContain(secret);
    }
    for (const key of ['"id"', '"bookingId"', '"clientId"', '"contactEmail"', '"contactPhone"', '"accessTokenHash"']) {
      expect(res.text).not.toContain(key);
    }
  });

  it('opens again and again: a reload still works', async () => {
    const { token } = await insertBookingWithToken(prisma, world);
    const app = appWith();

    for (let i = 0; i < 3; i += 1) expect((await request(app).get(bookingUrl(token))).status).toBe(200);
  });

  it('works with no payment provider configured', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);

    const res = await request(appWithoutPayments()).get(bookingUrl(token));

    expect(res.status).toBe(200);
    expect(res.body.booking.reference).toBe(booking.reference);
  });

  it('is anonymous: a bogus Authorization header changes nothing and sets no cookie', async () => {
    const { token } = await insertBookingWithToken(prisma, world);

    const res = await request(appWith()).get(bookingUrl(token)).set('Authorization', 'Bearer not-a-token');

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

// --- Never 403 -----------------------------------------------------------------------------

describe('a token that does not resolve is 404, never 403', () => {
  it.each([
    ['an unknown token of the right shape', 'Zx9Q2mT7vL4pR8sK1nB6yH3cF5dG0wJe'],
    ['a short token', 'abc'],
    ['a 5,000-character token', 'a'.repeat(5_000)],
    ['a token with a quote', "abcdefghijklmnop'x"],
    ['a token in standard base64', `${'a'.repeat(40)}%2Bb`],
    ['a padded token', `${'a'.repeat(42)}%3D`],
  ])('%s', async (_case, token) => {
    const { booking } = await insertBookingWithToken(prisma, world);

    const res = await request(appWith()).get(bookingUrl(token));

    expectNotFound(res);
    expectNoStore(res);
    expect(await lastUsed(booking.id)).toBeNull();
  });

  it('an expired token', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world, { expiresInMinutes: -1 });

    expectNotFound(await request(appWith()).get(bookingUrl(token)));
    expect(await lastUsed(booking.id)).toBeNull();
  });

  it('a token a resend replaced: the old link 404s and the new one opens', async () => {
    const { booking, token: old } = await insertBookingWithToken(prisma, world);
    const resent = await grantAccessToken(prisma, booking.id);
    const app = appWith();

    expectNotFound(await request(app).get(bookingUrl(old)));
    expect((await request(app).get(bookingUrl(resent))).status).toBe(200);
  });

  it('a missing token: /api/booking and /api/booking/ are 404 too', async () => {
    await insertBookingWithToken(prisma, world);
    const app = appWith();

    expect((await request(app).get('/api/booking')).status).toBe(404);
    expect((await request(app).get('/api/booking/')).status).toBe(404);
  });

  it('never answers 403, whatever the token', async () => {
    await insertBookingWithToken(prisma, world);
    const app = appWith();

    for (const token of ['x', 'a'.repeat(43), "' OR 1=1 --", '../../etc/passwd']) {
      for (const res of [
        await request(app).get(bookingUrl(encodeURIComponent(token))),
        await request(app).post(`${bookingUrl(encodeURIComponent(token))}/cancel`),
        await request(app).post(`${bookingUrl(encodeURIComponent(token))}/payments`).send(payBody()),
      ]) {
        expect(res.status, `${token}: ${res.text}`).not.toBe(403);
        expect(res.status).toBe(404);
      }
    }
  });
});

// --- Scope is the token alone --------------------------------------------------------------

describe('another booking’s id, reference or email changes nothing (plan.md Task 18, spec §2.2)', () => {
  /** Everything a caller might hope widens the scope. */
  function foreign(other: { id: string; reference: string }) {
    return {
      bookingId: other.id,
      id: other.id,
      reference: other.reference,
      booking: other.reference,
      email: 'someone.else@example.com',
      contactEmail: 'someone.else@example.com',
      token: 'another-token-entirely-0123456789',
    };
  }

  it('on GET, in the query string', async () => {
    const mine = await insertBookingWithToken(prisma, world, { addons: ['own'] });
    const theirs = await insertBookingWithToken(prisma, world, { addons: ['shared'] });
    const query = new URLSearchParams(Object.entries(foreign(theirs.booking))).toString();

    const res = await request(appWith()).get(`${bookingUrl(mine.token)}?${query}`);

    expect(res.status).toBe(200);
    expect(res.body.booking.reference).toBe(mine.booking.reference);
    expect(res.text).not.toContain(theirs.booking.reference);
    expect(res.body.booking.addons).toStrictEqual([{ name: 'Extra hour', priceRwf: 10_000, stage: 'at_booking' }]);
    expect(await lastUsed(theirs.booking.id)).toBeNull();
  });

  it('on cancel, in the body and the query string', async () => {
    const mine = await insertBookingWithToken(prisma, world);
    const theirs = await insertBookingWithToken(prisma, world);
    const query = new URLSearchParams(Object.entries(foreign(theirs.booking))).toString();

    const res = await request(appWith())
      .post(`${bookingUrl(mine.token)}/cancel?${query}`)
      .send(foreign(theirs.booking));

    expect(res.status, res.text).toBe(200);
    expect(res.body.booking.reference).toBe(mine.booking.reference);
    expect(res.body.booking.status).toBe('cancelled_by_client');
    const rows = await raw.query<{ id: string; status: string }>('SELECT id::text, status FROM booking');
    expect(rows.rows.find((row) => row.id === theirs.booking.id)?.status).toBe('confirmed');
  });

  it('on payments, in the body: the amount is this booking’s, and the row is on this booking', async () => {
    const mine = await payableBooking();
    const theirs = await payableBooking();
    const provider = stubProvider();

    const res = await request(appWith(provider))
      .post(`${bookingUrl(mine.token)}/payments`)
      .send({ ...payBody(), ...foreign(theirs.booking), amountRwf: 1, amount: 1, status: 'succeeded', kind: 'booking_fee' });

    expect(res.status, res.text).toBe(201);
    const started = await raw.query<{ booking_id: string; kind: string; amount_rwf: number }>(
      "SELECT booking_id::text, kind, amount_rwf FROM payment WHERE status = 'pending'",
    );
    expect(started.rows).toStrictEqual([{ booking_id: mine.booking.id, kind: 'session_fee', amount_rwf: 30_000 }]);
  });

  it('cannot reach another booking by sending its reference with no token at all', async () => {
    const theirs = await insertBookingWithToken(prisma, world);

    const res = await request(appWith()).get(`/api/booking/${theirs.booking.reference}`);

    expectNotFound(res);
    expect(await lastUsed(theirs.booking.id)).toBeNull();
  });
});

// --- Cancelling ----------------------------------------------------------------------------

describe('POST /api/booking/:token/cancel', () => {
  it('answers 200 with the cancelled booking, no-store', async () => {
    const { booking, token } = await payableBooking();

    const res = await request(appWith()).post(`${bookingUrl(token)}/cancel`);

    expect(res.status, res.text).toBe(200);
    expectNoStore(res);
    expect(res.body.booking).toMatchObject({
      reference: booking.reference,
      status: 'cancelled_by_client',
      cancelledAt: NOW.toISOString(),
      canCancel: false,
      sessionFee: null,
      totals: { outstandingRwf: 0, collectedRwf: 20_000 },
    });
  });

  it('shows the refund the client is owed when a session fee had been paid', async () => {
    const { booking, token } = await payableBooking();
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000 });

    const res = await request(appWith()).post(`${bookingUrl(token)}/cancel`);

    expect(res.body.booking.totals).toMatchObject({ refundDueRwf: 30_000, outstandingRwf: 0 });
    expect(res.body.booking.payments).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'session_fee', status: 'refund_due', amountRwf: 30_000 })]),
    );
  });

  it('answers 409 not_cancellable the second time, carrying the booking as it stands', async () => {
    const { booking, token } = await payableBooking();
    const app = appWith();

    expect((await request(app).post(`${bookingUrl(token)}/cancel`)).status).toBe(200);
    const res = await request(app).post(`${bookingUrl(token)}/cancel`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_cancellable');
    expect(res.body.booking).toMatchObject({ reference: booking.reference, status: 'cancelled_by_client', canCancel: false });
    expectNoStore(res);
  });

  it.each([
    ['a shoot that has started', { status: 'confirmed', startsAt: new Date('2026-09-30T07:00:00Z') }],
    ['a completed booking', { status: 'completed' }],
    ['a no-show', { status: 'no_show' }],
    ['an expired booking', { status: 'expired' }],
    ['a booking the photographer cancelled', { status: 'cancelled_by_admin' }],
  ])('answers 409 not_cancellable for %s, and changes nothing', async (_case, seed) => {
    const { booking, token } = await insertBookingWithToken(prisma, world, seed);

    const res = await request(appWith()).post(`${bookingUrl(token)}/cancel`);

    expect(res.status, res.text).toBe(409);
    expect(res.body.error).toBe('not_cancellable');
    expect(res.body.booking.reference).toBe(booking.reference);
    const row = await raw.query<{ status: string }>('SELECT status FROM booking WHERE id = $1', [booking.id]);
    expect(row.rows[0]?.status).toBe(seed.status);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('is 404 for a token that does not resolve, and cancels nothing', async () => {
    const { booking } = await payableBooking();

    expectNotFound(await request(appWith()).post(`${bookingUrl('a'.repeat(43))}/cancel`));

    const row = await raw.query<{ status: string }>('SELECT status FROM booking WHERE id = $1', [booking.id]);
    expect(row.rows[0]?.status).toBe('confirmed');
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('cancels with no payment provider configured: the page does not need one', async () => {
    const { token } = await payableBooking();

    const res = await request(appWithoutPayments()).post(`${bookingUrl(token)}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('cancelled_by_client');
  });

  it('needs no body, and ignores one that is not an object', async () => {
    const { token } = await payableBooking();

    const res = await request(appWith()).post(`${bookingUrl(token)}/cancel`).send('[1,2,3]').set('Content-Type', 'application/json');

    expect(res.status, res.text).toBe(200);
  });
});

// --- Paying the session fee ------------------------------------------------------------------

describe('POST /api/booking/:token/payments', () => {
  it('answers 201 with the pending payment’s our_ref, having prompted the normalised number for the outstanding amount', async () => {
    const { booking, token } = await payableBooking();
    const provider = stubProvider();

    const res = await request(appWith(provider)).post(`${bookingUrl(token)}/payments`).send(payBody());

    expect(res.status, res.text).toBe(201);
    expectNoStore(res);
    const session = (await paymentRows()).find((row) => row.kind === 'session_fee');
    expect(res.body).toStrictEqual({ payment: { ourRef: session?.our_ref, status: 'pending' } });
    expect(session).toMatchObject({ status: 'pending', amount_rwf: 30_000 });
    expect(provider.initiated).toStrictEqual([
      {
        ourRef: session?.our_ref,
        amountRwf: 30_000,
        method: 'momo_mtn',
        payerPhone: '+250788123456',
        kind: 'session_fee',
        bookingReference: booking.reference,
      },
    ]);
  });

  it('pays a completed booking too', async () => {
    const { token } = await payableBooking({ status: 'completed' });

    expect((await request(appWith()).post(`${bookingUrl(token)}/payments`).send(payBody())).status).toBe(201);
  });

  it('answers 409 payment_in_progress with the waiting attempt’s our_ref, prompting nothing', async () => {
    const { booking, token } = await payableBooking();
    const waiting = await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 30 });
    const provider = stubProvider();

    const res = await request(appWith(provider)).post(`${bookingUrl(token)}/payments`).send(payBody());

    expect(res.status, res.text).toBe(409);
    expect(res.body).toStrictEqual({ error: 'payment_in_progress', payment: { ourRef: waiting.ourRef } });
    expect(provider.initiated).toEqual([]);
  });

  it('answers a second press of Pay with the first attempt', async () => {
    const { token } = await payableBooking();
    const app = appWith();

    const first = await request(app).post(`${bookingUrl(token)}/payments`).send(payBody());
    const second = await request(app).post(`${bookingUrl(token)}/payments`).send(payBody());

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.payment.ourRef).toBe(first.body.payment.ourRef);
  });

  it.each([
    ['a booking paid in full', 'paid'],
    ['a cancelled booking', 'cancelled'],
    ['a booking still waiting for its fee', 'pending'],
  ])('answers 409 nothing_to_pay for %s, carrying the booking', async (_case, kind) => {
    const made = await payableBooking(kind === 'pending' ? { status: 'pending_payment' } : {});
    if (kind === 'paid') await insertPayment(prisma, made.booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000 });
    if (kind === 'cancelled') await prisma.booking.update({ where: { id: made.booking.id }, data: { status: 'cancelled_by_client' } });
    const provider = stubProvider();

    const res = await request(appWith(provider)).post(`${bookingUrl(made.token)}/payments`).send(payBody());

    expect(res.status, res.text).toBe(409);
    expect(res.body.error).toBe('nothing_to_pay');
    expect(res.body.booking.reference).toBe(made.booking.reference);
    expect(provider.initiated).toEqual([]);
  });

  it.each(['momo_airtel', 'card', 'bitcoin', '', 'MOMO_MTN'])('answers 422 on method for "%s", which the provider does not collect', async (method) => {
    const { token } = await payableBooking();
    const provider = stubProvider();

    const res = await request(appWith(provider)).post(`${bookingUrl(token)}/payments`).send(payBody({ method }));

    expect(res.status, res.text).toBe(422);
    expect(res.body).toStrictEqual({ error: 'validation_failed', fields: ['method'] });
    expectNoStore(res);
    expect(provider.initiated).toEqual([]);
    expect(await paymentRows()).toHaveLength(1);
  });

  it.each(['abc', '12345', '+250 78x 123 456', '', '   '])('answers 422 on phone for "%s"', async (phone) => {
    const { token } = await payableBooking();
    const provider = stubProvider();

    const res = await request(appWith(provider)).post(`${bookingUrl(token)}/payments`).send(payBody({ phone }));

    expect(res.status, res.text).toBe(422);
    expect(res.body).toStrictEqual({ error: 'validation_failed', fields: ['phone'] });
    expect(provider.initiated).toEqual([]);
  });

  it('names both fields when both are wrong, and echoes neither value', async () => {
    const { token } = await payableBooking();

    const res = await request(appWith()).post(`${bookingUrl(token)}/payments`).send({ method: 'card', phone: 'call-me-maybe' });

    expect(res.status).toBe(422);
    expect(res.body).toStrictEqual({ error: 'validation_failed', fields: ['method', 'phone'] });
    expect(res.text).not.toContain('call-me-maybe');
  });

  it.each([
    ['no method', { phone: '0788123456' }],
    ['no phone', { method: 'momo_mtn' }],
    ['a numeric phone', { method: 'momo_mtn', phone: 788_123_456 }],
    ['an empty body', {}],
  ])('answers 400 for %s', async (_case, body) => {
    const { token } = await payableBooking();
    const provider = stubProvider();

    const res = await request(appWith(provider)).post(`${bookingUrl(token)}/payments`).send(body);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'invalid_request' });
    expect(provider.initiated).toEqual([]);
  });

  it('answers 404 before it reads the body: a bad token with a bad body is still 404', async () => {
    await payableBooking();

    const res = await request(appWith()).post(`${bookingUrl('a'.repeat(43))}/payments`).send({ method: 'card' });

    expectNotFound(res);
    expect(await paymentRows()).toHaveLength(1);
  });

  it('answers 502 payment_not_started, reason rejected, carrying the failed attempt', async () => {
    const { token } = await payableBooking();
    const provider = stubProvider({ initiate: async () => ({ outcome: 'rejected', reason: 'PAYER_NOT_FOUND' }) });

    const res = await request(appWith(provider)).post(`${bookingUrl(token)}/payments`).send(payBody());

    const session = (await paymentRows()).find((row) => row.kind === 'session_fee');
    expect(res.status, res.text).toBe(502);
    expect(res.body).toStrictEqual({
      error: 'payment_not_started',
      reason: 'rejected',
      payment: { ourRef: session?.our_ref, status: 'failed' },
    });
    expect(res.text).not.toContain('PAYER_NOT_FOUND');
    expect(session?.status).toBe('failed');
  });

  it('answers 502, reason unavailable, when the provider does not answer in time', async () => {
    const { token } = await payableBooking();

    const res = await request(appWith(stubProvider({ initiate: () => new Promise(() => {}) }), 50))
      .post(`${bookingUrl(token)}/payments`)
      .send(payBody());

    expect(res.status, res.text).toBe(502);
    expect(res.body).toMatchObject({ error: 'payment_not_started', reason: 'unavailable' });
    const session = (await paymentRows()).find((row) => row.kind === 'session_fee');
    expect(session?.status).toBe('failed');
  });

  it('lets the client try again at once after a 502', async () => {
    const { token } = await payableBooking();
    let fail = true;
    const app = appWith(stubProvider({ initiate: async () => (fail ? { outcome: 'rejected', reason: 'X' } : { outcome: 'accepted', providerRef: null }) }));

    expect((await request(app).post(`${bookingUrl(token)}/payments`).send(payBody())).status).toBe(502);
    fail = false;
    expect((await request(app).post(`${bookingUrl(token)}/payments`).send(payBody())).status).toBe(201);
    expect((await paymentRows()).map((row) => row.status)).toEqual(['succeeded', 'failed', 'pending']);
  });

  it('offers a method only when the active provider collects it', async () => {
    const { token } = await payableBooking();
    const provider = stubProvider({ id: 'flutterwave', methods: ['momo_mtn', 'momo_airtel', 'card'] });

    const res = await request(appWith(provider)).post(`${bookingUrl(token)}/payments`).send(payBody({ method: 'momo_airtel', phone: '0731234567' }));

    expect(res.status, res.text).toBe(201);
    expect(provider.initiated[0]).toMatchObject({ method: 'momo_airtel' });
  });
});

// --- Mounting -------------------------------------------------------------------------------

describe('mounting', () => {
  it('has no payments route without a provider: 404, and nothing is started', async () => {
    const { token } = await payableBooking();

    const res = await request(appWithoutPayments()).post(`${bookingUrl(token)}/payments`).send(payBody());

    expect(res.status, res.text).toBe(404);
    expect(res.body).toStrictEqual({ error: 'not_found' });
    expect((await paymentRows()).filter((row) => row.kind === 'session_fee')).toEqual([]);
  });

  it('does not exist at all unless the public API is mounted', async () => {
    const { token } = await payableBooking();
    const app = createApp();

    expect((await request(app).get(bookingUrl(token))).status).toBe(404);
    expect((await request(app).post(`${bookingUrl(token)}/cancel`)).status).toBe(404);
    expect((await request(app).post(`${bookingUrl(token)}/payments`).send(payBody())).status).toBe(404);
    const row = await raw.query<{ status: string }>('SELECT status FROM booking');
    expect(row.rows).toEqual([{ status: 'confirmed' }]);
  });

  it('has nothing below the payments route: a deeper path is 404', async () => {
    const { token } = await payableBooking();

    expect((await request(appWith()).get(`${bookingUrl(token)}/payments/extra`)).status).toBe(404);
    expect((await request(appWith()).get(`${bookingUrl(token)}/anything`)).status).toBe(404);
  });
});

// --- A booking that never confirmed -----------------------------------------------------------

describe('a booking with no token', () => {
  it('is reachable by nothing: no id, no reference, no blank token', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const app = appWith();

    for (const path of [`/api/booking/${booking.id}`, `/api/booking/${booking.reference}`, '/api/booking/null', '/api/booking/undefined']) {
      expect((await request(app).get(path)).status, path).toBe(404);
    }
  });
});
