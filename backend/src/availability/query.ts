import type { PrismaClient } from '@prisma/client';
import { OCCUPYING_STATUSES } from '../db/statuses.js';
import { getSettings } from '../settings/index.js';
import { type KigaliDate, assertKigaliDate, availableStarts, kigaliMinuteToUtc } from './engine.js';

/**
 * The database side of availability (plan.md Task 8): loads the rows the pure
 * engine needs for a run of Kigali dates, reads the operating values through
 * `getSettings()`, and returns what a visitor may see.
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
  const { from, to, packageDurationMinutes, now } = options;
  const dates = kigaliDatesBetween(from, to);

  const rangeStart = kigaliMinuteToUtc(from, 0);
  const rangeEnd = kigaliMinuteToUtc(to, MINUTES_PER_DAY);
  const { minLeadTimeMinutes, bufferMinutes } = await getSettings(prisma);

  const [workingHours, blocks, bookings] = await Promise.all([
    prisma.workingHours.findMany({
      where: {
        OR: [
          { effectiveDate: null },
          { effectiveDate: { gte: utcMidnight(from), lte: utcMidnight(to) } },
        ],
      },
      select: {
        weekday: true,
        effectiveDate: true,
        opensMinute: true,
        closesMinute: true,
        isOpen: true,
      },
    }),
    prisma.availabilityBlock.findMany({
      where: { startsAt: { lt: rangeEnd }, endsAt: { gt: rangeStart } },
      select: { startsAt: true, endsAt: true },
    }),
    prisma.booking.findMany({
      where: {
        status: { in: [...OCCUPYING_STATUSES] },
        bufferEndsAt: { gt: rangeStart },
        // A candidate near the last closing reserves its own buffer past it, so
        // a booking starting inside that buffer still collides.
        startsAt: { lt: new Date(rangeEnd.getTime() + bufferMinutes * MS_PER_MINUTE) },
      },
      select: { status: true, startsAt: true, bufferEndsAt: true, holdExpiresAt: true },
    }),
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
