-- ============================================================================
-- Bookly Marketplace baseline (marketplace-data-model.md §5). One squashed
-- migration replacing the five single-photographer ones: production holds no
-- data, and the change touches almost every table.
--
-- Phase 1 scope only. subscription, subscription_period, payout_method, payout,
-- payout_item and the subscription columns of payment arrive in later phases as
-- incremental migrations.
--
-- The generated DDL below is left as Prisma wrote it. Everything after the
-- HAND-WRITTEN banner at the end is invisible to Prisma.
-- ============================================================================

-- booking_no_overlap and availability_block_range_idx combine an equality on
-- photographer_id (a plain uuid) with a range in one GiST index. Core GiST has
-- no operator class for uuid equality; btree_gist provides it. Trusted since
-- PostgreSQL 13, so a non-superuser owner (Neon) may create it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "full_name" TEXT,
    "password_hash" TEXT,
    "google_sub" TEXT,
    "email_verified_at" TIMESTAMPTZ(6),
    "email_verify_token_hash" TEXT,
    "email_verify_expires_at" TIMESTAMPTZ(6),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "password_reset_token_hash" TEXT,
    "password_reset_expires_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "disabled_at" TIMESTAMPTZ(6),
    "anonymized_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_setting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "hold_minutes" INTEGER NOT NULL DEFAULT 30,
    "trial_days" INTEGER NOT NULL DEFAULT 30,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photographer_setting" (
    "photographer_id" UUID NOT NULL,
    "booking_fee_rate" DECIMAL(4,3) NOT NULL DEFAULT 0.400,
    "min_lead_time_minutes" INTEGER NOT NULL DEFAULT 120,
    "buffer_minutes" INTEGER NOT NULL DEFAULT 30,
    "delivery_expiry_days" INTEGER NOT NULL DEFAULT 90,
    "client_cancel_cutoff_hours" INTEGER NOT NULL DEFAULT 0,
    "booking_fee_refundable_on_client_cancel" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photographer_setting_pkey" PRIMARY KEY ("photographer_id")
);

-- CreateTable
CREATE TABLE "photographer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "bio" TEXT,
    "contact_phone" TEXT,
    "whatsapp_phone" TEXT,
    "contact_email" TEXT,
    "cover_image_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "submitted_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_user_id" UUID,
    "suspended_at" TIMESTAMPTZ(6),
    "suspension_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photographer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "district" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "district_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "photographer_district" (
    "photographer_id" UUID NOT NULL,
    "district_code" TEXT NOT NULL,

    CONSTRAINT "photographer_district_pkey" PRIMARY KEY ("photographer_id","district_code")
);

-- CreateTable
CREATE TABLE "category" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_fr" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photographer_category" (
    "photographer_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,

    CONSTRAINT "photographer_category_pkey" PRIMARY KEY ("photographer_id","category_id")
);

-- CreateTable
CREATE TABLE "portfolio_image" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photographer_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "caption" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_hours" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photographer_id" UUID NOT NULL,
    "weekday" INTEGER,
    "effective_date" DATE,
    "opens_minute" INTEGER,
    "closes_minute" INTEGER,
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "working_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_block" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photographer_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "is_all_day" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photographer_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_fr" TEXT,
    "description_en" TEXT,
    "description_fr" TEXT,
    "cover_image_url" TEXT,
    "booking_fee_rate_override" DECIMAL(4,3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_id" UUID NOT NULL,
    "photographer_id" UUID NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_fr" TEXT,
    "description_en" TEXT,
    "description_fr" TEXT,
    "price_rwf" INTEGER NOT NULL,
    "photo_count" INTEGER NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addon" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photographer_id" UUID NOT NULL,
    "service_id" UUID,
    "name_en" TEXT NOT NULL,
    "name_fr" TEXT,
    "price_rwf" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "addon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "user_id" UUID,
    "anonymized_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL,
    "client_id" UUID NOT NULL,
    "photographer_id" UUID NOT NULL,
    "contact_name" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "service_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "service_name_snapshot" TEXT NOT NULL,
    "package_name_snapshot" TEXT NOT NULL,
    "package_price_rwf" INTEGER NOT NULL,
    "package_duration_minutes" INTEGER NOT NULL,
    "package_photo_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_payment',
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "buffer_ends_at" TIMESTAMPTZ(6) NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(6),
    "original_starts_at" TIMESTAMPTZ(6),
    "rescheduled_at" TIMESTAMPTZ(6),
    "location_text" TEXT NOT NULL,
    "party_size" INTEGER,
    "special_requests" TEXT,
    "consent_at" TIMESTAMPTZ(6) NOT NULL,
    "booking_fee_rate" DECIMAL(4,3) NOT NULL,
    "booking_fee_rwf" INTEGER NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancellation_reason" TEXT,
    "access_token_hash" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(6),
    "access_token_last_used_at" TIMESTAMPTZ(6),
    "pending_contact_email" TEXT,
    "pending_email_token_hash" TEXT,
    "pending_email_expires_at" TIMESTAMPTZ(6),
    "delivery_url" TEXT,
    "delivery_expires_on" DATE,
    "delivery_sent_at" TIMESTAMPTZ(6),
    "delivery_note" TEXT,
    "gcal_event_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_addon" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "addon_id" UUID NOT NULL,
    "name_snapshot" TEXT NOT NULL,
    "unit_price_rwf" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "amount_rwf" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_addon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "our_ref" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_ref" TEXT,
    "method" TEXT,
    "amount_rwf" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'initiated',
    "failure_reason" TEXT,
    "initiated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(6),
    "refunded_at" TIMESTAMPTZ(6),
    "refund_reference" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "our_ref" UUID,
    "provider_ref" TEXT,
    "reported_status" TEXT,
    "signature_valid" BOOLEAN NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'received',
    "processing_error" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_note" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "emailed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "booking_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "booking_id" UUID,
    "photographer_id" UUID,
    "dedupe_key" TEXT NOT NULL,
    "template" TEXT,
    "recipient" TEXT,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "provider_message_id" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "photographer_user_id_key" ON "photographer"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "photographer_handle_key" ON "photographer"("handle");

-- CreateIndex
CREATE INDEX "photographer_status_idx" ON "photographer"("status");

-- CreateIndex
CREATE INDEX "photographer_district_district_code_photographer_id_idx" ON "photographer_district"("district_code", "photographer_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_slug_key" ON "category"("slug");

-- CreateIndex
CREATE INDEX "photographer_category_category_id_photographer_id_idx" ON "photographer_category"("category_id", "photographer_id");

-- CreateIndex
CREATE INDEX "portfolio_image_photographer_id_sort_order_idx" ON "portfolio_image"("photographer_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "service_photographer_id_slug_key" ON "service"("photographer_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "service_id_photographer_id_key" ON "service"("id", "photographer_id");

-- CreateIndex
CREATE INDEX "package_service_id_idx" ON "package"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "package_id_photographer_id_key" ON "package"("id", "photographer_id");

-- CreateIndex
CREATE INDEX "addon_photographer_id_idx" ON "addon"("photographer_id");

-- CreateIndex
CREATE INDEX "addon_service_id_idx" ON "addon"("service_id");

-- CreateIndex
CREATE INDEX "client_user_id_idx" ON "client"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_reference_key" ON "booking"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "booking_access_token_hash_key" ON "booking"("access_token_hash");

-- CreateIndex
CREATE INDEX "booking_status_starts_at_idx" ON "booking"("status", "starts_at");

-- CreateIndex
CREATE INDEX "booking_photographer_id_status_starts_at_idx" ON "booking"("photographer_id", "status", "starts_at");

-- CreateIndex
CREATE INDEX "booking_client_id_starts_at_idx" ON "booking"("client_id", "starts_at" DESC);

-- CreateIndex
CREATE INDEX "booking_photographer_id_client_id_starts_at_idx" ON "booking"("photographer_id", "client_id", "starts_at" DESC);

-- CreateIndex
CREATE INDEX "booking_service_id_idx" ON "booking"("service_id");

-- CreateIndex
CREATE INDEX "booking_package_id_idx" ON "booking"("package_id");

-- CreateIndex
CREATE INDEX "booking_addon_booking_id_idx" ON "booking_addon"("booking_id");

-- CreateIndex
CREATE INDEX "booking_addon_addon_id_idx" ON "booking_addon"("addon_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_our_ref_key" ON "payment"("our_ref");

-- CreateIndex
CREATE INDEX "payment_booking_id_kind_status_idx" ON "payment"("booking_id", "kind", "status");

-- CreateIndex
CREATE INDEX "webhook_event_our_ref_idx" ON "webhook_event"("our_ref");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_provider_event_id_unique" ON "webhook_event"("provider", "event_id");

-- CreateIndex
CREATE INDEX "booking_note_booking_id_created_at_idx" ON "booking_note"("booking_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_dedupe_key_key" ON "outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_booking_id_created_at_idx" ON "outbox"("booking_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_photographer_id_created_at_idx" ON "outbox"("photographer_id", "created_at");

-- AddForeignKey
ALTER TABLE "photographer_setting" ADD CONSTRAINT "photographer_setting_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photographer" ADD CONSTRAINT "photographer_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photographer" ADD CONSTRAINT "photographer_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photographer_district" ADD CONSTRAINT "photographer_district_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photographer_district" ADD CONSTRAINT "photographer_district_district_code_fkey" FOREIGN KEY ("district_code") REFERENCES "district"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photographer_category" ADD CONSTRAINT "photographer_category_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photographer_category" ADD CONSTRAINT "photographer_category_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_image" ADD CONSTRAINT "portfolio_image_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_block" ADD CONSTRAINT "availability_block_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package" ADD CONSTRAINT "package_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package" ADD CONSTRAINT "package_service_id_photographer_id_fkey" FOREIGN KEY ("service_id", "photographer_id") REFERENCES "service"("id", "photographer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addon" ADD CONSTRAINT "addon_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addon" ADD CONSTRAINT "addon_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client" ADD CONSTRAINT "client_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_service_id_photographer_id_fkey" FOREIGN KEY ("service_id", "photographer_id") REFERENCES "service"("id", "photographer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_package_id_photographer_id_fkey" FOREIGN KEY ("package_id", "photographer_id") REFERENCES "package"("id", "photographer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_addon" ADD CONSTRAINT "booking_addon_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_addon" ADD CONSTRAINT "booking_addon_addon_id_fkey" FOREIGN KEY ("addon_id") REFERENCES "addon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_note" ADD CONSTRAINT "booking_note_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- HAND-WRITTEN. Everything below this line was added by hand and is INVISIBLE
-- to Prisma (data-model_v2.md 2.1). `prisma db push` reconciles the database to
-- schema.prisma and would drop all of it -- including booking_no_overlap, the
-- constraint that makes double booking impossible. That command is forbidden in
-- every environment. Schema changes go through `migrate dev --create-only`, and
-- every generated file is reviewed for drops of what is below.
--
-- Order (marketplace-data-model.md §5): uniques, indexes, exclusions, CHECKs,
-- district rows. Section numbers cite marketplace-data-model.md §3.11 unless
-- they say otherwise.
-- ============================================================================

-- --- Functional unique indexes ----------------------------------------------
-- Email is matched case-insensitively, so uniqueness must be too. client stays
-- platform-global: one dedupe record per address across photographers (§2.8).

CREATE UNIQUE INDEX "app_user_lower_email_unique" ON "app_user" (lower(email));
CREATE UNIQUE INDEX "client_lower_email_unique" ON "client" (lower(email));

-- --- Partial unique indexes -------------------------------------------------
-- Each column below is null on most rows, so a plain unique constraint cannot
-- express "unique once set".

-- One account per Google identity (R2.4).
CREATE UNIQUE INDEX "app_user_google_sub_unique"
  ON "app_user" (google_sub)
  WHERE google_sub IS NOT NULL;

-- With many users a token hash must address exactly one row; the login flows
-- look a token up by its hash alone (§2.1).
CREATE UNIQUE INDEX "app_user_password_reset_token_hash_unique"
  ON "app_user" (password_reset_token_hash)
  WHERE password_reset_token_hash IS NOT NULL;

CREATE UNIQUE INDEX "app_user_email_verify_token_hash_unique"
  ON "app_user" (email_verify_token_hash)
  WHERE email_verify_token_hash IS NOT NULL;

-- The provider's own id, once it exists. Null until they answer.
CREATE UNIQUE INDEX "payment_provider_ref_unique"
  ON "payment" (provider_ref)
  WHERE provider_ref IS NOT NULL;

-- No double-charging the deposit (v1 defect #5). Session fees stay
-- many-per-booking, which spec 6.15 requires.
CREATE UNIQUE INDEX "payment_one_succeeded_booking_fee"
  ON "payment" (booking_id)
  WHERE kind = 'booking_fee' AND status = 'succeeded';

-- A contact-email confirmation link addresses exactly one booking (2026-09-25).
CREATE UNIQUE INDEX "booking_pending_email_token_hash_unique"
  ON "booking" (pending_email_token_hash)
  WHERE pending_email_token_hash IS NOT NULL;

-- One recurring rule per weekday, per photographer (§2.3).
CREATE UNIQUE INDEX "working_hours_weekday_unique"
  ON "working_hours" (photographer_id, weekday)
  WHERE effective_date IS NULL;

-- One dated override per date, per photographer (§2.3).
CREATE UNIQUE INDEX "working_hours_effective_date_unique"
  ON "working_hours" (photographer_id, effective_date)
  WHERE weekday IS NULL;

-- --- Partial and expression indexes that are NOT unique ---------------------

-- Keeps the queue scan small as history grows (data-model_v2.md 9.3).
CREATE INDEX "outbox_queue_idx"
  ON "outbox" (status, next_attempt_at)
  WHERE status IN ('pending', 'processing');

-- Sweeper, and step 2 of the claim transaction (data-model_v2.md 9.2). Global:
-- the hold sweeper serves every photographer.
CREATE INDEX "booking_hold_expires_at_idx"
  ON "booking" (hold_expires_at)
  WHERE status = 'pending_payment';

-- Subtracting one photographer's blocks from their open window (§2.4).
CREATE INDEX "availability_block_range_idx"
  ON "availability_block" USING gist (photographer_id, tstzrange(starts_at, ends_at, '[)'));

-- The directory's "from" price (§3.12).
CREATE INDEX "package_directory_price_idx"
  ON "package" (photographer_id, price_rwf)
  WHERE is_active;

-- The reconciler's scan for payments still waiting on a provider (§2.11).
CREATE INDEX "payment_pending_lookup_idx"
  ON "payment" (provider, initiated_at)
  WHERE status = 'pending';

-- ============================================================================
-- THE CONSTRAINT THE PROJECT EXISTS FOR (data-model_v2.md 9.1, marketplace
-- §2.9)
--
-- Two bookings OF ONE PHOTOGRAPHER with overlapping reserved ranges cannot both
-- exist, whatever the application does. Two photographers may book the same
-- hour. The range runs to buffer_ends_at, so the buffer is protected by the
-- same mechanism as the shoot. Cancelled and expired bookings leave the
-- predicate and stop occupying time the instant their status changes.
--
-- The status list here MUST equal OCCUPYING_STATUSES in db/statuses.ts. A test
-- asserts that, because adding a status without updating this predicate would
-- silently free occupied time.
--
-- `photographer_id WITH =` is what needs btree_gist (top of file).
-- ============================================================================

ALTER TABLE "booking" ADD CONSTRAINT "booking_no_overlap"
  EXCLUDE USING gist (
    photographer_id WITH =,
    tstzrange(starts_at, buffer_ends_at, '[)') WITH &&
  )
  WHERE (status IN ('pending_payment', 'confirmed', 'completed', 'no_show'));

-- --- CHECK constraints ------------------------------------------------------
-- Enumerations are text + CHECK, not native enum: adding a value is then one
-- line, not an ALTER TYPE that locks and will not roll back inside a
-- transaction (data-model_v2.md 2).

-- Identity -------------------------------------------------------------------

ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_role_allowed" CHECK (role IN ('platform_admin', 'photographer', 'client')),
  ADD CONSTRAINT "app_user_email_verify_complete" CHECK ((email_verify_token_hash IS NULL) = (email_verify_expires_at IS NULL)),
  ADD CONSTRAINT "app_user_password_reset_complete" CHECK ((password_reset_token_hash IS NULL) = (password_reset_expires_at IS NULL)),
  -- Google sign-in is for clients only (R2.4).
  ADD CONSTRAINT "app_user_google_client_only" CHECK (google_sub IS NULL OR role = 'client'),
  -- A login nobody can use is not a login.
  ADD CONSTRAINT "app_user_has_credential" CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL);

-- Configuration --------------------------------------------------------------
-- The single-photographer `setting` CHECKs, split by owner (§2.2).

ALTER TABLE "platform_setting"
  ADD CONSTRAINT "platform_setting_single_row" CHECK (id = 1),
  ADD CONSTRAINT "platform_setting_hold_minutes_positive" CHECK (hold_minutes > 0),
  ADD CONSTRAINT "platform_setting_trial_days_non_negative" CHECK (trial_days >= 0);

ALTER TABLE "photographer_setting"
  ADD CONSTRAINT "photographer_setting_booking_fee_rate_range" CHECK (booking_fee_rate >= 0 AND booking_fee_rate <= 1),
  ADD CONSTRAINT "photographer_setting_min_lead_time_non_negative" CHECK (min_lead_time_minutes >= 0),
  ADD CONSTRAINT "photographer_setting_buffer_minutes_non_negative" CHECK (buffer_minutes >= 0),
  ADD CONSTRAINT "photographer_setting_delivery_expiry_days_positive" CHECK (delivery_expiry_days > 0),
  ADD CONSTRAINT "photographer_setting_cancel_cutoff_non_negative" CHECK (client_cancel_cutoff_hours >= 0);

-- Photographers --------------------------------------------------------------

ALTER TABLE "photographer"
  ADD CONSTRAINT "photographer_status_allowed" CHECK (status IN ('pending', 'approved', 'suspended')),
  -- /p/<handle>: lowercase letters, digits and inner hyphens, 3-30 characters.
  ADD CONSTRAINT "photographer_handle_format" CHECK (handle ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'),
  ADD CONSTRAINT "photographer_display_name_length" CHECK (char_length(display_name) BETWEEN 1 AND 80),
  ADD CONSTRAINT "photographer_bio_length" CHECK (bio IS NULL OR char_length(bio) <= 2000),
  ADD CONSTRAINT "photographer_cover_image_https" CHECK (cover_image_url IS NULL OR cover_image_url ~ '^https://'),
  ADD CONSTRAINT "photographer_approved_has_date" CHECK (status <> 'approved' OR approved_at IS NOT NULL),
  ADD CONSTRAINT "photographer_suspended_has_date" CHECK (status <> 'suspended' OR suspended_at IS NOT NULL);

ALTER TABLE "district"
  ADD CONSTRAINT "district_province_allowed" CHECK (province IN ('kigali', 'eastern', 'northern', 'southern', 'western'));

ALTER TABLE "category"
  ADD CONSTRAINT "category_slug_format" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE "portfolio_image"
  ADD CONSTRAINT "portfolio_image_url_https" CHECK (url ~ '^https://'),
  ADD CONSTRAINT "portfolio_image_caption_length" CHECK (caption IS NULL OR char_length(caption) <= 200);

-- Availability (carried over verbatim) ----------------------------------------

ALTER TABLE "working_hours"
  ADD CONSTRAINT "working_hours_weekday_xor_date" CHECK ((weekday IS NOT NULL) <> (effective_date IS NOT NULL)),
  ADD CONSTRAINT "working_hours_weekday_range" CHECK (weekday IS NULL OR (weekday BETWEEN 0 AND 6)),
  ADD CONSTRAINT "working_hours_opens_minute_range" CHECK (opens_minute IS NULL OR (opens_minute BETWEEN 0 AND 1440)),
  ADD CONSTRAINT "working_hours_closes_minute_range" CHECK (closes_minute IS NULL OR (closes_minute BETWEEN 0 AND 1440)),
  ADD CONSTRAINT "working_hours_open_window" CHECK (
    is_open = false
    OR (opens_minute IS NOT NULL AND closes_minute IS NOT NULL AND closes_minute > opens_minute)
  );

ALTER TABLE "availability_block"
  ADD CONSTRAINT "availability_block_range_valid" CHECK (ends_at > starts_at);

-- Catalogue ------------------------------------------------------------------

ALTER TABLE "service"
  -- Now part of a public URL, /p/<handle>/<slug> (§2.5).
  ADD CONSTRAINT "service_slug_format" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT "service_booking_fee_rate_override_range" CHECK (
    booking_fee_rate_override IS NULL
    OR (booking_fee_rate_override >= 0 AND booking_fee_rate_override <= 1)
  );

ALTER TABLE "package"
  ADD CONSTRAINT "package_price_non_negative" CHECK (price_rwf >= 0),
  ADD CONSTRAINT "package_photo_count_non_negative" CHECK (photo_count >= 0),
  ADD CONSTRAINT "package_duration_positive" CHECK (duration_minutes > 0);

ALTER TABLE "addon"
  ADD CONSTRAINT "addon_price_non_negative" CHECK (price_rwf >= 0);

-- Booking --------------------------------------------------------------------
-- cancelled_by_admin is now cancelled_by_photographer, and a platform admin
-- cancelling one booking is cancelled_by_platform. Both release the slot and
-- refund the booking fee in full (§2.9). Everything else carried over verbatim.

ALTER TABLE "booking"
  ADD CONSTRAINT "booking_status_allowed" CHECK (status IN (
    'pending_payment', 'confirmed', 'completed', 'no_show',
    'expired', 'cancelled_by_client', 'cancelled_by_photographer', 'cancelled_by_platform'
  )),
  ADD CONSTRAINT "booking_locale_allowed" CHECK (locale IN ('en', 'fr')),
  ADD CONSTRAINT "booking_ends_after_starts" CHECK (ends_at > starts_at),
  ADD CONSTRAINT "booking_buffer_after_ends" CHECK (buffer_ends_at >= ends_at),
  ADD CONSTRAINT "booking_party_size_positive" CHECK (party_size IS NULL OR party_size > 0),
  ADD CONSTRAINT "booking_fee_rate_range" CHECK (booking_fee_rate >= 0 AND booking_fee_rate <= 1),
  ADD CONSTRAINT "booking_fee_non_negative" CHECK (booking_fee_rwf >= 0),
  ADD CONSTRAINT "booking_package_price_non_negative" CHECK (package_price_rwf >= 0),
  ADD CONSTRAINT "booking_package_duration_positive" CHECK (package_duration_minutes > 0),
  ADD CONSTRAINT "booking_package_photo_count_non_negative" CHECK (package_photo_count >= 0),
  ADD CONSTRAINT "booking_delivery_url_https" CHECK (delivery_url IS NULL OR delivery_url ~ '^https://'),
  -- A pending contact-email change: all three or none (2026-09-25).
  ADD CONSTRAINT "booking_pending_email_complete" CHECK (
    (pending_contact_email IS NULL AND pending_email_token_hash IS NULL AND pending_email_expires_at IS NULL)
    OR (pending_contact_email IS NOT NULL AND pending_email_token_hash IS NOT NULL AND pending_email_expires_at IS NOT NULL)
  );

ALTER TABLE "booking_addon"
  ADD CONSTRAINT "booking_addon_unit_price_non_negative" CHECK (unit_price_rwf >= 0),
  ADD CONSTRAINT "booking_addon_quantity_positive" CHECK (quantity > 0),
  ADD CONSTRAINT "booking_addon_amount_derived" CHECK (amount_rwf = unit_price_rwf * quantity),
  ADD CONSTRAINT "booking_addon_stage_allowed" CHECK (stage IN ('at_booking', 'post_shoot'));

-- 1 to 1000 characters, as the studio form and the API allow (2026-09-25).
ALTER TABLE "booking_note"
  ADD CONSTRAINT "booking_note_body_length" CHECK (char_length(body) BETWEEN 1 AND 1000);

-- Money ----------------------------------------------------------------------
-- The single-photographer vocabulary, carried over verbatim (cash since
-- 2026-09-28). The subscription kind, the hosted-checkout provider and their
-- shape CHECKs arrive with Phase 5 (§2.11).

ALTER TABLE "payment"
  ADD CONSTRAINT "payment_kind_allowed" CHECK (kind IN ('booking_fee', 'session_fee')),
  ADD CONSTRAINT "payment_provider_allowed" CHECK (provider IN ('mtn_momo_direct', 'flutterwave', 'cash')),
  ADD CONSTRAINT "payment_method_allowed" CHECK (method IS NULL OR method IN ('momo_mtn', 'momo_airtel', 'card')),
  ADD CONSTRAINT "payment_amount_positive" CHECK (amount_rwf > 0),
  ADD CONSTRAINT "payment_status_allowed" CHECK (status IN (
    'initiated', 'pending', 'succeeded', 'failed', 'refund_due', 'refunded'
  )),
  -- 1 to 500 characters, as the studio form and the API allow.
  ADD CONSTRAINT "payment_note_length" CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  -- Cash is money handed over at the shoot: never the booking fee (§2.11).
  ADD CONSTRAINT "payment_cash_is_session_fee" CHECK (provider <> 'cash' OR kind = 'session_fee');

ALTER TABLE "webhook_event"
  ADD CONSTRAINT "webhook_event_provider_allowed" CHECK (provider IN ('mtn_momo_direct', 'flutterwave')),
  ADD CONSTRAINT "webhook_event_status_allowed" CHECK (status IN ('received', 'applied', 'ignored', 'failed'));

-- Work queue -----------------------------------------------------------------
-- admin_alert is split into photographer_alert and platform_alert, and
-- admin_new_booking is photographer_new_booking (R1.7). Password reset and
-- lockout are account mail. The application, subscription and payout names are
-- reserved now so later phases need no template migration (§2.14).

ALTER TABLE "outbox"
  ADD CONSTRAINT "outbox_kind_allowed" CHECK (kind IN ('email', 'gcal_create', 'gcal_update', 'gcal_delete')),
  ADD CONSTRAINT "outbox_status_allowed" CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled')),
  ADD CONSTRAINT "outbox_attempts_non_negative" CHECK (attempts >= 0),
  -- enqueue() copies the booking's photographer; a booking row without one
  -- would escape the studio's scope.
  ADD CONSTRAINT "outbox_booking_has_photographer" CHECK (booking_id IS NULL OR photographer_id IS NOT NULL),
  ADD CONSTRAINT "outbox_template_allowed" CHECK (template IS NULL OR template IN (
    'booking_confirmation', 'photographer_new_booking', 'session_fee_request',
    'payment_receipt', 'photo_delivery', 'cancellation', 'reschedule',
    'access_link_resend', 'photographer_alert', 'platform_alert', 'booking_links',
    'email_change_confirm', 'email_changed_notice', 'client_note',
    'account_verify_email', 'account_password_reset', 'account_security_alert',
    'photographer_application_received', 'photographer_approved', 'photographer_suspended',
    'subscription_reminder', 'subscription_receipt', 'subscription_expired',
    'payout_sent'
  ));

-- --- Reference data -----------------------------------------------------------
-- Rwanda's 30 districts (§3.4), inserted here rather than by a seed: every
-- environment needs exactly these rows, and the test helpers never truncate
-- this table.

INSERT INTO "district" (code, name, province, sort_order) VALUES
  ('gasabo', 'Gasabo', 'kigali', 1), ('kicukiro', 'Kicukiro', 'kigali', 2), ('nyarugenge', 'Nyarugenge', 'kigali', 3),
  ('bugesera', 'Bugesera', 'eastern', 4), ('gatsibo', 'Gatsibo', 'eastern', 5), ('kayonza', 'Kayonza', 'eastern', 6),
  ('kirehe', 'Kirehe', 'eastern', 7), ('ngoma', 'Ngoma', 'eastern', 8), ('nyagatare', 'Nyagatare', 'eastern', 9),
  ('rwamagana', 'Rwamagana', 'eastern', 10),
  ('burera', 'Burera', 'northern', 11), ('gakenke', 'Gakenke', 'northern', 12), ('gicumbi', 'Gicumbi', 'northern', 13),
  ('musanze', 'Musanze', 'northern', 14), ('rulindo', 'Rulindo', 'northern', 15),
  ('gisagara', 'Gisagara', 'southern', 16), ('huye', 'Huye', 'southern', 17), ('kamonyi', 'Kamonyi', 'southern', 18),
  ('muhanga', 'Muhanga', 'southern', 19), ('nyamagabe', 'Nyamagabe', 'southern', 20), ('nyanza', 'Nyanza', 'southern', 21),
  ('nyaruguru', 'Nyaruguru', 'southern', 22), ('ruhango', 'Ruhango', 'southern', 23),
  ('karongi', 'Karongi', 'western', 24), ('ngororero', 'Ngororero', 'western', 25), ('nyabihu', 'Nyabihu', 'western', 26),
  ('nyamasheke', 'Nyamasheke', 'western', 27), ('rubavu', 'Rubavu', 'western', 28), ('rusizi', 'Rusizi', 'western', 29),
  ('rutsiro', 'Rutsiro', 'western', 30);
