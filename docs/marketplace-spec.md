# Bookly Marketplace: specification

Bookly started as a booking site for a single photographer (`docs/specs_v2.md`). This specification turns it into a **marketplace**:
- Many photographers subscribe, list their services and manage their own bookings.
- Clients browse a public directory, book any photographer, and can optionally hold an account.

Where this document and `docs/specs_v2.md` disagree, this document wins. In particular it replaces §2.1 (one admin), §4.2 (multiple photographers out of scope) and §6.10–6.11 (cancellation rules, which are now set by each photographer).

The data model changes are in [`docs/marketplace-data-model.md`](marketplace-data-model.md). Requirement ids (`R1.2`, `T3.4`, …) are referenced from code comments and tests.

## Product decisions
| Topic | Decision |
|---|---|
| Money in | Clients pay into the **platform's** MoMo or Flutterwave account. They choose MoMo (MTN or Airtel) or **card** (Flutterwave hosted checkout) at checkout. |
| Money out | Each photographer saves one payout destination: MoMo (network, number, account name) or bank (bank, account number, account name). The platform transfers their share **by hand**. **No commission.** A banner says transfer fees are deducted from what they receive, so they should price accordingly. |
| Payout timing | The booking fee is payable as soon as its payment succeeds. The session fee is payable once the session has ended and the booking was not cancelled. A refund after a payout becomes a negative line on the next payout. |
| Fees and cancellation | **Each photographer decides, with no platform limits:** booking-fee %, lead time, buffer, delivery expiry, and the client cancellation policy (cut-off and whether the booking fee is refunded). One platform rule is assumed: *a photographer who cancels always refunds the booking fee in full* (today's §6.11 behaviour). |
| Subscription | One plan, **monthly or yearly**, paid by MoMo or card. A **30-day** free trial starts at approval. Reminders go out 7, 3 and 1 days before the period ends. After that, 7 days of `past_due`: the profile stays visible but can't be booked. Then `expired`: hidden from the directory. Existing bookings always carry on. |
| Photographer onboarding | They sign up themselves (email and password, email verified), start as `pending`, and a platform admin approves them. Suspending a photographer **keeps their existing bookings**. |
| Clients | Accounts are optional. Guest booking with an emailed link and token stays. Clients sign in with email and password **or Google**. Google sign-in is for clients only. |
| Platform admin | Password only, no 2FA in v1. The first platform admin is seeded from env. |
| Client dashboard | Bookings across all photographers; payments and receipts; profile and privacy (edit details, change password, export data, delete account). |
| Directory filters | Category, district (Rwanda's 30), price range (cheapest active package), available on a date. |
| Images | **No file uploads.** Cover and portfolio images are pasted `https://` URLs. |
| Scope | Rwanda only (RWF, Africa/Kigali). **English only**, with i18n kept ready. No reviews (later phase), no commission, no staff accounts, no automatic payouts, no saved or recurring cards, no Google Calendar sync. |

## Documents this work produces
1. **`docs/marketplace-data-model.md`** covers every change to the current schema: what is kept, changed, replaced or added; exact Prisma models; hand-written SQL; the migration strategy; which code breaks; and which schema tests to add.
2. **`docs/marketplace-spec.md`**: the decisions table above plus the rules in each phase below. It replaces the single-photographer parts of `specs_v2.md` (§2.1, §4.2, §6.10–6.11).

## URL map (frontend)
| Area | Routes |
|---|---|
| Public | `/` (marketplace landing), `/photographers?category&district&min&max&date&page` (directory), `/p/:handle` (profile: bio, portfolio, services, policies, contact), `/p/:handle/:slug` (service: reuses `ServiceDetail` with slot picker, form and hold) |
| Guest booking (unchanged mechanics) | `/checkout/:reference/:token`, `/checkout/:reference/:token/payments/:ourRef` (also the **card return page**), `/booking/:token`, `/my-booking`, `/email-confirm/:token` |
| Client account | `/account/login`, `/account/signup`, `/account/verify/:token`, `/account/reset-password`, `/account` (dashboard), `/account/bookings/:reference`, `/account/payments`, `/account/payments/:ourRef/receipt`, `/account/profile` |
| Photographer studio | `/studio/login`, `/studio/signup`, `/studio/verify/:token`, `/studio/reset-password`. The current five pages move from `/admin/*` to `/studio/*`. New pages: `/studio/setup`, `/studio/profile`, `/studio/earnings`, `/studio/payout-method`, `/studio/subscription`. |
| Platform admin | `/platform/login`, `/platform/photographers` (+ `/:id`), `/platform/payouts` (+ `/:id`), `/platform/subscriptions`, `/platform/categories`, `/platform/settings`, `/platform/refunds` |

The API follows the same shape: `/api/...` for public, `/api/account/*`, `/api/studio/*` and `/api/platform/*`. Reserved handles (`admin`, `api`, `p`, `studio`, `platform`, `account`, `photographers`, …) are refused at signup.

---

## Phase 0: Baseline (done)
- The open findings of the 2026-10-11 security review are fixed:
  - the "email me my links" lookup matches the email exactly instead of by pattern
  - rate limits and a cap of 3 live holds per email
  - security headers on the API and the SPA
  - a configurable proxy-hop count
  - delivery URLs must be `https://`
  - an explicit JSON body limit
  - dependency audit
- CI runs the backend tests against Postgres, frontend lint, tests and build, OpenAPI parity, and a secret scan.

---

## Phase 1: Data model and per-photographer separation (backend foundation)
Everything in **`marketplace-data-model.md`** applies; that is the specification for this phase. Key points:

**Requirements**
- **R1.1** One squashed baseline migration (`marketplace_init`) with `btree_gist`. The 14 tables become 26. `admin_user` becomes `app_user`, and `setting` is split into `photographer_setting` and `platform_setting`.
- **R1.2** `photographer_id NOT NULL` on `service`, `package`, `addon`, `working_hours`, `availability_block` and `booking`; optional on `outbox`.
  - Composite FKs make sure a booking's service and package belong to the same photographer as the booking.
  - The double-booking constraint becomes `photographer_id WITH =, tstzrange(...) WITH &&`.
- **R1.3** The slot-claiming code is scoped per photographer:
  - `booking/claim.ts:80`: the advisory lock key becomes `'bookly.claim_slot:' || photographer_id`.
  - `claim.ts:119-131`: stale-hold expiry is scoped to the photographer.
  - `payments/webhooks.ts:219` (lock order) and `:330-341` (`slotOccupied`) are scoped too.
  - The claim re-checks inside its transaction that the photographer can be booked.
- **R1.4** Every studio query takes `photographerId` from the verified token, **never from the request**. `findUnique({id})` becomes `findFirst({id, photographerId})`, and a missing match returns `404`. The IDOR-risk sites are listed in `marketplace-data-model.md` §6.
- **R1.5** Fix two holes that let one photographer's add-ons attach to another's bookings: `catalogue/basket.ts:66-72` and `booking/addons.ts:73-79`.
- **R1.6** Photographers see only the booking's snapshot fields (`contact_*`), never the shared `client` row.
- **R1.7** Notifications go to the booking's photographer, not the oldest admin:
  - replace the 4 `adminUser.findFirst` calls
  - split `admin_alert` into `photographer_alert` and `platform_alert`
  - rename `admin_new_booking` to `photographer_new_booking`
- **R1.8** Per-photographer cancellation policy. This is an **amendment to `marketplace-data-model.md`**: `photographer_setting` gains
  - `client_cancel_cutoff_hours int NOT NULL DEFAULT 0` (0 = any time before the shoot, today's behaviour)
  - `booking_fee_refundable_on_client_cancel boolean NOT NULL DEFAULT false` (today's behaviour)

  `cancel.ts` and `canCancel` read these. A photographer cancelling always refunds in full.

  **Snapshotted per booking (decided 2026-10-16).** Each booking copies both values from its photographer's settings when it is created (`booking.client_cancel_cutoff_hours`, `booking.booking_fee_refundable_on_client_cancel`; `marketplace-data-model.md` §2.9), and `cancel.ts` and `canCancel` read the booking's copy. Editing the settings changes the terms of new bookings only, never of one already made. The client's booking page and the checkout show the terms as `cancellation: { deadline, bookingFeeRefundable }`.
- **R1.9** Seed: one platform admin from env, a `platform_setting` row (trial 30, prices as placeholders), and the starter categories. The demo seed adds **3 photographers** whose catalogues and calendars overlap.

**Test criteria**
- **T1.1** Every schema test in `marketplace-data-model.md` §7 passes: constraints, composite FKs, exclusion per photographer, CHECKs, 30 districts, 26 tables.
- **T1.2** **Isolation sweep:** a table-driven test that lists every `/api/studio/*` route from the OpenAPI spec. Logged in as photographer A, a request that names B's booking, block, service, package, add-on, payment or note id gets **404** and leaves B's data unchanged. Any new studio route that isn't in the table fails the test.
- **T1.3** Concurrency: parallel claims for **different** photographers on the same time range both succeed. For the **same** photographer exactly one wins. A late webhook for A is not refused because B has an overlapping booking.
- **T1.4** Availability for A is unchanged by B's hours, blocks and bookings.
- **T1.5** The existing backend suite (about 1,625 tests) is ported and green.

---

## Phase 2: Accounts, roles and authentication
**Requirements**
- **R2.1** `app_user.role` is one of `platform_admin`, `photographer` or `client`.
  - JWT claims are `{sub, role, pwf}` (pwf is the existing password fingerprint). The studio middleware looks up the photographer row and checks it isn't disabled.
  - **Each role gets its own `aud`**, so a client token can't pass studio or platform checks even if a route is wired to the wrong middleware.
  - `requireRole('photographer' | 'platform_admin' | 'client')`.
  - Sessions last 8 hours for photographers and admins and 7 days for clients. All roles keep the bearer token in `sessionStorage`, which is why the CSP from Phase 0 matters.
- **R2.2** **Photographer signup:**
  - email, password, display name and handle
  - email verification (24-hour token, only its SHA-256 stored)
  - creates `photographer(status=pending)` and `photographer_setting`
  - a pending photographer can log in and set up their studio, but isn't listed or bookable
- **R2.3** **Client signup:** email and password with verification.
  - **Bookings are linked to an account only after its email is verified** (`marketplace-data-model.md` §2.8). Without this, signing up with someone else's email would show you their bookings.
  - A client's new bookings are linked when the booking email matches their verified email.
- **R2.4** **Google sign-in (clients only):**
  - Authorization code flow with PKCE, `state` and `nonce`; the code is exchanged on the server.
  - The `id_token` is checked for signature (Google JWKS), `iss`, `aud`, `exp` and `nonce`.
  - It requires `email_verified = true`. An existing client account with that email is linked; an account with that email in another role is refused.
  - **Amendment to `marketplace-data-model.md`:** `app_user.password_hash` becomes nullable, and `google_sub text` is added (partial unique), with CHECKs `google_sub IS NULL OR role = 'client'` and `password_hash IS NOT NULL OR google_sub IS NOT NULL`.
- **R2.5** Lockout, password reset and the fingerprint-based token revocation (`auth/admin-auth.ts`, `auth/token.ts`) are reused for every role. Signup, login and reset always return the same response, so they don't reveal which emails have accounts.
- **R2.6** Frontend:
  - the session knows its role
  - route guards for `/studio/*`, `/platform/*` and `/account/*`, each with its own login page
  - `adminFetch` is generalised to `apiFetch(role)`

**Test criteria**
- **T2.1** Role matrix: tokens for every role (and none) against one route from each family (public, account, studio, platform). Only the correct role gets 2xx; the rest get 401 or 403.
- **T2.2** Someone who signs up with a victim's email but **doesn't verify it** sees 0 bookings. After verifying, the bookings appear.
- **T2.3** Google, with a fake identity provider: a bad signature, `aud`, `nonce` or `state` is rejected. `email_verified=false` is rejected. An email that belongs to a photographer is not linked.
- **T2.4** Signup, reset and login for an existing versus a non-existent email give identical status and body.
- **T2.5** Changing the password revokes old tokens for every role, and a disabled user gets 401.

---

## Phase 3: Checkout and payments (MoMo and card)
**Requirements**
- **R3.1** The single `PAYMENT_PROVIDER` becomes `PAYMENT_METHODS_ENABLED` (`momo_mtn`, `momo_airtel`, `card`).
  - `/payment-methods` lists the enabled methods, and the client picks one at checkout.
  - Each method maps to a provider: MoMo to MTN direct or Flutterwave mobile money, card to `flutterwave_checkout`.
- **R3.2** **Card flow (hosted checkout):**
  1. Initiation creates the `payment` row first.
  2. It calls Flutterwave with `tx_ref = our_ref`, an amount computed **on the server**, currency `RWF`, and `redirect_url = WEB_ORIGIN + '/checkout/:reference/:token/payments/:ourRef'`, built on the server so it can't be used as an open redirect.
  3. It stores `checkout_url`. If a card payment is already in progress, it returns the same `checkout_url` instead of starting a second charge.
- **R3.3** **The return page trusts nothing in its query string** (`status=successful` and similar). It polls `GET /api/.../payments/:ourRef`. A payment counts as succeeded only through:
  - a verified webhook (constant-time check of the hash or HMAC over the raw body), or
  - the server calling Flutterwave to verify the transaction, matching `tx_ref`, **amount** and **currency** exactly.

  The existing protections stay as they are: store first, dedupe, forward-only status changes, `amount_mismatch` ignored.
- **R3.4** At **initiation and at the claim**, the photographer must be approved with a live subscription. Amounts always come from the booking snapshots (`bookingTotals()`), never from the client.
- **R3.5** Reconcile loops over every enabled provider (`payments/reconcile.ts`).
- **R3.6** The checkout and booking links keep their current design:
  - The checkout token is an HMAC of the reference with its own derived key (`payments/checkout-link.ts`), and the booking id never appears in a URL.
  - The access token is 256-bit, stored only as SHA-256, and rotated when resent.
  - `Referrer-Policy: no-referrer` keeps tokens in URL paths from leaking to the Flutterwave page or image hosts.

**Test criteria**
- **T3.1** With a fake provider: card initiation creates a payment and returns a checkout URL that points at Flutterwave. Initiating again while pending returns the **same** URL.
- **T3.2** Opening the return page with forged `?status=successful` leaves the payment `pending` and the booking `pending_payment`.
- **T3.3** A webhook with a bad signature gets `401` and changes nothing. A correct webhook with a mismatched amount or currency is ignored. A duplicate webhook does nothing.
- **T3.4** Initiation for a suspended or expired-subscription photographer is refused (`409`).
- **T3.5** Reconcile settles a card payment whose webhook never arrived.
- **T3.6** Manual Playwright run against the Flutterwave sandbox: card success, card decline and abandoned checkout (the hold expires).

---

## Phase 4: Payouts
**Requirements**
- **R4.1** `payout_method` is immutable: a change retires the old row and inserts a new one.
  - Changing it **requires the current password** and sends an `account_security_alert` email.
  - The platform's payout screen flags methods changed within the last 72 hours, because redirecting payouts is what an account takeover would aim for.
- **R4.2** `payout_item`:
  - an `earning` for every succeeded non-cash booking or session fee (amount = payment amount; no commission)
  - a `refund_due` payment voids its earning if it hasn't been paid out yet, or adds a `reversal` otherwise
- **R4.3** "Payable now" is calculated each time from the SQL in `marketplace-data-model.md` §3.9, not stored.
- **R4.4** Platform flow:
  1. "Payouts due" lists photographers with their balance and payout method.
  2. Build a draft: lock the items and total them. If the total is ≤ 0, no payout is created and the balance carries forward.
  3. Make the transfer outside the app.
  4. Mark it paid with the transfer reference (required, unique). That emails `payout_sent`.
- **R4.5** Studio "Earnings" page: pending, payable and paid, each line linked to its booking. The payout-method page and the catalogue price form both show the **transfer-fee banner**.
- **R4.6** Refunds are recorded on the platform's `/platform/refunds` page (the money is in your account). Recording a refund marks the payment `refunded` with a reference.

**Test criteria**
- **T4.1** A succeeded booking fee is payable immediately. A succeeded session fee becomes payable only after `ends_at`, and not if the booking was cancelled. A cash payment creates no item.
- **T4.2** A refund before payout voids the earning. A refund after payout creates a reversal, and the next payout nets it off.
- **T4.3** A second draft for the same photographer, marking paid without a reference, or a duplicate reference: each is refused.
- **T4.4** Photographer A can't read B's earnings or payout method (404). Changing the method without the password gets 403, and the security email is enqueued.

---

## Phase 5: Subscriptions
**Requirements**
- **R5.1** On approval, create the `subscription` and a **30-day trial** period. The trial length and the monthly and yearly prices live in `platform_setting` and are editable in `/platform/settings`.
- **R5.2** On `/studio/subscription` the photographer picks monthly or yearly and pays by MoMo or card. This reuses the Phase 3 payment flow (`payment.kind = 'subscription'`, amount taken from `platform_setting` on the server). Only one payment can be in progress per subscription.
- **R5.3** A successful payment adds a period starting at `greatest(now, current_period_ends_at)`, so paying early adds time on top. Then a `subscription_receipt` email goes out.
- **R5.4** A cron job (reusing the node-cron setup) does two things:
  - sends reminders 7, 3 and 1 days before the end, deduplicated by key
  - moves the status to `past_due` at the end and to `expired` after the 7-day grace period

  Whether a photographer can be booked is checked against `current_period_ends_at > now()` directly, so it's correct even if the job runs late.
- **R5.5** Effects of each status:
  - `past_due`: still in the directory with a "not taking bookings" notice.
  - `expired`: hidden from the directory, and the profile page says "unavailable".
  - In every status, existing bookings, session fees and deliveries carry on.

**Test criteria**
- **T5.1** With an injected clock: trial at day 0, reminders at days 23, 27 and 29, `past_due` at day 30, `expired` at day 37, each status checked.
- **T5.2** Paying on day 25 of the trial adds the period on top: it ends at day 30 plus 1 month.
- **T5.3** A forged amount from the client is ignored and the server price is charged. Two parallel subscription initiations produce one payment.
- **T5.4** A `past_due` photographer: `POST /bookings` gets `409`, but an existing booking's session fee is still payable.

---

## Phase 6: Public marketplace
**Requirements**
- **R6.1** `GET /api/photographers?category&district&min&max&date&page`:
  - Uses the SQL in `marketplace-data-model.md` §3.12. Only approved photographers with a trialing or active subscription appear.
  - The **date** filter first narrows candidates in SQL, then runs the availability engine on the current page only, checking for at least one slot for the photographer's shortest package.
  - Page size is 24. Sorted by cheapest price, then name.
- **R6.2** `GET /api/photographers/:handle`: the profile, districts, categories, portfolio URLs (up to 24), active services with their "from" price, the cancellation policy in plain words, and contact details.
- **R6.3** Pages:
  - landing
  - directory: filter bar, URL-synced query, empty state, mobile layout
  - profile
  - service page under the handle
- **R6.4** Remove the hardcoded studio details: `frontend/src/lib/contact.ts` `PHOTOGRAPHER_CONTACT` and the landing copy become profile data. Branding becomes marketplace branding. `en.json` changes are additive only, never edits to existing strings.
- **R6.5** All profile text is rendered as plain text (no HTML or markdown). Image URLs are `https://` only, rendered with `referrerpolicy="no-referrer"`. External links get `rel="noopener noreferrer"`.
- **R6.6** SEO for a client-rendered app: per-route `<title>` and meta tags, plus a `sitemap.xml` endpoint listing bookable profiles. Server rendering is deferred.

**Test criteria**
- **T6.1** Backend: every filter alone and in combination against seeded photographers. Pending, suspended and expired photographers never appear. The date filter agrees with the engine (a photographer fully booked on that date is excluded).
- **T6.2** Playwright: filter by district and category, open a profile, open a service, book A at 10:00; B's 10:00 slot is still offered.
- **T6.3** The directory API answers in under 300 ms (p95) with 200 seeded photographers locally.
- **T6.4** A bio containing `<script>` displays as literal text.

---

## Phase 7: Photographer studio and onboarding
**Requirements**
- **R7.1** The existing Calendar, Bookings, Catalogue, Availability and Settings pages move to `/studio`, scoped to the photographer. Settings now includes the cancellation policy fields (R1.8). Hold time moves to the platform.
- **R7.2** New pages: Profile (handle is read-only after approval; bio, contact, districts, categories, cover URL), Portfolio (URL list, reordering, captions), Earnings, Payout method, Subscription.
- **R7.3** `/studio/setup` checklist: profile, at least one category, at least one district, payout method, at least one service with a package, working hours. **Submitting for review** is enabled once every item is done.
- **R7.4** Banners for: pending approval, suspended (with the reason), trial ending, past due.

**Test criteria**
- **T7.1** Submitting before the checklist is complete returns `422`, with the missing items listed.
- **T7.2** Playwright: sign up, verify email, finish setup, submit. The platform admin approves. The photographer appears in the directory and gets the trial.
- **T7.3** Every Vitest unit test for the existing admin pages passes under `/studio`.

---

## Phase 8: Client dashboard (`/account`)
**Requirements**
- **R8.1** **Bookings:** upcoming and past bookings across photographers, through `client.user_id` linking.
  - Each shows the photographer, service, date, status and amounts.
  - The detail page reuses the BookingPage components (pay the session fee, cancel under that photographer's policy, open the delivery link, contact the photographer), **authorised by the session** instead of a token.
- **R8.2** **Payments and receipts:** every payment (kind, method, amount, status, reference, date) and a printable receipt page using the browser's print stylesheet (no PDF library). Refunds are shown.
- **R8.3** **Profile and privacy:**
  - edit name and phone
  - change email (re-verified at the new address, with a notice to the old one)
  - change password (password accounts only)
  - **export my data** as JSON: account, bookings, payments
  - **delete account**: anonymise the `app_user` and clear `client.user_id`. Booking snapshots stay for the photographer's records (Rwanda data protection law no. 058/2021).
- **R8.4** Guest bookings made later with the verified email appear in the dashboard automatically.

**Test criteria**
- **T8.1** Client X can't open client Y's booking or receipt through `/api/account/*` (404).
- **T8.2** Cancelling from the dashboard follows the photographer's cut-off and refund setting (both branches tested).
- **T8.3** After deleting the account, login fails, the export returns 401, the photographer still sees the booking snapshot, and the `client` row has no `user_id`.
- **T8.4** The export contains exactly the user's own records.

---

## Phase 9: Platform admin console (`/platform`)
**Requirements**
- **R9.1** Photographers: list and filter by status. Approve (starts the trial and sends `photographer_approved`). Suspend with a reason (hides the profile, blocks new bookings, keeps existing ones). Reactivate.
- **R9.2** Categories: create, rename, reorder and deactivate. A category that's in use can't be deleted.
- **R9.3** Payouts (Phase 4), Refunds, Subscriptions (status and history) and Platform settings (hold time, trial, prices, grace, reminder days).
- **R9.4** Every platform action records who did it and when: `approved_by_user_id`, `paid_by_user_id`, `created_by_user_id`, plus an entry in the structured log.

**Test criteria**
- **T9.1** Every platform route refuses photographer and client tokens.
- **T9.2** Suspending removes the photographer from the directory, refuses a new booking, and leaves an existing booking's session-fee payment working.

---

## Phase 10: Documentation and launch checks
- Update `docs-site/` (guides for clients and photographers, plus a new platform guide) and the OpenAPI spec (the parity test enforces it).
- Rerun the security review over the marketplace: tenant separation, payouts, Google sign-in, card checkout.
- Set the real subscription prices, confirm `btree_gist` is available on Neon, and switch on GitHub secret scanning and Dependabot.

---

## Security: summary across all phases
| Area | Controls |
|---|---|
| Data separation between photographers | The photographer id comes from the token only. Composite FKs in the database. Lookups that return 404 (not 403). An isolation sweep over every studio route (T1.2). Photographers see snapshots only, never the shared client row. |
| Auth | Argon2id, lockout, fingerprint revocation, a separate `aud` per role, and identical responses that don't reveal whether an email has an account. Bookings link to an account only after its email is verified. Google: PKCE, state and nonce, a fully validated `id_token`, and `email_verified` required. |
| Checkout and payments | Amounts computed on the server. Hosted card page, so no card data touches our server. The return URL is never trusted. Webhooks are verified with a constant-time HMAC over the raw body, stored first, deduplicated and forward-only, with amount and currency matched. Reconcile is the fallback. The redirect URL is built on the server. One payment in progress at a time. Bookability is re-checked at initiation and at the claim. |
| Links and tokens | 256-bit access tokens stored only as SHA-256 and rotated when resent. Checkout tokens are HMACs with keys derived per purpose. No ids in URLs. `Referrer-Policy: no-referrer`. Email-change and verification actions are `POST`s, so an email scanner opening the link can't trigger them. |
| Abuse | Per-IP and per-email limits with `429`, a cap of 3 live holds per email, and a `trust proxy` setting that matches the real hosting. |
| Browser | A strict CSP (no inline script, `frame-ancestors 'none'`), `nosniff`, HSTS. Pasted URLs limited to `https:` by DB CHECK and zod, and checked again at render. User text rendered as plain text only. |
| Money out | Changing the payout method requires the password and sends an alert, and recent changes are flagged. Unique transfer references. Who did what is recorded on every payout. |
| Public repo | `gitleaks` in CI, only `.env.example` tracked, Dependabot and secret scanning switched on. |

## Overall verification
1. **Every phase:** `npm test` in `backend/` (Vitest against local Postgres), and `npm run lint && npm test && npm run build` in `frontend/`. CI runs both on every push.
2. **Playwright end-to-end flows** in `frontend/e2e/`:
   - photographer: sign up → setup → approval → listed
   - client: directory → book → MoMo payment (fake provider) → dashboard
   - card payment through the Flutterwave sandbox (manual or opt-in)
   - platform admin: build a payout → mark paid → the photographer's Earnings page updates
3. **Manual pass:** run the backend and frontend locally with the demo seed (3 photographers), then click through every client, photographer and platform-admin flow at phone and desktop widths.

---

