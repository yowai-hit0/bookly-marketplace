import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createPrismaClient } from '../db/client.js';
import { checkoutToken } from '../payments/checkout-link.js';
import type { PaymentProvider } from '../payments/provider.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  CLIENT,
  type PaymentWorld,
  type StubProvider,
  TEST_SECRET,
  UUID,
  insertBooking,
  insertPayment,
  mtnProvider,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';

/**
 * The checkout over HTTP (plan.md Task 16; spec §2.2 P-05, §3.1 steps 9-10,
 * §6.19), against real PostgreSQL with the provider stubbed or pointed at a fake
 * MTN.
 *
 * What is proven: `GET /api/payment-methods` reports exactly what the active
 * provider collects -- `['momo_mtn']` for MTN direct -- so the pay page never
 * hardcodes a method. A checkout opens only with its own token: a wrong,
 * foreign, re-signed, malformed or truncated token and an unknown reference are
 * the same 404. It describes the fee, the hold and the state (payable, paid,
 * expired, closed) and any payment still waiting, and never the client's
 * details or an id. Starting a payment is 201 with the new `our_ref`; a method
 * not on offer (Airtel, card) or an unusable number is a 422 naming the field
 * and prompts no phone; a booking fee already succeeded is 409 `already_paid`,
 * as are a lapsed hold, a zero fee and an attempt still waiting (with its
 * `our_ref`); a refusal, an unreachable provider or a timeout is a 502 carrying
 * the failed attempt. The status endpoint shows where a payment stands with a
 * coarse failure reason and no contact details. Everything is `no-store`, all of
 * it is anonymous, none of it exists unless payments are mounted -- and a booking
 * created through the API carries the token that opens its checkout.
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

function checkoutUrl(reference: string, token = checkoutToken(TEST_SECRET, reference)): string {
  return `/api/checkout/${reference}/${token}`;
}

function pay(app: Express, reference: string, body: unknown = { method: 'momo_mtn', phone: '078 812 3456' }, token?: string): request.Test {
  return request(app).post(`${checkoutUrl(reference, token)}/payments`).send(body as object);
}

async function paymentRows(): Promise<{ our_ref: string; status: string; amount_rwf: number; failure_reason: string | null }[]> {
  const result = await raw.query<{ our_ref: string; status: string; amount_rwf: number; failure_reason: string | null }>(
    'SELECT our_ref::text, status, amount_rwf, failure_reason FROM payment ORDER BY initiated_at',
  );
  return result.rows;
}

function expectNoStore(res: Response): void {
  expect(res.headers['cache-control']).toBe('no-store');
}

function expectNotFound(res: Response): void {
  expect(res.status, res.text).toBe(404);
  expect(res.body).toStrictEqual({ error: 'not_found' });
  expectNoStore(res);
}

/** Nothing about the client, and no internal id, in a response. */
async function expectNothingPrivate(res: Response, bookingId: string): Promise<void> {
  const secrets = [CLIENT.name, CLIENT.email, CLIENT.phone, '788123456', CLIENT.location, CLIENT.specialRequests, bookingId, world.clientId];
  const paymentIds = await raw.query<{ id: string }>('SELECT id::text FROM payment');
  for (const secret of [...secrets, ...paymentIds.rows.map((row) => row.id)]) expect(res.text).not.toContain(secret);
  for (const key of ['id', 'bookingId', 'clientId', 'contactEmail', 'contactPhone', 'contactName', 'accessToken', 'accessTokenHash', 'providerRef', 'failureReason']) {
    expect(res.text).not.toContain(`"${key}"`);
  }
}

// --- Methods --------------------------------------------------------------------------------

describe('GET /api/payment-methods', () => {
  it('reports MTN MoMo alone for MTN direct, no-store', async () => {
    const res = await request(appWith(mtnProvider())).get('/api/payment-methods');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ provider: 'mtn_momo_direct', methods: ['momo_mtn'] });
    expectNoStore(res);
  });

  it('reports whatever the active provider collects, in its order', async () => {
    const res = await request(appWith(stubProvider({ id: 'flutterwave', methods: ['card', 'momo_mtn', 'momo_airtel'] }))).get('/api/payment-methods');

    expect(res.body).toStrictEqual({ provider: 'flutterwave', methods: ['card', 'momo_mtn', 'momo_airtel'] });
  });

  it('reports methods even when the provider lacks credentials: availability is the phase, not the keys', async () => {
    const res = await request(appWith(mtnProvider({ credentials: false }))).get('/api/payment-methods');
    expect(res.body).toStrictEqual({ provider: 'mtn_momo_direct', methods: ['momo_mtn'] });
  });
});

// --- The checkout ----------------------------------------------------------------------------

describe('GET /api/checkout/:reference/:token', () => {
  it('answers a payable checkout in exactly the public shape', async () => {
    const booking = await insertBooking(prisma, world, { bookingFeeRwf: 19_500 });

    const res = await request(appWith()).get(checkoutUrl(booking.reference));

    expect(res.status).toBe(200);
    expectNoStore(res);
    expect(res.body).toStrictEqual({
      checkout: {
        reference: booking.reference,
        serviceName: 'Portraits',
        packageName: 'Standard',
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        holdExpiresAt: booking.holdExpiresAt?.toISOString(),
        bookingFeeRwf: 19_500,
        state: 'payable',
        waitingPayment: null,
      },
    });
    await expectNothingPrivate(res, booking.id);
  });

  it('names the most recent attempt still waiting on the payer', async () => {
    const booking = await insertBooking(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'pending', ageSeconds: 600 });
    const latest = await insertPayment(prisma, booking.id, { status: 'initiated', ageSeconds: 5 });
    await insertPayment(prisma, booking.id, { status: 'failed', ageSeconds: 1 });

    const res = await request(appWith()).get(checkoutUrl(booking.reference));

    expect(res.body.checkout.waitingPayment).toStrictEqual({ ourRef: latest.ourRef });
  });

  it('names no waiting attempt when the only attempts failed', async () => {
    const booking = await insertBooking(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'failed' });

    const res = await request(appWith()).get(checkoutUrl(booking.reference));

    expect(res.body.checkout).toMatchObject({ state: 'payable', waitingPayment: null });
  });

  it.each([
    ['paid', 'a confirmed booking with its fee', { status: 'confirmed' }, 'succeeded'],
    ['paid', 'a booking whose fee succeeded while its hold still shows', { status: 'pending_payment' }, 'succeeded'],
    ['expired', 'a lapsed hold the sweeper has not reached', { status: 'pending_payment', holdMinutes: -1 }, null],
    ['expired', 'an expired booking', { status: 'expired' }, null],
    ['expired', 'a pending_payment booking with no hold', { status: 'pending_payment', holdMinutes: null }, null],
    ['closed', 'a zero fee', { bookingFeeRwf: 0 }, null],
    ['closed', 'a confirmed booking with no fee on record', { status: 'confirmed' }, null],
    ['closed', 'a cancelled booking', { status: 'cancelled_by_client' }, null],
    ['closed', 'a completed booking', { status: 'completed' }, null],
    ['expired', 'an expired booking whose late fee is owed back', { status: 'expired' }, 'refund_due'],
  ])('is %s for %s', async (state, _case, seed, feeStatus) => {
    const booking = await insertBooking(prisma, world, seed);
    if (feeStatus !== null) await insertPayment(prisma, booking.id, { status: feeStatus });

    const res = await request(appWith()).get(checkoutUrl(booking.reference));

    expect(res.status).toBe(200);
    expect(res.body.checkout.state).toBe(state);
  });

  it('opens with the token again and again: a reload still works', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();

    for (let i = 0; i < 3; i += 1) expect((await request(app).get(checkoutUrl(booking.reference))).status).toBe(200);
  });

  it('is 404 for another booking’s token, a token under another secret, and a token one character off', async () => {
    const booking = await insertBooking(prisma, world);
    const other = await insertBooking(prisma, world);
    const token = checkoutToken(TEST_SECRET, booking.reference);
    const app = appWith();

    expectNotFound(await request(app).get(checkoutUrl(booking.reference, checkoutToken(TEST_SECRET, other.reference))));
    expectNotFound(await request(app).get(checkoutUrl(booking.reference, checkoutToken(`${TEST_SECRET}-other`, booking.reference))));
    expectNotFound(await request(app).get(checkoutUrl(booking.reference, `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)));
  });

  it('is 404 for a well-formed reference with its valid token when no such booking exists', async () => {
    expectNotFound(await request(appWith()).get(checkoutUrl('BKY-2610-ZZZZZ')));
  });

  it.each([
    ['a lower-case reference', (ref: string, token: string) => `/api/checkout/${ref.toLowerCase()}/${token}`],
    ['a reference with a letter Crockford excludes', (_ref: string, token: string) => `/api/checkout/BKY-2610-7K3QI/${token}`],
    ['a truncated token', (ref: string, token: string) => `/api/checkout/${ref}/${token.slice(0, 42)}`],
    ['a padded token', (ref: string, token: string) => `/api/checkout/${ref}/${token}=`],
    ['a token in standard base64', (ref: string, token: string) => `/api/checkout/${ref}/${token.replaceAll('-', '+').replaceAll('_', '%2F')}X`],
    ['a missing token', (ref: string) => `/api/checkout/${ref}/`],
    ['a percent-encoded token', (ref: string, token: string) => `/api/checkout/${ref}/${encodeURIComponent(`${token.slice(0, 40)}/..`)}`],
  ])('is 404 for %s', async (_case, url) => {
    const booking = await insertBooking(prisma, world);
    const res = await request(appWith()).get(url(booking.reference, checkoutToken(TEST_SECRET, booking.reference)));
    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'not_found' });
  });

  it('is anonymous: a bogus Authorization header changes nothing', async () => {
    const booking = await insertBooking(prisma, world);
    const res = await request(appWith()).get(checkoutUrl(booking.reference)).set('Authorization', 'Bearer not-a-token');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

// --- Starting a payment ------------------------------------------------------------------------

describe('POST /api/checkout/:reference/:token/payments', () => {
  it('answers 201 with the pending payment’s our_ref, having prompted the normalised number for the frozen fee', async () => {
    const booking = await insertBooking(prisma, world, { bookingFeeRwf: 19_500 });
    const provider = stubProvider();

    const res = await pay(appWith(provider), booking.reference, { method: 'momo_mtn', phone: '078 812 3456' });

    expect(res.status, res.text).toBe(201);
    expectNoStore(res);
    const [row] = await paymentRows();
    expect(res.body).toStrictEqual({ payment: { ourRef: row?.our_ref, status: 'pending' } });
    expect(row).toMatchObject({ status: 'pending', amount_rwf: 19_500 });
    expect(provider.initiated).toStrictEqual([
      { ourRef: row?.our_ref, amountRwf: 19_500, method: 'momo_mtn', payerPhone: '+250788123456', kind: 'booking_fee', bookingReference: booking.reference },
    ]);
    await expectNothingPrivate(res, booking.id);
  });

  it('sends MTN the our_ref it answers, as X-Reference-Id', async () => {
    const booking = await insertBooking(prisma, world);
    const referenceIds: (string | null)[] = [];
    const provider = mtnProvider({
      fetch: (async (input: string, init?: RequestInit) => {
        if (String(input).endsWith('/collection/token/')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
        referenceIds.push(new Headers(init?.headers).get('X-Reference-Id'));
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    });

    const res = await pay(appWith(provider), booking.reference);

    expect(res.status).toBe(201);
    expect(res.body.payment.ourRef).toMatch(UUID);
    expect(referenceIds).toEqual([res.body.payment.ourRef]);
  });

  it('ignores any amount, status or reference the body carries', async () => {
    const booking = await insertBooking(prisma, world);

    const res = await pay(appWith(), booking.reference, {
      method: 'momo_mtn',
      phone: '0788123456',
      amountRwf: 1,
      amount: 1,
      status: 'succeeded',
      ourRef: '00000000-0000-4000-8000-000000000000',
      reference: 'BKY-2610-ZZZZZ',
    });

    expect(res.status).toBe(201);
    expect(res.body.payment.ourRef).not.toBe('00000000-0000-4000-8000-000000000000');
    expect(await paymentRows()).toMatchObject([{ status: 'pending', amount_rwf: 20_000 }]);
  });

  describe('refuses before any payment exists', () => {
    async function expectNothingStarted(provider: StubProvider): Promise<void> {
      expect(provider.initiated).toEqual([]);
      expect(await paymentRows()).toEqual([]);
    }

    it('404 for a wrong token', async () => {
      const booking = await insertBooking(prisma, world);
      const other = await insertBooking(prisma, world);
      const provider = stubProvider();

      expectNotFound(await pay(appWith(provider), booking.reference, undefined, checkoutToken(TEST_SECRET, other.reference)));
      await expectNothingStarted(provider);
    });

    it('404 for an unknown reference with its valid token', async () => {
      const provider = stubProvider();
      expectNotFound(await pay(appWith(provider), 'BKY-2610-ZZZZZ'));
      await expectNothingStarted(provider);
    });

    it('404 before reading the body: a wrong token with a bad body is still 404', async () => {
      const booking = await insertBooking(prisma, world);
      expectNotFound(await pay(appWith(), booking.reference, { method: 'card' }, 'x'.repeat(43)));
    });

    it.each(['momo_airtel', 'card', 'bitcoin', '', 'MOMO_MTN'])('422 on method for "%s", which MTN direct does not offer', async (method) => {
      const booking = await insertBooking(prisma, world);
      const provider = stubProvider();

      const res = await pay(appWith(provider), booking.reference, { method, phone: '0788123456' });

      expect(res.status).toBe(422);
      expect(res.body).toStrictEqual({ error: 'validation_failed', fields: ['method'] });
      expectNoStore(res);
      await expectNothingStarted(provider);
    });

    it('offers Airtel and card only when the active provider lists them', async () => {
      const booking = await insertBooking(prisma, world);
      const provider = stubProvider({ id: 'flutterwave', methods: ['momo_mtn', 'momo_airtel', 'card'] });

      const res = await pay(appWith(provider), booking.reference, { method: 'momo_airtel', phone: '0731234567' });

      expect(res.status).toBe(201);
      expect(provider.initiated[0]).toMatchObject({ method: 'momo_airtel' });
    });

    it.each(['abc', '12345', '+250 78x 123 456', '0788123456789012345', `+${'2'.repeat(15)} ${'-'.repeat(30)}`, '', '   '])(
      '422 on phone for "%s"',
      async (phone) => {
        const booking = await insertBooking(prisma, world);
        const provider = stubProvider();

        const res = await pay(appWith(provider), booking.reference, { method: 'momo_mtn', phone });

        expect(res.status, res.text).toBe(422);
        expect(res.body).toStrictEqual({ error: 'validation_failed', fields: ['phone'] });
        await expectNothingStarted(provider);
      },
    );

    it('422 naming both fields when both are wrong, and never echoing either value', async () => {
      const booking = await insertBooking(prisma, world);

      const res = await pay(appWith(), booking.reference, { method: 'card', phone: 'call-me-maybe' });

      expect(res.status).toBe(422);
      expect(res.body).toStrictEqual({ error: 'validation_failed', fields: ['method', 'phone'] });
      expect(res.text).not.toContain('call-me-maybe');
    });

    it.each([
      ['no method', { phone: '0788123456' }],
      ['no phone', { method: 'momo_mtn' }],
      ['a numeric method', { method: 1, phone: '0788123456' }],
      ['a numeric phone', { method: 'momo_mtn', phone: 788123456 }],
      ['an empty body', {}],
      ['an array', [{ method: 'momo_mtn', phone: '0788123456' }]],
    ])('400 for %s', async (_case, body) => {
      const booking = await insertBooking(prisma, world);
      const provider = stubProvider();

      const res = await pay(appWith(provider), booking.reference, body);

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual({ error: 'invalid_request' });
      await expectNothingStarted(provider);
    });

    it('400 for a body that is not JSON', async () => {
      const booking = await insertBooking(prisma, world);
      const res = await request(appWith()).post(`${checkoutUrl(booking.reference)}/payments`).set('Content-Type', 'application/json').send('{"method":');
      expect(res.status).toBe(400);
      expect(await paymentRows()).toEqual([]);
    });
  });

  it('409 already_paid for a booking with a succeeded booking fee, prompting no phone', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await insertPayment(prisma, booking.id, { status: 'succeeded' });
    const provider = stubProvider();

    const res = await pay(appWith(provider), booking.reference);

    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual({ error: 'already_paid' });
    expectNoStore(res);
    expect(provider.initiated).toEqual([]);
    expect(await paymentRows()).toHaveLength(1);
  });

  it.each([
    ['hold_expired', 'a lapsed hold', { holdMinutes: -1 }],
    ['hold_expired', 'an expired booking', { status: 'expired' }],
    ['hold_expired', 'a cancelled booking', { status: 'cancelled_by_admin' }],
    ['nothing_to_pay', 'a zero fee', { bookingFeeRwf: 0 }],
  ])('409 %s for %s', async (error, _case, seed) => {
    const booking = await insertBooking(prisma, world, seed);
    const provider = stubProvider();

    const res = await pay(appWith(provider), booking.reference);

    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual({ error });
    expect(provider.initiated).toEqual([]);
  });

  it('409 payment_in_progress with the waiting attempt’s our_ref', async () => {
    const booking = await insertBooking(prisma, world);
    const waiting = await insertPayment(prisma, booking.id, { status: 'pending', ageSeconds: 30 });

    const res = await pay(appWith(), booking.reference);

    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual({ error: 'payment_in_progress', payment: { ourRef: waiting.ourRef } });
  });

  it('answers a second press of Pay with the first attempt: one 201, then 409 naming it', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();

    const first = await pay(app, booking.reference);
    const second = await pay(app, booking.reference);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.payment.ourRef).toBe(first.body.payment.ourRef);
    expect(await paymentRows()).toHaveLength(1);
  });

  it('502 payment_not_started, reason rejected, carrying the failed attempt, when the provider refuses', async () => {
    const booking = await insertBooking(prisma, world);

    const res = await pay(appWith(stubProvider({ initiate: async () => ({ outcome: 'rejected', reason: 'PAYER_NOT_FOUND' }) })), booking.reference);

    const [row] = await paymentRows();
    expect(res.status).toBe(502);
    expect(res.body).toStrictEqual({ error: 'payment_not_started', reason: 'rejected', payment: { ourRef: row?.our_ref, status: 'failed' } });
    expectNoStore(res);
    expect(res.text).not.toContain('PAYER_NOT_FOUND');
    expect(row).toMatchObject({ status: 'failed', failure_reason: 'PAYER_NOT_FOUND' });
  });

  it.each([
    ['throws', { provider: () => stubProvider({ initiate: async () => Promise.reject(new Error('down')) }), timeout: undefined, reason: 'provider_unavailable: Error' }],
    ['does not answer in time', { provider: () => stubProvider({ initiate: () => new Promise(() => {}) }), timeout: 50, reason: 'provider_timeout' }],
    ['has no credentials', { provider: () => mtnProvider({ credentials: false }), timeout: undefined, reason: expect.stringMatching(/^provider_unavailable: MTN MoMo is not configured/) }],
  ])('502 payment_not_started, reason unavailable, when the provider %s', async (_case, { provider, timeout, reason }) => {
    const booking = await insertBooking(prisma, world);

    const res = await pay(appWith(provider(), timeout), booking.reference);

    const [row] = await paymentRows();
    expect(res.status).toBe(502);
    expect(res.body).toStrictEqual({ error: 'payment_not_started', reason: 'unavailable', payment: { ourRef: row?.our_ref, status: 'failed' } });
    expect(row).toMatchObject({ status: 'failed', failure_reason: reason });
    expect(await raw.query('SELECT status FROM booking').then((result) => result.rows)).toEqual([{ status: 'pending_payment' }]);
  });

  it('lets the payer try again at once after a 502', async () => {
    const booking = await insertBooking(prisma, world);
    let fail = true;
    const app = appWith(stubProvider({ initiate: async () => (fail ? { outcome: 'rejected', reason: 'X' } : { outcome: 'accepted', providerRef: null }) }));

    expect((await pay(app, booking.reference)).status).toBe(502);
    fail = false;
    expect((await pay(app, booking.reference)).status).toBe(201);
    expect((await paymentRows()).map((row) => row.status)).toEqual(['failed', 'pending']);
  });
});

// --- Following a payment --------------------------------------------------------------------------

describe('GET /api/payments/:ourRef', () => {
  it('answers where the payment and its booking stand, in exactly the public shape', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'pending', amountRwf: 20_000, providerRef: 'PROVIDER-SECRET-REF' });

    const res = await request(appWith()).get(`/api/payments/${payment.ourRef}`);

    expect(res.status).toBe(200);
    expectNoStore(res);
    expect(res.body).toStrictEqual({
      payment: { status: 'pending', amountRwf: 20_000, failure: null },
      booking: {
        reference: booking.reference,
        status: 'pending_payment',
        serviceName: 'Portraits',
        packageName: 'Standard',
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
      },
    });
    await expectNothingPrivate(res, booking.id);
    expect(res.text).not.toContain('PROVIDER-SECRET-REF');
  });

  it.each([
    ['PAYER_NOT_FOUND', 'declined'],
    ['APPROVAL_REJECTED', 'declined'],
    ['TIMEOUT', 'declined'],
    [null, 'declined'],
    ['provider_timeout', 'unavailable'],
    ['provider_unavailable: MTN MoMo answered 503', 'unavailable'],
  ])('reads a failure recorded as %s as %s, never quoting it', async (failureReason, failure) => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'failed', failureReason });

    const res = await request(appWith()).get(`/api/payments/${payment.ourRef}`);

    expect(res.body.payment).toStrictEqual({ status: 'failed', amountRwf: 20_000, failure });
    if (failureReason !== null) expect(res.text).not.toContain(failureReason);
  });

  it.each(['initiated', 'pending', 'succeeded', 'refund_due', 'refunded'])('has no failure for a %s payment', async (status) => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const payment = await insertPayment(prisma, booking.id, { status, failureReason: 'stale' });

    const res = await request(appWith()).get(`/api/payments/${payment.ourRef}`);

    expect(res.body.payment).toStrictEqual({ status, amountRwf: 20_000, failure: null });
  });

  it('shows a confirmed booking without its access token or hash', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await raw.query('UPDATE booking SET access_token_hash = $1 WHERE id = $2', ['deadbeef'.repeat(8), booking.id]);
    const payment = await insertPayment(prisma, booking.id, { status: 'succeeded' });

    const res = await request(appWith()).get(`/api/payments/${payment.ourRef}`);

    expect(res.body.booking.status).toBe('confirmed');
    expect(res.text).not.toContain('deadbeef');
  });

  it('accepts an upper-case our_ref', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id);

    expect((await request(appWith()).get(`/api/payments/${payment.ourRef.toUpperCase()}`)).status).toBe(200);
  });

  it.each(['00000000-0000-4000-8000-000000000000', 'not-a-uuid', "1' OR '1'='1", '%00'])('is 404 for %s', async (ourRef) => {
    const booking = await insertBooking(prisma, world);
    await insertPayment(prisma, booking.id);

    const res = await request(appWith()).get(`/api/payments/${encodeURIComponent(ourRef)}`);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'not_found' });
  });
});

// --- Mounting and the booking's token ------------------------------------------------------------

describe('mounting', () => {
  it('is absent unless payments are configured: every route 404s', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id);

    for (const app of [createApp(), createApp({ publicApi: { prisma, now: () => NOW } })]) {
      expect((await request(app).get('/api/payment-methods')).status).toBe(404);
      expect((await request(app).get(checkoutUrl(booking.reference))).status).toBe(404);
      expect((await pay(app, booking.reference)).status).toBe(404);
      expect((await request(app).get(`/api/payments/${payment.ourRef}`)).status).toBe(404);
    }
    expect(await paymentRows()).toHaveLength(1);
  });
});

describe('POST /api/bookings with payments mounted', () => {
  beforeEach(async () => {
    await prisma.workingHours.createMany({ data: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinute: 540, closesMinute: 1020 })) });
  });

  const body = () => ({
    packageId: world.packageId,
    addonIds: [world.ownAddonId],
    startsAt: '2026-10-07T09:00:00+02:00',
    fullName: 'Aline Uwase',
    email: 'aline@example.com',
    phone: '0788123456',
    location: 'Kigali Heights',
    partySize: 3,
    specialRequests: null,
    consent: true,
  });

  it('carries the checkout token for the new booking, which opens a payable checkout that can be paid', async () => {
    const app = appWith();

    const created = await request(app).post('/api/bookings').send(body());

    expect(created.status, created.text).toBe(201);
    const { reference, checkoutToken: token } = created.body.booking as { reference: string; checkoutToken: string };
    expect(token).toBe(checkoutToken(TEST_SECRET, reference));

    const checkout = await request(app).get(checkoutUrl(reference, token));
    expect(checkout.status).toBe(200);
    expect(checkout.body.checkout).toMatchObject({ reference, state: 'payable', bookingFeeRwf: 20_000, holdExpiresAt: created.body.booking.holdExpiresAt });

    const paid = await pay(app, reference, undefined, token);
    expect(paid.status).toBe(201);
    const progress = await request(app).get(`/api/payments/${paid.body.payment.ourRef}`);
    expect(progress.body).toMatchObject({ payment: { status: 'pending', amountRwf: 20_000 }, booking: { reference, status: 'pending_payment' } });
  });

  it('carries no checkout token when payments are not mounted', async () => {
    const created = await request(createApp({ publicApi: { prisma, now: () => NOW } })).post('/api/bookings').send(body());

    expect(created.status).toBe(201);
    expect(created.body.booking).not.toHaveProperty('checkoutToken');
  });

  it('gives each booking its own token', async () => {
    const app = appWith();
    const first = await request(app).post('/api/bookings').send(body());
    const second = await request(app).post('/api/bookings').send({ ...body(), startsAt: '2026-10-08T09:00:00+02:00' });

    expect(first.body.booking.checkoutToken).not.toBe(second.body.booking.checkoutToken);
    expect((await request(app).get(checkoutUrl(first.body.booking.reference, second.body.booking.checkoutToken))).status).toBe(404);
  });
});
