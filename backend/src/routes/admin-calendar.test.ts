import type { Server } from 'node:http';
import { PrismaPg } from '@prisma/adapter-pg';
import { type AdminUser, type Prisma, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { issueAdminToken } from '../auth/token.js';
import { findCalendar } from '../calendar/query.js';
import type { BookingStatus } from '../db/statuses.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';

/**
 * `GET /api/admin/calendar` over HTTP, against real PostgreSQL (plan.md Task 9;
 * spec §3.3 step 1, §7).
 *
 * The loading rules are proven in calendar/query.test.ts. What is proven here:
 * the route sits behind `requireAdmin`, validates its query with the one admin
 * rule (400 malformed, 422 out of range), reads the injected clock, and stays
 * bounded -- the same two queries whether the range holds 3 bookings or 500,
 * and under 500 ms at p95 for a month grid holding all 500.
 *
 * Kigali is UTC+2 with no DST. October 2026's month grid runs Monday
 * 2026-09-28 to Sunday 2026-11-01.
 */

let prisma: PrismaClient;
let raw: pg.Client;
/** Every SQL statement the Prisma client has issued since the last reset. */
let queries: string[] = [];
let admin: AdminUser;
let token: string;
let clock: Date;
let app: Express;
let catalogue: Catalogue;

const SECRET = 'admin-calendar-test-secret-at-least-32-characters';
const WEB_ORIGIN = 'https://admin.bookly.example';
const START = new Date('2026-10-01T06:00:00Z');
const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;

const CALENDAR = '/api/admin/calendar';
const OCTOBER_GRID = { from: '2026-09-28', to: '2026-11-01' };
const WEDNESDAY = '2026-10-07';

beforeAll(async () => {
  prisma = createCountingPrismaClient();
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
  // No login happens in this file, so no Argon2 is spent: the token only needs
  // the stored hash to fingerprint it.
  admin = await prisma.adminUser.create({
    data: { email: 'photographer@bookly.example', passwordHash: '$argon2id$placeholder-never-verified' },
  });
  token = (await issueAdminToken(SECRET, admin, START)).token;
  app = createApp({
    corsOrigin: WEB_ORIGIN,
    admin: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock },
  });
  catalogue = await insertCatalogue();
  queries = [];
});

// --- Fixtures ---------------------------------------------------------------

/**
 * The client db/client.ts builds -- same adapter, same forced UTC session --
 * with query events on, so a test can count what one request issues.
 */
function createCountingPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: testDatabaseUrl(), options: '-c timezone=UTC' }),
    log: [{ emit: 'event', level: 'query' }],
  });
  client.$on('query', (event: Prisma.QueryEvent) => {
    queries.push(event.query);
  });
  return client;
}

type Catalogue = { serviceId: string; packageId: string; clientId: string };

async function insertCatalogue(): Promise<Catalogue> {
  const service = await prisma.service.create({ data: { slug: 'portrait', nameEn: 'Portrait' } });
  const pkg = await prisma.package.create({
    data: { serviceId: service.id, nameEn: 'Standard', priceRwf: 40_000, photoCount: 20, durationMinutes: 60 },
  });
  const client = await prisma.client.create({
    data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' },
  });
  return { serviceId: service.id, packageId: pkg.id, clientId: client.id };
}

/** A Kigali wall-clock time on `date`, as the UTC instant. */
function at(date: string, wallTime: string): Date {
  return new Date(`${date}T${wallTime}:00+02:00`);
}

type BookingRow = {
  reference: string;
  startsAt: Date;
  status?: BookingStatus;
  holdExpiresAt?: Date | null;
  contactName?: string;
};

/** A 60-minute booking with a 30-minute buffer, every snapshot column filled. */
function bookingData({ reference, startsAt, status = 'confirmed', holdExpiresAt = null, contactName = 'Aline Uwase' }: BookingRow) {
  const endsAt = new Date(startsAt.getTime() + 60 * MINUTE_MS);
  return {
    reference,
    clientId: catalogue.clientId,
    contactName,
    contactEmail: 'aline@example.com',
    contactPhone: '+250788000000',
    serviceId: catalogue.serviceId,
    packageId: catalogue.packageId,
    serviceNameSnapshot: 'Portrait',
    packageNameSnapshot: 'Standard',
    packagePriceRwf: 40_000,
    packageDurationMinutes: 60,
    packagePhotoCount: 20,
    locationText: 'Kigali Heights',
    consentAt: START,
    bookingFeeRate: '0.400',
    bookingFeeRwf: 16_000,
    status,
    startsAt,
    endsAt,
    bufferEndsAt: new Date(endsAt.getTime() + 30 * MINUTE_MS),
    holdExpiresAt,
  };
}

/** `bearer: null` sends no Authorization header at all. */
function getCalendar(query: string, bearer: string | null = token, target: Express | Server = app): request.Test {
  const req = request(target).get(`${CALENDAR}${query}`);
  return bearer === null ? req : req.set('Authorization', `Bearer ${bearer}`);
}

function range(from: string, to: string): string {
  return `?from=${from}&to=${to}`;
}

type CalendarJson = {
  bookings: { reference: string; status: string; conflictsWithBlock: boolean }[];
  blocks: { id: string }[];
};

function expectUnauthenticated(res: Response): void {
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'unauthenticated' });
  expect(String(res.headers['www-authenticate'])).toMatch(/^Bearer realm="bookly-admin"/);
}

// --- Auth -----------------------------------------------------------------------

describe('GET /api/admin/calendar without a valid token', () => {
  it('answers 401 with no token, running no calendar query', async () => {
    const res = await getCalendar(range(WEDNESDAY, WEDNESDAY), null);

    expectUnauthenticated(res);
    expect(queries).toEqual([]);
  });

  it('answers 401 with a garbage token', async () => {
    const res = await getCalendar(range(WEDNESDAY, WEDNESDAY), 'not.a.token');

    expectUnauthenticated(res);
    expect(String(res.headers['www-authenticate'])).toContain('error="invalid_token"');
  });

  it('answers 401 before validating, so a bad query reveals nothing to a stranger', async () => {
    expectUnauthenticated(await getCalendar('?from=nonsense', null));
  });
});

// --- Response ----------------------------------------------------------------------

describe('GET /api/admin/calendar', () => {
  it('answers 200 with the range’s bookings, live holds and blocks, and nothing else', async () => {
    const block = await prisma.availabilityBlock.create({
      data: { startsAt: at(WEDNESDAY, '09:30'), endsAt: at(WEDNESDAY, '11:00'), reason: 'Clinic' },
    });
    const confirmed = await prisma.booking.create({
      data: bookingData({ reference: 'BKY-2610-00001', startsAt: at(WEDNESDAY, '09:00'), contactName: 'Grace Mukamana' }),
    });
    const liveHold = await prisma.booking.create({
      data: bookingData({
        reference: 'BKY-2610-00005',
        startsAt: at(WEDNESDAY, '16:00'),
        status: 'pending_payment',
        holdExpiresAt: new Date(START.getTime() + MINUTE_MS),
      }),
    });
    await prisma.booking.createMany({
      data: [
        bookingData({
          reference: 'BKY-2610-00002',
          startsAt: at(WEDNESDAY, '14:00'),
          status: 'pending_payment',
          holdExpiresAt: new Date(START.getTime() - MINUTE_MS),
        }),
        bookingData({ reference: 'BKY-2610-00003', startsAt: at(WEDNESDAY, '12:00'), status: 'cancelled_by_admin' }),
        bookingData({ reference: 'BKY-2610-00004', startsAt: at('2026-10-08', '09:00') }),
      ],
    });

    const res = await getCalendar(range(WEDNESDAY, WEDNESDAY));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      bookings: [
        {
          id: confirmed.id,
          reference: 'BKY-2610-00001',
          status: 'confirmed',
          startsAt: '2026-10-07T07:00:00.000Z',
          endsAt: '2026-10-07T08:00:00.000Z',
          contactName: 'Grace Mukamana',
          serviceName: 'Portrait',
          packageName: 'Standard',
          conflictsWithBlock: true,
        },
        {
          id: liveHold.id,
          reference: 'BKY-2610-00005',
          status: 'pending_payment',
          startsAt: '2026-10-07T14:00:00.000Z',
          endsAt: '2026-10-07T15:00:00.000Z',
          contactName: 'Aline Uwase',
          serviceName: 'Portrait',
          packageName: 'Standard',
          conflictsWithBlock: false,
        },
      ],
      blocks: [
        {
          id: block.id,
          startsAt: '2026-10-07T07:30:00.000Z',
          endsAt: '2026-10-07T09:00:00.000Z',
          isAllDay: false,
          reason: 'Clinic',
        },
      ],
    });
  });

  it('decides whether a hold is live with the injected clock', async () => {
    await prisma.booking.create({
      data: bookingData({
        reference: 'BKY-2610-00001',
        startsAt: at(WEDNESDAY, '09:00'),
        status: 'pending_payment',
        holdExpiresAt: new Date(START.getTime() + 10 * MINUTE_MS),
      }),
    });
    const references = async () =>
      ((await getCalendar(range(WEDNESDAY, WEDNESDAY))).body as CalendarJson).bookings.map((b) => b.reference);

    expect(await references()).toEqual(['BKY-2610-00001']);

    clock = new Date(START.getTime() + 10 * MINUTE_MS);

    expect(await references()).toEqual([]);
  });
});

// --- Validation ------------------------------------------------------------------------

describe('GET /api/admin/calendar query validation', () => {
  it.each<[string, string]>([
    ['no query at all', ''],
    ['a missing from', '?to=2026-10-31'],
    ['a missing to', '?from=2026-10-01'],
    ['an empty from', '?from=&to=2026-10-31'],
    ['a one-digit day', '?from=2026-10-1&to=2026-10-31'],
    ['a non-ISO date', '?from=01/10/2026&to=2026-10-31'],
    ['a datetime where a date belongs', '?from=2026-10-01T00:00:00Z&to=2026-10-31'],
    ['an impossible date', '?from=2026-02-30&to=2026-03-01'],
    ['a February 29th outside a leap year', '?from=2026-02-29&to=2026-03-01'],
    ['an extra parameter', '?from=2026-10-01&to=2026-10-31&view=month'],
    ['a repeated from', '?from=2026-10-01&from=2026-10-02&to=2026-10-31'],
    ['a bracketed key', '?from[gte]=2026-10-01&to=2026-10-31'],
  ])('refuses %s with 400 invalid_request', async (_label, query) => {
    const res = await getCalendar(query);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
  });

  it.each<[string, string, string[]]>([
    ['to before from', range('2026-10-31', '2026-10-01'), ['to']],
    ['to one day before from', range('2026-10-08', WEDNESDAY), ['to']],
    ['a 63-day span', range('2026-10-01', '2026-12-02'), ['to']],
    ['a span of a year', range('2026-01-01', '2026-12-31'), ['to']],
    ['years below 100', range('0050-01-01', '0050-01-31'), ['from', 'to']],
  ])('refuses %s with 422 naming the fields', async (_label, query, fields) => {
    const res = await getCalendar(query);

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'validation_failed', fields });
  });

  it.each<[string, string]>([
    ['a single day', range(WEDNESDAY, WEDNESDAY)],
    ['a Monday–Sunday week', range('2026-10-05', '2026-10-11')],
    ['a six-week month grid', range('2026-06-29', '2026-08-09')],
    ['exactly 62 days, the cap', range('2026-10-01', '2026-12-01')],
    ['62 days across a year end', range('2026-12-01', '2027-01-31')],
    ['a leap day', range('2028-02-29', '2028-02-29')],
  ])('accepts %s with 200', async (_label, query) => {
    const res = await getCalendar(query);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookings: [], blocks: [] });
  });
});

// --- Bounded cost (spec §7) ----------------------------------------------------------------

describe('one month against a 500-booking dataset (plan.md Task 9, spec §7)', () => {
  const SLOTS_PER_DAY = 15;
  /** Most bookings occupy time; a few do not and must be filtered in SQL. */
  const STATUS_CYCLE: BookingStatus[] = [
    'confirmed', 'confirmed', 'confirmed', 'pending_payment', 'confirmed',
    'completed', 'confirmed', 'no_show', 'expired', 'cancelled_by_client',
  ];

  /**
   * Booking `index` of a dense October grid: 15 a day, 60 minutes each on a
   * 90-minute pitch from Kigali midnight, so each buffer ends as the next
   * session starts and the exclusion constraint is never tripped.
   */
  function gridBooking(index: number) {
    const day = Math.floor(index / SLOTS_PER_DAY);
    const slot = index % SLOTS_PER_DAY;
    const startsAt = new Date(at(OCTOBER_GRID.from, '00:00').getTime() + day * DAY_MS + slot * 90 * MINUTE_MS);
    const status = STATUS_CYCLE[index % STATUS_CYCLE.length] ?? 'confirmed';
    return bookingData({
      reference: `BKY-PERF-${String(index).padStart(5, '0')}`,
      startsAt,
      status,
      holdExpiresAt: status === 'pending_payment' ? new Date(START.getTime() + 30 * MINUTE_MS) : null,
    });
  }

  async function seedGrid(fromIndex: number, toIndex: number): Promise<void> {
    const data = [];
    for (let index = fromIndex; index < toIndex; index++) data.push(gridBooking(index));
    await prisma.booking.createMany({ data });
  }

  /** A handful of blocks across the month, some over bookings. */
  async function seedBlocks(): Promise<void> {
    await prisma.availabilityBlock.createMany({
      data: ['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30'].map((date) => ({
        startsAt: at(date, '06:00'),
        endsAt: at(date, '10:00'),
        reason: 'Weekly studio clean',
      })),
    });
  }

  function expectedOccupying(count: number): number {
    return Array.from({ length: count }, (_, index) => STATUS_CYCLE[index % STATUS_CYCLE.length]).filter(
      (status) => status !== 'expired' && status !== 'cancelled_by_client',
    ).length;
  }

  /** The SQL statements one run issues, counted from Prisma's query events. */
  async function queriesDuring(run: () => Promise<unknown>): Promise<string[]> {
    queries = [];
    await run();
    // Let any event emitted after the result resolved land before counting.
    await new Promise((resolve) => setImmediate(resolve));
    return [...queries];
  }

  const TABLE_PATTERN = /FROM "public"\."(booking|availability_block)"/;

  it('issues the same two queries for 3 bookings as for 500', async () => {
    await seedBlocks();
    await seedGrid(0, 3);

    const smallDirect = await queriesDuring(() => findCalendar(prisma, { ...OCTOBER_GRID, now: clock }));
    let smallBody: CalendarJson | undefined;
    const smallHttp = await queriesDuring(async () => {
      smallBody = (await getCalendar(range(OCTOBER_GRID.from, OCTOBER_GRID.to)).expect(200)).body as CalendarJson;
    });

    await seedGrid(3, 500);
    await expect(prisma.booking.count()).resolves.toBe(500);

    const largeDirect = await queriesDuring(() => findCalendar(prisma, { ...OCTOBER_GRID, now: clock }));
    let largeBody: CalendarJson | undefined;
    const largeHttp = await queriesDuring(async () => {
      largeBody = (await getCalendar(range(OCTOBER_GRID.from, OCTOBER_GRID.to)).expect(200)).body as CalendarJson;
    });

    // The data really grew, so an unchanged count means the cost does not.
    expect(smallBody?.bookings).toHaveLength(expectedOccupying(3));
    expect(largeBody?.bookings).toHaveLength(expectedOccupying(500));
    expect(largeBody?.blocks).toHaveLength(5);

    expect(smallDirect).toHaveLength(2);
    expect(largeDirect).toHaveLength(2);
    expect(largeDirect.every((sql) => TABLE_PATTERN.test(sql))).toBe(true);

    // Over HTTP the only other statement is requireAdmin loading the admin.
    expect(largeHttp).toHaveLength(smallHttp.length);
    expect(largeHttp.filter((sql) => TABLE_PATTERN.test(sql))).toHaveLength(2);
  });

  it('answers the month grid in under 500 ms at p95', { timeout: 60_000 }, async () => {
    await seedBlocks();
    await seedGrid(0, 500);

    const server = app.listen(0);
    try {
      const url = range(OCTOBER_GRID.from, OCTOBER_GRID.to);
      for (let i = 0; i < 5; i++) await getCalendar(url, token, server).expect(200);

      const REQUESTS = 40;
      const durations: number[] = [];
      for (let i = 0; i < REQUESTS; i++) {
        const started = performance.now();
        const res = await getCalendar(url, token, server);
        durations.push(performance.now() - started);
        expect(res.status).toBe(200);
        expect((res.body as CalendarJson).bookings).toHaveLength(expectedOccupying(500));
      }

      durations.sort((a, b) => a - b);
      const p95 = durations[Math.ceil(REQUESTS * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
      expect(p95, `p95 of ${REQUESTS} requests, in ms`).toBeLessThan(500);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
