# Security review — Bookly — 2026-10-11

> **Status in this repository: fixed.** This review was made against the
> single-photographer Bookly this marketplace grew from. Every finding below is
> fixed in the marketplace's baseline (see `docs/marketplace-spec.md`, Phase 0),
> each code finding with a regression test. Hostnames are replaced by placeholders.

Scope: code, dependencies, local exploits, and passive live checks, per
`docs/prompts/security-review.md`. Every attack below was proven against a local
copy running on a local PostgreSQL (`bookly_security`); the live site received
only read-only traffic. No application code was changed.

## Summary

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 0 |
| Medium | 2 |
| Low | 3 |
| Info | 1 |

**Top three risks, in plain words:**

1. **Anyone can read, cancel, or hijack other people's bookings** by typing a
   wildcard into the "Email me my links" box. The address is matched with a
   pattern match, not an equality test, so `_____@gmail.com` (or `%`) matches
   strangers' bookings and mails their fresh access links to the attacker. This
   is the same `ILIKE`-wildcard mistake that was fixed for admin login, left
   unfixed in one other place.
2. **None of the documented rate limits or abuse caps exist.** A single client
   can open unlimited slot holds and block the calendar, and can hammer the
   "email me my links" and payment endpoints, with no 429 anywhere. Spec §6.22
   requires per-IP/per-email limits and a 3-live-hold cap; they are not built.
3. **The API sends no security headers** (no CSP, HSTS, `X-Content-Type-Options`
   or `Referrer-Policy`). Spec §7 calls the CSP "load-bearing" because the admin
   bearer token lives in `sessionStorage`; today there is no CSP at all, on the
   API or in `frontend/vercel.json`.

---

## Findings

### 1. Booking takeover via `ILIKE` wildcard in "Email me my links" — Critical — Confirmed

**Location:** `backend/src/booking/link-lookup.ts:58`

```ts
where: { contactEmail: { equals: email, mode: 'insensitive' }, status: { in: ['confirmed', 'completed'] } },
```

On PostgreSQL, Prisma compiles `{ equals, mode: 'insensitive' }` to `ILIKE`, a
**pattern** match — not an equality. The typed string is used verbatim as the
pattern, and `z.email()` accepts the SQL-`LIKE` metacharacter `_` (and other
addresses can carry `%`). So `_____@gmail.com` matches every confirmed/completed
booking whose address is `<5 chars>@gmail.com`, and `%@gmail.com` matches all of
them. `admin-auth.ts:255` documents this exact footgun and fixes it there with a
raw `lower(email)` comparison; `link-lookup.ts` was missed.

The handler issues a **fresh** access token for each matched booking
(`issueAccessToken`, which rotates the hash) and emails them all to
`current[0].contactEmail` — the match with the earliest `starts_at`. An attacker
makes their own booking the earliest match (any near, early slot), submits the
wildcard, and receives a single email containing live access links for every
other matched booking. Those links grant the full client capability set: read
all PII (name, email, phone, location, notes), cancel the booking, and start/
change the contact email. Rotating the victims' tokens also silently breaks
their existing links (denial of service) even if the email never reaches the
attacker.

**Proof of concept (run locally against `bookly_security`):**

1. Seed two paid bookings: attacker `zzzzz@gmail.com` (earliest slot), victim
   `alice@gmail.com` (later slot).
2. `POST /api/booking-links` with `{"email":"_____@gmail.com"}` → `202`.
3. The enqueued `booking_links` email is addressed to `zzzzz@gmail.com` and its
   payload contains **both** references and a fresh access token for each.
4. `GET /api/booking/<victim-token-from-that-email>` → `200`, returning the
   victim's booking `confirmed` with full contact details.

Observed output:

```
booking_links email recipient: zzzzz@gmail.com
references inside it: BKY-2610-3RFMC, BKY-2610-7MAR5   (attacker + victim)
attacker opens the victim's link -> 200 BKY-2610-7MAR5 confirmed
```

`%` as the pattern matches the entire table; the earliest booking in the system
then receives everyone's links.

**Impact:** Confidentiality and integrity breach of every client booking;
bulk PII disclosure (Law N° 058/2021 personal data); unauthorised cancellation;
booking-link DoS. Reachable anonymously, no token required.

**Fix:** Match the address by equality, not `ILIKE`. Mirror the admin fix: a raw
`WHERE lower(contact_email) = lower($1)`, or at minimum escape `%`/`_` and use a
case-insensitive equality. The same pattern should be audited anywhere
`mode: 'insensitive'` is used on attacker-controlled input (see Checked and fine
for `admin-list.ts`, which is admin-only).

---

### 2. No rate limiting or abuse caps (booking holds, payments, links, login) — Medium — Confirmed

**Location:** `backend/src/booking/create.ts` (no per-IP/email limit, no
live-hold cap); `backend/src/routes/public-checkout.ts` and
`backend/src/routes/admin.ts` (`/auth/login`) (no limiter); plan.md Task 24
("Rate limits") appears unbuilt.

Spec §6.22 requires the booking endpoint to be "rate-limited per IP and per
email address, and one email address may hold at most 3 live `pending_payment`
bookings." Plan Task 24 additionally requires 429s on payment initiation and
admin login. None of this exists. The only limiter in the codebase is the
in-memory one on `/api/booking-links`
(`public-booking-links.ts:72`); it guards the email provider's quota but does
not implement the per-email database cap §6.22 describes, and the per-address
cooldown still allows a new "address" per wildcard pattern (compounding
Finding 1).

**Proof of concept (local):** From one email and IP, `POST /api/bookings` was
accepted `201` five times in a row with no `429`; each created a live
`pending_payment` hold that removed its slot from public availability. Repeating
across the calendar blocks every bookable slot for the 30-minute hold window,
re-armable indefinitely:

```
same email+IP: 5 pending holds created in a row, 429s seen: 0
free slots before ~487, after flood ~472; blocked 15
```

**Impact:** Anonymous denial of booking (hold every slot, never pay); unbounded
payment-initiation attempts (each prompts a real phone once providers are live —
the §6.22 "deposit paid twice"/harassment concern); email-provider quota and
inbox abuse; admin-login guessing is throttled only by the 5-attempt lockout,
not by a request rate limit. The claim transaction still prevents actual double
booking, so this is availability/abuse, not data integrity.

**Fix:** Add the per-IP and per-email limiter to `POST /api/bookings`, enforce
the "≤ 3 live `pending_payment` per email" cap in `createBooking`, and add 429
limiters to payment initiation and `/auth/login`, as Task 24 specifies.

---

### 3. API serves no security headers (CSP / HSTS / nosniff / Referrer-Policy) — Medium — Confirmed

**Location:** `backend/src/app.ts` (no `helmet`/header middleware);
`frontend/vercel.json` (no `headers` block).

The spec §7 and plan Task 24 require "HSTS, `X-Content-Type-Options`, a
restrictive `Referrer-Policy` and a CSP that blocks inline script — default
output from one middleware." No such middleware is mounted. `app.ts` disables
`x-powered-by` and sets CORS, and nothing else.

**Proof (passive, live API):** `GET https://api.bookly.example/api/health`
and `/` return no `Strict-Transport-Security`, `Content-Security-Policy`,
`X-Content-Type-Options`, or `Referrer-Policy` headers. `frontend/vercel.json`
contains only a SPA rewrite — no headers — so the deployed SPA has no CSP either
(Vercel supplies HSTS on the frontend by default, confirmed present there, but
nothing else).

**Impact:** The spec itself notes the trade-off of bearer-token auth: "script on
the admin UI can read the token, which makes the CSP load-bearing rather than
defence in depth." With the admin JWT in `sessionStorage` and no CSP, any
reflected/stored/dependency XSS on the admin origin can exfiltrate the admin
session. Missing `X-Content-Type-Options: nosniff` and `Referrer-Policy` widen
MIME-sniffing and token/reference leakage via `Referer`.

**Fix:** Mount `helmet` (or an equivalent header middleware) on the API with a
CSP that blocks inline script, HSTS, `nosniff`, and `Referrer-Policy:
no-referrer`/`strict-origin-when-cross-origin`; add a matching `headers` block to
`frontend/vercel.json` for the SPA (CSP, `X-Content-Type-Options`,
`Referrer-Policy`, `frame-ancestors 'none'`).

---

### 4. `trust proxy: 1` likely undercounts hops behind Cloudflare + Render — Low — Suspected

**Location:** `backend/src/app.ts:50` (`app.set('trust proxy', 1)`)

The live API is fronted by Cloudflare *and* Render (`Server: cloudflare`,
`x-render-origin-server: Render` on live responses), which is plausibly two
proxy hops, while the app trusts one. If so, `req.ip` is a proxy address rather
than the visitor's, so the in-memory IP limiter on `/api/booking-links` (and any
future per-IP limit from Finding 2) would either group unrelated clients
together or be steerable by a spoofed `X-Forwarded-For`. Not verified: proving it
needs `X-Forwarded-For` requests to the live site, outside the passive rule.

This compounds with the dependency finding below: Express 5.2.1 pulls
`proxy-addr@2.0.7`, which has a **critical** advisory (GHSA-jqcg-44mw-7w3h, IP
spoofing via an IPv4-mapped IPv6 trust subnet). `proxy-addr` is exactly what
`trust proxy` uses to resolve `req.ip`, so this is the one runtime-reachable
advisory and it bears directly on any per-IP limiter.

**Impact:** Per-IP throttling ineffective or bypassable; no data exposure on its
own.

**Fix:** Set `trust proxy` to the real hop count (or a specific CIDR), and verify
`req.ip` resolves to the client IP in the deployed topology before relying on it
for any limiter.

---

### 5. Admin-pasted delivery URL rendered as an `href` without scheme check — Low — Confirmed (self-XSS only)

**Location:** `frontend/src/pages/booking/BookingPage.tsx:507`
(`<a href={delivery.url ?? undefined} ...>`)

The photo-delivery link is stored as an admin-pasted URL and rendered into an
anchor `href`. React does not block `javascript:` URLs in `href` (it only warns
in dev), so a `javascript:…` delivery URL would execute when the client clicks
"view photos." Only the admin can set this value, so it is effectively
self-inflicted (the admin already holds all data and the client's trust), but it
is an untrusted-sink-shaped pattern worth closing.

**Impact:** Client-side script execution on the client booking page, gated behind
admin action — low real-world risk.

**Fix:** Validate the stored delivery URL to `https?:` at write time (admin
catalogue/delivery handler) and/or guard the scheme at render.

---

### 6. `express.json()` uses the default 100 kB body limit implicitly — Info

**Location:** `backend/src/app.ts:58`

The webhook router sets an explicit `64kb` raw limit; the main JSON parser relies
on body-parser's 100 kB default. That default is reasonable, but it is implicit —
worth pinning explicitly so a future bump elsewhere doesn't silently widen it.
No action required.

---

### 7. Dependency advisories — mostly dev/build-only, one runtime — Low — Confirmed

`npm audit` run in both apps on 2026-10-11:

- **backend:** 11 advisories (3 critical, 6 high, 2 moderate). All the
  critical/high ones resolve under **devDependencies / build tooling** —
  `vitest`→`tinypool` (critical, prototype-pollution RCE), `vite`/`esbuild`,
  `@prisma/config`→`deepmerge-ts`, `brace-expansion`, and `prisma`→`mysql2`
  (the app uses `pg`, so `mysql2` is never loaded). None runs in the deployed
  API process. The one **runtime-reachable** advisory is `proxy-addr@2.0.7`
  (critical, IP spoofing) via Express 5.2.1 — see Finding 4; impact is limited
  to IP-based throttling, not data access.
- **frontend:** 12 advisories (1 critical, 9 high, 2 moderate). The critical
  `proxy-addr` and the `express`/`ip-address` chain come in only through
  `shadcn`→`@modelcontextprotocol/sdk`→`express`, a scaffolding CLI that never
  reaches the browser bundle; `source-map-js` is build-time. None ships to
  users.

**Impact:** No internet-facing remote-code-execution path today — the dangerous
packages are dev/CI only. The runtime `proxy-addr` issue is the sole exception
and is low-impact (throttling).

**Fix:** Run `npm audit fix` in both apps (non-breaking resolves most, including
`proxy-addr`); take `vitest@5` via `--force` in a controlled bump to clear
`tinypool`. Re-audit before launch (plan Task 24).

---

## Checked and fine

- **JWT admin auth** (`auth/token.ts`): `algorithms: ['HS256']` pinned, `iss`/
  `aud` scoped, `requiredClaims` includes `exp`, UUID-checked `sub` before DB
  lookup, every `jose` failure → `null` (401, never 500). 32-char
  `SESSION_SECRET` floor enforced in `env.ts`.
- **Password-hash fingerprint revocation** (`auth/middleware.ts`,
  `token.ts:passwordFingerprint`): HMAC of the hash, constant-time compared
  against the current hash each request; password change revokes all tokens.
- **Login lockout** (`auth/admin-auth.ts`): atomic claim-before-verify UPDATE,
  pessimistic lock set in one statement, constant-time dummy Argon2 on the
  unknown-email/locked path, single `invalid_credentials` for all three cases.
- **Admin email lookup** (`admin-auth.ts:261`): raw `lower(email) = lower($1)` —
  the `ILIKE` footgun is correctly avoided here (contrast Finding 1).
- **Password reset** (`admin-auth.ts`): 256-bit token, only its SHA-256 stored,
  single-use enforced by `updateMany … WHERE tokenHash`, 30-min expiry, reset URL
  in a `#fragment`, no user enumeration (always `202`).
- **Client access tokens** (`booking/access-token.ts`, `access.ts`): 256-bit,
  base64url, only SHA-256 stored, expiry checked in the lookup UPDATE, rotated on
  resend, unknown/expired/superseded all return `404` not `403`; scope derives
  from the token alone — passing a booking id/reference/email changes nothing.
- **Checkout token** (`payments/checkout-link.ts`, `keys.ts`): per-purpose
  HMAC-derived key, constant-time verify, booking id never in a URL.
- **Email-change flow** (`booking/email-change.ts`): confirmed from the *new*
  address, old address notified, token rotated per request, confirmation is a
  `POST` (not a GET a mail scanner could trigger), masked email in responses.
- **Webhook authenticity** (`payments/mtn-momo.ts`, `flutterwave.ts`,
  `webhooks.ts`): MTN callback URL carries `HMAC(our_ref)` and the body's
  `externalId` must match; Flutterwave verifies base64 HMAC-SHA256 over the raw
  body, constant-time. Raw body is read before `express.json()`. Store-first,
  dedupe on `(provider, event_id)`, forward-only (settled statuses ignored),
  amount verified (`amount_mismatch` → ignored), duplicate/late-slot-taken →
  `refund_due` + admin alert. 64 kB limit; deep-JSON guarded.
- **Amounts server-authoritative**: booking fee and session fee computed from
  booking snapshots / `bookingTotals()`, never from the client; a stale "request"
  amount is clamped to current outstanding (`initiate.ts`).
- **SQL injection**: every `$queryRaw`/`$executeRaw`/`Prisma.sql` uses tagged
  parameters; no `$queryRawUnsafe`/`Prisma.raw` on user input.
- **Email HTML/header injection** (`email/layout.ts`): all subject/preheader/
  block content passed through `escapeHtml`; recipients are validated addresses.
- **CORS** (`app.ts`): allowlisted to `WEB_ORIGIN`, credentials disabled; a
  foreign-origin preflight to the live API returns no `Access-Control-Allow-
  Origin` (verified passively), so the browser blocks it.
- **Secrets & build**: `backend/.env` is gitignored and untracked; no real keys
  in git history (`xkeysib-`/`sk_live` hits are `.env.example` placeholders and
  test fixtures); only `VITE_API_BASE_URL` reaches the bundle; `*.js.map`
  returns 403 on the live frontend (no source maps shipped); `x-powered-by`
  disabled; Neon URLs use `sslmode=require` + `channel_binding=require`.
- **Error responses** (`app.ts`): generic `invalid_request`/`internal_error`;
  no stack, body, or path echoed.
- **Double-booking core**: GiST exclusion constraint + advisory-locked claim
  transaction with in-transaction stale-hold expiry — unchanged and sound.

## Out of scope / not tested

- **Active testing on the live site** (login, injection, fuzzing, POST/PUT/
  DELETE, token-bearing requests) — excluded by rule 2. Live findings rely on
  passive GET/HEAD/OPTIONS only.
- **Neon database user privileges and `sslmode` end-to-end** — rule 1 forbids
  using the production database; I verified the connection-string parameters
  from config only, without connecting.
- **Google Calendar / OAuth** (plan Task 22) — not yet built; no code to review.
- **Real payment-provider behaviour** — exercised against a fake provider and
  the real signature-verification code; no live provider was contacted.
- **`npm audit`** — now run; results in Finding 7.
