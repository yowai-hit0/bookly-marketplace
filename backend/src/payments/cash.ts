import type { PrismaClient } from '@prisma/client';
import { type AdminBooking, findAdminBooking } from '../booking/admin-view.js';
import { completeIfSettled } from '../booking/auto-complete.js';
import { bookingTotals } from '../booking/totals.js';
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
 * Paid in full after the shoot has begun, the booking completes in the same
 * transaction (item 6, `auto-complete.ts`).
 */

export type CashPaymentDeps = { prisma: PrismaClient; now: () => Date };

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
    // The lock every money edit takes: the balance read here cannot move.
    const bookings = await tx.$queryRaw<{ id: string; status: string; package_price_rwf: number }[]>`
      SELECT id::text AS id, status, package_price_rwf FROM booking WHERE id = ${bookingId}::uuid FOR UPDATE`;
    const booking = bookings[0];
    if (booking === undefined) return 'not_found';
    if (!PAYABLE_STATUSES.includes(booking.status)) return 'not_allowed';

    const [addons, payments] = await Promise.all([
      tx.bookingAddon.findMany({ where: { bookingId: booking.id }, select: { stage: true, amountRwf: true } }),
      tx.payment.findMany({ where: { bookingId: booking.id }, select: { status: true, amountRwf: true } }),
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
  const booking = await findAdminBooking(prisma, bookingId);
  return booking === null ? { status: 'not_found' } : { status: 'ok', booking };
}
