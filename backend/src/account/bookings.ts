import { Prisma, type PrismaClient } from '@prisma/client';
import { type AccessedBooking, FULL_BOOKING } from '../booking/access.js';
import { type ClientBookingView, clientBookingView } from '../booking/client-view.js';
import { type ClientStage, bookingStage } from '../booking/stage.js';
import { TOTALS_PAYMENT_SELECT, bookingTotals } from '../booking/totals.js';
import type { BookingStatus } from '../db/statuses.js';
import { checkoutToken } from '../payments/checkout-link.js';

/**
 * A signed-in client's bookings, across every photographer (marketplace-spec.md
 * R8.1, R8.4; Phase 8 units B1 and B2). Transport-free: `routes/account-dashboard.ts`
 * maps these onto HTTP.
 *
 * **Whose bookings.** Every booking whose `client` row is linked to the account
 * (`client.user_id`), and nothing else. A row is linked only once the address
 * is proven -- verification, a reset that verifies, Google sign-in, a confirmed
 * address change -- or by `upsertClient` when a verified account's address
 * books later (marketplace-data-model.md §2.8). So the scope is the session's
 * user and a join, never an id, a reference or an email from the request: a
 * reference that is not the account's answers exactly like one that names
 * nothing (`null`, a 404), and the isolation sweep holds every route to it (T8.1).
 *
 * **Upcoming and past** (design decision, Phase 8):
 *
 *   upcoming  `confirmed` with the shoot not yet over (in progress included),
 *             and `pending_payment` while its hold is LIVE, with the checkout
 *             link to finish paying. Soonest first.
 *   past      `completed`, `no_show`, every cancellation (a cancelled shoot
 *             still in the future too: it will not happen), and `confirmed`
 *             whose shoot is over but not yet marked. Latest first.
 *
 * An `expired` hold, or a `pending_payment` whose hold has lapsed before the
 * sweeper caught it, is in NEITHER list. A lapsed hold was never a booking
 * (totals.ts: nothing is owed on it), and a client who tried twice would see
 * the attempt they abandoned beside the booking they made. Its reference still
 * opens its detail, and a late payment on it, owed back, is in the payments list.
 *
 * The hold's liveness is measured on the DATABASE clock, as the checkout and
 * the claim measure it; the shoot's end on the app clock, as `bookingStage`
 * and `canCancel` measure it.
 *
 * Numbered pages of `ACCOUNT_PAGE_SIZE`, the studio list's shape; a page past
 * the end answers the last page. The count and the page are read in one
 * transaction so they agree.
 */

export const ACCOUNT_PAGE_SIZE = 20;

export const BOOKING_SCOPES = ['upcoming', 'past'] as const;
export type BookingScope = (typeof BOOKING_SCOPES)[number];

/** What the dashboard says about whose booking it is: the public profile's address and name. */
export type AccountPhotographer = { handle: string; displayName: string };

export type AccountBookingRow = {
  reference: string;
  photographer: AccountPhotographer;
  serviceName: string;
  packageName: string;
  startsAt: string;
  endsAt: string;
  status: string;
  /** The client's display stage (`stage.ts`). */
  stage: ClientStage;
  /** All from `bookingTotals()`, the guest page's helper: total, paid, still owed, owed back. */
  amounts: { totalRwf: number; paidRwf: number; dueRwf: number; refundDueRwf: number };
  /** A live hold's end; null otherwise. */
  holdExpiresAt: string | null;
  /** `/checkout/<reference>/<token>` while a hold is live and payments are on; null otherwise. */
  checkoutPath: string | null;
};

export type AccountBookingsPage = {
  scope: BookingScope;
  bookings: AccountBookingRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

/** The statuses that are history whatever the clock says. */
const PAST_STATUSES = ['completed', 'no_show', 'cancelled_by_client', 'cancelled_by_photographer', 'cancelled_by_platform'] as const satisfies readonly BookingStatus[];

/** The photographer columns any account view may show. */
const PHOTOGRAPHER_SUMMARY = { select: { handle: true, displayName: true } } as const;

type Db = PrismaClient | Prisma.TransactionClient;

/** Whether the booking's hold is still running, on the database clock. */
const HOLD_LIVE = Prisma.sql`(b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now())`;

function scopeWhere(scope: BookingScope, now: Date): Prisma.Sql {
  return scope === 'upcoming'
    ? Prisma.sql`((b.status = 'confirmed' AND b.ends_at > ${now}::timestamptz) OR (b.status = 'pending_payment' AND ${HOLD_LIVE}))`
    : Prisma.sql`(b.status IN (${Prisma.join([...PAST_STATUSES])}) OR (b.status = 'confirmed' AND b.ends_at <= ${now}::timestamptz))`;
}

export type ListAccountBookingsDeps = {
  prisma: PrismaClient;
  /** `SESSION_SECRET`, when the checkout is mounted: it signs the "finish payment" link. */
  checkoutSecret?: string;
};

export async function listAccountBookings(
  deps: ListAccountBookingsDeps,
  userId: string,
  query: { scope: BookingScope; page?: number },
  now: Date,
): Promise<AccountBookingsPage> {
  const where = scopeWhere(query.scope, now);
  const order = query.scope === 'upcoming' ? Prisma.sql`b.starts_at ASC, b.id ASC` : Prisma.sql`b.starts_at DESC, b.id DESC`;
  const pageSize = ACCOUNT_PAGE_SIZE;

  const { ids, total, page, holds } = await deps.prisma.$transaction(async (tx) => {
    const counted = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM booking b JOIN client c ON c.id = b.client_id
       WHERE c.user_id = ${userId}::uuid AND ${where}`;
    const total = counted[0]?.n ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(Math.trunc(query.page ?? 1), 1), pageCount);
    const rows = await tx.$queryRaw<{ id: string; hold_live: boolean }[]>`
      SELECT b.id::text AS id, ${HOLD_LIVE} AS hold_live
        FROM booking b JOIN client c ON c.id = b.client_id
       WHERE c.user_id = ${userId}::uuid AND ${where}
       ORDER BY ${order}
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    return { ids: rows.map((row) => row.id), total, page, holds: new Map(rows.map((row) => [row.id, row.hold_live])) };
  });

  const found = await deps.prisma.booking.findMany({
    where: { id: { in: ids } },
    include: {
      addons: { select: { stage: true, amountRwf: true } },
      payments: { select: TOTALS_PAYMENT_SELECT },
      photographer: PHOTOGRAPHER_SUMMARY,
    },
  });
  const byId = new Map(found.map((booking) => [booking.id, booking]));

  const bookings = ids.flatMap((id) => {
    const booking = byId.get(id);
    if (booking === undefined) return [];
    const totals = bookingTotals(booking, booking.addons, booking.payments);
    const holdLive = booking.status === 'pending_payment' && holds.get(id) === true;
    return [
      {
        reference: booking.reference,
        photographer: booking.photographer,
        serviceName: booking.serviceNameSnapshot,
        packageName: booking.packageNameSnapshot,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        status: booking.status,
        stage: bookingStage(booking, now, 'client'),
        amounts: { totalRwf: totals.grandTotalRwf, paidRwf: totals.collectedRwf, dueRwf: totals.outstandingRwf, refundDueRwf: totals.refundDueRwf },
        holdExpiresAt: holdLive ? (booking.holdExpiresAt?.toISOString() ?? null) : null,
        checkoutPath: holdLive ? checkoutPathOf(deps.checkoutSecret, booking.reference) : null,
      } satisfies AccountBookingRow,
    ];
  });

  return { scope: query.scope, bookings, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** The checkout page for a hold (plan.md Task 16): the reference and its HMAC, never the booking's id. */
function checkoutPathOf(secret: string | undefined, reference: string): string | null {
  return secret === undefined ? null : `/checkout/${reference}/${checkoutToken(secret, reference)}`;
}

/** A booking reference as `booking/reference.ts` mints it. Anything else names nothing, without a query. */
export const REFERENCE_FORMAT = /^BKY-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$/;

export type AccountBooking = AccessedBooking & { photographer: AccountPhotographerContact };

/** The photographer as the booking page shows them: the public profile's name, address and contact details. */
export type AccountPhotographerContact = AccountPhotographer & {
  contactPhone: string | null;
  whatsappPhone: string | null;
  /** The public contact address they chose, never their login. */
  contactEmail: string | null;
};

/**
 * The account's booking with this reference, or null -- for an unknown
 * reference, a malformed one, and another client's alike (T8.1).
 */
export async function findAccountBooking(db: Db, userId: string, reference: string): Promise<AccountBooking | null> {
  if (!REFERENCE_FORMAT.test(reference)) return null;
  return db.booking.findFirst({
    where: { reference, client: { userId } },
    include: {
      ...FULL_BOOKING,
      photographer: { select: { handle: true, displayName: true, contactPhone: true, whatsappPhone: true, contactEmail: true } },
    },
  });
}

/**
 * The booking page of the dashboard: the guest page's view, unchanged
 * (`clientBookingView`, so the frontend reuses its components), and beside it
 * who the photographer is and how to reach them (R8.1), and the "finish
 * payment" link of a live hold.
 */
export type AccountBookingDetail = {
  booking: ClientBookingView;
  photographer: { handle: string; displayName: string; contactPhone: string | null; whatsappPhone: string | null; email: string | null };
  checkoutPath: string | null;
  /** The live hold's end, beside its `checkoutPath`; null whenever that is. */
  holdExpiresAt: string | null;
};

export async function accountBookingDetail(
  deps: ListAccountBookingsDeps,
  booking: AccountBooking,
  now: Date,
): Promise<AccountBookingDetail> {
  let checkoutPath: string | null = null;
  if (booking.status === 'pending_payment' && deps.checkoutSecret !== undefined) {
    // The database clock, as the list and the checkout measure the hold.
    const rows = await deps.prisma.$queryRaw<{ live: boolean }[]>`
      SELECT (hold_expires_at IS NOT NULL AND hold_expires_at > now()) AS live FROM booking WHERE id = ${booking.id}::uuid`;
    if (rows[0]?.live === true) checkoutPath = checkoutPathOf(deps.checkoutSecret, booking.reference);
  }
  const holdExpiresAt = checkoutPath === null ? null : (booking.holdExpiresAt?.toISOString() ?? null);
  const { photographer } = booking;
  return {
    booking: clientBookingView(booking, now),
    photographer: {
      handle: photographer.handle,
      displayName: photographer.displayName,
      contactPhone: photographer.contactPhone,
      whatsappPhone: photographer.whatsappPhone,
      email: photographer.contactEmail,
    },
    checkoutPath,
    holdExpiresAt,
  };
}
