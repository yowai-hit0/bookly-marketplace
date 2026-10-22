-- ============================================================================
-- Subscriptions (marketplace-spec.md Phase 5, R5.1-R5.5; marketplace-data-model.md
-- §2.11, §3.2, §3.7, §3.11).
--
--   subscription         one per photographer, created at approval with its trial
--                        (R5.1). `status` is the job's record; bookability also
--                        compares current_period_ends_at with the clock (R5.4).
--   subscription_period  the trial (one only) and each paid month or year. Never
--                        overlapping unless voided; a paid one names its payment,
--                        once.
--   payment              booking_id becomes nullable: a subscription payment has a
--                        subscription for its subject instead (exactly one of the
--                        two), and freezes its plan_interval at initiation.
--   platform_setting     the plan: both prices, the grace days and the reminder
--                        days, all editable by a platform admin.
--
-- The prices have NO column default (§3.2). The existing row, if there is one,
-- gets the seed's PLACEHOLDERS (10,000 RWF monthly, 100,000 RWF yearly) through a
-- temporary default that is dropped again at once, exactly as the cancellation
-- policy migration did: set the real prices before launch (marketplace-spec.md
-- Phase 10).
--
-- BACKFILL: every photographer who was ever approved (approved_at set, which
-- covers every `approved` row by CHECK photographer_approved_has_date) and has no
-- subscription gets one now, with a trial of `trial_days` from this moment.
-- Without it, the bookability rule of this phase (approved AND a live
-- subscription) would make every photographer approved before it unbookable at
-- once, and the one way back -- paying -- would have no subscription to pay for.
-- A trial from now rather than from their approval date, so nobody's studio
-- closes on the day of the deploy. A photographer suspended after approval is
-- covered too: reactivation restores `approved` without approving again, so it
-- would otherwise come back without a subscription.
--
-- Generated with `migrate dev --create-only`, then edited: the two price columns
-- are added through a temporary default (Prisma's warning above it is answered by
-- that), and everything after the HAND-WRITTEN banner is invisible to Prisma.
-- ============================================================================

-- AlterTable
ALTER TABLE "payment" ADD COLUMN     "plan_interval" TEXT,
ADD COLUMN     "subscription_id" UUID,
ALTER COLUMN "booking_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "platform_setting" ADD COLUMN     "subscription_grace_days" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "subscription_monthly_price_rwf" INTEGER NOT NULL DEFAULT 10000,
ADD COLUMN     "subscription_reminder_days" INTEGER[] DEFAULT ARRAY[7, 3, 1]::INTEGER[],
ADD COLUMN     "subscription_yearly_price_rwf" INTEGER NOT NULL DEFAULT 100000;

-- The placeholders above reached the existing row, if any; no insert may lean on them.
ALTER TABLE "platform_setting" ALTER COLUMN "subscription_monthly_price_rwf" DROP DEFAULT,
ALTER COLUMN "subscription_yearly_price_rwf" DROP DEFAULT;

-- CreateTable
CREATE TABLE "subscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photographer_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'trialing',
    "current_period_ends_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_period" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscription_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "plan_interval" TEXT,
    "price_rwf" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "payment_id" UUID,
    "voided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_period_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_photographer_id_key" ON "subscription"("photographer_id");

-- CreateIndex
CREATE INDEX "subscription_status_current_period_ends_at_idx" ON "subscription"("status", "current_period_ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_period_payment_id_key" ON "subscription_period"("payment_id");

-- CreateIndex
CREATE INDEX "subscription_period_subscription_id_ends_at_idx" ON "subscription_period"("subscription_id", "ends_at");

-- CreateIndex
CREATE INDEX "payment_subscription_id_status_idx" ON "payment"("subscription_id", "status");

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_period" ADD CONSTRAINT "subscription_period_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_period" ADD CONSTRAINT "subscription_period_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- HAND-WRITTEN (invisible to Prisma). marketplace-data-model.md §2.11, §3.11.
-- ============================================================================

-- One trial per subscription: re-approving after a suspension never grants a
-- second one (R5.1).
CREATE UNIQUE INDEX "subscription_period_one_trial" ON "subscription_period" (subscription_id) WHERE kind = 'trial';

-- Periods of one subscription never overlap, unless voided (§3.7). Needs btree_gist.
ALTER TABLE "subscription_period" ADD CONSTRAINT "subscription_period_no_overlap"
  EXCLUDE USING gist (subscription_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (voided_at IS NULL);

ALTER TABLE "subscription"
  ADD CONSTRAINT "subscription_status_allowed" CHECK (status IN ('trialing', 'active', 'past_due', 'expired'));

ALTER TABLE "subscription_period"
  ADD CONSTRAINT "subscription_period_kind_allowed" CHECK (kind IN ('trial', 'paid')),
  ADD CONSTRAINT "subscription_period_plan_interval_allowed" CHECK (plan_interval IS NULL OR plan_interval IN ('monthly', 'yearly')),
  ADD CONSTRAINT "subscription_period_shape" CHECK (
       (kind = 'trial' AND payment_id IS NULL AND plan_interval IS NULL AND price_rwf = 0)
    OR (kind = 'paid'  AND payment_id IS NOT NULL AND plan_interval IS NOT NULL AND price_rwf > 0)),
  ADD CONSTRAINT "subscription_period_range_valid" CHECK (ends_at > starts_at);

-- payment (§2.11). The kind vocabulary gains `subscription`; the provider CHECK
-- keeps its Phase 3 shape (`flutterwave_checkout` waits for cards, deferred
-- 2026-10-17), and so does payment_cash_is_session_fee, which already holds.
ALTER TABLE "payment" DROP CONSTRAINT "payment_kind_allowed";
ALTER TABLE "payment"
  ADD CONSTRAINT "payment_kind_allowed" CHECK (kind IN ('booking_fee', 'session_fee', 'subscription')),
  -- A payment is for a booking or for a subscription, never both, never neither.
  ADD CONSTRAINT "payment_subject_exactly_one" CHECK (num_nonnulls(booking_id, subscription_id) = 1),
  ADD CONSTRAINT "payment_subject_matches_kind" CHECK ((kind = 'subscription') = (subscription_id IS NOT NULL)),
  -- The plan is frozen on a subscription payment, and only there.
  ADD CONSTRAINT "payment_plan_interval_matches_kind" CHECK ((kind = 'subscription') = (plan_interval IS NOT NULL)),
  ADD CONSTRAINT "payment_plan_interval_allowed" CHECK (plan_interval IS NULL OR plan_interval IN ('monthly', 'yearly'));

-- platform_setting (§3.2, §3.11). The trial CHECK tightens from >= 0 to > 0: a
-- trial is a subscription_period, and subscription_period_range_valid refuses one
-- of no length, so a zero trial would make every approval fail. The existing 30
-- passes. The reminder days are a nullable column to Prisma (scalar lists always
-- are), so NOT NULL is a CHECK here, where Prisma will not try to undo it.
ALTER TABLE "platform_setting" DROP CONSTRAINT "platform_setting_trial_days_non_negative";
ALTER TABLE "platform_setting"
  ADD CONSTRAINT "platform_setting_trial_days_positive" CHECK (trial_days > 0),
  ADD CONSTRAINT "platform_setting_prices_positive" CHECK (subscription_monthly_price_rwf > 0 AND subscription_yearly_price_rwf > 0),
  ADD CONSTRAINT "platform_setting_grace_days_non_negative" CHECK (subscription_grace_days >= 0),
  ADD CONSTRAINT "platform_setting_reminder_days_valid" CHECK (
    subscription_reminder_days IS NOT NULL
    AND cardinality(subscription_reminder_days) <= 10
    AND array_position(subscription_reminder_days, NULL) IS NULL
    AND 0 < ALL (subscription_reminder_days));

-- BACKFILL (see the header): a subscription and its trial for every photographer
-- ever approved who has none, the trial starting now. Kigali has no daylight
-- saving, so `trial_days` days are trial_days * 24 hours on its calendar too.
WITH settings AS (
  SELECT COALESCE((SELECT trial_days FROM platform_setting WHERE id = 1), 30) AS trial_days
), created AS (
  INSERT INTO "subscription" (photographer_id, status, current_period_ends_at)
  SELECT ph.id, 'trialing', now() + make_interval(days => settings.trial_days)
    FROM photographer ph, settings
   WHERE ph.approved_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "subscription" s WHERE s.photographer_id = ph.id)
  RETURNING id, current_period_ends_at
)
INSERT INTO "subscription_period" (subscription_id, kind, plan_interval, price_rwf, starts_at, ends_at)
SELECT created.id, 'trial', NULL, 0, now(), created.current_period_ends_at FROM created;
