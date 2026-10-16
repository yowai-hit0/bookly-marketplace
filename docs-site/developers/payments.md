# Payments

No card number, CVV or Mobile Money PIN ever reaches the application — payment
completes on the provider's hosted flow, keeping the project in PCI DSS SAQ-A
scope. The application's job is to start an attempt, record what the provider
says, and apply the provider's webhook safely.

## Providers

Both providers implement one interface, `PaymentProvider`
(`src/payments/provider.ts`): `initiate`, `lookupStatus`, `verifyWebhook`,
`parseWebhook`. Provider selection is configuration (`PAYMENT_PROVIDER`), not a
branch in business logic.

- **MTN MoMo direct** (`payments/mtn-momo.ts`) — the development phase. MTN
  signs nothing it sends, so the callback's authenticity is carried by the URL:
  `/api/webhooks/mtn-momo/<ourRef>/<HMAC(ourRef)>`, keyed from `SESSION_SECRET`,
  and the body's `externalId` must name the same payment.
- **Flutterwave** (`payments/flutterwave.ts`) — mobile money, post-cutover.
  Webhooks are verified by the `flutterwave-signature` header, an HMAC-SHA256 of
  the raw body against the dashboard's secret hash.

Both providers stay mounted after a cutover (`payments/providers.ts`), so
in-flight MTN payments still settle and switching back is a one-variable
rollback.

## Starting an attempt

`payments/initiate.ts` (`startBookingFeePayment`, `startSessionFeePayment`):

1. In a transaction, lock the booking, check it can still be paid, and
   **insert the `payment` row** (`initiated`, with its own `our_ref`) — so an
   attempt that never reaches the provider is still on record. The amount is the
   frozen `booking_fee_rwf` or the outstanding total; never a number the client
   sent.
2. Outside any transaction, call the provider. A slow provider must not hold a
   row lock or a pooled connection; the call has a deadline.
3. Accepted → `pending` (await the webhook). Refused or unreachable → `failed`
   with a reason; the booking is untouched and can be retried.

A second attempt while one is still live on the payer's phone is refused
(`payment_in_progress`) — that window is how a deposit gets paid twice.

## Applying a webhook

`payments/webhooks.ts` — **store first, verify, dedupe, apply forward-only**:

1. **Verify.** A delivery that fails verification is stored
   `signature_valid = false`, `ignored`, and applies nothing.
2. **Insert.** `(provider, event_id)` is unique, so a repeat delivery finds the
   first and is stored `ignored` beside it. This — not `provider_ref` — is what
   makes delivery idempotent.
3. **Match** a payment on `our_ref`, else `provider_ref`. No match → `ignored`
   and kept for inspection.
4. **Forward-only.** An event for a payment already `succeeded`, `failed`,
   `refunded` or `refund_due` is recorded and ignored — a failed attempt never
   becomes a success; a retry is its own payment with its own `our_ref`.
5. **Apply** the transition in one transaction with everything it implies, and
   mark the event `applied`.

A `succeeded` event that would confirm a booking takes the slot-claim advisory
lock first, so a confirmation and a claim can never race. The reported **amount
is checked** against the payment's frozen amount; a mismatch is logged and the
event ignored. Money over what the booking is worth — a duplicate fee, or a fee
after the slot was lost — is settled but marked `refund_due`, and the admin is
alerted.

Every callback is stored as a `webhook_event` row even when it matches nothing
or fails verification, because a stray or spoofed post is itself evidence worth
keeping. The route answers `200` whenever the delivery is on record and `500`
only when processing genuinely failed (asking the provider to retry).

## The reconciler

Callbacks get lost, and the MTN sandbox sends none. `payments/reconcile.ts`
polls the provider's status endpoint for payments still pending and feeds the
result through the *same* apply path, so a reconciled settlement and a webhook
settlement are indistinguishable and equally idempotent.

## Refunds and cash

- **Refund** — the system never moves money. `POST /api/admin/payments/:id/refund`
  records that the photographer refunded a payment by hand, with the MoMo or
  bank reference. A cancellation marks the booking fee `refund_due`; recording
  the refund is the separate, deliberate second step.
- **Cash** (`payments/cash.ts`) — the photographer records cash handed over, up
  to what is owed. It is refused while an online payment may be in flight, and it
  voids any open online request so the same money cannot be collected twice.
  Cash is refunded like any other payment.

---

*Not a developer? The same flow for the people using it: clients see
[Paying for your booking](/help/paying); the photographer sees
[Payments, cash and refunds](/guide/payments).*
