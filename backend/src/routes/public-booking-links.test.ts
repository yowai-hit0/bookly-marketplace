import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { findBookingByToken } from '../booking/access.js';
import { createPrismaClient } from '../db/client.js';
import { renderEmail } from '../email/render.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  CLIENT,
  PHOTOGRAPHER_NAME,
  type PaymentWorld,
  grantAccessToken,
  insertBooking,
  insertPayment,
  logSink,
  seedSecondPhotographer,
  seedWorld,
} from '../test/payment-fixtures.js';
import { RequestLimiter } from './public-booking-links.js';

/**
 * "Email me my links" over HTTP (docs/prompts/client-access-and-admin-polish.md,
 * item 4), against real PostgreSQL.
 *
 * What is proven: the answer is a byte-identical 202 whether the address has
 * bookings, has none, or has asked too often, so the page tells nobody who
 * books. A match sends one email, to the address on the bookings, listing each
 * current booking (confirmed and still ahead, or completed and still owing or
 * with live photos) with a fresh link. The old links stop working and the new
 * ones open their bookings. Past, cancelled, expired and unpaid bookings are
 * left out. One email per address every 10 minutes and five a day, however the
 * address is typed, and six requests at once still send one. The per-IP limit
 * stops the work but not the answer. A malformed email is a 422 and sends
 * nothing. No token is in any response or log line.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let sink: ReturnType<typeof logSink>;

/** Before every fixture booking (January 2027 on), after the "past" one. */
const NOW = new Date('2026-10-01T06:00:00Z');
const PATH = '/api/booking-links';

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

type App = { app: Express; settled: () => Promise<void>; works: Promise<unknown>[] };

function appWith(limiter?: RequestLimiter): App {
  const works: Promise<unknown>[] = [];
  const app = createApp({
    publicApi: {
      prisma,
      now: () => NOW,
      bookingLinks: { onWork: (work) => works.push(work), log: sink.log, ...(limiter === undefined ? {} : { limiter }) },
    },
  });
  return { app, works, settled: async () => void (await Promise.all(works)) };
}

async function ask(target: App, email: unknown = CLIENT.email) {
  const res = await request(target.app).post(PATH).send({ email });
  await target.settled();
  return res;
}

type Sent = {
  recipient: string;
  payload: { clientName: string; bookings: { reference: string; accessToken: string; photographerName?: string }[] };
  booking_id: string | null;
};

async function linkEmails(): Promise<Sent[]> {
  return (await raw.query<Sent>("SELECT recipient, payload, booking_id FROM outbox WHERE template = 'booking_links' ORDER BY created_at")).rows;
}

async function completed(extra: { deliveryUrl?: string; deliveryExpiresOn?: string; paidRwf?: number } = {}) {
  const booking = await insertBooking(prisma, world, { status: 'completed', holdMinutes: null });
  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      confirmedAt: new Date('2026-09-01T06:00:00Z'),
      completedAt: new Date('2027-01-10T10:00:00Z'),
      ...(extra.deliveryUrl === undefined ? {} : { deliveryUrl: extra.deliveryUrl }),
      ...(extra.deliveryExpiresOn === undefined ? {} : { deliveryExpiresOn: new Date(`${extra.deliveryExpiresOn}T00:00:00Z`) }),
    },
  });
  // 40,000 package plus the 10,000 own add-on: 50,000 in all.
  if (extra.paidRwf !== undefined) await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: extra.paidRwf });
  return booking;
}

describe('POST /api/booking-links', () => {
  it('emails one fresh link per current booking to the booking’s address; the old links stop working', async () => {
    const target = appWith();
    const first = await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null });
    const second = await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null });
    const oldFirst = await grantAccessToken(prisma, first.id);
    const oldSecond = await grantAccessToken(prisma, second.id);

    const res = await ask(target);

    expect([res.status, res.body]).toEqual([202, { sent: true }]);
    const [email, ...more] = await linkEmails();
    expect(more).toEqual([]);
    expect(email?.recipient).toBe(CLIENT.email);
    expect(email?.booking_id).toBeNull();
    expect(email?.payload.clientName).toBe(CLIENT.name);
    expect(email?.payload.bookings.map((b) => b.reference)).toEqual([first.reference, second.reference]);

    await expect(findBookingByToken(prisma, oldFirst)).resolves.toBeNull();
    await expect(findBookingByToken(prisma, oldSecond)).resolves.toBeNull();
    const [newFirst, newSecond] = email?.payload.bookings ?? [];
    expect((await findBookingByToken(prisma, newFirst?.accessToken ?? ''))?.id).toBe(first.id);
    expect((await findBookingByToken(prisma, newSecond?.accessToken ?? ''))?.id).toBe(second.id);
  });

  it('lists bookings with several photographers in one email, each naming its photographer', async () => {
    const target = appWith();
    const second = await seedSecondPhotographer(prisma, world, { displayName: 'Hills & Light' });
    const mine = await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null });
    const theirs = await insertBooking(prisma, second, { status: 'confirmed', holdMinutes: null });

    await ask(target);

    const [email, ...more] = await linkEmails();
    expect(more).toEqual([]);
    expect(email?.payload.bookings.map((b) => [b.reference, b.photographerName])).toEqual([
      [mine.reference, PHOTOGRAPHER_NAME],
      [theirs.reference, 'Hills & Light'],
    ]);
    const rendered = renderEmail('booking_links', email?.payload, { webOrigin: 'https://bookly.example' });
    expect(rendered.text).toContain(`Photographer: ${PHOTOGRAPHER_NAME}`);
    expect(rendered.text).toContain('Photographer: Hills & Light');
  });

  it('lists only bookings the client can still act on', async () => {
    const target = appWith();
    const upcoming = await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null });
    const owing = await completed({ paidRwf: 20_000 });
    const photosLive = await completed({ paidRwf: 50_000, deliveryUrl: 'https://photos.example/a', deliveryExpiresOn: '2026-10-01' });
    const settled = await completed({ paidRwf: 50_000, deliveryUrl: 'https://photos.example/b', deliveryExpiresOn: '2026-09-30' });
    const past = await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null, startsAt: new Date('2026-09-01T07:00:00Z') });
    const waiting = await insertBooking(prisma, world, { status: 'pending_payment' });
    const expired = await insertBooking(prisma, world, { status: 'expired' });
    const cancelled = await insertBooking(prisma, world, { status: 'cancelled_by_client', holdMinutes: null });
    const tokens = await Promise.all([settled, past, waiting, expired, cancelled].map((booking) => grantAccessToken(prisma, booking.id)));

    await ask(target);

    const listed = (await linkEmails())[0]?.payload.bookings.map((b) => b.reference);
    expect([...(listed ?? [])].sort()).toEqual([upcoming.reference, owing.reference, photosLive.reference].sort());
    // What was left out keeps the link it had.
    for (const token of tokens) await expect(findBookingByToken(prisma, token)).resolves.not.toBeNull();
  });

  it('answers byte-for-byte the same for a match, no match and a limited request', async () => {
    const target = appWith();
    await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null });

    const match = await ask(target);
    const limited = await ask(target);
    const nobody = await ask(target, 'nobody@example.com');

    for (const res of [match, limited, nobody]) {
      expect(res.status).toBe(202);
      expect(res.text).toBe(match.text);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(await linkEmails()).toHaveLength(1);
  });

  // Security review 2026-10-11, finding 1 (marketplace spec T0.1): the address
  // was matched with ILIKE, so `_` and `%` in the typed string were wildcards
  // that reached strangers' bookings and rotated their links.
  it.each(['aline_private@example.com', '%@example.com', '_____________@example.com'])(
    'treats %j as an address, never a pattern: no email, and the matching stranger keeps their link',
    async (pattern) => {
      const target = appWith();
      const victim = await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null });
      const victimToken = await grantAccessToken(prisma, victim.id);

      const res = await ask(target, pattern);

      expect(res.status === 202 || res.status === 422).toBe(true);
      expect(await linkEmails()).toEqual([]);
      expect((await findBookingByToken(prisma, victimToken))?.id).toBe(victim.id);
    },
  );

  it('matches the address however it is typed, and counts it as one address', async () => {
    const target = appWith();
    await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null });

    await ask(target, `  ${CLIENT.email.toUpperCase()} `);
    await ask(target, CLIENT.email);

    const emails = await linkEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0]?.recipient).toBe(CLIENT.email);
  });

  it('sends again once 10 minutes have passed, and stops at five a day', async () => {
    const target = appWith();
    await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null });

    for (let sent = 1; sent <= 5; sent += 1) {
      await ask(target);
      expect(await linkEmails()).toHaveLength(sent);
      // Every email so far into the past, clear of the cooldown but inside the day.
      await raw.query("UPDATE outbox SET created_at = created_at - interval '11 minutes' WHERE template = 'booking_links'");
    }
    await ask(target);
    expect(await linkEmails()).toHaveLength(5);

    await raw.query("UPDATE outbox SET created_at = created_at - interval '1 day' WHERE template = 'booking_links'");
    await ask(target);
    expect(await linkEmails()).toHaveLength(6);
  });

  it('sends one email when six requests arrive at once', async () => {
    const target = appWith();
    await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null });

    const answers = await Promise.all(Array.from({ length: 6 }, () => request(target.app).post(PATH).send({ email: CLIENT.email })));
    await target.settled();

    expect(answers.map((res) => res.status)).toEqual([202, 202, 202, 202, 202, 202]);
    expect(await linkEmails()).toHaveLength(1);
  });

  it('stops the work past the per-IP limit, answering 202 all the same', async () => {
    const target = appWith(new RequestLimiter(2, 60 * 60_000));

    const answers = [await ask(target, 'a@example.com'), await ask(target, 'b@example.com'), await ask(target, 'c@example.com')];

    expect(answers.map((res) => [res.status, res.text])).toEqual(Array(3).fill([202, answers[0]?.text]));
    expect(target.works).toHaveLength(2);
  });

  it.each([
    ['not an email', { email: 'not-an-email' }, 422],
    ['blank', { email: '   ' }, 422],
    ['missing', {}, 400],
    ['not a string', { email: 42 }, 400],
    ['carrying another field', { email: CLIENT.email, reference: 'BKY-2701-00001' }, 400],
  ])('refuses a body that is %s, sending nothing', async (_label, body, status) => {
    const target = appWith();
    await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null });

    const res = await request(target.app).post(PATH).send(body);
    await target.settled();

    expect(res.status).toBe(status);
    expect(target.works).toHaveLength(0);
    expect(await linkEmails()).toHaveLength(0);
  });

  it('puts no token in any response or log line', async () => {
    const target = appWith();
    await insertBooking(prisma, world, { status: 'confirmed', holdMinutes: null });

    const res = await ask(target);

    const tokens = (await linkEmails()).flatMap((email) => email.payload.bookings.map((b) => b.accessToken));
    expect(tokens).toHaveLength(1);
    for (const token of tokens) {
      expect(res.text).not.toContain(token);
      expect(JSON.stringify(sink.entries)).not.toContain(token);
    }
  });
});
