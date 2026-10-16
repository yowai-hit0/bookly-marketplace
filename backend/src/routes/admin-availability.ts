import type { AvailabilityBlock, PrismaClient, WorkingHours } from '@prisma/client';
import { type Response, Router } from 'express';
import { z } from 'zod';
import { kigaliMinuteToUtc } from '../availability/engine.js';
import { SQLSTATE, sqlstateOf } from '../db/errors.js';
import type { BookingStatus } from '../db/statuses.js';
import { kigaliDate, parseOrReject } from './validation.js';

/**
 * `/api/admin/working-hours` and `/api/admin/blocks` (plan.md Task 8, spec
 * §3.3, §6.3, §6.4, P-15, P-16). Mounted behind `requireAdmin`, so nothing here
 * checks auth itself.
 *
 * These are the only endpoints that serialise a block's `reason` (spec P-03).
 * The public side reads availability through `availability/query.ts`, which
 * never selects it.
 */

const MINUTES_PER_DAY = 1440;
/** Bounds storage for free text. A developer default, not a spec value. */
const TEXT_MAX_LENGTH = 500;

const minuteOfDay = z.int().min(0).max(MINUTES_PER_DAY);
const optionalText = z.string().max(TEXT_MAX_LENGTH).nullable().default(null);
/** Postgres accepts any 8-4-4-4-12 hex id; a malformed one names no row. */
const rowId = z.guid();

// --- Working hours ---------------------------------------------------------------

const hoursFields = {
  opensMinute: minuteOfDay.nullable().default(null),
  closesMinute: minuteOfDay.nullable().default(null),
  isOpen: z.boolean().default(true),
  note: optionalText,
};

type Hours = { isOpen: boolean; opensMinute: number | null; closesMinute: number | null };

/** Mirrors the `working_hours_open_window` CHECK, so it answers 422 first. */
function hasOpenWindow(row: Hours): boolean {
  return (
    !row.isOpen ||
    (row.opensMinute !== null && row.closesMinute !== null && row.closesMinute > row.opensMinute)
  );
}

const openWindowIssue = {
  message: 'An open day needs opensMinute before closesMinute',
  path: ['closesMinute'],
};

/**
 * A recurring weekday rule OR a one-date override -- never both, never neither
 * (data-model_v2.md §5.3). A union of strict objects rather than a refinement,
 * so a payload carrying both keys is a malformed request (400), not a rule
 * violation (422). See `validation.ts`.
 */
const workingHoursBody = z.union([
  z.strictObject({ weekday: z.int().min(0).max(6), ...hoursFields }).refine(hasOpenWindow, openWindowIssue),
  z.strictObject({ effectiveDate: kigaliDate, ...hoursFields }).refine(hasOpenWindow, openWindowIssue),
]);

type WorkingHoursBody = z.output<typeof workingHoursBody>;

export function workingHoursRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const rows = await prisma.workingHours.findMany({
      orderBy: [{ weekday: { sort: 'asc', nulls: 'last' } }, { effectiveDate: 'asc' }],
    });
    res.json({ workingHours: rows.map(toAdminWorkingHours) });
  });

  router.post('/', async (req, res) => {
    const body = parseOrReject(workingHoursBody, req.body, res);
    if (body === undefined) return;

    const data = toWorkingHoursData(body);
    try {
      const created = await prisma.workingHours.create({ data });
      res.status(201).json({ workingHours: toAdminWorkingHours(created) });
    } catch (error) {
      if (!rejectDuplicateHours(error, res)) throw error;
    }
  });

  /** Replaces the whole row, key included, so a rule can move to another day. */
  router.put('/:id', async (req, res) => {
    const id = rowId.safeParse(req.params.id);
    if (!id.success) return notFound(res);
    const body = parseOrReject(workingHoursBody, req.body, res);
    if (body === undefined) return;

    const data = toWorkingHoursData(body);
    try {
      const { count } = await prisma.workingHours.updateMany({ where: { id: id.data }, data });
      if (count === 0) return notFound(res);
      res.json({ workingHours: toAdminWorkingHours({ id: id.data, ...data }) });
    } catch (error) {
      if (!rejectDuplicateHours(error, res)) throw error;
    }
  });

  /** Deleting a weekday rule closes that weekday; deleting an override restores
   *  the weekly rule for its date. */
  router.delete('/:id', async (req, res) => {
    const id = rowId.safeParse(req.params.id);
    if (!id.success) return notFound(res);

    const { count } = await prisma.workingHours.deleteMany({ where: { id: id.data } });
    if (count === 0) return notFound(res);
    res.status(204).end();
  });

  return router;
}

function toWorkingHoursData(body: WorkingHoursBody) {
  return {
    // Both keys are always written, so replacing a weekday rule with a dated
    // override (or back) clears the other one.
    weekday: 'weekday' in body ? body.weekday : null,
    // `@db.Date` is read back as UTC midnight; written the same way.
    effectiveDate: 'effectiveDate' in body ? new Date(`${body.effectiveDate}T00:00:00Z`) : null,
    opensMinute: body.opensMinute,
    closesMinute: body.closesMinute,
    isOpen: body.isOpen,
    note: body.note,
  };
}

/** One rule per weekday, one override per date: the partial unique indexes. */
function rejectDuplicateHours(error: unknown, res: Response): boolean {
  if (sqlstateOf(error) !== SQLSTATE.UNIQUE_VIOLATION) return false;
  res.status(409).json({ error: 'working_hours_exists' });
  return true;
}

type AdminWorkingHours = {
  id: string;
  weekday: number | null;
  effectiveDate: string | null;
  opensMinute: number | null;
  closesMinute: number | null;
  isOpen: boolean;
  note: string | null;
};

function toAdminWorkingHours(
  row: Pick<WorkingHours, 'id' | 'weekday' | 'effectiveDate' | 'opensMinute' | 'closesMinute' | 'isOpen' | 'note'>,
): AdminWorkingHours {
  return {
    id: row.id,
    weekday: row.weekday,
    effectiveDate: row.effectiveDate?.toISOString().slice(0, 10) ?? null,
    opensMinute: row.opensMinute,
    closesMinute: row.closesMinute,
    isOpen: row.isOpen,
    note: row.note,
  };
}

// --- Blocks ----------------------------------------------------------------------

const blockCommon = {
  /** Private to the admin (spec P-03). */
  reason: optionalText,
  /** Saves over confirmed bookings after the 409 warning (spec §6.4). */
  confirm: z.boolean().default(false),
};

/**
 * A full day or range of days, or a time range (spec §3.3 step 3). Whole days
 * arrive as Kigali dates and become instants here, so no browser timezone is
 * ever involved; the stored range is absolute either way and `isAllDay` is
 * presentation only (data-model_v2.md §5.4).
 */
const blockBody = z.discriminatedUnion('isAllDay', [
  z
    .strictObject({
      isAllDay: z.literal(true),
      /** Inclusive. */
      startDate: kigaliDate,
      /** Inclusive. */
      endDate: kigaliDate,
      ...blockCommon,
    })
    // ISO dates order correctly as strings.
    .refine((b) => b.endDate >= b.startDate, {
      message: 'endDate is before startDate',
      path: ['endDate'],
    }),
  z
    .strictObject({
      isAllDay: z.literal(false),
      /** An offset is required: a bare local time would be read in the server's zone. */
      startsAt: z.iso.datetime({ offset: true }),
      endsAt: z.iso.datetime({ offset: true }),
      ...blockCommon,
    })
    .refine((b) => Date.parse(b.endsAt) > Date.parse(b.startsAt), {
      message: 'endsAt must be after startsAt',
      path: ['endsAt'],
    }),
]);

type BlockBody = z.output<typeof blockBody>;

export function blocksRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const rows = await prisma.availabilityBlock.findMany({ orderBy: { startsAt: 'asc' } });
    res.json({ blocks: rows.map(toAdminBlock) });
  });

  router.post('/', async (req, res) => {
    const body = parseOrReject(blockBody, req.body, res);
    if (body === undefined) return;

    const data = toBlockData(body);
    if (!body.confirm && (await warnOfConfirmedBookings(prisma, data, res))) return;

    const created = await prisma.availabilityBlock.create({ data });
    res.status(201).json({ block: toAdminBlock(created) });
  });

  router.put('/:id', async (req, res) => {
    const id = rowId.safeParse(req.params.id);
    if (!id.success) return notFound(res);
    const body = parseOrReject(blockBody, req.body, res);
    if (body === undefined) return;

    // Existence first, so a missing block is a 404 rather than a conflict
    // warning about a save that could never happen.
    const existing = await prisma.availabilityBlock.findUnique({
      where: { id: id.data },
      select: { id: true },
    });
    if (existing === null) return notFound(res);

    const data = toBlockData(body);
    if (!body.confirm && (await warnOfConfirmedBookings(prisma, data, res))) return;

    const { count } = await prisma.availabilityBlock.updateMany({ where: { id: id.data }, data });
    if (count === 0) return notFound(res);
    res.json({ block: toAdminBlock({ id: id.data, ...data }) });
  });

  router.delete('/:id', async (req, res) => {
    const id = rowId.safeParse(req.params.id);
    if (!id.success) return notFound(res);

    const { count } = await prisma.availabilityBlock.deleteMany({ where: { id: id.data } });
    if (count === 0) return notFound(res);
    res.status(204).end();
  });

  return router;
}

function toBlockData(body: BlockBody) {
  const { startsAt, endsAt } = body.isAllDay
    ? {
        startsAt: kigaliMinuteToUtc(body.startDate, 0),
        // Midnight after the last day, so the range is half-open like every other.
        endsAt: kigaliMinuteToUtc(body.endDate, MINUTES_PER_DAY),
      }
    : { startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt) };

  return { startsAt, endsAt, isAllDay: body.isAllDay, reason: body.reason };
}

const CONFIRMED = 'confirmed' satisfies BookingStatus;

/**
 * Spec §6.4: a block never silently cancels a paid booking. If the range
 * overlaps a `confirmed` booking's session, answer 409 naming each one; the
 * admin cancels or reschedules them explicitly, or resends with `confirm: true`
 * and the booking stands as a calendar conflict. Returns whether it answered.
 *
 * Measured against the session, not the buffer: the buffer is slack, and a
 * block over it takes nothing the client paid for.
 *
 * A warning, not a guarantee: a booking confirmed between this read and the
 * save is not named. That is the §6.4 aftermath the calendar shows (Task 9).
 */
async function warnOfConfirmedBookings(
  prisma: PrismaClient,
  range: { startsAt: Date; endsAt: Date },
  res: Response,
): Promise<boolean> {
  const bookings = await prisma.booking.findMany({
    where: { status: CONFIRMED, startsAt: { lt: range.endsAt }, endsAt: { gt: range.startsAt } },
    orderBy: { startsAt: 'asc' },
    select: { id: true, reference: true, contactName: true, startsAt: true, endsAt: true },
  });
  if (bookings.length === 0) return false;

  res.status(409).json({
    error: 'block_overlaps_confirmed_bookings',
    bookings: bookings.map((booking) => ({
      id: booking.id,
      reference: booking.reference,
      contactName: booking.contactName,
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
    })),
  });
  return true;
}

type AdminBlock = {
  id: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  reason: string | null;
};

function toAdminBlock(
  row: Pick<AvailabilityBlock, 'id' | 'startsAt' | 'endsAt' | 'isAllDay' | 'reason'>,
): AdminBlock {
  return {
    id: row.id,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    isAllDay: row.isAllDay,
    reason: row.reason,
  };
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}
