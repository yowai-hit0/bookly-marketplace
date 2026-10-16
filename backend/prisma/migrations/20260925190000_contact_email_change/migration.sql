-- Clients change their own email, confirmed from the new address
-- (docs/prompts/client-access-and-admin-polish.md, item 6). A request waits on
-- the booking until the new address clicks its link: the address, the SHA-256
-- of that link's token, and when it stops working. All three or none.

ALTER TABLE "booking"
  ADD COLUMN "pending_contact_email" TEXT,
  ADD COLUMN "pending_email_token_hash" TEXT,
  ADD COLUMN "pending_email_expires_at" TIMESTAMPTZ(6);

ALTER TABLE "booking"
  ADD CONSTRAINT "booking_pending_email_complete" CHECK (
    (pending_contact_email IS NULL AND pending_email_token_hash IS NULL AND pending_email_expires_at IS NULL)
    OR (pending_contact_email IS NOT NULL AND pending_email_token_hash IS NOT NULL AND pending_email_expires_at IS NOT NULL)
  );

-- A confirmation link addresses exactly one booking.
CREATE UNIQUE INDEX "booking_pending_email_token_hash_unique"
  ON "booking" (pending_email_token_hash)
  WHERE pending_email_token_hash IS NOT NULL;

-- The two new emails: the confirmation link to the new address, and the notice to the old one.
ALTER TABLE "outbox"
  DROP CONSTRAINT "outbox_template_allowed",
  ADD CONSTRAINT "outbox_template_allowed" CHECK (template IS NULL OR template IN (
    'booking_confirmation', 'admin_new_booking', 'session_fee_request',
    'payment_receipt', 'photo_delivery', 'cancellation', 'reschedule',
    'access_link_resend', 'admin_alert', 'booking_links',
    'email_change_confirm', 'email_changed_notice'
  ));
