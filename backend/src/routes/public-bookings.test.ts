import type { Addon, Package, PrismaClient, Service } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createPrismaClient } from '../db/client.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';

/**
 * `POST /api/bookings` over HTTP, against real PostgreSQL (plan.md Task 13;
 * spec §3.1 steps 6-8, §6.1, §6.13, §7; data-model_v2.md §5.8-§5.10, §9.5).
 *
 * What is proven: a booking comes back in exactly the public shape, with no id
 * and none of the client's details, and amounts priced from the catalogue; a
 * body carrying its own totals, status, hold, reference or ids has every one of
 * them ignored; a start the calendar does not offer -- out of hours, inside the
 * lead time, on a weekend, off the grid, blocked or occupied -- is a 422 on
 * `startsAt` however the request was made; consent must be `true` and is
 * recorded; validation follows the one rule (400 malformed, 422 a rule broken,
 * naming every field); the form's values are normalised before they are
 * stored; a race lost inside the claim is a 409 that leaves nothing behind; and
 * the route is anonymous, and absent unless the public API is mounted.
 *
 * Kigali is UTC+2 with no DST. The clock is Thursday 1 October 2026, 08:00
 * Kigali, so today's earliest bookable start is 10:00.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let catalogue: Catalogue;

const NOW = new Date('2026-10-01T06:00:00Z');
const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;
const BOOKINGS = '/api/bookings';
const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';
const REFERENCE = /^BKY-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$/;

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
  // Defaults 0.400 / 120 / 30 / 30 / 90.
  await prisma.setting.create({ data: { id: 1 } });
  await prisma.workingHours.createMany({
    data: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinute: 540, closesMinute: 1020 })),
  });
  catalogue = await seedCatalogue();
  app = createApp({ publicApi: { prisma, now: () => NOW } });
});

// --- Fixtures ---------------------------------------------------------------

type Catalogue = {
  portraits: Service;
  weddings: Service;
  /** 40,000 RWF, 25 photos, 90 minutes. */
  standard: Package;
  /** 40,000 RWF, 60 minutes, at the Weddings 30% override. */
  fullDay: Package;
  /** Portraits' own, 10,000 RWF. */
  extraHour: Addon;
  /** Weddings' own, 10,000 RWF. */
  secondShooter: Addon;
  /** Shared, 5,000 RWF. */
  rushEdit: Addon;
};

async function seedCatalogue(): Promise<Catalogue> {
  const portraits = await prisma.service.create({ data: { slug: 'portraits', nameEn: 'Portraits' } });
  const weddings = await prisma.service.create({
    data: { slug: 'weddings', nameEn: 'Weddings', bookingFeeRateOverride: '0.300', sortOrder: 1 },
  });
  return {
    portraits,
    weddings,
    standard: await prisma.package.create({
      data: { serviceId: portraits.id, nameEn: 'Standard', priceRwf: 40_000, photoCount: 25, durationMinutes: 90 },
    }),
    fullDay: await prisma.package.create({
      data: { serviceId: weddings.id, nameEn: 'Full day', priceRwf: 40_000, photoCount: 150, durationMinutes: 60 },
    }),
    extraHour: await prisma.addon.create({ data: { serviceId: portraits.id, nameEn: 'Extra hour', priceRwf: 10_000 } }),
    secondShooter: await prisma.addon.create({ data: { serviceId: weddings.id, nameEn: 'Second shooter', priceRwf: 10_000 } }),
    rushEdit: await prisma.addon.create({ data: { serviceId: null, nameEn: 'Rush edit', priceRwf: 5_000, sortOrder: 3 } }),
  };
}

/** A Kigali wall-clock time on `date`, as the ISO string a browser would send. */
function kigali(date: string, wallTime: string): string {
  return `${date}T${wallTime}:00+02:00`;
}

const WEDNESDAY = '2026-10-07';
const THURSDAY = '2026-10-08';

/** The first Kigali Wednesday at least `days` after `instant`, for tests on the real clock. */
function kigaliWednesdayAfter(instant: number, days: number): string {
  for (let t = instant + days * DAY_MS; ; t += DAY_MS) {
    const local = new Date(t + 120 * MINUTE_MS);
    if (local.getUTCDay() === 3) return local.toISOString().slice(0, 10);
  }
}

/** A body the API accepts: Standard plus Extra hour on Wednesday at 09:00. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageId: catalogue.standard.id,
    addonIds: [catalogue.extraHour.id],
    startsAt: kigali(WEDNESDAY, '09:00'),
    fullName: 'Aline Uwase',
    email: 'aline@example.com',
    phone: '0788123456',
    location: 'Kigali Heights, KG 7 Ave',
    partySize: 3,
    specialRequests: 'Golden hour if possible.',
    consent: true,
    ...overrides,
  };
}

/** The valid body without the named keys. */
function without(...keys: string[]): Record<string, unknown> {
  const body = validBody();
  for (const key of keys) delete body[key];
  return body;
}

function post(body: unknown, target: Express = app): request.Test {
  return request(target).post(BOOKINGS).send(body as object);
}

function postText(text: string, contentType = 'application/json'): request.Test {
  return request(app).post(BOOKINGS).set('Content-Type', contentType).send(text);
}

type HeldBooking = {
  reference: string;
  status: string;
  startsAt: string;
  endsAt: string;
  holdExpiresAt: string | null;
  serviceName: string;
  packageName: string;
  packagePriceRwf: number;
  addons: { name: string; priceRwf: number }[];
  totalRwf: number;
  bookingFeeRate: number;
  bookingFeeRwf: number;
  sessionFeeRwf: number;
};

function createdBooking(res: Response): HeldBooking {
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.headers['content-type']).toMatch(/^application\/json/);
  return (res.body as { booking: HeldBooking }).booking;
}

function expectInvalid(res: Response): void {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body).toStrictEqual({ error: 'invalid_request' });
}

function expectRefused(res: Response, fields: string[]): void {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body).toStrictEqual({ error: 'validation_failed', fields });
}

type Counts = { bookings: number; clients: number; addons: number };

async function counts(): Promise<Counts> {
  const [bookings, clients, addons] = await Promise.all([
    prisma.booking.count(),
    prisma.client.count(),
    prisma.bookingAddon.count(),
  ]);
  return { bookings, clients, addons };
}

const NOTHING: Counts = { bookings: 0, clients: 0, addons: 0 };

async function databaseNowMs(): Promise<number> {
  const result = await raw.query<{ ms: string }>(`SELECT (extract(epoch from now()) * 1000)::bigint AS ms`);
  return Number(firstRow(result).ms);
}

/** A confirmed (or other) booking written directly, on its own client. */
async function insertExistingBooking(options: {
  reference: string;
  startsAt: string;
  status?: string;
  holdExpiresAt?: Date | null;
}) {
  const startsAt = new Date(options.startsAt);
  const endsAt = new Date(startsAt.getTime() + 90 * MINUTE_MS);
  const email = `rival-${options.reference.toLowerCase()}@example.com`;
  const client = await prisma.client.create({ data: { fullName: 'Rival Visitor', email, phone: '+250788999999' } });
  return prisma.booking.create({
    data: {
      reference: options.reference,
      clientId: client.id,
      contactName: 'Rival Visitor',
      contactEmail: email,
      contactPhone: '+250788999999',
      serviceId: catalogue.portraits.id,
      packageId: catalogue.standard.id,
      serviceNameSnapshot: 'Portraits',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 40_000,
      packageDurationMinutes: 90,
      packagePhotoCount: 25,
      startsAt,
      endsAt,
      bufferEndsAt: new Date(endsAt.getTime() + 30 * MINUTE_MS),
      status: options.status ?? 'confirmed',
      holdExpiresAt: options.holdExpiresAt ?? null,
      locationText: 'Elsewhere',
      consentAt: NOW,
      bookingFeeRate: '0.400',
      bookingFeeRwf: 16_000,
    },
  });
}

/** The root client with a rival booking committed just before the claim transaction opens. */
function withRivalBeforeClaim(rival: () => Promise<unknown>): PrismaClient {
  let fired = false;
  return new Proxy(prisma, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property === '$transaction' && typeof value === 'function') {
        return async (...args: unknown[]) => {
          if (!fired) {
            fired = true;
            await rival();
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// --- 201 ----------------------------------------------------------------------

describe('POST /api/bookings: a booking held', () => {
  it('answers 201 with exactly the public shape: 50,000 total, 20,000 now at 40%, 30,000 after', async () => {
    const dbBefore = await databaseNowMs();
    const res = await post(validBody());
    const dbAfter = await databaseNowMs();

    const booking = createdBooking(res);
    expect(res.body).toStrictEqual({
      booking: {
        reference: expect.stringMatching(REFERENCE),
        status: 'pending_payment',
        startsAt: '2026-10-07T07:00:00.000Z',
        endsAt: '2026-10-07T08:30:00.000Z',
        holdExpiresAt: expect.any(String),
        serviceName: 'Portraits',
        packageName: 'Standard',
        packagePriceRwf: 40_000,
        addons: [{ name: 'Extra hour', priceRwf: 10_000 }],
        totalRwf: 50_000,
        bookingFeeRate: 0.4,
        bookingFeeRwf: 20_000,
        sessionFeeRwf: 30_000,
      },
    });
    const hold = Date.parse(booking.holdExpiresAt ?? '');
    expect(hold).toBeGreaterThanOrEqual(dbBefore + 30 * MINUTE_MS - 5_000);
    expect(hold).toBeLessThanOrEqual(dbAfter + 30 * MINUTE_MS + 5_000);
    expect(booking.reference.slice(0, 9)).toBe('BKY-2610-');
  });

  it('matches what it stored', async () => {
    const booking = createdBooking(await post(validBody()));

    const stored = await prisma.booking.findUniqueOrThrow({ where: { reference: booking.reference }, include: { addons: true } });
    expect(stored.status).toBe(booking.status);
    expect(stored.startsAt.toISOString()).toBe(booking.startsAt);
    expect(stored.endsAt.toISOString()).toBe(booking.endsAt);
    expect(stored.holdExpiresAt?.toISOString()).toBe(booking.holdExpiresAt);
    expect(stored.bookingFeeRwf).toBe(booking.bookingFeeRwf);
    expect(stored.bookingFeeRate.toString()).toBe('0.4');
    expect(stored.packagePriceRwf).toBe(booking.packagePriceRwf);
    expect(stored.addons.map((addon) => [addon.nameSnapshot, addon.amountRwf, addon.stage])).toEqual([['Extra hour', 10_000, 'at_booking']]);
  });

  it('carries no id and none of the client’s details', async () => {
    const res = await post(validBody({ fullName: 'Aline Uwase', specialRequests: 'Bring the red umbrella' }));

    const booking = createdBooking(res);
    const stored = await prisma.booking.findUniqueOrThrow({ where: { reference: booking.reference } });
    for (const key of ['id', 'clientId', 'client', 'contactName', 'contactEmail', 'contactPhone', 'locationText', 'partySize', 'specialRequests', 'consentAt', 'accessToken', 'accessTokenHash']) {
      expect(booking).not.toHaveProperty(key);
    }
    for (const secret of [stored.id, stored.clientId, 'Aline', 'aline@example.com', '788123456', 'Kigali Heights', 'red umbrella']) {
      expect(res.text).not.toContain(secret);
    }
  });

  it('answers 15,000 now and 35,000 after at a service’s own 30% rate', async () => {
    const booking = createdBooking(
      await post(validBody({ packageId: catalogue.fullDay.id, addonIds: [catalogue.secondShooter.id], startsAt: kigali(WEDNESDAY, '14:00') })),
    );

    expect(booking).toMatchObject({
      serviceName: 'Weddings',
      packageName: 'Full day',
      endsAt: '2026-10-07T13:00:00.000Z',
      addons: [{ name: 'Second shooter', priceRwf: 10_000 }],
      totalRwf: 50_000,
      bookingFeeRate: 0.3,
      bookingFeeRwf: 15_000,
      sessionFeeRwf: 35_000,
    });
  });

  it('lists add-ons in catalogue order, whatever order they were sent in', async () => {
    const booking = createdBooking(await post(validBody({ addonIds: [catalogue.rushEdit.id, catalogue.extraHour.id] })));

    expect(booking.addons).toEqual([
      { name: 'Extra hour', priceRwf: 10_000 },
      { name: 'Rush edit', priceRwf: 5_000 },
    ]);
    expect(booking).toMatchObject({ totalRwf: 55_000, bookingFeeRwf: 22_000, sessionFeeRwf: 33_000 });
  });

  it('books a package without add-ons when addonIds is omitted or empty', async () => {
    const omitted = createdBooking(await post(without('addonIds')));
    const empty = createdBooking(await post(validBody({ addonIds: [], startsAt: kigali(THURSDAY, '09:00') })));

    for (const booking of [omitted, empty]) {
      expect(booking).toMatchObject({ addons: [], totalRwf: 40_000, bookingFeeRwf: 16_000, sessionFeeRwf: 24_000 });
    }
  });

  it('accepts add-on ids in upper case', async () => {
    const booking = createdBooking(await post(validBody({ addonIds: [catalogue.extraHour.id.toUpperCase()] })));

    expect(booking.addons).toEqual([{ name: 'Extra hour', priceRwf: 10_000 }]);
  });

  it('takes the slot off the public calendar at once, and refuses the same start again with 422', async () => {
    // The hold is stamped on the database clock, so the app clock must be the
    // real one for the calendar to see it live: the fixed test clock is weeks
    // away from the database's.
    const realApp = createApp({ publicApi: { prisma, now: () => new Date() } });
    const date = kigaliWednesdayAfter(Date.now(), 3);
    const startsAt = kigali(date, '09:00');
    createdBooking(await post(validBody({ startsAt }), realApp));

    const month = await request(realApp).get(`/api/availability?packageId=${catalogue.standard.id}&month=${date.slice(0, 7)}`);
    const day = (month.body as { days: { date: string; starts: string[] }[] }).days.find((candidate) => candidate.date === date);
    expect(day?.starts).toContain(new Date(kigali(date, '14:00')).toISOString());
    expect(day?.starts).not.toContain(new Date(startsAt).toISOString());

    expectRefused(await post(validBody({ startsAt, email: 'second@example.com' }), realApp), ['startsAt']);
    await expect(prisma.booking.count()).resolves.toBe(1);
    await expect(prisma.client.count()).resolves.toBe(1);
  });

  it('reuses one client for two bookings from the same address in different case', async () => {
    createdBooking(await post(validBody()));
    createdBooking(await post(validBody({ email: 'ALINE@example.COM', phone: '+250 722 000 111', startsAt: kigali(THURSDAY, '09:00') })));

    await expect(prisma.client.count()).resolves.toBe(1);
    const bookings = await prisma.booking.findMany({ orderBy: { startsAt: 'asc' } });
    expect(bookings.map((booking) => booking.contactPhone)).toEqual(['+250788123456', '+250722000111']);
    expect(bookings.map((booking) => booking.contactEmail)).toEqual(['aline@example.com', 'aline@example.com']);
    await expect(prisma.client.findFirstOrThrow()).resolves.toMatchObject({ phone: '+250722000111' });
  });
});

// --- Trusts nothing -----------------------------------------------------------

describe('POST /api/bookings trusts nothing the client sends', () => {
  it('prices, schedules and creates from the catalogue, honouring none of the extra keys', async () => {
    const foreignClient = await prisma.client.create({ data: { fullName: 'Victim', email: 'victim@example.com', phone: '+250700000000' } });

    const res = await post(
      validBody({
        totalRwf: 1,
        bookingFeeRwf: 1,
        bookingFeeRate: 0.001,
        sessionFeeRwf: 0,
        packagePriceRwf: 1,
        status: 'confirmed',
        holdExpiresAt: '2099-01-01T00:00:00.000Z',
        reference: 'BKY-2610-HACKD',
        clientId: foreignClient.id,
        id: NONEXISTENT_ID,
        endsAt: '2026-10-07T20:00:00+02:00',
        bufferEndsAt: '2026-10-07T20:00:00+02:00',
        consentAt: '2000-01-01T00:00:00Z',
        locale: 'fr',
        serviceId: catalogue.weddings.id,
        contactEmail: 'victim@example.com',
        confirmedAt: '2026-10-01T00:00:00Z',
        addons: [{ name: 'Free prints', priceRwf: 0 }],
      }),
    );

    const booking = createdBooking(res);
    expect(booking).toMatchObject({
      status: 'pending_payment',
      endsAt: '2026-10-07T08:30:00.000Z',
      serviceName: 'Portraits',
      packagePriceRwf: 40_000,
      addons: [{ name: 'Extra hour', priceRwf: 10_000 }],
      totalRwf: 50_000,
      bookingFeeRate: 0.4,
      bookingFeeRwf: 20_000,
      sessionFeeRwf: 30_000,
    });
    expect(booking.reference).not.toBe('BKY-2610-HACKD');
    expect(Date.parse(booking.holdExpiresAt ?? '')).toBeLessThan(Date.parse('2099-01-01T00:00:00Z'));

    const stored = await prisma.booking.findUniqueOrThrow({ where: { reference: booking.reference } });
    expect(stored.clientId).not.toBe(foreignClient.id);
    expect(stored.id).not.toBe(NONEXISTENT_ID);
    expect(stored.status).toBe('pending_payment');
    expect(stored.confirmedAt).toBeNull();
    expect(stored.serviceId).toBe(catalogue.portraits.id);
    expect(stored.locale).toBe('en');
    expect(stored.contactEmail).toBe('aline@example.com');
    expect(stored.consentAt.toISOString()).toBe(NOW.toISOString());
    expect(stored.bufferEndsAt.toISOString()).toBe('2026-10-07T09:00:00.000Z');
    expect(stored.bookingFeeRate.toFixed(3)).toBe('0.400');
    expect(stored.bookingFeeRwf).toBe(20_000);
    // The client named by id was neither linked nor touched.
    await expect(prisma.client.findUniqueOrThrow({ where: { id: foreignClient.id } })).resolves.toEqual(foreignClient);
    await expect(prisma.client.count()).resolves.toBe(2);
  });

  it('prices from the catalogue as it stands at submission, not as the page last showed it', async () => {
    await prisma.package.update({ where: { id: catalogue.standard.id }, data: { priceRwf: 45_000 } });

    const booking = createdBooking(await post(validBody({ packagePriceRwf: 40_000, totalRwf: 50_000 })));

    expect(booking).toMatchObject({ packagePriceRwf: 45_000, totalRwf: 55_000, bookingFeeRwf: 22_000, sessionFeeRwf: 33_000 });
  });
});

// --- A start the calendar does not offer ------------------------------------

describe('POST /api/bookings with a start the calendar does not offer', () => {
  it.each<[string, () => string | Promise<string>]>([
    ['out of hours (19:00)', () => kigali(WEDNESDAY, '19:00')],
    ['before opening (08:00)', () => kigali(WEDNESDAY, '08:00')],
    ['running past closing (16:00, 90 minutes)', () => kigali(WEDNESDAY, '16:00')],
    ['inside the 120-minute lead time (today 09:30)', () => kigali('2026-10-01', '09:30')],
    ['in the past', () => kigali('2026-09-30', '10:00')],
    ['on a Saturday', () => kigali('2026-10-10', '10:00')],
    ['on a Sunday', () => kigali('2026-10-11', '10:00')],
    ['off the 30-minute grid', () => kigali(WEDNESDAY, '09:10')],
    ['with seconds off the grid', () => '2026-10-07T09:00:30+02:00'],
    [
      'inside a block',
      async () => {
        await prisma.availabilityBlock.create({
          data: { startsAt: new Date(kigali(WEDNESDAY, '09:00')), endsAt: new Date(kigali(WEDNESDAY, '12:00')), reason: 'Dentist' },
        });
        return kigali(WEDNESDAY, '10:00');
      },
    ],
    [
      'occupied by a confirmed booking',
      async () => {
        await insertExistingBooking({ reference: 'BKY-2610-CONF1', startsAt: kigali(WEDNESDAY, '09:00') });
        return kigali(WEDNESDAY, '09:30');
      },
    ],
    [
      'inside a confirmed booking’s buffer',
      async () => {
        await insertExistingBooking({ reference: 'BKY-2610-CONF1', startsAt: kigali(WEDNESDAY, '09:00') });
        return kigali(WEDNESDAY, '10:30');
      },
    ],
  ])('answers 422 on startsAt for a start %s, bypassing the UI, and writes nothing', async (_label, start) => {
    const startsAt = await start();
    const before = await counts();

    const res = await post(validBody({ startsAt }));

    expectRefused(res, ['startsAt']);
    await expect(counts()).resolves.toEqual(before);
  });

  it('never echoes a block’s private reason', async () => {
    await prisma.availabilityBlock.create({
      data: { startsAt: new Date(kigali(WEDNESDAY, '09:00')), endsAt: new Date(kigali(WEDNESDAY, '12:00')), reason: 'Dentist' },
    });

    const res = await post(validBody({ startsAt: kigali(WEDNESDAY, '10:00') }));

    expect(res.text).not.toContain('Dentist');
  });

  it('accepts the same instant sent in UTC', async () => {
    const booking = createdBooking(await post(validBody({ startsAt: '2026-10-07T07:00:00.000Z' })));

    expect(booking.startsAt).toBe('2026-10-07T07:00:00.000Z');
  });

  it('answers 422 for a start year the engine cannot compute (0050)', async () => {
    expectRefused(await post(validBody({ startsAt: '0050-10-07T09:00:00+02:00' })), ['startsAt']);
    await expect(counts()).resolves.toEqual(NOTHING);
  });
});

describe('POST /api/bookings with a basket the public cannot book', () => {
  it.each<[string, () => Record<string, unknown>, string[]]>([
    ['an unknown package', () => ({ packageId: NONEXISTENT_ID }), ['packageId']],
    ['an add-on of another service', () => ({ addonIds: [catalogue.secondShooter.id] }), ['addonIds']],
    ['an unknown add-on', () => ({ addonIds: [NONEXISTENT_ID] }), ['addonIds']],
    ['the same add-on twice', () => ({ addonIds: [catalogue.extraHour.id, catalogue.extraHour.id] }), ['addonIds']],
    ['the same add-on twice in different case', () => ({ addonIds: [catalogue.extraHour.id, catalogue.extraHour.id.toUpperCase()] }), ['addonIds']],
    ['51 add-ons', () => ({ addonIds: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }), ['addonIds']],
  ])('answers 422 for %s and writes nothing', async (_label, overrides, fields) => {
    expectRefused(await post(validBody(overrides())), fields);
    await expect(counts()).resolves.toEqual(NOTHING);
  });

  it('answers 422 for a deactivated package and a package on a deactivated service', async () => {
    await prisma.package.update({ where: { id: catalogue.standard.id }, data: { isActive: false } });
    expectRefused(await post(validBody({ addonIds: [] })), ['packageId']);

    await prisma.package.update({ where: { id: catalogue.standard.id }, data: { isActive: true } });
    await prisma.service.update({ where: { id: catalogue.portraits.id }, data: { isActive: false } });
    expectRefused(await post(validBody({ addonIds: [] })), ['packageId']);

    await expect(counts()).resolves.toEqual(NOTHING);
  });
});

// --- Consent (Law N° 058/2021) ----------------------------------------------

describe('POST /api/bookings and consent', () => {
  it('answers 422 on consent when it is omitted, and writes nothing', async () => {
    expectRefused(await post(without('consent')), ['consent']);
    await expect(counts()).resolves.toEqual(NOTHING);
  });

  it('answers 422 on consent when it is false', async () => {
    expectRefused(await post(validBody({ consent: false })), ['consent']);
    await expect(counts()).resolves.toEqual(NOTHING);
  });

  it.each([['true'], ['on'], [null], [1], [0], [[true]], [{}]])('answers 400 for consent %j, which is not a boolean', async (consent) => {
    expectInvalid(await post(validBody({ consent })));
    await expect(counts()).resolves.toEqual(NOTHING);
  });

  it('writes consent_at, at the injected clock, on success', async () => {
    const booking = createdBooking(await post(validBody()));

    const result = await raw.query<{ ms: string }>(
      `SELECT (extract(epoch from consent_at) * 1000)::bigint AS ms FROM booking WHERE reference = $1`,
      [booking.reference],
    );
    expect(Number(firstRow(result).ms)).toBe(NOW.getTime());
  });
});

// --- Validation: 422 ----------------------------------------------------------

describe('POST /api/bookings: a rule broken is a 422 naming the field', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['an empty name', { fullName: '' }, 'fullName'],
    ['a blank name', { fullName: '   ' }, 'fullName'],
    ['a 201-character name', { fullName: 'a'.repeat(201) }, 'fullName'],
    ['an unreadable email', { email: 'not-an-email' }, 'email'],
    ['an email without a domain', { email: 'aline@' }, 'email'],
    ['an empty email', { email: '' }, 'email'],
    ['an email of 321 characters', { email: `${'a'.repeat(309)}@example.com` }, 'email'],
    ['a phone with letters', { phone: 'call me' }, 'phone'],
    ['a phone with too few digits', { phone: '12 34' }, 'phone'],
    ['a phone with too many digits', { phone: '+1234567890123456' }, 'phone'],
    ['an empty phone', { phone: '' }, 'phone'],
    ['a phone of 41 characters', { phone: `0788123456${' '.repeat(31)}` }, 'phone'],
    ['a blank location', { location: '  ' }, 'location'],
    ['a 501-character location', { location: 'x'.repeat(501) }, 'location'],
    ['a party of 0', { partySize: 0 }, 'partySize'],
    ['a party of -1', { partySize: -1 }, 'partySize'],
    ['a party of 1001', { partySize: 1001 }, 'partySize'],
    ['special requests of 2001 characters', { specialRequests: 'x'.repeat(2001) }, 'specialRequests'],
  ])('answers 422 for %s', async (_label, overrides, field) => {
    expectRefused(await post(validBody(overrides)), [field]);
    await expect(counts()).resolves.toEqual(NOTHING);
  });

  it('accepts the limits themselves', async () => {
    const booking = createdBooking(
      await post(
        validBody({
          fullName: 'a'.repeat(200),
          location: 'x'.repeat(500),
          partySize: 1000,
          specialRequests: 'x'.repeat(2000),
          phone: '+123456789012345',
        }),
      ),
    );
    const stored = await prisma.booking.findUniqueOrThrow({ where: { reference: booking.reference } });
    expect(stored.partySize).toBe(1000);
    expect(stored.specialRequests).toHaveLength(2000);

    createdBooking(await post(validBody({ partySize: 1, phone: '1234567', email: 'b@example.com', startsAt: kigali(THURSDAY, '09:00') })));
  });

  it('measures the limits after trimming', async () => {
    const booking = createdBooking(
      await post(validBody({ fullName: `  ${'a'.repeat(200)}  `, specialRequests: `  ${'x'.repeat(2000)}  ` })),
    );

    expect(booking.status).toBe('pending_payment');
  });

  it('reports several rule breaks together, and never echoes a value', async () => {
    const res = await post(
      validBody({ fullName: ' ', email: 'nope', phone: 'call me', location: '', partySize: 0, specialRequests: 'x'.repeat(2001), consent: false }),
    );

    expect(res.status).toBe(422);
    const body = res.body as { error: string; fields: string[] };
    expect(body.error).toBe('validation_failed');
    expect([...body.fields].sort()).toEqual(['consent', 'email', 'fullName', 'location', 'partySize', 'phone', 'specialRequests']);
    expect(Object.keys(body).sort()).toEqual(['error', 'fields']);
    expect(res.text).not.toContain('nope');
    expect(res.text).not.toContain('call me');
    await expect(counts()).resolves.toEqual(NOTHING);
  });

  // PostgreSQL text cannot hold U+0000 (22021). A visitor's input must be
  // refused by the schema, never surface as a 500 from the database.
  it.each(['fullName', 'location', 'specialRequests', 'email', 'phone'])(
    'refuses a NUL character in %s with a 4xx, not a 500, and writes nothing',
    async (field) => {
      const nul = String.fromCharCode(0);
      const value = field === 'email' ? `aline${nul}@example.com` : field === 'phone' ? `0788123456${nul}` : `Aline${nul}Uwase`;

      const res = await post(validBody({ [field]: value }));

      expect([400, 422], JSON.stringify(res.body)).toContain(res.status);
      await expect(counts()).resolves.toEqual(NOTHING);
    },
  );

  it('answers 400, not 422, when a malformed value comes with the rule breaks', async () => {
    expectInvalid(await post(validBody({ fullName: '', partySize: '2' })));
  });
});

// --- Validation: 400 ----------------------------------------------------------

describe('POST /api/bookings: a malformed request is a 400', () => {
  it.each<[string, () => Record<string, unknown>]>([
    ['no packageId', () => without('packageId')],
    ['a non-uuid packageId', () => validBody({ packageId: 'not-a-uuid' })],
    ['a numeric packageId', () => validBody({ packageId: 42 })],
    ['a null packageId', () => validBody({ packageId: null })],
    ['addonIds that is not an array', () => validBody({ addonIds: catalogue.extraHour.id })],
    ['a non-uuid add-on id', () => validBody({ addonIds: ['extra-hour'] })],
    ['no startsAt', () => without('startsAt')],
    ['a startsAt without an offset', () => validBody({ startsAt: '2026-10-07T09:00:00' })],
    ['a startsAt that is only a date', () => validBody({ startsAt: '2026-10-07' })],
    ['an unparseable startsAt', () => validBody({ startsAt: 'next Wednesday at nine' })],
    ['a startsAt on a day the calendar lacks', () => validBody({ startsAt: '2026-02-30T09:00:00+02:00' })],
    ['a startsAt as epoch milliseconds', () => validBody({ startsAt: Date.parse('2026-10-07T07:00:00Z') })],
    ['no fullName', () => without('fullName')],
    ['a numeric fullName', () => validBody({ fullName: 42 })],
    ['no email', () => without('email')],
    ['a null email', () => validBody({ email: null })],
    ['no phone', () => without('phone')],
    ['a numeric phone', () => validBody({ phone: 788123456 })],
    ['no location', () => without('location')],
    ['a partySize of 2.5', () => validBody({ partySize: 2.5 })],
    ['a partySize of "2"', () => validBody({ partySize: '2' })],
    ['a numeric specialRequests', () => validBody({ specialRequests: 42 })],
  ])('answers 400 for %s', async (_label, body) => {
    expectInvalid(await post(body()));
    await expect(counts()).resolves.toEqual(NOTHING);
  });

  it.each([
    ['malformed JSON', '{"packageId":', 'application/json'],
    ['a JSON array', '[]', 'application/json'],
    ['a JSON string', '"booking"', 'application/json'],
    ['JSON null', 'null', 'application/json'],
  ])('answers 400 for %s', async (_label, text, contentType) => {
    expectInvalid(await postText(text, contentType));
    await expect(counts()).resolves.toEqual(NOTHING);
  });

  it('answers 400 for an empty or non-JSON body, which parses to nothing', async () => {
    expectInvalid(await request(app).post(BOOKINGS));
    expectInvalid(await postText('packageId=x', 'application/x-www-form-urlencoded'));
    await expect(counts()).resolves.toEqual(NOTHING);
  });
});

// --- Normalisation ------------------------------------------------------------

describe('POST /api/bookings stores the form normalised', () => {
  it('lowercases and trims the email, reads the phone as E.164, and trims the text', async () => {
    const booking = createdBooking(
      await post(
        validBody({
          fullName: '  Aline Uwase  ',
          email: '  Aline.Uwase@Example.COM ',
          phone: ' 078 812 3456 ',
          location: '  Kigali Heights  ',
          specialRequests: '  Golden hour  ',
        }),
      ),
    );

    const stored = await prisma.booking.findUniqueOrThrow({ where: { reference: booking.reference }, include: { client: true } });
    expect(stored).toMatchObject({
      contactName: 'Aline Uwase',
      contactEmail: 'aline.uwase@example.com',
      contactPhone: '+250788123456',
      locationText: 'Kigali Heights',
      specialRequests: 'Golden hour',
    });
    expect(stored.client).toMatchObject({ fullName: 'Aline Uwase', email: 'aline.uwase@example.com', phone: '+250788123456' });
  });

  it.each([
    ['250788123456', '+250788123456'],
    ['+250 788 123 456', '+250788123456'],
    ['+1 (415) 555-0100', '+14155550100'],
  ])('stores the phone %j as %s', async (phone, expected) => {
    const booking = createdBooking(await post(validBody({ phone })));

    const stored = await prisma.booking.findUniqueOrThrow({ where: { reference: booking.reference } });
    expect(stored.contactPhone).toBe(expected);
  });

  it('stores blank special requests as null', async () => {
    const booking = createdBooking(await post(validBody({ specialRequests: '   ' })));

    const stored = await prisma.booking.findUniqueOrThrow({ where: { reference: booking.reference } });
    expect(stored.specialRequests).toBeNull();
  });

  it('stores omitted or null party size and special requests as null', async () => {
    const omitted = createdBooking(await post(without('partySize', 'specialRequests')));
    const nulled = createdBooking(
      await post(validBody({ partySize: null, specialRequests: null, startsAt: kigali(THURSDAY, '09:00'), email: 'b@example.com' })),
    );

    for (const booking of [omitted, nulled]) {
      const stored = await prisma.booking.findUniqueOrThrow({ where: { reference: booking.reference } });
      expect(stored.partySize).toBeNull();
      expect(stored.specialRequests).toBeNull();
    }
  });
});

// --- 409 ----------------------------------------------------------------------

describe('POST /api/bookings when the slot goes between check and claim', () => {
  it('answers 409 slot_taken and leaves no booking, add-on or client behind', async () => {
    const racing = withRivalBeforeClaim(() => insertExistingBooking({ reference: 'BKY-2610-RIVAL', startsAt: kigali(WEDNESDAY, '09:00') }));
    const racingApp = createApp({ publicApi: { prisma: racing, now: () => NOW } });

    const res = await post(validBody({ email: 'brand-new@example.com' }), racingApp);

    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual({ error: 'slot_taken' });
    await expect(prisma.booking.count()).resolves.toBe(1);
    await expect(prisma.bookingAddon.count()).resolves.toBe(0);
    await expect(prisma.client.count({ where: { email: 'brand-new@example.com' } })).resolves.toBe(0);
  });

  it('answers 409 for a hold the calendar saw as lapsed that the database clock still keeps', async () => {
    const dbNow = await databaseNowMs();
    const now = new Date(dbNow + 2 * DAY_MS);
    const date = kigaliWednesdayAfter(now.getTime(), 3);
    const existing = await prisma.client.create({ data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788123456' } });
    await insertExistingBooking({
      reference: 'BKY-2610-LIVE1',
      startsAt: kigali(date, '09:00'),
      status: 'pending_payment',
      holdExpiresAt: new Date(dbNow + DAY_MS),
    });
    const laterApp = createApp({ publicApi: { prisma, now: () => now } });

    const res = await post(validBody({ startsAt: kigali(date, '09:00'), fullName: 'Someone Else', phone: '+250722999999' }), laterApp);

    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual({ error: 'slot_taken' });
    await expect(prisma.client.findUniqueOrThrow({ where: { id: existing.id } })).resolves.toEqual(existing);
    await expect(prisma.booking.count()).resolves.toBe(1);
  });
});

describe('POST /api/bookings when many visitors submit one slot at once', () => {
  // Conflicting inserts under the exclusion constraint can deadlock (40P01),
  // most readily against an empty booking table, and lock waits can outlast
  // Prisma's 5 s transaction (P2028). Every loser must still get a 409 or a
  // 422 -- never a 500 -- and every round must leave the slot booked once.
  it('answers only 201, 409 or 422, and books the slot once, over 10 rounds of 12 simultaneous requests', { timeout: 300_000 }, async () => {
    const statuses: Record<string, number> = {};
    const badRounds: string[] = [];
    // 120 requests from one IP: this is the claim's race, not the request limit.
    app = createApp({
      publicApi: { prisma, now: () => NOW },
      rateLimits: { bookingsPerIp: { limit: 1_000, windowMs: 60 * MINUTE_MS } },
    });

    for (let round = 0; round < 10; round += 1) {
      await raw.query('TRUNCATE booking_addon, booking, client CASCADE');
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_unused, i) => post(validBody({ email: `racer-${round}-${i}@example.com` }))),
      );
      for (const res of responses) statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      const created = responses.filter((res) => res.status === 201).length;
      const { bookings, clients } = await counts();
      if (created !== 1 || bookings !== 1 || clients !== 1) {
        badRounds.push(`round ${round}: ${created} created, ${bookings} bookings, ${clients} clients`);
      }
    }

    expect(Object.keys(statuses).filter((status) => !['201', '409', '422'].includes(status)), JSON.stringify(statuses)).toEqual([]);
    expect(badRounds, JSON.stringify(statuses)).toEqual([]);
  });
});

// --- Access -------------------------------------------------------------------

describe('POST /api/bookings access', () => {
  it('is anonymous: no Authorization header is needed, and a bogus one changes nothing', async () => {
    const res = await post(validBody());
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']).toBeUndefined();

    const withHeader = await request(app)
      .post(BOOKINGS)
      .set('Authorization', 'Bearer not-a-token')
      .send(validBody({ startsAt: kigali(THURSDAY, '09:00'), email: 'b@example.com' }));
    expect(withHeader.status).toBe(201);
  });

  it('is 404 when the public API is not mounted', async () => {
    const res = await request(createApp()).post(BOOKINGS).send(validBody());

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'not_found' });
    await expect(counts()).resolves.toEqual(NOTHING);
  });

  it.each(['get', 'put', 'patch', 'delete'] as const)('answers 404 to %s: bookings cannot be listed or edited here', async (method) => {
    createdBooking(await post(validBody()));

    const res = await request(app)[method](BOOKINGS);

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('Aline');
  });
});

// --- Abuse caps (security review 2026-10-11, finding 2; marketplace spec T0.2) ---

describe('live holds per email address', () => {
  const book = (wallTime: string, email = 'aline@example.com', date = WEDNESDAY) =>
    request(app).post(BOOKINGS).send(validBody({ startsAt: kigali(date, wallTime), email, addonIds: [] }));

  it(`refuses a fourth live hold for one address with 429 too_many_holds, however it is typed`, async () => {
    for (const wallTime of ['09:00', '11:00', '13:00']) expect((await book(wallTime)).status).toBe(201);

    const fourth = await book('15:00', 'ALINE@example.com');

    expect([fourth.status, fourth.body]).toEqual([429, { error: 'too_many_holds' }]);
    expect(await raw.query("SELECT 1 FROM booking WHERE status = 'pending_payment'")).toHaveProperty('rowCount', 3);
  });

  it('lets another address book, and the same address again once a hold has lapsed', async () => {
    for (const wallTime of ['09:00', '11:00', '13:00']) expect((await book(wallTime)).status).toBe(201);

    expect((await book('15:00', 'someone.else@example.com')).status).toBe(201);
    await raw.query(
      "UPDATE booking SET status = 'expired' WHERE id = (SELECT id FROM booking WHERE contact_email = 'aline@example.com' ORDER BY starts_at LIMIT 1)",
    );
    expect((await book('09:00', 'aline@example.com', THURSDAY)).status).toBe(201);
  });
});

describe('request limits', () => {
  it('answers 429 rate_limited with a Retry-After past the per-IP limit, before any work', async () => {
    const limited = createApp({ publicApi: { prisma, now: () => NOW }, rateLimits: { bookingsPerIp: { limit: 2, windowMs: 60 * MINUTE_MS } } });
    const send = (wallTime: string) =>
      request(limited).post(BOOKINGS).send(validBody({ startsAt: kigali(WEDNESDAY, wallTime), email: `${wallTime.replace(':', '')}@example.com` }));

    expect((await send('09:00')).status).toBe(201);
    expect((await send('11:00')).status).toBe(201);
    const third = await send('13:00');

    expect([third.status, third.body]).toEqual([429, { error: 'rate_limited' }]);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(await raw.query('SELECT 1 FROM booking')).toHaveProperty('rowCount', 2);
  });

  it('counts per email address too, across different addresses from one IP', async () => {
    const limited = createApp({ publicApi: { prisma, now: () => NOW }, rateLimits: { bookingsPerEmail: { limit: 1, windowMs: 60 * MINUTE_MS } } });

    expect((await request(limited).post(BOOKINGS).send(validBody())).status).toBe(201);
    expect((await request(limited).post(BOOKINGS).send(validBody({ startsAt: kigali(WEDNESDAY, '11:00'), email: 'ALINE@example.com' }))).status).toBe(429);
    expect((await request(limited).post(BOOKINGS).send(validBody({ startsAt: kigali(WEDNESDAY, '11:00'), email: 'other@example.com' }))).status).toBe(201);
  });
});
