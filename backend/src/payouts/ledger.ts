import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * The payout ledger (marketplace-spec.md R4.2, R4.3; marketplace-data-model.md
 * §3.9): what a photographer is owed, one `payout_item` per fact.
 *
 * Money sits in the platform's account and is paid out by hand, with no
 * commission (decisions table: money out, payout timing). So:
 *
 *   - a non-cash booking or session fee that SUCCEEDS earns what was due:
 *     `recordEarning`, called in the transaction that set `succeeded`
 *     (payments/webhooks.ts, for every success a delivery or the reconciler
 *     applies; db/seed-demo.ts). That is the full amount, less the overpaid
 *     part of an overpaid session fee (`overpaid_rwf`, set in the same update):
 *     the platform returns that part to the client, so it is never the
 *     photographer's (Phase 4 overpayment decision);
 *   - a payment that becomes `refund_due` takes its earning back:
 *     `recordRefundDue`, called in the transaction that set `refund_due`
 *     (booking/cancel.ts, booking/admin-actions.ts, payments/webhooks.ts). An
 *     earning in no payout is voided; one already in a payout, draft or paid,
 *     gets a `reversal` of the earning's own amount, negative, which nets off on
 *     the next payout (T4.2). For an overpaid fee that is the reduced amount,
 *     never the payment's;
 *   - cash creates nothing (T4.1): the photographer was handed it, so the
 *     platform owes nothing for it. `recordEarning` refuses it, and
 *     payments/cash.ts never calls it;
 *   - subscriptions (Phase 5) never create items: only `booking_fee` and
 *     `session_fee` earn.
 *
 * Idempotent by construction: `@@unique([paymentId, kind])` allows one earning
 * and one reversal per payment, and both inserts are `ON CONFLICT DO NOTHING`,
 * so a replayed webhook or a second cancellation adds nothing.
 *
 * "Payable now" is derived on every read, never stored (R4.3): `payableItems`
 * is the §3.9 SQL, with the clock passed in so tests and the API agree on it.
 *
 * This module is the only writer of `payout_item` outside payouts/payouts.ts,
 * which assigns items to payouts and releases them.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The booking statuses after which a session fee is never payable (§3.9). */
export const UNPAYABLE_BOOKING_STATUSES = ['cancelled_by_client', 'cancelled_by_photographer', 'cancelled_by_platform', 'expired'] as const;

/** The payment kinds that earn. A Phase 5 subscription payment never does. */
export const EARNING_PAYMENT_KINDS = ['booking_fee', 'session_fee'] as const;

export type EarningOutcome =
  | 'recorded'
  /** Already recorded: a replay. */
  | 'exists'
  /** Cash, not succeeded, or a kind that does not earn. */
  | 'not_eligible';

/**
 * The earning for a payment the caller has just set `succeeded`, in the same
 * transaction. The amount is the payment's, frozen at initiation, less its
 * overpaid part (CHECK payment_overpaid_range keeps that positive); the
 * photographer is the booking's, never the caller's.
 */
export async function recordEarning(tx: Prisma.TransactionClient, paymentId: string): Promise<EarningOutcome> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO payout_item (photographer_id, payment_id, kind, amount_rwf)
    SELECT b.photographer_id, p.id, 'earning', p.amount_rwf - p.overpaid_rwf
      FROM payment p
      JOIN booking b ON b.id = p.booking_id
     WHERE p.id = ${paymentId}::uuid
       AND p.status = 'succeeded'
       AND p.provider <> 'cash'
       AND p.kind = ANY(${[...EARNING_PAYMENT_KINDS]}::text[])
    ON CONFLICT (payment_id, kind) DO NOTHING
    RETURNING id::text AS id`;
  if (inserted.length === 1) return 'recorded';
  const existing = await tx.payoutItem.count({ where: { paymentId, kind: 'earning' } });
  return existing > 0 ? 'exists' : 'not_eligible';
}

export type RefundDueOutcome =
  /** The earning was in no payout: it no longer counts. */
  | 'voided'
  /** The earning was in a draft or paid payout: a negative line nets it off next time. */
  | 'reversed'
  /** Nothing to undo: cash, a payment that never succeeded (a late or duplicate fee), or one from before Phase 4. */
  | 'no_earning'
  /** Already undone: a replay. */
  | 'already_undone';

/**
 * Takes back the earning of a payment the caller has just set `refund_due`, in
 * the same transaction (R4.2, T4.2). The earning row is locked first, so a
 * payout being built at the same moment (payouts/payouts.ts locks the items it
 * takes) either finishes first -- and this sees `payout_id` set and reverses --
 * or waits for this to void it, and leaves it out.
 */
export async function recordRefundDue(tx: Prisma.TransactionClient, paymentId: string, at: Date): Promise<RefundDueOutcome> {
  const payments = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM payment WHERE id = ${paymentId}::uuid`;
  if (payments[0]?.status !== 'refund_due') {
    // A caller bug, not a state to tolerate: the ledger would disagree with the payment.
    throw new Error(`recordRefundDue called for payment ${paymentId}, which is not refund_due`);
  }

  const earnings = await tx.$queryRaw<{ id: string; photographer_id: string; amount_rwf: number; payout_id: string | null; voided_at: Date | null }[]>`
    SELECT id::text AS id, photographer_id::text AS photographer_id, amount_rwf, payout_id::text AS payout_id, voided_at
      FROM payout_item
     WHERE payment_id = ${paymentId}::uuid AND kind = 'earning'
       FOR UPDATE`;
  const earning = earnings[0];
  if (earning === undefined) return 'no_earning';
  if (earning.voided_at !== null) return 'already_undone';

  if (earning.payout_id === null) {
    await tx.payoutItem.update({ where: { id: earning.id }, data: { voidedAt: at } });
    return 'voided';
  }

  const reversed = await tx.$executeRaw`
    INSERT INTO payout_item (photographer_id, payment_id, kind, amount_rwf)
    VALUES (${earning.photographer_id}::uuid, ${paymentId}::uuid, 'reversal', ${-earning.amount_rwf})
    ON CONFLICT (payment_id, kind) DO NOTHING`;
  return reversed === 1 ? 'reversed' : 'already_undone';
}

// --- Payable now (R4.3; marketplace-data-model.md §3.9) ---------------------------------

/**
 * Whether an open item (`pi`, its payment `p`, the payment's booking `b`) is
 * payable at `now`: the §3.9 predicate, written once. A reversal always is; a
 * booking fee once it succeeded; a session fee once it succeeded AND its shoot
 * has ended AND the booking was not cancelled.
 */
export function payablePredicate(now: Date): Prisma.Sql {
  return Prisma.sql`(
        pi.kind = 'reversal'
     OR (p.status = 'succeeded' AND p.kind = 'booking_fee')
     OR (p.status = 'succeeded' AND p.kind = 'session_fee' AND b.ends_at <= ${now}::timestamptz
         AND b.status <> ALL(${[...UNPAYABLE_BOOKING_STATUSES]}::text[])))`;
}

export type PayableItem = { id: string; payment_id: string; kind: 'earning' | 'reversal'; amount_rwf: number };

/**
 * The photographer's items payable now: in no payout, not voided, and payable
 * by `payablePredicate`. `lock` takes each row `FOR UPDATE` (payout building).
 */
export async function payableItems(db: Db, photographerId: string, now: Date, options: { lock?: boolean } = {}): Promise<PayableItem[]> {
  const lock = options.lock === true ? Prisma.sql`FOR UPDATE OF pi` : Prisma.empty;
  return db.$queryRaw<PayableItem[]>`
    SELECT pi.id::text AS id, pi.payment_id::text AS payment_id, pi.kind, pi.amount_rwf
      FROM payout_item pi
      JOIN payment p ON p.id = pi.payment_id
      LEFT JOIN booking b ON b.id = p.booking_id
     WHERE pi.photographer_id = ${photographerId}::uuid
       AND pi.payout_id IS NULL
       AND pi.voided_at IS NULL
       AND ${payablePredicate(now)}
     ORDER BY pi.created_at, pi.id
     ${lock}`;
}

/** The sum of `payableItems`: may be zero or negative, when reversals outweigh new earnings. */
export async function payableBalance(db: Db, photographerId: string, now: Date): Promise<number> {
  const rows = await db.$queryRaw<{ total: number }[]>`
    SELECT COALESCE(sum(pi.amount_rwf), 0)::int AS total
      FROM payout_item pi
      JOIN payment p ON p.id = pi.payment_id
      LEFT JOIN booking b ON b.id = p.booking_id
     WHERE pi.photographer_id = ${photographerId}::uuid
       AND pi.payout_id IS NULL
       AND pi.voided_at IS NULL
       AND ${payablePredicate(now)}`;
  return rows[0]?.total ?? 0;
}

/**
 * Releases the items of a draft being cancelled (§3.9: "clear payout_id on its
 * items"), in the caller's transaction, after the payout row is locked.
 *
 * One refinement: an earning that was in the draft when its payment became
 * `refund_due` got a reversal instead of a void (`recordRefundDue`). Once the
 * draft is cancelled neither was ever paid, so both are voided together:
 * otherwise the earning, no longer `succeeded`, would never be payable while
 * its reversal always is, and the next payout would take the refund off money
 * the photographer never received.
 */
export async function releaseDraftItems(tx: Prisma.TransactionClient, payoutId: string, at: Date): Promise<void> {
  const released = await tx.$queryRaw<{ id: string; payment_id: string }[]>`
    UPDATE payout_item SET payout_id = NULL
     WHERE payout_id = ${payoutId}::uuid
    RETURNING id::text AS id, payment_id::text AS payment_id`;
  if (released.length === 0) return;

  await tx.$executeRaw`
    WITH undone AS (
      SELECT e.payment_id
        FROM payout_item e
        JOIN payment p ON p.id = e.payment_id
        JOIN payout_item r ON r.payment_id = e.payment_id AND r.kind = 'reversal' AND r.payout_id IS NULL AND r.voided_at IS NULL
       WHERE e.id = ANY(${released.map((item) => item.id)}::uuid[])
         AND e.kind = 'earning'
         AND p.status <> 'succeeded'
    )
    UPDATE payout_item SET voided_at = ${at}::timestamptz
     WHERE payment_id IN (SELECT payment_id FROM undone) AND payout_id IS NULL AND voided_at IS NULL`;
}
