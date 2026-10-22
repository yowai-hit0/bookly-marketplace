import type { BookingStatus } from '../db/statuses.js';

/**
 * A booking's money, derived (data-model_v2.md §6.1): the one function every
 * amount after creation comes from. There is no stored total and no stored
 * session fee; there is this.
 *
 *   quotedTotalRwf   package price + at-booking add-ons
 *   grandTotalRwf    quoted total + post-shoot add-ons
 *   collectedRwf     payments that succeeded, each counted for the part that was
 *                    due: `amount_rwf - overpaid_rwf`
 *   refundDueRwf     money held that is owed back -- reported, never netted off:
 *                    each `refund_due` payment's `refundAmountRwf`, and each
 *                    overpaid part not yet sent back
 *   outstandingRwf   what the client still owes, which depends on the status
 *
 * The overpaid part of a succeeded online session fee (Phase 4 overpayment
 * decision) is the platform's to send back, so it never counts towards the
 * booking: an add-on added afterwards asks for new money rather than quietly
 * spending what is queued for refund, and a second overpayment is measured
 * against what was due, not against the first one's surplus.
 *
 * Nothing is owed on a booking that no longer stands: a no-show or a client
 * cancellation forfeits the fee and closes it (spec §6.10, §6.12), an admin
 * cancellation owes the client instead (§6.11), and an expired hold was never a
 * booking to owe against.
 */

export type TotalsBooking = { status: string; packagePriceRwf: number };
export type TotalsAddon = { stage: string; amountRwf: number };
/**
 * The overpayment fields are optional so a hand-built payment (a test, an
 * in-memory row) reads as never overpaid. Every database read selects them:
 * `TOTALS_PAYMENT_SELECT`, or the whole row.
 */
export type TotalsPayment = { status: string; amountRwf: number; overpaidRwf?: number; overpaymentRefundedAt?: Date | string | null };

/** What `bookingTotals` reads from a payment row, for a `select`. */
export const TOTALS_PAYMENT_SELECT = { status: true, amountRwf: true, overpaidRwf: true, overpaymentRefundedAt: true } as const;

/** The part of a succeeded payment that was due: what it counts for and what it earns. */
export function dueRwf(payment: TotalsPayment): number {
  return payment.amountRwf - (payment.overpaidRwf ?? 0);
}

/** The overpaid part still held: overpaid and not yet sent back. */
export function overpaymentHeldRwf(payment: TotalsPayment): number {
  return payment.overpaymentRefundedAt == null ? (payment.overpaidRwf ?? 0) : 0;
}

/**
 * What a full refund of the payment sends back: the whole amount, less an
 * overpaid part the platform has already returned (Phase 4 overpayment
 * decision). Not yet returned, the full refund covers it.
 */
export function refundAmountRwf(payment: TotalsPayment): number {
  return payment.overpaymentRefundedAt == null ? payment.amountRwf : dueRwf(payment);
}

export type BookingTotals = {
  quotedTotalRwf: number;
  grandTotalRwf: number;
  collectedRwf: number;
  refundDueRwf: number;
  outstandingRwf: number;
};

const OWING_STATUSES: ReadonlySet<string> = new Set<BookingStatus>(['pending_payment', 'confirmed', 'completed']);

export function bookingTotals(
  booking: TotalsBooking,
  addons: readonly TotalsAddon[],
  payments: readonly TotalsPayment[],
): BookingTotals {
  const sum = (amounts: readonly number[]) => amounts.reduce((total, amount) => total + amount, 0);

  const quotedTotalRwf = booking.packagePriceRwf + sum(addons.filter((a) => a.stage === 'at_booking').map((a) => a.amountRwf));
  const grandTotalRwf = quotedTotalRwf + sum(addons.filter((a) => a.stage === 'post_shoot').map((a) => a.amountRwf));
  const succeeded = payments.filter((p) => p.status === 'succeeded');
  const collectedRwf = sum(succeeded.map(dueRwf));
  const refundDueRwf = sum(payments.filter((p) => p.status === 'refund_due').map(refundAmountRwf)) + sum(succeeded.map(overpaymentHeldRwf));
  // Never negative: an overpayment is money to hand back, not a negative debt.
  const outstandingRwf = OWING_STATUSES.has(booking.status) ? Math.max(grandTotalRwf - collectedRwf, 0) : 0;

  return { quotedTotalRwf, grandTotalRwf, collectedRwf, refundDueRwf, outstandingRwf };
}
