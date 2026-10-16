import { kigaliDateOf } from '../availability/engine.js';
import { type AccessedBooking, type CancellationPolicy, cancellationPolicyOf } from './access.js';
import { maskEmail, pendingMaskedEmailOf } from './email-change.js';
import { type ClientNotice, clientNotices } from './notices.js';
import { type ClientStage, bookingStage } from './stage.js';
import { bookingTotals } from './totals.js';

/**
 * A booking as its own client may see it (plan.md Task 18; spec §3.9): status,
 * when and where, what it costs and what is still owed, the delivery link once
 * photos are sent, and whether it can still be cancelled or paid.
 *
 * Every amount comes from `bookingTotals()` (data-model_v2.md §6.1) -- nothing
 * is recomputed in the browser, and a cancelled or no-show booking owes
 * nothing. The token that reached this page appears nowhere in it, and neither
 * does the booking's id: the page needs neither, and a value that is never sent
 * cannot leak from the client's screen.
 */

/** Statuses whose shoot has not happened and whose money can still move. */
const PAYABLE_STATUSES = ['confirmed', 'completed'];

const MS_PER_HOUR = 3_600_000;

export type ClientBookingView = {
  reference: string;
  status: string;
  /** The client's display stage (`stage.ts`): never `needs_review`. */
  stage: ClientStage;
  clientName: string;
  /**
   * Where the booking's emails go, masked (`a•••••@example.com`) so the client
   * can recognise it and whoever else holds the link cannot read it (2026-09-25).
   * The full address is never in this view.
   */
  maskedEmail: string;
  /** A change asked for and not yet confirmed from the new address, masked; null once its link lapses. */
  pendingMaskedEmail: string | null;
  startsAt: string;
  endsAt: string;
  serviceName: string;
  packageName: string;
  packagePriceRwf: number;
  packagePhotoCount: number;
  packageDurationMinutes: number;
  locationText: string;
  partySize: number | null;
  specialRequests: string | null;
  addons: { name: string; priceRwf: number; stage: string }[];
  totals: {
    quotedTotalRwf: number;
    grandTotalRwf: number;
    collectedRwf: number;
    refundDueRwf: number;
    outstandingRwf: number;
  };
  bookingFeeRwf: number;
  payments: { kind: string; status: string; amountRwf: number; settledAt: string | null }[];
  /** Whether the client may cancel now: a confirmed booking, before its photographer's cut-off (R1.8). */
  canCancel: boolean;
  /**
   * The cancellation policy this booking was made under (R1.8), so the page
   * states the terms the client actually has rather than a blanket rule.
   * `deadline` is the instant a client cancellation stops being accepted
   * (`startsAt` minus the cut-off; exactly `startsAt` when there is none), or
   * null once the booking is past any client cancellation -- cancelled,
   * expired or its shoot done. `bookingFeeRefundable` says whether cancelling
   * refunds the booking fee; a session fee already paid is always refunded.
   */
  cancellation: { deadline: string | null; bookingFeeRefundable: boolean };
  cancellationReason: string | null;
  cancelledAt: string | null;
  /** Present once there is money to take and a booking to take it for. */
  sessionFee: { outstandingRwf: number; waitingPayment: { ourRef: string } | null } | null;
  /** Present once the photographer has sent the photos (spec §3.9, §6.20). */
  delivery: { url: string | null; expiresOn: string | null; expired: boolean; note: string | null } | null;
  /** What has happened since, newest first (2026-09-25; `notices.ts`). */
  notices: ClientNotice[];
};

export function clientBookingView(booking: AccessedBooking, now: Date): ClientBookingView {
  const totals = bookingTotals(booking, booking.addons, booking.payments);
  const waiting = booking.payments.find(
    (payment) => payment.kind === 'session_fee' && (payment.status === 'initiated' || payment.status === 'pending'),
  );

  return {
    reference: booking.reference,
    status: booking.status,
    stage: bookingStage(booking, now, 'client'),
    clientName: booking.contactName,
    maskedEmail: maskEmail(booking.contactEmail),
    pendingMaskedEmail: pendingMaskedEmailOf(booking, now),
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    serviceName: booking.serviceNameSnapshot,
    packageName: booking.packageNameSnapshot,
    packagePriceRwf: booking.packagePriceRwf,
    packagePhotoCount: booking.packagePhotoCount,
    packageDurationMinutes: booking.packageDurationMinutes,
    locationText: booking.locationText,
    partySize: booking.partySize,
    specialRequests: booking.specialRequests,
    addons: booking.addons.map((addon) => ({ name: addon.nameSnapshot, priceRwf: addon.amountRwf, stage: addon.stage })),
    totals,
    bookingFeeRwf: booking.bookingFeeRwf,
    // Only money that moved, or is owed back: an abandoned attempt is not the client's business.
    payments: booking.payments
      .filter((payment) => ['succeeded', 'refund_due', 'refunded'].includes(payment.status))
      .map((payment) => ({
        kind: payment.kind,
        status: payment.status,
        amountRwf: payment.amountRwf,
        settledAt: payment.settledAt?.toISOString() ?? null,
      })),
    canCancel: canCancel(booking, now),
    cancellation: {
      deadline: CANCELLABLE_STATUSES.includes(booking.status) ? cancellationDeadline(booking).toISOString() : null,
      bookingFeeRefundable: cancellationPolicyOf(booking).bookingFeeRefundableOnClientCancel,
    },
    cancellationReason: booking.cancellationReason,
    cancelledAt: booking.cancelledAt?.toISOString() ?? null,
    sessionFee:
      PAYABLE_STATUSES.includes(booking.status) && totals.outstandingRwf > 0
        ? { outstandingRwf: totals.outstandingRwf, waitingPayment: waiting === undefined ? null : { ourRef: waiting.ourRef } }
        : null,
    delivery: deliveryOf(booking, now),
    notices: clientNotices({
      outbox: booking.outbox,
      notes: booking.notes,
      // Money still owed once the shoot is done: before then it is the session fee the page already asks for.
      balance: {
        outstandingRwf: totals.outstandingRwf,
        showing: ['completed', 'closed'].includes(bookingStage(booking, now, 'client')),
        since: booking.completedAt ?? booking.endsAt,
      },
    }),
  };
}

/**
 * Statuses a client cancellation can still apply to: a confirmed booking, or a
 * hold that will be one once paid. The policy's deadline is shown for these.
 */
const CANCELLABLE_STATUSES = ['pending_payment', 'confirmed'];

type CancelPolicyFields = { startsAt: Date } & Pick<CancellationPolicy, 'clientCancelCutoffHours'>;

/**
 * The first instant a client may no longer cancel: `clientCancelCutoffHours`
 * before the shoot, under the policy the booking was made with (R1.8).
 */
export function cancellationDeadline(booking: CancelPolicyFields): Date {
  return new Date(booking.startsAt.getTime() - booking.clientCancelCutoffHours * MS_PER_HOUR);
}

/**
 * Only while the booking stands, and until the photographer's cut-off: up to
 * `clientCancelCutoffHours` before the shoot (marketplace-spec.md R1.8). A
 * cut-off of 0 is any time before the shoot, the single-photographer rule
 * (spec §6.10). The cut-off instant itself is already too late, as the start
 * itself is with no cut-off. The cut-off is the booking's own snapshot, so
 * editing the photographer's settings never moves it.
 */
export function canCancel(booking: { status: string } & CancelPolicyFields, now: Date): boolean {
  return booking.status === 'confirmed' && now < cancellationDeadline(booking);
}

/**
 * The delivery, once it has been sent. `delivery_expires_on` is a date, and
 * dates end at the end of their day in Kigali (spec §6.5, §6.20): the link is
 * live all through its last day and the expired message follows it.
 */
function deliveryOf(booking: AccessedBooking, now: Date): ClientBookingView['delivery'] {
  if (booking.deliverySentAt === null || booking.deliveryUrl === null) return null;
  const expiresOn = booking.deliveryExpiresOn === null ? null : booking.deliveryExpiresOn.toISOString().slice(0, 10);
  const expired = expiresOn !== null && kigaliDateOf(now) > expiresOn;
  return {
    url: expired ? null : booking.deliveryUrl,
    expiresOn,
    expired,
    note: booking.deliveryNote,
  };
}
