-- Cash the photographer records by hand (docs/prompts/admin-console-fixes.md,
-- item 7; user decision 2026-09-27). A cash payment is a `session_fee` row
-- with the `cash` provider, written `succeeded`; `note` is what he typed with
-- it. Written by hand, never `prisma db push`: that drops the booking
-- exclusion constraint.

ALTER TABLE "payment" DROP CONSTRAINT "payment_provider_allowed";
ALTER TABLE "payment"
  ADD CONSTRAINT "payment_provider_allowed" CHECK (provider IN ('mtn_momo_direct', 'flutterwave', 'cash'));

ALTER TABLE "payment" ADD COLUMN "note" TEXT;
-- 1 to 500 characters, as the admin form and the API allow.
ALTER TABLE "payment"
  ADD CONSTRAINT "payment_note_length" CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500);
