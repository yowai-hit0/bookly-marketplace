-- The "email me my links" page (docs/prompts/client-access-and-admin-polish.md, item 4):
-- one new transactional email, `booking_links`, listing a fresh link for each of
-- a client's current bookings. The CHECK is recreated whole, as every template
-- migration does, so it always reads as the full list.

ALTER TABLE "outbox"
  DROP CONSTRAINT "outbox_template_allowed",
  ADD CONSTRAINT "outbox_template_allowed" CHECK (template IS NULL OR template IN (
    'booking_confirmation', 'admin_new_booking', 'session_fee_request',
    'payment_receipt', 'photo_delivery', 'cancellation', 'reschedule',
    'access_link_resend', 'admin_alert', 'booking_links'
  ));
