-- ============================================================================
-- Payouts (marketplace-spec.md Phase 4, R4.1-R4.6; marketplace-data-model.md
-- §3.8-§3.9, §3.10, §3.11).
--
-- Money sits in the platform's account; photographers are paid by hand, with no
-- commission (decisions table: money out, payout timing).
--
--   payout_method  where a photographer is paid. Immutable: a change retires the
--                  current row and inserts a new one (R4.1).
--   payout         one manual transfer: draft -> paid | cancelled (R4.4).
--   payout_item    an earning per succeeded non-cash booking or session fee, and
--                  a reversal when one became refund_due after its earning was
--                  already in a payout (R4.2). "Payable now" is derived, never
--                  stored (R4.3, §3.9).
--
-- Refinements of §3.9, recorded in marketplace-data-model.md: who cancelled a
-- draft (payout.cancelled_by_user_id) and who recorded a refund
-- (payment.refunded_by_user_id), so who did what is on every row of money out;
-- and payout -> payout_method is a composite foreign key, so a payout can only
-- ever name its own photographer's destination.
--
-- Nothing is backfilled: a payment that succeeded before this migration has no
-- earning (see the Phase 4 notes in marketplace-spec.md).
--
-- Generated with `migrate dev --create-only`; everything after the HAND-WRITTEN
-- banner is invisible to Prisma.
-- ============================================================================

-- AlterTable
ALTER TABLE "payment" ADD COLUMN     "refunded_by_user_id" UUID;

-- CreateTable
CREATE TABLE "payout_method" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photographer_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "momo_network" TEXT,
    "momo_number" TEXT,
    "bank_name" TEXT,
    "bank_account_number" TEXT,
    "account_name" TEXT NOT NULL,
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_method_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photographer_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "amount_rwf" INTEGER NOT NULL,
    "payout_method_id" UUID NOT NULL,
    "transfer_reference" TEXT,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "paid_by_user_id" UUID,
    "paid_at" TIMESTAMPTZ(6),
    "cancelled_by_user_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photographer_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_rwf" INTEGER NOT NULL,
    "payout_id" UUID,
    "voided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_method_photographer_id_created_at_idx" ON "payout_method"("photographer_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payout_method_id_photographer_id_key" ON "payout_method"("id", "photographer_id");

-- CreateIndex
CREATE INDEX "payout_photographer_id_created_at_idx" ON "payout"("photographer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payout_status_idx" ON "payout"("status");

-- CreateIndex
CREATE INDEX "payout_item_payout_id_idx" ON "payout_item"("payout_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_item_payment_id_kind_key" ON "payout_item"("payment_id", "kind");

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_refunded_by_user_id_fkey" FOREIGN KEY ("refunded_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_method" ADD CONSTRAINT "payout_method_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout" ADD CONSTRAINT "payout_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout" ADD CONSTRAINT "payout_payout_method_id_photographer_id_fkey" FOREIGN KEY ("payout_method_id", "photographer_id") REFERENCES "payout_method"("id", "photographer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout" ADD CONSTRAINT "payout_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout" ADD CONSTRAINT "payout_paid_by_user_id_fkey" FOREIGN KEY ("paid_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout" ADD CONSTRAINT "payout_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_item" ADD CONSTRAINT "payout_item_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_item" ADD CONSTRAINT "payout_item_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_item" ADD CONSTRAINT "payout_item_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- HAND-WRITTEN (invisible to Prisma). marketplace-data-model.md §3.11.
-- ============================================================================

-- One current destination per photographer, one draft per photographer, and a
-- transfer reference used once (T4.3).
CREATE UNIQUE INDEX "payout_method_one_current"        ON "payout_method" (photographer_id) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX "payout_one_draft"                 ON "payout" (photographer_id) WHERE status = 'draft';
CREATE UNIQUE INDEX "payout_transfer_reference_unique" ON "payout" (transfer_reference) WHERE transfer_reference IS NOT NULL;

-- What "payable now" and the earnings page scan: the photographer's open items.
CREATE INDEX "payout_item_unpaid_idx" ON "payout_item" (photographer_id) WHERE payout_id IS NULL AND voided_at IS NULL;

ALTER TABLE "payout_method"
  ADD CONSTRAINT "payout_method_kind_allowed" CHECK (kind IN ('momo', 'bank')),
  ADD CONSTRAINT "payout_method_network_allowed" CHECK (momo_network IS NULL OR momo_network IN ('mtn', 'airtel')),
  ADD CONSTRAINT "payout_method_shape" CHECK (
       (kind = 'momo' AND momo_network IS NOT NULL AND momo_number IS NOT NULL AND bank_name IS NULL AND bank_account_number IS NULL)
    OR (kind = 'bank' AND bank_name IS NOT NULL AND bank_account_number IS NOT NULL AND momo_network IS NULL AND momo_number IS NULL)),
  ADD CONSTRAINT "payout_method_account_name_length" CHECK (char_length(account_name) BETWEEN 1 AND 120),
  -- Beyond §3.11: the formats the API validates, held again here. A Rwandan
  -- mobile number in E.164; a bank name and account number of sane length.
  ADD CONSTRAINT "payout_method_momo_number_e164" CHECK (momo_number IS NULL OR momo_number ~ '^\+2507[2389][0-9]{7}$'),
  ADD CONSTRAINT "payout_method_bank_fields_length" CHECK (
    (bank_name IS NULL OR char_length(bank_name) BETWEEN 1 AND 100)
    AND (bank_account_number IS NULL OR char_length(bank_account_number) BETWEEN 1 AND 40));

ALTER TABLE "payout"
  ADD CONSTRAINT "payout_status_allowed" CHECK (status IN ('draft', 'paid', 'cancelled')),
  ADD CONSTRAINT "payout_amount_positive" CHECK (amount_rwf > 0),
  ADD CONSTRAINT "payout_paid_complete" CHECK (status <> 'paid' OR (transfer_reference IS NOT NULL AND paid_at IS NOT NULL AND paid_by_user_id IS NOT NULL)),
  ADD CONSTRAINT "payout_cancelled_has_date" CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  -- Beyond §3.11: who cancelled is recorded like who built and who paid, and
  -- only a paid payout carries payment details.
  ADD CONSTRAINT "payout_cancelled_has_user" CHECK (status <> 'cancelled' OR cancelled_by_user_id IS NOT NULL),
  ADD CONSTRAINT "payout_unpaid_has_no_transfer" CHECK (status = 'paid' OR (transfer_reference IS NULL AND paid_at IS NULL AND paid_by_user_id IS NULL)),
  ADD CONSTRAINT "payout_transfer_reference_length" CHECK (transfer_reference IS NULL OR char_length(transfer_reference) BETWEEN 1 AND 100),
  ADD CONSTRAINT "payout_note_length" CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500);

ALTER TABLE "payout_item"
  ADD CONSTRAINT "payout_item_kind_allowed" CHECK (kind IN ('earning', 'reversal')),
  ADD CONSTRAINT "payout_item_sign_matches_kind" CHECK ((kind = 'earning' AND amount_rwf > 0) OR (kind = 'reversal' AND amount_rwf < 0)),
  ADD CONSTRAINT "payout_item_void_or_paid" CHECK (voided_at IS NULL OR payout_id IS NULL);

-- Who recorded a refund is only ever set on a refunded payment.
ALTER TABLE "payment"
  ADD CONSTRAINT "payment_refunded_by_when_refunded" CHECK (refunded_by_user_id IS NULL OR status = 'refunded');
