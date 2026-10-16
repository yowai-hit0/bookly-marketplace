-- ============================================================================
-- Snapshot the client cancellation policy on each booking (marketplace-spec.md
-- R1.8, marketplace-data-model.md §2.9).
--
-- photographer_setting holds the policy a photographer offers NOW. A booking
-- keeps the policy it was made under, exactly as it keeps its price, fee rate
-- and buffer: editing the setting must never change the terms of a booking the
-- client has already paid for. booking/create.ts writes both columns inside the
-- slot claim; booking/access.ts and booking/cancel.ts read them from here.
--
-- Generated with `migrate dev --create-only`, then hand-edited: Prisma's
-- version adds two NOT NULL columns with no default, which cannot apply to a
-- table that already has rows. The DEFAULTs below exist only so the ADD can
-- apply; existing bookings are backfilled from their photographer's current
-- settings (the best record of the terms they were offered), and the DEFAULTs
-- are dropped again so no future insert can skip the snapshot silently.
-- ============================================================================

-- AlterTable
ALTER TABLE "booking" ADD COLUMN     "booking_fee_refundable_on_client_cancel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "client_cancel_cutoff_hours" INTEGER NOT NULL DEFAULT 0;

UPDATE "booking" AS b
   SET "client_cancel_cutoff_hours" = s."client_cancel_cutoff_hours",
       "booking_fee_refundable_on_client_cancel" = s."booking_fee_refundable_on_client_cancel"
  FROM "photographer_setting" AS s
 WHERE s."photographer_id" = b."photographer_id";

ALTER TABLE "booking" ALTER COLUMN "booking_fee_refundable_on_client_cancel" DROP DEFAULT,
ALTER COLUMN "client_cancel_cutoff_hours" DROP DEFAULT;

-- ============================================================================
-- HAND-WRITTEN (invisible to Prisma). The same rule as
-- photographer_setting_cancel_cutoff_non_negative.
-- ============================================================================
ALTER TABLE "booking"
  ADD CONSTRAINT "booking_cancel_cutoff_non_negative" CHECK (client_cancel_cutoff_hours >= 0);
