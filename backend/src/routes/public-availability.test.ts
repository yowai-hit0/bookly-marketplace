import type { Server } from 'node:http';
import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { findAvailability } from '../availability/query.js';
import type { BookingStatus } from '../db/statuses.js';
import { updateSettings } from '../settings/index.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';

/**
 * `GET /api/availability` over HTTP, against real PostgreSQL (plan.md Task 12;
 * spec §3.1 steps 4-5, §6.1, §6.5-6.7, §7; data-model_v2.md §7.1, §8, §9.2).
 *
 * The engine's rules are proven one at a time in availability/engine.test.ts
 * and the loading in availability/query.test.ts. What is proven here: the route
 * answers a whole Kigali month for one bookable package, exactly as
 * `findAvailability()` computes it with that package's duration and the injected
 * clock; a fixture month is pinned by a snapshot AND by a hand-derived
 * expectation, so the snapshot is never the only witness; the raw JSON carries
 * dates and instants and nothing else; validation follows the one rule (400
 * malformed, 422 well-formed but refused); every response says `no-store`; no
 * cache sits between the database and the answer; and a month answers in under
 * 500 ms at p95 against a few hundred bookings.
 *
 * Kigali is UTC+2 with no DST. October 2026 starts on a Thursday. The clock is
 * Tuesday 6 October, 12:10 Kigali, so lead time bites on the 6th itself.
 */

let prisma: PrismaClient;
let raw: pg.Client;
/** Every SQL statement the Prisma client has issued since the last reset. */
let queries: string[] = [];
let clock: Date;
let app: Express;
let catalogue: Catalogue;

/** 12:10 Kigali on Tuesday 6 October 2026. Earliest bookable start: 14:10, so 14:30 on the grid. */
const NOW = new Date('2026-10-06T10:10:00Z');
const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;
const KIGALI_OFFSET_MS = 120 * MINUTE_MS;

const AVAILABILITY = '/api/availability';
const OCTOBER = '2026-10';
const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  prisma = createCountingPrismaClient();
  raw = connect();
  await raw.connect();
});

afterAll(async () => {
  // Leave no edited setting behind for a suite that seeds instead of truncating.
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  clock = NOW;
  // Defaults 0.400 / 120 / 30 / 30 / 90; findAvailability throws without the row.
  await prisma.setting.create({ data: { id: 1 } });
  // The seeded weekly rule: Mon–Fri 09:00–17:00.
  await prisma.workingHours.createMany({
    data: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinute: 540, closesMinute: 1020 })),
  });
  catalogue = await insertCatalogue();
  app = createApp({ publicApi: { prisma, now: () => clock } });
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

type Catalogue = {
  serviceId: string;
  clientId: string;
  /** 60 minutes. */
  short: string;
  /** 120 minutes. */
  standard: string;
  /** 180 minutes. */
  long: string;
};

async function insertCatalogue(): Promise<Catalogue> {
  const service = await prisma.service.create({ data: { slug: 'portrait', nameEn: 'Portrait' } });
  const insertPackage = async (nameEn: string, durationMinutes: number) =>
    (
      await prisma.package.create({
        data: { serviceId: service.id, nameEn, priceRwf: 40_000, photoCount: 20, durationMinutes },
      })
    ).id;
  const client = await prisma.client.create({
    data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' },
  });
  return {
    serviceId: service.id,
    clientId: client.id,
    short: await insertPackage('Short', 60),
    standard: await insertPackage('Standard', 120),
    long: await insertPackage('Long', 180),
  };
}

/** A Kigali wall-clock time on `date`, as the UTC instant. */
function at(date: string, wallTime: string): Date {
  return new Date(`${date}T${wallTime}:00+02:00`);
}

function kigaliTime(iso: string): string {
  return new Date(Date.parse(iso) + KIGALI_OFFSET_MS).toISOString().slice(11, 16);
}

type Reservation = {
  reference: string;
  startsAt: Date;
  minutes?: number;
  status?: BookingStatus;
  holdExpiresAt?: Date | null;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  locationText?: string;
  specialRequests?: string | null;
};

/** A booking with a 30-minute buffer, every snapshot column filled. */
function bookingData({
  reference,
  startsAt,
  minutes = 60,
  status = 'confirmed',
  holdExpiresAt = null,
  contactName = 'Aline Uwase',
  contactEmail = 'aline@example.com',
  contactPhone = '+250788000000',
  locationText = 'Kigali Heights',
  specialRequests = null,
}: Reservation) {
  const endsAt = new Date(startsAt.getTime() + minutes * MINUTE_MS);
  return {
    reference,
    clientId: catalogue.clientId,
    contactName,
    contactEmail,
    contactPhone,
    serviceId: catalogue.serviceId,
    packageId: catalogue.short,
    serviceNameSnapshot: 'Portrait',
    packageNameSnapshot: 'Short',
    packagePriceRwf: 40_000,
    packageDurationMinutes: minutes,
    packagePhotoCount: 20,
    locationText,
    specialRequests,
    consentAt: NOW,
    bookingFeeRate: '0.400',
    bookingFeeRwf: 16_000,
    status,
    startsAt,
    endsAt,
    bufferEndsAt: new Date(endsAt.getTime() + 30 * MINUTE_MS),
    holdExpiresAt,
  };
}

function getAvailability(query: string, target: Express | Server = app): request.Test {
  return request(target).get(`${AVAILABILITY}${query}`);
}

function monthOf(packageId: string, month = OCTOBER): string {
  return `?packageId=${packageId}&month=${month}`;
}

type Day = { date: string; starts: string[] };
type AvailabilityJson = { days: Day[] };

function bodyOf(res: Response): AvailabilityJson {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.headers['content-type']).toMatch(/^application\/json/);
  return res.body as AvailabilityJson;
}

/** GET a month and return its days. */
async function daysOf(packageId: string, month = OCTOBER): Promise<Day[]> {
  return bodyOf(await getAvailability(monthOf(packageId, month))).days;
}

/** Offered Kigali start times per date. */
function kigaliTimesByDate(days: Day[]): Record<string, string[]> {
  return Object.fromEntries(days.map((day) => [day.date, day.starts.map(kigaliTime)]));
}

/** Offered Kigali start times on one date of a fetched month. */
async function startTimes(date: string, packageId = catalogue.short): Promise<string[]> {
  return kigaliTimesByDate(await daysOf(packageId, date.slice(0, 7)))[date] ?? [];
}

function expectInvalid(res: Response): void {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body).toStrictEqual({ error: 'invalid_request' });
}

function expectRefused(res: Response, fields: string[]): void {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body).toStrictEqual({ error: 'validation_failed', fields });
}

/** Every 30-minute Kigali start from `first` to `last`, inclusive. */
function grid(first: string, last: string): string[] {
  const toMinute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const times: string[] = [];
  for (let minute = toMinute(first); minute <= toMinute(last); minute += 30) {
    times.push(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`);
  }
  return times;
}

/** Every date of a month, `YYYY-MM-01` to its last day. */
function datesOf(month: string, length: number): string[] {
  return Array.from({ length }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}

// --- The fixture month -------------------------------------------------------------

/**
 * October 2026 as the photographer might have it, on top of the Mon–Fri
 * 09:00–17:00 weekly rule:
 *
 * - Wed 14: closed by a dated override.       - Sat 17: opened 10:00–14:00 by a dated override.
 * - Fri 16: a full-day block.                  - Tue 20: a 14:00–16:00 partial block.
 * - Thu 8:  a confirmed 09:00–10:00 booking, buffered to 10:30.
 * - Mon 12: a live pending_payment hold, 11:00–12:00 buffered to 12:30.
 * - Tue 13: the same hold, lapsed a minute ago -- no sweeper has run.
 * - Wed 21: a booking cancelled by the client, 09:00–10:00.
 *
 * Every private column is filled with a marker the raw JSON must not carry.
 */
async function seedOctober() {
  await prisma.workingHours.createMany({
    data: [
      { effectiveDate: new Date('2026-10-14T00:00:00Z'), isOpen: false, note: 'SECRET-HOURS-NOTE' },
      { effectiveDate: new Date('2026-10-17T00:00:00Z'), opensMinute: 600, closesMinute: 840, note: 'SECRET-HOURS-NOTE' },
    ],
  });
  const fullDayBlock = await prisma.availabilityBlock.create({
    data: { startsAt: at('2026-10-16', '00:00'), endsAt: at('2026-10-17', '00:00'), isAllDay: true, reason: 'SECRET-BLOCK-REASON' },
  });
  const partialBlock = await prisma.availabilityBlock.create({
    data: { startsAt: at('2026-10-20', '14:00'), endsAt: at('2026-10-20', '16:00'), reason: 'SECRET-DENTIST-REASON' },
  });
  const secrets = {
    contactName: 'Grace SECRET-NAME Mukamana',
    contactEmail: 'secret-contact@example.com',
    contactPhone: '+250788123456',
    locationText: 'SECRET-LOCATION',
    specialRequests: 'SECRET-REQUEST',
  };
  const bookings = [
    await prisma.booking.create({
      data: bookingData({ reference: 'BKY-2610-7QX3Z', startsAt: at('2026-10-08', '09:00'), ...secrets }),
    }),
    await prisma.booking.create({
      data: bookingData({
        reference: 'BKY-2610-HQ4MV',
        startsAt: at('2026-10-12', '11:00'),
        status: 'pending_payment',
        holdExpiresAt: new Date(NOW.getTime() + 10 * MINUTE_MS),
        ...secrets,
      }),
    }),
    await prisma.booking.create({
      data: bookingData({
        reference: 'BKY-2610-JK9RT',
        startsAt: at('2026-10-13', '11:00'),
        status: 'pending_payment',
        holdExpiresAt: new Date(NOW.getTime() - MINUTE_MS),
        ...secrets,
      }),
    }),
    await prisma.booking.create({
      data: bookingData({
        reference: 'BKY-2610-WX2PN',
        startsAt: at('2026-10-21', '09:00'),
        status: 'cancelled_by_client',
        ...secrets,
      }),
    }),
  ];
  return { blocks: [fullDayBlock, partialBlock], bookings, secrets };
}

/** Every start a 120-minute package fits into 09:00–17:00. */
const FULL_DAY_120 = grid('09:00', '15:00');

/**
 * October 2026 for the 120-minute package, derived by hand from the fixture and
 * the five rules -- not read off the response.
 */
const OCTOBER_120: Record<string, string[]> = {
  // Before now + 120 min: the 1st to the 5th are gone, and on the 6th (now
  // 12:10, so 14:10) only 14:30 and 15:00 remain.
  '2026-10-01': [],
  '2026-10-02': [],
  '2026-10-03': [],
  '2026-10-04': [],
  '2026-10-05': [],
  '2026-10-06': ['14:30', '15:00'],
  '2026-10-07': FULL_DAY_120,
  // Confirmed 09:00–10:00, buffered to 10:30: 10:30 is the first free start.
  '2026-10-08': grid('10:30', '15:00'),
  '2026-10-09': FULL_DAY_120,
  '2026-10-10': [],
  '2026-10-11': [],
  // Live hold 11:00–12:30 reserved: a candidate reserves its session plus a
  // 30-minute buffer, 150 minutes, so every start from 09:00 to 12:00 collides.
  '2026-10-12': grid('12:30', '15:00'),
  // The lapsed hold occupies nothing.
  '2026-10-13': FULL_DAY_120,
  // Closed by override, though Wednesday is open weekly.
  '2026-10-14': [],
  '2026-10-15': FULL_DAY_120,
  // Full-day block.
  '2026-10-16': [],
  // A Saturday opened 10:00–14:00: the last 120-minute start ends at 14:00.
  '2026-10-17': grid('10:00', '12:00'),
  '2026-10-18': [],
  '2026-10-19': FULL_DAY_120,
  // A 14:00–16:00 block: any session running past 14:00 is out, so 12:00 is the last.
  '2026-10-20': grid('09:00', '12:00'),
  // The cancelled booking frees its slot.
  '2026-10-21': FULL_DAY_120,
  '2026-10-22': FULL_DAY_120,
  '2026-10-23': FULL_DAY_120,
  '2026-10-24': [],
  '2026-10-25': [],
  '2026-10-26': FULL_DAY_120,
  '2026-10-27': FULL_DAY_120,
  '2026-10-28': FULL_DAY_120,
  '2026-10-29': FULL_DAY_120,
  '2026-10-30': FULL_DAY_120,
  '2026-10-31': [],
};

// --- The response --------------------------------------------------------------------

describe('GET /api/availability for a fixture month', () => {
  it('pins October 2026 for a 120-minute package, and every pinned day agrees with the hand-derived month', async () => {
    await seedOctober();

    const res = await getAvailability(monthOf(catalogue.standard));
    const body = bodyOf(res);

    // Hand-derived first, so the snapshot below pins a response already checked.
    expect(kigaliTimesByDate(body.days)).toStrictEqual(OCTOBER_120);
    expect(body).toMatchSnapshot();
  });

  it('holds the load-bearing days to the rules they prove', async () => {
    await seedOctober();

    const days = kigaliTimesByDate(await daysOf(catalogue.standard));

    // Occupancy and buffer: 09:00, 09:30 and 10:00 are gone, 10:30 is first.
    expect(days['2026-10-08']?.[0]).toBe('10:30');
    expect(days['2026-10-08']).not.toContain('10:00');
    // A dated override opens a Saturday; the one after stays closed.
    expect(days['2026-10-17']).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00']);
    expect(days['2026-10-24']).toEqual([]);
    // A dated override closes one Wednesday; the next is untouched.
    expect(days['2026-10-14']).toEqual([]);
    expect(days['2026-10-21']).toEqual(FULL_DAY_120);
    // Blocks: the whole day, then only what a session would overlap.
    expect(days['2026-10-16']).toEqual([]);
    expect(days['2026-10-20']?.at(-1)).toBe('12:00');
    // Fit: a 120-minute session ends by 17:00, so nothing after 15:00 anywhere.
    for (const times of Object.values(days)) expect(times.every((time) => time <= '15:00')).toBe(true);
    // The live hold holds; the lapsed one does not.
    expect(days['2026-10-12']).not.toContain('11:00');
    expect(days['2026-10-13']).toContain('11:00');
  });

  it('offers no start sooner than now plus the minimum lead time, on the grid, inside the window', async () => {
    await seedOctober();

    const days = await daysOf(catalogue.standard);
    const starts = days.flatMap((day) => day.starts);

    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) {
      const instant = new Date(start);
      expect(instant.getTime(), start).toBeGreaterThanOrEqual(NOW.getTime() + 120 * MINUTE_MS);
      // ISO UTC, on a 30-minute grid measured from Kigali midnight.
      expect(start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:(00|30):00\.000Z$/);
      const kigaliWeekday = new Date(instant.getTime() + KIGALI_OFFSET_MS).getUTCDay();
      const date = new Date(instant.getTime() + KIGALI_OFFSET_MS).toISOString().slice(0, 10);
      // Mon–Fri, or the one Saturday an override opened.
      expect((kigaliWeekday >= 1 && kigaliWeekday <= 5) || date === '2026-10-17', start).toBe(true);
    }
    // The earliest start of all: today, 14:30 Kigali.
    expect(starts[0]).toBe('2026-10-06T12:30:00.000Z');
  });

  it('returns ISO-8601 UTC instants two hours behind Kigali wall time, ascending within each day', async () => {
    const days = await daysOf(catalogue.short);
    const wednesday = days.find((day) => day.date === '2026-10-07');

    expect(wednesday?.starts[0]).toBe('2026-10-07T07:00:00.000Z');
    expect(wednesday?.starts.at(-1)).toBe('2026-10-07T14:00:00.000Z');
    for (const day of days) expect(day.starts).toEqual([...day.starts].sort());
  });

  it('answers exactly what findAvailability computes for the package’s duration and the injected clock', async () => {
    await seedOctober();

    for (const [packageId, packageDurationMinutes] of [
      [catalogue.short, 60],
      [catalogue.standard, 120],
      [catalogue.long, 180],
    ] as const) {
      const direct = await findAvailability(prisma, {
        from: '2026-10-01',
        to: '2026-10-31',
        packageDurationMinutes,
        now: NOW,
      });

      expect(bodyOf(await getAvailability(monthOf(packageId))), `${packageDurationMinutes} minutes`).toStrictEqual({
        days: direct,
      });
    }
  });

  it('measures lead time against the injected clock, read afresh on every request', async () => {
    expect((await startTimes('2026-10-06'))[0]).toBe('14:30');

    clock = at('2026-10-06', '13:00');

    expect((await startTimes('2026-10-06'))[0]).toBe('15:00');
  });
});

describe('GET /api/availability for packages of different lengths', () => {
  it('returns fewer starts on the same day for a longer package', async () => {
    const short = await startTimes('2026-10-07', catalogue.short);
    const long = await startTimes('2026-10-07', catalogue.long);

    // 60 minutes fits 09:00–16:00; 180 minutes fits 09:00–14:00.
    expect(short).toEqual(grid('09:00', '16:00'));
    expect(long).toEqual(grid('09:00', '14:00'));
    expect(long.length).toBeLessThan(short.length);
    expect(short).toEqual(expect.arrayContaining(long));
  });

  it('returns fewer starts beside a booking too, both starting at the buffer end', async () => {
    await prisma.booking.create({ data: bookingData({ reference: 'BKY-2610-00001', startsAt: at('2026-10-08', '09:00') }) });

    expect(await startTimes('2026-10-08', catalogue.short)).toEqual(grid('10:30', '16:00'));
    expect(await startTimes('2026-10-08', catalogue.long)).toEqual(grid('10:30', '14:00'));
  });

  it('offers nothing all month for a package longer than any open window (spec §6.8)', async () => {
    const tooLong = await prisma.package.create({
      data: { serviceId: catalogue.serviceId, nameEn: 'Marathon', priceRwf: 1, photoCount: 1, durationMinutes: 600 },
    });

    const days = await daysOf(tooLong.id);

    expect(days).toHaveLength(31);
    expect(days.every((day) => day.starts.length === 0)).toBe(true);
  });
});

describe('GET /api/availability month lengths', () => {
  it.each<[string, string, number]>([
    ['a non-leap February', '2027-02', 28],
    ['a leap February', '2028-02', 29],
    ['a February in a century year that is not a leap year', '2100-02', 28],
    ['a 30-day month', '2026-11', 30],
    ['a 31-day month ending a year', '2026-12', 31],
    ['a 31-day month starting a year', '2027-01', 31],
  ])('answers every Kigali date of %s (%s), ascending and contiguous', async (_label, month, length) => {
    const days = await daysOf(catalogue.short, month);

    expect(days.map((day) => day.date)).toEqual(datesOf(month, length));
  });

  it('answers a month entirely in the past with every date and no starts', async () => {
    const days = await daysOf(catalogue.short, '2026-09');

    expect(days.map((day) => day.date)).toEqual(datesOf('2026-09', 30));
    expect(days.every((day) => day.starts.length === 0)).toBe(true);
  });
});

// --- What the public must never see (spec P-03) ------------------------------------------

describe('GET /api/availability privacy', () => {
  it('carries no block reason, client detail, reference or id anywhere in the raw JSON', async () => {
    const { blocks, bookings, secrets } = await seedOctober();

    const res = await getAvailability(monthOf(catalogue.standard));
    const body = bodyOf(res);

    // Not vacuous: the private rows were loaded and shaped the answer.
    expect(kigaliTimesByDate(body.days)['2026-10-16']).toEqual([]);
    expect(kigaliTimesByDate(body.days)['2026-10-08']?.[0]).toBe('10:30');

    const forbidden = [
      'SECRET',
      ...Object.values(secrets),
      ...bookings.flatMap((booking) => [booking.id, booking.reference]),
      ...blocks.map((block) => block.id),
      catalogue.clientId,
      catalogue.serviceId,
      catalogue.standard,
      'Aline',
      'Portrait',
      'BKY-',
      'reason',
      'contact',
      'reference',
      'status',
      'confirmed',
      'pending_payment',
      'cancelled',
      'buffer',
      'hold',
      'isAllDay',
      'endsAt',
    ];
    for (const secret of forbidden) expect(res.text, secret).not.toContain(secret);
  });

  it('shapes every day as exactly { date, starts } under a single days key', async () => {
    await seedOctober();

    const body = bodyOf(await getAvailability(monthOf(catalogue.standard)));

    expect(Object.keys(body)).toEqual(['days']);
    expect(body.days).toHaveLength(31);
    for (const day of body.days) {
      expect(Object.keys(day).sort()).toEqual(['date', 'starts']);
      expect(day.date).toMatch(/^2026-10-\d{2}$/);
      expect(day.starts.every((start) => typeof start === 'string')).toBe(true);
    }
  });
});

// --- Access -----------------------------------------------------------------------------

describe('GET /api/availability access', () => {
  it('answers an anonymous request, and a bogus credential changes nothing', async () => {
    const anonymous = await getAvailability(monthOf(catalogue.short));
    const withGarbage = await getAvailability(monthOf(catalogue.short)).set('Authorization', 'Bearer not.a.token');

    expect(anonymous.status).toBe(200);
    expect(withGarbage.status).toBe(200);
    expect(withGarbage.body).toStrictEqual(anonymous.body);
  });

  it('stays anonymous when the admin API is mounted beside it', async () => {
    const both = createApp({
      publicApi: { prisma, now: () => clock },
      admin: { prisma, sessionSecret: 'public-availability-test-secret-at-least-32-characters', webOrigin: 'https://admin.bookly.example', now: () => clock },
    });

    const res = await getAvailability(monthOf(catalogue.short), both);

    expect(res.status).toBe(200);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('is not mounted without publicApi: the path 404s and touches no database', async () => {
    const res = await request(createApp()).get(`${AVAILABILITY}${monthOf(catalogue.short)}`);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'not_found' });
    expect(queries).toEqual([]);
  });

  it('answers GET only', async () => {
    const res = await request(app).post(AVAILABILITY).send({ packageId: catalogue.short, month: OCTOBER });

    expect(res.status).toBe(404);
  });

  it('defaults to the real clock when none is injected', async () => {
    const realClock = createApp({ publicApi: { prisma } });

    const past = bodyOf(await getAvailability(monthOf(catalogue.short, '2020-01'), realClock)).days;
    const future = bodyOf(await getAvailability(monthOf(catalogue.short, '2090-01'), realClock)).days;

    expect(past.every((day) => day.starts.length === 0)).toBe(true);
    // Monday 2 January 2090 is a weekday decades from any real now.
    expect(future.find((day) => day.date === '2090-01-02')?.starts).toHaveLength(15);
  });
});

// --- Validation ---------------------------------------------------------------------------

describe('GET /api/availability query validation', () => {
  it.each<[string, (id: string) => string]>([
    ['no query at all', () => ''],
    ['a missing month', (id) => `?packageId=${id}`],
    ['a missing packageId', () => `?month=${OCTOBER}`],
    ['an empty month', (id) => `?packageId=${id}&month=`],
    ['an empty packageId', () => `?packageId=&month=${OCTOBER}`],
    ['a thirteenth month', (id) => `?packageId=${id}&month=2026-13`],
    ['month zero', (id) => `?packageId=${id}&month=2026-00`],
    ['an unpadded month', (id) => `?packageId=${id}&month=2026-1`],
    ['a month without its hyphen', (id) => `?packageId=${id}&month=202610`],
    ['a full date where a month belongs', (id) => `?packageId=${id}&month=2026-10-01`],
    ['a two-digit year', (id) => `?packageId=${id}&month=26-10`],
    ['a five-digit year', (id) => `?packageId=${id}&month=20260-10`],
    ['a month name', (id) => `?packageId=${id}&month=October`],
    ['a month with trailing space', (id) => `?packageId=${id}&month=2026-10%20`],
    ['a non-uuid packageId', () => `?packageId=not-a-uuid&month=${OCTOBER}`],
    ['a packageId one character short', (id) => `?packageId=${id.slice(0, -1)}&month=${OCTOBER}`],
    ['a braced packageId', (id) => `?packageId={${id}}&month=${OCTOBER}`],
    ['an unknown extra parameter', (id) => `?packageId=${id}&month=${OCTOBER}&duration=30`],
    ['a client-sent now', (id) => `?packageId=${id}&month=${OCTOBER}&now=2020-01-01T00:00:00Z`],
    ['a repeated month', (id) => `?packageId=${id}&month=${OCTOBER}&month=${OCTOBER}`],
    ['a repeated packageId', (id) => `?packageId=${id}&packageId=${id}&month=${OCTOBER}`],
    ['a bracketed key', (id) => `?packageId=${id}&month[gte]=${OCTOBER}`],
    ['a malformed month with an unknown package', () => `?packageId=${NONEXISTENT_ID}&month=2026-13`],
  ])('refuses %s with 400 invalid_request and no-store', async (_label, query) => {
    const res = await getAvailability(query(catalogue.short));

    expectInvalid(res);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each(['0000-01', '0050-01', '0099-12'])(
    'refuses %s, a well-formed month the engine cannot compute, with 422 naming month',
    async (month) => {
      const res = await getAvailability(monthOf(catalogue.short, month));

      expectRefused(res, ['month']);
      expect(res.headers['cache-control']).toBe('no-store');
    },
  );

  it('refuses an uncomputable month before looking the package up', async () => {
    expectRefused(await getAvailability(monthOf(NONEXISTENT_ID, '0050-01')), ['month']);
  });

  it('accepts the first year the engine computes', async () => {
    const days = await daysOf(catalogue.short, '0100-01');

    expect(days.map((day) => day.date)).toEqual(datesOf('0100-01', 31));
    expect(days.every((day) => day.starts.length === 0)).toBe(true);
  });

  it('accepts the last month a four-digit year can name', async () => {
    const days = await daysOf(catalogue.short, '9999-12');

    expect(days.map((day) => day.date)).toEqual(datesOf('9999-12', 31));
    // Friday 31 December 9999 is still a weekday.
    expect(days.at(-1)?.starts).toHaveLength(15);
  });

  it('accepts a packageId in upper case, as PostgreSQL reads a uuid', async () => {
    const lower = await getAvailability(monthOf(catalogue.short));
    const upper = await getAvailability(monthOf(catalogue.short.toUpperCase()));

    expect(upper.status).toBe(200);
    expect(upper.body).toStrictEqual(lower.body);
  });
});

describe('GET /api/availability for a package the public cannot book', () => {
  it('refuses an unknown package with 422 naming packageId, and no-store', async () => {
    const res = await getAvailability(monthOf(NONEXISTENT_ID));

    expectRefused(res, ['packageId']);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses an inactive package on an active service', async () => {
    await prisma.package.update({ where: { id: catalogue.short }, data: { isActive: false } });

    expectRefused(await getAvailability(monthOf(catalogue.short)), ['packageId']);
    // Its siblings are unaffected.
    expect((await getAvailability(monthOf(catalogue.standard))).status).toBe(200);
  });

  it('refuses an active package on an inactive service', async () => {
    await prisma.service.update({ where: { id: catalogue.serviceId }, data: { isActive: false } });

    expectRefused(await getAvailability(monthOf(catalogue.short)), ['packageId']);
  });

  it('refuses a package the moment it is deactivated, with nothing cached from before', async () => {
    expect((await getAvailability(monthOf(catalogue.short))).status).toBe(200);

    await prisma.package.update({ where: { id: catalogue.short }, data: { isActive: false } });

    expectRefused(await getAvailability(monthOf(catalogue.short)), ['packageId']);
  });
});

describe('GET /api/availability Cache-Control', () => {
  it('says no-store on a 200', async () => {
    const res = await getAvailability(monthOf(catalogue.short));

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

// --- No caching layer (plan.md Task 12) ----------------------------------------------------

describe('GET /api/availability with the database changing between two identical requests', () => {
  const WEDNESDAY = '2026-10-07';

  it('drops the starts a booking confirmed in between now occupies', async () => {
    expect(await startTimes(WEDNESDAY)).toEqual(grid('09:00', '16:00'));

    await prisma.booking.create({ data: bookingData({ reference: 'BKY-2610-00001', startsAt: at(WEDNESDAY, '11:00') }) });

    // 11:00–12:00 buffered to 12:30; a 60-minute candidate reserves 90 minutes.
    expect(await startTimes(WEDNESDAY)).toEqual([...grid('09:00', '09:30'), ...grid('12:30', '16:00')]);
  });

  it('drops the starts a live hold taken in between occupies', async () => {
    await startTimes(WEDNESDAY);

    await prisma.booking.create({
      data: bookingData({
        reference: 'BKY-2610-00001',
        startsAt: at(WEDNESDAY, '11:00'),
        status: 'pending_payment',
        holdExpiresAt: new Date(NOW.getTime() + 30 * MINUTE_MS),
      }),
    });

    expect(await startTimes(WEDNESDAY)).not.toContain('11:00');
  });

  it('returns the starts a booking cancelled in between frees', async () => {
    const booking = await prisma.booking.create({
      data: bookingData({ reference: 'BKY-2610-00001', startsAt: at(WEDNESDAY, '11:00') }),
    });
    expect(await startTimes(WEDNESDAY)).not.toContain('11:00');

    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'cancelled_by_admin' } });

    expect(await startTimes(WEDNESDAY)).toEqual(grid('09:00', '16:00'));
  });

  it('frees a hold’s slot as soon as the clock passes its expiry, with no sweeper run', async () => {
    await prisma.booking.create({
      data: bookingData({
        reference: 'BKY-2610-00001',
        startsAt: at(WEDNESDAY, '11:00'),
        status: 'pending_payment',
        holdExpiresAt: new Date(NOW.getTime() + 5 * MINUTE_MS),
      }),
    });
    expect(await startTimes(WEDNESDAY)).not.toContain('11:00');

    clock = new Date(NOW.getTime() + 5 * MINUTE_MS);

    expect(await startTimes(WEDNESDAY)).toContain('11:00');
  });

  it('drops the starts a block added in between covers', async () => {
    await startTimes(WEDNESDAY);

    await prisma.availabilityBlock.create({ data: { startsAt: at(WEDNESDAY, '09:00'), endsAt: at(WEDNESDAY, '13:00') } });

    expect(await startTimes(WEDNESDAY)).toEqual(grid('13:00', '16:00'));
  });

  it('applies a lead-time edit made in between', async () => {
    clock = at(WEDNESDAY, '10:00');
    expect((await startTimes(WEDNESDAY))[0]).toBe('12:00');

    await updateSettings({ minLeadTimeMinutes: 0 }, prisma);

    expect((await startTimes(WEDNESDAY))[0]).toBe('10:00');
  });

  it('applies a package duration edited in between', async () => {
    expect((await startTimes(WEDNESDAY, catalogue.short)).at(-1)).toBe('16:00');

    await prisma.package.update({ where: { id: catalogue.short }, data: { durationMinutes: 240 } });

    expect((await startTimes(WEDNESDAY, catalogue.short)).at(-1)).toBe('13:00');
  });

  it('applies working hours changed in between', async () => {
    expect(await startTimes('2026-10-10')).toEqual([]);

    await prisma.workingHours.create({ data: { weekday: 6, opensMinute: 540, closesMinute: 720 } });

    expect(await startTimes('2026-10-10')).toEqual(grid('09:00', '11:00'));
  });
});

// --- Bounded cost (spec §7) ---------------------------------------------------------------

describe('one month against a few hundred bookings (spec §7)', () => {
  const SLOTS_PER_DAY = 15;
  const BOOKINGS = 400;
  /** Most bookings occupy time; a few do not and must still be read past. */
  const STATUS_CYCLE: BookingStatus[] = [
    'confirmed', 'confirmed', 'confirmed', 'pending_payment', 'confirmed',
    'completed', 'confirmed', 'no_show', 'expired', 'cancelled_by_client',
  ];

  /**
   * Booking `index` of a dense October: 15 a day, 60 minutes each on a
   * 90-minute pitch from Kigali midnight, so each buffer ends as the next
   * session starts and the exclusion constraint is never tripped.
   */
  function gridBooking(index: number) {
    const day = Math.floor(index / SLOTS_PER_DAY);
    const slot = index % SLOTS_PER_DAY;
    const startsAt = new Date(at('2026-10-01', '00:00').getTime() + day * DAY_MS + slot * 90 * MINUTE_MS);
    const status = STATUS_CYCLE[index % STATUS_CYCLE.length] ?? 'confirmed';
    return bookingData({
      reference: `BKY-PERF-${String(index).padStart(5, '0')}`,
      startsAt,
      status,
      holdExpiresAt: status === 'pending_payment' ? new Date(NOW.getTime() + 30 * MINUTE_MS) : null,
    });
  }

  async function seedGrid(fromIndex: number, toIndex: number): Promise<void> {
    const data = [];
    for (let index = fromIndex; index < toIndex; index++) data.push(gridBooking(index));
    await prisma.booking.createMany({ data });
  }

  /** Open round the clock every day, the most candidates the engine can face, plus blocks. */
  async function seedWorstCase(): Promise<void> {
    await prisma.workingHours.deleteMany();
    await prisma.workingHours.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensMinute: 0, closesMinute: 1440 })),
    });
    await prisma.availabilityBlock.createMany({
      data: ['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30'].map((date) => ({
        startsAt: at(date, '06:00'),
        endsAt: at(date, '10:00'),
        reason: 'Weekly studio clean',
      })),
    });
  }

  /** The SQL statements one run issues, counted from Prisma's query events. */
  async function queriesDuring(run: () => Promise<unknown>): Promise<string[]> {
    queries = [];
    await run();
    // Let any event emitted after the result resolved land before counting.
    await new Promise((resolve) => setImmediate(resolve));
    return [...queries];
  }

  it('issues the same number of queries for 3 bookings as for 400', async () => {
    await seedWorstCase();
    await seedGrid(0, 3);

    let small: AvailabilityJson | undefined;
    const smallHttp = await queriesDuring(async () => {
      small = bodyOf(await getAvailability(monthOf(catalogue.short)));
    });

    await seedGrid(3, BOOKINGS);
    await expect(prisma.booking.count()).resolves.toBe(BOOKINGS);

    let large: AvailabilityJson | undefined;
    const largeHttp = await queriesDuring(async () => {
      large = bodyOf(await getAvailability(monthOf(catalogue.short)));
    });

    // The data really grew and really mattered, so an unchanged count means the cost does not.
    const count = (body?: AvailabilityJson) => body?.days.reduce((sum, day) => sum + day.starts.length, 0) ?? 0;
    expect(count(large)).toBeLessThan(count(small));

    // The package, the settings, then working hours, blocks and bookings.
    expect(largeHttp).toHaveLength(smallHttp.length);
    expect(largeHttp.length).toBeLessThanOrEqual(5);
  });

  it('answers the month in under 500 ms at p95', { timeout: 60_000 }, async () => {
    await seedWorstCase();
    await seedGrid(0, BOOKINGS);

    const server = app.listen(0);
    try {
      const url = monthOf(catalogue.short);
      for (let i = 0; i < 5; i++) await getAvailability(url, server).expect(200);

      const REQUESTS = 40;
      const durations: number[] = [];
      for (let i = 0; i < REQUESTS; i++) {
        const started = performance.now();
        const res = await getAvailability(url, server);
        durations.push(performance.now() - started);
        expect(res.status).toBe(200);
        expect((res.body as AvailabilityJson).days).toHaveLength(31);
      }

      durations.sort((a, b) => a - b);
      const p95 = durations[Math.ceil(REQUESTS * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
      expect(p95, `p95 of ${REQUESTS} requests, in ms`).toBeLessThan(500);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
