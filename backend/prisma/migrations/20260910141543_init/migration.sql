-- CreateTable
CREATE TABLE "admin_user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "password_reset_token_hash" TEXT,
    "password_reset_expires_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "booking_fee_rate" DECIMAL(4,3) NOT NULL DEFAULT 0.400,
    "min_lead_time_minutes" INTEGER NOT NULL DEFAULT 120,
    "hold_minutes" INTEGER NOT NULL DEFAULT 30,
    "buffer_minutes" INTEGER NOT NULL DEFAULT 30,
    "delivery_expiry_days" INTEGER NOT NULL DEFAULT 90,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_hours" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "booking_id" UUID,
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
CREATE UNIQUE INDEX "service_slug_key" ON "service"("slug");

-- CreateIndex
CREATE INDEX "package_service_id_idx" ON "package"("service_id");

-- CreateIndex
CREATE INDEX "addon_service_id_idx" ON "addon"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_reference_key" ON "booking"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "booking_access_token_hash_key" ON "booking"("access_token_hash");

-- CreateIndex
CREATE INDEX "booking_status_starts_at_idx" ON "booking"("status", "starts_at");

-- CreateIndex
CREATE INDEX "booking_client_id_starts_at_idx" ON "booking"("client_id", "starts_at" DESC);

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
CREATE UNIQUE INDEX "outbox_dedupe_key_key" ON "outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_booking_id_created_at_idx" ON "outbox"("booking_id", "created_at");

-- AddForeignKey
ALTER TABLE "package" ADD CONSTRAINT "package_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addon" ADD CONSTRAINT "addon_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_addon" ADD CONSTRAINT "booking_addon_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_addon" ADD CONSTRAINT "booking_addon_addon_id_fkey" FOREIGN KEY ("addon_id") REFERENCES "addon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- HAND-WRITTEN. Everything below this line was added by hand and is INVISIBLE
-- to Prisma (data-model_v2.md 2.1). `prisma db push` reconciles the database to
-- schema.prisma and would drop all of it -- including booking_no_overlap, the
-- constraint that makes double booking impossible. That command is forbidden in
-- every environment. Schema changes go through `migrate dev --create-only`.
-- ============================================================================

-- --- Functional unique indexes ----------------------------------------------
-- Email is matched case-insensitively, so uniqueness must be too.

CREATE UNIQUE INDEX "admin_user_lower_email_unique" ON "admin_user" (lower(email));
CREATE UNIQUE INDEX "client_lower_email_unique" ON "client" (lower(email));

-- --- Partial unique index 1 of 4 --------------------------------------------
-- The provider's own id, once it exists. Null until they answer, and many rows
-- may sit null at once, so a plain unique constraint cannot express this.

CREATE UNIQUE INDEX "payment_provider_ref_unique"
  ON "payment" (provider_ref)
  WHERE provider_ref IS NOT NULL;

-- --- Partial unique index 2 of 4 --------------------------------------------
-- No double-charging the deposit (v1 defect #5). Session fees stay
-- many-per-booking, which spec 6.15 requires.

CREATE UNIQUE INDEX "payment_one_succeeded_booking_fee"
  ON "payment" (booking_id)
  WHERE kind = 'booking_fee' AND status = 'succeeded';

-- --- Partial unique index 3 of 4 --------------------------------------------
-- One recurring rule per weekday.

CREATE UNIQUE INDEX "working_hours_weekday_unique"
  ON "working_hours" (weekday)
  WHERE effective_date IS NULL;

-- --- Partial unique index 4 of 4 --------------------------------------------
-- One dated override per date.

CREATE UNIQUE INDEX "working_hours_effective_date_unique"
  ON "working_hours" (effective_date)
  WHERE weekday IS NULL;

-- --- Partial indexes that are NOT unique ------------------------------------

-- Keeps the queue scan small as history grows (data-model_v2.md 9.3).
CREATE INDEX "outbox_queue_idx"
  ON "outbox" (status, next_attempt_at)
  WHERE status IN ('pending', 'processing');

-- Sweeper, and step 2 of the claim transaction (data-model_v2.md 9.2).
CREATE INDEX "booking_hold_expires_at_idx"
  ON "booking" (hold_expires_at)
  WHERE status = 'pending_payment';

-- Subtracting blocks from the open window.
CREATE INDEX "availability_block_range_idx"
  ON "availability_block" USING gist (tstzrange(starts_at, ends_at));

-- ============================================================================
-- THE CONSTRAINT THE PROJECT EXISTS FOR (data-model_v2.md 9.1)
--
-- Two bookings with overlapping reserved ranges cannot both exist, whatever the
-- application does. The range runs to buffer_ends_at, so the buffer is
-- protected by the same mechanism as the shoot. Cancelled and expired bookings
-- leave the predicate and stop occupying time the instant their status changes.
--
-- The status list here MUST equal the occupying statuses in data-model_v2.md
-- 7.1. A test asserts that, because adding a status without updating this
-- predicate would silently free occupied time.
--
-- No btree_gist extension is needed: the constraint ranges over one expression.
-- ============================================================================

ALTER TABLE "booking" ADD CONSTRAINT "booking_no_overlap"
  EXCLUDE USING gist (tstzrange(starts_at, buffer_ends_at, '[)') WITH &&)
  WHERE (status IN ('pending_payment', 'confirmed', 'completed', 'no_show'));

-- --- CHECK constraints ------------------------------------------------------
-- Enumerations are text + CHECK, not native enum: adding a value under R-1 is
-- then one line, not an ALTER TYPE that locks and will not roll back inside a
-- transaction (data-model_v2.md 2).

ALTER TABLE "setting"
  ADD CONSTRAINT "setting_single_row" CHECK (id = 1),
  ADD CONSTRAINT "setting_booking_fee_rate_range" CHECK (booking_fee_rate >= 0 AND booking_fee_rate <= 1),
  ADD CONSTRAINT "setting_min_lead_time_non_negative" CHECK (min_lead_time_minutes >= 0),
  ADD CONSTRAINT "setting_hold_minutes_positive" CHECK (hold_minutes > 0),
  ADD CONSTRAINT "setting_buffer_minutes_non_negative" CHECK (buffer_minutes >= 0),
  ADD CONSTRAINT "setting_delivery_expiry_days_positive" CHECK (delivery_expiry_days > 0);

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

ALTER TABLE "service"
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

ALTER TABLE "booking"
  ADD CONSTRAINT "booking_status_allowed" CHECK (status IN (
    'pending_payment', 'confirmed', 'completed', 'no_show',
    'expired', 'cancelled_by_client', 'cancelled_by_admin'
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
  ADD CONSTRAINT "booking_delivery_url_https" CHECK (delivery_url IS NULL OR delivery_url ~ '^https://');

ALTER TABLE "booking_addon"
  ADD CONSTRAINT "booking_addon_unit_price_non_negative" CHECK (unit_price_rwf >= 0),
  ADD CONSTRAINT "booking_addon_quantity_positive" CHECK (quantity > 0),
  ADD CONSTRAINT "booking_addon_amount_derived" CHECK (amount_rwf = unit_price_rwf * quantity),
  ADD CONSTRAINT "booking_addon_stage_allowed" CHECK (stage IN ('at_booking', 'post_shoot'));

ALTER TABLE "payment"
  ADD CONSTRAINT "payment_kind_allowed" CHECK (kind IN ('booking_fee', 'session_fee')),
  ADD CONSTRAINT "payment_provider_allowed" CHECK (provider IN ('mtn_momo_direct', 'flutterwave')),
  ADD CONSTRAINT "payment_method_allowed" CHECK (method IS NULL OR method IN ('momo_mtn', 'momo_airtel', 'card')),
  ADD CONSTRAINT "payment_amount_positive" CHECK (amount_rwf > 0),
  ADD CONSTRAINT "payment_status_allowed" CHECK (status IN (
    'initiated', 'pending', 'succeeded', 'failed', 'refund_due', 'refunded'
  ));

ALTER TABLE "webhook_event"
  ADD CONSTRAINT "webhook_event_provider_allowed" CHECK (provider IN ('mtn_momo_direct', 'flutterwave')),
  ADD CONSTRAINT "webhook_event_status_allowed" CHECK (status IN ('received', 'applied', 'ignored', 'failed'));

ALTER TABLE "outbox"
  ADD CONSTRAINT "outbox_kind_allowed" CHECK (kind IN ('email', 'gcal_create', 'gcal_update', 'gcal_delete')),
  ADD CONSTRAINT "outbox_status_allowed" CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled')),
  ADD CONSTRAINT "outbox_attempts_non_negative" CHECK (attempts >= 0),
  ADD CONSTRAINT "outbox_template_allowed" CHECK (template IS NULL OR template IN (
    'booking_confirmation', 'admin_new_booking', 'session_fee_request',
    'payment_receipt', 'photo_delivery', 'cancellation', 'reschedule',
    'access_link_resend', 'admin_alert'
  ));
