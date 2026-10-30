import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { issueToken } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { type PaymentCheck, createPaymentCheck } from '../payments/card-check.js';
import { checkoutToken } from '../payments/checkout-link.js';
import { CARD_SESSION_EXPIRED, CARD_SESSION_SECONDS, FLUTTERWAVE_CHECKOUT_WEBHOOK_PATH, FlutterwaveCheckoutProvider, VERIF_HASH_HEADER } from '../payments/flutterwave-checkout.js';
import { reconcilePendingPayments } from '../payments/reconcile.js';
import { accountToken, createClientAccount } from '../test/account-fixtures.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { expectMatchesSpec } from '../test/openapi.js';
import {
  CLIENT,
  PHOTOGRAPHER_EMAIL,
  PHOTOGRAPHER_NAME,
  PLATFORM_ADMIN_EMAIL,
  type PaymentWorld,
  type StubProvider,
  TEST_SECRET,
  grantAccessToken,
  insertBooking,
  insertBookingWithToken,
  insertPayment,
  logSink,
  routeTo,
  seedSecondPhotographer,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';

/**
 * Cards end to end (user decisions, 2026-10-30; marketplace-spec.md R3.2, R3.3,
 * T3.1-T3.5 for cards, R5.2), against real PostgreSQL. The card provider is the
 * real `FlutterwaveCheckoutProvider` in front of a FAKE Flutterwave v3: an
 * in-memory list of transactions answering `verify_by_reference` and
 * `/:id/verify`. Nothing here reaches Flutterwave.
 *
 * What is proven:
 *  - T3.1 (Inline): a card initiation records the payment `pending` under
 *    `flutterwave_checkout`, calls nothing, and answers the Inline config built
 *    on the server; initiating again while it is open answers the SAME
 *    `ourRef` and config (200), in parallel too, with one row. Mixing methods
 *    meets the existing window; past its session a card starts afresh. A
 *    forged amount, provider or status in the body is ignored.
 *  - T3.2: a forged `status=successful` on the poll leaves the payment pending
 *    and the booking `pending_payment`; only Flutterwave's own answer settles.
 *  - C5: the poll verifies a pending card payment, by id when the page passes
 *    the `transaction_id`, throttled per payment, a foreign id or a wrong
 *    amount settling nothing, Flutterwave down answering what is on record.
 *  - T3.3 (v3): a missing or wrong `verif-hash` is 401 and stored unverified;
 *    a right one is only a claim, re-verified through the API -- a claim the
 *    API contradicts, does not know, or answers for another `tx_ref` applies
 *    nothing; the API down is a 500 and nothing applied; amount and currency
 *    mismatches are ignored; a repeat changes nothing; a declined try leaves
 *    the payment open for the next card.
 *  - T3.4: no card initiation for a suspended or out-of-subscription photographer.
 *  - T3.5: the reconciler settles a card payment whose webhook never came, and
 *    closes one whose session ended unpaid (`card_session_expired`), which a
 *    late verified success still revives.
 *  - Session fees (guest page and account) and the subscription pay by card
 *    with their own return pages; a subscription card payment adds its period;
 *    a card earning is the full amount, and its refund is recorded on the
 *    platform's refunds page like MoMo's.
 *  - The new pieces stay inside their areas: the public poll never asks about a
 *    subscription payment, and the studio's never about another photographer's.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let sink: ReturnType<typeof logSink>;
let mtn: StubProvider;
let fw: FakeV3;
let cards: FlutterwaveCheckoutProvider;
let checkClock: number;
let checkPayment: PaymentCheck;

const NOW = new Date('2026-10-01T06:00:00Z');
const WEB_ORIGIN = 'https://bookly.example';
const BASE_URL = 'https://flutterwave-v3.test';
const SECRET = 'FLWSECK_TEST-placeholder-secret-X';
const PUBLIC = 'FLWPUBK_TEST-placeholder-public-X';
const HASH = 'placeholder-webhook-hash-for-card-tests';

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
  mtn = stubProvider({ id: 'mtn_momo_direct', methods: ['momo_mtn'] });
  fw = fakeV3();
  cards = new FlutterwaveCheckoutProvider({ baseUrl: BASE_URL, secretKey: SECRET, publicKey: PUBLIC, webhookHash: HASH, webOrigin: WEB_ORIGIN, fetch: fw.fetch });
  checkClock = 1_000_000;
  checkPayment = createPaymentCheck({ prisma, providers: { mtn_momo_direct: mtn, flutterwave_checkout: cards }, clock: () => checkClock, log: sink.log });
});

// --- A fake Flutterwave v3 --------------------------------------------------------------------

type FakeV3 = {
  fetch: typeof fetch;
  transactions: Record<string, unknown>[];
  /** Path and query of every call, in order. */
  calls: string[];
  down: boolean;
  /** A transaction under `txRef`, as the modal would make one. */
  charge(txRef: string, amount: number, extra?: Record<string, unknown>): Record<string, unknown>;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeV3(): FakeV3 {
  let nextId = 285_959_875;
  const fake: FakeV3 = {
    transactions: [],
    calls: [],
    down: false,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      fake.calls.push(`${url.pathname}${url.search}`);
      if (fake.down) return json({ status: 'error', message: 'Service unavailable' }, 503);
      const notFound = () => json({ status: 'error', message: 'No transaction was found for this id', data: null }, 400);
      const found = (tx: Record<string, unknown> | undefined) => (tx === undefined ? notFound() : json({ status: 'success', message: 'Transaction fetched successfully', data: tx }));
      if (url.pathname === '/v3/transactions/verify_by_reference') {
        // The newest try under the reference (an assumption: see flutterwave-checkout.ts).
        return found([...fake.transactions].reverse().find((tx) => tx.tx_ref === url.searchParams.get('tx_ref')));
      }
      const byId = /^\/v3\/transactions\/(\d+)\/verify$/.exec(url.pathname);
      if (byId !== null) return found(fake.transactions.find((tx) => String(tx.id) === byId[1]));
      return json({ status: 'error', message: 'Not found' }, 404);
    }) as typeof fetch,
    charge(txRef, amount, extra = {}) {
      const tx = { id: nextId, tx_ref: txRef, flw_ref: `FLW-MOCK-${nextId}`, amount, charged_amount: amount, currency: 'RWF', status: 'successful', payment_type: 'card', ...extra };
      nextId += 1;
      fake.transactions.push(tx);
      return tx;
    },
  };
  return fake;
}

// --- Helpers ----------------------------------------------------------------------------------

function appWith(options: { cardsOffered?: boolean; check?: boolean } = {}): Express {
  const routing = options.cardsOffered === false ? routeTo(mtn) : routeTo(mtn, cards);
  return createApp({
    corsOrigin: WEB_ORIGIN,
    auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: WEB_ORIGIN, now: () => NOW },
    publicApi: {
      prisma,
      now: () => NOW,
      payments: { routing, secret: TEST_SECRET, ...(options.check === false ? {} : { checkPayment }) },
    },
    webhooks: { prisma, providers: { mtn_momo_direct: mtn, flutterwave_checkout: cards }, log: sink.log },
  });
}

const checkoutUrl = (reference: string) => `/api/checkout/${reference}/${checkoutToken(TEST_SECRET, reference)}/payments`;
const payFee = (app: Express, reference: string, body: object = { method: 'card' }) => request(app).post(checkoutUrl(reference)).send(body);

function webhook(app: Express, data: unknown, hash: string | null = HASH, event = 'charge.completed'): request.Test {
  const text = JSON.stringify({ event, 'event.type': 'CARD_TRANSACTION', data });
  const req = request(app).post(FLUTTERWAVE_CHECKOUT_WEBHOOK_PATH).set('Content-Type', 'application/json');
  if (hash !== null) req.set(VERIF_HASH_HEADER, hash);
  return req.send(text);
}

async function rows<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await raw.query<T>(sql, params)).rows;
}

async function paymentOf(ourRef: string) {
  return prisma.payment.findUniqueOrThrow({ where: { ourRef } });
}

/** Moves a payment's initiation (and its attempt) back by `seconds`, on the database clock. */
async function age(ourRef: string, seconds: number): Promise<void> {
  await raw.query(
    `UPDATE payment SET initiated_at = now() - make_interval(secs => $2), updated_at = now() - make_interval(secs => $2) WHERE our_ref = $1::uuid`,
    [ourRef, seconds],
  );
}

async function templatesOf(bookingId: string): Promise<string[]> {
  return (await rows<{ template: string }>('SELECT template FROM outbox WHERE booking_id = $1 ORDER BY template', [bookingId])).map((row) => row.template);
}

async function studioToken(of: PaymentWorld = world): Promise<string> {
  const user = await prisma.appUser.findUniqueOrThrow({ where: { id: of.photographerUserId } });
  return (await issueToken(TEST_SECRET, 'studio', user, NOW)).token;
}

async function platformToken(): Promise<string> {
  const admin = await prisma.appUser.findFirstOrThrow({ where: { email: PLATFORM_ADMIN_EMAIL, role: 'platform_admin' } });
  return (await issueToken(TEST_SECRET, 'platform', admin, NOW)).token;
}

type CardBody = { payment: { ourRef: string; status: string }; card: Record<string, unknown> & { configurations: { session_duration: number } } };

// --- T3.1, adapted to Inline ---------------------------------------------------------------------

describe('booking fee by card: initiation (T3.1, Inline)', () => {
  it('records the payment pending under flutterwave_checkout, calls nothing, and answers the Inline config built on the server', async () => {
    const booking = await insertBooking(prisma, world);
    const res = await payFee(appWith(), booking.reference);

    expect(res.status, res.text).toBe(201);
    await expectMatchesSpec(res, 'startCheckoutPayment', 201);
    const { payment, card } = res.body as CardBody;
    expect(payment.status).toBe('pending');
    expect(card).toStrictEqual({
      public_key: PUBLIC,
      tx_ref: payment.ourRef,
      amount: 20_000,
      currency: 'RWF',
      payment_options: 'card',
      redirect_url: `${WEB_ORIGIN}/checkout/${booking.reference}/${checkoutToken(TEST_SECRET, booking.reference)}/payments/${payment.ourRef}`,
      customer: { email: CLIENT.email, name: CLIENT.name, phone_number: CLIENT.phone },
      customizations: { title: `Bookly booking fee ${booking.reference}` },
      configurations: { session_duration: CARD_SESSION_SECONDS / 60 },
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain(HASH);
    expect(await paymentOf(payment.ourRef)).toMatchObject({ provider: 'flutterwave_checkout', method: 'card', status: 'pending', amountRwf: 20_000, providerRef: null, kind: 'booking_fee' });
    expect(fw.calls).toEqual([]);
  });

  it('answers a second card tap while the checkout is open with the SAME payment and config, starting nothing', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const first = (await payFee(app, booking.reference)).body as CardBody;
    const again = await payFee(app, booking.reference, { method: 'card' });

    expect(again.status, again.text).toBe(200);
    await expectMatchesSpec(again, 'startCheckoutPayment', 200);
    const second = again.body as CardBody;
    expect(second.payment).toStrictEqual(first.payment);
    const { configurations: firstSession, ...firstRest } = first.card;
    const { configurations: secondSession, ...secondRest } = second.card;
    expect(secondRest).toStrictEqual(firstRest);
    // Never longer than what was left of the first: a reopened modal never outlives it.
    expect(secondSession.session_duration).toBeLessThanOrEqual(firstSession.session_duration);
    expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
  });

  it('opens one payment for two card taps at once', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const [a, b] = await Promise.all([payFee(app, booking.reference), payFee(app, booking.reference)]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((a.body as CardBody).payment.ourRef).toBe((b.body as CardBody).payment.ourRef);
    expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
  });

  it('ignores a forged amount, provider, status and phone in the body: the server prices it', async () => {
    const booking = await insertBooking(prisma, world);
    const res = await payFee(appWith(), booking.reference, { method: 'card', amountRwf: 1, amount: 1, provider: 'cash', status: 'succeeded', phone: 'not-a-phone', currency: 'USD' });

    expect(res.status, res.text).toBe(201);
    const { payment, card } = res.body as CardBody;
    expect(card).toMatchObject({ amount: 20_000, currency: 'RWF' });
    expect(await paymentOf(payment.ourRef)).toMatchObject({ amountRwf: 20_000, provider: 'flutterwave_checkout', status: 'pending' });
  });

  it('ends the card session with the hold', async () => {
    const booking = await insertBooking(prisma, world, { holdMinutes: 5 });
    const { card } = (await payFee(appWith(), booking.reference)).body as CardBody;
    expect(card.configurations.session_duration).toBeGreaterThanOrEqual(4);
    expect(card.configurations.session_duration).toBeLessThanOrEqual(5);
  });

  it('says on the checkout which method the waiting payment is, so the page reopens the card', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    const res = await request(app).get(`/api/checkout/${booking.reference}/${checkoutToken(TEST_SECRET, booking.reference)}`);
    await expectMatchesSpec(res, 'getCheckout', 200);
    expect(res.body.checkout.waitingPayment).toStrictEqual({ ourRef: payment.ourRef, method: 'card' });
  });

  it('answers card exactly as before cards when they are not on offer: a 422 on method, or a 400 without a phone', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith({ cardsOffered: false });
    const res = await payFee(app, booking.reference, { method: 'card', phone: '0788123456' });
    expect(res.status).toBe(422);
    expect(res.body).toStrictEqual({ error: 'validation_failed', fields: ['method'] });
    expect((await payFee(app, booking.reference, { method: 'card' })).status).toBe(400);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('still asks MoMo for a phone: missing is a 400, unreadable a 422', async () => {
    const booking = await insertBooking(prisma, world);
    expect((await payFee(appWith(), booking.reference, { method: 'momo_mtn' })).status).toBe(400);
    expect((await payFee(appWith(), booking.reference, { method: 'momo_mtn', phone: 'call-me' })).body).toStrictEqual({ error: 'validation_failed', fields: ['phone'] });
  });

  it.each([
    ['a lapsed hold', { holdMinutes: -1 }, 'hold_expired'],
    ['a booking no longer waiting', { status: 'expired' }, 'hold_expired'],
  ])('refuses %s, opening nothing', async (_case, seed, error) => {
    const booking = await insertBooking(prisma, world, seed);
    const res = await payFee(appWith(), booking.reference);
    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual({ error });
    expect(await prisma.payment.count()).toBe(0);
  });

  it('refuses a fee already paid', async () => {
    const booking = await insertBooking(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded' });
    expect((await payFee(appWith(), booking.reference)).body).toStrictEqual({ error: 'already_paid' });
  });
});

describe('mixing methods and abandonment (C3)', () => {
  it('answers MoMo while a card checkout is in its first minutes with payment_in_progress, and the reverse', async () => {
    const app = appWith();
    const cardBooking = await insertBooking(prisma, world);
    const { payment } = (await payFee(app, cardBooking.reference)).body as CardBody;
    const momo = await payFee(app, cardBooking.reference, { method: 'momo_mtn', phone: '0788123456' });
    expect(momo.status).toBe(409);
    expect(momo.body).toStrictEqual({ error: 'payment_in_progress', payment: { ourRef: payment.ourRef, method: 'card' } });
    expect(mtn.initiated).toEqual([]);

    const momoBooking = await insertBooking(prisma, world);
    const started = await payFee(app, momoBooking.reference, { method: 'momo_mtn', phone: '0788123456' });
    const card = await payFee(app, momoBooking.reference);
    expect(card.status).toBe(409);
    expect(card.body).toStrictEqual({ error: 'payment_in_progress', payment: { ourRef: started.body.payment.ourRef, method: 'momo_mtn' } });
  });

  it('lets MoMo start once the attempt window has passed, a closed modal blocking nothing', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    await age(payment.ourRef, 181);

    const momo = await payFee(app, booking.reference, { method: 'momo_mtn', phone: '0788123456' });
    expect(momo.status, momo.text).toBe(201);
    expect(momo.body.payment.ourRef).not.toBe(payment.ourRef);
  });

  it('still reopens the same card checkout after the attempt window, while its session lasts', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    await age(payment.ourRef, 600);

    const again = await payFee(app, booking.reference);
    expect(again.status).toBe(200);
    expect((again.body as CardBody).payment.ourRef).toBe(payment.ourRef);
    // 15 minutes less 10, floored: never past the first session's end.
    expect((again.body as CardBody).card.configurations.session_duration).toBe(4);
  });

  it('starts a new card payment, with a new tx_ref, once less than a minute of the old session is left', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    await age(payment.ourRef, CARD_SESSION_SECONDS - 30);

    const fresh = await payFee(app, booking.reference);
    expect(fresh.status).toBe(201);
    const next = fresh.body as CardBody;
    expect(next.payment.ourRef).not.toBe(payment.ourRef);
    expect(next.card.tx_ref).toBe(next.payment.ourRef);
    // The old one is left to the reconciler, which closes it once its session is over.
    expect((await paymentOf(payment.ourRef)).status).toBe('pending');
  });

  it('counts a late success on the old payment and owes it back: a duplicate booking fee', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const old = ((await payFee(app, booking.reference)).body as CardBody).payment.ourRef;
    await age(old, CARD_SESSION_SECONDS - 30);
    const fresh = ((await payFee(app, booking.reference)).body as CardBody).payment.ourRef;

    expect((await webhook(app, fw.charge(fresh, 20_000))).status).toBe(200);
    expect((await webhook(app, fw.charge(old, 20_000))).status).toBe(200);

    expect((await paymentOf(fresh)).status).toBe('succeeded');
    expect(await paymentOf(old)).toMatchObject({ status: 'refund_due', providerRef: expect.stringMatching(/^FLW-\d+$/) });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('confirmed');
  });
});

describe('T3.4 for cards: an unbookable photographer', () => {
  it('refuses a card for a suspended photographer, opening nothing', async () => {
    const booking = await insertBooking(prisma, world);
    await prisma.photographer.update({ where: { id: world.photographerId }, data: { status: 'suspended', suspendedAt: NOW } });
    const res = await payFee(appWith(), booking.reference);
    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual({ error: 'photographer_unavailable' });
    expect(await prisma.payment.count()).toBe(0);
  });

  it('refuses a card when the subscription has run out', async () => {
    const booking = await insertBooking(prisma, world);
    await raw.query(`UPDATE subscription SET current_period_ends_at = now() - interval '1 day', status = 'past_due' WHERE photographer_id = $1`, [world.photographerId]);
    const res = await payFee(appWith(), booking.reference);
    expect(res.body).toStrictEqual({ error: 'photographer_unavailable' });
    expect(await prisma.payment.count()).toBe(0);
  });
});

// --- T3.2 and C5: the progress page's poll ---------------------------------------------------------

describe('the poll: nothing the page says counts, only Flutterwave (T3.2, C5)', () => {
  it('leaves the payment pending and the booking pending_payment on a forged ?status=successful', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;

    const res = await request(app).get(`/api/payments/${payment.ourRef}`).query({ status: 'successful', tx_ref: payment.ourRef, transaction_id: '999' });
    expect(res.status).toBe(200);
    expect(res.body.payment).toStrictEqual({ status: 'pending', amountRwf: 20_000, failure: null });
    expect(res.body.booking.status).toBe('pending_payment');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('pending_payment');
  });

  it('leaves it pending when the page names a transaction Flutterwave does not have', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    const res = await request(app).get(`/api/payments/${payment.ourRef}`).query({ transactionId: '123456' });
    expect(res.body.payment.status).toBe('pending');
    expect(fw.calls).toEqual(['/v3/transactions/123456/verify']);
  });

  it('settles at once when Flutterwave says it is paid: the booking confirmed in the same poll', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    fw.charge(payment.ourRef, 20_000);

    const res = await request(app).get(`/api/payments/${payment.ourRef}`);
    await expectMatchesSpec(res, 'getPaymentStatus', 200);
    expect(res.body.payment.status).toBe('succeeded');
    expect(res.body.booking.status).toBe('confirmed');
    expect(fw.calls).toEqual([`/v3/transactions/verify_by_reference?tx_ref=${payment.ourRef}`]);
    expect(await templatesOf(booking.id)).toEqual(['booking_confirmation', 'photographer_new_booking']);
  });

  it('verifies by the transaction id the page passes', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    const tx = fw.charge(payment.ourRef, 20_000);

    const res = await request(app).get(`/api/payments/${payment.ourRef}`).query({ transactionId: String(tx.id) });
    expect(res.body.payment.status).toBe('succeeded');
    expect(fw.calls).toEqual([`/v3/transactions/${String(tx.id)}/verify`]);
    expect((await paymentOf(payment.ourRef)).providerRef).toBe(`FLW-${String(tx.id)}`);
  });

  it('settles nothing on a transaction id that belongs to another payment', async () => {
    const booking = await insertBooking(prisma, world);
    const other = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    const { payment: otherPayment } = (await payFee(app, other.reference)).body as CardBody;
    const foreign = fw.charge(otherPayment.ourRef, 20_000);

    const res = await request(app).get(`/api/payments/${payment.ourRef}`).query({ transactionId: String(foreign.id) });
    expect(res.body.payment.status).toBe('pending');
    expect((await paymentOf(otherPayment.ourRef)).status).toBe('pending');
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'payment_check_other_reference' }));
  });

  it('settles nothing when Flutterwave reports another amount, and records why', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    fw.charge(payment.ourRef, 100);

    expect((await request(app).get(`/api/payments/${payment.ourRef}`)).body.payment.status).toBe('pending');
    expect(await rows('SELECT status, processing_error FROM webhook_event WHERE our_ref = $1::uuid', [payment.ourRef])).toEqual([{ status: 'ignored', processing_error: 'amount_mismatch' }]);
  });

  it('records nothing for a declined try or a pending one: the modal may still be paid', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    fw.charge(payment.ourRef, 20_000, { status: 'failed' });
    expect((await request(app).get(`/api/payments/${payment.ourRef}`)).body.payment.status).toBe('pending');
    checkClock += 10_000;
    fw.charge(payment.ourRef, 20_000, { status: 'pending' });
    expect((await request(app).get(`/api/payments/${payment.ourRef}`)).body.payment.status).toBe('pending');
    expect(await rows('SELECT id FROM webhook_event')).toEqual([]);
  });

  it('asks Flutterwave at most once per payment every few seconds, however often it is polled', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    for (let i = 0; i < 4; i += 1) await request(app).get(`/api/payments/${payment.ourRef}`);
    expect(fw.calls).toHaveLength(1);
    checkClock += 5_000;
    await request(app).get(`/api/payments/${payment.ourRef}`);
    expect(fw.calls).toHaveLength(2);
  });

  it('answers what is on record when Flutterwave is down', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    fw.down = true;
    const res = await request(app).get(`/api/payments/${payment.ourRef}`);
    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('pending');
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'payment_check_failed' }));
  });

  it('never asks about a MoMo payment, a settled one, or an unknown reference', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith();
    const momo = (await payFee(app, booking.reference, { method: 'momo_mtn', phone: '0788123456' })).body.payment.ourRef as string;
    await request(app).get(`/api/payments/${momo}`);
    const settled = await insertPayment(prisma, (await insertBooking(prisma, world)).id, { status: 'succeeded', provider: 'flutterwave_checkout' });
    await request(app).get(`/api/payments/${settled.ourRef}`);
    await request(app).get('/api/payments/3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8');
    await request(app).get('/api/payments/not-a-uuid');
    expect(fw.calls).toEqual([]);
    expect(mtn.lookedUp).toEqual([]);
  });

  it('only reads without the check wired in', async () => {
    const booking = await insertBooking(prisma, world);
    const app = appWith({ check: false });
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    fw.charge(payment.ourRef, 20_000);
    expect((await request(app).get(`/api/payments/${payment.ourRef}`)).body.payment.status).toBe('pending');
    expect(fw.calls).toEqual([]);
  });
});

// --- T3.3, the v3 webhook ----------------------------------------------------------------------------

describe('POST /api/webhooks/flutterwave-checkout (T3.3, C4)', () => {
  async function pendingCard(app: Express) {
    const booking = await insertBooking(prisma, world);
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    return { booking, ourRef: payment.ourRef };
  }

  it.each([
    ['no verif-hash', null],
    ['a wrong verif-hash', 'not-the-hash'],
    ['the hash of another deployment', `${HASH}-staging`],
  ])('refuses %s with 401, stores it unverified and changes nothing', async (_case, hash) => {
    const app = appWith();
    const { booking, ourRef } = await pendingCard(app);
    const res = await webhook(app, fw.charge(ourRef, 20_000), hash);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'invalid_signature' });
    expect(await rows('SELECT provider, signature_valid, status, processing_error FROM webhook_event')).toEqual([
      { provider: 'flutterwave_checkout', signature_valid: false, status: 'ignored', processing_error: 'signature_invalid' },
    ]);
    expect((await paymentOf(ourRef)).status).toBe('pending');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('pending_payment');
    expect(fw.calls).toEqual([]);
  });

  it('settles a verified claim only on what the API says, and stores the claim beside it', async () => {
    const app = appWith();
    const { booking, ourRef } = await pendingCard(app);
    const tx = fw.charge(ourRef, 20_000);
    const res = await webhook(app, tx);

    expect(res.status, res.text).toBe(200);
    expect(res.body).toStrictEqual({ received: true });
    expect(fw.calls).toEqual([`/v3/transactions/${String(tx.id)}/verify`]);
    expect(await paymentOf(ourRef)).toMatchObject({ status: 'succeeded', providerRef: `FLW-${String(tx.id)}`, method: 'card' });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('confirmed');
    const events = await rows<{ event_id: string; status: string; processing_error: string | null }>(
      'SELECT event_id, status, processing_error FROM webhook_event ORDER BY received_at, event_id',
    );
    const verified = events.find((row) => row.event_id === `${String(tx.id)}:SUCCESSFUL`);
    expect(verified).toMatchObject({ status: 'applied' });
    const claim = events.find((row) => row.event_id.startsWith('claim:'));
    expect(claim?.status).toBe('ignored');
    expect(claim?.processing_error).toMatch(/^reverified_as:[0-9a-f-]{36}$/);
  });

  it('applies nothing when the API contradicts the claim: a forged success from someone holding the hash', async () => {
    const app = appWith();
    const { booking, ourRef } = await pendingCard(app);
    const real = fw.charge(ourRef, 20_000, { status: 'pending' });
    const res = await webhook(app, { ...real, status: 'successful' });

    expect(res.status).toBe(200);
    expect((await paymentOf(ourRef)).status).toBe('pending');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('pending_payment');
  });

  it('applies nothing for a claimed transaction Flutterwave never heard of', async () => {
    const app = appWith();
    const { ourRef } = await pendingCard(app);
    const res = await webhook(app, { id: 4242, tx_ref: ourRef, amount: 20_000, currency: 'RWF', status: 'successful' });
    expect(res.status).toBe(200);
    expect((await paymentOf(ourRef)).status).toBe('pending');
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'webhook_claim_unknown_to_provider' }));
  });

  it('applies nothing when the API answers the claimed id for another tx_ref', async () => {
    const app = appWith();
    const { ourRef } = await pendingCard(app);
    const { ourRef: otherRef } = await pendingCard(app);
    const theirs = fw.charge(otherRef, 20_000);
    const res = await webhook(app, { ...theirs, tx_ref: ourRef });

    expect(res.status).toBe(200);
    expect((await paymentOf(ourRef)).status).toBe('pending');
    expect((await paymentOf(otherRef)).status).toBe('pending');
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'webhook_claim_mismatch' }));
  });

  it('answers 500 when the API cannot be reached, applies nothing, and settles on the retry', async () => {
    const app = appWith();
    const { ourRef } = await pendingCard(app);
    const tx = fw.charge(ourRef, 20_000);
    fw.down = true;
    const first = await webhook(app, tx);
    expect(first.status).toBe(500);
    expect((await paymentOf(ourRef)).status).toBe('pending');

    fw.down = false;
    expect((await webhook(app, tx)).status).toBe(200);
    expect((await paymentOf(ourRef)).status).toBe('succeeded');
  });

  it.each([
    ['amount', { amount: 19_999 }, 'amount_mismatch'],
    ['currency', { currency: 'NGN' }, 'currency_mismatch'],
  ])('ignores a verified success with the wrong %s, logging it', async (_case, extra, note) => {
    const app = appWith();
    const { ourRef } = await pendingCard(app);
    const res = await webhook(app, fw.charge(ourRef, 20_000, extra));

    expect(res.status).toBe(200);
    expect((await paymentOf(ourRef)).status).toBe('pending');
    expect(await rows("SELECT processing_error FROM webhook_event WHERE event_id NOT LIKE 'claim:%'")).toEqual([{ processing_error: note }]);
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: `webhook_${note}` }));
  });

  it('is no success when the API states no amount', async () => {
    const app = appWith();
    const { ourRef } = await pendingCard(app);
    const tx = fw.charge(ourRef, 20_000);
    delete tx.amount;
    expect((await webhook(app, tx)).status).toBe(200);
    expect((await paymentOf(ourRef)).status).toBe('pending');
  });

  it('does nothing more on a repeat: one confirmation, one earning', async () => {
    const app = appWith();
    const { booking, ourRef } = await pendingCard(app);
    const tx = fw.charge(ourRef, 20_000);
    expect((await webhook(app, tx)).status).toBe(200);
    expect((await webhook(app, tx)).status).toBe(200);

    expect(await templatesOf(booking.id)).toEqual(['booking_confirmation', 'photographer_new_booking']);
    expect(await prisma.payoutItem.count()).toBe(1);
    expect(await rows("SELECT status, processing_error FROM webhook_event WHERE event_id LIKE '%#duplicate:%'")).toEqual([
      { status: 'ignored', processing_error: expect.stringMatching(/^duplicate_of:/) },
    ]);
  });

  it('treats the webhook and the poll of one outcome as one event', async () => {
    const app = appWith();
    const { booking, ourRef } = await pendingCard(app);
    const tx = fw.charge(ourRef, 20_000);
    await request(app).get(`/api/payments/${ourRef}`);
    expect((await webhook(app, tx)).status).toBe(200);
    expect(await rows(`SELECT count(*)::int AS n FROM webhook_event WHERE event_id = $1`, [`${String(tx.id)}:SUCCESSFUL`])).toEqual([{ n: 1 }]);
    expect(await templatesOf(booking.id)).toEqual(['booking_confirmation', 'photographer_new_booking']);
  });

  it('leaves the payment open after a declined try, so the next card in the same modal settles it', async () => {
    const app = appWith();
    const { booking, ourRef } = await pendingCard(app);
    const declined = await webhook(app, fw.charge(ourRef, 20_000, { status: 'failed' }));
    expect(declined.status).toBe(200);
    expect((await paymentOf(ourRef)).status).toBe('pending');
    // A claimed failure is not even asked about: it could only ever be recorded.
    expect(fw.calls).toEqual([]);

    expect((await webhook(app, fw.charge(ourRef, 20_000))).status).toBe(200);
    expect((await paymentOf(ourRef)).status).toBe('succeeded');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('confirmed');
  });

  it('stores a body it cannot read and applies nothing', async () => {
    const app = appWith();
    const { ourRef } = await pendingCard(app);
    const res = await request(app).post(FLUTTERWAVE_CHECKOUT_WEBHOOK_PATH).set('Content-Type', 'application/json').set(VERIF_HASH_HEADER, HASH).send('{"event":');
    expect(res.status).toBe(200);
    expect(await rows('SELECT processing_error FROM webhook_event')).toEqual([{ processing_error: 'unreadable_event' }]);
    expect((await paymentOf(ourRef)).status).toBe('pending');
  });

  it('is absent without the card provider: no keys, no route', async () => {
    const app = createApp({ webhooks: { prisma, providers: { mtn_momo_direct: mtn } } });
    expect((await webhook(app, { id: 1 })).status).toBe(404);
  });
});

// --- T3.5, the reconciler -----------------------------------------------------------------------------

describe('reconcile for cards (T3.5, C6)', () => {
  const reconcile = () => reconcilePendingPayments({ prisma, provider: cards, log: sink.log });

  async function waitingCard(ageSeconds: number) {
    const booking = await insertBooking(prisma, world);
    const { payment } = (await payFee(appWith(), booking.reference)).body as CardBody;
    await age(payment.ourRef, ageSeconds);
    return { booking, ourRef: payment.ourRef };
  }

  it('settles a card payment whose webhook never came', async () => {
    const { booking, ourRef } = await waitingCard(90);
    fw.charge(ourRef, 20_000);
    expect(await reconcile()).toBe(1);
    expect((await paymentOf(ourRef)).status).toBe('succeeded');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('confirmed');
  });

  it('leaves one Flutterwave never heard of waiting while its session may still be paid', async () => {
    const { ourRef } = await waitingCard(90);
    expect(await reconcile()).toBe(0);
    expect((await paymentOf(ourRef)).status).toBe('pending');
  });

  it('closes one whose session is over with nothing paid, as card_session_expired', async () => {
    const { ourRef } = await waitingCard(cards.sessionClosesAfterSeconds + 5);
    expect(await reconcile()).toBe(1);
    expect(await paymentOf(ourRef)).toMatchObject({ status: 'failed', failureReason: CARD_SESSION_EXPIRED });
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'card_session_expired', ourRef }));
  });

  it('closes one whose session is over with only declined tries', async () => {
    const { ourRef } = await waitingCard(cards.sessionClosesAfterSeconds + 5);
    fw.charge(ourRef, 20_000, { status: 'failed' });
    await reconcile();
    expect(await paymentOf(ourRef)).toMatchObject({ status: 'failed', failureReason: CARD_SESSION_EXPIRED });
  });

  it.each([
    ['Flutterwave reports it pending', (ourRef: string) => fw.charge(ourRef, 20_000, { status: 'pending' })],
    ['Flutterwave is down', () => {
      fw.down = true;
    }],
  ])('closes nothing past the session when %s', async (_case, arrange) => {
    const { ourRef } = await waitingCard(cards.sessionClosesAfterSeconds + 5);
    arrange(ourRef);
    await reconcile();
    expect((await paymentOf(ourRef)).status).toBe('pending');
  });

  it('closes nothing before the session is over', async () => {
    const { ourRef } = await waitingCard(cards.sessionClosesAfterSeconds - 30);
    fw.charge(ourRef, 20_000, { status: 'failed' });
    await reconcile();
    expect((await paymentOf(ourRef)).status).toBe('pending');
  });

  it('revives a closed card payment on a late verified success, confirming the booking if its slot is free', async () => {
    const { booking, ourRef } = await waitingCard(cards.sessionClosesAfterSeconds + 5);
    await reconcile();
    expect((await paymentOf(ourRef)).status).toBe('failed');

    const res = await webhook(appWith(), fw.charge(ourRef, 20_000));
    expect(res.status).toBe(200);
    expect(await paymentOf(ourRef)).toMatchObject({ status: 'succeeded', failureReason: CARD_SESSION_EXPIRED });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('confirmed');
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'webhook_success_for_locally_failed_payment', failureReason: CARD_SESSION_EXPIRED }));
  });
});

// --- Session fees -------------------------------------------------------------------------------------------

describe('session fee by card', () => {
  async function confirmedWithFeePaid() {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded' });
    return { booking, token };
  }

  it('from the guest booking page: the outstanding amount, back to the token-free /payments/:ourRef', async () => {
    const { booking, token } = await confirmedWithFeePaid();
    const app = appWith();
    const res = await request(app).post(`/api/booking/${token}/payments`).send({ method: 'card', amountRwf: 1 });

    expect(res.status, res.text).toBe(201);
    await expectMatchesSpec(res, 'startClientSessionFeePayment', 201);
    const { payment, card } = res.body as CardBody;
    expect(card).toMatchObject({
      tx_ref: payment.ourRef,
      amount: 30_000,
      redirect_url: `${WEB_ORIGIN}/payments/${payment.ourRef}`,
      customizations: { title: `Bookly session fee ${booking.reference}` },
      customer: { email: CLIENT.email, name: CLIENT.name, phone_number: CLIENT.phone },
    });
    // The booking's access token never goes into a URL Flutterwave stores.
    expect(JSON.stringify(card)).not.toContain(token);

    const again = await request(app).post(`/api/booking/${token}/payments`).send({ method: 'card' });
    expect(again.status).toBe(200);
    expect((again.body as CardBody).payment.ourRef).toBe(payment.ourRef);
    expect(await prisma.payment.count({ where: { bookingId: booking.id, kind: 'session_fee' } })).toBe(1);
  });

  it('pays the amount the photographer asked for, moving the ask to the card provider', async () => {
    const { booking, token } = await confirmedWithFeePaid();
    const studio = await studioToken();
    const app = createApp({
      auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: WEB_ORIGIN, now: () => NOW },
      publicApi: { prisma, now: () => NOW, payments: { routing: routeTo(mtn, cards), secret: TEST_SECRET, checkPayment } },
    });
    const ask = await request(app).post(`/api/studio/bookings/${booking.id}/session-fee`).set('Authorization', `Bearer ${studio}`).send({});
    expect(ask.status, ask.text).toBe(200);
    const asked = await prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id, kind: 'session_fee' } });
    expect(asked).toMatchObject({ provider: 'mtn_momo_direct', method: null, status: 'initiated' });

    // The request's email carries a fresh link; the client pays from it.
    const fresh = await grantAccessToken(prisma, booking.id);
    expect(fresh).not.toBe(token);
    const res = await request(app).post(`/api/booking/${fresh}/payments`).send({ method: 'card' });
    expect(res.status, res.text).toBe(201);
    expect((res.body as CardBody).payment.ourRef).toBe(asked.ourRef);
    expect(await paymentOf(asked.ourRef)).toMatchObject({ provider: 'flutterwave_checkout', method: 'card', status: 'pending', amountRwf: asked.amountRwf });
  });

  it('settles by webhook, receipted, and earns the photographer the full amount (decision 3)', async () => {
    const { booking, token } = await confirmedWithFeePaid();
    const app = appWith();
    const { payment } = (await request(app).post(`/api/booking/${token}/payments`).send({ method: 'card' })).body as CardBody;

    expect((await webhook(app, fw.charge(payment.ourRef, 30_000))).status).toBe(200);
    const paid = await paymentOf(payment.ourRef);
    expect(paid.status).toBe('succeeded');
    expect(await prisma.payoutItem.findFirstOrThrow({ where: { paymentId: paid.id } })).toMatchObject({ kind: 'earning', amountRwf: 30_000, photographerId: world.photographerId });
    expect(await templatesOf(booking.id)).toContain('payment_receipt');
  });

  it('from the account dashboard: back to the account progress page', async () => {
    const { booking } = await confirmedWithFeePaid();
    const user = await createClientAccount(prisma, { email: CLIENT.email });
    const bearer = await accountToken(TEST_SECRET, prisma, user.id, NOW);
    const app = appWith();
    const res = await request(app).post(`/api/account/bookings/${booking.reference}/payments`).set('Authorization', `Bearer ${bearer}`).send({ method: 'card' });

    expect(res.status, res.text).toBe(201);
    await expectMatchesSpec(res, 'payAccountBookingSessionFee', 201);
    const { payment, card } = res.body as CardBody;
    expect(card).toMatchObject({ amount: 30_000, redirect_url: `${WEB_ORIGIN}/account/bookings/${booking.reference}/payments/${payment.ourRef}` });
    const again = await request(app).post(`/api/account/bookings/${booking.reference}/payments`).set('Authorization', `Bearer ${bearer}`).send({ method: 'card' });
    expect(again.status).toBe(200);
    expect((again.body as CardBody).payment.ourRef).toBe(payment.ourRef);
  });

  it('is payable by card for a booking whose photographer has since been suspended (R5.5)', async () => {
    const { token } = await confirmedWithFeePaid();
    await prisma.photographer.update({ where: { id: world.photographerId }, data: { status: 'suspended', suspendedAt: NOW } });
    expect((await request(appWith()).post(`/api/booking/${token}/payments`).send({ method: 'card' })).status).toBe(201);
  });
});

// --- Payout and refund (C7) --------------------------------------------------------------------------------------

describe('a card booking fee in the ledger and on the refunds page (C7)', () => {
  it('earns the full amount, and its refund is recorded by the platform like MoMo money', async () => {
    const booking = await insertBooking(prisma, world, { bookingFeeRefundableOnClientCancel: true });
    const app = appWith();
    const { payment } = (await payFee(app, booking.reference)).body as CardBody;
    expect((await webhook(app, fw.charge(payment.ourRef, 20_000))).status).toBe(200);
    // The confirmation's link, as the client would hold it.
    const token = await grantAccessToken(prisma, booking.id);
    const paid = await paymentOf(payment.ourRef);
    expect(await prisma.payoutItem.findFirstOrThrow({ where: { paymentId: paid.id, kind: 'earning' } })).toMatchObject({ amountRwf: 20_000, voidedAt: null });

    // The client cancels with a refundable fee: owed back, the earning voided.
    expect((await request(app).post(`/api/booking/${token}/cancel`).send({})).status).toBe(200);
    expect((await paymentOf(payment.ourRef)).status).toBe('refund_due');
    expect((await prisma.payoutItem.findFirstOrThrow({ where: { paymentId: paid.id, kind: 'earning' } })).voidedAt).not.toBeNull();

    // Listed for the platform, recorded by it after a refund in the Flutterwave dashboard.
    const platform = await platformToken();
    const list = await request(app).get('/api/platform/refunds').set('Authorization', `Bearer ${platform}`);
    expect(JSON.stringify(list.body)).toContain(paid.id);
    const recorded = await request(app).post(`/api/platform/refunds/${paid.id}`).set('Authorization', `Bearer ${platform}`).send({ reference: 'FLW-REFUND-1' });
    expect(recorded.status, recorded.text).toBe(200);
    expect(await paymentOf(payment.ourRef)).toMatchObject({ status: 'refunded', refundReference: 'FLW-REFUND-1' });

    // The studio may not record it: the money is in the platform's account.
    const studio = await studioToken();
    const studioRefund = await request(app).post(`/api/studio/payments/${paid.id}/refund`).set('Authorization', `Bearer ${studio}`).send({ reference: 'X' });
    expect(studioRefund.status).toBe(409);
  });
});

// --- The subscription (R5.2) ---------------------------------------------------------------------------------------

describe('subscription by card (R5.2)', () => {
  const pay = async (app: Express, body: object, bearer?: string) =>
    request(app).post('/api/studio/subscription/payments').set('Authorization', `Bearer ${bearer ?? (await studioToken())}`).send(body);

  it('charges the platform price, ignoring a forged amount, and returns to the studio page', async () => {
    const app = appWith();
    const res = await pay(app, { planInterval: 'monthly', method: 'card', amountRwf: 1, phone: 'x' });

    expect(res.status, res.text).toBe(201);
    await expectMatchesSpec(res, 'startSubscriptionPayment', 201);
    const body = res.body as CardBody & { payment: { planInterval: string; amountRwf: number } };
    expect(body.payment).toMatchObject({ status: 'pending', planInterval: 'monthly', amountRwf: 10_000 });
    expect(body.card).toMatchObject({
      tx_ref: body.payment.ourRef,
      amount: 10_000,
      currency: 'RWF',
      redirect_url: `${WEB_ORIGIN}/studio/subscription/payments/${body.payment.ourRef}`,
      customer: { email: PHOTOGRAPHER_EMAIL, name: PHOTOGRAPHER_NAME },
      customizations: { title: 'Bookly monthly subscription' },
    });
    expect(await paymentOf(body.payment.ourRef)).toMatchObject({ kind: 'subscription', provider: 'flutterwave_checkout', amountRwf: 10_000, planInterval: 'monthly' });
  });

  it('answers the same plan again with the same payment, and another plan with payment_in_progress', async () => {
    const app = appWith();
    const first = (await pay(app, { planInterval: 'yearly', method: 'card' })).body as CardBody;
    const again = await pay(app, { planInterval: 'yearly', method: 'card' });
    expect(again.status).toBe(200);
    await expectMatchesSpec(again, 'startSubscriptionPayment', 200);
    expect((again.body as CardBody).payment.ourRef).toBe(first.payment.ourRef);

    const other = await pay(app, { planInterval: 'monthly', method: 'card' });
    expect(other.status).toBe(409);
    expect(other.body).toStrictEqual({ error: 'payment_in_progress', payment: { ourRef: first.payment.ourRef, method: 'card' } });
    expect(await prisma.payment.count({ where: { kind: 'subscription' } })).toBe(1);
  });

  it('shows the open card checkout as the payment in progress', async () => {
    const app = appWith();
    const { payment } = (await pay(app, { planInterval: 'monthly', method: 'card' })).body as CardBody;
    await age(payment.ourRef, 600);
    const page = await request(app).get('/api/studio/subscription').set('Authorization', `Bearer ${await studioToken()}`);
    expect(page.body.subscription.paymentInProgress).toMatchObject({ ourRef: payment.ourRef, method: 'card' });
    expect(page.body.methods).toEqual(['momo_mtn', 'card']);
  });

  it('adds the period on a verified success: on top of the current end, active, receipted', async () => {
    const app = appWith();
    const { payment } = (await pay(app, { planInterval: 'monthly', method: 'card' })).body as CardBody;
    const before = await prisma.subscription.findUniqueOrThrow({ where: { photographerId: world.photographerId } });

    expect((await webhook(app, fw.charge(payment.ourRef, 10_000))).status).toBe(200);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { photographerId: world.photographerId } });
    expect(after.status).toBe('active');
    expect(after.currentPeriodEndsAt.toISOString()).toBe('2100-02-01T00:00:00.000Z');
    expect(before.currentPeriodEndsAt.toISOString()).toBe('2100-01-01T00:00:00.000Z');
    const paid = await paymentOf(payment.ourRef);
    expect(await prisma.subscriptionPeriod.findFirstOrThrow({ where: { paymentId: paid.id } })).toMatchObject({ kind: 'paid', planInterval: 'monthly', priceRwf: 10_000 });
    expect(await rows("SELECT template FROM outbox WHERE template = 'subscription_receipt'")).toHaveLength(1);
    expect(await prisma.payoutItem.count()).toBe(0);
  });

  it('settles through the studio poll, and the public poll never asks about it', async () => {
    const app = appWith();
    const bearer = await studioToken();
    const { payment } = (await pay(app, { planInterval: 'monthly', method: 'card' }, bearer)).body as CardBody;
    const tx = fw.charge(payment.ourRef, 10_000);

    expect((await request(app).get(`/api/payments/${payment.ourRef}`)).status).toBe(404);
    expect(fw.calls).toEqual([]);

    const res = await request(app).get(`/api/studio/subscription/payments/${payment.ourRef}`).query({ transactionId: String(tx.id) }).set('Authorization', `Bearer ${bearer}`);
    await expectMatchesSpec(res, 'getStudioSubscriptionPayment', 200);
    expect(res.body.payment.status).toBe('succeeded');
    expect(res.body.subscription.status).toBe('active');
  });

  it("never asks about another photographer's payment from the studio poll (isolation)", async () => {
    const second = await seedSecondPhotographer(prisma, world);
    const app = appWith();
    const { payment } = (await pay(app, { planInterval: 'monthly', method: 'card' }, await studioToken(second))).body as CardBody;
    fw.charge(payment.ourRef, 10_000);

    const res = await request(app).get(`/api/studio/subscription/payments/${payment.ourRef}`).set('Authorization', `Bearer ${await studioToken()}`);
    expect(res.status).toBe(404);
    expect(fw.calls).toEqual([]);
    expect((await paymentOf(payment.ourRef)).status).toBe('pending');
  });

  it('lets an expired subscription pay by card', async () => {
    const fresh = await seedSecondPhotographer(prisma, world, { email: 'expired@bookly.example', handle: 'expired-studio' });
    await raw.query(`UPDATE subscription SET status = 'expired', current_period_ends_at = now() - interval '30 days' WHERE photographer_id = $1`, [fresh.photographerId]);
    const res = await pay(appWith(), { planInterval: 'monthly', method: 'card' }, await studioToken(fresh));
    expect(res.status, res.text).toBe(201);
  });
});
