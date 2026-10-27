-- ============================================================================
-- A handle changed after submission (marketplace-spec.md Phase 7 as built, user
-- decision 2026-10-27; marketplace-data-model.md §3.3).
--
--   photographer.handle_changed_at   when the photographer last changed their
--                                    handle while pending AND submitted for
--                                    review (`submitted_at` set). Null when it
--                                    has not changed since the submission.
--
-- The handle is the one profile detail the platform treats as crucial: it is
-- the studio's public address (/p/<handle>), fixed for good at approval
-- (`handle_locked`, R7.2). A change while the studio waits for review is saved,
-- every platform admin is emailed the old and the new handle, and the platform
-- console flags the row "changed since submission" from this column
-- (photographers/profile.ts). A change before submission is the photographer
-- still setting up, and sets nothing.
--
-- Named for what it records, a moment, like every other *_at column of the
-- table: it is the latest such change, and a nullable timestamp says both
-- whether and when.
--
-- Nothing is backfilled: a handle changed after a submission before this
-- migration is not flagged.
--
-- HAND-WRITTEN, never generated: no Prisma CLI command was run against a
-- database to write it. The column matches schema.prisma; the CHECK is
-- invisible to Prisma.
-- ============================================================================

-- AlterTable
ALTER TABLE "photographer" ADD COLUMN     "handle_changed_at" TIMESTAMPTZ(6);

-- ============================================================================
-- HAND-WRITTEN (invisible to Prisma). Only a submitted studio's handle change
-- is recorded, so the column is never set without `submitted_at`.
-- ============================================================================
ALTER TABLE "photographer"
  ADD CONSTRAINT "photographer_handle_changed_after_submission" CHECK (handle_changed_at IS NULL OR submitted_at IS NOT NULL);
