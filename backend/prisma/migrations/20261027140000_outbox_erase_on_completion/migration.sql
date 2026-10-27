-- ============================================================================
-- An outbox row that erases its own recipient and payload once the worker is
-- done with it (marketplace-spec.md Phase 8 as built, user decision 2026-10-27;
-- marketplace-data-model.md §2.14).
--
--   outbox.erase_on_completion   when true, the worker's move to a terminal
--                                state (`done` or `failed`, an abandoned row
--                                included) also sets `recipient` to
--                                '[erased]' and `payload` to null, in the same
--                                statement or transaction -- the erasure rule
--                                of data-model_v2.md §10.2, applied to one row
--                                at the moment it no longer needs them.
--
-- Its one user today: the notice a client's account deletion sends to the
-- address being erased (`account_security_alert`, variant `account_deleted`).
-- The deletion scrubs every other account-mail row of the user at once, but
-- this row must keep the address until it has been delivered, or given up on.
-- A retry (back to `pending`) keeps both: the next attempt needs them.
--
-- Defaults to false: every row before this migration, and every other row
-- after it, keeps its recipient and payload as the permanent outbox always has.
--
-- HAND-WRITTEN, never generated: no Prisma CLI command was run against a
-- database to write it. The column matches schema.prisma; the CHECK is
-- invisible to Prisma.
-- ============================================================================

-- AlterTable
ALTER TABLE "outbox" ADD COLUMN     "erase_on_completion" BOOLEAN NOT NULL DEFAULT false;

-- ============================================================================
-- HAND-WRITTEN (invisible to Prisma). Only an email has a recipient to erase.
-- ============================================================================
ALTER TABLE "outbox"
  ADD CONSTRAINT "outbox_erase_on_completion_email_only" CHECK (NOT erase_on_completion OR kind = 'email');
