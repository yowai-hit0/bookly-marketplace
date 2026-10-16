-- Notes the photographer writes to a client, shown on the client's booking page
-- and optionally emailed (docs/prompts/client-access-and-admin-polish.md, item 8).
-- Deleting one hides it from the client and keeps the row: `deleted_at`.

CREATE TABLE "booking_note" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "booking_id" UUID NOT NULL,
  "body"       TEXT NOT NULL,
  "emailed"    BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "booking_note_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "booking_note_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- 1 to 1000 characters, as the admin form and the API allow.
  CONSTRAINT "booking_note_body_length" CHECK (char_length(body) BETWEEN 1 AND 1000)
);

CREATE INDEX "booking_note_booking_id_created_at_idx" ON "booking_note" ("booking_id", "created_at");

-- The email a note may go out as.
ALTER TABLE "outbox"
  DROP CONSTRAINT "outbox_template_allowed",
  ADD CONSTRAINT "outbox_template_allowed" CHECK (template IS NULL OR template IN (
    'booking_confirmation', 'admin_new_booking', 'session_fee_request',
    'payment_receipt', 'photo_delivery', 'cancellation', 'reschedule',
    'access_link_resend', 'admin_alert', 'booking_links',
    'email_change_confirm', 'email_changed_notice', 'client_note'
  ));
