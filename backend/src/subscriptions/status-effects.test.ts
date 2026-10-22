import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { issueToken } from '../auth/token.js';
import { claimSlot } from '../booking/claim.js';
import { createPrismaClient } from '../db/client.js';
import { checkoutToken } from '../payments/checkout-link.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  CLIENT,
  PHOTOGRAPHER_HANDLE,
  type PaymentWorld,
  TEST_SECRET,
  insertBooking,
  insertBookingWithToken,
  insertPayment,
  routeTo,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';
import { DAY_MS } from './plan.js';

/**
 * What each subscription status does to a photographer, over HTTP
 * (marketplace-spec.md R5.4, R5.5, T5.4, T3.4):
 *
 *   - `past_due` -- the period over, inside the grace days: still listed, with
 *     `takingBookings: false`; profile and services shown; the quote, the
 *     calendar and the booking form answer as for an inactive package; a new
 *     booking-fee payment is `photographer_unavailable`.
 *   - `expired` -- past the grace: not listed; the profile and services are the
 *     404 a suspended photographer's are.
 *   - In EVERY status, existing bookings carry on: the client's page, the
 *     session fee and the studio's delivery.
 *
 * Each is checked with the job's status written (`past_due`, `expired`) and
 * with the job never having run (still `trialing`): bookability compares the
 * period's end with the clock directly (R5.4). The injected clock is the real
 * one, so the paths that measure on the database clock -- the slot claim and
 * the booking-fee initiation -- see the same lapse.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let app: Express;

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const WEB_ORIGIN = 'https://bookly.example';
const PHOTOGRAPHERS = '/api/photographers';
const PROFILE = `${PHOTOGRAPHERS}/${PHOTOGRAPHER_HANDLE}`;

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
  // Mon-Fri 09:00-17:00, so the calendar offers slots.
  await prisma.workingHours.createMany({
    data: [1, 2, 3, 4, 5].map((weekday) => ({ photographerId: world.photographerId, weekday, opensMinute: 540, closesMinute: 1020, isOpen: true })),
  });
  app = createApp({
    corsOrigin: WEB_ORIGIN,
    auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: WEB_ORIGIN, now: () => NOW },
    publicApi: { prisma, now: () => NOW, payments: { routing: routeTo(stubProvider()), secret: TEST_SECRET } },
  });
});

/** The subscription's period ended `daysAgo` days before now; `stored` is what the job has written. */
async function lapse(daysAgo: number, stored: string): Promise<void> {
  await prisma.subscription.update({
    where: { photographerId: world.photographerId },
    data: { currentPeriodEndsAt: new Date(NOW.getTime() - daysAgo * DAY_MS), status: stored },
  });
}

/** The first slot the calendar offers in the next two months. */
async function firstSlot(): Promise<string> {
  for (const offset of [1, 2]) {
    const month = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
    const res = await request(app).get(`/api/availability?packageId=${world.packageId}&month=${month}`);
    const start = (res.body as { days?: { starts: string[] }[] }).days?.flatMap((day) => day.starts)[0];
    if (start !== undefined) return start;
  }
  throw new Error('no slot offered');
}

const bookingBody = (startsAt: string) => ({
  packageId: world.packageId,
  startsAt,
  fullName: 'Aline Uwase',
  email: 'new.client@example.com',
  phone: '+250788123456',
  location: 'Kigali Heights',
  consent: true,
});

async function studioToken(): Promise<string> {
  const user = await prisma.appUser.findUniqueOrThrow({ where: { id: world.photographerUserId } });
  return (await issueToken(TEST_SECRET, 'studio', user, NOW)).token;
}

describe.each([
  ['recorded by the job', 'past_due'],
  ['before the job has run', 'trialing'],
])('past_due, %s (R5.5, T5.4)', (_label, stored) => {
  beforeEach(async () => {
    await lapse(1, stored);
  });

  it('is still listed, profile and services included, not taking bookings', async () => {
    const list = await request(app).get(PHOTOGRAPHERS);
    expect(list.body.photographers).toEqual([expect.objectContaining({ handle: PHOTOGRAPHER_HANDLE, takingBookings: false })]);
    const profile = await request(app).get(PROFILE);
    expect(profile.status).toBe(200);
    expect(profile.body.photographer).toMatchObject({ takingBookings: false });
    for (const hidden of ['past_due', 'trialing', 'subscription', 'currentPeriodEndsAt']) expect(profile.text).not.toContain(hidden);
    expect((await request(app).get(`${PROFILE}/services`)).status).toBe(200);
    expect((await request(app).get(`${PROFILE}/services/portraits`)).body.service).toMatchObject({ takingBookings: false });
  });

  it('answers the quote and the calendar as for an inactive package', async () => {
    const quote = await request(app).post('/api/quote').send({ packageId: world.packageId, addonIds: [] });
    expect([quote.status, quote.body]).toEqual([422, { error: 'validation_failed', fields: ['packageId'] }]);
    const month = new Date(NOW.getTime() + 31 * DAY_MS).toISOString().slice(0, 7);
    const calendar = await request(app).get(`/api/availability?packageId=${world.packageId}&month=${month}`);
    expect([calendar.status, calendar.body]).toEqual([422, { error: 'validation_failed', fields: ['packageId'] }]);
  });

  it('refuses POST /bookings for a slot it offered a moment ago, as the existing unbookable answer: 422 on packageId (T5.4)', async () => {
    await prisma.subscription.update({ where: { photographerId: world.photographerId }, data: { currentPeriodEndsAt: new Date('2100-01-01T00:00:00Z'), status: 'trialing' } });
    const slot = await firstSlot();
    await lapse(1, stored);

    const res = await request(app).post('/api/bookings').send(bookingBody(slot));

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'validation_failed', fields: ['packageId'] });
    await expect(prisma.booking.count()).resolves.toBe(0);
  });

  it('refuses the claim itself, on the database clock, should a caller get past the read', async () => {
    const result = await claimSlot(
      prisma,
      world.photographerId,
      {
        reference: 'BKY-2611-AAAAA',
        clientId: world.clientId,
        contactName: CLIENT.name,
        contactEmail: CLIENT.email,
        contactPhone: CLIENT.phone,
        serviceId: world.serviceId,
        packageId: world.packageId,
        serviceNameSnapshot: 'Portraits',
        packageNameSnapshot: 'Standard',
        packagePriceRwf: 40_000,
        packageDurationMinutes: 90,
        packagePhotoCount: 25,
        startsAt: new Date('2027-03-01T07:00:00Z'),
        endsAt: new Date('2027-03-01T08:30:00Z'),
        bufferEndsAt: new Date('2027-03-01T09:00:00Z'),
        locationText: 'Kigali',
        consentAt: NOW,
        bookingFeeRate: '0.400',
        bookingFeeRwf: 20_000,
        clientCancelCutoffHours: 0,
        bookingFeeRefundableOnClientCancel: false,
      },
      30,
    );
    expect(result).toEqual({ status: 'not_bookable' });
  });

  it('refuses a new booking-fee payment for a held booking: photographer_unavailable, nothing charged (T3.4)', async () => {
    const booking = await insertBooking(prisma, world);
    const res = await request(app)
      .post(`/api/checkout/${booking.reference}/${checkoutToken(TEST_SECRET, booking.reference)}/payments`)
      .send({ method: 'momo_mtn', phone: '0788123456' });

    expect([res.status, res.body]).toEqual([409, { error: 'photographer_unavailable' }]);
    await expect(prisma.payment.count()).resolves.toBe(0);
  });
});

describe.each([
  ['recorded by the job', 'expired'],
  ['before the job has run', 'trialing'],
])('expired, %s (R5.5)', (_label, stored) => {
  beforeEach(async () => {
    await lapse(8, stored);
  });

  it('is hidden: not listed, and the profile, services and service are the same 404 as a suspended photographer', async () => {
    expect((await request(app).get(PHOTOGRAPHERS)).body).toEqual({ photographers: [] });
    const answers = await Promise.all([PROFILE, `${PROFILE}/services`, `${PROFILE}/services/portraits`].map((path) => request(app).get(path)));
    for (const res of answers) expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);

    // A suspended photographer with a running subscription answers exactly the same.
    await prisma.subscription.update({ where: { photographerId: world.photographerId }, data: { currentPeriodEndsAt: new Date('2100-01-01T00:00:00Z'), status: 'trialing' } });
    await prisma.photographer.update({ where: { id: world.photographerId }, data: { status: 'suspended', suspendedAt: NOW } });
    const suspended = await request(app).get(PROFILE);
    expect([suspended.status, suspended.text]).toEqual([404, answers[0]?.text]);
  });

  it('is listed again within the grace once the grace is widened: the grace end is read from the clock', async () => {
    if (stored === 'expired') return; // The job's `expired` stands until a payment: widening the grace never un-expires.
    await prisma.platformSetting.update({ where: { id: 1 }, data: { subscriptionGraceDays: 10 } });
    expect((await request(app).get(PHOTOGRAPHERS)).body.photographers).toEqual([expect.objectContaining({ takingBookings: false })]);
  });
});

describe.each([
  ['past_due', 1, 'past_due'],
  ['expired', 8, 'expired'],
  ['expired, the job late', 8, 'trialing'],
])('existing bookings carry on when %s (R5.5, T5.4)', (_label, daysAgo, stored) => {
  beforeEach(async () => {
    await lapse(daysAgo, stored);
  });

  it("serves the client's booking page and takes the session fee", async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { kind: 'booking_fee', status: 'succeeded', amountRwf: 20_000 });

    expect((await request(app).get(`/api/booking/${token}`)).status).toBe(200);
    const res = await request(app).post(`/api/booking/${token}/payments`).send({ method: 'momo_mtn', phone: '0788123456' });

    expect(res.status).toBe(201);
    await expect(prisma.payment.findUniqueOrThrow({ where: { ourRef: res.body.payment.ourRef } })).resolves.toMatchObject({
      kind: 'session_fee',
      amountRwf: 30_000,
      status: 'pending',
    });
  });

  it('lets the studio deliver the photos of a completed booking', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    const res = await request(app)
      .put(`/api/studio/bookings/${booking.id}/delivery`)
      .set('Authorization', `Bearer ${await studioToken()}`)
      .send({ url: 'https://photos.example-host.com/s/abc' });

    expect(res.status).toBe(200);
    await expect(prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).resolves.toMatchObject({ deliveryUrl: 'https://photos.example-host.com/s/abc' });
  });

  it('lets the photographer ask for the session fee', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await insertPayment(prisma, booking.id, { kind: 'booking_fee', status: 'succeeded', amountRwf: 20_000 });
    const res = await request(app).post(`/api/studio/bookings/${booking.id}/session-fee`).set('Authorization', `Bearer ${await studioToken()}`);

    expect(res.status).toBe(200);
  });
});
