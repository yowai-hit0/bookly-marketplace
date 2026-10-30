import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { issueToken } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { recordEvent } from '../payments/webhooks.js';
import { addPlanInterval } from '../subscriptions/plan.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { expectMatchesSpec } from '../test/openapi.js';
import {
  type PaymentWorld,
  type StubProvider,
  TEST_SECRET,
  delay,
  insertBooking,
  insertPayment,
  routeTo,
  seedSecondPhotographer,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';

/**
 * `/api/studio/subscription*` over HTTP (marketplace-spec.md R5.2, R5.3, T5.3):
 * the page, paying for a month or a year by MoMo, and polling the payment. The
 * amount is the platform's, never the request's; one payment at a time; the
 * signed-in photographer's own only.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let provider: StubProvider;
let app: Express;
let token: string;
let clock: Date;

const WEB_ORIGIN = 'https://bookly.example';
/** Day 25 of a trial approved on 1 October (T5.2): the trial ends 31 October 06:00. */
const NOW = new Date('2026-10-26T06:00:00.000Z');
const TRIAL_END = new Date('2026-10-31T06:00:00.000Z');
const BODY = { planInterval: 'monthly', method: 'momo_mtn', phone: '0788 123 456' };

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

function build(routing = routeTo(provider)) {
  return createApp({
    corsOrigin: WEB_ORIGIN,
    auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: WEB_ORIGIN, now: () => clock },
    publicApi: { prisma, now: () => clock, payments: { routing, secret: TEST_SECRET, providerTimeoutMs: 200 } },
  });
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await truncateAll(raw);
  clock = NOW;
  world = await seedWorld(prisma);
  // The world photographer's trial: approved 1 October, ends 31 October (R5.1).
  await prisma.subscription.update({ where: { photographerId: world.photographerId }, data: { currentPeriodEndsAt: TRIAL_END } });
  await prisma.subscriptionPeriod.updateMany({ data: { startsAt: new Date('2026-10-01T06:00:00.000Z'), endsAt: TRIAL_END } });
  provider = stubProvider();
  app = build();
  token = await tokenFor(world);
});

async function tokenFor(of: PaymentWorld): Promise<string> {
  const user = await prisma.appUser.findUniqueOrThrow({ where: { id: of.photographerUserId } });
  return (await issueToken(TEST_SECRET, 'studio', user, clock)).token;
}

const page = (bearer = token, server = app) => request(server).get('/api/studio/subscription').set('Authorization', `Bearer ${bearer}`);
const pay = (body: object = BODY, bearer = token, server = app) =>
  request(server).post('/api/studio/subscription/payments').set('Authorization', `Bearer ${bearer}`).send(body);
const poll = (ourRef: string, bearer = token) => request(app).get(`/api/studio/subscription/payments/${ourRef}`).set('Authorization', `Bearer ${bearer}`);

const subscriptionId = async (of = world) => (await prisma.subscription.findUniqueOrThrow({ where: { photographerId: of.photographerId } })).id;

function settle(ourRef: string, at: Date) {
  return recordEvent({ prisma, now: () => at, log: () => undefined }, 'mtn_momo_direct', {
    signatureValid: true,
    event: { eventId: randomUUID(), eventType: 'test', ourRef, providerRef: null, reportedStatus: 'succeeded', method: 'momo_mtn', failureReason: null, amount: null },
    payload: {},
    expectedCurrency: 'EUR',
  });
}

describe('GET /api/studio/subscription', () => {
  it('shows the trial, its end, the history, both prices and the methods on offer', async () => {
    const res = await page();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    await expectMatchesSpec(res, 'getStudioSubscription', 200);
    const id = await subscriptionId();
    const trial = {
      id: expect.any(String),
      kind: 'trial',
      planInterval: null,
      priceRwf: 0,
      startsAt: '2026-10-01T06:00:00.000Z',
      endsAt: TRIAL_END.toISOString(),
      paidAt: null,
    };
    expect(res.body).toEqual({
      subscription: {
        id,
        status: 'trialing',
        currentPeriodEndsAt: TRIAL_END.toISOString(),
        graceEndsAt: '2026-11-07T06:00:00.000Z',
        takingBookings: true,
        currentPeriod: trial,
        periods: [trial],
        paymentInProgress: null,
      },
      prices: { monthly: 10_000, yearly: 100_000 },
      methods: ['momo_mtn'],
      graceDays: 7,
    });
  });

  it('computes the status from the clock, even before the job has run: past_due, then expired (R5.4)', async () => {
    clock = new Date('2026-11-02T06:00:00.000Z');
    token = await tokenFor(world);
    expect((await page()).body.subscription).toMatchObject({ status: 'past_due', takingBookings: false, currentPeriod: null });
    clock = new Date('2026-11-08T06:00:00.000Z');
    token = await tokenFor(world);
    expect((await page()).body.subscription).toMatchObject({ status: 'expired', takingBookings: false });
  });

  it('says not taking bookings for a suspended photographer, whose period still runs', async () => {
    await prisma.photographer.update({ where: { id: world.photographerId }, data: { status: 'suspended', suspendedAt: NOW } });
    expect((await page()).body.subscription).toMatchObject({ status: 'trialing', takingBookings: false });
  });

  it('answers a null subscription, with the prices, for a photographer never approved', async () => {
    await prisma.subscriptionPeriod.deleteMany();
    await prisma.subscription.deleteMany();
    await prisma.photographer.update({ where: { id: world.photographerId }, data: { status: 'pending', approvedAt: null } });

    const res = await page();
    await expectMatchesSpec(res, 'getStudioSubscription', 200);
    expect(res.body).toMatchObject({ subscription: null, prices: { monthly: 10_000, yearly: 100_000 } });
  });

  it('offers no method when no payment provider is configured', async () => {
    const offline = createApp({ corsOrigin: WEB_ORIGIN, auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: WEB_ORIGIN, now: () => clock } });
    expect((await page(token, offline)).body.methods).toEqual([]);
    expect((await pay(BODY, token, offline)).body).toEqual({ error: 'validation_failed', fields: ['method'] });
  });

  it('refuses a request without a studio token', async () => {
    expect((await request(app).get('/api/studio/subscription')).status).toBe(401);
    expect((await request(app).post('/api/studio/subscription/payments').send(BODY)).status).toBe(401);
  });
});

describe('POST /api/studio/subscription/payments', () => {
  it("charges the platform's price and prompts the phone, whatever amount the body names (T5.3)", async () => {
    const res = await pay({ ...BODY, planInterval: 'yearly', amountRwf: 1, amount: 1, status: 'succeeded', provider: 'cash' });

    expect(res.status).toBe(201);
    await expectMatchesSpec(res, 'startSubscriptionPayment', 201);
    expect(res.body).toEqual({ payment: { ourRef: expect.any(String), status: 'pending', planInterval: 'yearly', amountRwf: 100_000 } });
    expect(provider.initiated).toEqual([expect.objectContaining({ amountRwf: 100_000, kind: 'subscription', payerPhone: '+250788123456' })]);
    await expect(prisma.payment.findUniqueOrThrow({ where: { ourRef: res.body.payment.ourRef } })).resolves.toMatchObject({
      amountRwf: 100_000,
      status: 'pending',
      provider: 'mtn_momo_direct',
      subscriptionId: await subscriptionId(),
    });
  });

  it('makes one payment of two sent at once; the other is told which is in progress (T5.3)', async () => {
    provider = stubProvider({ initiate: async () => (await delay(100), { outcome: 'accepted', providerRef: null }) });
    app = build();

    const [first, second] = await Promise.all([pay(), pay({ ...BODY, planInterval: 'yearly' })]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    const started = first.status === 201 ? first : second;
    const refused = first.status === 201 ? second : first;
    await expectMatchesSpec(refused, 'startSubscriptionPayment', 409);
    expect(refused.body).toEqual({ error: 'payment_in_progress', payment: { ourRef: started.body.payment.ourRef, method: 'momo_mtn' } });
    await expect(prisma.payment.count({ where: { kind: 'subscription' } })).resolves.toBe(1);
    expect(provider.initiated).toHaveLength(1);
    // The page shows it as in progress.
    expect((await page()).body.subscription.paymentInProgress).toMatchObject({ ourRef: started.body.payment.ourRef, status: 'pending', amountRwf: 10_000 });
  });

  it.each([['card', 'flutterwave_checkout'], ['momo_airtel', 'flutterwave'], ['momo_mtn', 'mtn_momo_direct']] as const)(
    'names the waiting payment’s %s method in the 409 payment_in_progress',
    async (method, waitingProvider) => {
      const waiting = await prisma.payment.create({
        data: { kind: 'subscription', subscriptionId: await subscriptionId(), provider: waitingProvider, method, amountRwf: 10_000, planInterval: 'monthly', status: 'pending' },
      });

      const res = await pay({ ...BODY, planInterval: 'yearly' });

      expect(res.status).toBe(409);
      await expectMatchesSpec(res, 'startSubscriptionPayment', 409);
      expect(res.body).toEqual({ error: 'payment_in_progress', payment: { ourRef: waiting.ourRef, method } });
    },
  );

  it.each([
    ['suspended', { status: 'suspended', suspendedAt: NOW }],
    ['pending', { status: 'pending' }],
  ])('refuses a %s photographer with 409 photographer_not_approved', async (_label, data) => {
    await prisma.photographer.update({ where: { id: world.photographerId }, data });
    const res = await pay();
    expect(res.status).toBe(409);
    await expectMatchesSpec(res, 'startSubscriptionPayment', 409);
    expect(res.body).toEqual({ error: 'photographer_not_approved' });
    expect(provider.initiated).toEqual([]);
  });

  it('lets an expired subscription pay, and the success makes the photographer bookable again', async () => {
    clock = new Date('2026-11-20T06:00:00.000Z');
    token = await tokenFor(world);
    await prisma.subscription.update({ where: { photographerId: world.photographerId }, data: { status: 'expired' } });

    const res = await pay();
    expect(res.status).toBe(201);
    await settle(res.body.payment.ourRef, clock);

    expect((await page()).body.subscription).toMatchObject({
      status: 'active',
      takingBookings: true,
      currentPeriodEndsAt: addPlanInterval(clock, 'monthly').toISOString(),
    });
  });

  it.each([
    [{ ...BODY, method: 'momo_airtel' }, ['method']],
    [{ ...BODY, method: 'card' }, ['method']],
    [{ ...BODY, phone: '12' }, ['phone']],
  ])('refuses %o with 422 naming the field', async (body, fields) => {
    const res = await pay(body);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'validation_failed', fields });
    await expect(prisma.payment.count()).resolves.toBe(0);
  });

  it.each([[{ ...BODY, planInterval: 'weekly' }], [{ method: 'momo_mtn', phone: '0788123456' }], [{ ...BODY, phone: 788123456 }]])('refuses %o with 400', async (body) => {
    expect((await pay(body)).body).toEqual({ error: 'invalid_request' });
  });

  it('answers 502 payment_not_started when the provider refuses or is unreachable; the attempt is failed and another may start', async () => {
    provider = stubProvider({ initiate: async () => ({ outcome: 'rejected', reason: 'PAYER_NOT_FOUND' }) });
    app = build();

    const res = await pay();
    expect(res.status).toBe(502);
    await expectMatchesSpec(res, 'startSubscriptionPayment', 502);
    expect(res.body).toEqual({ error: 'payment_not_started', reason: 'rejected', payment: { ourRef: expect.any(String), status: 'failed' } });

    provider = stubProvider({ initiate: () => new Promise(() => undefined) });
    app = build();
    expect((await pay()).body).toMatchObject({ reason: 'unavailable' });
    expect((await poll((await prisma.payment.findFirstOrThrow({ where: { failureReason: 'provider_timeout' } })).ourRef)).body.payment).toMatchObject({
      status: 'failed',
      failure: 'unavailable',
    });
  });

  it('is rate-limited per address with the client payment routes', async () => {
    const limited = createApp({
      corsOrigin: WEB_ORIGIN,
      auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: WEB_ORIGIN, now: () => clock },
      publicApi: { prisma, now: () => clock, payments: { routing: routeTo(provider), secret: TEST_SECRET } },
      rateLimits: { paymentsPerIp: { limit: 1, windowMs: 60_000 } },
    });
    expect((await pay(BODY, token, limited)).status).toBe(201);
    expect((await pay(BODY, token, limited)).status).toBe(429);
  });
});

describe('GET /api/studio/subscription/payments/:ourRef', () => {
  it('shows the payment, and the subscription as the success leaves it', async () => {
    const started = await pay();
    const { ourRef } = started.body.payment;

    const waiting = await poll(ourRef);
    await expectMatchesSpec(waiting, 'getStudioSubscriptionPayment', 200);
    expect(waiting.body).toEqual({
      payment: { ourRef, status: 'pending', planInterval: 'monthly', amountRwf: 10_000, method: 'momo_mtn', failure: null, initiatedAt: expect.any(String), settledAt: null },
      subscription: { status: 'trialing', currentPeriodEndsAt: TRIAL_END.toISOString(), takingBookings: true },
    });

    await settle(ourRef, NOW);
    const paid = await poll(ourRef);
    expect(paid.body).toMatchObject({
      payment: { status: 'succeeded', settledAt: NOW.toISOString() },
      subscription: { status: 'active', currentPeriodEndsAt: addPlanInterval(TRIAL_END, 'monthly').toISOString() },
    });
    expect((await page()).body.subscription.periods[0]).toMatchObject({ kind: 'paid', paidAt: NOW.toISOString(), startsAt: TRIAL_END.toISOString() });
  });

  it("404s another photographer's payment, a booking's payment, an unknown reference and a malformed one alike", async () => {
    const other = await seedSecondPhotographer(prisma, world);
    const theirs = (await pay(BODY, await tokenFor(other))).body.payment.ourRef as string;
    const booking = await insertBooking(prisma, world);
    const fee = await insertPayment(prisma, booking.id);

    for (const ref of [theirs, fee.ourRef, randomUUID(), 'not-a-uuid']) {
      const res = await poll(ref);
      expect(res.status, ref).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    }
  });

  it('is not served by the public payment status route: a subscription reference is unknown there', async () => {
    const { ourRef } = (await pay()).body.payment;
    expect((await request(app).get(`/api/payments/${ourRef}`)).body).toEqual({ error: 'not_found' });
  });
});
