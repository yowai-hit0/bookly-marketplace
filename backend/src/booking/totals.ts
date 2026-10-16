import type { BookingStatus } from '../db/statuses.js';

/**
 * A booking's money, derived (data-model_v2.md §6.1): the one function every
 * amount after creation comes from. There is no stored total and no stored
 * session fee; there is this.
 *
 *   quotedTotalRwf   package price + at-booking add-ons
 *   grandTotalRwf    quoted total + post-shoot add-ons
 *   collectedRwf     payments that succeeded
 *   refundDueRwf     payments held that are owed back -- reported, never netted off
 *   outstandingRwf   what the client still owes, which depends on the status
 *
 * Nothing is owed on a booking that no longer stands: a no-show or a client
 * cancellation forfeits the fee and closes it (spec §6.10, §6.12), an admin
 * cancellation owes the client instead (§6.11), and an expired hold was never a
 * booking to owe against.
 */

export type TotalsBooking = { status: string; packagePriceRwf: number };
export type TotalsAddon = { stage: string; amountRwf: number };
export type TotalsPayment = { status: string; amountRwf: number };

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
  const collectedRwf = sum(payments.filter((p) => p.status === 'succeeded').map((p) => p.amountRwf));
  const refundDueRwf = sum(payments.filter((p) => p.status === 'refund_due').map((p) => p.amountRwf));
  // Never negative: an overpayment is money to hand back, not a negative debt.
  const outstandingRwf = OWING_STATUSES.has(booking.status) ? Math.max(grandTotalRwf - collectedRwf, 0) : 0;

  return { quotedTotalRwf, grandTotalRwf, collectedRwf, refundDueRwf, outstandingRwf };
}
