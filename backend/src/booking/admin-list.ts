import type { Prisma, PrismaClient } from '@prisma/client';
import { type KigaliDate, kigaliMinuteToUtc } from '../availability/engine.js';
import type { BookingStatus } from '../db/statuses.js';
import { type BookingStage, bookingStage, stageWhere } from './stage.js';
import { bookingTotals } from './totals.js';

/**
 * The bookings list (plan.md Task 19): filtered by status and date, and paged
 * by number with a total (admin console fixes, item 5, 2026-09-27).
 *
 * It was a cursor, because an offset is not stable: page 2 of `OFFSET 20`
 * shifts the moment a booking is created or rescheduled, so a row can be shown
 * twice or skipped. The photographer asked for numbered pages and a total
 * instead ("Showing 21-40 of 132"), which only an offset can give, and accepted
 * that trade: one person edits these bookings, and a page is re-read on every
 * change of filter or page. The order stays deterministic -- start, then id --
 * so the same page asked twice over an unchanged table is the same rows, and
 * the count and the page are read in one transaction so they agree.
 *
 * Amounts come from `bookingTotals()` (data-model_v2.md §6.1), computed from
 * each row's own add-ons and payments, which the query loads with it: one
 * round trip, whatever the page holds.
 */

export const BOOKINGS_PAGE_SIZE = 25;
export const BOOKINGS_MAX_PAGE_SIZE = 100;
const MINUTES_PER_DAY = 1440;

export type BookingsQuery = {
  /** Empty means every status. Kept for links made before stages (2026-09-25). */
  statuses?: readonly BookingStatus[];
  /** Display stages (`stage.ts`), what the list filters by now. Empty means every stage. */
  stages?: readonly BookingStage[];
  /** The clock stages are read on; the same one the rows are staged with. */
  now?: Date;
  /** Kigali dates, inclusive, matched against the shoot's start. */
  from?: KigaliDate;
  to?: KigaliDate;
  /** A reference, a name, an email or a phone number, matched loosely. */
  search?: string;
  /** 1-based. Past the last page, the last page is answered. */
  page?: number;
  pageSize?: number;
};

export type BookingListRow = {
  id: string;
  reference: string;
  status: string;
  /** The admin's display stage (`stage.ts`). */
  stage: BookingStage;
  startsAt: string;
  endsAt: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  serviceName: string;
  packageName: string;
  grandTotalRwf: number;
  collectedRwf: number;
  outstandingRwf: number;
  refundDueRwf: number;
  /** Money the photographer owes back, which the list should surface (spec §6.16). */
  hasRefundDue: boolean;
};

export type BookingsPage = {
  bookings: BookingListRow[];
  /** Every booking the filter matches, across all pages. */
  total: number;
  /** The page answered, 1-based: the one asked for, or the last one if it was past the end. */
  page: number;
  pageSize: number;
  /** At least 1, so a list with nothing in it is still "page 1 of 1". */
  pageCount: number;
};

export async function findBookings(prisma: PrismaClient, query: BookingsQuery = {}): Promise<BookingsPage> {
  const pageSize = Math.min(Math.max(Math.trunc(query.pageSize ?? BOOKINGS_PAGE_SIZE), 1), BOOKINGS_MAX_PAGE_SIZE);
  const now = query.now ?? new Date();
  const where = bookingsWhere(query, now);

  return prisma.$transaction(async (tx) => {
    const total = await tx.booking.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    // A page past the end (a filter narrowed the list under a bookmarked
    // URL) answers the last page rather than an empty one.
    const page = Math.min(Math.max(Math.trunc(query.page ?? 1), 1), pageCount);

    const rows = await tx.booking.findMany({
      where,
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        addons: { select: { stage: true, amountRwf: true } },
        payments: { select: { status: true, amountRwf: true } },
      },
    });

    return { bookings: rows.map((row) => toRow(row, now)), total, page, pageSize, pageCount };
  });
}

function bookingsWhere(query: BookingsQuery, now: Date): Prisma.BookingWhereInput {
  const startsAt: Prisma.DateTimeFilter = {};
  if (query.from !== undefined) startsAt.gte = kigaliMinuteToUtc(query.from, 0);
  if (query.to !== undefined) startsAt.lt = kigaliMinuteToUtc(query.to, MINUTES_PER_DAY);

  const search = query.search?.trim() ?? '';

  return {
    ...(query.statuses !== undefined && query.statuses.length > 0 ? { status: { in: [...query.statuses] } } : {}),
    ...(Object.keys(startsAt).length > 0 ? { startsAt } : {}),
    AND: [
      ...(query.stages !== undefined && query.stages.length > 0 ? [{ OR: query.stages.map((stage) => stageWhere(stage, now)) }] : []),
      ...(search === ''
        ? []
        : [
            {
              OR: [
                { reference: { contains: search, mode: 'insensitive' as const } },
                { contactName: { contains: search, mode: 'insensitive' as const } },
                { contactEmail: { contains: search, mode: 'insensitive' as const } },
                { contactPhone: { contains: search, mode: 'insensitive' as const } },
              ],
            },
          ]),
    ],
  };
}

type ListedBooking = Prisma.BookingGetPayload<{
  include: { addons: { select: { stage: true; amountRwf: true } }; payments: { select: { status: true; amountRwf: true } } };
}>;

function toRow(booking: ListedBooking, now: Date): BookingListRow {
  const totals = bookingTotals(booking, booking.addons, booking.payments);
  return {
    id: booking.id,
    reference: booking.reference,
    status: booking.status,
    stage: bookingStage(booking, now, 'admin'),
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    contactName: booking.contactName,
    contactEmail: booking.contactEmail,
    contactPhone: booking.contactPhone,
    serviceName: booking.serviceNameSnapshot,
    packageName: booking.packageNameSnapshot,
    grandTotalRwf: totals.grandTotalRwf,
    collectedRwf: totals.collectedRwf,
    outstandingRwf: totals.outstandingRwf,
    refundDueRwf: totals.refundDueRwf,
    hasRefundDue: totals.refundDueRwf > 0,
  };
}
