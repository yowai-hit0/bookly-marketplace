import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { kigaliMinuteToUtc } from '../availability/engine.js';
import { findAvailability } from '../availability/query.js';
import { DIRECTORY_DATE_HORIZON_DAYS, DIRECTORY_MAX_PAGE, searchDirectory } from '../catalogue/directory.js';
import { createPrismaClient } from '../db/client.js';
import { updatePhotographerSettings } from '../settings/index.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type ListedPhotographer, type ListedPhotographerSeed, listedPhotographer, seedStarterCategories } from '../test/directory-fixtures.js';
import { TEST_PLATFORM_SETTING } from '../test/payment-fixtures.js';

/**
 * The public directory over HTTP, against real PostgreSQL (marketplace-spec.md
 * R6.1, T6.1; marketplace-data-model.md §3.12; catalogue/directory.ts).
 *
 *   - Every filter alone and combined: category, district, min, max, date.
 *   - Who never appears: pending, suspended, expired (recorded by the job or
 *     only by the clock), approved without a subscription, and anyone with no
 *     active package on an active service.
 *   - Past-due photographers are listed after every bookable one with
 *     `takingBookings: false`, and are excluded whenever a date is asked for
 *     (user decision, Phase 6).
 *   - The date filter agrees with the engine: closed that weekday, closed by a
 *     dated override, blocked all day (in one block or several), fully booked,
 *     a window too short, inside the lead time -- each excluded; a dated
 *     override that opens a closed day, and a half-booked day, kept. And for a
 *     mixed set, the directory keeps exactly whom `findAvailability` offers a
 *     start to, for their shortest active package.
 *   - Pagination: 24 a page, a total order (bookable, price, name, id), an
 *     exact `total` and `hasMore` without a date; under the date filter, pages
 *     that are consecutive slices of the survivors, no `total`, and `hasMore`
 *     only when one more survivor exists.
 *   - Validation: unknown keys, repeats and malformed values are 400; values
 *     outside their rules, unknown or inactive slugs and codes, `min > max`, a
 *     date in the past or past the horizon are 422 naming the fields.
 *   - Injection-shaped input never reaches SQL as text: the route refuses it,
 *     and `searchDirectory` called with it directly matches nothing and harms
 *     nothing, because every value is a bound parameter.
 *
 * The clock is injected: Thursday 1 October 2026, 08:00 in Kigali. Every
 * fixture photographer works Monday to Saturday 09:00-17:00 unless it says
 * otherwise, at the default lead time (120 minutes) and buffer (30).
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;

const NOW = new Date('2026-10-01T06:00:00Z');
const TODAY = '2026-10-01';
const WEDNESDAY = '2026-10-07';
const SATURDAY = '2026-10-10';
const SUNDAY = '2026-10-11';
const DIRECTORY = '/api/photographers';
const DAY_MS = 24 * 60 * 60_000;

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
  await prisma.platformSetting.create({ data: TEST_PLATFORM_SETTING });
  await seedStarterCategories(prisma);
  app = createApp({ publicApi: { prisma, now: () => NOW } });
});

// --- Helpers ------------------------------------------------------------------------

type Card = {
  handle: string;
  displayName: string;
  coverImageUrl: string | null;
  fromPriceRwf: number;
  districts: { code: string; name: string }[];
  categories: { slug: string; name: string }[];
  takingBookings: boolean;
};
type Page = { photographers: Card[]; page: number; pageSize: number; hasMore: boolean; total?: number };

function seed(handle: string, rest: Omit<ListedPhotographerSeed, 'handle'> = {}): Promise<ListedPhotographer> {
  return listedPhotographer(prisma, { handle, ...rest });
}

/** A subscription whose period ended `daysAgo` before NOW, stored as `status` (the job's record, or not yet). */
function lapsed(daysAgo: number, status: string) {
  return { status, endsAt: new Date(NOW.getTime() - daysAgo * DAY_MS) };
}

async function directory(query: Record<string, string | number> = {}, server: Express = app): Promise<Page> {
  const res = await request(server).get(DIRECTORY).query(query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Page;
}

async function handles(query: Record<string, string | number> = {}, server: Express = app): Promise<string[]> {
  return (await directory(query, server)).photographers.map((card) => card.handle);
}

function expectInvalid(res: Response): void {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body).toStrictEqual({ error: 'invalid_request' });
}

function expectRefused(res: Response, fields: string[]): void {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body).toStrictEqual({ error: 'validation_failed', fields });
}

let referenceCounter = 0;

/** A confirmed booking of `owner`'s first package, Kigali wall minutes on `date`, with no buffer of its own. */
async function book(owner: ListedPhotographer, date: string, opensMinute: number, closesMinute: number, status = 'confirmed'): Promise<void> {
  referenceCounter += 1;
  const client = await prisma.client.create({ data: { fullName: 'Client', email: `client${referenceCounter}@example.com`, phone: '+250788123456' } });
  const startsAt = kigaliMinuteToUtc(date, opensMinute);
  const endsAt = kigaliMinuteToUtc(date, closesMinute);
  await prisma.booking.create({
    data: {
      reference: `BKY-2610-${String(referenceCounter).padStart(5, '0')}`,
      clientId: client.id,
      photographerId: owner.photographerId,
      contactName: 'Client',
      contactEmail: client.email,
      contactPhone: '+250788123456',
      serviceId: owner.serviceIds[0] ?? '',
      packageId: owner.packageIds[0] ?? '',
      serviceNameSnapshot: 'Service',
      packageNameSnapshot: 'Package',
      packagePriceRwf: 40_000,
      packageDurationMinutes: closesMinute - opensMinute,
      packagePhotoCount: 20,
      status,
      startsAt,
      endsAt,
      bufferEndsAt: endsAt,
      locationText: 'Kigali',
      consentAt: NOW,
      bookingFeeRate: '0.400',
      bookingFeeRwf: 1_000,
      clientCancelCutoffHours: 0,
      bookingFeeRefundableOnClientCancel: false,
      ...(status === 'confirmed' ? { confirmedAt: NOW } : {}),
    },
  });
}

async function block(owner: ListedPhotographer, date: string, fromMinute: number, toMinute: number): Promise<void> {
  await prisma.availabilityBlock.create({
    data: { photographerId: owner.photographerId, startsAt: kigaliMinuteToUtc(date, fromMinute), endsAt: kigaliMinuteToUtc(date, toMinute) },
  });
}

// --- Who is listed -------------------------------------------------------------------

describe('who the directory lists (R6.1, R5.5)', () => {
  it('lists approved photographers with a live subscription and an active package, and nobody else', async () => {
    await seed('listed-trial');
    await seed('listed-active', { subscription: { status: 'active', endsAt: new Date('2100-01-01T00:00:00Z') } });
    await seed('pending-one', { status: 'pending' });
    await seed('suspended-one', { status: 'suspended' });
    await seed('expired-by-job', { subscription: lapsed(8, 'expired') });
    await seed('expired-by-clock', { subscription: lapsed(8, 'trialing') });
    await seed('no-subscription', { subscription: null });
    await seed('no-packages', { packages: [] });
    await seed('inactive-package', { packages: [{ priceRwf: 10_000, isActive: false }] });
    await seed('inactive-service', { packages: [{ priceRwf: 10_000, serviceInactive: true }] });

    const page = await directory();

    expect(page.photographers.map((card) => card.handle)).toEqual(['listed-active', 'listed-trial']);
    expect(page.total).toBe(2);
  });

  it.each([
    ['recorded by the job', 'past_due'],
    ['before the job has run', 'trialing'],
  ])('lists a past-due photographer %s after every bookable one, even a cheaper one, not taking bookings', async (_label, stored) => {
    await seed('cheap-past-due', { subscription: lapsed(1, stored), packages: [{ priceRwf: 5_000 }] });
    await seed('dear-bookable', { packages: [{ priceRwf: 900_000 }] });
    await seed('mid-bookable', { packages: [{ priceRwf: 50_000 }] });

    const page = await directory();

    expect(page.photographers.map((card) => [card.handle, card.takingBookings])).toEqual([
      ['mid-bookable', true],
      ['dear-bookable', true],
      ['cheap-past-due', false],
    ]);
  });

  it('hides a past-due photographer once the grace has run out by the clock alone', async () => {
    await seed('just-past-grace', { subscription: { status: 'past_due', endsAt: new Date(NOW.getTime() - 7 * DAY_MS) } });
    await seed('inside-grace', { subscription: { status: 'past_due', endsAt: new Date(NOW.getTime() - 7 * DAY_MS + 1000) } });

    expect(await handles()).toEqual(['inside-grace']);
  });

  it('answers a card as an allowlist: no id, status, login, bio, settings or subscription', async () => {
    const owner = await seed('kigali-lens', {
      displayName: 'Kigali Lens',
      coverImageUrl: 'https://images.example.com/kigali.jpg',
      bio: 'A private bio is not on the card.',
      districts: ['huye', 'gasabo', 'nyarugenge'],
      categories: ['wedding', 'family', 'portrait'],
    });

    const res = await request(app).get(DIRECTORY);

    expect(res.body).toStrictEqual({
      photographers: [
        {
          handle: 'kigali-lens',
          displayName: 'Kigali Lens',
          coverImageUrl: 'https://images.example.com/kigali.jpg',
          fromPriceRwf: 40_000,
          // In the migration's district order and the platform's category order.
          districts: [
            { code: 'gasabo', name: 'Gasabo' },
            { code: 'nyarugenge', name: 'Nyarugenge' },
            { code: 'huye', name: 'Huye' },
          ],
          categories: [
            { slug: 'wedding', name: 'Wedding' },
            { slug: 'portrait', name: 'Portrait' },
            { slug: 'family', name: 'Family' },
          ],
          takingBookings: true,
        },
      ],
      page: 1,
      pageSize: 24,
      hasMore: false,
      total: 1,
    });
    for (const hidden of [owner.photographerId, 'kigali-lens@photographers.example', 'approved', 'trialing', 'private bio', 'status', 'userId', 'bufferMinutes']) {
      expect(res.text, hidden).not.toContain(hidden);
    }
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('leaves an inactive category off the card', async () => {
    await seed('kigali-lens', { categories: ['wedding', 'portrait'] });
    await prisma.category.update({ where: { slug: 'wedding' }, data: { isActive: false } });

    expect((await directory()).photographers[0]?.categories).toEqual([{ slug: 'portrait', name: 'Portrait' }]);
  });

  it('lists nobody, with an honest empty page, when nobody is listed', async () => {
    await seed('pending-one', { status: 'pending' });

    expect(await directory()).toStrictEqual({ photographers: [], page: 1, pageSize: 24, hasMore: false, total: 0 });
  });
});

// --- The "from" price ------------------------------------------------------------------

describe('fromPriceRwf: the cheapest active package of an active service', () => {
  it('ignores an inactive package and every package of an inactive service, however cheap', async () => {
    await seed('kigali-lens', {
      packages: [{ priceRwf: 1_000, isActive: false }, { priceRwf: 2_000, serviceInactive: true }, { priceRwf: 75_000 }, { priceRwf: 60_000 }],
    });

    expect((await directory()).photographers[0]?.fromPriceRwf).toBe(60_000);
  });

  it('follows a price edit at once', async () => {
    const owner = await seed('kigali-lens', { packages: [{ priceRwf: 60_000 }] });
    await prisma.package.update({ where: { id: owner.packageIds[0] }, data: { priceRwf: 30_000 } });

    expect((await directory()).photographers[0]?.fromPriceRwf).toBe(30_000);
  });

  it('can be zero', async () => {
    await seed('free-one', { packages: [{ priceRwf: 0 }] });

    expect((await directory({ max: 0 })).photographers.map((card) => [card.handle, card.fromPriceRwf])).toEqual([['free-one', 0]]);
  });
});

// --- Order ---------------------------------------------------------------------------

describe('the order: bookable, then price, then name, then id', () => {
  it('sorts by price, then by name ignoring case, whatever the order of creation', async () => {
    await seed('zulu', { displayName: 'Zulu Studio', packages: [{ priceRwf: 30_000 }] });
    await seed('bravo', { displayName: 'bravo photos', packages: [{ priceRwf: 50_000 }] });
    await seed('alpha', { displayName: 'Alpha Photos', packages: [{ priceRwf: 50_000 }] });
    await seed('charlie', { displayName: 'Charlie', packages: [{ priceRwf: 50_000 }] });
    await seed('dear', { displayName: 'Aaron', packages: [{ priceRwf: 90_000 }] });

    expect(await handles()).toEqual(['zulu', 'alpha', 'bravo', 'charlie', 'dear']);
  });

  it('breaks a tie of price and name by id, the same way on every request', async () => {
    const seeded: ListedPhotographer[] = [];
    for (const handle of ['twin-one', 'twin-two', 'twin-three', 'twin-four']) seeded.push(await seed(handle, { displayName: 'Twin Studio' }));
    const byId = [...seeded].sort((a, b) => (a.photographerId < b.photographerId ? -1 : 1)).map((owner) => owner.handle);

    for (let attempt = 0; attempt < 3; attempt += 1) expect(await handles()).toEqual(byId);
  });
});

// --- Each filter alone, then combined --------------------------------------------------

describe('category', () => {
  beforeEach(async () => {
    await seed('weddings-only', { categories: ['wedding'] });
    await seed('portraits-and-weddings', { categories: ['portrait', 'wedding'] });
    await seed('no-category');
  });

  it('keeps the photographers who shoot it', async () => {
    expect((await handles({ category: 'wedding' })).sort()).toEqual(['portraits-and-weddings', 'weddings-only']);
    expect(await handles({ category: 'portrait' })).toEqual(['portraits-and-weddings']);
  });

  it('keeps nobody for an active category nobody shoots', async () => {
    expect(await directory({ category: 'real-estate' })).toStrictEqual({ photographers: [], page: 1, pageSize: 24, hasMore: false, total: 0 });
  });

  it('refuses an unknown category, and one that has been deactivated, as 422', async () => {
    expectRefused(await request(app).get(DIRECTORY).query({ category: 'underwater' }), ['category']);
    await prisma.category.update({ where: { slug: 'wedding' }, data: { isActive: false } });
    expectRefused(await request(app).get(DIRECTORY).query({ category: 'wedding' }), ['category']);
  });
});

describe('district', () => {
  beforeEach(async () => {
    await seed('kigali-wide', { districts: ['gasabo', 'kicukiro', 'nyarugenge'] });
    await seed('huye-only', { districts: ['huye'] });
    await seed('nowhere');
  });

  it('keeps the photographers who work there', async () => {
    expect(await handles({ district: 'huye' })).toEqual(['huye-only']);
    expect(await handles({ district: 'kicukiro' })).toEqual(['kigali-wide']);
  });

  it('keeps nobody for a district nobody works in', async () => {
    expect(await handles({ district: 'rusizi' })).toEqual([]);
  });

  it('refuses an unknown district as 422', async () => {
    expectRefused(await request(app).get(DIRECTORY).query({ district: 'atlantis' }), ['district']);
  });
});

describe('min and max: inclusive bounds on the "from" price', () => {
  beforeEach(async () => {
    await seed('at-20k', { packages: [{ priceRwf: 20_000 }, { priceRwf: 500_000 }] });
    await seed('at-50k', { packages: [{ priceRwf: 50_000 }] });
    await seed('at-80k', { packages: [{ priceRwf: 80_000 }] });
  });

  it('min alone', async () => {
    expect(await handles({ min: 50_000 })).toEqual(['at-50k', 'at-80k']);
    expect(await handles({ min: 50_001 })).toEqual(['at-80k']);
  });

  it('max alone, against the cheapest package only: a dear second package does not exclude', async () => {
    expect(await handles({ max: 50_000 })).toEqual(['at-20k', 'at-50k']);
    expect(await handles({ max: 19_999 })).toEqual([]);
  });

  it('both, including min equal to max', async () => {
    expect(await handles({ min: 20_000, max: 80_000 })).toEqual(['at-20k', 'at-50k', 'at-80k']);
    expect(await handles({ min: 50_000, max: 50_000 })).toEqual(['at-50k']);
    expect(await handles({ min: 0, max: 2_147_483_647 })).toEqual(['at-20k', 'at-50k', 'at-80k']);
  });

  it('refuses min above max as 422 naming both', async () => {
    expectRefused(await request(app).get(DIRECTORY).query({ min: 50_001, max: 50_000 }), ['min', 'max']);
  });
});

describe('every filter combined', () => {
  it('keeps only the photographers who pass all of them, past-due ones last', async () => {
    const base = { categories: ['wedding'], districts: ['gasabo'], packages: [{ priceRwf: 50_000 }] };
    await seed('all-match', base);
    await seed('all-match-past-due', { ...base, packages: [{ priceRwf: 40_000 }], subscription: lapsed(1, 'past_due') });
    await seed('wrong-category', { ...base, categories: ['portrait'] });
    await seed('wrong-district', { ...base, districts: ['huye'] });
    await seed('too-cheap', { ...base, packages: [{ priceRwf: 10_000 }] });
    await seed('too-dear', { ...base, packages: [{ priceRwf: 200_000 }] });
    await seed('suspended-match', { ...base, status: 'suspended' });
    await seed('expired-match', { ...base, subscription: lapsed(30, 'expired') });

    const query = { category: 'wedding', district: 'gasabo', min: 20_000, max: 100_000 };
    expect(await handles(query)).toEqual(['all-match', 'all-match-past-due']);

    // And with a date: the past-due one goes, the bookable one stays.
    expect(await handles({ ...query, date: WEDNESDAY })).toEqual(['all-match']);
  });

  it('pairs each two filters correctly', async () => {
    await seed('w-gasabo-30k', { categories: ['wedding'], districts: ['gasabo'], packages: [{ priceRwf: 30_000 }] });
    await seed('w-huye-60k', { categories: ['wedding'], districts: ['huye'], packages: [{ priceRwf: 60_000 }] });
    await seed('p-gasabo-60k', { categories: ['portrait'], districts: ['gasabo'], packages: [{ priceRwf: 60_000 }] });
    await seed('p-huye-30k-sundays', {
      categories: ['portrait'],
      districts: ['huye'],
      packages: [{ priceRwf: 30_000 }],
      hours: [{ weekday: 0, opensMinute: 540, closesMinute: 1020 }],
    });

    expect(await handles({ category: 'wedding', district: 'huye' })).toEqual(['w-huye-60k']);
    expect(await handles({ category: 'portrait', min: 40_000 })).toEqual(['p-gasabo-60k']);
    expect(await handles({ district: 'gasabo', max: 40_000 })).toEqual(['w-gasabo-30k']);
    expect(await handles({ category: 'portrait', date: SUNDAY })).toEqual(['p-huye-30k-sundays']);
    expect(await handles({ district: 'huye', date: WEDNESDAY })).toEqual(['w-huye-60k']);
    expect(await handles({ min: 30_000, max: 30_000, date: WEDNESDAY })).toEqual(['w-gasabo-30k']);
  });
});

// --- The date filter ---------------------------------------------------------------------

describe('date: agrees with the availability engine (T6.1)', () => {
  it('keeps a photographer open that day with a free slot', async () => {
    await seed('open-wednesday');

    const page = await directory({ date: WEDNESDAY });

    expect(page.photographers.map((card) => card.handle)).toEqual(['open-wednesday']);
    // No total under the date filter: it would need the engine on every candidate.
    expect(page).not.toHaveProperty('total');
    expect(page.hasMore).toBe(false);
  });

  it('excludes a past-due photographer, by the job or by the clock, whatever their hours', async () => {
    await seed('past-due-by-job', { subscription: lapsed(1, 'past_due') });
    await seed('past-due-by-clock', { subscription: lapsed(1, 'trialing') });
    await seed('bookable');

    expect(await handles({ date: WEDNESDAY })).toEqual(['bookable']);
  });

  it('excludes a photographer closed that weekday', async () => {
    await seed('weekdays-only', { hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinute: 540, closesMinute: 1020 })) });
    await seed('no-hours-at-all', { hours: [] });
    await seed('saturdays-too');

    expect(await handles({ date: SATURDAY })).toEqual(['saturdays-too']);
    expect((await handles({ date: WEDNESDAY })).sort()).toEqual(['saturdays-too', 'weekdays-only']);
  });

  it('follows dated overrides both ways: closing an open Wednesday, opening a closed Sunday', async () => {
    const closed = await seed('closed-this-wednesday');
    const opened = await seed('open-this-sunday');
    await prisma.workingHours.create({ data: { photographerId: closed.photographerId, effectiveDate: new Date(`${WEDNESDAY}T00:00:00Z`), isOpen: false } });
    await prisma.workingHours.create({
      data: { photographerId: opened.photographerId, effectiveDate: new Date(`${SUNDAY}T00:00:00Z`), opensMinute: 600, closesMinute: 720, isOpen: true },
    });

    expect(await handles({ date: WEDNESDAY })).toEqual(['open-this-sunday']);
    expect(await handles({ date: SUNDAY })).toEqual(['open-this-sunday']);
    // The override is for that date only.
    expect((await handles({ date: '2026-10-14' })).sort()).toEqual(['closed-this-wednesday', 'open-this-sunday']);
  });

  it('excludes a photographer blocked all day, in one block or in several', async () => {
    const whole = await seed('blocked-whole-day');
    const pieces = await seed('blocked-in-pieces');
    const partly = await seed('blocked-morning');
    await block(whole, WEDNESDAY, 0, 1440);
    await block(pieces, WEDNESDAY, 540, 780);
    await block(pieces, WEDNESDAY, 780, 1020);
    await block(partly, WEDNESDAY, 540, 780);

    expect(await handles({ date: WEDNESDAY })).toEqual(['blocked-morning']);
  });

  it('excludes a photographer fully booked that day, and keeps one with time left', async () => {
    const full = await seed('fully-booked');
    const half = await seed('half-booked');
    const held = await seed('held-by-a-live-hold');
    const lapsedHold = await seed('hold-lapsed');
    const cancelled = await seed('cancelled-booking');
    await book(full, WEDNESDAY, 540, 1020);
    await book(half, WEDNESDAY, 540, 780);
    await book(cancelled, WEDNESDAY, 540, 1020, 'cancelled_by_client');
    await book(held, WEDNESDAY, 540, 1020, 'pending_payment');
    await prisma.booking.updateMany({ where: { photographerId: held.photographerId }, data: { holdExpiresAt: new Date(NOW.getTime() + 30 * 60_000) } });
    await book(lapsedHold, WEDNESDAY, 540, 1020, 'pending_payment');
    await prisma.booking.updateMany({ where: { photographerId: lapsedHold.photographerId }, data: { holdExpiresAt: new Date(NOW.getTime() - 60_000) } });

    expect((await handles({ date: WEDNESDAY })).sort()).toEqual(['cancelled-booking', 'half-booked', 'hold-lapsed']);
  });

  it('checks the SHORTEST active package: a day too short for the long one is still bookable for the short one', async () => {
    const short = { weekday: 3, opensMinute: 540, closesMinute: 630 };
    await seed('short-and-long', { packages: [{ priceRwf: 90_000, durationMinutes: 600 }, { priceRwf: 40_000, durationMinutes: 90 }], hours: [short] });
    await seed('long-only', { packages: [{ priceRwf: 90_000, durationMinutes: 600 }], hours: [short] });
    await seed('short-is-inactive', { packages: [{ priceRwf: 90_000, durationMinutes: 600 }, { priceRwf: 40_000, durationMinutes: 60, isActive: false }], hours: [short] });

    expect(await handles({ date: WEDNESDAY })).toEqual(['short-and-long']);
  });

  it('fits the slot grid as the engine does: a window opening off the grid loses its first minutes', async () => {
    // 09:10-10:30 offers no 90-minute start: the first grid start is 09:30.
    await seed('off-grid', { packages: [{ priceRwf: 40_000, durationMinutes: 90 }], hours: [{ weekday: 3, opensMinute: 550, closesMinute: 630 }] });
    await seed('on-grid', { packages: [{ priceRwf: 40_000, durationMinutes: 90 }], hours: [{ weekday: 3, opensMinute: 540, closesMinute: 630 }] });

    expect(await handles({ date: WEDNESDAY })).toEqual(['on-grid']);
  });

  it('applies the lead time on today, so a photographer whose day is over is excluded', async () => {
    await seed('today-open');
    const late = await seed('late-lead-time');
    await updatePhotographerSettings(late.photographerId, { minLeadTimeMinutes: 600 }, prisma);

    // 08:00 now plus 120 minutes leaves 10:00-17:00; plus 600 minutes reaches 18:00, past closing.
    expect(await handles({ date: TODAY })).toEqual(['today-open']);

    const evening = createApp({ publicApi: { prisma, now: () => new Date('2026-10-01T14:30:00Z') } });
    expect(await handles({ date: TODAY }, evening)).toEqual([]);
  });

  it('keeps exactly whom the engine offers a start to, for a varied set', async () => {
    const owners = [
      await seed('a-open', { packages: [{ priceRwf: 10_000 }] }),
      await seed('b-booked', { packages: [{ priceRwf: 11_000 }] }),
      await seed('c-blocked', { packages: [{ priceRwf: 12_000 }] }),
      await seed('d-closed', { packages: [{ priceRwf: 13_000 }], hours: [{ weekday: 1, opensMinute: 540, closesMinute: 1020 }] }),
      await seed('e-tight', { packages: [{ priceRwf: 14_000, durationMinutes: 120 }], hours: [{ weekday: 3, opensMinute: 540, closesMinute: 690 }] }),
      await seed('f-tight-booked', { packages: [{ priceRwf: 15_000, durationMinutes: 120 }], hours: [{ weekday: 3, opensMinute: 540, closesMinute: 690 }] }),
      await seed('g-buffered', { packages: [{ priceRwf: 16_000, durationMinutes: 60 }], hours: [{ weekday: 3, opensMinute: 540, closesMinute: 660 }] }),
      await seed('h-two-packages', { packages: [{ priceRwf: 17_000, durationMinutes: 480 }, { priceRwf: 18_000, durationMinutes: 30 }] }),
    ];
    const [, booked, blocked, , , tightBooked, buffered, twoPackages] = owners;
    await book(booked!, WEDNESDAY, 540, 1020);
    await block(blocked!, WEDNESDAY, 500, 1100);
    await book(tightBooked!, WEDNESDAY, 600, 630);
    // 09:00-10:00 booked; with a 30-minute buffer the next 60-minute candidate would end at 11:00 plus its buffer: still fits.
    await book(buffered!, WEDNESDAY, 540, 600);
    // Booked until 16:00: only the 30-minute package still fits, at 16:00.
    await book(twoPackages!, WEDNESDAY, 540, 960);

    const expected: string[] = [];
    for (const owner of owners) {
      const packages = await prisma.package.findMany({ where: { photographerId: owner.photographerId, isActive: true, service: { isActive: true } } });
      const shortest = Math.min(...packages.map((pkg) => pkg.durationMinutes));
      const [day] = await findAvailability(prisma, { photographerId: owner.photographerId, from: WEDNESDAY, to: WEDNESDAY, packageDurationMinutes: shortest, now: NOW });
      if ((day?.starts.length ?? 0) > 0) expected.push(owner.handle);
    }

    expect(await handles({ date: WEDNESDAY })).toEqual(expected);
    // The fixture is only worth something if the engine both kept and dropped some.
    expect(expected).toEqual(['a-open', 'e-tight', 'g-buffered', 'h-two-packages']);
  });

  it('accepts today and the last day of the horizon, and refuses the day before and the day after as 422', async () => {
    await seed('open-every-day', { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensMinute: 540, closesMinute: 1020 })) });
    const last = new Date(NOW.getTime() + 2 * 60 * 60_000 + DIRECTORY_DATE_HORIZON_DAYS * DAY_MS).toISOString().slice(0, 10);
    const afterLast = new Date(Date.parse(`${last}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

    expect(await handles({ date: TODAY })).toEqual(['open-every-day']);
    expect(await handles({ date: last })).toEqual(['open-every-day']);
    expectRefused(await request(app).get(DIRECTORY).query({ date: '2026-09-30' }), ['date']);
    expectRefused(await request(app).get(DIRECTORY).query({ date: '2020-01-01' }), ['date']);
    expectRefused(await request(app).get(DIRECTORY).query({ date: afterLast }), ['date']);
  });

  it('reads "today" on the Kigali calendar, not the UTC one', async () => {
    await seed('open-every-day', { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensMinute: 540, closesMinute: 1020 })) });
    // 23:30 UTC on 30 September is already 1 October in Kigali.
    const lateUtc = createApp({ publicApi: { prisma, now: () => new Date('2026-09-30T23:30:00Z') } });

    expectRefused(await request(lateUtc).get(DIRECTORY).query({ date: '2026-09-30' }), ['date']);
    expect(await handles({ date: '2026-10-01' }, lateUtc)).toEqual(['open-every-day']);
  });

  it('excludes a photographer with no active package with a date too', async () => {
    await seed('nothing-to-book', { packages: [{ priceRwf: 40_000, isActive: false }] });

    expect(await handles({ date: WEDNESDAY })).toEqual([]);
  });
});

// --- Pagination ------------------------------------------------------------------------

describe('pagination without a date', () => {
  beforeEach(async () => {
    // 30 photographers; prices repeat so the name and the id decide too.
    for (let i = 0; i < 30; i += 1) {
      await seed(`studio-${String(i).padStart(2, '0')}`, { displayName: `Studio ${i % 7}`, packages: [{ priceRwf: 10_000 * ((i % 4) + 1) }] });
    }
  });

  it('serves 24 a page with an exact total, then the rest, then an empty page past the end', async () => {
    const first = await directory();
    const second = await directory({ page: 2 });
    const third = await directory({ page: 3 });

    expect([first.photographers.length, first.page, first.pageSize, first.hasMore, first.total]).toEqual([24, 1, 24, true, 30]);
    expect([second.photographers.length, second.page, second.hasMore, second.total]).toEqual([6, 2, false, 30]);
    expect(third).toStrictEqual({ photographers: [], page: 3, pageSize: 24, hasMore: false, total: 30 });
    const all = [...first.photographers, ...second.photographers].map((card) => card.handle);
    expect(new Set(all).size).toBe(30);
  });

  it('cuts the pages from one total order', async () => {
    const all = [...(await directory()).photographers, ...(await directory({ page: 2 })).photographers];

    for (let i = 1; i < all.length; i += 1) {
      const [a, b] = [all[i - 1]!, all[i]!];
      expect(a.fromPriceRwf <= b.fromPriceRwf, `${a.handle} before ${b.handle}`).toBe(true);
      if (a.fromPriceRwf === b.fromPriceRwf) expect(a.displayName.toLowerCase() <= b.displayName.toLowerCase()).toBe(true);
    }
    // Asking again gives the same pages.
    expect([...(await directory()).photographers, ...(await directory({ page: 2 })).photographers]).toEqual(all);
  });

  it('treats an absent page as page 1', async () => {
    expect(await directory()).toEqual(await directory({ page: 1 }));
  });

  it('pages through filtered results with a filtered total', async () => {
    const page = await directory({ min: 40_000 });

    expect(page.total).toBe(7);
    expect(page.photographers.every((card) => card.fromPriceRwf === 40_000)).toBe(true);
    expect(page.hasMore).toBe(false);
  });
});

describe('pagination under the date filter', () => {
  /** 60 candidates in price order; every third is fully booked on Wednesday, so 40 survive. */
  async function seedSixty(): Promise<string[]> {
    const survivors: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const handle = `cand-${String(i).padStart(2, '0')}`;
      const owner = await seed(handle, { displayName: `Candidate ${String(i).padStart(2, '0')}`, packages: [{ priceRwf: 1_000 * (i + 1) }] });
      if (i % 3 === 0) await book(owner, WEDNESDAY, 540, 1020);
      else survivors.push(handle);
    }
    return survivors;
  }

  it('serves consecutive slices of the survivors, with no total and an honest hasMore', async () => {
    const survivors = await seedSixty();

    const first = await directory({ date: WEDNESDAY });
    const second = await directory({ date: WEDNESDAY, page: 2 });
    const third = await directory({ date: WEDNESDAY, page: 3 });

    expect(survivors).toHaveLength(40);
    expect(first.photographers.map((card) => card.handle)).toEqual(survivors.slice(0, 24));
    expect(second.photographers.map((card) => card.handle)).toEqual(survivors.slice(24, 40));
    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, false, false]);
    expect(third.photographers).toEqual([]);
    for (const page of [first, second, third]) expect(page).not.toHaveProperty('total');
  });

  it('says hasMore false when exactly one page of survivors exists, though more candidates did', async () => {
    const survivors: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const owner = await seed(`exact-${String(i).padStart(2, '0')}`, { packages: [{ priceRwf: 1_000 * (i + 1) }] });
      // The last six candidates are all fully booked: 24 survive.
      if (i >= 24) await book(owner, WEDNESDAY, 540, 1020);
      else survivors.push(owner.handle);
    }

    const first = await directory({ date: WEDNESDAY });

    expect(first.photographers.map((card) => card.handle)).toEqual(survivors);
    expect(first.hasMore).toBe(false);
    expect((await directory({ date: WEDNESDAY, page: 2 })).photographers).toEqual([]);
  });

  it('finds survivors past the first chunk of candidates when the early ones are all booked', async () => {
    const survivors: string[] = [];
    for (let i = 0; i < 70; i += 1) {
      const owner = await seed(`deep-${String(i).padStart(2, '0')}`, { packages: [{ priceRwf: 1_000 * (i + 1) }] });
      if (i < 60) await book(owner, WEDNESDAY, 540, 1020);
      else survivors.push(owner.handle);
    }

    const first = await directory({ date: WEDNESDAY });

    expect(first.photographers.map((card) => card.handle)).toEqual(survivors);
    expect(first.hasMore).toBe(false);
  });
});

// --- Validation and injection -----------------------------------------------------------

describe('validation (routes/validation.ts: 400 malformed, 422 a rule)', () => {
  beforeEach(async () => {
    await seed('kigali-lens', { categories: ['wedding'], districts: ['gasabo'] });
  });

  it.each([
    ['an unknown key', '?sort=price'],
    ['a misspelt filter', '?categry=wedding'],
    ['a repeated key', '?category=wedding&category=portrait'],
    ['a bracketed key', '?min[]=1'],
    ['an empty value', '?category='],
    ['an uppercase slug', '?category=Wedding'],
    ['a district with a space', '?district=gasabo%20district'],
    ['a non-numeric min', '?min=abc'],
    ['a decimal max', '?max=1.5'],
    ['an exponent', '?min=1e3'],
    ['an empty page', '?page='],
    ['a non-numeric page', '?page=two'],
    ['a malformed date', '?date=07-10-2026'],
    ['a date with a time', '?date=2026-10-07T10:00:00Z'],
    ['an impossible month', '?date=2026-13-01'],
    ['too many digits', '?min=1234567890123'],
  ])('refuses %s as 400', async (_label, query) => {
    expectInvalid(await request(app).get(`${DIRECTORY}${query}`));
  });

  it.each([
    ['a negative min', { min: -1 }, ['min']],
    ['a max past int4', { max: 2_147_483_648 }, ['max']],
    ['page 0', { page: 0 }, ['page']],
    ['a negative page', { page: -3 }, ['page']],
    ['a page past the bound', { page: DIRECTORY_MAX_PAGE + 1 }, ['page']],
    ['a year the engine cannot compute', { date: '0050-01-01' }, ['date']],
    ['a slug too long', { category: 'a'.repeat(65) }, ['category']],
  ])('refuses %s as 422', async (_label, query, fields) => {
    expectRefused(await request(app).get(DIRECTORY).query(query), fields);
  });

  it('names every field that breaks a rule in one answer', async () => {
    expectRefused(await request(app).get(DIRECTORY).query({ category: 'underwater', district: 'atlantis', date: '2020-01-01' }), ['category', 'district', 'date']);
  });

  it('answers the last allowed page, past the end, as an empty 200', async () => {
    expect(await directory({ page: DIRECTORY_MAX_PAGE })).toStrictEqual({ photographers: [], page: DIRECTORY_MAX_PAGE, pageSize: 24, hasMore: false, total: 1 });
  });
});

describe('injection-shaped input', () => {
  const ATTACKS = [
    "wedding' OR '1'='1",
    "gasabo'; DROP TABLE photographer; --",
    '1 OR 1=1',
    "1); DELETE FROM package; --",
    '%27%20OR%201%3D1',
    "' UNION SELECT email FROM app_user --",
  ];

  beforeEach(async () => {
    await seed('kigali-lens', { categories: ['wedding'], districts: ['gasabo'] });
  });

  it('is refused by the route, and changes nothing', async () => {
    for (const attack of ATTACKS) {
      for (const key of ['category', 'district', 'min', 'max', 'date', 'page']) {
        expectInvalid(await request(app).get(DIRECTORY).query({ [key]: attack }));
      }
    }
    expect(await prisma.photographer.count()).toBe(1);
    expect(await prisma.package.count()).toBe(1);
    expect(await handles()).toEqual(['kigali-lens']);
  });

  it('reaches SQL only as a bound value: searchDirectory given it directly matches nothing and harms nothing', async () => {
    for (const attack of ATTACKS) {
      const page = await searchDirectory(prisma, { category: attack, page: 1 }, NOW);
      expect(page.photographers, attack).toEqual([]);
      expect((await searchDirectory(prisma, { district: attack, page: 1 }, NOW)).photographers, attack).toEqual([]);
    }
    expect(await prisma.photographer.count()).toBe(1);
    expect(await prisma.package.count()).toBe(1);
    expect(await handles()).toEqual(['kigali-lens']);
  });
});

// --- Reference data ----------------------------------------------------------------------

describe('GET /api/categories', () => {
  it('lists the active categories in the platform order, as slug and name only', async () => {
    await prisma.category.update({ where: { slug: 'product' }, data: { isActive: false } });
    await prisma.category.update({ where: { slug: 'fashion' }, data: { sortOrder: -1 } });

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      categories: [
        { slug: 'fashion', name: 'Fashion' },
        { slug: 'wedding', name: 'Wedding' },
        { slug: 'portrait', name: 'Portrait' },
        { slug: 'event', name: 'Event' },
        { slug: 'graduation', name: 'Graduation' },
        { slug: 'family', name: 'Family' },
        { slug: 'real-estate', name: 'Real estate' },
      ],
    });
  });

  it('lists nothing when there are no active categories', async () => {
    await prisma.category.updateMany({ data: { isActive: false } });

    expect((await request(app).get('/api/categories')).body).toStrictEqual({ categories: [] });
  });
});

describe('GET /api/districts', () => {
  it("lists Rwanda's 30 districts grouped into the 5 provinces, in the migration's order", async () => {
    const res = await request(app).get('/api/districts');
    const body = res.body as { provinces: { code: string; name: string; districts: { code: string; name: string }[] }[] };

    expect(res.status).toBe(200);
    expect(body.provinces.map((province) => [province.code, province.name, province.districts.length])).toEqual([
      ['kigali', 'Kigali City', 3],
      ['eastern', 'Eastern Province', 7],
      ['northern', 'Northern Province', 5],
      ['southern', 'Southern Province', 8],
      ['western', 'Western Province', 7],
    ]);
    expect(body.provinces[0]?.districts).toStrictEqual([
      { code: 'gasabo', name: 'Gasabo' },
      { code: 'kicukiro', name: 'Kicukiro' },
      { code: 'nyarugenge', name: 'Nyarugenge' },
    ]);
    expect(body.provinces.flatMap((province) => province.districts)).toHaveLength(30);
    expect(Object.keys(body.provinces[0] ?? {}).sort()).toEqual(['code', 'districts', 'name']);
  });
});

describe('mounting', () => {
  it('404s the directory and the reference data when publicApi is omitted', async () => {
    const closed = createApp();
    for (const path of [DIRECTORY, '/api/categories', '/api/districts']) {
      const res = await request(closed).get(path);
      expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
    }
  });

  it('serves only GET', async () => {
    for (const res of [await request(app).post('/api/categories').send({}), await request(app).delete('/api/districts'), await request(app).put(DIRECTORY).send({})]) {
      expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
    }
  });
});
