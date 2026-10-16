import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  AvailabilityBlockRow,
  AvailabilityOptions,
  BookingRow,
  KigaliDate,
  WorkingHoursRow,
} from './engine.js';
import { availableStarts } from './engine.js';

/**
 * Unit tests for the availability engine (plan.md Task 5, data-model_v2.md §8).
 *
 * No database, no Prisma, no network: the engine takes rows and a clock as plain
 * arguments, and the last describe block proves that statically.
 */

// --- Fixtures ---------------------------------------------------------------

/** Kigali is UTC+2 with no DST (spec §6.5), so the offset is a constant. */
const KIGALI_OFFSET_MINUTES = 120;
const MS_PER_MINUTE = 60_000;

const MONDAY = '2026-10-05';
const TUESDAY = '2026-10-06';
const WEDNESDAY = '2026-10-07';
const THURSDAY = '2026-10-08';
const FRIDAY = '2026-10-09';
const SATURDAY = '2026-10-10';
const NEXT_WEDNESDAY = '2026-10-14';
const NEXT_SATURDAY = '2026-10-17';

/** Statuses that hold their slot, per data-model_v2.md §7.1. Spelled out here
 *  rather than imported, so drift in the vocabulary fails this suite too. */
const OCCUPYING = ['pending_payment', 'confirmed', 'completed', 'no_show'] as const;
const FREEING = ['expired', 'cancelled_by_client', 'cancelled_by_admin'] as const;

/** The seeded weekly rule: Mon–Fri 09:00–17:00 Kigali (spec §A-10, §6.6). */
const WEEKDAY_HOURS: readonly WorkingHoursRow[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  effectiveDate: null,
  opensMinute: 540,
  closesMinute: 1020,
  isOpen: true,
}));

/** Every 30-minute start a 60-minute package fits into a 09:00–17:00 day. */
const FULL_WEDNESDAY = [
  '09:00',
  '09:30',
  '10:00',
  '10:30',
  '11:00',
  '11:30',
  '12:00',
  '12:30',
  '13:00',
  '13:30',
  '14:00',
  '14:30',
  '15:00',
  '15:30',
  '16:00',
];

// --- Helpers ----------------------------------------------------------------

/** A Kigali wall-clock time on `date`, as the UTC instant the engine speaks in. */
function kigali(date: KigaliDate, wallTime: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = wallTime.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1, day, hour, minute - KIGALI_OFFSET_MINUTES));
}

/** Kigali wall times of the returned instants, for expectations that read aloud. */
function toKigaliTimes(starts: readonly Date[]): string[] {
  return starts.map((start) =>
    new Date(start.getTime() + KIGALI_OFFSET_MINUTES * MS_PER_MINUTE).toISOString().slice(11, 16),
  );
}

/** Well before every fixture date, so lead time only bites when a test says so. */
function dayBefore(date: KigaliDate): Date {
  return new Date(kigali(date, '00:00').getTime() - 24 * 60 * MS_PER_MINUTE);
}

function options(overrides: Partial<AvailabilityOptions> = {}): AvailabilityOptions {
  const date = overrides.date ?? WEDNESDAY;
  return {
    date,
    packageDurationMinutes: 60,
    workingHours: WEEKDAY_HOURS,
    blocks: [],
    bookings: [],
    minLeadTimeMinutes: 120,
    bufferMinutes: 30,
    now: dayBefore(date),
    ...overrides,
  };
}

function starts(overrides: Partial<AvailabilityOptions> = {}): Date[] {
  return availableStarts(options(overrides));
}

function startTimes(overrides: Partial<AvailabilityOptions> = {}): string[] {
  return toKigaliTimes(starts(overrides));
}

function dated(date: KigaliDate, row: Partial<WorkingHoursRow> = {}): WorkingHoursRow {
  return {
    weekday: null,
    // Prisma reads a `@db.Date` as UTC midnight (data-model_v2.md §5.3).
    effectiveDate: new Date(`${date}T00:00:00Z`),
    opensMinute: 540,
    closesMinute: 1020,
    isOpen: true,
    ...row,
  };
}

function block(
  fromDate: KigaliDate,
  fromTime: string,
  toDate: KigaliDate,
  toTime: string,
): AvailabilityBlockRow {
  return { startsAt: kigali(fromDate, fromTime), endsAt: kigali(toDate, toTime) };
}

/** A same-day block, the common case. */
function dayBlock(date: KigaliDate, fromTime: string, toTime: string): AvailabilityBlockRow {
  return block(date, fromTime, date, toTime);
}

/**
 * A booking on `date` running `from`–`to` Kigali, reserving through `bufferEnd`.
 * `bufferEndsAt` is the booking's own snapshot, never recomputed (§5.9, §9.5).
 */
function booking(
  date: KigaliDate,
  from: string,
  bufferEnd: string,
  row: Partial<BookingRow> = {},
): BookingRow {
  return {
    status: 'confirmed',
    startsAt: kigali(date, from),
    bufferEndsAt: kigali(date, bufferEnd),
    holdExpiresAt: null,
    ...row,
  };
}

// --- 1. Open window ---------------------------------------------------------

describe('the open window', () => {
  it('offers every grid start on a Wednesday, because Mon–Fri 09:00–17:00 is seeded', () => {
    expect(startTimes({ date: WEDNESDAY })).toEqual(FULL_WEDNESDAY);
  });

  it('offers nothing on a Saturday, because no weekday row exists and no row means closed', () => {
    expect(starts({ date: SATURDAY })).toEqual([]);
  });

  it('offers nothing on a Sunday for the same reason', () => {
    expect(starts({ date: '2026-10-11' })).toEqual([]);
  });

  it('returns UTC instants two hours behind the Kigali wall time', () => {
    // 09:00 Kigali is 07:00Z; 16:00 Kigali is 14:00Z (spec §6.5).
    const offered = starts({ date: WEDNESDAY });
    expect(offered[0]?.toISOString()).toBe('2026-10-07T07:00:00.000Z');
    expect(offered.at(-1)?.toISOString()).toBe('2026-10-07T14:00:00.000Z');
  });

  it('offers nothing when the weekday row is explicitly closed', () => {
    const closedWednesdays = WEEKDAY_HOURS.map((row) =>
      row.weekday === 3 ? { ...row, isOpen: false } : row,
    );
    expect(starts({ workingHours: closedWednesdays })).toEqual([]);
  });
});

// --- 2. Dated override, additive -------------------------------------------

describe('a dated override that opens a day', () => {
  it('opens the one Saturday it names and leaves the following Saturday closed', () => {
    // The R-4 fix (data-model_v2.md §5.3): one dated row opens a Saturday that
    // has no weekly rule, and it opens only that date.
    const workingHours = [...WEEKDAY_HOURS, dated(SATURDAY)];

    expect(startTimes({ date: SATURDAY, workingHours })).toEqual(FULL_WEDNESDAY);
    expect(starts({ date: NEXT_SATURDAY, workingHours })).toEqual([]);
  });

  it('leaves the ordinary weekdays around it untouched', () => {
    const workingHours = [...WEEKDAY_HOURS, dated(SATURDAY)];

    expect(startTimes({ date: FRIDAY, workingHours })).toEqual(FULL_WEDNESDAY);
    expect(startTimes({ date: MONDAY, workingHours })).toEqual(FULL_WEDNESDAY);
  });

  it('can open a closed day with hours of its own, not the weekly hours', () => {
    // "Mukamana wedding — open Saturday 10:00–14:00" (§5.3 note).
    const workingHours = [
      ...WEEKDAY_HOURS,
      dated(SATURDAY, { opensMinute: 600, closesMinute: 840 }),
    ];

    expect(startTimes({ date: SATURDAY, workingHours })).toEqual([
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
      '12:30',
      '13:00',
    ]);
  });
});

// --- 3. Dated override, subtractive ----------------------------------------

describe('a dated override that closes a day', () => {
  it('closes the one Wednesday it names and leaves the next Wednesday open', () => {
    const workingHours = [...WEEKDAY_HOURS, dated(WEDNESDAY, { isOpen: false })];

    expect(starts({ date: WEDNESDAY, workingHours })).toEqual([]);
    expect(startTimes({ date: NEXT_WEDNESDAY, workingHours })).toEqual(FULL_WEDNESDAY);
  });

  it('wins outright over the weekday row even when it narrows the hours', () => {
    const workingHours = [
      ...WEEKDAY_HOURS,
      dated(WEDNESDAY, { opensMinute: 780, closesMinute: 900 }),
    ];

    // 13:00-15:00 Kigali: a 60-minute session fits starting 13:00, 13:30 and 14:00.
    expect(startTimes({ date: WEDNESDAY, workingHours })).toEqual(['13:00', '13:30', '14:00']);
  });

  it('closes the day even when the dated row still carries opening hours', () => {
    const workingHours = [...WEEKDAY_HOURS, dated(WEDNESDAY, { isOpen: false })];
    expect(starts({ date: WEDNESDAY, workingHours })).toEqual([]);
  });
});

// --- 4. Blocks --------------------------------------------------------------

describe('availability blocks', () => {
  it('removes exactly the starts a midday block covers', () => {
    // A 30-minute session, so "covered" and "starting inside the block" coincide.
    const offered = startTimes({
      packageDurationMinutes: 30,
      blocks: [dayBlock(WEDNESDAY, '11:00', '13:00')],
    });

    expect(offered).not.toContain('11:00');
    expect(offered).not.toContain('11:30');
    expect(offered).not.toContain('12:00');
    expect(offered).not.toContain('12:30');
    expect(offered).toContain('10:30');
    expect(offered).toContain('13:00');
  });

  it('also removes an earlier start whose session would run into the block', () => {
    const offered = startTimes({ blocks: [dayBlock(WEDNESDAY, '11:00', '13:00')] });

    expect(offered).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '13:00',
      '13:30',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
    ]);
  });

  it('offers a session that ends exactly when a block begins', () => {
    // Half-open ranges: [10:00, 11:00) does not overlap [11:00, 13:00).
    const offered = startTimes({ blocks: [dayBlock(WEDNESDAY, '11:00', '13:00')] });
    expect(offered).toContain('10:00');
  });

  it('offers a session that begins exactly when a block ends', () => {
    const offered = startTimes({ blocks: [dayBlock(WEDNESDAY, '11:00', '13:00')] });
    expect(offered).toContain('13:00');
  });

  it('removes every day a multi-day block covers end to end', () => {
    // One row for a multi-day absence (§5.4); availability is asked per day.
    const blocks = [block(TUESDAY, '00:00', SATURDAY, '00:00')];

    expect(starts({ date: TUESDAY, blocks })).toEqual([]);
    expect(starts({ date: WEDNESDAY, blocks })).toEqual([]);
    expect(starts({ date: THURSDAY, blocks })).toEqual([]);
    expect(starts({ date: FRIDAY, blocks })).toEqual([]);
    expect(startTimes({ date: MONDAY, blocks })).toEqual(FULL_WEDNESDAY);
  });

  it('trims only the covered part of the first and last day of a multi-day block', () => {
    const blocks = [block(TUESDAY, '12:00', FRIDAY, '12:00')];

    expect(startTimes({ date: TUESDAY, blocks })).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
    ]);
    expect(starts({ date: WEDNESDAY, blocks })).toEqual([]);
    expect(starts({ date: THURSDAY, blocks })).toEqual([]);
    expect(startTimes({ date: FRIDAY, blocks })).toEqual([
      '12:00',
      '12:30',
      '13:00',
      '13:30',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
    ]);
  });

  it('handles overlapping blocks as their union, not as an error', () => {
    // Blocks may overlap each other; overlap is information (§5.4, spec §6.4).
    const blocks = [dayBlock(WEDNESDAY, '10:00', '12:00'), dayBlock(WEDNESDAY, '11:00', '14:00')];

    expect(startTimes({ packageDurationMinutes: 30, blocks })).toEqual([
      '09:00',
      '09:30',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
      '16:30',
    ]);
  });

  it('empties the day when one block spans it', () => {
    expect(starts({ blocks: [block(WEDNESDAY, '00:00', THURSDAY, '00:00')] })).toEqual([]);
  });

  it('ignores a block that falls entirely on another day', () => {
    expect(startTimes({ blocks: [dayBlock(THURSDAY, '09:00', '17:00')] })).toEqual(FULL_WEDNESDAY);
  });
});

// --- 5. Occupancy and buffer ------------------------------------------------

describe('occupancy and the buffer', () => {
  it('makes 10:30 the first free start after a 09:00–10:00 booking reserving to 10:30', () => {
    // data-model_v2.md §8 step 3: occupancy runs to buffer_ends_at, not ends_at.
    // v2.0 asserted 10:15, a time the 30-minute grid never produces.
    const offered = startTimes({ bookings: [booking(WEDNESDAY, '09:00', '10:30')] });

    expect(offered).not.toContain('09:00');
    expect(offered).not.toContain('09:30');
    expect(offered).not.toContain('10:00');
    expect(offered[0]).toBe('10:30');
  });

  it('offers a start landing exactly on the existing booking’s buffer end', () => {
    const offered = starts({ bookings: [booking(WEDNESDAY, '09:00', '10:30')] });
    expect(offered[0]).toEqual(kigali(WEDNESDAY, '10:30'));
  });

  it('refuses a candidate whose own trailing buffer would collide with a later booking', () => {
    // The exclusion constraint is symmetric (§9.1): the candidate reserves
    // [start, start + duration + buffer). A 10:00 start would reserve to 11:30
    // and collide with an 11:00 booking, so the database would reject it (23P01)
    // even though the sessions themselves do not overlap.
    const offered = startTimes({ bookings: [booking(WEDNESDAY, '11:00', '12:30')] });

    expect(offered).not.toContain('10:00');
    expect(offered).not.toContain('10:30');
    expect(offered).toContain('09:30');
    expect(offered).toEqual([
      '09:00',
      '09:30',
      '12:30',
      '13:00',
      '13:30',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
    ]);
  });

  it('offers the start ending exactly when the next booking starts, when the buffer is zero', () => {
    const offered = startTimes({
      bufferMinutes: 0,
      bookings: [booking(WEDNESDAY, '11:00', '12:00')],
    });

    expect(offered).toContain('10:00');
    expect(offered).toContain('12:00');
    expect(offered).not.toContain('11:00');
    expect(offered).not.toContain('11:30');
  });

  it('leaves exactly one buffer between two adjacent shoots', () => {
    // §8: the trailing buffer belongs to the booking that created it.
    const offered = startTimes({
      bookings: [booking(WEDNESDAY, '09:00', '10:30'), booking(WEDNESDAY, '12:00', '13:30')],
    });

    expect(offered).toEqual(['10:30', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00']);
  });

  it('ignores a booking on another day', () => {
    expect(startTimes({ bookings: [booking(THURSDAY, '09:00', '17:30')] })).toEqual(FULL_WEDNESDAY);
  });

  it('lets a buffer run past closing without blocking anything', () => {
    // spec §6.7: there is nothing after 17:00 for the buffer to block, so 16:00
    // stays offerable even though it reserves to 17:30.
    expect(startTimes()).toContain('16:00');
  });
});

// --- Booking statuses -------------------------------------------------------

describe('booking status', () => {
  it.each(OCCUPYING.filter((status) => status !== 'pending_payment'))(
    '%s holds its slot',
    (status) => {
      const offered = startTimes({ bookings: [booking(WEDNESDAY, '09:00', '10:30', { status })] });
      expect(offered[0]).toBe('10:30');
    },
  );

  it('pending_payment holds its slot while its hold is live', () => {
    const held = booking(WEDNESDAY, '09:00', '10:30', {
      status: 'pending_payment',
      holdExpiresAt: kigali(WEDNESDAY, '08:00'),
    });

    expect(startTimes({ bookings: [held], now: kigali(WEDNESDAY, '06:00') })[0]).toBe('10:30');
  });

  it.each(FREEING)('%s frees its slot', (status) => {
    const offered = startTimes({ bookings: [booking(WEDNESDAY, '09:00', '10:30', { status })] });
    expect(offered).toEqual(FULL_WEDNESDAY);
  });

  it('treats an unknown status as freeing rather than silently occupying', () => {
    const offered = startTimes({
      bookings: [booking(WEDNESDAY, '09:00', '10:30', { status: 'rescheduled' })],
    });
    expect(offered).toEqual(FULL_WEDNESDAY);
  });
});

describe('a pending_payment hold', () => {
  const pending = (holdExpiresAt: Date | null): BookingRow =>
    booking(WEDNESDAY, '09:00', '10:30', { status: 'pending_payment', holdExpiresAt });

  it('occupies while hold_expires_at is in the future', () => {
    const now = kigali(WEDNESDAY, '06:00');
    expect(startTimes({ bookings: [pending(kigali(WEDNESDAY, '06:30'))], now })[0]).toBe('10:30');
  });

  it('does not occupy once hold_expires_at has passed', () => {
    // §9.2: the claim transaction expires the stale hold in-transaction, so
    // showing the time as taken would deny a slot the database would grant.
    const now = kigali(WEDNESDAY, '06:00');
    expect(startTimes({ bookings: [pending(kigali(WEDNESDAY, '05:30'))], now })).toEqual(
      FULL_WEDNESDAY,
    );
  });

  it('does not occupy at the exact instant the hold expires', () => {
    const now = kigali(WEDNESDAY, '06:00');
    expect(startTimes({ bookings: [pending(now)], now })).toEqual(FULL_WEDNESDAY);
  });

  it('does not occupy when hold_expires_at is null', () => {
    expect(startTimes({ bookings: [pending(null)], now: kigali(WEDNESDAY, '06:00') })).toEqual(
      FULL_WEDNESDAY,
    );
  });
});

// --- 6. Lead time -----------------------------------------------------------

describe('minimum lead time', () => {
  it('offers nothing before 16:00 when it is 14:00 and the notice is 120 minutes', () => {
    // spec §6.6: slots sooner than now + 120 minutes are not offered.
    const offered = startTimes({ now: kigali(WEDNESDAY, '14:00'), minLeadTimeMinutes: 120 });

    expect(offered).toEqual(['16:00']);
  });

  it('offers the start that falls exactly on now + lead time', () => {
    const offered = startTimes({ now: kigali(WEDNESDAY, '13:45'), minLeadTimeMinutes: 135 });

    expect(offered[0]).toBe('16:00');
  });

  it('withholds a start one minute inside the threshold', () => {
    const offered = startTimes({ now: kigali(WEDNESDAY, '13:46'), minLeadTimeMinutes: 135 });

    expect(offered).toEqual([]);
  });

  it('offers the current instant itself when the lead time is zero', () => {
    const offered = startTimes({ now: kigali(WEDNESDAY, '10:00'), minLeadTimeMinutes: 0 });

    expect(offered[0]).toBe('10:00');
    expect(offered).toEqual(FULL_WEDNESDAY.slice(FULL_WEDNESDAY.indexOf('10:00')));
  });

  it('offers nothing once the day has closed', () => {
    expect(starts({ now: kigali(WEDNESDAY, '20:00'), minLeadTimeMinutes: 120 })).toEqual([]);
  });

  it('permits same-day booking that clears the threshold', () => {
    // spec §6.6 states same-day booking is permitted, not merely tolerated.
    expect(startTimes({ now: kigali(WEDNESDAY, '09:00'), minLeadTimeMinutes: 120 })[0]).toBe(
      '11:00',
    );
  });
});

// --- 7. Fit -----------------------------------------------------------------

describe('fitting the package inside the window', () => {
  it('makes 15:00 the last start for a 120-minute package on a day closing at 17:00', () => {
    const offered = startTimes({ packageDurationMinutes: 120 });

    expect(offered.at(-1)).toBe('15:00');
    expect(offered).not.toContain('15:30');
    expect(offered).not.toContain('16:00');
  });

  it('makes 09:00 the only start for a package exactly as long as the day', () => {
    expect(startTimes({ packageDurationMinutes: 480 })).toEqual(['09:00']);
  });

  it('measures fit on the session alone, ignoring the trailing buffer', () => {
    // spec §6.7: the buffer may extend past 17:00 and blocks nothing.
    expect(startTimes({ packageDurationMinutes: 480, bufferMinutes: 120 })).toEqual(['09:00']);
  });
});

// --- 8. Impossible package --------------------------------------------------

describe('a package longer than the working window', () => {
  it('produces no availability at all for a 600-minute package on an 8-hour day', () => {
    // spec §6.8 / R-4: an empty calendar, and the admin is warned on the package.
    expect(starts({ packageDurationMinutes: 600 })).toEqual([]);
  });

  it('produces no availability even one minute too long', () => {
    expect(starts({ packageDurationMinutes: 481 })).toEqual([]);
  });
});

// --- Malformed and degenerate input ----------------------------------------

describe('a malformed date', () => {
  it.each(['not-a-date', '', '2026-10-7', '07-10-2026', '2026-10-07T00:00:00Z', '  '])(
    'is rejected: %j',
    (date) => {
      expect(() => starts({ date })).toThrow(RangeError);
    },
  );

  it.each(['2026-13-01', '2026-00-10', '2026-02-30', '2026-10-32', '2027-02-29'])(
    'is rejected when it is well-formed but not a real day: %s',
    (date) => {
      expect(() => starts({ date })).toThrow(RangeError);
    },
  );

  it('accepts a real leap day', () => {
    const workingHours = [dated('2028-02-29')];
    expect(startTimes({ date: '2028-02-29', workingHours })).toEqual(FULL_WEDNESDAY);
  });

  it('rejects the date before looking at any other argument', () => {
    expect(() =>
      availableStarts({ ...options({ date: 'nonsense' }), workingHours: [], bookings: [] }),
    ).toThrow(RangeError);
  });
});

describe('degenerate input', () => {
  it('offers nothing for a zero-minute package', () => {
    expect(starts({ packageDurationMinutes: 0 })).toEqual([]);
  });

  it('offers nothing for a negative package duration', () => {
    expect(starts({ packageDurationMinutes: -30 })).toEqual([]);
  });

  it('offers nothing when no working hours exist at all', () => {
    expect(starts({ workingHours: [] })).toEqual([]);
  });

  it('offers nothing when an open row has no opening minute', () => {
    // The database CHECK forbids this row (§5.3); the engine must not trust it.
    const workingHours = [dated(WEDNESDAY, { opensMinute: null })];
    expect(starts({ workingHours })).toEqual([]);
  });

  it('offers nothing when an open row has no closing minute', () => {
    const workingHours = [dated(WEDNESDAY, { closesMinute: null })];
    expect(starts({ workingHours })).toEqual([]);
  });

  it('offers nothing when closing is before opening', () => {
    const workingHours = [dated(WEDNESDAY, { opensMinute: 1020, closesMinute: 540 })];
    expect(starts({ workingHours })).toEqual([]);
  });

  it('offers nothing when closing equals opening', () => {
    const workingHours = [dated(WEDNESDAY, { opensMinute: 540, closesMinute: 540 })];
    expect(starts({ workingHours })).toEqual([]);
  });

  it('does not fall back to the weekday row when the dated row closes the day', () => {
    const workingHours = [...WEEKDAY_HOURS, dated(WEDNESDAY, { opensMinute: null })];
    expect(starts({ workingHours })).toEqual([]);
  });
});

// --- The grid ---------------------------------------------------------------

describe('the 30-minute grid', () => {
  it('lands starts on :00 and :30 even when the day opens off-grid', () => {
    // Starts sit on the grid measured from Kigali midnight, not from opens_minute.
    const workingHours = [dated(WEDNESDAY, { opensMinute: 545 })];
    const offered = startTimes({ workingHours });

    expect(offered[0]).toBe('09:30');
    for (const time of offered) {
      expect(time.slice(3)).toMatch(/^(00|30)$/);
    }
  });

  it('does not offer a start before an off-grid opening minute', () => {
    const workingHours = [dated(WEDNESDAY, { opensMinute: 555 })];
    expect(startTimes({ workingHours })[0]).toBe('09:30');
  });

  it('returns starts in strictly ascending order', () => {
    const offered = starts({
      blocks: [dayBlock(WEDNESDAY, '11:00', '12:00')],
      bookings: [booking(WEDNESDAY, '14:00', '15:30')],
    });

    for (let index = 1; index < offered.length; index += 1) {
      expect(offered[index]!.getTime()).toBeGreaterThan(offered[index - 1]!.getTime());
    }
    expect(offered.length).toBeGreaterThan(1);
  });
});

// --- Determinism ------------------------------------------------------------

describe('the engine as a pure function', () => {
  const input = () =>
    options({
      blocks: [dayBlock(WEDNESDAY, '11:00', '13:00')],
      bookings: [booking(WEDNESDAY, '14:00', '15:30')],
    });

  it('returns equal results for two identical calls', () => {
    expect(availableStarts(input())).toEqual(availableStarts(input()));
  });

  it('returns a fresh array each call, never a shared one', () => {
    expect(availableStarts(input())).not.toBe(availableStarts(input()));
  });

  it('does not mutate the arrays it is given', () => {
    const shared = input();
    const before = JSON.stringify([shared.workingHours, shared.blocks, shared.bookings]);

    availableStarts(shared);

    expect(JSON.stringify([shared.workingHours, shared.blocks, shared.bookings])).toBe(before);
  });

  it('works on frozen input', () => {
    const shared = input();
    Object.freeze(shared.workingHours);
    Object.freeze(shared.blocks);
    Object.freeze(shared.bookings);

    expect(() => availableStarts(shared)).not.toThrow();
  });

  it('does not mutate the Date objects it is given', () => {
    const now = dayBefore(WEDNESDAY);
    const nowMillis = now.getTime();
    const existing = booking(WEDNESDAY, '14:00', '15:30');
    const startsAtMillis = existing.startsAt.getTime();

    availableStarts(options({ bookings: [existing], now }));

    expect(now.getTime()).toBe(nowMillis);
    expect(existing.startsAt.getTime()).toBe(startsAtMillis);
  });
});

// --- No DST anywhere --------------------------------------------------------

describe('Kigali without daylight saving', () => {
  it.each([
    ['January', '2026-01-07'],
    ['July', '2026-07-01'],
    ['October', WEDNESDAY],
  ])('offers the same wall times in %s', (_month, date) => {
    expect(startTimes({ date })).toEqual(FULL_WEDNESDAY);
  });

  it.each([
    ['January', '2026-01-07'],
    ['July', '2026-07-01'],
  ])('keeps 09:00 Kigali at 07:00Z in %s', (_month, date) => {
    expect(starts({ date })[0]?.toISOString()).toBe(`${date}T07:00:00.000Z`);
  });

  it('is unaffected by the host machine timezone', () => {
    const original = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      expect(startTimes({ date: WEDNESDAY })).toEqual(FULL_WEDNESDAY);
    } finally {
      process.env.TZ = original;
    }
  });
});

// --- 9. Purity, proven statically ------------------------------------------

describe('the availability engine module graph', () => {
  const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const entry = resolve(srcRoot, 'availability', 'engine.ts');

  /** Anything that would open a database connection at import time. */
  const FORBIDDEN_PACKAGES = ['@prisma/client', '@prisma/adapter-pg', 'pg'];

  it('reaches only the two pure modules it needs', () => {
    const graph = transitiveGraph(entry).map((file) => relative(srcRoot, file).replace(/\\/g, '/'));

    expect(graph.sort()).toEqual([
      'availability/engine.ts',
      'db/statuses.ts',
      'settings/constants.ts',
    ]);
  });

  it('imports no Prisma or pg package anywhere in that graph', () => {
    for (const file of transitiveGraph(entry)) {
      const bare = importSpecifiers(readFileSync(file, 'utf8')).filter(
        (specifier) => !specifier.startsWith('.'),
      );
      expect(bare.filter((specifier) => FORBIDDEN_PACKAGES.includes(specifier))).toEqual([]);
    }
  });

  it('never reaches the module that instantiates the client', () => {
    // db/client.ts calls createPrismaClient() at module scope; importing it
    // anywhere in this graph would open a connection just by loading the engine.
    const client = resolve(srcRoot, 'db', 'client.ts');
    expect(transitiveGraph(entry)).not.toContain(client);
  });

  it('never reaches settings/index.ts, which does touch the database', () => {
    const settings = resolve(srcRoot, 'settings', 'index.ts');
    expect(transitiveGraph(entry)).not.toContain(settings);
  });
});

/** Every `.ts` file reachable from `entry` through relative imports, inclusive. */
function transitiveGraph(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      // NodeNext: the source is .ts but the specifier carries .js.
      pending.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
    }
  }

  return [...seen];
}

/** Specifiers of every static import, re-export and dynamic `import()`. */
function importSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}
