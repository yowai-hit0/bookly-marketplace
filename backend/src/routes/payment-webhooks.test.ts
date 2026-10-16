import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashAccessToken } from '../booking/access-token.js';
import { createPrismaClient } from '../db/client.js';
import { renderEmail } from '../email/render.js';
import { checkoutToken } from '../payments/checkout-link.js';
import type { MtnMomoProvider } from '../payments/mtn-momo.js';
import type { PaymentProvider } from '../payments/provider.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  ADMIN_EMAIL,
  API_ORIGIN,
  DAY_MS,
  type PaymentWorld,
  TEST_SECRET,
  callbackPath,
  insertBooking,
  insertPayment,
  logSink,
  mtnProvider,
  mtnStatusBody,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';

/**
 * Provider callbacks over HTTP (plan.md Task 17; spec §3.1 steps 10-12, §6.9,
 * §6.18; data-model_v2.md §7.3), against real PostgreSQL. MTN is the real
 * provider pointed at a fake MTN, so a payment is started through the checkout
 * and its callback is POSTed to the very URL MTN was handed.
 *
 * What is proven: the route reads the raw body -- the exact bytes, whitespace,
 * key order, invalid JSON and all, for `application/json` and every other type,
 * by POST and by PUT -- so `express.json()`, which still parses every other
 * route of the same app, never consumes it first. A verified success confirms
 * the booking (hold nulled, `confirmed_at`, token hash and 365-day expiry, both
 * emails, a paid checkout that answers a second payment with 409). A duplicate is
 * one applied and one ignored row and one confirmation, concurrently too; a bad
 * signature is stored unverified, applies nothing, and is answered 200 with the
 * same body as anything else; an unmatched event is 200 and kept; a late success
 * re-confirms or is flagged for refund; a processing failure is a 500 whose retry
 * is processed. The plaintext token, generated for real, is in the outbox payload
 * and in no column of any table and no response. Unusable bodies are stored and
 * answered 200; an oversized one is a 413, never a 500. Only POST and PUT on the
 * exact path exist, and only when webhooks are mounted.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let sink: ReturnType<typeof logSink>;

const NOW = new Date('2026-10-01T06:00:00Z');
const WEB_ORIGIN = 'https://bookly.example';

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

type FakeMtn = { provider: MtnMomoProvider; callbacks: string[]; referenceIds: string[] };

/** The real MTN provider in front of a fake MTN that accepts every request to pay. */
function fakeMtn(): FakeMtn {
  const callbacks: string[] = [];
  const referenceIds: string[] = [];
  const provider = mtnProvider({
    fetch: (async (input: string, init?: RequestInit) => {
      if (String(input).endsWith('/collection/token/')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      const headers = new Headers(init?.headers);
      callbacks.push(headers.get('X-Callback-Url') ?? '');
      referenceIds.push(headers.get('X-Reference-Id') ?? '');
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });
  return { provider, callbacks, referenceIds };
}

function appWith(provider: PaymentProvider, extra: { newAccessToken?: () => { token: string; hash: string } } = {}): Express {
  return createApp({
    publicApi: { prisma, now: () => NOW, payments: { provider, secret: TEST_SECRET } },
    webhooks: { prisma, providers: { mtn_momo_direct: provider }, log: sink.log, ...extra },
  });
}

/** Starts a booking-fee payment through the checkout; answers its our_ref and the callback path MTN was given. */
async function startPayment(app: Express, mtn: FakeMtn, reference: string): Promise<{ ourRef: string; path: string }> {
  const res = await request(app)
    .post(`/api/checkout/${reference}/${checkoutToken(TEST_SECRET, reference)}/payments`)
    .send({ method: 'momo_mtn', phone: '0788123456' });
  expect(res.status, res.text).toBe(201);
  const ourRef = res.body.payment.ourRef as string;
  const callback = mtn.callbacks.at(-1) ?? '';
  expect(callback.startsWith(`${API_ORIGIN}/api/webhooks/mtn-momo/${ourRef}/`)).toBe(true);
  expect(mtn.referenceIds.at(-1)).toBe(ourRef);
  return { ourRef, path: new URL(callback).pathname };
}

function callback(app: Express, path: string, body: unknown, method: 'post' | 'put' = 'post'): request.Test {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return request(app)[method](path).set('Content-Type', 'application/json').send(text);
}

function expectReceived(res: request.Response): void {
  expect(res.status, res.text).toBe(200);
  expect(res.body).toStrictEqual({ received: true });
}

async function rows<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await raw.query<T>(sql, params)).rows;
}

type EventRow = { event_id: string; status: string; signature_valid: boolean; payload: unknown; processing_error: string | null; our_ref: string | null };

function events(): Promise<EventRow[]> {
  return rows<EventRow>('SELECT event_id, status, signature_valid, payload, processing_error, our_ref::text FROM webhook_event ORDER BY received_at, event_id');
}

type OutboxRow = { template: string; recipient: string; payload: Record<string, unknown> };

function outbox(): Promise<OutboxRow[]> {
  return rows<OutboxRow>('SELECT template, recipient, payload FROM outbox ORDER BY template');
}

async function bookingStatus(reference: string) {
  return firstRow(
    await raw.query<{ status: string; hold_expires_at: Date | null; confirmed_at: Date | null; access_token_hash: string | null; access_token_expires_at: Date | null }>(
      'SELECT status, hold_expires_at, confirmed_at, access_token_hash, access_token_expires_at FROM booking WHERE reference = $1',
      [reference],
    ),
  );
}

/** A raw HTTP request with exactly the headers given -- no Content-Type unless one is named. */
async function rawRequest(app: Express, method: string, path: string, body: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Length': String(body.length), ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(body);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// --- The whole path ------------------------------------------------------------------------

describe('a verified success delivered to the callback URL MTN was given', () => {
  it.each(['post', 'put'] as const)('by %s: 200, the booking confirmed, the payment recorded, both emails queued', async (method) => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const booking = await insertBooking(prisma, world);
    const { ourRef, path } = await startPayment(app, mtn, booking.reference);

    const res = await callback(app, path, mtnStatusBody(ourRef, 'SUCCESSFUL', { financialTransactionId: '9990001' }), method);

    expectReceived(res);
    const after = await bookingStatus(booking.reference);
    expect(after.status).toBe('confirmed');
    expect(after.hold_expires_at).toBeNull();
    expect(after.confirmed_at).toEqual(expect.any(Date));
    expect(after.access_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(after.access_token_expires_at?.getTime()).toBe((after.confirmed_at?.getTime() ?? 0) + 365 * DAY_MS);
    expect(await rows('SELECT status, provider_ref, method, amount_rwf FROM payment')).toEqual([
      { status: 'succeeded', provider_ref: '9990001', method: 'momo_mtn', amount_rwf: 20_000 },
    ]);
    const queued = await outbox();
    expect(queued.map((row) => [row.template, row.recipient])).toEqual([
      ['admin_new_booking', ADMIN_EMAIL],
      ['booking_confirmation', 'aline.private@example.com'],
    ]);
    expect(await events()).toMatchObject([{ event_id: `${ourRef}:SUCCESSFUL`, status: 'applied', signature_valid: true }]);
  });

  it('then shows the payment succeeded, the checkout paid, and answers another payment with 409 already_paid', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const booking = await insertBooking(prisma, world);
    const { ourRef, path } = await startPayment(app, mtn, booking.reference);
    expectReceived(await callback(app, path, mtnStatusBody(ourRef, 'SUCCESSFUL')));

    const progress = await request(app).get(`/api/payments/${ourRef}`);
    expect(progress.body).toMatchObject({ payment: { status: 'succeeded', failure: null }, booking: { status: 'confirmed' } });

    const checkout = await request(app).get(`/api/checkout/${booking.reference}/${checkoutToken(TEST_SECRET, booking.reference)}`);
    expect(checkout.body.checkout).toMatchObject({ state: 'paid', waitingPayment: null, holdExpiresAt: null });

    const again = await request(app)
      .post(`/api/checkout/${booking.reference}/${checkoutToken(TEST_SECRET, booking.reference)}/payments`)
      .send({ method: 'momo_mtn', phone: '0788123456' });
    expect(again.status).toBe(409);
    expect(again.body).toStrictEqual({ error: 'already_paid' });
    expect(mtn.referenceIds).toHaveLength(1);
  });

  it('keeps the plaintext token out of every column of every table but outbox.payload, and out of every response', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const booking = await insertBooking(prisma, world);
    await insertBooking(prisma, world, { status: 'confirmed' });
    const { ourRef, path } = await startPayment(app, mtn, booking.reference);
    const webhookResponse = await callback(app, path, mtnStatusBody(ourRef, 'SUCCESSFUL'));

    const confirmation = (await outbox()).find((row) => row.template === 'booking_confirmation');
    const token = confirmation?.payload.accessToken as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await bookingStatus(booking.reference)).access_token_hash).toBe(hashAccessToken(token));

    // Every column of every booking row.
    const bookings = await rows<Record<string, unknown>>('SELECT * FROM booking');
    expect(bookings).toHaveLength(2);
    for (const row of bookings) {
      for (const [column, value] of Object.entries(row)) {
        const text = value instanceof Date ? value.toISOString() : JSON.stringify(value ?? null);
        expect(text, `booking.${column}`).not.toContain(token);
      }
    }

    // Every column of every other table, as text.
    const tables = await rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT LIKE '\\_prisma%'`,
    );
    expect(tables.map((table) => table.table_name)).toEqual(expect.arrayContaining(['booking', 'payment', 'webhook_event', 'outbox', 'client']));
    for (const { table_name: table } of tables) {
      const columns = await rows<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]);
      for (const { column_name: column } of columns) {
        if (table === 'outbox' && column === 'payload') continue;
        const hits = await rows<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}" WHERE "${column}"::text LIKE '%' || $1 || '%'`, [token]);
        expect(hits[0]?.n, `${table}.${column}`).toBe('0');
      }
    }
    const inPayload = await rows<{ n: string }>(`SELECT count(*)::text AS n FROM outbox WHERE payload::text LIKE '%' || $1 || '%'`, [token]);
    expect(inPayload[0]?.n).toBe('1');

    const progress = await request(app).get(`/api/payments/${ourRef}`);
    const checkout = await request(app).get(`/api/checkout/${booking.reference}/${checkoutToken(TEST_SECRET, booking.reference)}`);
    for (const res of [webhookResponse, progress, checkout]) expect(res.text).not.toContain(token);
    expect(JSON.stringify(sink.entries)).not.toContain(token);
  });

  it('queues emails that render: the confirmation with the reference, amounts and the link, the photographer’s with the client', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const booking = await insertBooking(prisma, world);
    const { ourRef, path } = await startPayment(app, mtn, booking.reference);
    await callback(app, path, mtnStatusBody(ourRef, 'SUCCESSFUL'));

    const queued = await outbox();
    const confirmation = queued.find((row) => row.template === 'booking_confirmation');
    const email = renderEmail('booking_confirmation', confirmation?.payload, { webOrigin: WEB_ORIGIN, locale: 'en' });
    expect(email.text).toContain(booking.reference);
    expect(email.text).toContain('20,000 RWF');
    expect(email.text).toContain('30,000 RWF');
    expect(email.text).toContain(`${WEB_ORIGIN}/`);
    expect(email.text).toContain(confirmation?.payload.accessToken as string);

    const admin = queued.find((row) => row.template === 'admin_new_booking');
    const adminEmail = renderEmail('admin_new_booking', admin?.payload, { webOrigin: WEB_ORIGIN, locale: 'en' });
    expect(adminEmail.text).toContain('aline.private@example.com');
    expect(adminEmail.text).not.toContain(confirmation?.payload.accessToken as string);
  });
});

// --- The raw body --------------------------------------------------------------------------

describe('the raw body', () => {
  const REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8';
  const PATH = `/api/webhooks/mtn-momo/${REF}/some-signature`;
  /** Whitespace, key order, a tab, a unicode escape and a trailing newline express.json would normalise away. */
  const BYTES = `{\n  "status" : "SUCCESSFUL",\t"externalId":"${REF}",  "b": 2, "a": 1, "note": "caf\\u00e9"\n}\n`;

  function capturing() {
    const provider = stubProvider();
    const app = createApp({ webhooks: { prisma, providers: { mtn_momo_direct: provider }, log: sink.log } });
    return { provider, app };
  }

  it.each(['post', 'put'] as const)('reaches verification byte for byte for application/json by %s', async (method) => {
    const { provider, app } = capturing();

    const res = await request(app)[method](PATH).set('Content-Type', 'application/json').send(BYTES);

    expectReceived(res);
    expect(provider.deliveries).toHaveLength(1);
    const delivery = provider.deliveries[0];
    expect(Buffer.isBuffer(delivery?.rawBody)).toBe(true);
    expect(delivery?.rawBody.equals(Buffer.from(BYTES, 'utf8'))).toBe(true);
    expect(delivery?.params).toStrictEqual({ ourRef: REF, signature: 'some-signature' });
    expect(delivery?.headers['content-type']).toBe('application/json');
  });

  it.each([
    'application/json; charset=utf-8',
    'text/plain',
    'application/x-www-form-urlencoded',
    'application/octet-stream',
    'application/vnd.mtn+json',
  ])('reaches verification byte for byte for %s', async (contentType) => {
    const { provider, app } = capturing();

    expectReceived(await request(app).post(PATH).set('Content-Type', contentType).send(BYTES));

    expect(provider.deliveries[0]?.rawBody.toString('utf8')).toBe(BYTES);
  });

  it('reaches verification byte for byte with no Content-Type at all', async () => {
    const { provider, app } = capturing();

    const res = await rawRequest(app, 'POST', PATH, Buffer.from(BYTES));

    expect(res.status).toBe(200);
    expect(provider.deliveries[0]?.rawBody.toString('utf8')).toBe(BYTES);
  });

  it('reaches verification with bytes express.json would have refused as malformed', async () => {
    const { provider, app } = capturing();
    const broken = '{"status": "SUCCESSFUL", ';

    const res = await request(app).post(PATH).set('Content-Type', 'application/json').send(broken);

    expectReceived(res);
    expect(provider.deliveries[0]?.rawBody.toString('utf8')).toBe(broken);
  });

  it('reaches verification as an empty buffer when there is no body', async () => {
    const { provider, app } = capturing();

    const res = await rawRequest(app, 'POST', PATH, Buffer.alloc(0));

    expect(res.status).toBe(200);
    expect(provider.deliveries[0]?.rawBody).toEqual(Buffer.alloc(0));
  });

  it('verifies and applies a genuine callback spaced and ordered as MTN chose to send it', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const booking = await insertBooking(prisma, world);
    const { ourRef, path } = await startPayment(app, mtn, booking.reference);
    const sent = `{"status":"SUCCESSFUL",  "externalId" : "${ourRef}", "amount":"20000"}`;

    expectReceived(await callback(app, path, sent));

    expect((await events())[0]).toMatchObject({ status: 'applied', payload: { status: 'SUCCESSFUL', externalId: ourRef, amount: '20000' } });
  });

  it('leaves express.json parsing every other route of the same app', async () => {
    const { provider } = capturing();
    const app = appWith(provider);
    const booking = await insertBooking(prisma, world);

    // A JSON body the checkout can only answer 422 on if it was parsed.
    const res = await request(app)
      .post(`/api/checkout/${booking.reference}/${checkoutToken(TEST_SECRET, booking.reference)}/payments`)
      .send({ method: 'card', phone: '0788123456' });

    expect(res.status).toBe(422);
    expect(res.body).toStrictEqual({ error: 'validation_failed', fields: ['method'] });
  });
});

// --- Verification and matching ---------------------------------------------------------------

describe('what the route answers', () => {
  it('200 for a bad signature, stored unverified and ignored, applying nothing -- with the same body as an applied event', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const booking = await insertBooking(prisma, world);
    const { ourRef, path } = await startPayment(app, mtn, booking.reference);
    const forged = `${path.slice(0, -1)}${path.endsWith('A') ? 'B' : 'A'}`;

    const res = await callback(app, forged, mtnStatusBody(ourRef, 'SUCCESSFUL'));

    expectReceived(res);
    expect(await events()).toMatchObject([{ event_id: expect.stringMatching(/^unverified:/), signature_valid: false, status: 'ignored', our_ref: ourRef }]);
    expect((await bookingStatus(booking.reference)).status).toBe('pending_payment');
    expect(await rows('SELECT status FROM payment')).toEqual([{ status: 'pending' }]);
    expect(await outbox()).toEqual([]);

    const genuine = await callback(app, path, mtnStatusBody(ourRef, 'SUCCESSFUL'));
    expect(genuine.text).toBe(res.text);
    expect((await bookingStatus(booking.reference)).status).toBe('confirmed');
  });

  it('200 for a forged callback to a guessed URL for a real payment, applying nothing', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const booking = await insertBooking(prisma, world);
    const { ourRef } = await startPayment(app, mtn, booking.reference);

    for (const path of [`/api/webhooks/mtn-momo/${ourRef}/${'A'.repeat(43)}`, `/api/webhooks/mtn-momo/${ourRef}/${checkoutToken(TEST_SECRET, ourRef)}`]) {
      expectReceived(await callback(app, path, mtnStatusBody(ourRef, 'SUCCESSFUL')));
    }

    expect((await events()).map((row) => row.signature_valid)).toEqual([false, false]);
    expect((await bookingStatus(booking.reference)).status).toBe('pending_payment');
  });

  it('200 for a duplicate delivery: one applied row, one ignored row, one booking_confirmation', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const booking = await insertBooking(prisma, world);
    const { ourRef, path } = await startPayment(app, mtn, booking.reference);
    const body = mtnStatusBody(ourRef, 'SUCCESSFUL');

    expectReceived(await callback(app, path, body));
    expectReceived(await callback(app, path, body, 'put'));

    expect((await events()).map((row) => row.status).sort()).toEqual(['applied', 'ignored']);
    expect((await outbox()).filter((row) => row.template === 'booking_confirmation')).toHaveLength(1);
  });

  it('applies once when six deliveries of one event arrive at the same moment, answering 200 to all', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const booking = await insertBooking(prisma, world);
    const { ourRef, path } = await startPayment(app, mtn, booking.reference);
    const body = mtnStatusBody(ourRef, 'SUCCESSFUL');

    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => callback(app, path, body, i % 2 === 0 ? 'post' : 'put')));

    for (const res of responses) expectReceived(res);
    expect((await events()).filter((row) => row.status === 'applied')).toHaveLength(1);
    expect((await outbox()).filter((row) => row.template === 'booking_confirmation')).toHaveLength(1);
  });

  it('200 for a signed event matching no payment, which stays inspectable', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const unknown = '7d2f1e4a-5b6c-4d8e-9f0a-1b2c3d4e5f60';

    expectReceived(await callback(app, callbackPath(mtn.provider, unknown), mtnStatusBody(unknown, 'SUCCESSFUL')));

    expect(await events()).toMatchObject([{ our_ref: unknown, status: 'ignored', processing_error: 'no_matching_payment', signature_valid: true }]);
  });

  it('200 and nothing changes for a success on a payment already failed', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const booking = await insertBooking(prisma, world);
    const failed = await insertPayment(prisma, booking.id, { status: 'failed', failureReason: 'provider_timeout' });

    expectReceived(await callback(app, callbackPath(mtn.provider, failed.ourRef), mtnStatusBody(failed.ourRef, 'SUCCESSFUL')));

    expect(await events()).toMatchObject([{ status: 'ignored', processing_error: 'payment_failed' }]);
    expect(await rows('SELECT status, failure_reason FROM payment')).toEqual([{ status: 'failed', failure_reason: 'provider_timeout' }]);
    expect((await bookingStatus(booking.reference)).status).toBe('pending_payment');
  });

  it('200 and a re-confirmed booking for a late success whose slot is free', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const booking = await insertBooking(prisma, world, { status: 'expired' });
    const payment = await insertPayment(prisma, booking.id, { status: 'pending', ageSeconds: 45 * 60 });

    expectReceived(await callback(app, callbackPath(mtn.provider, payment.ourRef), mtnStatusBody(payment.ourRef, 'SUCCESSFUL')));

    expect(await bookingStatus(booking.reference)).toMatchObject({ status: 'confirmed', hold_expires_at: null });
  });

  it('200, the booking left expired, the payment refund_due and an admin_alert queued for a late success whose slot is taken', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const slot = new Date('2027-05-05T07:00:00Z');
    const booking = await insertBooking(prisma, world, { status: 'expired', startsAt: slot });
    await insertBooking(prisma, world, { status: 'confirmed', startsAt: slot });
    const payment = await insertPayment(prisma, booking.id, { status: 'pending', ageSeconds: 45 * 60 });

    expectReceived(await callback(app, callbackPath(mtn.provider, payment.ourRef), mtnStatusBody(payment.ourRef, 'SUCCESSFUL')));

    expect((await bookingStatus(booking.reference)).status).toBe('expired');
    expect(await rows('SELECT status FROM payment')).toEqual([{ status: 'refund_due' }]);
    expect(await outbox()).toMatchObject([{ template: 'admin_alert', recipient: ADMIN_EMAIL, payload: { variant: 'refund_due', reason: 'late_payment_slot_taken' } }]);
  });

  it('500 when processing fails, and the provider’s retry of the same delivery is processed', async () => {
    const mtn = fakeMtn();
    let failNext = true;
    const app = appWith(mtn.provider, {
      newAccessToken: () => {
        if (failNext) {
          failNext = false;
          throw new Error('entropy pool exhausted');
        }
        return { token: 'RetriedToken_0123456789abcdefghijklmnopqrstu', hash: hashAccessToken('RetriedToken_0123456789abcdefghijklmnopqrstu') };
      },
    });
    const booking = await insertBooking(prisma, world);
    const { ourRef, path } = await startPayment(app, mtn, booking.reference);
    const body = mtnStatusBody(ourRef, 'SUCCESSFUL');

    const first = await callback(app, path, body);

    expect(first.status).toBe(500);
    expect(first.body).toStrictEqual({ error: 'internal_error' });
    expect(first.text).not.toContain('entropy');
    expect(await events()).toMatchObject([{ status: 'failed', processing_error: 'Error: entropy pool exhausted' }]);
    expect((await bookingStatus(booking.reference)).status).toBe('pending_payment');
    expect(await outbox()).toEqual([]);

    const retry = await callback(app, path, body);

    expectReceived(retry);
    expect(await events()).toMatchObject([{ status: 'applied', processing_error: null }]);
    expect((await bookingStatus(booking.reference)).status).toBe('confirmed');
    expect(await outbox()).toHaveLength(2);
  });
});

// --- Bodies -------------------------------------------------------------------------------------

describe('bodies that are not what MTN sends', () => {
  async function send(body: Buffer | string, contentType = 'application/json') {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const ref = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8';
    const res = await request(app).post(callbackPath(mtn.provider, ref)).set('Content-Type', contentType).send(body);
    return { res, rows: await events() };
  }

  it.each([
    ['a JSON \\u0000 escape', '{"status":"SUCCESSFUL","note":"a\\u0000b"}'],
    ['a raw NUL byte', Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x00, 0x22, 0x7d])],
    ['a lone surrogate escape', '{"status":"PENDING","\\udc00":"\\ud800"}'],
    ['bytes that are not UTF-8', Buffer.from([0xc3, 0x28, 0xa0, 0xa1, 0xff])],
    ['form-encoded text', 'status=SUCCESSFUL&externalId=x'],
    ['XML', '<?xml version="1.0"?><status>SUCCESSFUL</status>'],
    ['JSON null', 'null'],
    ['a 60 KB JSON body', JSON.stringify({ status: 'PENDING', filler: 'x'.repeat(60_000) })],
    ['a 60 KB body of characters JSON escapes', '"\\'.repeat(30_000)],
  ])('%s: stored and answered 200, never 500', async (_case, body) => {
    const { res, rows: stored } = await send(body);

    expectReceived(res);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('ignored');
  });

  it('an empty body: stored with a null payload and answered 200', async () => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);

    const res = await rawRequest(app, 'POST', callbackPath(mtn.provider, '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'), Buffer.alloc(0));

    expect(res.status).toBe(200);
    expect(await events()).toMatchObject([{ payload: null, status: 'ignored' }]);
  });

  it('a body over 64 KB: refused 413 unread, never a 500, and nothing stored', async () => {
    const { res, rows: stored } = await send(JSON.stringify({ status: 'SUCCESSFUL', filler: 'x'.repeat(70_000) }));

    expect(res.status).toBe(413);
    expect(res.body).toStrictEqual({ error: 'invalid_request' });
    expect(stored).toEqual([]);
  });

  // Fails today: a deeply nested body overflows the stack in webhooks.ts `scrub`, before anything is
  // stored, so the route answers 500 and the provider is asked to retry a delivery that can never succeed.
  it('a deeply nested JSON body (5,000 levels, 10 KB): stored and answered 200, never 500', async () => {
    const { res, rows: stored } = await send(`${'['.repeat(5_000)}${']'.repeat(5_000)}`);

    expectReceived(res);
    expect(stored).toHaveLength(1);
  });
});

// --- Routing --------------------------------------------------------------------------------------

describe('routing', () => {
  it.each(['get', 'patch', 'delete'] as const)('404 for %s on the callback path, storing nothing', async (method) => {
    const mtn = fakeMtn();
    const app = appWith(mtn.provider);
    const path = callbackPath(mtn.provider, '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8');

    const res = await request(app)[method](path);

    expect(res.status).toBe(404);
    expect(await events()).toEqual([]);
  });

  it.each([
    '/api/webhooks/mtn-momo',
    '/api/webhooks/mtn-momo/3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8',
    '/api/webhooks/mtn-momo/3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8/sig/extra',
    '/api/webhooks/flutterwave/3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8/sig',
    '/api/webhooks',
  ])('404 for POST %s, storing nothing', async (path) => {
    const app = appWith(fakeMtn().provider);

    const res = await request(app).post(path).set('Content-Type', 'application/json').send('{}');

    expect(res.status).toBe(404);
    expect(await events()).toEqual([]);
  });

  it('is absent unless webhooks are mounted, or when no MTN provider is given', async () => {
    const mtn = fakeMtn();
    const path = callbackPath(mtn.provider, '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8');
    const apps = [
      createApp(),
      createApp({ publicApi: { prisma, payments: { provider: mtn.provider, secret: TEST_SECRET } } }),
      createApp({ webhooks: { prisma, providers: {}, log: sink.log } }),
    ];

    for (const app of apps) {
      const res = await request(app).post(path).set('Content-Type', 'application/json').send('{"status":"SUCCESSFUL"}');
      expect(res.status).toBe(404);
    }
    expect(await events()).toEqual([]);
  });

  it('keeps accepting MTN callbacks when another provider is active (spec §6.18)', async () => {
    const mtn = fakeMtn();
    const flutterwave = stubProvider({ id: 'flutterwave', methods: ['momo_mtn', 'momo_airtel', 'card'] });
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'pending' });
    const app = createApp({
      publicApi: { prisma, payments: { provider: flutterwave, secret: TEST_SECRET } },
      webhooks: { prisma, providers: { mtn_momo_direct: mtn.provider, flutterwave }, log: sink.log },
    });

    expectReceived(await callback(app, callbackPath(mtn.provider, payment.ourRef), mtnStatusBody(payment.ourRef, 'SUCCESSFUL')));

    expect((await bookingStatus(booking.reference)).status).toBe('confirmed');
  });
});
