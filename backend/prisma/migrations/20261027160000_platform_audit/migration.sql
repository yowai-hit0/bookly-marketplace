-- ============================================================================
-- The platform's audit trail (marketplace-spec.md R9.4, Phase 9 user decision
-- 2026-10-27; marketplace-data-model.md §3.15).
--
--   platform_audit   one row per platform admin action that changed something,
--                    written IN THE SAME TRANSACTION as the change, so a
--                    refused or failed action leaves no row and a committed
--                    one always has its row. Read by the console's Activity
--                    page (`GET /api/platform/audit`) and the photographer
--                    detail (`GET /api/platform/photographers/:id`).
--
--     actor_user_id    the platform admin, from the verified token. RESTRICT:
--                      a login with history is disabled, never deleted.
--     action           the fixed vocabulary of platform/audit.ts
--                      (CHECK platform_audit_action_allowed).
--     target_type      what was acted on: photographer, payout, payment,
--     target_id        platform_setting or category. target_id is null where
--                      the target has no uuid (the settings row, the category
--                      order) and is never set without a type. No foreign key:
--                      the target is polymorphic, and a deleted category keeps
--                      its row here.
--     photographer_id  the photographer the action concerns, if any, so their
--                      detail page can show it. RESTRICT, like the outbox's:
--                      a photographer with history is never deleted.
--     details          ids, statuses, amounts, references and reasons only:
--                      never a password, a token, a full payout account
--                      number or a client's personal data (the code's rule;
--                      a JSON object by CHECK).
--
-- HAND-WRITTEN, never generated: no Prisma CLI command was run against a
-- database to write it. The table matches schema.prisma; the CHECKs and the
-- descending indexes' direction are invisible to Prisma.
-- ============================================================================

-- CreateTable
CREATE TABLE "platform_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" UUID,
    "photographer_id" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the Activity page, newest first.
CREATE INDEX "platform_audit_created_at_idx" ON "platform_audit"("created_at" DESC);

-- CreateIndex: one photographer's history, newest first.
CREATE INDEX "platform_audit_photographer_id_created_at_idx" ON "platform_audit"("photographer_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "platform_audit" ADD CONSTRAINT "platform_audit_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_audit" ADD CONSTRAINT "platform_audit_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- HAND-WRITTEN (invisible to Prisma).
-- ============================================================================
ALTER TABLE "platform_audit"
  ADD CONSTRAINT "platform_audit_action_allowed" CHECK (action IN (
    'photographer_approved', 'photographer_suspended', 'photographer_reactivated',
    'payout_created', 'payout_paid', 'payout_cancelled',
    'refund_recorded',
    'settings_updated',
    'category_created', 'category_updated', 'category_reordered',
    'category_deactivated', 'category_reactivated', 'category_deleted'
  ));

ALTER TABLE "platform_audit"
  ADD CONSTRAINT "platform_audit_target_type_allowed" CHECK (
    target_type IS NULL OR target_type IN ('photographer', 'payout', 'payment', 'platform_setting', 'category')
  );

ALTER TABLE "platform_audit"
  ADD CONSTRAINT "platform_audit_target_id_has_type" CHECK (target_id IS NULL OR target_type IS NOT NULL);

ALTER TABLE "platform_audit"
  ADD CONSTRAINT "platform_audit_details_object" CHECK (jsonb_typeof(details) = 'object');
