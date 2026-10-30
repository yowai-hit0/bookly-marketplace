# Payments

No card number, CVV or Mobile Money PIN ever reaches the application — Mobile
Money is approved on the payer's phone, and a card is typed into Flutterwave's
own Inline window (a frame served from Flutterwave's origin), never into a page
of ours. The application's job is to start an attempt, record what the provider
says, and apply the provider's webhook safely.

## Providers

Both providers implement one interface, `PaymentProvider`
(`src/payments/provider.ts`): `initiate`, `lookupStatus`, `verifyWebhook`,
`parseWebhook`. Which provider collects a payment follows the method the client
chose (`src/payments/routing.ts`), and the routing is configuration, not a
branch in business logic:

- `momo_mtn` goes where `MOMO_MTN_PROVIDER` says: `mtn_momo_direct` (the
  default) or `flutterwave`.
- `momo_airtel` always goes to `flutterwave`.
- `card` always goes to `flutterwave_checkout`: Flutterwave **v3 Inline**, the
  Flutterwave modal on our own pay page (user decisions 2026-10-30). It is
  offered, last, whenever the three `FLUTTERWAVE_V3_*` keys are set. See
  [Cards](#cards) below.
- `PAYMENT_METHODS_ENABLED` (optional, e.g. `momo_mtn,momo_airtel`) narrows the
  list. A method is offered only when its provider is configured, so
  `GET /api/payment-methods` answers `{ methods }` with exactly what can be
  collected, possibly nothing.

- **MTN MoMo direct** (`payments/mtn-momo.ts`) — the development phase. MTN
  signs nothing it sends, so the callback's authenticity is carried by the URL:
  `/api/webhooks/mtn-momo/<ourRef>/<HMAC(ourRef)>`, keyed from `SESSION_SECRET`,
  and the body's `externalId` must name the same payment.
- **Flutterwave** (`payments/flutterwave.ts`) — mobile money, post-cutover.
  Webhooks are verified by the `flutterwave-signature` header, an HMAC-SHA256 of
  the raw body against the dashboard's secret hash.

Both providers stay mounted after a cutover (`payments/providers.ts`), so
in-flight MTN payments still settle and switching `MOMO_MTN_PROVIDER` back is a
one-variable rollback. The retired `PAYMENT_PROVIDER` is refused at startup
unless it says `mtn_momo_direct`, the new default.

## Cards

Cards pay the booking fee, the session fee (guest checkout, guest booking page,
account dashboard) and the photographer's subscription. The platform absorbs
the card fee: the payer pays the listed amount, and the pay page shows no fee
line. Card refunds are made by hand in the Flutterwave dashboard and recorded
on `/platform/refunds`, as for MoMo.

- **Starting.** A pay route asked for `{ method: 'card' }` (no phone) creates the
  `payment` row and calls nothing. It answers `201 { payment, card }`, where
  `card` is the Inline config built on the server: public key, `tx_ref` (our
  `our_ref`), the row's amount, `RWF`, `payment_options: card`, the payer, a
  `redirect_url` on `WEB_ORIGIN` and the session length. While the card
  checkout is still open, a second card tap answers `200` with the **same**
  payment and config.
- **The browser** (`frontend/src/lib/flutterwave-inline.ts`) loads
  `https://checkout.flutterwave.com/v3.js` on demand, once, and calls
  `FlutterwaveCheckout({ ...card, callback, onclose })` with the config
  unchanged. Closing the modal unpaid leaves the payer on the pay page ("nothing
  was charged"). On completion, Flutterwave moves the tab to `redirect_url`
  with `?status=&tx_ref=&transaction_id=` (the redirect wins over the
  `callback`); a `callback` goes to the same page.
- **Return pages.** `/checkout/:reference/:token/payments/:ourRef`, the
  token-free `/payments/:ourRef` for a guest session fee (the booking's access
  token is never put in a URL Flutterwave stores; the tab keeps it in
  `sessionStorage` under the `ourRef` to link back),
  `/account/bookings/:reference/payments/:ourRef` and
  `/studio/subscription/payments/:ourRef`. Each reads `transaction_id` once
  (digits only), strips the query, and polls its status route with
  `?transactionId=`. `status=successful` is never read: only the poll's answer
  counts.
- **Settling.** A verified webhook (re-verified through Flutterwave's API), the
  poll's throttled check, or the reconciler; the amount and currency must match
  exactly. The CSP allows the script (`script-src`, by path) and Flutterwave's
  two checkout origins (`frame-src`) and nothing more.

## Starting an attempt

`payments/initiate.ts` (`startBookingFeePayment`, `startSessionFeePayment`):

1. In a transaction, lock the booking, check it can still be paid, and
   **insert the `payment` row** (`initiated`, with its own `our_ref`) — so an
   attempt that never reaches the provider is still on record. The amount is the
   frozen `booking_fee_rwf` or the outstanding total; never a number the client
   sent. The row records the provider the method routes to and the method
   itself. A booking fee for a photographer who can no longer be booked is
   `409 photographer_unavailable` and records nothing; a session fee on an
   existing booking stays payable whatever the photographer's status.
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
and currency are checked** against the payment's frozen amount and the
currency the provider charges; a mismatch is logged and the event ignored. Money over what the booking is worth — a duplicate fee, or a fee
after the slot was lost — is settled but marked `refund_due`, and the admin is
alerted.

Every callback is stored as a `webhook_event` row even when it matches nothing
or fails verification, because a stray or spoofed post is itself evidence worth
keeping. The route answers `401` for a delivery whose signature fails (stored,
applied to nothing), `200` for any other delivery on record, and `500` only
when processing genuinely failed (asking the provider to retry).

## The reconciler

Callbacks get lost, and the MTN sandbox sends none. `payments/reconcile.ts`
runs one job per configured provider, including one no method routes to any
more, and polls that provider's status endpoint for payments still pending, feeding the
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
