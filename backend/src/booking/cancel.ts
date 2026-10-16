import type { Prisma, PrismaClient } from '@prisma/client';
import { enqueue } from '../outbox/enqueue.js';
import { type AccessedBooking, findBookingByToken } from './access.js';
import { canCancel } from './client-view.js';

/**
 * A client cancelling their own booking (plan.md Task 18; spec §3.6, §6.10).
 *
 * The booking moves to `cancelled_by_client`, which takes it out of the
 * exclusion constraint's predicate -- that, and nothing else, is what returns
 * the slot and its buffer to the public calendar (data-model_v2.md §9.1).
 *
 * **The booking fee is not refunded.** It stays `succeeded`, forfeited, as the
 * summary said before payment and the cancellation email says again. A session
 * fee already paid is different money: it is marked `refund_due` and the
 * photographer is alerted, because the system never moves money itself
 * (spec §6.16). Everything -- status, refunds, both emails -- commits together
 * or not at all.
 */

export type CancelResult =
  | { status: 'cancelled'; booking: AccessedBooking }
  /** Already cancelled, past its shoot, or never confirmed: nothing was changed. */
  | { status: 'not_cancellable' };

export type CancelDeps = { prisma: PrismaClient; now: () => Date };

/**
 * Cancels the booking the token addresses. The token is re-read inside the
 * transaction, so a link that stopped working between page and confirmation
 * cancels nothing.
 */
export async function cancelByClient(deps: CancelDeps, token: string): Promise<CancelResult> {
  const { prisma } = deps;
  const now = deps.now();

  const booking = await findBookingByToken(prisma, token);
  if (booking === null || !canCancel(booking, now)) return { status: 'not_cancellable' };

  const cancelled = await prisma.$transaction(async (tx) => {
    // Guarded on the status we read: a photographer cancelling or rescheduling
    // in the same moment wins, and this returns untouched.
    const { count } = await tx.booking.updateMany({
      where: { id: booking.id, status: 'confirmed' },
      data: { status: 'cancelled_by_client', cancelledAt: now },
    });
    if (count === 0) return null;

    const refunded = await refundPaidSessionFees(tx, booking);

    await enqueue(tx, {
      kind: 'email',
      template: 'cancellation',
      recipient: booking.contactEmail,
      bookingId: booking.id,
      dedupeKey: `email:cancellation:${booking.id}`,
      payload: {
        locale: booking.locale,
        reference: booking.reference,
        clientName: booking.contactName,
        serviceName: booking.serviceNameSnapshot,
        packageName: booking.packageNameSnapshot,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        cancelledBy: 'client',
        reason: null,
        bookingFeeRwf: booking.bookingFeeRwf,
        // What the client is owed back: never the booking fee, only a session
        // fee they had already paid.
        refundRwf: refunded.reduce((total, payment) => total + payment.amountRwf, 0),
      },
    });

    const admin = await tx.adminUser.findFirst({ orderBy: { createdAt: 'asc' }, select: { email: true } });
    if (admin !== null) {
      await enqueue(tx, {
        kind: 'email',
        template: 'admin_alert',
        recipient: admin.email,
        dedupeKey: `email:admin_alert:booking_cancelled:${booking.id}`,
        payload: {
          variant: 'booking_cancelled',
          reference: booking.reference,
          clientName: booking.contactName,
          serviceName: booking.serviceNameSnapshot,
          startsAt: booking.startsAt.toISOString(),
          endsAt: booking.endsAt.toISOString(),
          bookingFeeRwf: booking.bookingFeeRwf,
        },
      });
      for (const payment of refunded) {
        await enqueue(tx, {
          kind: 'email',
          template: 'admin_alert',
          recipient: admin.email,
          dedupeKey: `email:admin_alert:refund_due:${payment.id}`,
          payload: {
            variant: 'refund_due',
            reference: booking.reference,
            clientName: booking.contactName,
            amountRwf: payment.amountRwf,
            reason: 'session_fee_after_client_cancel',
            paymentReference: payment.providerRef ?? payment.ourRef,
            provider: payment.provider,
            startsAt: booking.startsAt.toISOString(),
          },
        });
      }
    }

    return true;
  });

  if (cancelled === null) return { status: 'not_cancellable' };

  const after = await findBookingByToken(prisma, token);
  // The link cannot have stopped working in between, but the view is the
  // booking as it now stands, not as it was read before the change.
  if (after === null) return { status: 'not_cancellable' };
  return { status: 'cancelled', booking: after };
}

/** Session fees already collected are owed back; the booking fee is not (spec §6.10). */
async function refundPaidSessionFees(
  tx: Prisma.TransactionClient,
  booking: AccessedBooking,
): Promise<AccessedBooking['payments']> {
  const paid = booking.payments.filter((payment) => payment.kind === 'session_fee' && payment.status === 'succeeded');
  const refunded: AccessedBooking['payments'] = [];
  for (const payment of paid) {
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: 'succeeded' },
      data: { status: 'refund_due' },
    });
    if (count === 1) refunded.push(payment);
  }
  return refunded;
}
