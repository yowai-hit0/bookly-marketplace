import type { PrismaClient } from '@prisma/client';
import { type AdminBooking, findAdminBooking } from '../booking/admin-view.js';
import { completeIfSettled } from '../booking/auto-complete.js';
import { bookingTotals, TOTALS_PAYMENT_SELECT } from '../booking/totals.js';
import { latestSessionFee, moneyMoving, PAYABLE_STATUSES } from './session-fee.js';

/**
 * "Record cash payment" (admin console fixes, item 7; user decision
 * 2026-09-27): the client paid the photographer by hand, and he writes it down.
 *
 * The cash is a `session_fee` row with the `cash` provider, written
 * `succeeded` and settled at once -- nothing is waiting on anyone. From then
 * on it is money like any other: `bookingTotals` counts it, a cancellation
 * flags it `refund_due`, and the reconciler never looks it up, because it
 * only asks a provider about that provider's own rows. The client is not
 * emailed.
 *
 * Only up to what is owed: cash over the balance would be a refund the
 * photographer created himself. And not while the client may be paying the
 * same balance online -- a prompt on their phone, or a provider call not yet
 * answered, is refused as `in_progress`, the rule `requestSessionFee` uses.
 * Otherwise any open online request is voided (`failed`,
 * `superseded_by_cash`), so the link in its email cannot collect the same
 * money twice: the client's page then shows what is left, if anything, and a
 * payment made there opens a fresh attempt for exactly that.
 *
 * If the client approves the voided ask anyway, the money has moved: the
 * provider's success revives it (payments/webhooks.ts, `revivable`),
 * and what was not due goes back from the platform.
 *
 * Paid in full after the shoot has begun, the booking completes in the same
 * transaction (item 6, `auto-complete.ts`).
 *
 * Cash creates no payout item (marketplace-spec.md R4.2, T4.1): the
 * photographer was handed the money, so the platform owes him nothing for it,
 * and this path deliberately never calls `payouts/ledger.ts`. Refunding it is
 * his to record too (`payments/refund.ts`).
 *
 * Only on the signed-in photographer's own booking (marketplace-spec.md R1.4):
 * the row lock is by id and photographer, so another photographer's booking
 * is `not_found`.
 */

export type CashPaymentDeps = {
  prisma: PrismaClient;
  now: () => Date;
  /** The photographer whose booking this must be: from the token, never the request. */
  photographerId: string;
};

export type CashPaymentInput = { amountRwf: number; note: string | null };

export type CashPaymentResult =
  | { status: 'ok'; booking: AdminBooking }
  | { status: 'not_found' }
  /** A booking that owes nothing because it no longer stands (§6.1). */
  | { status: 'not_allowed' }
  /** Nothing outstanding. */
  | { status: 'nothing_to_pay' }
  /** More than is outstanding. */
  | { status: 'over_outstanding' }
  /** The client may be paying the same balance online right now. */
  | { status: 'in_progress' };

type Outcome = Exclude<CashPaymentResult, { status: 'ok' }>['status'] | 'ok';

/** The `failure_reason` of an online request the cash replaced. */
export const SUPERSEDED_BY_CASH = 'superseded_by_cash';

export async function recordCashPayment(deps: CashPaymentDeps, bookingId: string, input: CashPaymentInput): Promise<CashPaymentResult> {
  const { prisma } = deps;
  const now = deps.now();

  const outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
    // The lock every money edit takes: the balance read here cannot move. The
    // booking row first, then its payment rows (`latestSessionFee`, the voiding
    // below): the lock order in payments/webhooks.ts `applyEvent`, which a
    // session-fee success follows too, so the two queue and never deadlock.
    const bookings = await tx.$queryRaw<{ id: string; status: string; package_price_rwf: number }[]>`
      SELECT id::text AS id, status, package_price_rwf
        FROM booking
       WHERE id = ${bookingId}::uuid AND photographer_id = ${deps.photographerId}::uuid
         FOR UPDATE`;
    const booking = bookings[0];
    if (booking === undefined) return 'not_found';
    if (!PAYABLE_STATUSES.includes(booking.status)) return 'not_allowed';

    const [addons, payments] = await Promise.all([
      tx.bookingAddon.findMany({ where: { bookingId: booking.id }, select: { stage: true, amountRwf: true } }),
      tx.payment.findMany({ where: { bookingId: booking.id }, select: TOTALS_PAYMENT_SELECT }),
    ]);
    const { outstandingRwf } = bookingTotals({ status: booking.status, packagePriceRwf: booking.package_price_rwf }, addons, payments);
    if (outstandingRwf <= 0) return 'nothing_to_pay';
    if (input.amountRwf > outstandingRwf) return 'over_outstanding';

    if (moneyMoving(await latestSessionFee(tx, booking.id))) return 'in_progress';

    // Nothing is moving, so every open online request is only an ask: void it.
    await tx.payment.updateMany({
      where: { bookingId: booking.id, kind: 'session_fee', status: 'initiated' },
      data: { status: 'failed', failureReason: SUPERSEDED_BY_CASH },
    });
    await tx.payment.create({
      data: {
        bookingId: booking.id,
        kind: 'session_fee',
        provider: 'cash',
        amountRwf: input.amountRwf,
        status: 'succeeded',
        initiatedAt: now,
        settledAt: now,
        note: input.note,
      },
    });
    await completeIfSettled(tx, booking.id, now);
    return 'ok';
  });

  if (outcome !== 'ok') return { status: outcome };
  const booking = await findAdminBooking(prisma, deps.photographerId, bookingId);
  return booking === null ? { status: 'not_found' } : { status: 'ok', booking };
}
