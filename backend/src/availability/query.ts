import type { Prisma, PrismaClient } from '@prisma/client';
import { OCCUPYING_STATUSES } from '../db/statuses.js';
import { getPhotographerSettings, getPhotographerSettingsFor } from '../settings/index.js';
import { type KigaliDate, assertKigaliDate, availableStarts, kigaliMinuteToUtc } from './engine.js';

/**
 * The database side of availability (plan.md Task 8): loads the rows the pure
 * engine needs for a run of Kigali dates, reads the operating values through
 * `getPhotographerSettings()`, and returns what a visitor may see.
 *
 * One photographer's calendar at a time (marketplace-spec.md T1.4): their
 * working hours, their blocks, their bookings and their lead time and buffer.
 * Another photographer's busy afternoon is nobody else's: each photographer
 * books their own time, and the exclusion constraint is per photographer too.
 *
 * The result is the PUBLIC projection -- dates and start instants, nothing
 * else. Block reasons, booking ids and client names are never selected from the
 * database, so no serialiser downstream can leak them (spec P-03). Task 12's
 * route is expected to return this unchanged.
 */

export type DayAvailability = {
  date: KigaliDate;
  /** ISO-8601 UTC instants, ascending. */
  starts: string[];
};

export type FindAvailabilityOptions = {
  /** Whose calendar: the package's photographer, never a value from the request (R1.4). */
  photographerId: string;
  /** First Kigali date, inclusive. */
  from: KigaliDate;
  /** Last Kigali date, inclusive. */
  to: KigaliDate;
  packageDurationMinutes: number;
  /** The injected clock. */
  now: Date;
};

const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60_000;

export async function findAvailability(
  prisma: PrismaClient,
  options: FindAvailabilityOptions,
): Promise<DayAvailability[]> {
  const { photographerId, from, to, packageDurationMinutes, now } = options;
  const dates = kigaliDatesBetween(from, to);

  const rangeStart = kigaliMinuteToUtc(from, 0);
  const rangeEnd = kigaliMinuteToUtc(to, MINUTES_PER_DAY);
  const { minLeadTimeMinutes, bufferMinutes } = await getPhotographerSettings(photographerId, prisma);

  const [workingHours, blocks, bookings] = await Promise.all([
    prisma.workingHours.findMany({ where: workingHoursWhere(photographerId, from, to), select: WORKING_HOURS_SELECT }),
    prisma.availabilityBlock.findMany({ where: blocksWhere(photographerId, rangeStart, rangeEnd), select: BLOCK_SELECT }),
    prisma.booking.findMany({ where: bookingsWhere(photographerId, rangeStart, rangeEnd, bufferMinutes), select: BOOKING_SELECT }),
  ]);

  return dates.map((date) => ({
    date,
    starts: availableStarts({
      date,
      packageDurationMinutes,
      workingHours,
      blocks,
      bookings,
      minLeadTimeMinutes,
      bufferMinutes,
      now,
    }).map((start) => start.toISOString()),
  }));
}

/**
 * The rows that reach the engine, one definition for one photographer's month
 * and for a page of photographers' single day (the directory, R6.1), so the
 * two can never load differently. `photographerId` is one id or several.
 */
type PhotographerScope = string | { in: string[] };

function workingHoursWhere(photographerId: PhotographerScope, from: KigaliDate, to: KigaliDate): Prisma.WorkingHoursWhereInput {
  return {
    photographerId,
    OR: [{ effectiveDate: null }, { effectiveDate: { gte: utcMidnight(from), lte: utcMidnight(to) } }],
  };
}

function blocksWhere(photographerId: PhotographerScope, rangeStart: Date, rangeEnd: Date): Prisma.AvailabilityBlockWhereInput {
  return { photographerId, startsAt: { lt: rangeEnd }, endsAt: { gt: rangeStart } };
}

function bookingsWhere(photographerId: PhotographerScope, rangeStart: Date, rangeEnd: Date, bufferMinutes: number): Prisma.BookingWhereInput {
  return {
    photographerId,
    status: { in: [...OCCUPYING_STATUSES] },
    bufferEndsAt: { gt: rangeStart },
    // A candidate near the last closing reserves its own buffer past it, so
    // a booking starting inside that buffer still collides.
    startsAt: { lt: new Date(rangeEnd.getTime() + bufferMinutes * MS_PER_MINUTE) },
  };
}

const WORKING_HOURS_SELECT = { weekday: true, effectiveDate: true, opensMinute: true, closesMinute: true, isOpen: true } as const;
const BLOCK_SELECT = { startsAt: true, endsAt: true } as const;
const BOOKING_SELECT = { status: true, startsAt: true, bufferEndsAt: true, holdExpiresAt: true } as const;

export type DayStartsRequest = {
  /** Whose calendars, each with the package length to fit: ids the caller resolved from listed rows, never from the request. */
  photographers: readonly { photographerId: string; packageDurationMinutes: number }[];
  date: KigaliDate;
  /** The injected clock. */
  now: Date;
};

/**
 * One Kigali date's offerable starts for many photographers at once, keyed by
 * photographer id (marketplace-spec.md R6.1: the directory's date filter runs
 * the engine on a page of candidates). Exactly `findAvailability` for that date,
 * photographer by photographer -- the same row filters, the same engine, each
 * photographer's own settings, hours, blocks and bookings (T1.4) -- in four
 * queries instead of four per photographer.
 *
 * Bookings are loaded up to the LONGEST buffer among them; a row that turns
 * out to lie past a photographer's own buffer cannot collide with any of their
 * candidates, which the engine measures exactly, so loading it changes nothing.
 */
export async function findDayStartsFor(prisma: PrismaClient, request: DayStartsRequest): Promise<Map<string, Date[]>> {
  const { photographers, date, now } = request;
  assertKigaliDate(date);
  if (photographers.length === 0) return new Map();

  const ids = [...new Set(photographers.map((entry) => entry.photographerId))];
  const scope = { in: ids };
  const rangeStart = kigaliMinuteToUtc(date, 0);
  const rangeEnd = kigaliMinuteToUtc(date, MINUTES_PER_DAY);
  const settings = await getPhotographerSettingsFor(ids, prisma);
  const longestBuffer = Math.max(...[...settings.values()].map((entry) => entry.bufferMinutes));

  const [workingHours, blocks, bookings] = await Promise.all([
    prisma.workingHours.findMany({ where: workingHoursWhere(scope, date, date), select: { ...WORKING_HOURS_SELECT, photographerId: true } }),
    prisma.availabilityBlock.findMany({ where: blocksWhere(scope, rangeStart, rangeEnd), select: { ...BLOCK_SELECT, photographerId: true } }),
    prisma.booking.findMany({ where: bookingsWhere(scope, rangeStart, rangeEnd, longestBuffer), select: { ...BOOKING_SELECT, photographerId: true } }),
  ]);

  const result = new Map<string, Date[]>();
  for (const { photographerId, packageDurationMinutes } of photographers) {
    const own = settings.get(photographerId);
    if (own === undefined) throw new Error(`photographer ${photographerId} has no settings row`);
    result.set(
      photographerId,
      availableStarts({
        date,
        packageDurationMinutes,
        workingHours: workingHours.filter((row) => row.photographerId === photographerId),
        blocks: blocks.filter((row) => row.photographerId === photographerId),
        bookings: bookings.filter((row) => row.photographerId === photographerId),
        minLeadTimeMinutes: own.minLeadTimeMinutes,
        bufferMinutes: own.bufferMinutes,
        now,
      }),
    );
  }
  return result;
}

/** Every Kigali date from `from` to `to`, inclusive. */
function kigaliDatesBetween(from: KigaliDate, to: KigaliDate): KigaliDate[] {
  assertKigaliDate(from);
  assertKigaliDate(to);
  if (to < from) throw new RangeError(`Date range ends before it starts: ${from} to ${to}`);

  const dates: KigaliDate[] = [];
  for (let day = utcMidnight(from); day <= utcMidnight(to); day = addUtcDay(day)) {
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

/** A date as `@db.Date` stores it: UTC midnight. */
function utcMidnight(date: KigaliDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

function addUtcDay(day: Date): Date {
  return new Date(day.getTime() + MINUTES_PER_DAY * MS_PER_MINUTE);
}
