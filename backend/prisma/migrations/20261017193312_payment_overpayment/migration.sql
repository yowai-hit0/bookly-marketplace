-- ============================================================================
-- Overpayments (marketplace-spec.md Phase 4, overpayment decision;
-- marketplace-data-model.md §3.9).
--
-- A client who pays a session fee online for more than the booking is worth
-- has paid into the platform's account, so:
--
--   payment.overpaid_rwf        the part over what was due. The payment stays
--                               `succeeded`; its earning is amount - overpaid,
--                               and booking totals count only the part that was
--                               due. Always below the amount: a fee that is
--                               wholly extra is `refund_due` instead.
--   payment.overpayment_*       the platform admin's record of sending that part
--                               back: when, the MoMo or bank reference, and who.
--
-- Columns on `payment`, not a table: a payment has at most one overpayment,
-- fixed when it succeeds, and the full refund it might later need already lives
-- on the same row.
--
-- Online refund references -- full refunds and overpayment refunds alike -- are
-- used once (two partial uniques here, and a check across both columns under a
-- lock in payments/refund.ts). Cash refund references are the photographer's
-- free text and stay outside the rule. If a database already holds two online
-- refunds with one reference, the first index refuses to build: resolve them
-- by hand first.
--
-- Nothing is backfilled: an overpayment taken before this migration has
-- overpaid_rwf = 0 and its earning at the full amount.
--
-- Generated with `migrate dev --create-only`; everything after the HAND-WRITTEN
-- banner is invisible to Prisma.
-- ============================================================================

-- AlterTable
ALTER TABLE "payment" ADD COLUMN     "overpaid_rwf" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "overpayment_refund_reference" TEXT,
ADD COLUMN     "overpayment_refunded_at" TIMESTAMPTZ(6),
ADD COLUMN     "overpayment_refunded_by_user_id" UUID;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_overpayment_refunded_by_user_id_fkey" FOREIGN KEY ("overpayment_refunded_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- HAND-WRITTEN (invisible to Prisma). marketplace-data-model.md §3.11.
-- ============================================================================

-- A reference names one refund of money paid online, whichever kind it was.
CREATE UNIQUE INDEX "payment_refund_reference_online_unique"
  ON "payment" (refund_reference) WHERE refund_reference IS NOT NULL AND provider <> 'cash';
CREATE UNIQUE INDEX "payment_overpayment_refund_reference_unique"
  ON "payment" (overpayment_refund_reference) WHERE overpayment_refund_reference IS NOT NULL;

ALTER TABLE "payment"
  -- Some of the payment was due: a fee that is wholly extra is refund_due, not overpaid.
  ADD CONSTRAINT "payment_overpaid_range" CHECK (overpaid_rwf >= 0 AND overpaid_rwf < amount_rwf),
  -- Only an online session fee overpays: a booking fee is exact, and cash is refused over the balance.
  ADD CONSTRAINT "payment_overpaid_online_session_fee" CHECK (overpaid_rwf = 0 OR (kind = 'session_fee' AND provider <> 'cash')),
  -- The overpayment refund is recorded whole, and only for an overpayment.
  ADD CONSTRAINT "payment_overpayment_refund_complete" CHECK (
       (overpayment_refunded_at IS NULL AND overpayment_refund_reference IS NULL AND overpayment_refunded_by_user_id IS NULL)
    OR (overpayment_refunded_at IS NOT NULL AND overpayment_refund_reference IS NOT NULL AND overpayment_refunded_by_user_id IS NOT NULL
        AND overpaid_rwf > 0)),
  ADD CONSTRAINT "payment_overpayment_refund_reference_length" CHECK (
    overpayment_refund_reference IS NULL OR char_length(overpayment_refund_reference) BETWEEN 1 AND 100);
