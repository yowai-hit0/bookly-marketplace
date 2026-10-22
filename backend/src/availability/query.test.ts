import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { updatePhotographerSettings } from '../settings/index.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { PHOTOGRAPHER_EMAIL, PHOTOGRAPHER_HANDLE, createPhotographer } from '../test/payment-fixtures.js';
import { type FindAvailabilityOptions, findAvailability, findDayStartsFor } from './query.js';

/**
 * `findAvailability`, the database side of availability, against real
 * PostgreSQL (plan.md Task 8, data-model_v2.md §8).
 *
 * The engine's rules are proven in engine.test.ts with rows handed in. What is
 * proven here is the loading: that the right working hours, blocks and bookings
 * reach the engine for a range of Kigali dates -- including rows that start or
 * end outside that range -- and that the operating values are read through
 * `getPhotographerSettings()` on every call, so an edit on the settings screen
 * applies to the very next request.
 *
 * Every row is one photographer's (marketplace-spec.md T1.4): another
 * photographer's hours, blocks, bookings and settings never reach the engine.
 *
 * Kigali is UTC+2 with no DST. 2026-10-07 is a Wednesday. The clock is injected.
 */

let prisma: PrismaClient;
let raw: pg.Client;
/** The photographer whose calendar is asked about, unless a test names another. */
let photographerId: string;

/** A week before every fixture date, so lead time only bites when a test says so. */
const NOW = new Date('2026-09-30T08:00:00Z');
const MINUTE_MS = 60_000;
const KIGALI_OFFSET_MS = 120 * MINUTE_MS;

const MONDAY = '2026-10-05';
const TUESDAY = '2026-10-06';
const WEDNESDAY = '2026-10-07';
const THURSDAY = '2026-10-08';
const FRIDAY = '2026-10-09';
const SATURDAY = '2026-10-10';
const SUNDAY = '2026-10-11';
const NEXT_MONDAY = '2026-10-12';

/** Every 30-minute start a 60-minute package fits into 09:00–17:00. */
const FULL_DAY = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00',
];

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
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
  // Born with its settings row at the defaults: lead 120, buffer 30.
  ({ photographerId } = await createPhotographer(prisma, { email: PHOTOGRAPHER_EMAIL, handle: PHOTOGRAPHER_HANDLE, displayName: 'Kigali Lens' }));
  await weekdayHours(photographerId);
});

// --- Fixtures ---------------------------------------------------------------

/** The weekly rule sign-up gives a photographer: Mon–Fri 09:00–17:00. */
async function weekdayHours(owner: string): Promise<void> {
  await prisma.workingHours.createMany({
    data: [1, 2, 3, 4, 5].map((weekday) => ({ photographerId: owner, weekday, opensMinute: 540, closesMinute: 1020 })),
  });
}

/** A Kigali wall-clock time on `date`, as the UTC instant. */
function kigali(date: string, wallTime: string): Date {
  return new Date(`${date}T${wallTime}:00+02:00`);
}

function kigaliTime(iso: string): string {
  return new Date(Date.parse(iso) + KIGALI_OFFSET_MS).toISOString().slice(11, 16);
}

function find(from: string, to = from, options: Partial<FindAvailabilityOptions> = {}) {
  return findAvailability(prisma, { photographerId, from, to, packageDurationMinutes: 60, now: NOW, ...options });
}

/** Offered Kigali start times per date. */
async function offered(
  from: string,
  to = from,
  options: Partial<FindAvailabilityOptions> = {},
): Promise<Record<string, string[]>> {
  const days = await find(from, to, options);
  return Object.fromEntries(days.map((day) => [day.date, day.starts.map(kigaliTime)]));
}

/** Offered Kigali start times on one date. */
async function startTimes(date: string, options: Partial<FindAvailabilityOptions> = {}): Promise<string[]> {
  return (await offered(date, date, options))[date] ?? [];
}

/** Open a date round the clock, so rows crossing midnight become visible. */
async function openAllDay(date: string, owner = photographerId): Promise<void> {
  await prisma.workingHours.create({
    data: { photographerId: owner, effectiveDate: new Date(`${date}T00:00:00Z`), opensMinute: 0, closesMinute: 1440 },
  });
}

let bookingCount = 0;

type Reservation = {
  startsAt: Date;
  endsAt: Date;
  bufferEndsAt: Date;
  status?: string;
  holdExpiresAt?: Date | null;
};

/** One booking row of `owner`'s, with a fresh catalogue so tests can add several. */
async function insertBooking(reservation: Reservation, owner = photographerId): Promise<void> {
  bookingCount += 1;
  const service = await prisma.service.create({
    data: { photographerId: owner, slug: `portrait-${bookingCount}`, nameEn: 'Portrait' },
  });
  const pkg = await prisma.package.create({
    data: { photographerId: owner, serviceId: service.id, nameEn: 'Standard', priceRwf: 40_000, photoCount: 20, durationMinutes: 60 },
  });
  const client = await prisma.client.create({
    data: { fullName: 'Aline Uwase', email: `aline-${bookingCount}@example.com`, phone: '+250788000000' },
  });
  await prisma.booking.create({
    data: {
      reference: `BKY-2610-${String(bookingCount).padStart(5, '0')}`,
      photographerId: owner,
      clientId: client.id,
      contactName: 'Aline Uwase',
      contactEmail: 'aline@example.com',
      contactPhone: '+250788000000',
      serviceId: service.id,
      packageId: pkg.id,
      serviceNameSnapshot: 'Portrait',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 40_000,
      packageDurationMinutes: 60,
      packagePhotoCount: 20,
      locationText: 'Kigali Heights',
      consentAt: NOW,
      bookingFeeRate: '0.400',
      bookingFeeRwf: 16_000,
      clientCancelCutoffHours: 0,
      bookingFeeRefundableOnClientCancel: false,
      status: reservation.status ?? 'confirmed',
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
      bufferEndsAt: reservation.bufferEndsAt,
      holdExpiresAt: reservation.holdExpiresAt ?? null,
    },
  });
}

/** A same-day reservation in Kigali wall time. */
function on(date: string, from: string, to: string, bufferTo: string): Reservation {
  return { startsAt: kigali(date, from), endsAt: kigali(date, to), bufferEndsAt: kigali(date, bufferTo) };
}

// --- The result -------------------------------------------------------------------

describe('the shape of findAvailability', () => {
  it('returns one entry per Kigali date, inclusive and ascending, closed days included', async () => {
    expect(await offered(FRIDAY, NEXT_MONDAY)).toEqual({
      [FRIDAY]: FULL_DAY,
      [SATURDAY]: [],
      [SUNDAY]: [],
      [NEXT_MONDAY]: FULL_DAY,
    });
    expect((await find(FRIDAY, NEXT_MONDAY)).map((day) => day.date)).toEqual([FRIDAY, SATURDAY, SUNDAY, NEXT_MONDAY]);
  });

  it('returns a single day when from equals to', async () => {
    const days = await find(WEDNESDAY);

    expect(days.map((day) => day.date)).toEqual([WEDNESDAY]);
  });

  it('walks across a month end and a year end', async () => {
    expect((await find('2026-10-30', '2026-11-02')).map((day) => day.date)).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect((await find('2026-12-31', '2027-01-01')).map((day) => day.date)).toEqual(['2026-12-31', '2027-01-01']);
  });

  it('returns ISO-8601 UTC instants two hours behind Kigali wall time', async () => {
    const [day] = await find(WEDNESDAY);

    expect(day?.starts[0]).toBe('2026-10-07T07:00:00.000Z');
    expect(day?.starts.at(-1)).toBe('2026-10-07T14:00:00.000Z');
  });

  it('fits the package duration it is given', async () => {
    expect((await startTimes(WEDNESDAY, { packageDurationMinutes: 120 })).at(-1)).toBe('15:00');
  });
});

describe('an invalid range', () => {
  it.each(['2026-02-30', '10/10/2026', '2026-10-7', '2026-10-07T00:00:00Z', '', 'not-a-date'])(
    'rejects %j as either end with a RangeError',
    async (bad) => {
      await expect(find(bad, WEDNESDAY)).rejects.toThrow(RangeError);
      await expect(find(WEDNESDAY, bad)).rejects.toThrow(RangeError);
    },
  );

  it('rejects a range that ends before it starts with a RangeError', async () => {
    await expect(find(THURSDAY, WEDNESDAY)).rejects.toThrow(RangeError);
  });
});

// --- What gets loaded ---------------------------------------------------------------

describe('working hours loaded for the range', () => {
  it('honours dated overrides on the first and last date of the range', async () => {
    for (const date of [MONDAY, FRIDAY]) {
      await prisma.workingHours.create({ data: { photographerId, effectiveDate: new Date(`${date}T00:00:00Z`), isOpen: false } });
    }

    expect(await offered(MONDAY, FRIDAY)).toEqual({
      [MONDAY]: [],
      [TUESDAY]: FULL_DAY,
      [WEDNESDAY]: FULL_DAY,
      [THURSDAY]: FULL_DAY,
      [FRIDAY]: [],
    });
  });
});

describe('blocks loaded for the range', () => {
  it('subtracts a block that began the evening before the range', async () => {
    await prisma.availabilityBlock.create({
      data: { photographerId, startsAt: kigali(TUESDAY, '20:00'), endsAt: kigali(WEDNESDAY, '10:00') },
    });

    expect(await startTimes(WEDNESDAY)).toEqual(FULL_DAY.slice(FULL_DAY.indexOf('10:00')));
  });

  it('subtracts a block that runs on past the end of the range', async () => {
    await prisma.availabilityBlock.create({
      data: { photographerId, startsAt: kigali(WEDNESDAY, '16:00'), endsAt: kigali(THURSDAY, '12:00') },
    });

    expect((await startTimes(WEDNESDAY)).at(-1)).toBe('15:00');
  });

  it('ignores a block ending exactly at Kigali midnight as the range begins', async () => {
    await openAllDay(WEDNESDAY);
    await prisma.availabilityBlock.create({
      data: { photographerId, startsAt: kigali(TUESDAY, '09:00'), endsAt: kigali(WEDNESDAY, '00:00') },
    });

    expect((await startTimes(WEDNESDAY))[0]).toBe('00:00');
  });
});

describe('bookings loaded for the range', () => {
  it('makes 10:30 the first free start after a confirmed 09:00–10:00 booking buffered to 10:30', async () => {
    await insertBooking(on(WEDNESDAY, '09:00', '10:00', '10:30'));

    expect(await startTimes(WEDNESDAY)).toEqual(FULL_DAY.slice(FULL_DAY.indexOf('10:30')));
  });

  it('holds a booking to its own buffer_ends_at, not the buffer in force now', async () => {
    // Snapshotted with a 60-minute buffer; the setting says 30.
    await insertBooking(on(WEDNESDAY, '09:00', '10:00', '11:00'));

    expect((await startTimes(WEDNESDAY))[0]).toBe('11:00');
  });

  it('occupies the slot while a pending_payment hold is live', async () => {
    await insertBooking({
      ...on(WEDNESDAY, '09:00', '10:00', '10:30'),
      status: 'pending_payment',
      holdExpiresAt: new Date(NOW.getTime() + MINUTE_MS),
    });

    expect((await startTimes(WEDNESDAY))[0]).toBe('10:30');
  });

  it('frees the slot once a pending_payment hold has lapsed, with no sweeper run', async () => {
    await insertBooking({
      ...on(WEDNESDAY, '09:00', '10:00', '10:30'),
      status: 'pending_payment',
      holdExpiresAt: new Date(NOW.getTime() - MINUTE_MS),
    });

    expect(await startTimes(WEDNESDAY)).toEqual(FULL_DAY);
  });

  it.each(['completed', 'no_show'])('occupies the slot for a %s booking', async (status) => {
    await insertBooking({ ...on(WEDNESDAY, '09:00', '10:00', '10:30'), status });

    expect((await startTimes(WEDNESDAY))[0]).toBe('10:30');
  });

  it.each(['expired', 'cancelled_by_client', 'cancelled_by_photographer'])(
    'frees the slot for a %s booking',
    async (status) => {
      await insertBooking({ ...on(WEDNESDAY, '09:00', '10:00', '10:30'), status });

      expect(await startTimes(WEDNESDAY)).toEqual(FULL_DAY);
    },
  );

  it('keeps a late start clear of a booking that begins just after the range ends', async () => {
    // A 23:00 start reserves to 00:30 with its buffer, into Thursday's 00:00
    // booking -- which lies outside [Wednesday], and must still be loaded.
    await openAllDay(WEDNESDAY);
    await insertBooking(on(THURSDAY, '00:00', '01:00', '01:30'));

    const starts = await startTimes(WEDNESDAY);

    expect(starts.at(-1)).toBe('22:30');
    expect(starts).not.toContain('23:00');
  });

  it('ignores a booking whose buffer ended exactly as the range began', async () => {
    await openAllDay(WEDNESDAY);
    await insertBooking({
      startsAt: kigali(TUESDAY, '22:30'),
      endsAt: kigali(TUESDAY, '23:30'),
      bufferEndsAt: kigali(WEDNESDAY, '00:00'),
    });

    expect((await startTimes(WEDNESDAY))[0]).toBe('00:00');
  });
});

// --- Lead time and the settings screen -----------------------------------------------

describe('operating values', () => {
  it('withholds starts sooner than now plus the minimum lead time', async () => {
    expect(await startTimes(WEDNESDAY, { now: kigali(WEDNESDAY, '14:00') })).toEqual(['16:00']);
  });

  it('reads the lead time afresh on every call, so a settings edit applies at once', async () => {
    const now = kigali(WEDNESDAY, '10:00');
    expect((await startTimes(WEDNESDAY, { now }))[0]).toBe('12:00');

    await updatePhotographerSettings(photographerId, { minLeadTimeMinutes: 0 }, prisma);

    expect((await startTimes(WEDNESDAY, { now }))[0]).toBe('10:00');
  });

  it('applies a changed buffer to new candidates, never to the booking already made', async () => {
    await insertBooking(on(WEDNESDAY, '12:00', '13:00', '13:30'));
    const afternoon = FULL_DAY.slice(FULL_DAY.indexOf('13:30'));

    // Buffer 30: a 10:30 start reserves to 12:00, touching the booking.
    expect(await startTimes(WEDNESDAY)).toEqual(['09:00', '09:30', '10:00', '10:30', ...afternoon]);

    await updatePhotographerSettings(photographerId, { bufferMinutes: 60 }, prisma);

    // Buffer 60: 10:30 would now reserve to 12:30. The booking still frees
    // 13:30, because its own buffer end did not move.
    expect(await startTimes(WEDNESDAY)).toEqual(['09:00', '09:30', '10:00', ...afternoon]);
  });
});

// --- Per photographer (marketplace-spec.md T1.4) ------------------------------------------

describe('another photographer’s calendar', () => {
  let otherId: string;

  beforeEach(async () => {
    ({ photographerId: otherId } = await createPhotographer(prisma, {
      email: 'other@bookly.example',
      handle: 'hills-and-light',
      displayName: 'Hills & Light',
    }));
  });

  it('leaves this photographer’s calendar exactly as it was, whatever the other has', async () => {
    const before = await offered(MONDAY, SUNDAY);

    // The other photographer works every day round the clock, is closed on
    // Wednesday, has blocked Thursday, holds a booking or a live hold on every
    // weekday morning, and works with no lead time and a two-hour buffer.
    for (const date of [MONDAY, TUESDAY, FRIDAY, SATURDAY, SUNDAY]) await openAllDay(date, otherId);
    await prisma.workingHours.create({ data: { photographerId: otherId, effectiveDate: new Date(`${WEDNESDAY}T00:00:00Z`), isOpen: false } });
    await prisma.availabilityBlock.create({ data: { photographerId: otherId, startsAt: kigali(THURSDAY, '00:00'), endsAt: kigali(FRIDAY, '00:00') } });
    for (const date of [MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY]) {
      await insertBooking(on(date, '09:00', '10:00', '12:00'), otherId);
    }
    await insertBooking(
      { ...on(MONDAY, '14:00', '15:00', '15:30'), status: 'pending_payment', holdExpiresAt: new Date(NOW.getTime() + MINUTE_MS) },
      otherId,
    );
    await updatePhotographerSettings(otherId, { minLeadTimeMinutes: 0, bufferMinutes: 120 }, prisma);

    expect(await offered(MONDAY, SUNDAY)).toEqual(before);
    expect(before[WEDNESDAY]).toEqual(FULL_DAY);
    expect(before[SATURDAY]).toEqual([]);
  });

  it('is computed from the other photographer’s own rows when asked for', async () => {
    await weekdayHours(otherId);
    await insertBooking(on(WEDNESDAY, '09:00', '10:00', '10:30'), otherId);
    await prisma.availabilityBlock.create({ data: { photographerId: otherId, startsAt: kigali(WEDNESDAY, '15:00'), endsAt: kigali(WEDNESDAY, '17:00') } });

    expect(await startTimes(WEDNESDAY, { photographerId: otherId })).toEqual(FULL_DAY.slice(FULL_DAY.indexOf('10:30'), FULL_DAY.indexOf('14:30')));
    expect(await startTimes(WEDNESDAY)).toEqual(FULL_DAY);
  });

  it('offers nothing for a photographer with no working hours, whoever else is open', async () => {
    expect(await offered(MONDAY, FRIDAY, { photographerId: otherId })).toEqual({
      [MONDAY]: [],
      [TUESDAY]: [],
      [WEDNESDAY]: [],
      [THURSDAY]: [],
      [FRIDAY]: [],
    });
  });

  it('reads each photographer’s lead time and buffer, not the other’s', async () => {
    await weekdayHours(otherId);
    await updatePhotographerSettings(otherId, { minLeadTimeMinutes: 0 }, prisma);
    const now = kigali(WEDNESDAY, '10:00');

    expect((await startTimes(WEDNESDAY, { now }))[0]).toBe('12:00');
    expect((await startTimes(WEDNESDAY, { now, photographerId: otherId }))[0]).toBe('10:00');
  });
});

// --- Many photographers' single day (the directory's date filter, R6.1) ----------------

describe('findDayStartsFor', () => {
  let otherId: string;
  let thirdId: string;

  beforeEach(async () => {
    ({ photographerId: otherId } = await createPhotographer(prisma, { email: 'other@bookly.example', handle: 'hills-and-light', displayName: 'Hills & Light' }));
    ({ photographerId: thirdId } = await createPhotographer(prisma, { email: 'third@bookly.example', handle: 'amahoro-studio', displayName: 'Amahoro' }));
    await weekdayHours(otherId);
  });

  /** findAvailability's starts for one photographer and date, the reference the batch must equal. */
  async function reference(owner: string, date: string, packageDurationMinutes: number, now = NOW): Promise<string[]> {
    const [day] = await findAvailability(prisma, { photographerId: owner, from: date, to: date, packageDurationMinutes, now });
    return day?.starts ?? [];
  }

  it('equals findAvailability photographer by photographer, each with their own rows, settings and package length', async () => {
    // This photographer: a booking, a block and a dated override on Thursday.
    await insertBooking(on(WEDNESDAY, '09:00', '10:00', '10:30'));
    await prisma.availabilityBlock.create({ data: { photographerId, startsAt: kigali(WEDNESDAY, '15:00'), endsAt: kigali(WEDNESDAY, '17:00') } });
    await prisma.workingHours.create({ data: { photographerId, effectiveDate: new Date(`${THURSDAY}T00:00:00Z`), opensMinute: 600, closesMinute: 720 } });
    // The other: a long buffer, no lead time, a booking at noon that this photographer's rows never see.
    await updatePhotographerSettings(otherId, { minLeadTimeMinutes: 0, bufferMinutes: 120 }, prisma);
    await insertBooking(on(WEDNESDAY, '12:00', '13:00', '15:00'), otherId);
    // The third works Saturdays only, round the clock, with a block crossing into Sunday.
    await openAllDay(SATURDAY, thirdId);
    await prisma.availabilityBlock.create({ data: { photographerId: thirdId, startsAt: kigali(SATURDAY, '20:00'), endsAt: kigali(SUNDAY, '04:00') } });

    for (const date of [MONDAY, WEDNESDAY, THURSDAY, SATURDAY, SUNDAY]) {
      for (const now of [NOW, kigali(WEDNESDAY, '11:20')]) {
        const request = [
          { photographerId, packageDurationMinutes: 60 },
          { photographerId: otherId, packageDurationMinutes: 90 },
          { photographerId: thirdId, packageDurationMinutes: 240 },
        ];
        const batch = await findDayStartsFor(prisma, { date, now, photographers: request });
        for (const entry of request) {
          const label = `${entry.photographerId} on ${date} at ${now.toISOString()}`;
          expect((batch.get(entry.photographerId) ?? []).map((start) => start.toISOString()), label).toEqual(
            await reference(entry.photographerId, date, entry.packageDurationMinutes, now),
          );
        }
      }
    }
  });

  it("collides a late candidate with a booking inside the photographer's own buffer, loaded up to the longest buffer of the batch", async () => {
    // Open until midnight, and booked at 00:10 the next day: a 23:00 candidate's own 30-minute buffer runs into it.
    await openAllDay(WEDNESDAY);
    await updatePhotographerSettings(otherId, { bufferMinutes: 240 }, prisma);
    await insertBooking({ startsAt: kigali(THURSDAY, '00:10'), endsAt: kigali(THURSDAY, '01:00'), bufferEndsAt: kigali(THURSDAY, '01:30') });

    const batch = await findDayStartsFor(prisma, {
      date: WEDNESDAY,
      now: NOW,
      photographers: [
        { photographerId, packageDurationMinutes: 60 },
        { photographerId: otherId, packageDurationMinutes: 60 },
      ],
    });

    expect((batch.get(photographerId) ?? []).map((start) => start.toISOString())).toEqual(await reference(photographerId, WEDNESDAY, 60));
    // 22:30 reserves to 00:00 (no collision), 23:00 to 00:30 (collides with the 00:10 booking).
    expect((batch.get(photographerId) ?? []).map((start) => kigaliTime(start.toISOString())).slice(-2)).toEqual(['22:00', '22:30']);
  });

  it('answers an empty map for no photographers, and an empty list for a photographer with no hours', async () => {
    await expect(findDayStartsFor(prisma, { date: WEDNESDAY, now: NOW, photographers: [] })).resolves.toEqual(new Map());

    const batch = await findDayStartsFor(prisma, { date: WEDNESDAY, now: NOW, photographers: [{ photographerId: thirdId, packageDurationMinutes: 60 }] });
    expect(batch.get(thirdId)).toEqual([]);
  });

  it('refuses a malformed date and a photographer id without a settings row', async () => {
    await expect(findDayStartsFor(prisma, { date: '2026-02-30', now: NOW, photographers: [{ photographerId, packageDurationMinutes: 60 }] })).rejects.toThrow(RangeError);
    await expect(
      findDayStartsFor(prisma, { date: WEDNESDAY, now: NOW, photographers: [{ photographerId: '00000000-0000-4000-8000-000000000000', packageDurationMinutes: 60 }] }),
    ).rejects.toThrow(/no settings row/);
  });
});
