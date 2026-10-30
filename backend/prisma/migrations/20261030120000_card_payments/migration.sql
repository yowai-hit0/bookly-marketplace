-- ============================================================================
-- Card payments through Flutterwave v3 Inline (user decisions 2026-10-30;
-- marketplace-spec.md "Cards as built"; marketplace-data-model.md §2.11, §2.12).
--
-- The provider vocabulary gains `flutterwave_checkout`, on `payment` and on
-- `webhook_event`, exactly as §2.11 and §2.12 planned it. The `method`
-- vocabulary already allowed `card`.
--
-- Not added: `payment.checkout_url` and its https CHECK. They were planned for
-- the hosted (redirect) checkout. Inline opens a modal on our own page, so
-- there is no hosted page to send a payer back to: an in-progress card payment
-- is reopened from its row (our_ref as tx_ref, amount_rwf, the booking's
-- contact snapshot), which the server rebuilds the same every time.
--
-- No backfill: no card payment exists before this migration.
-- ============================================================================

ALTER TABLE "payment" DROP CONSTRAINT "payment_provider_allowed";
ALTER TABLE "payment"
  ADD CONSTRAINT "payment_provider_allowed" CHECK (provider IN ('mtn_momo_direct', 'flutterwave', 'flutterwave_checkout', 'cash'));

ALTER TABLE "webhook_event" DROP CONSTRAINT "webhook_event_provider_allowed";
ALTER TABLE "webhook_event"
  ADD CONSTRAINT "webhook_event_provider_allowed" CHECK (provider IN ('mtn_momo_direct', 'flutterwave', 'flutterwave_checkout'));
