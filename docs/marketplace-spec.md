# Bookly Marketplace: specification

Bookly started as a booking site for a single photographer (`docs/specs_v2.md`). This specification turns it into a **marketplace**:
- Many photographers subscribe, list their services and manage their own bookings.
- Clients browse a public directory, book any photographer, and can optionally hold an account.

Where this document and `docs/specs_v2.md` disagree, this document wins. In particular it replaces §2.1 (one admin), §4.2 (multiple photographers out of scope) and §6.10–6.11 (cancellation rules, which are now set by each photographer).

The data model changes are in [`docs/marketplace-data-model.md`](marketplace-data-model.md). Requirement ids (`R1.2`, `T3.4`, …) are referenced from code comments and tests.

## Product decisions
| Topic | Decision |
|---|---|
| Money in | Clients pay into the **platform's** MoMo or Flutterwave account. They choose MoMo (MTN or Airtel) or **card** (Flutterwave hosted checkout) at checkout. **Card is deferred (user decision, 2026-10-17; Phase 3):** MoMo only until then. |
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
| Platform admin | `/platform/login`, `/platform/reset-password`, `/platform/photographers` (+ `/:id`), `/platform/payouts` (+ `/:id`), `/platform/subscriptions`, `/platform/categories`, `/platform/settings`, `/platform/refunds` |

The API follows the same shape: `/api/...` for public, `/api/account/*`, `/api/studio/*` and `/api/platform/*`. Each signed-in area has its own `/api/{studio,platform,account}/auth/*` (login, password reset). The studio API was `/api/admin/*` until Phase 2, which renamed it with no alias. Reserved handles (`admin`, `api`, `p`, `studio`, `platform`, `account`, `photographers`, …) are refused at signup.

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
- **R2.5** Lockout, password reset and the fingerprint-based token revocation (`auth/account-auth.ts`, `auth/token.ts`) are reused for every role. Signup, login and reset always return the same response, so they don't reveal which emails have accounts.
- **R2.1a** Tokens and revocation, as built (decided 2026-10-17):
  - Audiences `bookly-studio`, `bookly-platform`, `bookly-account` (the Phase 1 `bookly-admin` is retired); TTL 8 h, 8 h and 7 days. A token for one area is a `401 invalid_token` in every other.
  - The fingerprint claim is `cred_fp`: an HMAC under `SESSION_SECRET` of `password_hash`, `google_sub` and a new `app_user.token_version int NOT NULL DEFAULT 0` (migration `20261017095220_app_user_token_version`; **amendment to `marketplace-data-model.md` §2.1**). A password change, linking a Google identity, or `revokeTokens` (adds 1 to `token_version`) revokes every token the user holds. `revokeTokens` is the revocation of a Google-only client, who has no password to change.
  - Middleware: `requirePhotographer` (studio), `requirePlatformAdmin`, `requireClient`. Each re-reads the user on every request and requires the area's role, `disabled_at` and `anonymized_at` null, a verified email, the fingerprint to match, and for the studio a photographer row.
  - Each area's login admits only its role. Any other account, a disabled or erased one, and a Google-only client at a password login are answered exactly like an unknown email (dummy Argon2, no attempt counted, no email). An **unverified** address with the right password is answered exactly like a wrong password (the attempt counts toward the lockout); the lockout alert goes only to a verified address. The alert's sign-in button and the reset link point to the area's own page (`/studio/…`, `/platform/…`, `/account/…`). A reset token works only in the area it was issued for.
  - Login and `/me` answer the public user under `user` (Phase 1 used `admin`); the studio's `/me` adds `photographer { id, handle, displayName, status }` for the pending or suspended banner.
- **R2.1b** Platform admin, minimal (pulled forward from R9.1, decided 2026-10-17): `POST /api/platform/auth/login` and reset, `GET /api/platform/me`, `GET /api/platform/photographers?status=`, and `POST /api/platform/photographers/:id/{approve,suspend,reactivate}`.
  - approve: `pending` → `approved`, sets `approved_at` and `approved_by_user_id`, emails `photographer_approved`. A suspended photographer is a `409 invalid_transition` (reactivate instead).
  - suspend `{ reason }`: `pending` or `approved` → `suspended`, sets `suspended_at` and `suspension_reason`, emails `photographer_suspended`. Existing bookings are kept.
  - reactivate: `suspended` → `approved` (or `pending` if never approved), clearing `suspended_at` and `suspension_reason`. No email.
  - Each is one `UPDATE … WHERE status IN (…)`, so racing calls make the change once; a repeat is a `200` that changes nothing and sends nothing. Every change is also a structured log line naming who and when (R9.4).
- **R2.1c** Signup, email verification and the pre-registration hijack, as built (decided 2026-10-17):
  - **Signup.** `POST /api/studio/auth/signup` `{ email, password, displayName, handle }` and `POST /api/account/auth/signup` `{ email, password, fullName }` answer `202 { ok: true }` whether or not the address is taken. The only other answers are the 400/422 of a malformed body and, for the studio, `409 handle_taken` for a taken or reserved handle, decided before the address is looked at. The photographer's login, `photographer(status=pending)` and `photographer_setting` are one transaction, which also enqueues the verification link and one `photographer_application_received` per platform admin (filed under no photographer, so a delivery failure alerts the platform). Passwords are 12 to 1024 characters; addresses are stored trimmed and lowercased.
  - **Verification.** `POST /api/{area}/auth/verify` `{ token, password }` and `POST /api/{area}/auth/verify/resend` `{ email }` in every area. The `account_verify_email` link is `/{area}/verify/<token>`: a 256-bit token, stored as its SHA-256 (`email_verify_token_hash`), 24 hours, single-use, the newest replacing any earlier one. Opening the link changes nothing; the page posts it.
  - **(a) Verification proves the inbox AND the password.** The POST needs the token and the account's password; either wrong is one `400 invalid_verification`, a wrong password counts toward the lockout (the login's atomic attempt claim), and every refusal costs one Argon2 check. Without the password, someone who signed up with another person's address and a password of their own would get a verified account the moment the owner clicked the link. A successful verification also signs the caller in (the login's response) and, for a client, links the bookings.
  - **(b) A completed password reset verifies the address.** The reset link proves the inbox and replaces the password, so `confirmPasswordReset` sets `email_verified_at` when it is null, voids any pending verification link, links a client's bookings, and (by changing `password_hash`) revokes every token. This is the real owner's way in to a pre-registered account: "Forgot password". The verification email says so to anyone asked for a password they never chose.
  - **(c) Signing up again never changes a stored account.** An existing unverified login of the same area gets a fresh verification link and keeps its password, name and studio. A verified account of any area gets an `account_security_alert` of variant `account_exists` (button to its own area's sign-in page; at most one per account per hour). Anything else (an unverified login of another area, a disabled or erased one) gets nothing.
  - **Google and the hijack.** Linking Google to an existing client whose address was never verified also discards its password and pending reset link: Google proved the inbox, nobody proved the password.
  - **Linking (§2.8).** `UPDATE client SET user_id … WHERE lower(email) = lower($1) AND user_id IS NULL AND anonymized_at IS NULL` runs on verification, on a reset that verifies and on every Google sign-in. `upsertClient` sets `user_id` for a new client row from a verified, unerased client login with that address, and keeps an existing link (`COALESCE`). Never at signup.
  - **Google sign-in**, `/api/account/auth/{providers,google/start,google/callback}`: `providers` is `{ google }`; `start` answers `{ authorizationUrl, state }` and stores an `oauth_flow` row (state as SHA-256, PKCE verifier, nonce, 10 minutes; `marketplace-data-model.md` §3.14); `callback` `{ code, state }` consumes the flow in one UPDATE, exchanges the code, verifies the id_token (RS256 only, `iss`, `aud`, `exp`, `nonce`) and requires `email_verified === true`. Errors: `400 invalid_state`, `400 google_sign_in_failed` (refused code or identity, or a disabled or erased account), `400 google_email_unverified`, `409 account_conflict` (another role's address, or a client already linked to another Google subject). Without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` the two POSTs answer 404.
  - **`GET /api/account/me`** answers `{ user: { id, email, lastLoginAt, fullName } }`.
  - **Rate limits** per IP and area: signup 5/hour, verify 10/hour, resend 5/hour, Google start and callback 20 per 15 minutes each.
- **R2.6** Frontend:
  - the session knows its role
  - route guards for `/studio/*`, `/platform/*` and `/account/*`, each with its own login page
  - `adminFetch` is generalised to `apiFetch(role)`

**Test criteria**
- **T2.1** Role matrix: tokens for every role (and none) against one route from each family (public, account, studio, platform). Only the correct role gets 2xx; the rest get 401 or 403.
- **T2.2** Someone who signs up with a victim's email but **doesn't verify it** sees 0 bookings. After verifying, the bookings appear.
- **T2.3** Google, with a fake identity provider: a bad signature, `aud`, `nonce` or `state` is rejected. `email_verified=false` is rejected. An email that belongs to a photographer is not linked. As built, also: wrong `iss`, an expired id_token, an expired or reused state, an HS256 or unsigned token; an existing client is linked, a new one is created, a returning user is found by `google_sub`.
- **T2.3a** The pre-registration hijack (R2.1c): someone who signs up with a victim's address cannot sign in, cannot verify without the inbox, is not verified when the victim clicks the link, and after the victim's password reset their password no longer works.
- **T2.4** Signup, reset and login for an existing versus a non-existent email give identical status and body.
- **T2.5** Changing the password revokes old tokens for every role, and a disabled user gets 401. So does `revokeTokens`, for every role including a Google-only client.

---

## Phase 3: Checkout and payments (MoMo and card)
> **Card payments are deferred (user decision, 2026-10-17).** Phase 3 is choosing a payment method, routing it to a provider, and payment safety. R3.2, R3.3, T3.1, T3.2 and T3.6 are deferred with cards, and so are `flutterwave_checkout` and `payment.checkout_url` (`marketplace-data-model.md` §2.11-§2.12). They stay below, marked, so the card work can pick them up as written.

**Requirements**
- **R3.1** The single `PAYMENT_PROVIDER` becomes method routing (decided 2026-10-17; `payments/routing.ts`).
  - `/payment-methods` lists the methods on offer, and the client picks one at checkout. The answer is `{ methods }`: no provider is named any more, because there is no single one.
  - Each method maps to a provider, and the provider of a payment always comes from the method the client chose, never from a deployment-wide default:

    | Method | Provider |
    |---|---|
    | `momo_mtn` | `MOMO_MTN_PROVIDER`: `mtn_momo_direct` (the default) or `flutterwave` |
    | `momo_airtel` | always `flutterwave` (MTN direct collects MTN MoMo only) |
    | `card` | `flutterwave_checkout`: **deferred** with R3.2. Refused in configuration and never offered. |

  - **`MOMO_MTN_PROVIDER`** = `mtn_momo_direct | flutterwave`, default `mtn_momo_direct`.
  - **`PAYMENT_METHODS_ENABLED`** (optional): a comma list from `momo_mtn,momo_airtel` that narrows what is offered; unset, every method is a candidate. `card`, an unknown name or an empty list is a startup error. Spaces and repeats are forgiven; the pay page order is always `momo_mtn`, `momo_airtel`.
  - **A method is offered only if its routed provider is configured** (MTN direct: `MTN_MOMO_SUBSCRIPTION_KEY`, `MTN_MOMO_API_USER`, `MTN_MOMO_API_KEY`; Flutterwave: `FLUTTERWAVE_CLIENT_ID`, `FLUTTERWAVE_CLIENT_SECRET`). An unconfigured provider is never offered, so with no credentials the list is empty and the pay page says online payment is unavailable. A method that is not offered is a `422` at both pay routes.
  - Startup checks (`env.ts`), production only: half a provider's credentials is an error; every method listed in `PAYMENT_METHODS_ENABLED` must be collectable; unset, at least one method must be on offer; and while Flutterwave collects any method, `FLUTTERWAVE_WEBHOOK_HASH` is required.
  - `PAYMENT_PROVIDER` is retired. `PAYMENT_PROVIDER=mtn_momo_direct`, which means exactly the new default, is tolerated and ignored so an old `.env` keeps working; any other value is a startup error, so a deployment still saying `flutterwave` cannot silently start sending MTN MoMo to MTN direct.
  - **Every provider with payments in flight still settles.** MTN direct stays constructed whatever the routing (its webhook route stays mounted), and Flutterwave whenever it collects a method or is configured. Switching `MOMO_MTN_PROVIDER` back is a one-variable rollback.
  - **The photographer's session-fee request** (`POST /api/studio/bookings/:id/session-fee`) is recorded against the provider of the first method on offer, because the photographer cannot know how the client will pay; with nothing on offer the route is absent. When the client pays, an ask nobody has attempted yet (no `method` on it) moves to the provider the client's method routes to, keeping its `our_ref` and frozen amount. A row that has been attempted never moves: only the provider it went to may settle it, so a new row opens instead. The chosen method is written on the row with the attempt, which also stamps `updated_at`: for 30 seconds from the client's attempt on an ask (the provider call's deadline), a second tap under any method, a new request and a cash record all answer `in_progress`, so two providers are never prompted for the same fee.
- **R3.2** **Card flow (hosted checkout):** **Deferred with cards (user decision, 2026-10-17).**
  1. Initiation creates the `payment` row first.
  2. It calls Flutterwave with `tx_ref = our_ref`, an amount computed **on the server**, currency `RWF`, and `redirect_url = WEB_ORIGIN + '/checkout/:reference/:token/payments/:ourRef'`, built on the server so it can't be used as an open redirect.
  3. It stores `checkout_url`. If a card payment is already in progress, it returns the same `checkout_url` instead of starting a second charge.
- **R3.3** **The return page trusts nothing in its query string** (`status=successful` and similar). **Deferred with cards (2026-10-17).** It polls `GET /api/.../payments/:ourRef`. A payment counts as succeeded only through:
  - a verified webhook (constant-time check of the hash or HMAC over the raw body), or
  - the server calling Flutterwave to verify the transaction, matching `tx_ref`, **amount** and **currency** exactly.

  The existing protections stay as they are: store first, dedupe, forward-only status changes, `amount_mismatch` ignored. (The MoMo webhook rules of T3.3, the currency check included, are built now.)
- **R3.4** At **initiation and at the claim**, the photographer must be approved with a live subscription. Amounts always come from the booking snapshots (`bookingTotals()`), never from the client.
  - As built (2026-10-17): the booking-fee checkout re-checks bookability (`photographers/bookable.ts`) inside its transaction, after `already_paid` and `hold_expired`. An unbookable photographer is `409 photographer_unavailable`: no payment row, no prompt, the booking untouched, payable again on reactivation. The code names no status, so suspended, pending and (from Phase 5) out of subscription look the same from outside. An attempt started before a suspension still settles through its webhook.
  - **Session fees stay payable.** R5.5 and T9.2 say existing bookings carry on, so the client's session fee for a confirmed or completed booking is **not** refused when the photographer has since been suspended (or is pending again), and neither is the photographer's own request. Only new booking-fee payments are refused.
  - Any amount, provider, status or reference in a pay request body is ignored: the booking fee is the booking's frozen `booking_fee_rwf`, the session fee what `bookingTotals()` leaves outstanding (or the frozen ask).
- **R3.5** Reconcile loops over every configured provider (`payments/reconcile.ts` `reconcilerPlans`, started by `server.ts`): one status-lookup job per configured provider in the deployment, including one no method routes to any more, so its waiting payments still settle. An unconfigured provider has nothing to ask with and gets none; the MTN sandbox's runs every 5 seconds.
- **R3.6** The checkout and booking links keep their current design:
  - The checkout token is an HMAC of the reference with its own derived key (`payments/checkout-link.ts`), and the booking id never appears in a URL.
  - The access token is 256-bit, stored only as SHA-256, and rotated when resent.
  - `Referrer-Policy: no-referrer` keeps tokens in URL paths from leaking to the Flutterwave page or image hosts.

**Test criteria**
- **T3.1** With a fake provider: card initiation creates a payment and returns a checkout URL that points at Flutterwave. Initiating again while pending returns the **same** URL. **Deferred with cards (2026-10-17).**
- **T3.2** Opening the return page with forged `?status=successful` leaves the payment `pending` and the booking `pending_payment`. **Deferred with cards (2026-10-17).**
- **T3.3** A webhook with a bad signature gets `401` and changes nothing. A correct webhook with a mismatched amount or currency is ignored. A duplicate webhook does nothing.
  - As built: the unverified delivery is still stored (`signature_valid = false`, under an id of its own) and the body is `{ error: 'invalid_signature' }`; for MTN, whose callback URL is its signature, a body that is not about the payment the URL signs is refused the same way. A correct delivery that is applied or ignored is `200 { received: true }`. A success whose `currency` differs from the one the provider charges (`RWF`; `EUR` in MTN's sandbox) is ignored as `currency_mismatch`, as a wrong amount is `amount_mismatch`; a body naming no currency is accepted, as one naming no amount is. The status lookup applies the same rule.
- **T3.4** Initiation for a suspended or expired-subscription photographer is refused (`409`). (The subscription half arrives with Phase 5, through `bookable.ts`.)
- **T3.5** Reconcile settles a payment whose webhook never arrived, for every configured provider. (The card case is deferred with cards.)
- **T3.6** Manual Playwright run against the Flutterwave sandbox: card success, card decline and abandoned checkout (the hold expires). **Deferred with cards (2026-10-17).**

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

