import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createPrismaClient } from '../db/client.js';
import { checkoutToken } from '../payments/checkout-link.js';
import { FLUTTERWAVE_WEBHOOK_PATH, FlutterwaveProvider } from '../payments/flutterwave.js';
import { reconcilePendingPayments } from '../payments/reconcile.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  ADMIN_EMAIL,
  type PaymentWorld,
  TEST_SECRET,
  callbackPath,
  insertBooking,
  insertPayment,
  logSink,
  mtnProvider,
  mtnStatusBody,
  seedWorld,
} from '../test/payment-fixtures.js';

/**
 * Flutterwave end to end (plan.md Task 25; spec §3.1 steps 9-12, §6.18;
 * data-model_v2.md §7.3), against real PostgreSQL. Flutterwave is the real
 * provider in front of a fake Flutterwave, so a payment is started through the
 * checkout exactly as the pay page starts it, and settled by a webhook signed
 * the way Flutterwave signs one.
 *
 * What is proven: the checkout offers MTN MoMo and Airtel Money; a payment
 * started through it is `pending` under `flutterwave` with the `chg_` id as
 * `provider_ref`; a signed `charge.completed` at the static webhook URL confirms
 * the booking and queues both emails; a forged one is stored
 * `signature_valid = false` and applies nothing, and is answered 200 all the
 * same; a webhook and a lookup of the same outcome are one event; a failure is
 * recorded with the processor code; and MTN's callbacks are still accepted
 * beside Flutterwave's.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let sink: ReturnType<typeof logSink>;

const NOW = new Date('2026-10-01T06:00:00Z');
const HASH = 'flutterwave-dashboard-secret-hash';
const CHARGE_ID = 'chg_wzRkqRwy6C';

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
  sink = logSink();
});

// --- Helpers ----------------------------------------------------------------------------

type FakeFlutterwave = { provider: FlutterwaveProvider; charges: Record<string, unknown>[]; lookup: { answer: unknown[] } };

/** The real provider in front of a fake Flutterwave that takes every charge as pending. */
function fakeFlutterwave(): FakeFlutterwave {
  const charges: Record<string, unknown>[] = [];
  const lookup: { answer: unknown[] } = { answer: [] };
  const provider = new FlutterwaveProvider({
    baseUrl: 'https://flutterwave.test',
    tokenUrl: 'https://idp.flutterwave.test/token',
    clientId: 'client',
    clientSecret: 'secret',
    webhookHash: HASH,
    currency: 'RWF',
    fetch: (async (input: string, init?: RequestInit) => {
      const url = String(input);
      const reply = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status });
      if (url.endsWith('/token')) return reply({ access_token: 't', expires_in: 600 }, 200);
      if (url.endsWith('/customers')) return reply({ data: { id: 'cus_1' } });
      if (url.endsWith('/payment-methods')) return reply({ data: { id: 'pmd_1' } });
      if (url.includes('/charges?reference=')) return reply({ data: lookup.answer }, 200);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      charges.push(body);
      return reply({ data: { id: CHARGE_ID, reference: body.reference, status: 'pending', next_action: { type: 'payment_instruction' } } });
    }) as typeof fetch,
  });
  return { provider, charges, lookup };
}

function appWith(fw: FakeFlutterwave): Express {
  const mtn = mtnProvider();
  return createApp({
    publicApi: { prisma, now: () => NOW, payments: { provider: fw.provider, secret: TEST_SECRET } },
    webhooks: { prisma, providers: { mtn_momo_direct: mtn, flutterwave: fw.provider }, log: sink.log },
  });
}

async function startPayment(app: Express, reference: string, method = 'momo_mtn', phone = '0788123456'): Promise<string> {
  const res = await request(app).post(`/api/checkout/${reference}/${checkoutToken(TEST_SECRET, reference)}/payments`).send({ method, phone });
  expect(res.status, res.text).toBe(201);
  return res.body.payment.ourRef as string;
}

function charge(ourRef: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: CHARGE_ID,
    reference: ourRef,
    status,
    amount: 20_000,
    currency: 'RWF',
    payment_method: { type: 'mobile_money', mobile_money: { country_code: '250', network: 'MTN', phone_number: '788123456' } },
    ...extra,
  };
}

function webhook(app: Express, data: unknown, key = HASH): request.Test {
  const text = JSON.stringify({ id: 'wbk_W5p6ktwU0jQ8RO4By860', type: 'charge.completed', timestamp: 1735116884019, data });
  return request(app)
    .post(FLUTTERWAVE_WEBHOOK_PATH)
    .set('Content-Type', 'application/json')
    .set('flutterwave-signature', createHmac('sha256', key).update(text).digest('base64'))
    .send(text);
}

function expectReceived(res: request.Response): void {
  expect(res.status, res.text).toBe(200);
  expect(res.body).toStrictEqual({ received: true });
}

async function rows<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await raw.query<T>(sql, params)).rows;
}

async function bookingStatus(reference: string): Promise<string> {
  return firstRow(await raw.query<{ status: string }>('SELECT status FROM booking WHERE reference = $1', [reference])).status;
}

// --- Tests --------------------------------------------------------------------------------

describe('the checkout with Flutterwave active', () => {
  it('offers MTN MoMo and Airtel Money', async () => {
    const res = await request(appWith(fakeFlutterwave())).get('/api/payment-methods');
    expect(res.status, res.text).toBe(200);
    expect(res.body).toStrictEqual({ provider: 'flutterwave', methods: ['momo_mtn', 'momo_airtel'] });
  });

  it('records the attempt pending under flutterwave, with the charge id as provider_ref and our_ref as reference', async () => {
    const fw = fakeFlutterwave();
    const booking = await insertBooking(prisma, world);
    const ourRef = await startPayment(appWith(fw), booking.reference, 'momo_airtel', '0731234567');

    expect(fw.charges).toMatchObject([{ reference: ourRef, amount: 20_000, currency: 'RWF' }]);
    expect(await rows('SELECT provider, status, provider_ref, our_ref::text AS our_ref FROM payment')).toEqual([
      { provider: 'flutterwave', status: 'pending', provider_ref: CHARGE_ID, our_ref: ourRef },
    ]);
  });
});

describe('a signed charge.completed at /api/webhooks/flutterwave', () => {
  it('confirms the booking, records the payment and queues both emails', async () => {
    const fw = fakeFlutterwave();
    const app = appWith(fw);
    const booking = await insertBooking(prisma, world);
    const ourRef = await startPayment(app, booking.reference);

    expectReceived(await webhook(app, charge(ourRef, 'succeeded')));

    expect(await bookingStatus(booking.reference)).toBe('confirmed');
    expect(await rows('SELECT status, provider_ref, method, amount_rwf FROM payment')).toEqual([
      { status: 'succeeded', provider_ref: CHARGE_ID, method: 'momo_mtn', amount_rwf: 20_000 },
    ]);
    expect((await rows<{ template: string; recipient: string }>('SELECT template, recipient FROM outbox ORDER BY template')).map((r) => [r.template, r.recipient])).toEqual([
      ['admin_new_booking', ADMIN_EMAIL],
      ['booking_confirmation', 'aline.private@example.com'],
    ]);
    expect(await rows('SELECT event_id, status, signature_valid FROM webhook_event')).toEqual([
      { event_id: `${ourRef}:SUCCEEDED`, status: 'applied', signature_valid: true },
    ]);
  });

  it('records a failure with the processor code, leaving the booking waiting', async () => {
    const app = appWith(fakeFlutterwave());
    const booking = await insertBooking(prisma, world);
    const ourRef = await startPayment(app, booking.reference);

    expectReceived(await webhook(app, charge(ourRef, 'failed', { processor_response: { type: 'failed', code: '06' } })));

    expect(await bookingStatus(booking.reference)).toBe('pending_payment');
    expect(await rows('SELECT status, failure_reason FROM payment')).toEqual([{ status: 'failed', failure_reason: 'charge_failed_06' }]);
  });

  it('refuses a forgery: stored unverified, applying nothing, answered 200 all the same', async () => {
    const app = appWith(fakeFlutterwave());
    const booking = await insertBooking(prisma, world);
    const ourRef = await startPayment(app, booking.reference);

    expectReceived(await webhook(app, charge(ourRef, 'succeeded'), 'a-guessed-hash'));
    const unsigned = await request(app).post(FLUTTERWAVE_WEBHOOK_PATH).set('Content-Type', 'application/json').send(JSON.stringify({ type: 'charge.completed', data: charge(ourRef, 'succeeded') }));
    expectReceived(unsigned);

    expect(await bookingStatus(booking.reference)).toBe('pending_payment');
    expect(await rows('SELECT status FROM payment')).toEqual([{ status: 'pending' }]);
    expect(await rows('SELECT status, signature_valid FROM webhook_event')).toEqual([
      { status: 'ignored', signature_valid: false },
      { status: 'ignored', signature_valid: false },
    ]);
  });

  it('is one event with a lookup of the same outcome: whichever comes second changes nothing', async () => {
    const fw = fakeFlutterwave();
    const app = appWith(fw);
    const booking = await insertBooking(prisma, world);
    const ourRef = await startPayment(app, booking.reference);
    await raw.query("UPDATE payment SET initiated_at = now() - interval '2 minutes'");

    fw.lookup.answer = [charge(ourRef, 'succeeded')];
    expect(await reconcilePendingPayments({ prisma, provider: fw.provider, log: sink.log })).toBe(1);
    expectReceived(await webhook(app, charge(ourRef, 'succeeded')));

    expect(await bookingStatus(booking.reference)).toBe('confirmed');
    expect(await rows("SELECT count(*)::int AS n FROM outbox WHERE template = 'booking_confirmation'")).toEqual([{ n: 1 }]);
    expect(await rows('SELECT status FROM webhook_event ORDER BY received_at')).toEqual([{ status: 'applied' }, { status: 'ignored' }]);
  });
});

describe('beside MTN', () => {
  it('keeps accepting MTN callbacks for MTN payments while Flutterwave is active (spec §6.18)', async () => {
    const mtn = mtnProvider();
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'pending' });
    const app = createApp({
      publicApi: { prisma, payments: { provider: fakeFlutterwave().provider, secret: TEST_SECRET } },
      webhooks: { prisma, providers: { mtn_momo_direct: mtn, flutterwave: fakeFlutterwave().provider }, log: sink.log },
    });

    const res = await request(app)
      .post(callbackPath(mtn, payment.ourRef))
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(mtnStatusBody(payment.ourRef, 'SUCCESSFUL')));

    expectReceived(res);
    expect(await bookingStatus(booking.reference)).toBe('confirmed');
  });

  it('never lets a Flutterwave webhook settle an MTN payment', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'pending' });

    expectReceived(await webhook(appWith(fakeFlutterwave()), charge(payment.ourRef, 'succeeded')));

    expect(await bookingStatus(booking.reference)).toBe('pending_payment');
    expect(await rows('SELECT processing_error FROM webhook_event')).toEqual([{ processing_error: 'no_matching_payment' }]);
  });
});
