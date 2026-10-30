import type { Payment, Prisma, PrismaClient } from '@prisma/client';
import { refundAmountRwf } from '../booking/totals.js';
import { isUniqueViolation } from '../db/errors.js';
import { type AuditLog, type AuditRecord, logAudit, recordAudit } from '../platform/audit.js';

/**
 * Recording a refund that has already been sent (plan.md Task 19; spec §6.16,
 * §6.11; marketplace-spec.md R4.6 and the Phase 4 refund decision).
 *
 * The system never moves money. `refund_due` is the task; this is the record of
 * having done it by hand, with the MoMo or bank reference that proves it. No
 * provider is called from here -- there is no refund API (R-5), and adding one
 * later would still leave this the place the fact is recorded.
 *
 * WHO records it follows where the money is (user decision, Phase 4):
 *
 *   - money paid online (`mtn_momo_direct`, `flutterwave`) sits in the
 *     platform's account, so only a platform admin can send it back and record
 *     it (`/api/platform/refunds`). The studio is refused it as
 *     `refund_with_platform`, and shows it as pending with the platform;
 *   - cash the photographer was handed is his to give back, so only he records
 *     it, in the studio. The platform is refused it as `cash_payment`.
 *
 * Only a payment already flagged `refund_due` can be refunded: a `succeeded`
 * one is money correctly held, and marking it refunded would quietly rewrite
 * what the booking is worth. The earning it had was already taken back when it
 * became `refund_due` (payouts/ledger.ts), so recording the refund touches no
 * payout item.
 *
 * The one exception is an overpayment (Phase 4 overpayment decision): a
 * succeeded online session fee with `overpaid_rwf > 0` has that part to send
 * back, and the platform records it on the `overpayment_*` columns while the
 * payment stays `succeeded`. Its earning was only ever what was due, so this
 * touches no payout item either. One endpoint records whichever refund is
 * pending; if a payment were somehow both `refund_due` and overpaid, the FULL
 * refund wins: `refund_due` is only reached from `succeeded`, it covers the
 * overpaid part, and an overpayment entry is never listed beside it. A caller
 * may name the kind it means (`expectedKind`), so an admin who sent back the
 * overpaid part from a list that has since changed -- the booking cancelled,
 * the whole payment now owed -- is refused rather than recorded as having sent
 * the whole of it.
 *
 * Online refund references are used once, across full and overpayment
 * refunds: the platform's record of where the money went must not name one
 * transfer twice. Checked under a per-reference lock across both columns, and
 * held again by the partial uniques `payment_refund_reference_online_unique`
 * and `payment_overpayment_refund_reference_unique` (23505 is mapped to the
 * same answer). Cash references are the photographer's own words ("handed
 * back at the studio") and stay outside the rule.
 *
 * A platform recording also writes a `refund_recorded` row to the platform's
 * audit trail in its own transaction (Phase 9, R9.4; platform/audit.ts): the
 * payment, the kind, the amount sent back and the reference -- never the
 * client's contact details -- and a log line once it commits. A refusal writes
 * neither.
 *
 * In the studio, only a payment on the signed-in photographer's own bookings
 * (R1.4): another photographer's payment is `not_found` and is left exactly as
 * it was. Who recorded it is written on the payment (`refunded_by_user_id`).
 */

/** A whole payment owed back (`refund_due`), or the overpaid part of a succeeded one. */
export type RefundKind = 'full' | 'overpayment';

export type RecordRefundResult =
  | { status: 'recorded'; payment: Payment; refundKind: RefundKind }
  | { status: 'not_found' }
  /** Not flagged for refund, and no overpaid part left to send back: nothing here is owed back. */
  | { status: 'not_refundable' }
  /** Studio only: money paid online, which a platform admin refunds. */
  | { status: 'refund_with_platform' }
  /** Platform only: cash, which the photographer who was handed it refunds. */
  | { status: 'cash_payment' }
  /** Platform only: another online refund already names this reference. */
  | { status: 'duplicate_refund_reference' }
  /** Platform only: the caller named a kind, and another is what is pending. */
  | { status: 'refund_kind_mismatch'; pending: RefundKind };

/** Who is recording the refund: from the verified token, never the request. */
export type RefundActor =
  /** A photographer in the studio: their own bookings' cash only. */
  | { area: 'studio'; photographerId: string; userId: string }
  /** A platform admin: any booking's online payment. */
  | { area: 'platform'; userId: string };

export type RecordRefundDeps = {
  prisma: PrismaClient;
  now: () => Date;
  actor: RefundActor;
  /** The platform's structured log of the recording (R9.4). */
  log?: AuditLog;
};

export type RefundInput = {
  reference: string;
  refundedAt?: Date;
  /** Platform only: the kind the admin means to record; refused when another is pending. */
  expectedKind?: RefundKind;
};

export async function recordRefund(deps: RecordRefundDeps, paymentId: string, refund: RefundInput): Promise<RecordRefundResult> {
  const { actor } = deps;
  if (actor.area === 'platform') return recordOnlineRefund(deps, actor.userId, paymentId, refund);
  // The studio: cash on the photographer's own bookings only. One guarded
  // UPDATE: two recordings racing for one payment write once.
  const own = { booking: { photographerId: actor.photographerId } };
  const { count } = await deps.prisma.payment.updateMany({
    where: { id: paymentId, status: 'refund_due', provider: 'cash', ...own },
    data: {
      status: 'refunded',
      refundedAt: refund.refundedAt ?? deps.now(),
      refundReference: refund.reference,
      refundedByUserId: actor.userId,
    },
  });

  const payment = await deps.prisma.payment.findFirst({ where: { id: paymentId, ...own } });
  if (payment === null) return { status: 'not_found' };
  if (count === 1) return { status: 'recorded', payment, refundKind: 'full' };
  // Where the money is decides first: the other area's refund is never this one's to record.
  if (payment.provider !== 'cash') return { status: 'refund_with_platform' };
  return { status: 'not_refundable' };
}

type LockedPayment = { provider: string; status: string; overpaid_rwf: number; overpayment_refunded_at: Date | null };

/** What is pending on a payment, if anything. A full refund takes precedence: it covers any overpaid part. */
export function pendingRefundKind(payment: { status: string; overpaidRwf: number; overpaymentRefundedAt: Date | null }): RefundKind | null {
  if (payment.status === 'refund_due') return 'full';
  if (payment.status === 'succeeded' && payment.overpaidRwf > 0 && payment.overpaymentRefundedAt === null) return 'overpayment';
  return null;
}

type OnlineOutcome = Exclude<RecordRefundResult, { status: 'recorded' }> | { status: 'recorded'; refundKind: RefundKind; audit: AuditRecord };

/**
 * A platform admin's record of money paid online sent back. It takes no booking
 * lock, only the payment row and then a per-reference lock that guards no row,
 * so it sits at step 3 of the lock order in payments/webhooks.ts `applyEvent`
 * and cannot deadlock with a cancellation or a success. The payment row is
 * locked first, so two recordings of one payment write once (the second finds
 * nothing pending); the reference lock comes second, so two payments recorded
 * with one reference queue and the second sees the first.
 */
async function recordOnlineRefund(deps: RecordRefundDeps, userId: string, paymentId: string, refund: RefundInput): Promise<RecordRefundResult> {
  const refundedAt = refund.refundedAt ?? deps.now();
  let outcome: OnlineOutcome;
  try {
    outcome = await deps.prisma.$transaction(async (tx): Promise<OnlineOutcome> => {
      const rows = await tx.$queryRaw<LockedPayment[]>`
        SELECT provider, status, overpaid_rwf, overpayment_refunded_at FROM payment WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const row = rows[0];
      if (row === undefined) return { status: 'not_found' };
      if (row.provider === 'cash') return { status: 'cash_payment' };
      const pending = pendingRefundKind({ status: row.status, overpaidRwf: row.overpaid_rwf, overpaymentRefundedAt: row.overpayment_refunded_at });
      if (pending === null) return { status: 'not_refundable' };
      if (refund.expectedKind !== undefined && refund.expectedKind !== pending) return { status: 'refund_kind_mismatch', pending };

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bookly.refund_reference:' || ${refund.reference}))`;
      if (await onlineReferenceTaken(tx, refund.reference)) return { status: 'duplicate_refund_reference' };

      const select = { kind: true, status: true, amountRwf: true, overpaidRwf: true, overpaymentRefundedAt: true, booking: { select: { id: true, photographerId: true } } } as const;
      const updated =
        pending === 'full'
          ? await tx.payment.update({
              where: { id: paymentId },
              data: { status: 'refunded', refundedAt, refundReference: refund.reference, refundedByUserId: userId },
              select,
            })
          : // The status stays `succeeded`: the part that was due is still money correctly held.
            await tx.payment.update({
              where: { id: paymentId },
              data: { overpaymentRefundedAt: refundedAt, overpaymentRefundReference: refund.reference, overpaymentRefundedByUserId: userId },
              select,
            });
      const audit = await recordAudit(
        tx,
        {
          actorUserId: userId,
          action: 'refund_recorded',
          target: { type: 'payment', id: paymentId },
          photographerId: updated.booking?.photographerId ?? null,
          details: {
            paymentKind: updated.kind,
            refundKind: pending,
            amountRwf: pending === 'full' ? refundAmountRwf(updated) : updated.overpaidRwf,
            reference: refund.reference,
            bookingId: updated.booking?.id ?? null,
          },
        },
        deps.now(),
      );
      return { status: 'recorded', refundKind: pending, audit };
    });
  } catch (error) {
    // A recording that slipped past the check: the partial uniques refuse it the same way.
    if (isUniqueViolation(error)) return { status: 'duplicate_refund_reference' };
    throw error;
  }
  if (outcome.status !== 'recorded') return outcome;
  logAudit(deps.log, [outcome.audit]);
  const payment = await deps.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  return { status: 'recorded', payment, refundKind: outcome.refundKind };
}

/** Whether any online refund, of either kind, already names this reference. */
async function onlineReferenceTaken(tx: Prisma.TransactionClient, reference: string): Promise<boolean> {
  const taken = await tx.payment.count({
    where: { OR: [{ refundReference: reference, provider: { not: 'cash' } }, { overpaymentRefundReference: reference }] },
  });
  return taken > 0;
}
