# Payments migration: MTN MoMo direct → Flutterwave v4 (mobile money only)

Fills the `flutterwave` slot of the existing `PaymentProvider` seam (plan.md Task 25).
No schema change, no route-contract change, no card support. `PAYMENT_PROVIDER=mtn_momo_direct`
remains a one-variable rollback.

## Stage 0 findings

Probed against the sandbox on 2026-09-23 (throwaway script, not committed).

### Q1: next_action for a Rwanda mobile money charge: `payment_instruction`
Default charge (no `X-Scenario-Key`), `country_code: "250"`, `network: "MTN"`, RWF 1000:
HTTP 201, `status: "pending"`, `processor_response {type: "pending", code: "02"}`,
`next_action: { type: "payment_instruction", payment_instruction: { note: "Please authorise this
payment on your mobile number: 250788123456. …" } }`. Airtel gave the same result.
**The frontend is untouched.** `redirect_url` appears only when forced with `scenario:auth_redirect`.
The adapter still handles it defensively (see Stage 1 decisions).

### Q2: Airtel Rwanda network code: `AIRTEL`
`network: "AIRTEL"` → 201, and the charge returns `payment_instruction`. `ATL` and `AIRTELTIGO` → 400
`MOBILE_MONEY_NETWORK_NOT_SUPPORTED`: *"Network ATL not supported for RW Mobile Money. Supported
networks: AIRTEL, MTN."* The API itself names the code. **Ship `methods: ['momo_mtn', 'momo_airtel']`.**

### Q3: Webhook signature (settled from docs, v4.0.0)
Source: https://developer.flutterwave.com/v4.0/docs/webhooks (the unversioned `/docs/webhooks`
still serves v3 with `verif-hash`, so do not use it).
- Header: `flutterwave-signature`.
- Value: `base64(HMAC-SHA256(key = dashboard "Secret hash", message = raw request body))`.
- So the secret hash is **no longer compared verbatim**. It is the HMAC key. We compute the MAC over
  the raw bytes and compare it with `crypto.timingSafeEqual` after a length check (the docs' sample uses `===`).
- Envelope: `{ id: "wbk_…", timestamp, type: "charge.completed", data: { id, reference, status,
  amount, currency, payment_method, customer, processor_response, … } }`.
- Retries: 3 times at 30-minute intervals when any response other than 200 comes back (when retries are enabled in the dashboard). Timeout 60 s.

### Other facts established
- `matchPayment` (webhooks.ts) already matches on `event.ourRef`, which `parseWebhook` supplies.
  It never reads URL params. A static `/api/webhooks/flutterwave` route plus `data.reference` in
  `parseWebhook` is enough, and webhooks.ts needs no change.
- `lookupStatus`: `GET /charges?reference=<ourRef>` exists in v4 (list, filterable by reference).
  Empty `data` → return null.
- v4 charge statuses: `succeeded`, `pending`, `failed`, `voided`.
- `eventId` will be `${ourRef}:${STATUS}` as in MoMo, **not** the `wbk_…` delivery id. Only that
  form collides between a webhook and a reconciler lookup reporting the same outcome.

### Wire facts from the probe (the adapter relies on these)
- **Token:** `expires_in: 600`, i.e. 10 minutes, far shorter than MoMo's. The 60 s refresh margin still fits.
- **Customer per attempt:** `POST /customers { email, name: { first, last } }` → 201 `cus_…`. Accepted,
  so that is the choice. We send a placeholder email, since we don't give Flutterwave the booker's email.
- **Payment method:** `phone_number` is the national number without the country code (`788123456`),
  with `country_code: "250"` separate. We strip the `+250` from our E.164 value.
- **Charge:** `reference` = our uuid (36 chars, accepted). `X-Idempotency-Key` = our uuid too. The
  response has `data.id` = `chg_…` → `providerRef`, and `data.amount` in whole RWF (1000 → 1000, not ×100).
- **Hard decline is a 201, not a 4xx.** `X-Scenario-Key: issuer:insufficient_funds` (also
  `incorrect_pin`, `issuer_unavailable`, `suspected_fraud`) → HTTP 201, `data.status: "failed"`,
  `processor_response {type: "failed", code: "06"}`, no `next_action`, no text message. `initiate` must read
  `data.status` and not stop at the HTTP code.
- **Validation errors are 4xx** with `{ status: "failed", error: { type, code, message, validation_errors } }`.
  `error.type` (e.g. `MOBILE_MONEY_NETWORK_NOT_SUPPORTED`) is a clean short code for `reason`.
- **Lookup:** `GET /charges?reference=<uuid>` → 200 `{ data: [charge], meta.page_info.total: 1 }`.
  Unknown reference → 200 with `data: []`, which returns null.
- **Sandbox success cannot be forced.** Two default-flow charges (`chg_wzRkqRwy6C` MTN, `chg_NKpm6gvu6x`
  Airtel), polled once a minute, were still `pending` / `02` about 19 minutes after creation (16:13 → 16:33 UTC).
  `issuer:approved` doesn't force success either. The "auto-authorizes after a few seconds" claim does not hold in this
  sandbox. The success path is therefore proven by unit tests and signed fake webhooks, and only a live-mode
  charge exercises it for real. The decline path *is* sandbox-testable with `issuer:insufficient_funds`.

## Stage 1: the adapter (2026-09-25)

- `backend/src/payments/flutterwave.ts`: token (cached, shared, dropped on 401) → `POST /customers` →
  `POST /payment-methods` → `POST /charges` (`reference` = idempotency key = `our_ref`). `methods: ['momo_mtn',
  'momo_airtel']`. Numbers outside `+2507xxxxxxxx` are refused `phone_not_rwandan_mobile` before any call.
- Decisions taken as proposed: a `redirect_url` next action → rejected `redirect_required`; Flutterwave is in
  `providers.all` whenever it is active or configured; the "flutterwave throws" test is replaced.
- Refusals: `data.status` failed/voided → `charge_failed_<processor code>` / `charge_voided`; 400/409/422 →
  `error.type`. 401, 429, 5xx, network and timeout → `PaymentProviderError` (recorded as unavailable).
- Webhook: `POST /api/webhooks/flutterwave`, verified by `flutterwave-signature` (timing-safe, raw bytes). MTN's
  route stays mounted. The lookup-based reconciler runs for every configured provider, Flutterwave included.
- Env: `FLUTTERWAVE_BASE_URL`, `FLUTTERWAVE_IDP_URL`, `FLUTTERWAVE_CLIENT_ID`, `FLUTTERWAVE_CLIENT_SECRET`,
  `FLUTTERWAVE_WEBHOOK_HASH`, `FLUTTERWAVE_CURRENCY` (default RWF). The first three credentials are required in
  production with `PAYMENT_PROVIDER=flutterwave`.
- Frontend: unchanged. It already renders any method `/api/payment-methods` lists, Airtel Money included.

## Run state
- Stage: 1 complete (uncommitted). Full backend suite green against local PostgreSQL.
- Awaiting from the user: real sandbox client credentials (the local `.env` ones answer `401 invalid_client`);
  the webhook URL and secret hash entered in the dashboard; the same variables set on the deployed API.
- Next action: a live-mode charge to exercise the success path for real (the sandbox never settles momo).
