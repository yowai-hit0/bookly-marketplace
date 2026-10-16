import type { PrismaClient } from '@prisma/client';
import { type KigaliDate, kigaliMinuteToUtc } from '../availability/engine.js';
import { OCCUPYING_STATUSES } from '../db/statuses.js';

/**
 * What the admin calendar shows for a run of Kigali dates (plan.md Task 9,
 * spec §3.3 step 1): every booking that occupies time, and every block.
 *
 * Exactly two queries, however many bookings the range holds. Service and
 * package names come from the booking's own snapshots (data-model_v2.md §5.9),
 * so nothing joins or looks up per row, and a renamed service still shows what
 * the client booked.
 *
 * Cancelled and expired bookings are not on the calendar: they hold no time,
 * and the bookings list (Task 19) is where they are read. A lapsed hold is left
 * off too, even before the sweeper has flipped it -- it occupies nothing
 * (data-model_v2.md §9.2), so showing it would claim time that is free.
 */

type OccupyingStatus = (typeof OCCUPYING_STATUSES)[number];

export type CalendarBooking = {
  id: string;
  reference: string;
  status: OccupyingStatus;
  startsAt: string;
  endsAt: string;
  contactName: string;
  serviceName: string;
  packageName: string;
  /** Overlaps a block: the spec §6.4 aftermath of saving a block anyway. */
  conflictsWithBlock: boolean;
};

export type CalendarBlock = {
  id: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  /** Admin-only (spec P-03); this module serves the admin calendar alone. */
  reason: string | null;
};

export type Calendar = {
  bookings: CalendarBooking[];
  blocks: CalendarBlock[];
};

export type FindCalendarOptions = {
  /** First Kigali date, inclusive. */
  from: KigaliDate;
  /** Last Kigali date, inclusive. */
  to: KigaliDate;
  /** The injected clock, for deciding which holds are still live. */
  now: Date;
};

const MINUTES_PER_DAY = 1440;

export async function findCalendar(
  prisma: PrismaClient,
  { from, to, now }: FindCalendarOptions,
): Promise<Calendar> {
  const rangeStart = kigaliMinuteToUtc(from, 0);
  const rangeEnd = kigaliMinuteToUtc(to, MINUTES_PER_DAY);

  // Both ranges are bounded by Kigali midnights. A booking's session always
  // fits inside one working day, so it never straddles the edge, and every
  // block it could conflict with overlaps the range too.
  const [bookings, blocks] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: { in: [...OCCUPYING_STATUSES] },
        startsAt: { lt: rangeEnd },
        endsAt: { gt: rangeStart },
        OR: [{ status: { not: 'pending_payment' } }, { holdExpiresAt: { gt: now } }],
      },
      orderBy: { startsAt: 'asc' },
      select: {
        id: true,
        reference: true,
        status: true,
        startsAt: true,
        endsAt: true,
        contactName: true,
        serviceNameSnapshot: true,
        packageNameSnapshot: true,
      },
    }),
    prisma.availabilityBlock.findMany({
      where: { startsAt: { lt: rangeEnd }, endsAt: { gt: rangeStart } },
      orderBy: { startsAt: 'asc' },
      select: { id: true, startsAt: true, endsAt: true, isAllDay: true, reason: true },
    }),
  ]);

  return {
    bookings: bookings.map((booking) => ({
      id: booking.id,
      reference: booking.reference,
      status: booking.status as OccupyingStatus,
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      contactName: booking.contactName,
      serviceName: booking.serviceNameSnapshot,
      packageName: booking.packageNameSnapshot,
      // Against the session, not the buffer -- the same measure as the §6.4
      // warning when the block was saved.
      conflictsWithBlock: blocks.some(
        (block) => block.startsAt < booking.endsAt && booking.startsAt < block.endsAt,
      ),
    })),
    blocks: blocks.map((block) => ({
      id: block.id,
      startsAt: block.startsAt.toISOString(),
      endsAt: block.endsAt.toISOString(),
      isAllDay: block.isAllDay,
      reason: block.reason,
    })),
  };
}
