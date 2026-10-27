-- ============================================================================
-- The client dashboard (marketplace-spec.md Phase 8, user decisions
-- 2026-10-27; marketplace-data-model.md §2.1 amendment).
--
--   app_user.phone                     the client's own phone number, E.164
--                                      (decision 1). It prefills the booking
--                                      form; a booking keeps its own contact
--                                      snapshot, which editing this never touches.
--   app_user.pending_email             an address change asked for and not yet
--   app_user.pending_email_token_hash  confirmed from the new inbox (R8.3): the
--   app_user.pending_email_expires_at  new address, the SHA-256 of the 256-bit
--                                      token emailed to it (never the token),
--                                      and when the link lapses (24 hours).
--
-- And one CHECK relaxed: `app_user_has_credential` admits an ERASED account
-- with no credential at all. Deleting an account (R8.3, decision 4) nulls the
-- password hash and the Google subject, so nobody can sign in to the row
-- again, while the row itself stays for the foreign keys of the records the
-- law keeps (Rwanda law 058/2021).
--
-- Nothing is backfilled: every new column starts null.
--
-- HAND-WRITTEN, never generated: no Prisma CLI command was run against a
-- database to write it. The columns match schema.prisma; the CHECKs and the
-- partial unique index are invisible to Prisma.
-- ============================================================================

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "phone" TEXT,
ADD COLUMN     "pending_email" TEXT,
ADD COLUMN     "pending_email_token_hash" TEXT,
ADD COLUMN     "pending_email_expires_at" TIMESTAMPTZ(6);

-- ============================================================================
-- HAND-WRITTEN (invisible to Prisma).
-- ============================================================================

-- A token hash addresses one account, as the reset and verification hashes do.
CREATE UNIQUE INDEX "app_user_pending_email_token_hash_unique"
  ON "app_user" ("pending_email_token_hash")
  WHERE "pending_email_token_hash" IS NOT NULL;

ALTER TABLE "app_user"
  -- What the profile route stores (booking/phone.ts, then the E.164 shape),
  -- the same rule as the studio's contact phones.
  ADD CONSTRAINT "app_user_phone_e164" CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  -- The address, its token's hash and its expiry: all three or none.
  ADD CONSTRAINT "app_user_pending_email_complete" CHECK (
    (pending_email IS NULL) = (pending_email_token_hash IS NULL)
    AND (pending_email_token_hash IS NULL) = (pending_email_expires_at IS NULL)
  );

-- An erased account holds no credential: that is what erasing it means.
ALTER TABLE "app_user" DROP CONSTRAINT "app_user_has_credential";
ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_has_credential" CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL OR anonymized_at IS NOT NULL);
