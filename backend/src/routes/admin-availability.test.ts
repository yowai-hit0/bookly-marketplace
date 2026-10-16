import type { Booking, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { issueAdminToken } from '../auth/token.js';
import { findAvailability } from '../availability/query.js';
import { createPrismaClient } from '../db/client.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';

/**
 * `/api/admin/working-hours` and `/api/admin/blocks` over HTTP, against real
 * PostgreSQL (plan.md Task 8; spec §3.3, §6.3, §6.4, P-03, P-15, P-16;
 * data-model_v2.md §5.3, §5.4, §8).
 *
 * Every edit is judged by what the public calendar then offers, read through
 * `findAvailability` -- the projection Task 12's public route returns -- rather
 * than by the rows alone: a row that saves but does not open or close the right
 * minutes is the defect this task exists to prevent.
 *
 * Validation follows one rule (routes/validation.ts): a malformed request is a
 * 400, a well-formed one breaking a rule is a 422 naming the fields.
 *
 * Kigali is UTC+2 with no DST. 2026-10-07 is a Wednesday, 2026-10-10 a Saturday.
 * The clock is fixed a week before every fixture date, so lead time never bites.
 */

let prisma: PrismaClient;
let raw: pg.Client;
/** Argon2id computed once; a bearer token is minted per test without spending it again. */
let passwordHash: string;
let token: string;
let app: Express;

const SECRET = 'admin-availability-test-secret-at-least-32-characters';
const WEB_ORIGIN = 'https://admin.bookly.example';
const NOW = new Date('2026-09-30T08:00:00Z');
const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';
const MALFORMED_IDS = [
  'not-a-uuid',
  '12345',
  '00000000-0000-4000-8000-00000000000g',
  '00000000000040008000000000000000',
];

const HOURS = '/api/admin/working-hours';
const BLOCKS = '/api/admin/blocks';

const MONDAY = '2026-10-05';
const TUESDAY = '2026-10-06';
const WEDNESDAY = '2026-10-07';
const THURSDAY = '2026-10-08';
const FRIDAY = '2026-10-09';
const SATURDAY = '2026-10-10';
const SUNDAY = '2026-10-11';
const NEXT_WEDNESDAY = '2026-10-14';
const NEXT_SATURDAY = '2026-10-17';

/** Every 30-minute start a 60-minute package fits into 09:00–17:00. */
const FULL_DAY = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00',
];

const KIGALI_OFFSET_MS = 2 * 60 * 60_000;

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
  passwordHash = await hashPassword('correct horse battery staple');
});

afterAll(async () => {
  // Leave no edited row behind for a suite that seeds instead of truncating.
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  // truncateAll empties `setting`, and findAvailability reads it. Schema
  // defaults: 0.400 / 120 / 30 / 30 / 90.
  await prisma.setting.create({ data: { id: 1 } });
  const admin = await prisma.adminUser.create({
    data: { email: 'photographer@bookly.example', passwordHash },
  });
  token = (await issueAdminToken(SECRET, admin, NOW)).token;
  app = createApp({
    corsOrigin: WEB_ORIGIN,
    admin: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => NOW },
  });
});

// --- Fixtures ---------------------------------------------------------------

type Method = 'get' | 'post' | 'put' | 'delete';

type WorkingHoursJson = {
  id: string;
  weekday: number | null;
  effectiveDate: string | null;
  opensMinute: number | null;
  closesMinute: number | null;
  isOpen: boolean;
  note: string | null;
};

type BlockJson = {
  id: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  reason: string | null;
};

type ConflictJson = {
  error: string;
  bookings: { id: string; reference: string; contactName: string; startsAt: string; endsAt: string }[];
};

/** `bearer: null` sends no Authorization header at all. */
function send(method: Method, path: string, body?: unknown, bearer: string | null = token): request.Test {
  const req = request(app)[method](path);
  if (bearer !== null) req.set('Authorization', `Bearer ${bearer}`);
  return body === undefined ? req : req.send(body as object);
}

/** A Kigali wall-clock time on `date`, as the UTC instant. */
function kigali(date: string, wallTime: string): Date {
  return new Date(`${date}T${wallTime}:00+02:00`);
}

/** The Kigali wall time of an ISO instant. */
function kigaliTime(iso: string): string {
  return new Date(Date.parse(iso) + KIGALI_OFFSET_MS).toISOString().slice(11, 16);
}

/** What the public calendar offers, as Kigali start times keyed by date. */
async function offered(from: string, to = from): Promise<Record<string, string[]>> {
  const days = await findAvailability(prisma, { from, to, packageDurationMinutes: 60, now: NOW });
  return Object.fromEntries(days.map((day) => [day.date, day.starts.map(kigaliTime)]));
}

/** The seeded weekly rule: Mon–Fri 09:00–17:00 (data-model_v2.md §13). */
async function seedWeekdayHours(): Promise<void> {
  await prisma.workingHours.createMany({
    data: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinute: 540, closesMinute: 1020 })),
  });
}

async function createHours(body: object): Promise<WorkingHoursJson> {
  const res = await send('post', HOURS, body);
  expect(res.status).toBe(201);
  return (res.body as { workingHours: WorkingHoursJson }).workingHours;
}

async function createBlock(body: object): Promise<BlockJson> {
  const res = await send('post', BLOCKS, body);
  expect(res.status).toBe(201);
  return (res.body as { block: BlockJson }).block;
}

function allDay(startDate: string, endDate = startDate, extra: object = {}): object {
  return { isAllDay: true, startDate, endDate, ...extra };
}

/** A same-day time range, sent with the +02:00 offset the admin UI would use. */
function timed(date: string, from: string, to: string, extra: object = {}): object {
  return {
    isAllDay: false,
    startsAt: `${date}T${from}:00+02:00`,
    endsAt: `${date}T${to}:00+02:00`,
    ...extra,
  };
}

function expectInvalidRequest(res: Response): void {
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: 'invalid_request' });
}

function expectValidationFailed(res: Response, fields: string[]): void {
  expect(res.status).toBe(422);
  expect(res.body).toEqual({ error: 'validation_failed', fields });
}

function expectNotFound(res: Response): void {
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: 'not_found' });
}

function expectUnauthenticated(res: Response): void {
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'unauthenticated' });
  expect(String(res.headers['www-authenticate'])).toMatch(/^Bearer realm="bookly-admin"/);
}

/** A block's stored range as epoch ms, read straight off the columns. */
async function storedBlockMs(id: string): Promise<{ startsAt: number; endsAt: number }> {
  const row = firstRow(
    await raw.query<{ starts_ms: string; ends_ms: string }>(
      `SELECT (extract(epoch from starts_at) * 1000)::bigint AS starts_ms,
              (extract(epoch from ends_at) * 1000)::bigint AS ends_ms
         FROM availability_block WHERE id = $1`,
      [id],
    ),
  );
  return { startsAt: Number(row.starts_ms), endsAt: Number(row.ends_ms) };
}

/** The error a raw statement raised, or undefined if it succeeded. */
async function pgErrorOf(run: () => Promise<unknown>): Promise<{ code?: string; constraint?: string } | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
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

type BookingFixture = {
  reference: string;
  date: string;
  from: string;
  to: string;
  bufferTo: string;
  status?: string;
  holdExpiresAt?: Date | null;
  contactName?: string;
  contactEmail?: string;
};

/** A booking row in whatever state the test needs, with every snapshot column filled. */
function insertBooking(ids: Catalogue, fixture: BookingFixture): Promise<Booking> {
  return prisma.booking.create({
    data: {
      reference: fixture.reference,
      clientId: ids.clientId,
      contactName: fixture.contactName ?? 'Aline Uwase',
      contactEmail: fixture.contactEmail ?? 'aline@example.com',
      contactPhone: '+250788000000',
      serviceId: ids.serviceId,
      packageId: ids.packageId,
      serviceNameSnapshot: 'Portrait',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 40_000,
      packageDurationMinutes: 60,
      packagePhotoCount: 20,
      locationText: 'Kigali Heights',
      consentAt: NOW,
      bookingFeeRate: '0.400',
      bookingFeeRwf: 16_000,
      status: fixture.status ?? 'confirmed',
      startsAt: kigali(fixture.date, fixture.from),
      endsAt: kigali(fixture.date, fixture.to),
      bufferEndsAt: kigali(fixture.date, fixture.bufferTo),
      holdExpiresAt: fixture.holdExpiresAt ?? null,
    },
  });
}

function reload(booking: Booking): Promise<Booking> {
  return prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
}

// --- Auth -------------------------------------------------------------------------

describe('working-hours and blocks routes without a valid token', () => {
  const ROUTES: [Method, string][] = [
    ['get', HOURS],
    ['post', HOURS],
    ['put', `${HOURS}/${NONEXISTENT_ID}`],
    ['delete', `${HOURS}/${NONEXISTENT_ID}`],
    ['get', BLOCKS],
    ['post', BLOCKS],
    ['put', `${BLOCKS}/${NONEXISTENT_ID}`],
    ['delete', `${BLOCKS}/${NONEXISTENT_ID}`],
  ];

  it.each(ROUTES)('%s %s answers 401 with no token', async (method, path) => {
    expectUnauthenticated(await send(method, path, { weekday: 6, isOpen: false }, null));
  });

  it.each(ROUTES)('%s %s answers 401 with a garbage token', async (method, path) => {
    const res = await send(method, path, { weekday: 6, isOpen: false }, 'not.a.token');
    expectUnauthenticated(res);
    expect(String(res.headers['www-authenticate'])).toContain('error="invalid_token"');
  });

  it.each([null, 'garbage-token'])('runs no handler for writes with bearer %j', async (bearer) => {
    const hours = await prisma.workingHours.create({
      data: { weekday: 6, opensMinute: 540, closesMinute: 1020 },
    });
    const block = await prisma.availabilityBlock.create({
      data: { startsAt: kigali(WEDNESDAY, '14:00'), endsAt: kigali(WEDNESDAY, '16:00') },
    });
    const before = [await prisma.workingHours.findMany(), await prisma.availabilityBlock.findMany()];

    const statuses = [
      (await send('post', HOURS, { weekday: 0, opensMinute: 540, closesMinute: 1020 }, bearer)).status,
      (await send('put', `${HOURS}/${hours.id}`, { weekday: 0, isOpen: false }, bearer)).status,
      (await send('delete', `${HOURS}/${hours.id}`, undefined, bearer)).status,
      (await send('post', BLOCKS, allDay(THURSDAY), bearer)).status,
      (await send('put', `${BLOCKS}/${block.id}`, allDay(THURSDAY), bearer)).status,
      (await send('delete', `${BLOCKS}/${block.id}`, undefined, bearer)).status,
    ];

    expect(statuses).toEqual(Array<number>(6).fill(401));
    expect([await prisma.workingHours.findMany(), await prisma.availabilityBlock.findMany()]).toEqual(before);
  });
});

// --- Working hours: create --------------------------------------------------------

describe('POST /api/admin/working-hours', () => {
  it.each<[string, Record<string, unknown>]>([
    ['a Saturday rule, 09:00–17:00', { weekday: 6, opensMinute: 540, closesMinute: 1020 }],
    ['Sunday, the lowest weekday', { weekday: 0, opensMinute: 540, closesMinute: 1020 }],
    ['the whole day, minute 0 to 1440', { weekday: 1, opensMinute: 0, closesMinute: 1440 }],
    ['a one-minute window', { weekday: 2, opensMinute: 540, closesMinute: 541 }],
    ['a closed weekday with no minutes', { weekday: 3, isOpen: false }],
    ['a closed date with no minutes', { effectiveDate: WEDNESDAY, isOpen: false }],
    ['explicitly null minutes on a closed date', { effectiveDate: WEDNESDAY, isOpen: false, opensMinute: null, closesMinute: null }],
    ['an opened date with its own hours and a note', { effectiveDate: SATURDAY, opensMinute: 600, closesMinute: 840, note: 'Mukamana wedding' }],
    ['an explicit null note', { weekday: 4, opensMinute: 540, closesMinute: 1020, note: null }],
    ['a real leap day', { effectiveDate: '2028-02-29', isOpen: false }],
  ])('accepts %s with 201 and stores exactly what it returns', async (_label, body) => {
    const res = await send('post', HOURS, body);

    expect(res.status).toBe(201);
    const expected = {
      id: expect.any(String),
      weekday: body.weekday ?? null,
      effectiveDate: body.effectiveDate ?? null,
      opensMinute: body.opensMinute ?? null,
      closesMinute: body.closesMinute ?? null,
      isOpen: body.isOpen ?? true,
      note: body.note ?? null,
    };
    expect(res.body).toEqual({ workingHours: expected });
    const list = await send('get', HOURS);
    expect(list.body).toEqual({ workingHours: [(res.body as { workingHours: WorkingHoursJson }).workingHours] });
  });

  it('stores an effective date as that calendar day, not a timezone-shifted one', async () => {
    const created = await createHours({ effectiveDate: SATURDAY, opensMinute: 540, closesMinute: 1020 });

    const row = firstRow(
      await raw.query<{ day: string }>(`SELECT effective_date::text AS day FROM working_hours WHERE id = $1`, [
        created.id,
      ]),
    );
    expect(row.day).toBe(SATURDAY);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['closing before opening (1020/540)', { weekday: 1, opensMinute: 1020, closesMinute: 540 }, ['closesMinute']],
    ['closing equal to opening', { weekday: 1, opensMinute: 540, closesMinute: 540 }, ['closesMinute']],
    ['a closing minute past 1440', { weekday: 1, opensMinute: 540, closesMinute: 1441 }, ['closesMinute']],
    ['both minutes past 1440', { weekday: 1, opensMinute: 1441, closesMinute: 1500 }, ['opensMinute', 'closesMinute']],
    ['a negative opening minute', { weekday: 1, opensMinute: -1, closesMinute: 540 }, ['opensMinute']],
    ['an open weekday with no minutes', { weekday: 1 }, ['closesMinute']],
    ['an open weekday with only an opening minute', { weekday: 1, opensMinute: 540 }, ['closesMinute']],
    ['an open weekday with null minutes', { weekday: 1, isOpen: true, opensMinute: null, closesMinute: null }, ['closesMinute']],
    ['an open date with no minutes', { effectiveDate: SATURDAY }, ['closesMinute']],
    ['a dated override closing before it opens', { effectiveDate: SATURDAY, opensMinute: 1020, closesMinute: 540 }, ['closesMinute']],
    ['weekday 7', { weekday: 7, opensMinute: 540, closesMinute: 1020 }, ['weekday']],
    ['weekday -1', { weekday: -1, opensMinute: 540, closesMinute: 1020 }, ['weekday']],
    ['a 501-character note', { weekday: 1, isOpen: false, note: 'n'.repeat(501) }, ['note']],
    ['a year below 100', { effectiveDate: '0050-01-01', isOpen: false }, ['effectiveDate']],
  ])('refuses %s with 422 naming the fields, storing nothing', async (_label, body, fields) => {
    expectValidationFailed(await send('post', HOURS, body), fields);
    await expect(prisma.workingHours.count()).resolves.toBe(0);
  });

  it.each<[string, unknown]>([
    ['both weekday and effectiveDate', { weekday: 6, effectiveDate: SATURDAY, opensMinute: 540, closesMinute: 1020 }],
    ['both keys on a closed row', { weekday: 6, effectiveDate: SATURDAY, isOpen: false }],
    ['neither weekday nor effectiveDate', { opensMinute: 540, closesMinute: 1020 }],
    ['a null weekday', { weekday: null, opensMinute: 540, closesMinute: 1020 }],
    ['a null effectiveDate', { effectiveDate: null, isOpen: false }],
    ['a fractional minute', { weekday: 1, opensMinute: 540.5, closesMinute: 1020 }],
    ['a string minute', { weekday: 1, opensMinute: '540', closesMinute: 1020 }],
    ['a string weekday', { weekday: '6', opensMinute: 540, closesMinute: 1020 }],
    ['a fractional weekday', { weekday: 1.5, opensMinute: 540, closesMinute: 1020 }],
    ['a null isOpen', { weekday: 1, isOpen: null, opensMinute: 540, closesMinute: 1020 }],
    ['a string isOpen', { weekday: 1, isOpen: 'false' }],
    ['a numeric note', { weekday: 1, isOpen: false, note: 42 }],
    ['an unknown key', { weekday: 1, opensMinute: 540, closesMinute: 1020, timezone: 'UTC' }],
    ['snake_case keys', { weekday: 1, opens_minute: 540, closes_minute: 1020 }],
    ['an impossible date', { effectiveDate: '2026-02-30', isOpen: false }],
    ['a non-ISO date', { effectiveDate: '10/10/2026', isOpen: false }],
    ['a datetime where a date belongs', { effectiveDate: '2026-10-10T00:00:00Z', isOpen: false }],
    ['an empty object', {}],
    ['a JSON array', [{ weekday: 1, isOpen: false }]],
  ])('refuses %s with 400, storing nothing', async (_label, body) => {
    expectInvalidRequest(await send('post', HOURS, body));
    await expect(prisma.workingHours.count()).resolves.toBe(0);
  });

  it('answers malformed JSON with 400', async () => {
    const res = await send('post', HOURS).set('Content-Type', 'application/json').send('{"weekday": 6,');
    expectInvalidRequest(res);
  });

  it('refuses a second rule for the same weekday with 409, keeping the first', async () => {
    const first = await createHours({ weekday: 6, opensMinute: 540, closesMinute: 1020 });

    const res = await send('post', HOURS, { weekday: 6, isOpen: false });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'working_hours_exists' });
    expect((await send('get', HOURS)).body).toEqual({ workingHours: [first] });
  });

  it('refuses a second override for the same date with 409, keeping the first', async () => {
    const first = await createHours({ effectiveDate: SATURDAY, opensMinute: 540, closesMinute: 1020 });

    const res = await send('post', HOURS, { effectiveDate: SATURDAY, isOpen: false });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'working_hours_exists' });
    expect((await send('get', HOURS)).body).toEqual({ workingHours: [first] });
  });

  it('lets a weekday rule and an override on a date of that weekday coexist', async () => {
    await createHours({ weekday: 6, opensMinute: 540, closesMinute: 1020 });
    await createHours({ effectiveDate: SATURDAY, isOpen: false });

    await expect(prisma.workingHours.count()).resolves.toBe(2);
  });
});

// --- Working hours: the CHECK behind the schema -------------------------------------

describe('weekday XOR effective date, in the schema and in the database', () => {
  it.each<[string, object, string]>([
    [
      'both',
      { weekday: 6, effectiveDate: SATURDAY, opensMinute: 540, closesMinute: 1020 },
      `INSERT INTO working_hours (weekday, effective_date, opens_minute, closes_minute)
       VALUES (6, '2026-10-10', 540, 1020)`,
    ],
    [
      'neither',
      { opensMinute: 540, closesMinute: 1020 },
      `INSERT INTO working_hours (opens_minute, closes_minute) VALUES (540, 1020)`,
    ],
  ])('refuses %s with 400 over HTTP, and with 23514 when the schema is bypassed', async (_label, body, sql) => {
    expectInvalidRequest(await send('post', HOURS, body));

    const error = await pgErrorOf(() => raw.query(sql));

    expect(error).toMatchObject({ code: '23514', constraint: 'working_hours_weekday_xor_date' });
    await expect(prisma.workingHours.count()).resolves.toBe(0);
  });
});

// --- Working hours: list, replace, delete ----------------------------------------------

describe('GET /api/admin/working-hours', () => {
  it('answers an empty list when there are no rows', async () => {
    const res = await send('get', HOURS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workingHours: [] });
  });

  it('lists weekday rules by weekday, then dated overrides by date', async () => {
    const override = await createHours({ effectiveDate: NEXT_SATURDAY, isOpen: false });
    const earlierOverride = await createHours({ effectiveDate: SATURDAY, opensMinute: 600, closesMinute: 840 });
    const friday = await createHours({ weekday: 5, opensMinute: 540, closesMinute: 1020 });
    const monday = await createHours({ weekday: 1, opensMinute: 540, closesMinute: 1020, note: 'Monday' });

    const res = await send('get', HOURS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workingHours: [monday, friday, earlierOverride, override] });
  });
});

describe('PUT /api/admin/working-hours/:id', () => {
  it('replaces the whole row, so an omitted optional field returns to its default', async () => {
    const created = await createHours({ weekday: 1, opensMinute: 540, closesMinute: 1020, note: 'seeded' });

    const res = await send('put', `${HOURS}/${created.id}`, { weekday: 1, opensMinute: 600, closesMinute: 900 });

    const replaced = { ...created, opensMinute: 600, closesMinute: 900, note: null };
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workingHours: replaced });
    expect((await send('get', HOURS)).body).toEqual({ workingHours: [replaced] });
  });

  it('turns a weekday rule into a dated override, nulling the weekday', async () => {
    const created = await createHours({ weekday: 6, opensMinute: 540, closesMinute: 1020 });

    const res = await send('put', `${HOURS}/${created.id}`, { effectiveDate: SATURDAY, isOpen: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workingHours: {
        id: created.id,
        weekday: null,
        effectiveDate: SATURDAY,
        opensMinute: null,
        closesMinute: null,
        isOpen: false,
        note: null,
      },
    });
    const row = await prisma.workingHours.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.weekday).toBeNull();
    expect(row.effectiveDate?.toISOString()).toBe(`${SATURDAY}T00:00:00.000Z`);
  });

  it('turns a dated override back into a weekday rule, nulling the date', async () => {
    const created = await createHours({ effectiveDate: SATURDAY, isOpen: false });

    const res = await send('put', `${HOURS}/${created.id}`, { weekday: 6, opensMinute: 540, closesMinute: 1020 });

    expect(res.status).toBe(200);
    const row = await prisma.workingHours.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ weekday: 6, effectiveDate: null, opensMinute: 540, closesMinute: 1020 });
  });

  it('accepts a row being saved onto its own key', async () => {
    const created = await createHours({ weekday: 6, opensMinute: 540, closesMinute: 1020 });

    const res = await send('put', `${HOURS}/${created.id}`, { weekday: 6, isOpen: false });

    expect(res.status).toBe(200);
  });

  it.each<[string, object, object, object]>([
    [
      'onto a weekday another rule holds',
      { weekday: 6, opensMinute: 540, closesMinute: 1020 },
      { weekday: 0, opensMinute: 540, closesMinute: 1020 },
      { weekday: 6, isOpen: false },
    ],
    [
      'onto a date another override holds',
      { effectiveDate: SATURDAY, isOpen: false },
      { effectiveDate: NEXT_SATURDAY, isOpen: false },
      { effectiveDate: SATURDAY, opensMinute: 540, closesMinute: 1020 },
    ],
    [
      'a weekday rule onto a date an override holds',
      { effectiveDate: SATURDAY, isOpen: false },
      { weekday: 6, opensMinute: 540, closesMinute: 1020 },
      { effectiveDate: SATURDAY, opensMinute: 540, closesMinute: 1020 },
    ],
  ])('answers 409 for moving a row %s, changing neither row', async (_label, holderBody, movedBody, update) => {
    await createHours(holderBody);
    const moved = await createHours(movedBody);
    const before = await prisma.workingHours.findMany({ orderBy: { id: 'asc' } });

    const res = await send('put', `${HOURS}/${moved.id}`, update);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'working_hours_exists' });
    await expect(prisma.workingHours.findMany({ orderBy: { id: 'asc' } })).resolves.toEqual(before);
  });

  it('answers 404 for an id that names no row', async () => {
    expectNotFound(await send('put', `${HOURS}/${NONEXISTENT_ID}`, { weekday: 6, isOpen: false }));
    await expect(prisma.workingHours.count()).resolves.toBe(0);
  });

  it.each(MALFORMED_IDS)('answers 404 for the malformed id %j', async (id) => {
    expectNotFound(await send('put', `${HOURS}/${id}`, { weekday: 6, isOpen: false }));
  });

  it('validates the body with the same rules as POST, leaving the row as it was', async () => {
    const created = await createHours({ weekday: 1, opensMinute: 540, closesMinute: 1020 });
    const path = `${HOURS}/${created.id}`;

    expectValidationFailed(await send('put', path, { weekday: 1, opensMinute: 1020, closesMinute: 540 }), [
      'closesMinute',
    ]);
    expectInvalidRequest(await send('put', path, { weekday: 1, effectiveDate: MONDAY, isOpen: false }));
    expectInvalidRequest(await send('put', path, { weekday: 1, opensMinute: '540', closesMinute: 1020 }));

    expect((await send('get', HOURS)).body).toEqual({ workingHours: [created] });
  });
});

describe('DELETE /api/admin/working-hours/:id', () => {
  it('deletes the row with 204, and a second delete is a 404', async () => {
    const created = await createHours({ weekday: 6, opensMinute: 540, closesMinute: 1020 });

    const res = await send('delete', `${HOURS}/${created.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    await expect(prisma.workingHours.count()).resolves.toBe(0);
    expectNotFound(await send('delete', `${HOURS}/${created.id}`));
  });

  it('answers 404 for an id that names no row, deleting nothing', async () => {
    await createHours({ weekday: 6, opensMinute: 540, closesMinute: 1020 });

    expectNotFound(await send('delete', `${HOURS}/${NONEXISTENT_ID}`));
    await expect(prisma.workingHours.count()).resolves.toBe(1);
  });

  it.each(MALFORMED_IDS)('answers 404 for the malformed id %j', async (id) => {
    expectNotFound(await send('delete', `${HOURS}/${id}`));
  });

  it.each([NONEXISTENT_ID, ...MALFORMED_IDS])('has no GET by id: %j is a 404', async (id) => {
    expectNotFound(await send('get', `${HOURS}/${id}`));
  });
});

// --- Working hours as the public calendar sees them -----------------------------------------

describe('working hours in the public availability', () => {
  it('opens every Saturday once a Saturday rule is added, and closes them again when it is deleted', async () => {
    await seedWeekdayHours();
    const before = await offered(SATURDAY, NEXT_SATURDAY);
    expect([before[SATURDAY], before[NEXT_SATURDAY]]).toEqual([[], []]);

    const rule = await createHours({ weekday: 6, opensMinute: 540, closesMinute: 1020 });

    const open = await offered(SATURDAY, NEXT_SATURDAY);
    expect(open[SATURDAY]).toEqual(FULL_DAY);
    expect(open[NEXT_SATURDAY]).toEqual(FULL_DAY);
    expect(open[SUNDAY]).toEqual([]);

    expect((await send('delete', `${HOURS}/${rule.id}`)).status).toBe(204);

    const closed = await offered(SATURDAY, NEXT_SATURDAY);
    expect(closed[SATURDAY]).toEqual([]);
    expect(closed[NEXT_SATURDAY]).toEqual([]);
    expect(closed[NEXT_WEDNESDAY]).toEqual(FULL_DAY);
  });

  it('opens only the one Saturday an open override names (R-4)', async () => {
    await seedWeekdayHours();

    await createHours({ effectiveDate: SATURDAY, isOpen: true, opensMinute: 540, closesMinute: 1020 });

    const days = await offered(SATURDAY, NEXT_SATURDAY);
    expect(days[SATURDAY]).toEqual(FULL_DAY);
    expect(days[NEXT_SATURDAY]).toEqual([]);
  });

  it('gives an opened date its own hours, and a PUT changes them', async () => {
    const override = await createHours({ effectiveDate: SATURDAY, opensMinute: 540, closesMinute: 1020 });

    await send('put', `${HOURS}/${override.id}`, { effectiveDate: SATURDAY, opensMinute: 600, closesMinute: 840 });

    expect((await offered(SATURDAY))[SATURDAY]).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00']);
  });

  it('closes only the one Wednesday a closed override names, and deleting it restores that day', async () => {
    await seedWeekdayHours();

    const override = await createHours({ effectiveDate: WEDNESDAY, isOpen: false });

    const closed = await offered(WEDNESDAY, NEXT_WEDNESDAY);
    expect(closed[WEDNESDAY]).toEqual([]);
    expect(closed[THURSDAY]).toEqual(FULL_DAY);
    expect(closed[NEXT_WEDNESDAY]).toEqual(FULL_DAY);

    expect((await send('delete', `${HOURS}/${override.id}`)).status).toBe(204);

    expect((await offered(WEDNESDAY))[WEDNESDAY]).toEqual(FULL_DAY);
  });
});

// --- Blocks: create, list, replace, delete ------------------------------------------------

describe('POST /api/admin/blocks', () => {
  it('stores a full-day block from Kigali midnight to the next Kigali midnight', async () => {
    const block = await createBlock(allDay(WEDNESDAY));

    const expected = {
      startsAt: '2026-10-06T22:00:00.000Z',
      endsAt: '2026-10-07T22:00:00.000Z',
    };
    expect(block).toEqual({ id: expect.any(String), ...expected, isAllDay: true, reason: null });
    await expect(storedBlockMs(block.id)).resolves.toEqual({
      startsAt: Date.parse(expected.startsAt),
      endsAt: Date.parse(expected.endsAt),
    });
  });

  it('stores an inclusive range of days as one row ending at midnight after the last day', async () => {
    const block = await createBlock(allDay(TUESDAY, THURSDAY, { reason: 'Travelling to Musanze' }));

    expect(block).toMatchObject({
      startsAt: '2026-10-05T22:00:00.000Z',
      endsAt: '2026-10-08T22:00:00.000Z',
      isAllDay: true,
      reason: 'Travelling to Musanze',
    });
    await expect(prisma.availabilityBlock.count()).resolves.toBe(1);
  });

  it.each<[string, string, string]>([
    ['a +02:00 offset', '2026-10-07T14:00:00+02:00', '2026-10-07T16:00:00+02:00'],
    ['UTC Z', '2026-10-07T12:00:00Z', '2026-10-07T14:00:00Z'],
    ['fractional seconds and a mixed offset', '2026-10-07T13:00:00.000+01:00', '2026-10-07T14:00:00.000Z'],
  ])('stores a time-range block given with %s as the same instants', async (_label, startsAt, endsAt) => {
    const block = await createBlock({ isAllDay: false, startsAt, endsAt });

    expect(block).toEqual({
      id: expect.any(String),
      startsAt: '2026-10-07T12:00:00.000Z',
      endsAt: '2026-10-07T14:00:00.000Z',
      isAllDay: false,
      reason: null,
    });
    await expect(storedBlockMs(block.id)).resolves.toEqual({
      startsAt: Date.parse('2026-10-07T12:00:00Z'),
      endsAt: Date.parse('2026-10-07T14:00:00Z'),
    });
  });

  it('does not store `confirm`, which only answers the warning', async () => {
    const block = await createBlock(allDay(WEDNESDAY, WEDNESDAY, { confirm: true }));

    expect(Object.keys(block).sort()).toEqual(['endsAt', 'id', 'isAllDay', 'reason', 'startsAt']);
  });

  it.each<[string, object, string[]]>([
    ['an end date before the start date', allDay(THURSDAY, WEDNESDAY), ['endDate']],
    ['an end equal to the start', timed(WEDNESDAY, '14:00', '14:00'), ['endsAt']],
    ['an end before the start', timed(WEDNESDAY, '16:00', '14:00'), ['endsAt']],
    [
      'the same instant written in two offsets',
      { isAllDay: false, startsAt: '2026-10-07T14:00:00+02:00', endsAt: '2026-10-07T12:00:00Z' },
      ['endsAt'],
    ],
    ['a 501-character reason', allDay(WEDNESDAY, WEDNESDAY, { reason: 'r'.repeat(501) }), ['reason']],
    // Date.UTC reads years 0-99 as 1900-1999: this was stored as a 1949 block.
    ['a year below 100', allDay('0050-01-01', '0050-01-02'), ['startDate', 'endDate']],
  ])('refuses %s with 422 naming the fields, storing nothing', async (_label, body, fields) => {
    expectValidationFailed(await send('post', BLOCKS, body), fields);
    await expect(prisma.availabilityBlock.count()).resolves.toBe(0);
  });

  it.each<[string, unknown]>([
    ['no isAllDay', { startDate: WEDNESDAY, endDate: WEDNESDAY }],
    ['a string isAllDay', { isAllDay: 'true', startDate: WEDNESDAY, endDate: WEDNESDAY }],
    ['a null isAllDay', { isAllDay: null, startDate: WEDNESDAY, endDate: WEDNESDAY }],
    ['an all-day block given datetimes', { isAllDay: true, startsAt: '2026-10-07T00:00:00+02:00', endsAt: '2026-10-08T00:00:00+02:00' }],
    ['an all-day block with an extra startsAt', allDay(WEDNESDAY, WEDNESDAY, { startsAt: '2026-10-07T00:00:00+02:00' })],
    ['a time-range block given dates', { isAllDay: false, startDate: WEDNESDAY, endDate: WEDNESDAY }],
    ['a datetime without an offset', { isAllDay: false, startsAt: '2026-10-07T14:00:00', endsAt: '2026-10-07T16:00:00' }],
    ['a date where a datetime belongs', { isAllDay: false, startsAt: WEDNESDAY, endsAt: THURSDAY }],
    ['a datetime where a date belongs', allDay('2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z')],
    ['an impossible date', allDay('2026-02-30')],
    ['a non-ISO date', allDay('07/10/2026')],
    ['a missing end date', { isAllDay: true, startDate: WEDNESDAY }],
    ['a numeric reason', allDay(WEDNESDAY, WEDNESDAY, { reason: 42 })],
    ['a string confirm', allDay(WEDNESDAY, WEDNESDAY, { confirm: 'yes' })],
    ['an unknown key', allDay(WEDNESDAY, WEDNESDAY, { private: true })],
    ['an empty object', {}],
    ['a JSON array', [allDay(WEDNESDAY)]],
  ])('refuses %s with 400, storing nothing', async (_label, body) => {
    expectInvalidRequest(await send('post', BLOCKS, body));
    await expect(prisma.availabilityBlock.count()).resolves.toBe(0);
  });

  it('answers malformed JSON with 400', async () => {
    const res = await send('post', BLOCKS).set('Content-Type', 'application/json').send('{"isAllDay": true, ');
    expectInvalidRequest(res);
  });
});

describe('GET /api/admin/blocks', () => {
  it('lists every block by start, reason included -- the admin may see it (P-03)', async () => {
    const later = await createBlock(allDay(FRIDAY, FRIDAY, { reason: 'Studio maintenance' }));
    const earlier = await createBlock(timed(WEDNESDAY, '14:00', '16:00', { reason: 'Dentist' }));

    const res = await send('get', BLOCKS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ blocks: [earlier, later] });
  });
});

describe('PUT /api/admin/blocks/:id', () => {
  it('replaces the range, the all-day flag and the reason', async () => {
    const created = await createBlock(allDay(WEDNESDAY, WEDNESDAY, { reason: 'first' }));

    const res = await send('put', `${BLOCKS}/${created.id}`, timed(THURSDAY, '14:00', '16:00'));

    const replaced = {
      id: created.id,
      startsAt: '2026-10-08T12:00:00.000Z',
      endsAt: '2026-10-08T14:00:00.000Z',
      isAllDay: false,
      reason: null,
    };
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ block: replaced });
    expect((await send('get', BLOCKS)).body).toEqual({ blocks: [replaced] });
  });

  it('answers 404 for an id that names no row', async () => {
    expectNotFound(await send('put', `${BLOCKS}/${NONEXISTENT_ID}`, allDay(WEDNESDAY)));
    await expect(prisma.availabilityBlock.count()).resolves.toBe(0);
  });

  it.each(MALFORMED_IDS)('answers 404 for the malformed id %j', async (id) => {
    expectNotFound(await send('put', `${BLOCKS}/${id}`, allDay(WEDNESDAY)));
  });

  it('validates the body, leaving the block as it was', async () => {
    const created = await createBlock(allDay(WEDNESDAY));
    const path = `${BLOCKS}/${created.id}`;

    expectValidationFailed(await send('put', path, allDay(THURSDAY, WEDNESDAY)), ['endDate']);
    expectInvalidRequest(await send('put', path, { isAllDay: false, startsAt: '2026-10-07T14:00:00', endsAt: '2026-10-07T16:00:00' }));

    expect((await send('get', BLOCKS)).body).toEqual({ blocks: [created] });
  });
});

describe('DELETE /api/admin/blocks/:id', () => {
  it('deletes the block with 204, returning its time to the calendar', async () => {
    await seedWeekdayHours();
    const block = await createBlock(allDay(WEDNESDAY));
    expect((await offered(WEDNESDAY))[WEDNESDAY]).toEqual([]);

    const res = await send('delete', `${BLOCKS}/${block.id}`);

    expect(res.status).toBe(204);
    expect((await offered(WEDNESDAY))[WEDNESDAY]).toEqual(FULL_DAY);
    expectNotFound(await send('delete', `${BLOCKS}/${block.id}`));
  });

  it('answers 404 for an id that names no row, deleting nothing', async () => {
    await createBlock(allDay(WEDNESDAY));

    expectNotFound(await send('delete', `${BLOCKS}/${NONEXISTENT_ID}`));
    await expect(prisma.availabilityBlock.count()).resolves.toBe(1);
  });

  it.each(MALFORMED_IDS)('answers 404 for the malformed id %j', async (id) => {
    expectNotFound(await send('delete', `${BLOCKS}/${id}`));
  });

  it.each([NONEXISTENT_ID, ...MALFORMED_IDS])('has no GET by id: %j is a 404', async (id) => {
    expectNotFound(await send('get', `${BLOCKS}/${id}`));
  });
});

// --- Blocks as the public calendar sees them ----------------------------------------------

describe('blocks in the public availability', () => {
  it('removes exactly the expected starts for a full-day block and a 14:00–16:00 block', async () => {
    await seedWeekdayHours();

    await createBlock(allDay(THURSDAY));
    await createBlock(timed(WEDNESDAY, '14:00', '16:00'));

    expect(await offered(TUESDAY, FRIDAY)).toEqual({
      [TUESDAY]: FULL_DAY,
      // A 60-minute session starting 13:30 would run into the block, and 16:00
      // is the first start once it ends.
      [WEDNESDAY]: ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '16:00'],
      [THURSDAY]: [],
      [FRIDAY]: FULL_DAY,
    });
  });

  it('removes every day of a multi-day block, and not the day after', async () => {
    await seedWeekdayHours();

    await createBlock(allDay(TUESDAY, THURSDAY));

    expect(await offered(MONDAY, FRIDAY)).toEqual({
      [MONDAY]: FULL_DAY,
      [TUESDAY]: [],
      [WEDNESDAY]: [],
      [THURSDAY]: [],
      [FRIDAY]: FULL_DAY,
    });
  });

  it('bounds a full-day block by Kigali midnight, not UTC midnight', async () => {
    // Round-the-clock hours either side make the boundary visible: 23:00 the
    // night before ends exactly as the block begins, and 00:00 the morning after
    // starts exactly as it ends. A UTC-midnight block would be two hours late
    // on both edges.
    for (const date of [TUESDAY, WEDNESDAY, THURSDAY]) {
      await createHours({ effectiveDate: date, opensMinute: 0, closesMinute: 1440 });
    }

    await createBlock(allDay(WEDNESDAY));

    const days = await offered(TUESDAY, THURSDAY);
    expect(days[TUESDAY]?.at(-1)).toBe('23:00');
    expect(days[WEDNESDAY]).toEqual([]);
    expect(days[THURSDAY]?.[0]).toBe('00:00');
  });

  it('moves the gap when a block is edited', async () => {
    await seedWeekdayHours();
    const block = await createBlock(allDay(WEDNESDAY));

    await send('put', `${BLOCKS}/${block.id}`, allDay(THURSDAY));

    const days = await offered(WEDNESDAY, THURSDAY);
    expect(days).toEqual({ [WEDNESDAY]: FULL_DAY, [THURSDAY]: [] });
  });
});

// --- Spec §6.4: a block over a confirmed booking ------------------------------------------

describe('a block overlapping a confirmed booking (spec §6.4)', () => {
  /** Wednesday 09:00–10:00 Kigali, reserving through its buffer to 10:30. */
  const NINE: Omit<BookingFixture, 'reference'> = { date: WEDNESDAY, from: '09:00', to: '10:00', bufferTo: '10:30' };

  function conflictOf(booking: Booking): ConflictJson['bookings'][number] {
    return {
      id: booking.id,
      reference: booking.reference,
      contactName: booking.contactName,
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
    };
  }

  it('answers 409 naming the booking and saves nothing; confirm: true saves and the booking stands', async () => {
    const ids = await insertCatalogue();
    const booking = await insertBooking(ids, { reference: 'BKY-2610-00001', ...NINE, contactName: 'Grace Mukamana' });

    const warned = await send('post', BLOCKS, timed(WEDNESDAY, '09:30', '11:00', { reason: 'Clinic' }));

    expect(warned.status).toBe(409);
    expect(warned.body).toEqual({
      error: 'block_overlaps_confirmed_bookings',
      bookings: [
        {
          id: booking.id,
          reference: 'BKY-2610-00001',
          contactName: 'Grace Mukamana',
          startsAt: '2026-10-07T07:00:00.000Z',
          endsAt: '2026-10-07T08:00:00.000Z',
        },
      ],
    });
    await expect(prisma.availabilityBlock.count()).resolves.toBe(0);
    await expect(reload(booking)).resolves.toEqual(booking);

    const confirmed = await send('post', BLOCKS, timed(WEDNESDAY, '09:30', '11:00', { reason: 'Clinic', confirm: true }));

    expect(confirmed.status).toBe(201);
    await expect(prisma.availabilityBlock.count()).resolves.toBe(1);
    const after = await reload(booking);
    expect(after).toEqual(booking);
    expect(after.status).toBe('confirmed');
  });

  it('treats confirm: false exactly like no confirm', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, { reference: 'BKY-2610-00001', ...NINE });

    const res = await send('post', BLOCKS, timed(WEDNESDAY, '09:00', '10:00', { confirm: false }));

    expect(res.status).toBe(409);
    await expect(prisma.availabilityBlock.count()).resolves.toBe(0);
  });

  it.each<[string, string, string]>([
    ['covers the session exactly', '09:00', '10:00'],
    ['overlaps the session start by a minute', '08:00', '09:01'],
    ['overlaps the session end by a minute', '09:59', '11:00'],
    ['sits inside the session', '09:15', '09:45'],
    ['contains the session', '08:00', '12:00'],
  ])('warns for a block that %s', async (_label, from, to) => {
    const ids = await insertCatalogue();
    const booking = await insertBooking(ids, { reference: 'BKY-2610-00001', ...NINE });

    const res = await send('post', BLOCKS, timed(WEDNESDAY, from, to));

    expect(res.status).toBe(409);
    expect((res.body as ConflictJson).bookings).toEqual([conflictOf(booking)]);
  });

  it.each<[string, string, string]>([
    ['ends exactly when the session starts', '08:00', '09:00'],
    ['starts exactly when the session ends', '10:00', '11:00'],
    ['covers only the trailing buffer', '10:00', '10:30'],
    ['starts inside the buffer', '10:15', '12:00'],
  ])('does not warn for a block that %s', async (_label, from, to) => {
    const ids = await insertCatalogue();
    await insertBooking(ids, { reference: 'BKY-2610-00001', ...NINE });

    const res = await send('post', BLOCKS, timed(WEDNESDAY, from, to));

    expect(res.status).toBe(201);
  });

  it('warns for a full-day block on the booking date, not for one on the day before', async () => {
    const ids = await insertCatalogue();
    const booking = await insertBooking(ids, { reference: 'BKY-2610-00001', ...NINE });

    expect((await send('post', BLOCKS, allDay(TUESDAY))).status).toBe(201);

    const res = await send('post', BLOCKS, allDay(WEDNESDAY));
    expect(res.status).toBe(409);
    expect((res.body as ConflictJson).bookings).toEqual([conflictOf(booking)]);
  });

  it('names every confirmed booking the block covers, in start order, and no other', async () => {
    const ids = await insertCatalogue();
    const afternoon = await insertBooking(ids, {
      reference: 'BKY-2610-00002', date: WEDNESDAY, from: '14:00', to: '15:00', bufferTo: '15:30', contactName: 'Second Client',
    });
    const morning = await insertBooking(ids, { reference: 'BKY-2610-00001', ...NINE, contactName: 'First Client' });
    await insertBooking(ids, { reference: 'BKY-2610-00003', date: THURSDAY, from: '09:00', to: '10:00', bufferTo: '10:30' });
    await insertBooking(ids, {
      reference: 'BKY-2610-00004', date: WEDNESDAY, from: '12:00', to: '13:00', bufferTo: '13:30', status: 'cancelled_by_admin',
    });

    const res = await send('post', BLOCKS, allDay(WEDNESDAY));

    expect(res.status).toBe(409);
    expect((res.body as ConflictJson).bookings).toEqual([conflictOf(morning), conflictOf(afternoon)]);
  });

  it.each<[string, Date | null]>([
    ['pending_payment', new Date(NOW.getTime() + 30 * 60_000)],
    ['completed', null],
    ['no_show', null],
    ['expired', null],
    ['cancelled_by_client', null],
    ['cancelled_by_admin', null],
  ])('does not warn for a %s booking, which it leaves untouched', async (status, holdExpiresAt) => {
    const ids = await insertCatalogue();
    const booking = await insertBooking(ids, { reference: 'BKY-2610-00001', ...NINE, status, holdExpiresAt });

    const res = await send('post', BLOCKS, allDay(WEDNESDAY));

    expect(res.status).toBe(201);
    await expect(reload(booking)).resolves.toEqual(booking);
  });

  it('warns on PUT too, leaving the block where it was until confirmed', async () => {
    const ids = await insertCatalogue();
    const booking = await insertBooking(ids, { reference: 'BKY-2610-00001', ...NINE });
    const block = await createBlock(allDay(THURSDAY));
    const path = `${BLOCKS}/${block.id}`;

    const warned = await send('put', path, timed(WEDNESDAY, '09:30', '11:00'));

    expect(warned.status).toBe(409);
    expect(warned.body).toEqual({ error: 'block_overlaps_confirmed_bookings', bookings: [conflictOf(booking)] });
    expect((await send('get', BLOCKS)).body).toEqual({ blocks: [block] });

    const confirmed = await send('put', path, timed(WEDNESDAY, '09:30', '11:00', { confirm: true }));

    expect(confirmed.status).toBe(200);
    expect((confirmed.body as { block: BlockJson }).block.startsAt).toBe('2026-10-07T07:30:00.000Z');
    await expect(reload(booking)).resolves.toEqual(booking);

    // Every save warns again: an edit to the reason is still a save over him.
    expect((await send('put', path, timed(WEDNESDAY, '09:30', '11:00', { reason: 'edited' }))).status).toBe(409);
  });

  it('answers a PUT to a missing block with 404, not a conflict warning', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, { reference: 'BKY-2610-00001', ...NINE });

    expectNotFound(await send('put', `${BLOCKS}/${NONEXISTENT_ID}`, timed(WEDNESDAY, '09:00', '10:00')));
  });
});

// --- Spec P-03: reasons stay private -------------------------------------------------------

describe('block reasons in the public availability (spec P-03)', () => {
  it('never appear in the raw JSON, which carries only dates and start instants', async () => {
    await seedWeekdayHours();
    const ids = await insertCatalogue();
    const REASONS = ['PRIVATE-REASON-hospital-visit', 'PRIVATE-REASON-family-funeral'];
    const blocks = [
      await createBlock(timed(WEDNESDAY, '14:00', '16:00', { reason: REASONS[0] })),
      await createBlock(allDay(THURSDAY, THURSDAY, { reason: REASONS[1] })),
    ];
    const bookings = [
      await insertBooking(ids, {
        reference: 'BKY-2610-SECR1', date: WEDNESDAY, from: '10:00', to: '11:00', bufferTo: '11:30',
        contactName: 'PRIVATE-NAME Uwimana', contactEmail: 'private-email@example.com',
      }),
      await insertBooking(ids, {
        reference: 'BKY-2610-SECR2', date: FRIDAY, from: '10:00', to: '11:00', bufferTo: '11:30',
        status: 'pending_payment', holdExpiresAt: kigali(FRIDAY, '08:00'),
      }),
    ];
    // The reasons are really stored, and the admin really sees them.
    const adminText = (await send('get', BLOCKS)).text;
    for (const reason of REASONS) expect(adminText).toContain(reason);

    const days = await findAvailability(prisma, { from: WEDNESDAY, to: FRIDAY, packageDurationMinutes: 60, now: NOW });
    const json = JSON.stringify(days);

    const secrets = [
      ...REASONS,
      ...blocks.map((block) => block.id),
      ...bookings.flatMap((booking) => [booking.id, booking.reference, booking.contactName, booking.contactEmail]),
      'reason',
      'status',
    ];
    for (const secret of secrets) expect(json).not.toContain(secret);
    for (const day of days) {
      expect(Object.keys(day).sort()).toEqual(['date', 'starts']);
      for (const start of day.starts) expect(start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    }
    // And it is not trivially clean: the blocks and bookings did shape it.
    expect(days.map((day) => day.starts.map(kigaliTime))).toEqual([
      ['11:30', '12:00', '12:30', '13:00', '16:00'],
      [],
      ['11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00'],
    ]);
  });
});
