import type { Payment, PrismaClient } from '@prisma/client';

/**
 * Recording a refund the photographer has already made (plan.md Task 19;
 * spec §6.16, §6.11).
 *
 * The system never moves money. `refund_due` is the task; this is his record of
 * having done it by hand, with the MoMo or bank reference that proves it. No
 * provider is called from here -- there is no refund API in this phase (R-5),
 * and adding one later would still leave this the place the fact is recorded.
 *
 * Only a payment already flagged `refund_due` can be refunded: a `succeeded`
 * one is money correctly held, and marking it refunded would quietly rewrite
 * what the booking is worth.
 */

export type RecordRefundResult =
  | { status: 'recorded'; payment: Payment }
  | { status: 'not_found' }
  /** Not flagged for refund: nothing here is owed back. */
  | { status: 'not_refundable' };

export type RecordRefundDeps = { prisma: PrismaClient; now: () => Date };

export async function recordRefund(
  deps: RecordRefundDeps,
  paymentId: string,
  refund: { reference: string; refundedAt?: Date },
): Promise<RecordRefundResult> {
  const { count } = await deps.prisma.payment.updateMany({
    where: { id: paymentId, status: 'refund_due' },
    data: {
      status: 'refunded',
      refundedAt: refund.refundedAt ?? deps.now(),
      refundReference: refund.reference,
    },
  });

  const payment = await deps.prisma.payment.findUnique({ where: { id: paymentId } });
  if (payment === null) return { status: 'not_found' };
  return count === 1 ? { status: 'recorded', payment } : { status: 'not_refundable' };
}
