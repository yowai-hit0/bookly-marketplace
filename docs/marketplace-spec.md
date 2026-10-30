# Bookly Marketplace: specification

Bookly started as a booking site for a single photographer (`docs/specs_v2.md`). This specification turns it into a **marketplace**:
- Many photographers subscribe, list their services and manage their own bookings.
- Clients browse a public directory, book any photographer, and can optionally hold an account.

Where this document and `docs/specs_v2.md` disagree, this document wins. In particular it replaces §2.1 (one admin), §4.2 (multiple photographers out of scope) and §6.10–6.11 (cancellation rules, which are now set by each photographer).

The data model changes are in [`docs/marketplace-data-model.md`](marketplace-data-model.md). Requirement ids (`R1.2`, `T3.4`, …) are referenced from code comments and tests.

## Product decisions
| Topic | Decision |
|---|---|
| Money in | Clients pay into the **platform's** MoMo or Flutterwave account. They choose MoMo (MTN or Airtel) or **card** at checkout. **Cards (user decisions, 2026-10-30; Phase 3 "Cards as built"):** Flutterwave **v3 Inline** (the Flutterwave modal on our own pay page), for the booking fee, the session fee and the photographer's subscription; the platform absorbs the card fee; card refunds are made by hand in the Flutterwave dashboard and recorded on `/platform/refunds`. |
| Money out | Each photographer saves one payout destination: MoMo (network, number, account name) or bank (bank, account number, account name). The platform transfers their share **by hand**. **No commission.** A banner says transfer fees are deducted from what they receive, so they should price accordingly. **Refunds (Phase 4):** a platform admin records the refund of money paid online; the photographer records the refund of cash he collected. |
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
> **Cards are built (user decisions, 2026-10-30).** Deferred on 2026-10-17, they are now Flutterwave **v3 Inline** under the provider id `flutterwave_checkout` (`marketplace-data-model.md` §2.11-§2.12; `payment.checkout_url` is not needed and not built). R3.2 and R3.3 below are as amended for Inline; the design, the decisions and what the sandbox must confirm are in **"Cards as built"** at the end of this phase.

**Requirements**
- **R3.1** The single `PAYMENT_PROVIDER` becomes method routing (decided 2026-10-17; `payments/routing.ts`).
  - `/payment-methods` lists the methods on offer, and the client picks one at checkout. The answer is `{ methods }`: no provider is named any more, because there is no single one.
  - Each method maps to a provider, and the provider of a payment always comes from the method the client chose, never from a deployment-wide default:

    | Method | Provider |
    |---|---|
    | `momo_mtn` | `MOMO_MTN_PROVIDER`: `mtn_momo_direct` (the default) or `flutterwave` |
    | `momo_airtel` | always `flutterwave` (MTN direct collects MTN MoMo only) |
    | `card` | always `flutterwave_checkout` (Flutterwave v3 Inline, 2026-10-30) |

  - **`MOMO_MTN_PROVIDER`** = `mtn_momo_direct | flutterwave`, default `mtn_momo_direct`.
  - **`PAYMENT_METHODS_ENABLED`** (optional): a comma list from `momo_mtn,momo_airtel,card` that narrows what is offered; unset, every method is a candidate. An unknown name or an empty list is a startup error, and so is `card` listed without the three Flutterwave v3 keys (in every environment). Spaces and repeats are forgiven; the pay page order is always `momo_mtn`, `momo_airtel`, `card`.
  - **A method is offered only if its routed provider is configured** (MTN direct: `MTN_MOMO_SUBSCRIPTION_KEY`, `MTN_MOMO_API_USER`, `MTN_MOMO_API_KEY`; Flutterwave: `FLUTTERWAVE_CLIENT_ID`, `FLUTTERWAVE_CLIENT_SECRET`; cards: `FLUTTERWAVE_V3_SECRET_KEY`, `FLUTTERWAVE_V3_PUBLIC_KEY`, `FLUTTERWAVE_V3_WEBHOOK_HASH`, all three or none in every environment). An unconfigured provider is never offered, so with no credentials the list is empty and the pay page says online payment is unavailable. A method that is not offered is a `422` at both pay routes.
  - Startup checks (`env.ts`), production only: half a provider's credentials is an error; every method listed in `PAYMENT_METHODS_ENABLED` must be collectable; unset, at least one method must be on offer; and while Flutterwave collects any method, `FLUTTERWAVE_WEBHOOK_HASH` is required.
  - `PAYMENT_PROVIDER` is retired. `PAYMENT_PROVIDER=mtn_momo_direct`, which means exactly the new default, is tolerated and ignored so an old `.env` keeps working; any other value is a startup error, so a deployment still saying `flutterwave` cannot silently start sending MTN MoMo to MTN direct.
  - **Every provider with payments in flight still settles.** MTN direct stays constructed whatever the routing (its webhook route stays mounted), and Flutterwave whenever it collects a method or is configured. Switching `MOMO_MTN_PROVIDER` back is a one-variable rollback.
  - **The photographer's session-fee request** (`POST /api/studio/bookings/:id/session-fee`) is recorded against the provider of the first method on offer, because the photographer cannot know how the client will pay; with nothing on offer the route is absent. When the client pays, an ask nobody has attempted yet (no `method` on it) moves to the provider the client's method routes to, keeping its `our_ref` and frozen amount. A row that has been attempted never moves: only the provider it went to may settle it, so a new row opens instead. The chosen method is written on the row with the attempt, which also stamps `updated_at`: for 30 seconds from the client's attempt on an ask (the provider call's deadline), a second tap under any method, a new request and a cash record all answer `in_progress`, so two providers are never prompted for the same fee.
- **R3.2** **Card flow (Flutterwave v3 Inline; amended 2026-10-30 from the hosted checkout):**
  1. Initiation creates the `payment` row first.
  2. It calls nothing: Inline is opened in the browser. It answers the **Inline config, built on the server**: the public key, `tx_ref = our_ref`, the row's amount (computed **on the server**), currency `RWF`, `payment_options: card`, the payer, and a `redirect_url` on WEB_ORIGIN built on the server so it can't be used as an open redirect (Inline may redirect for 3-D Secure).
  3. No `checkout_url` is stored: there is no hosted page. If a card payment is already in progress, initiation answers the same `ourRef` and config instead of starting a second charge.
- **R3.3** **The return page trusts nothing in its query string** (`status=successful` and similar). It polls `GET /api/.../payments/:ourRef`. A payment counts as succeeded only through:
  - a verified webhook (constant-time check of the hash or HMAC over the raw body; for cards, whose `verif-hash` is a static secret, the webhook is re-verified through the API, below), or
  - the server calling Flutterwave to verify the transaction, matching `tx_ref`, **amount** and **currency** exactly.

  The existing protections stay as they are: store first, dedupe, forward-only status changes, `amount_mismatch` ignored. (Phase 4 makes one exception: a verified success revives a payment we failed ourselves without a provider verdict; see Phase 4 "as built".) (The MoMo webhook rules of T3.3, the currency check included, are built now.)
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
- **T3.1** With a fake provider: card initiation creates a payment and returns the Inline config (amended 2026-10-30 from "a checkout URL"). Initiating again while pending returns the **same** `ourRef` and config. As built: `routes/card-payments.test.ts`.
- **T3.2** Opening the return page with forged `?status=successful` leaves the payment `pending` and the booking `pending_payment`. As built: `routes/card-payments.test.ts`.
- **T3.3** A webhook with a bad signature gets `401` and changes nothing. A correct webhook with a mismatched amount or currency is ignored. A duplicate webhook does nothing.
  - As built: the unverified delivery is still stored (`signature_valid = false`, under an id of its own) and the body is `{ error: 'invalid_signature' }`; for MTN, whose callback URL is its signature, a body that is not about the payment the URL signs is refused the same way. A correct delivery that is applied or ignored is `200 { received: true }`. A success whose `currency` differs from the one the provider charges (`RWF`; `EUR` in MTN's sandbox) is ignored as `currency_mismatch`, as a wrong amount is `amount_mismatch`; a body naming no currency is accepted, as one naming no amount is. The status lookup applies the same rule.
- **T3.4** Initiation for a suspended or expired-subscription photographer is refused (`409`). (The subscription half arrives with Phase 5, through `bookable.ts`.)
- **T3.5** Reconcile settles a payment whose webhook never arrived, for every configured provider, cards included (`routes/card-payments.test.ts`).
- **T3.6** Manual Playwright run against the Flutterwave sandbox: card success, card decline and abandoned checkout (the hold expires), with the assumptions listed under "Cards as built" confirmed. Manual; still to run (Stage 2).

**Cards as built (user decisions, 2026-10-30; Stage 1, backend)**

*Decisions.* (1) Flutterwave **v3 Inline**, not the hosted redirect and not v4 direct charge (v4 cards would have us collect and encrypt card numbers: PCI DSS SAQ D). The public key `FLWPUBK…` goes to the browser, the secret key `FLWSECK…` stays on the server, the webhook's secret hash arrives in `verif-hash`, the API is `https://api.flutterwave.com/v3`, and test or live is the keys' business. (2) Cards pay the booking fee, the session fee (guest checkout, guest booking page, account dashboard) and the photographer's subscription (R5.2). (3) **The platform absorbs card fees**: the client pays the listed amount, the photographer earns the full amount as with MoMo, and verification matches the `amount` we asked for exactly. (4) **Card refunds stay manual**: the platform admin refunds in the Flutterwave dashboard and records it on `/platform/refunds`; no refund API is called.

*Configuration* (`env.ts`). `FLUTTERWAVE_V3_SECRET_KEY`, `FLUTTERWAVE_V3_PUBLIC_KEY`, `FLUTTERWAVE_V3_WEBHOOK_HASH` (all three or none, a startup error otherwise, in every environment), `FLUTTERWAVE_V3_BASE_URL` (default `https://api.flutterwave.com`). The keys are checked for shape: the secret must start `FLWSECK`, the public `FLWPUBK` (a secret pasted into the public slot would be published to every payer; the message never echoes it), and both must be test keys or both live. `card` is offered, last, whenever the keys are set; listing it in `PAYMENT_METHODS_ENABLED` without them is a startup error. The card provider is constructed (webhook route mounted, reconciler running) whenever its keys are set, card enabled or not, so card payments in flight still settle. `routePayments` offers `card` only through a provider that has a browser checkout.

*The adapter* (`payments/flutterwave-checkout.ts`, provider `flutterwave_checkout`, currency RWF). `initiate` calls nothing and accepts only `card`. `browserCheckout` builds the Inline config (`public_key`, `tx_ref`, `amount`, `currency`, `payment_options: card`, `redirect_url`, `customer { email, name, phone_number? }`, `customizations { title }`, `configurations { session_duration }`). Lookups: `GET /v3/transactions/verify_by_reference?tx_ref=` (the reconciler, the poll) and `GET /v3/transactions/:id/verify` (the webhook, the poll's hint), bearer the secret key. A success needs `status: successful`, an exact `tx_ref`, a stated `amount` equal to the row's and currency RWF; a success stating no amount or no currency is no success at all; a stated wrong amount or currency is ignored as `amount_mismatch`/`currency_mismatch`, as for MoMo. `provider_ref` is `FLW-<transaction id>` (the prefix keeps it from colliding with MTN's numeric ids under the global `payment_provider_ref_unique`). "No transaction was found" is never-heard-of-it; any other error throws and changes nothing.

*Initiation* (`payments/initiate.ts`, `subscriptions/payments.ts`; `routes/payment-body.ts`). `method: card` needs no phone (a phone sent is ignored). The answer is `{ payment: { ourRef, status: 'pending' }, card }` (`201`); amounts come from `bookingTotals`/the frozen fee/`platform_setting` as before, and bookability is re-checked as for MoMo (T3.4). The payer is the booking's contact snapshot, or the photographer's login address, display name and contact phone. Return pages, built on the server: `/checkout/:reference/:token/payments/:ourRef` (booking fee), **`/payments/:ourRef`** (guest session fee: a new token-free page, because the booking's access token reads and cancels the booking and Flutterwave stores the URL), `/account/bookings/:reference/payments/:ourRef`, **`/studio/subscription/payments/:ourRef`** (new).

*One payment in progress, and abandonment.* A card payment's checkout session lasts `CARD_SESSION_SECONDS` (15 minutes) from its initiation, and Inline is told so (`session_duration`, whole minutes, cut to the hold's end for a booking fee). While at least a minute of it is left, a second card tap answers `200` with the SAME `ourRef` and config, its `session_duration` cut to what is left, so a reopened modal never outlives the first session (for a subscription, only for the same plan). Mixing methods follows the existing rules: inside the three-minute attempt window any waiting attempt answers any other method `409 payment_in_progress`. Closing the modal blocks nothing for good: after the window another method may start, and after the session a new card attempt gets a new row and `tx_ref`. A declined card is one try in a modal that stays open (Flutterwave sends `charge.completed` "for each failed attempt"), so a FAILED report is recorded but never applied (`attemptOnly`, note `attempt_failed`). The payment's end, if nothing succeeds, is the reconciler's: once the session and a five-minute grace are over and the lookup finds no transaction or only declined ones, it is closed `failed` with `card_session_expired`, a reason of ours that the Phase 4 revive rule includes, so a late verified success still counts (confirming the booking if its slot is free, `refund_due duplicate_payment` if a retry already paid). Holds are unchanged.

*Webhook* (`POST /api/webhooks/flutterwave-checkout`, before the JSON parser). `verif-hash` is compared in constant time (digests of both); missing or wrong, the delivery is stored `signature_valid = false` and answered 401. A verified delivery is only a CLAIM: stored first (`claim:<uuid>`, ignored), never applied; a claimed failure or pending report is not asked about; anything else is re-verified by `GET /v3/transactions/:id/verify`, and only that answer goes down the ordinary store/dedupe/forward-only path (event id `<transaction id>:<STATUS>`, so the webhook, the reconciler and the poll of one outcome are one event). An answer for another `tx_ref` applies nothing (`claim_mismatch`); an unknown transaction applies nothing; the API unreachable is a 500 so Flutterwave retries.

*The client-triggered check (C5)* (`payments/card-check.ts`). The progress page's own poll verifies: `GET /api/payments/:ourRef` (fees) and `GET /api/studio/subscription/payments/:ourRef` (the photographer's own subscription payment only) ask Flutterwave about a pending card payment, at most once per payment every 5 seconds whoever polls, waiting at most 8 seconds. The page may pass `?transactionId=` (from the modal's callback or the redirect) to say WHICH try to verify by id; the answer must name this payment's `tx_ref`, and a success must match amount and currency. Chosen over a rate-limited `POST …/verify` because the page already polls and the 3-D Secure redirect lands on that page, the throttle is per payment (a per-IP limit would not bound calls to Flutterwave), and no route is added to any area. The page's word is never the result (T3.2).

*Ledger and refunds.* A card earning is the full amount (no fee deducted); a `refund_due` card payment is listed on `/platform/refunds` and recorded there; the studio is refused it (`refund_with_platform`) as for MoMo. Emails name the provider "Card (Flutterwave)".

*Assumptions to confirm in the sandbox (T3.6).* Each was decided the safe way where the docs are silent:
1. Inline accepts a `tx_ref` reopened after the modal was closed unpaid (the in-progress answer reuses it). If not, a reopened modal fails and the payer waits out the session (at most 15 minutes) before a new card attempt; change the reuse rule then.
2. `configurations.session_duration` really closes the modal; the reconciler waits five more minutes before closing the payment.
3. `verify_by_reference` answers the successful transaction when one `tx_ref` has a declined try before it. If it answers the newest or the first instead, the webhook and the poll's `transactionId` (both by id) still settle it; a closed payment is revived by the webhook.
4. "Not found" is `status: error`, `data: null`, message "No transaction was found…", as a 400 or 404. Any other shape keeps the payment waiting (never wrongly closed), and an unpaid one stays `pending` instead of `card_session_expired`.
5. `amount` in a v3 transaction is what we asked, whatever the card fee (the platform absorbs it; `charged_amount` is not read), and in whole RWF.
6. `charge.completed` carries `data.id` and `data.tx_ref`; the claim is re-verified by `data.id`.
7. A payer who edits the config in the browser (amount, currency, `payment_options`) cannot make a success count: amount and currency are matched, and a success through another payment type is still money in the platform's account, settled (its method stays `card` on our row).
8. Flutterwave's redirect appends its query to `redirect_url` (which has none of its own).

---

## Phase 4: Payouts
> **Refunds follow the money (user decision, Phase 4).** Money paid online (`mtn_momo_direct`, `flutterwave`, and cards' `flutterwave_checkout`) sits in the platform's account, so **only a platform admin records its refund**, on `/platform/refunds` (`POST /api/platform/refunds/:paymentId`). The photographer **keeps recording refunds of cash** he was handed, in the studio; the studio refund route refuses anything else as `409 refund_with_platform`, and the studio booking view shows an online `refund_due` as pending with the platform (`refundPendingWithPlatform`). The platform's route refuses cash as `409 cash_payment`. The `refund_due` photographer alert says so for online money. Payouts cover booking and session fees only: a Phase 5 subscription payment never creates a payout item.

> **Overpayments go back from the platform (user decision, Phase 4).** When a client pays a session fee online for more than the booking is worth, the money is in the platform's account. The photographer **earns only what was due**: the earning is `amount_rwf - overpaid_rwf`. The extra is listed on `/api/platform/refunds` as an **overpayment refund** (`refundKind: 'overpayment'`), which a platform admin sends back to the client and records with a reference. The payment itself **stays `succeeded`**. The photographer is told, with nothing to do: the overpayment alert says the platform will return the difference to the client.

**Requirements**
- **R4.1** `payout_method` is immutable: a change retires the old row and inserts a new one.
  - Changing it **requires the current password** and sends an `account_security_alert` email.
  - The platform's payout screen flags methods changed within the last 72 hours, because redirecting payouts is what an account takeover would aim for.
- **R4.2** `payout_item`:
  - an `earning` for every succeeded non-cash booking or session fee (amount = payment amount less any overpaid part; no commission)
  - a `refund_due` payment voids its earning if it hasn't been paid out yet, or adds a `reversal` otherwise
- **R4.3** "Payable now" is calculated each time from the SQL in `marketplace-data-model.md` §3.9, not stored.
- **R4.4** Platform flow:
  1. "Payouts due" lists photographers with their balance and payout method.
  2. Build a draft: lock the items and total them. If the total is ≤ 0, no payout is created and the balance carries forward.
  3. Make the transfer outside the app.
  4. Mark it paid with the transfer reference (required, unique). That emails `payout_sent`.
- **R4.5** Studio "Earnings" page: pending, payable and paid, each line linked to its booking. The payout-method page and the catalogue price form both show the **transfer-fee banner**.
- **R4.6** Refunds are recorded on the platform's `/platform/refunds` page (the money is in your account). Recording a refund marks the payment `refunded` with a reference.
  - Recording an **overpayment refund** sets the payment's `overpayment_*` columns and leaves it `succeeded`.

**As built (Phase 4, stage 1)**
- **Ledger** (`payouts/ledger.ts`): the only writer of items, called in the transaction that changes the payment.
  - `recordEarning` runs on every success the webhook path applies (booking fee confirming or re-confirming, session fee, a fee for a booking in no state to take one), so the reconciler earns too. Cash and kinds other than `booking_fee`/`session_fee` are refused.
  - `recordRefundDue` runs on every move to `refund_due`: client cancel, photographer cancel, and the late slot-taken and duplicate-fee webhooks (which never succeeded, so find nothing to undo). A platform cancel (Phase 9) must call it too.
  - An earning in a **draft** when its payment is refunded is reversed, not voided, so the draft amount stands. Cancelling that draft voids the earning and its reversal together: neither was ever paid.
  - **No backfill:** a payment that succeeded before the Phase 4 migration has no earning.
- **Payable now** is the §3.9 SQL with the app's injected clock in place of `now()`.
- **Payout method change** (`PUT /api/studio/payout-method`):
  - The current password check **shares the login lockout**: a wrong password counts as a failed login and the locking attempt sends the `login_lockout` alert. Locked, the answer is `403 password_locked`; a missing or empty password is `403 invalid_password` and is not counted.
  - Rate-limited per address (`payoutMethodPerIp`, 10 an hour).
  - Saving the **first** method takes the same path and sends the same alert (worded "added").
  - The MoMo number must be E.164 Rwandan on its own network's prefixes (MTN 078/079, Airtel 072/073).
- **72-hour flag:** a method is flagged while its current row is under 72 hours old, a first method included.
- **Who did what:** a payout records who built, paid and cancelled it, and a payment records who recorded its refund (`refunded_by_user_id`, photographer or platform admin).
- **Concurrency:**
  - A build takes a per-photographer advisory lock and locks the items `FOR UPDATE`. A racing refund is ordered against it: void before, reversal after.
  - Mark-paid and cancel lock the payout row and act on a `draft` only.
  - The transfer reference is unique, checked first and mapped from `23505`.
  - **One lock order for a booking's money** (documented in `payments/webhooks.ts` `applyEvent`): the photographer's calendar lock, then the booking row, then its payment rows, then their payout items. Each path takes a prefix in that order. A webhook success matches its payment unlocked, takes the calendar and booking locks, then locks and re-reads the payment. Before this, a success took the payment row first while cash takes the booking first and then the open ask's payment row, and the two could deadlock (`40P01`, a 500 for the photographer). A race test runs a cash recording against a session-fee success, in both orders.
- **The studio's Earnings page:**
  - Lines are `pending`, `payable`, `in_draft`, `paid` or `voided`, each with its booking's id and reference.
  - Payout history shows the draft and paid payouts; a cancelled draft is hidden from the studio.
  - `GET /api/studio/payouts/:id` reads one, and is in the isolation sweep.
- **The payout's `note`** (typed at mark-paid) is platform-internal: never in the studio or the email.
- **Overpayments** (migration `20261017193312_payment_overpayment`; `marketplace-data-model.md` §3.9). The payment gets `overpaid_rwf` and `overpayment_refunded_at`, `overpayment_refund_reference`, `overpayment_refunded_by_user_id`: columns, not a table, because a payment has at most one overpayment and its full refund already lives on the same row.
  - **Recording it.** The webhook path measures a session fee's overpaid part under the booking's row lock, and sets it in the same update that sets `succeeded`. `recordEarning` then earns `amount_rwf - overpaid_rwf`. A replay never reaches it (the payment is settled), so `overpaid_rwf` is never added twice.
  - **Wholly extra** (`overpaid >= amount`), for example a stale prompt approved after the balance was paid in cash: the fee is `refund_due` with reason `duplicate_payment`, earns nothing, and is listed as a full refund, like a duplicate booking fee. Its alert names it as a session fee paid after the booking was paid in full. `CHECK payment_overpaid_range` keeps `overpaid_rwf` below the amount.
  - **A session fee voided by cash and then paid anyway.** Recording cash voids an open ask (`failed`, `superseded_by_cash`), but the client can still approve it. A verified success with matching amount and currency is then the only record that the money reached the platform's account. So it is an exception to forward-only: the payment is revived and measured like any success.
    - Wholly extra: `refund_due` with reason `duplicate_payment`, `settled_at` and the provider reference set, no earning, the duplicate session-fee alert, and listed as a `full` refund.
    - Partly due (the cash covered only part of the balance): it succeeds with its overpaid part.
    - Its `failure_reason` is kept, as the record of why it was voided, and a replay finds it settled and is ignored.
  - **A late success on an attempt whose provider call failed on our side** (user decision, Phase 4: "count it, refund only if extra"). An attempt we marked `failed` because the call to the provider failed may still have reached the payer. A verified late success (amount and currency matching) revives it, and it takes the success path exactly as a pending payment would:
    - **Booking fee:** it confirms the booking if the slot is still free (the claim lock and the slot-occupied check, re-confirming an expired booking). If the slot was taken it is `refund_due` `late_payment_slot_taken`; if a retry already paid the fee it is `refund_due` `duplicate_payment`.
    - **Session fee:** it pays what is still owed, with the overpayment split when partly extra, or is `refund_due` `duplicate_payment` when wholly extra.
    - Earnings and alerts are as for any success.
  - **Which failures revive** (`locallyFailed`, payments/webhooks.ts): exactly `superseded_by_cash`, `provider_timeout`, and any reason starting `provider_unavailable: ` (our call errored without a verdict: unreachable, an unreadable answer or 5xx, a token or configuration failure). As a second guard, no FAILED verdict from the provider may have been applied for the payment.
    - **Never revived:** a rejection the provider answered at initiation (MTN 400/409 as its code or `http_400`/`http_409`, Flutterwave's failure codes, `redirect_required`), our own pre-check refusals (`method_unavailable`, `phone_not_rwandan_mobile`), and any failure the provider reported in a FAILED event. Forward-only stands there, logged as `webhook_success_for_failed_payment`.
    - A revival is logged as `webhook_success_for_locally_failed_payment` (warn) with its reason, and its `failure_reason` is kept. A replay finds it settled and is ignored.
    - The reconciler still looks up only payments in progress, so a revival arrives by webhook.
  - **Totals.** `bookingTotals.collectedRwf` counts each succeeded payment for `amount - overpaid_rwf`. `refundDueRwf` includes overpaid parts not yet returned. Each payment's overpaid part is what is extra after the earlier payments' overpaid parts, so two overpayments never double-count, and an add-on added afterwards asks for new money. The client's receipt still shows what they actually paid (`paidRwf` adds the overpaid part still held) and names the difference.
  - **A full refund after an overpayment.** `refund_due` covers the overpaid part, so the overpayment entry drops off the list. The earning is voided, or reversed, for its own (reduced) amount. A full refund's `refundAmountRwf` is `amount - overpaid_rwf` when the overpaid part was already returned, and `amount` otherwise; the same figure goes in the cancellation alert and email and in `refundDueRwf`.
  - **Recording a refund** (`POST /api/platform/refunds/:paymentId { reference, refundedAt?, refundKind? }`) records whichever is pending. **If both could apply, the full refund takes precedence.** It refuses cash (`409 cash_payment`) and a payment with nothing pending (`409 not_refundable`). The optional `refundKind` (beyond the decision, a safety check) must match what is pending, else `409 refund_kind_mismatch { pending }`: an admin who returned the overpaid part from a list that has since changed is never recorded as having refunded the whole payment.
  - **Online refund references are unique** across `refund_reference` and `overpayment_refund_reference`, full refunds included: a repeat is `409 duplicate_refund_reference`. This is checked under a per-reference advisory lock across both columns, and held by the partial uniques `payment_refund_reference_online_unique` and `payment_overpayment_refund_reference_unique`, with `23505` mapped to the same answer. Cash references are the photographer's own words and stay outside the rule.
  - **The studio booking view** shows each payment's `overpaidRwf`, `overpaymentRefundPendingWithPlatform`, `overpaymentRefundedAt` and `overpaymentRefundReference`.
  - **No backfill:** an overpayment taken before the migration has `overpaid_rwf = 0` and its earning at the full amount.

**Test criteria**
- **T4.1** A succeeded booking fee is payable immediately. A succeeded session fee becomes payable only after `ends_at`, and not if the booking was cancelled. A cash payment creates no item.
- **T4.2** A refund before payout voids the earning. A refund after payout creates a reversal, and the next payout nets it off.
- **T4.3** A second draft for the same photographer, marking paid without a reference, or a duplicate reference: each is refused.
- **T4.4** Photographer A can't read B's earnings or payout method (404). Changing the method without the password gets 403, and the security email is enqueued.
- **T4.5** Overpayments:
  - An overpaid success earns only what was due, is listed as an overpayment refund, and recording it removes the entry and keeps the payment `succeeded`.
  - A replayed webhook adds no second overpaid part.
  - A wholly extra fee is `refund_due` (including a stale prompt approved after cash).
  - An add-on after an overpayment asks for new money, and two overpayments do not double-count.
  - A full refund after an overpayment drops the entry and voids or reverses the earning's own amount. Its refund amount is less the overpaid part only when that part was already returned (both branches).
  - A duplicate online reference is refused within a kind and across kinds, while cash is unaffected. Cash, nothing pending, and photographer and client tokens are refused.

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
  - As built: `422 validation_failed { fields: ['packageId'] }`, the existing answer for every unbookable photographer's package (user decision, Phase 5: match the existing unbookable behaviour), so out of subscription looks like suspended from outside (R3.4 as built). A new booking-fee payment for a booking already held is `409 photographer_unavailable`.

**As built (Phase 5, stage 1)** (migration `20261022135830_subscriptions`; `marketplace-data-model.md` §3.7 refinements)
- **Prices are PLACEHOLDERS.** The seed writes `subscription_monthly_price_rwf` 10,000 and `subscription_yearly_price_rwf` 100,000 (`db/seed.ts` `PLACEHOLDER_SUBSCRIPTION_PRICES`); the migration gives an existing row the same values. **Set the real prices in `/platform/settings` before launch** (Phase 10). The columns have no default; a reseed never overwrites prices already set.
- **Payment is MoMo or card** (cards since 2026-10-30, "Cards as built" in Phase 3), through the Phase 3 method routing (`payments/routing.ts`). The studio gets the same routing as the checkout.
- **Lifecycle** (`subscriptions/lifecycle.ts`): approval creates the subscription (`trialing`) and its trial period in the approval's transaction, starting at the approval instant, for `trial_days` as they stand then. `INSERT … ON CONFLICT (photographer_id) DO NOTHING`, so racing approvals create one, and a photographer approved again never gets a second trial (and the `photographer_approved` email then promises none; with a new trial it carries `trialEndsAt`). Suspension and reactivation leave the subscription alone: its clock keeps running.
- **Backfill.** The migration gives every photographer ever approved (`approved_at` set, so suspended-after-approval too) without a subscription a trial from the migration's moment. Without it, every photographer approved before Phase 5 would be unbookable at once, with no subscription to pay for; a suspended one would come back from reactivation the same way.
- **Bookable** (`photographers/bookable.ts`): `approved AND subscription.status IN ('trialing','active') AND current_period_ends_at > now`, compared with the clock directly in all three forms: the Prisma filter and the in-memory check on the app's clock (public reads, the quote, the calendar, booking creation), and `BOOKABLE_SQL` on the database clock (the slot claim's locked re-check and the booking-fee initiation, which already measure the hold there). The claim locks the photographer row `FOR SHARE` and only reads the subscription: nothing can make a bookable photographer unbookable except the clock, which it compares.
- **Listed:** approved, `status IN ('trialing','active','past_due')` and `current_period_ends_at + grace > now`. `GET /api/photographers`, the profile and the service detail carry `takingBookings`; a `past_due` photographer is listed with `false`, profile and services shown, and their packages answer the quote, calendar and booking form as an inactive package does.
- **Expired profile = 404** (R5.5's "unavailable" is the page's wording of it): `GET /api/photographers/:handle` (and its services) answers an expired photographer exactly as a suspended, pending or unknown one, because R3.4 as built keeps an out-of-subscription photographer indistinguishable from a suspended one, and a distinct answer would publish billing state. A job-recorded `expired` stays hidden until a payment (widening the grace afterwards does not un-expire it); a late job hides by the clock anyway.
- **Paying** (`subscriptions/payments.ts`, `routes/studio-subscription.ts`):
  - `GET /api/studio/subscription`, `POST /api/studio/subscription/payments { planInterval, method, phone }` (no phone for a card), `GET /api/studio/subscription/payments/:ourRef`; all `no-store`; the POST shares the client payment routes' per-IP limit.
  - The amount is `platform_setting`'s price for the plan, read in the transaction; the body is parsed with unknown keys stripped, so a forged amount is ignored (T5.3).
  - One payment in progress per subscription: the subscription row is locked `FOR UPDATE`, then `initiated`/`pending` payments younger than `PAYMENT_ATTEMPT_WINDOW_SECONDS` (180 s, the booking fee's window) block a new one (`409 payment_in_progress`). A window rather than a hard block, so a prompt nobody answers cannot lock the photographer out; an older one that settles still adds its period.
  - Any subscription status may pay (`expired` included); a pending or suspended photographer is `409 photographer_not_approved`; an approved one without a subscription (prevented by approval and the backfill) `409 no_subscription`.
  - The provider call is the shared `attemptPayment` (payments/initiate.ts), so failures use the same reasons and the Phase 4 revive rule applies. Statement reference `SUB-<handle>`.
- **Settling** (payments/webhooks.ts → `addPaidPeriod`): a verified success, by webhook or the reconciler, inserts a paid period starting at `greatest(now, current_period_ends_at)` and ending one month or one year later on the Kigali calendar (clamped to the month's last day), moves `current_period_ends_at`, sets `active`, and enqueues `subscription_receipt` (dedupe per payment), in one transaction. Amount and currency are checked first, as for fees.
  - **The double-payment decision:** every success adds its period on top, a late, duplicate or revived one included; none is ever `refund_due`, overpaid, refunded or earned (no payout item). The platform's refund route finds nothing pending on one (`409 not_refundable`). A replay finds the payment settled and is ignored.
  - **Lock order:** the subscription row takes the booking row's place for a subscription's money: subscription (2′), its payments (3), its periods (4′). Initiation takes 2′-3, a success 2′-4′, the job 2′ alone; approval holds the photographer row then inserts the subscription. The two chains never meet (documented in `applyEvent`).
  - The public `GET /api/payments/:ourRef` answers a subscription payment `404`.
- **The job** (`subscriptions/job.ts`, `*/10 * * * *`, started by `server.ts` with an injected clock): (1) past the grace → `expired` + `subscription_expired`; (2) period over → `past_due` + `subscription_reminder` variant `past_due`; (3) the smallest reminder day count reached → `subscription_reminder` variant `ending`. Expiry runs first, so a very late run goes straight to `expired` with no stale notice; a late run sends only the most urgent reminder it has reached, never the ones it passed. Dedupe keys: `email:subscription_reminder:<sub>:<end ISO>:<days|past_due>`, `email:subscription_expired:<sub>:<end ISO>`. Each move is a guarded `UPDATE … WHERE status IN (…) AND current_period_ends_at <= …` in a transaction with its email, so a racing payment wins either way. Status moves happen for every photographer; emails go to approved ones only (others cannot pay). One subscription's failure is logged and does not stop the others.
- **Emails:** `subscription_reminder` (`ending`, `past_due`), `subscription_receipt` and `subscription_expired` are sendable; `RESERVED_EMAIL_TEMPLATES` is empty. `photographer_approved` gains an optional `trialEndsAt`.
- **Platform** (`routes/platform-settings.ts`): `GET`/`PATCH /api/platform/settings` (hold 1-60 minutes, the reconciler's window; trial 1-366 days; prices 1 to int4; grace 0-366; reminder days at most ten, distinct, each 1-366, stored largest first; the 366 ceilings are developer bounds), each change logged with who (R9.4). `GET /api/platform/subscriptions?status=` lists every subscription with its photographer and periods, soonest end first, `status` at the clock.
- **Status shown is computed** (`subscriptions/plan.ts` `statusAt`): the studio page, the polling route and the platform list show the status at the clock, not the job's last record.

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

**As built (Phase 6, stage 1, backend)** (no migration; `catalogue/directory.ts`, `routes/public-catalogue.ts`, `routes/sitemap.ts`)
- **Who is listed** (user decisions, Phase 6): the LISTED rule of Phase 5 (`photographers/bookable.ts`), plus at least one **active package on an active service**: a photographer with nothing to book is not listed at all. Pending, suspended and expired photographers never appear. A `past_due` photographer is listed with `takingBookings: false`, **after every bookable one**, and is **left out whenever `date` is given**. The rules are SQL on the app's clock (`bookableSqlAt`, `listedSqlAt`), held equal to the Prisma and in-memory forms by `photographers/bookable.test.ts`.
- **`GET /api/photographers?category&district&min&max&date&page`** answers `{ photographers: [{ handle, displayName, coverImageUrl, fromPriceRwf, districts: [{ code, name }], categories: [{ slug, name }], takingBookings }], page, pageSize: 24, hasMore, total? }`. `Cache-Control: no-store`.
  - `fromPriceRwf` is the cheapest active package of an active service; `min`/`max` are inclusive bounds on it.
  - Districts come in the migration's order, categories (active only) in the platform's.
  - **Order:** bookable first, then `fromPriceRwf`, then the name lowercased and compared byte by byte (`COLLATE "C"`, so the order does not depend on the database's locale), then the id. A total order: a page boundary never moves between two requests over the same rows. This amends R6.1's "cheapest price, then name".
- **The date filter**, in two stages (§3.12):
  1. SQL keeps candidates that are bookable, open that Kigali day (a dated override wins over the weekday's row, either way), whose window fits their shortest active package on the slot grid, and that no single block covers wholly. Each is a necessary condition of a slot, so the pre-filter never drops anyone the engine would keep.
  2. The engine (`availability/query.ts` `findDayStartsFor`: the calendar's own row filters and `availableStarts`, in four queries for a batch) keeps a candidate only if it offers at least one start for their **shortest** active package. Bookings, live holds, buffers, blocks in pieces and the lead time are all decided there.
- **Pagination under the engine.** Page *n* is survivors 24(*n*-1)+1 to 24*n* in the order above. The engine runs on candidates in chunks of 48, in order, from the first, until 24*n*+1 have survived or the candidates run out: the current page and what precedes it, never the rest. So pages are exact consecutive slices that never overlap or skip, and **`hasMore` is true only when survivor 24*n*+1 was actually found**. **`total` is answered only without `date`**: an honest total would need the engine on every candidate, and the SQL candidate count would overstate it. Without a date `total` is the exact count and `hasMore` is `page * 24 < total`. A page past the end is an empty `200`.
- **Dates accepted** (decision): today in Kigali through **365 days** ahead (`DIRECTORY_DATE_HORIZON_DAYS`, a developer bound: the app has no booking horizon of its own). Outside it is **`422 validation_failed { fields: ['date'] }`**, not an empty page: "nobody is free" would be a false answer, and the filter bar can mark the field. Today is allowed, because its later slots may still be free; the lead time then decides.
- **Validation** (`routes/validation.ts`): the query is a strict object, each key at most once.
  - `400 invalid_request`: an unknown or repeated key, an empty value, a slug or code of the wrong form, a number that is not whole digits (`abc`, `1.5`, `1e3`, more than 12 digits), a malformed date.
  - `422 validation_failed { fields }`: `category` (no active category has that slug: an unknown or deactivated one), `district` (no such district), `min`/`max` (negative or past int4; `min > max` names both), `date` (outside the window above, or a year the engine cannot compute), `page` (below 1 or above 1000, `DIRECTORY_MAX_PAGE`). Several at once are named together.
  - Every value reaches SQL as a bound parameter. A test calls `searchDirectory` with injection-shaped slugs directly and finds that nothing matches and nothing changes.
- **Filter bar:** `GET /api/categories` answers `{ categories: [{ slug, name }] }` (active only, in the platform's order). `GET /api/districts` answers `{ provinces: [{ code, name, districts: [{ code, name }] }] }`: the five provinces in a fixed order (`kigali`, `eastern`, `northern`, `southern`, `western`), English names, Rwanda's 30 districts.
- **Profile page** (`GET /api/photographers/:handle`, R6.2) answers `{ photographer: { handle, displayName, bio, coverImageUrl, contactPhone, whatsappPhone, email, takingBookings, cancellationPolicy: { cutoffHours, bookingFeeRefundable }, districts, categories, portfolio: [{ url, caption }], services: [{ slug, nameEn, descriptionEn, coverImageUrl, fromPriceRwf }] } }`.
  - Still the allowlist: no id, status, login email or operating setting. Each contact field is null when not set; `email` is the published contact address, never the login.
  - `portfolio`: at most 24, in `sort_order`, then age; `https://` only (the CHECK, and filtered again on read).
  - `services`: the active services in catalogue order; `fromPriceRwf` is null while a service has no active package.
  - Unknown, pending, suspended and expired are the same `404 not_found` (Phase 5 as built).
  - **T6.4:** every text field is returned verbatim, `<script>` included. The page renders it as plain text (R6.5).
- **Sitemap** (R6.6): `GET /sitemap.xml` at the API's **root** (not under `/api`), `application/xml`, `Cache-Control: public, max-age=3600`. It lists `${WEB_ORIGIN}/`, `${WEB_ORIGIN}/photographers` and `${WEB_ORIGIN}/p/<handle>` for each **bookable** photographer (not past-due), by handle, each profile with `lastmod` from `photographer.updated_at`. At most 50,000 URLs, the protocol's limit for one file. Every text node is XML-escaped. `WEB_ORIGIN` is the CORS origin `server.ts` passes. **The web host rewrites its own `/sitemap.xml` to the API's `/sitemap.xml`**, and `frontend/public/robots.txt` names `${WEB_ORIGIN}/sitemap.xml` (frontend work).
- **Demo seed** (`db/seed-demo.ts`): each of the three photographers has a two-paragraph bio, a WhatsApp number, a cover and 5 to 8 portfolio images. The images are **demo-only** Unsplash stock photos on `images.unsplash.com`, by fixed photo id; they are never anyone's work. The "from" prices are 35,000, 40,000 and 50,000 RWF, with overlapping ranges. A demo photographer from an earlier seed (the one at that handle whose login is the demo address) gets the cover, WhatsApp number and portfolio it lacks; nothing already set is changed.
- **Indexes:** no migration. At 200 photographers every directory query plans as index scans (`subscription_photographer_id_key`, the join tables' keys, `category_slug_key`, `service`/`package` by photographer and service) and executes in about 1 ms. The planner prefers `package_service_id_idx` to `package_directory_price_idx` at this size, because it reaches packages through their active service.
- **T6.3** (`catalogue/directory-performance.test.ts`, an ordinary suite file): 200 varied photographers, 20 requests per path after a warm-up. It asserts p95 < 300 ms for the SQL paths (no filter, a deep page, every filter combined). It reports the date paths separately, with a loose 2-second ceiling for a slow machine. Locally the SQL paths measured 14-20 ms p95 and the date paths 20-40 ms p95.

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

**As built (Phase 7, stage 1, backend)** (`photographer.submitted_at` was in the baseline; one migration, `20261027090000_photographer_handle_changed_at`, for the handle-change flag below; `photographers/{profile,portfolio,setup}.ts`, `routes/studio-profile.ts`, `routes/studio-setup.ts`)
- **Approval requires a submission** (user decision, Phase 7). `POST /api/platform/photographers/:id/approve` on a pending photographer whose `submitted_at` is null is **`409 not_submitted`** `{ error, photographer }`, changing nothing and sending nothing. The guard is in the approval's own `UPDATE … WHERE status = 'pending' AND submitted_at IS NOT NULL`, so a submission racing an approval can never approve an unsubmitted studio. Approving an approved photographer stays a `200` no-op, submitted or not (photographers approved before Phase 7 never submitted); a suspended one stays `409 invalid_transition`. The submission survives a suspension before approval, so a photographer reactivated to `pending` is approvable without submitting again.
- **Platform list.** Each photographer carries `submittedAt` and **`handleChangedAt`** (the handle's latest change after submitting, null if none; the console flags the row "handle changed since submission"; the moderation answers carry it too). `GET /api/platform/photographers?status&review`: **`review=awaiting`** (pending and submitted: the queue, the only pending photographers approval accepts) or **`review=setting_up`** (pending, not submitted). A filter of its own, not two more `status` values: `status` is the column's vocabulary and every row's `status` field is one of those three values, so `status=awaiting` would be a filter value no row ever carries. The two combine with AND (`status=approved&review=awaiting` is an honest empty list). An unknown, empty or repeated `review` is `400`.
- **Profile** (R7.2). `GET /api/studio/profile` → `{ profile: { handle, handleEditable, displayName, bio, contactPhone, whatsappPhone, contactEmail, coverImageUrl, districts: [{ code, name }], categories: [{ slug, name }], status, submittedAt } }` (`submittedAt` so the editor can say a handle change will notify the platform). `PATCH` takes any subset, in one transaction (a refusal changes nothing):
  - **Handle** editable only while `approved_at` is null (**ever approved**, so a suspension after approval keeps it locked: the handle has been public in the directory, the sitemap and every link sent). A different handle after that is `409 handle_locked`; the current handle (any case) is never a change, so a form posting every field back still saves. Before approval: the signup's format (`400`), the reserved list and someone else's handle (`409 handle_taken`, a race on the unique index included). The photographer row is locked `FOR UPDATE` first, so an approval committing meanwhile is seen.
  - **A handle changed after submitting** (user decisions 2026-10-27). Of all the profile details only the handle is crucial: it becomes the studio's public address, fixed for good at approval. When the handle actually changes while `status = 'pending' AND submitted_at IS NOT NULL`, the change **saves** (it is not blocked) and, in the same transaction and under the same row lock, sets **`photographer.handle_changed_at`** to the save's time and enqueues `photographer_application_received` **variant `handle_changed`** (`previousHandle` and `handle`, the old and the new) to every active platform admin, filed under no photographer; dedupe `email:photographer_application_received:handle_changed:<photographer>:<new handle>:<save time>:<admin>`, so one email per admin per change, and a later change is a new email. Each later change moves the timestamp forward; nothing clears it (approval included: by then the handle is locked and the flag is history). A change before submission sets and sends nothing; the same handle again (any case) is no change; after approval a different handle is still `409 handle_locked`; a refused save (`handle_taken`, `422`, a lost race on the unique index) rolls the flag and the emails back with it. A photographer suspended before approval is not under review, so a change then sets and sends nothing. Every other field stays free to edit after submitting, with no alert. CHECK `photographer_handle_changed_after_submission`: never set without `submitted_at`.
  - Approval does **not** re-check the checklist, and the platform admins keep **both** emails, at signup and at submission (user decisions 2026-10-27).
  - **Lengths are the CHECKs counted as PostgreSQL counts them** (code points, not UTF-16 units): `displayName` 1-80 (required text: null is `400`), `bio` ≤ 2,000. Text is trimmed; NUL is refused (`422`). Optional fields take `null` **or a blank string** to clear.
  - **Phones** stored E.164 (`^\+[1-9]\d{6,14}$`): a Rwandan local `078 123 4567` or `250…` becomes `+250…` (`booking/phone.ts`); any other number needs its `+`. Not a phone number is `422`. **Email** is a valid address (malformed `400`, the 400-versus-422 rule), stored lowercased; it is the public contact, never the login. **Cover URL** https only (malformed `400`, another scheme `422`), stored in its **canonical WHATWG form** (`HTTPS://`, `https:host`, a space become `https://host/…`, `%20`): the CHECK's case-sensitive `^https://` would otherwise refuse, as a 500, URLs zod accepts.
  - **`districts`** (codes) and **`categories`** (active slugs) replace the whole set; unknown, inactive or repeated is `422` naming the field, checked before the handle. A category the platform has deactivated stays assigned, untouched by a replace and unseen (it comes back on reactivation). `updated_at` moves on every save, so the sitemap's `lastmod` follows.
  - The editor's lists are the public `GET /api/categories` and `GET /api/districts`.
- **Portfolio** (R7.2). `GET /api/studio/portfolio` → `{ images: [{ id, url, caption, sortOrder, createdAt }], limit: 24 }`; `POST { url, caption? }` → `201 { image }`, appended last, at most **24** (`409 portfolio_full { limit }`); `PATCH /:id { caption }` (key required, null or blank clears); `DELETE /:id` → `204`; `PUT /portfolio/order { ids }` → `{ images }`, rewriting `sort_order` 0..n-1. The order must be exactly the photographer's set: a missing, extra, repeated (case-insensitively) or another photographer's id is **`422 validation_failed { fields: ['ids'] }`**, a non-uuid `400`. Captions ≤ 200 characters; URLs as the cover. Add, delete and reorder take a per-photographer advisory lock (`bookly.portfolio:<id>`), so racing adds never pass 24 and a reorder never interleaves with an add; an advisory lock rather than the photographer row, which a slot claim holds `FOR SHARE`. Another photographer's image id is the same `404` as an unknown one; both id routes are in the isolation sweep, which now also compares the photographer row, its districts, categories and portfolio.
- **Setup checklist** (R7.3). `GET /api/studio/setup` → `{ setup: { items: [{ key, done }], missing, status, submittedAt, canSubmit } }`, items always in this order, each judged from the rows as they are now:
  - `profile`: `display_name` and `bio` each hold a non-blank character (cover and contact details are optional);
  - `categories`: at least one **active** category; `districts`: at least one;
  - `payoutMethod`: a current (not retired) method;
  - `services`: an active service with an active package (the directory's rule);
  - `workingHours`: an open **weekly** rule (a one-date override alone is not working hours).

  `canSubmit` = pending, not submitted yet, every item done.
- **Submitting** (`POST /api/studio/setup/submit`, no body): **`409 not_pending`** for approved or suspended (checked first, so a suspended applicant is not told to finish setting up); **`422 setup_incomplete { missing }`** with the missing items in checklist order (T7.1), recording and sending nothing; else one guarded `UPDATE … WHERE status = 'pending' AND submitted_at IS NULL` sets `submitted_at` and, in the same transaction, enqueues `photographer_application_received` **variant `submitted`** to every active platform admin (filed under no photographer, like the signup's; dedupe `email:photographer_application_received:submitted:<photographer>:<admin>`), and logs `photographer_submit`. Answer `200 { setup }`.
  - **Resubmitting is idempotent:** an already-submitted studio answers `200` with its first `submittedAt`, sends nothing, and is **not re-judged**. Racing submissions record one time and one email per admin.
  - **Edits after submitting keep the submission** (design call). The items live behind a dozen studio routes, a photographer goes on polishing a studio while it waits, and the admin reviews the live studio at approval rather than a snapshot; clearing on every edit would re-queue the studio and email the admins again for a typo. The checklist keeps showing every item's live state, so an item undone after submitting is visible to both sides.
- **Email.** `photographer_application_received` gains an optional `variant`: absent or `signup` is the Phase 2 email (so rows queued before Phase 7 still render); `submitted` is "A studio is ready for review", its button `/platform/photographers?review=awaiting`; `handle_changed` (2026-10-27) is "A studio under review changed its handle", naming the previous and the new handle, with the same button (`previousHandle` is required for it and refused on any other variant). The signup email is unchanged and still sent. en.json: additive keys only (five for `submitted`, six for `handle_changed`).
- **`/me`** (R7.4) answers `{ user, photographer: { id, handle, displayName, status, submittedAt, suspensionReason }, subscription }`, everything the banners need in one read (`subscriptions/views.ts` `studioMe`): pending with `submittedAt` null ("finish your setup") or set ("waiting for review"); suspended with the reason; `subscription` is null until approval creates it, else `{ status, currentPeriodEndsAt, graceEndsAt, takingBookings, endingSoon }`, the status at the clock (`statusAt`). **`endingSoon`**: `trialing` or `active` and the period ends within the largest of `subscription_reminder_days` (7 by default, inclusive; never with no reminder days). Trial ending = `trialing` + `endingSoon`; past due = `past_due` until `graceEndsAt`. The platform settings are read only when there is a subscription.
- **No rate limit** on the profile, portfolio or setup writes: none calls a provider or hashes a password, like the catalogue, hours and settings writes beside them (`http/rate-limit.ts` says what the limits protect). The submission sends one email per admin, once; a handle change under review one per admin per change, only to the platform's own admins and only from a signed-in studio awaiting review.

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

**As built (Phase 8, stage 1, backend)** (user decisions 2026-10-27; one migration, `20261027120000_account_dashboard`; `account/{bookings,payments,profile,credentials,export}.ts`, `routes/account-dashboard.ts`, mounted inside `routes/account.ts` behind `requireClient`)
- **Decisions** (user, 2026-10-27): (1) the phone lives on the account (`app_user.phone`, E.164), prefills the booking form, and never rewrites a booking's contact snapshot; (2) a Google-only account may add a password and then signs in either way; with a password the address may change (confirmed with it), without one the change is `409 password_required` and deletion is confirmed by typing the address; adding a first password sends an `account_security_alert`, rotates `cred_fp` and answers a fresh token; (3) once a new address is confirmed, bookings already linked stay linked and the unclaimed `client` rows under the new address are linked, as at signup; (4) deleting with upcoming bookings is allowed: they carry on through the guest links already emailed.
- **Scope, everywhere.** A booking is the account's when its `client` row is (`client.user_id`), across photographers; a payment when its booking is. The user comes from the token, never from a path, query or body. A reference or `ourRef` that is not the account's is `404 not_found`, the answer for one that names nothing (T8.1). `Cache-Control: no-store` on every dashboard answer and on `/me`.
- **Bookings (R8.1).** `GET /api/account/bookings?scope=upcoming|past&page` → `{ scope, bookings, total, page, pageSize: 20, pageCount }`; a page past the end answers the last; `page` below 1 or above 1,000,000 is 422, a malformed one, an unknown scope, a repeated key or an unknown key 400. Each row: `reference`, `photographer { handle, displayName }`, `serviceName`, `packageName`, `startsAt`, `endsAt`, `status`, `stage` (client stages, never `needs_review`), `amounts { totalRwf, paidRwf, dueRwf, refundDueRwf }` (from `bookingTotals()`), `holdExpiresAt`, `checkoutPath`.
  - **upcoming**: `confirmed` whose shoot is not over (in progress included), and `pending_payment` while its hold is live (database clock, as the checkout measures it), with `checkoutPath` = `/checkout/<reference>/<token>` (the checkout's HMAC; null when payments are off). Soonest first.
  - **past**: `completed`, `no_show`, every cancellation (a cancelled future shoot included), and `confirmed` whose shoot is over. Latest first.
  - **An `expired` hold, and a `pending_payment` whose hold lapsed before the sweeper caught it, are in neither list** (design decision): a lapsed hold never became a booking, and listing the attempts a client abandoned beside the booking they made is noise. Its reference still opens its page; a late payment on it, owed back, is in the payments list.
- **One booking (R8.1).** `GET /api/account/bookings/:reference` → `{ booking, photographer: { handle, displayName, contactPhone, whatsappPhone, email }, checkoutPath }`, where `booking` is exactly the guest page's view (`clientBookingView`; a test compares the two byte for byte) and `photographer` the public profile's contact details. `POST …/cancel` is the guest cancellation (`booking/cancel.ts`, refactored into `cancelLoaded` so both callers share every rule, refund and email): `200` with the page, `409 not_cancellable` with the page, `404`. `POST …/payments { method, phone }` is the guest session-fee payment (`startSessionFeePayment`: the amount on the server, one attempt at a time, the method's provider; the same `paymentsPerIp` limit): `201`, `409 nothing_to_pay` (with the page) or `payment_in_progress`, `422`, `502 payment_not_started`, `404`; only mounted when payments are. The contact-email change stays on the guest page.
- **Payments and receipts (R8.2).** `GET /api/account/payments?page` → `{ payments, total, page, pageSize: 20, pageCount }`, newest first: every payment that moved money or tried to (`pending`, `succeeded`, `failed`, `refund_due`, `refunded`), **not `initiated`** (design decision: such a row is a photographer's request nobody has paid, which the booking page already asks for, or a provider call in its first seconds). Each: `ourRef`, `kind`, `method` (`momo_mtn`, `momo_airtel`, `card`, `cash` for money the photographer recorded, or null), `amountRwf`, `status`, `failure` (`declined`/`unavailable`, the public words), `createdAt`, `settledAt`, `refund` (`{ state: none }`, `{ state: due, amountRwf }`, `{ state: refunded, amountRwf, refundedAt, reference }`), `overpayment` (`{ amountRwf, refundedAt, reference }` or null), `hasReceipt`, `booking { reference, startsAt, serviceName, packageName, photographer }`. Never the provider's name or reference, the failure text, or a cash payment's note.
  - `GET /api/account/payments/:ourRef` → `{ receipt: { ourRef, kind, method, amountRwf, status, createdAt, settledAt, refund, overpayment, billedTo, photographer, booking: { reference, startsAt, endsAt, serviceName, packageName, packagePriceRwf, bookingFeeRwf, addons: [{ name, quantity, unitPriceRwf, amountRwf, stage }] } } }`. **Only `succeeded`, `refund_due` and `refunded` have a receipt** (a refunded one says so in `refund`); the account's own `initiated`, `pending` or `failed` payment is **`409 no_receipt { payment: { status } }`** (design decision: the caller owns it, so naming its status discloses nothing, and the page can explain); another account's, a subscription payment, an unknown or malformed `ourRef` are `404`. The page prints with the browser's stylesheet.
- **Profile (R8.3, decision 1).** `GET /api/account/profile` → `{ profile: { fullName, phone } }`; `PATCH { fullName?, phone? }`, any subset. The name is trimmed, 1-200 characters counted as PostgreSQL counts them, NUL refused (blank or long `422`, null `400`). The phone takes the studio's rule: `booking/phone.ts` reads a Rwandan `078…` or `250…` as `+250…`, any other number needs its `+`, else `422`; `null` or a blank string clears it. **`/me`** now answers `{ user: { id, email, lastLoginAt, fullName, phone, hasPassword, hasGoogle, pendingEmail } }` (`pendingEmail` only while its link is live).
- **Password (R8.3, decision 2).** `POST /api/account/password { currentPassword, newPassword }`: the current one is checked with the login's lockout (`verifyCurrentPassword`: wrong `403 invalid_password` and counted, locked `403 password_locked` without checking); a Google-only account is `409 no_password`; a change racing another is `409 credentials_changed`. `POST /api/account/password/set { newPassword }`: a Google-only account adds its first password, no old one to check; an account with one is `409 password_exists` (racing additions add one). Both write under a guard on the credentials that were checked, clear a pending reset link and the lockout, enqueue `account_security_alert` variant `password_changed` (`added` false or true), and answer a login's `{ user, token, tokenType, expiresAt }`: the new `password_hash` changes `cred_fp`, so every other token stops on its next request and the caller carries on with the fresh one. New passwords 12-1,024 characters (`422`).
- **Address (R8.3, decisions 2 and 3).** `POST /api/account/email { newEmail, password }`: `409 password_required` for a Google-only account (checked first), `422 { fields: ['newEmail'] }` for the account's own address (any case), `403` for a wrong or locked password, else **`202 { ok: true }` whether or not the address has an account** (R2.5's no-enumeration): the new address is stored pending with the SHA-256 of a fresh 256-bit token, 24 hours, a newer request replacing it; a free address is emailed the link (`account_verify_email` variant `email_change`, `/account/email-confirm/<token>`), **a taken one is sent nothing**, so that change can never complete, while the answer, `/me` and the stored state look the same.
  - **Confirming** is `POST /api/account/email/confirm { token, password }`, **unauthenticated** (mounted ahead of `requireClient`: the link opens in a tab with no session), like `/auth/verify`: the token proves the new inbox, the password the person; either wrong, a lapsed, replaced or used link, an erased account and a locked one are one `400 invalid_confirmation`, each refusal costing one Argon2 check, a wrong password counted. Under the row lock it re-checks the link and the password hash, then that the address is still free (**`409 email_taken`** if an account took it since; the pending change is withdrawn; the unique index catches a signup racing the write the same way), sets `email` and `email_verified_at`, clears the pending change, any verification link and any reset link (emailed to the old inbox), links the unclaimed client rows under the new address (decision 3; rows already linked stay), enqueues `account_security_alert` variant `email_changed` to the OLD address with the new one masked, and answers a login's response. The address is not in `cred_fp`, so open sessions carry on. **Google sign-in** finds the account by `google_sub` first (`auth/google.ts`, unchanged), so it keeps working after the change; a test proves it.
- **Export (R8.3, T8.4).** `GET /api/account/export` → the JSON document as an attachment (`Content-Disposition: attachment; filename="bookly-account-<Kigali date>.json"`): `{ format: 'bookly-account-export', version: 1, exportedAt, account: { email, fullName, phone, emailVerifiedAt, createdAt, lastLoginAt, hasPassword, hasGoogle, pendingEmail }, contacts: [{ fullName, email, phone }], bookings: [...], payments: [...] }`. Each booking: its reference, photographer, status, dates, its contact snapshot, the package and price snapshots, location, party size, requests, `consentAt`, the booking fee, the add-on lines, `totals`, the cancellation terms, the lifecycle dates and reason, the delivery once sent (`url` only while live), and the photographer's notes still shown to the client. Payments: every one on those bookings, every status, as the list shapes them. Out: every hash, token and expiry, the Google subject, `token_version`, the lockout, row ids, the provider's references and failure text, a cash payment's note, deleted notes, the outbox, and anything reached other than through the account's own client rows. A test holds it to exactly the account's records. Limited to 10 an hour per IP (`accountExportPerIp`).
- **Deletion (R8.3, T8.3, decision 4).** `POST /api/account/delete` with `{ password }` (an account with one: `403 invalid_password`/`password_locked`, counted) or `{ confirmEmail }` (a Google-only account: the address typed again, trimmed, any case, else `403 invalid_confirmation`); both, neither or another key `400`, an empty password `422`. One transaction anonymises the login (`deleted-<id>@deleted.invalid`; name, phone, both credentials, verification, last sign-in, every token hash and the pending change nulled; lockout cleared; `anonymized_at` set; `token_version` + 1; `disabled_at` left alone, being a platform admin's reversible switch) and clears `client.user_id` on its rows; the `client` rows, the bookings and their snapshots stay. `204`. Afterwards login fails, the old token is `401` everywhere (the export included), the photographer's booking page still shows the snapshot, the guest link still opens the booking, and the address is free for a new signup; a later Google sign-in with the same Google account creates a fresh account (which links the unclaimed rows under its address again, as any new account would). A structured log line names the user id, the time, and how many client rows and mail rows were unlinked and erased, never the address. CHECK `app_user_has_credential` now admits an erased row with no credential.
  - **The outbox** (user decisions 2026-10-27, deletion follow-up), in the same transaction, before the address leaves the login: every **account-mail** row of the user is erased as data-model_v2.md §10.2 erases a client's rows (`recipient` `'[erased]'`, `payload` null; one not yet delivered is also `cancelled`, its link being dead with the account). Account mail is `account_verify_email` (signup verification and address-change links), `account_password_reset` and `account_security_alert` (lockout, account exists, password changed or added, address changed, the deletion notice): no booking, no photographer, addressed to the login. A row is the user's when it is addressed to the current or the pending address (any case) or its dedupe key names the user's id, which also catches mail to an address the account has since left. **Booking mail is never touched**: it is each photographer's record of what their client was told, and the bookings stay. The API is unchanged: still `204`, no body.
  - **The deletion notice**: then ONE `account_security_alert` variant `account_deleted` (when, what was erased, that bookings stay with their photographers and upcoming ones go ahead through their own links, what to do if it was not them; no button) is enqueued to the address being erased, dedupe `email:account_security_alert:account_deleted:<user>`, so racing deletions send one. The scrub runs first, so it cannot erase the notice. The row is marked **`outbox.erase_on_completion`** (migration `20261027140000_outbox_erase_on_completion`): it keeps the address only until the worker reaches a terminal state, and the very statement that marks it `done` or `failed` (an abandoned row included) sets `recipient` to `'[erased]'` and `payload` to null. A retry keeps both, since the next attempt needs them. The outbox had no such place before, so this generic column is it; nothing else sets it yet. Left as it is: a provider error text in that row's `last_error` and in a `retries_exhausted` alert, which could echo the address if a provider wrote it into its error.
  - **Re-linking** (user decision 2026-10-27): a later signup with the freed address is a new account and, once it verifies, links the unclaimed guest bookings under the address, exactly as any signup does; proven by a test, as is the fresh account a later Google sign-in creates.
- **Linking (R8.4).** Unchanged mechanism (`upsertClient` sets `user_id` from a verified, unerased client account with the address; `COALESCE` keeps a link). Proven end to end: a guest booking through `POST /api/bookings` under a verified account's address (any case) appears in its dashboard at once, with its checkout link; an unverified or erased account's address links nothing.
- **Email** (no template CHECK change): `account_verify_email` variant `email_change`; `account_security_alert` variants `password_changed`, `email_changed` and `account_deleted`. en.json: additive keys only (6 for `email_change`, 10 for `password_changed`, 6 for `email_changed`, 6 for `account_deleted`). Snapshots in `email/__snapshots__/render.test.ts.snap`.
- **Rate limits**, per IP in the account area: `accountPasswordPerIp` (the change and the addition share it), `accountEmailChangePerIp`, `accountEmailConfirmPerIp`, `accountDeletePerIp`, `accountExportPerIp`, each 10 an hour; the session-fee payment shares `paymentsPerIp` with the guest routes. The lists, the booking page, the receipts and the profile are unlimited (no provider, no Argon2, no email).
  - **Follow-up, not built** (user decision 2026-10-27): a per-account cap on address-change requests. For now the per-IP limit and the password each request needs are enough; a cap per account (say a few a day, as the booking contact-email change has) would stop someone holding the password from filling a third party's inbox from many addresses. A request to an address that already has an account stays silent, as built.
- **Isolation sweep** (`routes/account-isolation.test.ts`, T8.1): client X on every `/api/account/*` operation but `/auth/*`, from the spec and from the code; id-taking ones name client Y's booking reference, receipt and pending payment and must answer `404` (never the `409 no_receipt` X's own pending payment gets), and every one leaves Y's login, client row, bookings, add-on lines, notes, payments and mail exactly as they were and shows none of it. A route on either list missing from the table fails the test.

---

## Phase 9: Platform admin console (`/platform`)
**Requirements**
- **R9.1** Photographers: list and filter by status. Approve (starts the trial and sends `photographer_approved`). Suspend with a reason (hides the profile, blocks new bookings, keeps existing ones). Reactivate.
- **R9.2** Categories: create, rename, reorder and deactivate. A category that's in use can't be deleted.
- **R9.3** Payouts (Phase 4), Refunds, Subscriptions (status and history) and Platform settings (hold time, trial, prices, grace, reminder days).
- **R9.4** Every platform action records who did it and when: `approved_by_user_id`, `paid_by_user_id`, `created_by_user_id`, plus an entry in the structured log. As built (Phase 9): also a `platform_audit` row in the action's own transaction, readable on the Activity page.

**Test criteria**
- **T9.1** Every platform route refuses photographer and client tokens.
- **T9.2** Suspending removes the photographer from the directory, refuses a new booking, and leaves an existing booking's session-fee payment working.

**As built (Phase 9, stage 1, backend)** (user decisions 2026-10-27; one migration, `20261027160000_platform_audit`; `platform/{audit,categories,photographer-detail}.ts`, `routes/platform-categories.ts`, two routes added to `routes/platform.ts`)
- **Decisions** (user, 2026-10-27): (1) R9.4's "who and when" becomes a `platform_audit` table written **in the same transaction** as each platform action, plus a structured log line, with a read-only API for an Activity page; (2) **no platform cancellation of a booking** in this phase: `cancelled_by_platform` stays in the vocabulary, unused; (3) **deactivating a category hides it, and photographers keep the tag**; deleting is allowed only while nobody has it.
- **The audit trail (R9.4; `marketplace-data-model.md` §3.15).** `recordAudit` writes one row inside the transaction that makes the change, so the two commit or roll back together: a refused action (approval `409 not_submitted` or `invalid_transition`, `draft_exists`, `nothing_payable`, `not_draft`, a duplicate transfer or refund reference, `cash_payment`, `not_refundable`, `refund_kind_mismatch`, `slug_taken`, `category_in_use`, any 400/422) and a failed one (a test makes the approval throw inside its transaction) leave no row, and an idempotent no-op (approving an approved photographer, suspending a suspended one, a settings save or category edit of the values already stored, the current category order) writes none: the trail records changes, not requests. After the commit, `logAudit` writes one line per row: `{ level, event: 'platform_action', action, auditId, actorUserId, targetType, targetId, photographerId, at }`, ids only, never an address. It replaces the bespoke `photographer_<action>` and `platform_settings_updated` lines.
  - **What each action records** (`details`: ids, statuses, amounts, references and reasons; never a password, a token, a login email, a full payout number, a payout's internal `note` or a client's personal data; a test reads every row back against all of them):

    | Action | Target | `details` |
    |---|---|---|
    | `photographer_approved` | photographer | `{ status, trialStarted, trialEndsAt }` |
    | `photographer_suspended` | photographer | `{ status, reason }` |
    | `photographer_reactivated` | photographer | `{ status }` (`approved`, or `pending` if never approved) |
    | `payout_created` | payout | `{ amountRwf, itemCount, payoutMethodId }` |
    | `payout_paid` | payout | `{ amountRwf, itemCount, transferReference }` |
    | `payout_cancelled` | payout | `{ amountRwf }` |
    | `refund_recorded` | payment | `{ paymentKind, refundKind, amountRwf, reference, bookingId }` (the amount sent back: the full refund's or the overpaid part) |
    | `settings_updated` | platform_setting (no id) | `{ changed: { <field>: { before, after } } }`, the changed fields only; the platform row is locked `FOR UPDATE` first |
    | `category_created` | category | `{ slug, nameEn, sortOrder }` |
    | `category_updated` | category | `{ slug, nameEn: { before, after } }` |
    | `category_deactivated`, `category_reactivated` | category | `{ slug, photographerCount }` |
    | `category_reordered` | category (no id) | `{ before: [id], after: [id] }` |
    | `category_deleted` | category | `{ slug, nameEn }` |

    `photographer_id` is set for the moderation, payout and refund rows (a refund's through its booking) and null for settings and categories. A rename and a deactivation in one PATCH are two rows of one transaction.
- **`GET /api/platform/audit?action&photographerId&page`** → `{ entries, total, page, pageSize: 50, pageCount }`, newest first (`created_at DESC, id DESC`, so a page boundary never moves between rows of one instant); a page past the end is empty. Each entry: `{ id, action, actor: { id, email }, target: { type, id }, photographer: { id, handle, displayName } | null, details, createdAt }`. The query is a strict object, each key once: an unknown or repeated key, an action outside the vocabulary, a malformed id or page is `400`; a page below 1 or above 1,000,000 is `422`. Filters combine with AND; an id naming nobody is an empty page.
- **One photographer (`GET /api/platform/photographers/:id`)** → `{ photographer, profile, setup, subscription, payoutMethod, methodChangedRecently, counts, earnings, activity }` in one read; `404` for an id naming nobody, `400` for a malformed one.
  - `photographer`: the list's row (login email, status, `submittedAt`, `handleChangedAt`, approval, suspension and reason) plus `approvedBy { id, email } | null`.
  - `profile`: bio, the three contact fields, cover, districts in the migration's order, and **every** category they are tagged with as `{ slug, name, isActive }` (the public sees active ones only).
  - `setup`: the studio's checklist as its rows stand (`items`, `missing`, `canSubmit`; photographers/setup.ts).
  - `subscription`: the platform list's row plus `takingBookings` (the bookability rule at the clock), every period newest first, the status at the clock; null until approval creates it.
  - `payoutMethod`: the current destination **masked**, `{ id, kind, provider (network or bank), accountName, last4, createdAt }` (design call: the detail page is for weighing a photographer, not for paying them; the payouts screen, which transfers the money, keeps showing the full number); `methodChangedRecently` is R4.1's 72-hour flag, false with no method.
  - `counts`: `bookings` keyed by every booking status, 0 included; `services { total, active }`.
  - `earnings`: `{ payableRwf (§3.9, may be negative), inDraftRwf, paidOutRwf }`.
  - `activity`: the latest 20 audit rows about them, the Activity page's shape.
- **Categories (R9.2, decision 3; `routes/platform-categories.ts`).**
  - `GET /api/platform/categories` → `{ categories: [{ id, slug, nameEn, isActive, sortOrder, photographerCount, createdAt, updatedAt }] }`, active and inactive, by sort order, then name, then slug (the public order); `photographerCount` counts photographers of every status.
  - `POST { slug, nameEn }` → `201 { category }`, active, **last** (`max(sort_order) + 1`, 0 when there is none). The slug is the CHECK's form (`^[a-z0-9]+(-[a-z0-9]+)*$`, malformed `400`), at most 64 characters (the directory query's bound, `422`), trimmed; one used by any category, active or not, is `409 slug_taken` (also the `23505` of a race). The name is trimmed, 1-80 code points (a developer bound), NUL refused (`422`). Create, reorder and delete take one advisory lock (`bookly.categories`), so racing creates land in distinct places.
  - `PATCH /:id { nameEn?, isActive? }` → `200 { category }`; any subset, `{}` a no-op. **The slug is immutable** (it is in every shared directory link, `/photographers?category=<slug>`): a `slug` key is a `400` like any unknown key. The row is locked `FOR UPDATE`.
  - `PUT /order { ids }` → `200 { categories }`; exactly the full set, inactive ones included, each once (case-insensitively), as the portfolio order: a missing, extra, repeated or unknown id is `422 { fields: ['ids'] }`, a non-uuid `400`; rewrites `sort_order` to 0..n-1.
  - `DELETE /:id` → `204`, or `409 category_in_use { photographerCount }` while any photographer of any status has it (deactivate it instead). The row is locked before counting, so a studio save adding it meanwhile is counted or refused by the RESTRICT key (`23503` maps to the same answer).
  - **Decision 3, the effects** (proven end to end through the console in `routes/platform-categories.test.ts`): an inactive category is hidden from the public filter bar (`GET /api/categories`), the directory filter (its slug is the `422 { fields: ['category'] }` of an unknown slug, byte for byte), the directory cards, the public profile, and the studio's own profile and picker (which cannot add it, `422`); a studio save of its other categories leaves the hidden tag in place. The rows in `photographer_category` stay. Reactivating restores all of it with nothing re-tagged. These reads already filtered on `is_active` (Phases 6 and 7); this phase verified them and added the console.
  - **The setup checklist** (decision 3's open point, decided as recommended): a studio tagged only with inactive categories has `categories` **undone**, consistent with "hidden". Already the Phase 7 rule (photographers/setup.ts); now tested through a deactivation. A submitted studio stays submitted (the Phase 7 rule: edits after submitting keep the submission), and approval does not re-check the checklist.
- **T9.1 (`routes/platform-access.test.ts`).** Every `/api/platform/*` operation but `/auth/*` (23 today), from the spec and from the code, each with real ids and a body valid enough to act: a photographer's studio token, a client's account token, and a photographer's and a client's real credentials signed for the platform audience are each `401`, leaving every platform-relevant row (logins, photographers, categories, subscriptions, payouts, payments, settings, outbox, audit) exactly as it was; a platform admin's token is never refused and never a 500, and each write case is shown to act. A route on either list missing from the table, or a table entry for a route that is gone, fails the test.
- **T9.2 (`routes/platform.test.ts`, "suspending through the console").** End to end through the API: suspending removes the photographer from `GET /api/photographers` and turns the profile into the 404 of an unknown handle; a new booking is refused, as **`422 validation_failed { fields: ['packageId'] }`** (the Phase 5 answer for every unbookable photographer's package, R3.4: "409" in T9.2 is the held booking's booking-fee payment, `409 photographer_unavailable`, also tested); the existing confirmed booking's page opens and its session-fee payment starts (`201`). Reactivating restores listing, profile and booking. The pieces existed before (public-directory, client-booking, public-checkout tests, by direct row updates); this proves them through the console.
- **Still not built:** a platform cancellation of a booking (decision 2), and any email to the photographer on reactivation (no template). `name_fr` stays unused (English only).

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
| Checkout and payments | Amounts computed on the server. Cards are typed into Flutterwave's Inline modal, so no card data touches our server; the browser gets only the public key and a config built on the server. The return URL is never trusted. Webhooks are verified with a constant-time HMAC over the raw body (for cards, a constant-time compare of the static `verif-hash`, and every claim re-verified through Flutterwave's API before anything is applied), stored first, deduplicated and forward-only, with amount and currency matched. Reconcile is the fallback. The redirect URL is built on the server. One payment in progress at a time. Bookability is re-checked at initiation and at the claim. |
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

