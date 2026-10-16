import type { Prisma } from '@prisma/client';
import { bookingTotals } from './totals.js';

/**
 * "Completed" means paid (admin console fixes, item 6; user decision
 * 2026-09-27): a booking whose shoot has begun completes by itself the moment
 * a payment clears what it owes -- a session fee arriving by webhook, or cash
 * the photographer records (item 7).
 *
 * Called inside the transaction that recorded the payment, after the payment
 * row is `succeeded`, so the booking and the money move together. It does
 * exactly what `close(..., 'completed')` does -- the status and
 * `completed_at`, nothing else -- and only from `confirmed`, so a replayed
 * webhook, or a payment that lands on a booking already completed, changes
 * nothing. A balance cleared before the shoot begins leaves the booking
 * `confirmed`: the photographer marks it completed afterwards.
 *
 * Answers whether it completed the booking.
 */
export async function completeIfSettled(tx: Prisma.TransactionClient, bookingId: string, now: Date): Promise<boolean> {
  // The same lock every money edit takes, so the totals read here cannot move.
  const rows = await tx.$queryRaw<{ status: string; starts_at: Date; package_price_rwf: number }[]>`
    SELECT status, starts_at, package_price_rwf FROM booking WHERE id = ${bookingId}::uuid FOR UPDATE`;
  const booking = rows[0];
  if (booking === undefined || booking.status !== 'confirmed' || booking.starts_at > now) return false;

  const [addons, payments] = await Promise.all([
    tx.bookingAddon.findMany({ where: { bookingId }, select: { stage: true, amountRwf: true } }),
    tx.payment.findMany({ where: { bookingId }, select: { status: true, amountRwf: true } }),
  ]);
  const { outstandingRwf } = bookingTotals({ status: booking.status, packagePriceRwf: booking.package_price_rwf }, addons, payments);
  if (outstandingRwf > 0) return false;

  const { count } = await tx.booking.updateMany({
    where: { id: bookingId, status: 'confirmed' },
    data: { status: 'completed', completedAt: now },
  });
  return count === 1;
}
