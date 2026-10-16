import { OCCUPYING_STATUSES } from '../db/statuses.js';
import { SLOT_GRANULARITY_MINUTES } from '../settings/constants.js';

/**
 * The availability engine (plan.md Task 5, data-model_v2.md §8).
 *
 * Everything a visitor sees on the calendar comes from here. It is a pure
 * function: it takes rows and a clock, touches no Prisma client, and opens no
 * database connection. Task 12 queries the rows and hands them over; this module
 * decides what is offerable.
 */

/** A Kigali calendar date, `YYYY-MM-DD`. Not an instant -- a day on his wall. */
export type KigaliDate = string;

/**
 * UTC+2, no DST (spec §6.5), which is why the arithmetic below is a fixed
 * offset rather than a timezone library. `working_hours` minutes are Kigali wall
 * time; every instant in and out of here is UTC.
 */
const KIGALI_UTC_OFFSET_MINUTES = 120;

const MS_PER_MINUTE = 60_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Shapes structurally satisfied by the matching Prisma rows. */
export type WorkingHoursRow = {
  weekday: number | null;
  effectiveDate: Date | null;
  opensMinute: number | null;
  closesMinute: number | null;
  isOpen: boolean;
};

export type AvailabilityBlockRow = {
  startsAt: Date;
  endsAt: Date;
};

export type BookingRow = {
  status: string;
  startsAt: Date;
  /** The booking's own snapshotted buffer end -- not recomputed from settings. */
  bufferEndsAt: Date;
  holdExpiresAt: Date | null;
};

export type AvailabilityOptions = {
  date: KigaliDate;
  packageDurationMinutes: number;
  workingHours: readonly WorkingHoursRow[];
  blocks: readonly AvailabilityBlockRow[];
  bookings: readonly BookingRow[];
  minLeadTimeMinutes: number;
  /** The buffer in force NOW, applied to the candidate. Existing bookings carry
   *  their own (data-model_v2.md §5.9). */
  bufferMinutes: number;
  /** The injected clock. */
  now: Date;
};

/**
 * Offerable start instants for one Kigali date, in ascending order.
 *
 * Follows the five-step resolution order of data-model_v2.md §8: resolve the
 * open window, subtract blocks, subtract occupancy through each booking's
 * buffer, apply lead time, then keep grid starts where the session fits before
 * closing.
 */
export function availableStarts(options: AvailabilityOptions): Date[] {
  const {
    date,
    packageDurationMinutes,
    workingHours,
    blocks,
    bookings,
    minLeadTimeMinutes,
    bufferMinutes,
    now,
  } = options;

  assertKigaliDate(date);

  // Step 1 -- open window. A closed day ends the evaluation.
  const window = resolveWindow(date, workingHours);
  if (window === null) return [];

  // A package that cannot fit the window produces nothing at all, rather than an
  // empty calendar with no explanation (spec §6.8; the admin is warned at
  // Task 10, on the package itself).
  if (packageDurationMinutes <= 0) return [];

  const occupying = bookings.filter((booking) => occupiesTime(booking, now));
  const earliestStart = new Date(now.getTime() + minLeadTimeMinutes * MS_PER_MINUTE);

  // Step 5, applied as generation: starts sit on the granularity grid measured
  // from Kigali midnight, not from opens_minute, so a window opening at an
  // off-grid minute still yields on-grid starts.
  const firstGridMinute =
    Math.ceil(window.opensMinute / SLOT_GRANULARITY_MINUTES) * SLOT_GRANULARITY_MINUTES;

  const starts: Date[] = [];

  for (
    let minute = firstGridMinute;
    // Fit is measured on the session alone. The buffer may run past closing --
    // it blocks nothing after the day ends (spec §6.7).
    minute + packageDurationMinutes <= window.closesMinute;
    minute += SLOT_GRANULARITY_MINUTES
  ) {
    const startsAt = kigaliMinuteToUtc(date, minute);

    // Step 4 -- lead time.
    if (startsAt < earliestStart) continue;

    const endsAt = addMinutes(startsAt, packageDurationMinutes);

    // Step 2 -- blocks, against the session only. A block is time he is not
    // working; the trailing buffer is slack, and §8 extends the buffer rule to
    // bookings alone.
    if (blocks.some((block) => overlaps(startsAt, endsAt, block.startsAt, block.endsAt))) {
      continue;
    }

    // Step 3 -- occupancy. The candidate reserves its session AND its trailing
    // buffer, because the database excludes on [starts_at, buffer_ends_at) and
    // that constraint is symmetric: a candidate ending exactly when an existing
    // booking starts would be accepted here and then rejected with 23P01.
    const candidateReservedUntil = addMinutes(endsAt, bufferMinutes);
    const collides = occupying.some((booking) =>
      overlaps(startsAt, candidateReservedUntil, booking.startsAt, booking.bufferEndsAt),
    );
    if (collides) continue;

    starts.push(startsAt);
  }

  return starts;
}

/**
 * Step 1. A dated row wins outright for its date; otherwise the weekday row
 * applies; otherwise the day is closed (data-model_v2.md §5.3). One dated row
 * opens a Saturday that has no weekly rule, and one dated row with
 * `is_open = false` closes a Wednesday that does -- both directions, one
 * mechanism, and the fix for R-4.
 */
function resolveWindow(
  date: KigaliDate,
  workingHours: readonly WorkingHoursRow[],
): { opensMinute: number; closesMinute: number } | null {
  const dated = workingHours.find(
    (row) => row.effectiveDate !== null && toKigaliDate(row.effectiveDate) === date,
  );
  const weekly = workingHours.find(
    (row) => row.effectiveDate === null && row.weekday === kigaliWeekday(date),
  );

  const row = dated ?? weekly;
  if (row === undefined || !row.isOpen) return null;
  if (row.opensMinute === null || row.closesMinute === null) return null;
  if (row.closesMinute <= row.opensMinute) return null;

  return { opensMinute: row.opensMinute, closesMinute: row.closesMinute };
}

/**
 * Whether a booking still holds its slot (data-model_v2.md §7.1). A
 * `pending_payment` booking holds only while its hold is live: once it lapses
 * the claim transaction will expire it in-transaction rather than defer to the
 * sweeper (§9.2), so showing that time as taken would deny a slot the database
 * would grant.
 */
function occupiesTime(booking: BookingRow, now: Date): boolean {
  if (!(OCCUPYING_STATUSES as readonly string[]).includes(booking.status)) return false;
  if (booking.status !== 'pending_payment') return true;
  return booking.holdExpiresAt !== null && booking.holdExpiresAt > now;
}

/** Half-open `[start, end)` overlap, matching the exclusion constraint's `'[)'`. */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MS_PER_MINUTE);
}

/** Minutes since Kigali midnight on `date`, as a UTC instant. `1440` is the
 *  next day's midnight, which is how a whole day's end is expressed. */
export function kigaliMinuteToUtc(date: KigaliDate, minutesFromMidnight: number): Date {
  const { year, month, day } = splitDate(date);
  return new Date(
    Date.UTC(year, month - 1, day, 0, minutesFromMidnight - KIGALI_UTC_OFFSET_MINUTES),
  );
}

/** 0 = Sunday ... 6 = Saturday, for the Kigali calendar date. */
function kigaliWeekday(date: KigaliDate): number {
  const { year, month, day } = splitDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The Kigali calendar date an instant falls on. */
export function kigaliDateOf(instant: Date): KigaliDate {
  return toKigaliDate(new Date(instant.getTime() + KIGALI_UTC_OFFSET_MINUTES * MS_PER_MINUTE));
}

/** Prisma reads a `@db.Date` as UTC midnight, so the date part is the day. */
function toKigaliDate(value: Date): KigaliDate {
  return value.toISOString().slice(0, 10);
}

function splitDate(date: KigaliDate): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

export function assertKigaliDate(date: KigaliDate): void {
  if (!DATE_PATTERN.test(date)) {
    throw new RangeError(`Expected a YYYY-MM-DD Kigali date, received: ${date}`);
  }
  const { year, month, day } = splitDate(date);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (toKigaliDate(roundTrip) !== date) {
    throw new RangeError(`Not a real calendar date: ${date}`);
  }
}
