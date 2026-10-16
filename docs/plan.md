# Bookly — Implementation Plan

| | |
|---|---|
| **Builds** | `specs_v2.md` (behaviour) on `data-model_v2.md` (storage) |
| **Tasks** | 25, sequential. Each is one focused work session. |
| **Frontend** | React + TypeScript via Vite · shadcn/ui · Tailwind for custom styling |
| **Backend** | Express + Prisma · TypeScript · PostgreSQL 15+ (local instance) |
| **Layout** | `backend/` · `frontend/` · `docs/` — **two separately-deployed apps** on two separate domains: Vite still proxies `/api` to Express in dev for a single-command inner loop; in production the frontend is static-hosted and the backend is an API-only process at `/api/*` on its own host |
| **Launch blocker outside this plan** | **R-6** — no service names, prices, durations, photo counts or images exist yet. Tasks 1–25 can all complete without them; the site cannot go live without them. |

## How to read a task

Every task carries **Goal**, **Dependencies**, **Verification**, and **Assumptions** where the spec is silent. A task is done when its verification passes, not when the code is written.

File paths are deliberately absent. They churn as the project evolves and would be the first thing to go stale and cause merge conflicts; the Goal says what the task owns and the Verification says how you know it landed.



## Global definition of done

Applies to every task; not repeated below.

- `npm run lint`, `npm run typecheck`, `npm test` pass in **both** `backend/` and `frontend/`.
- Every new Express route enforces its permission from spec §2.2 in middleware, and a test asserts the denial case, not only the allow case.
- No money is computed anywhere except at write time per `data-model_v2.md` §9.5, or by `bookingTotals()` (§6.1). Nothing recomputes an amount from a live catalogue row.
- Any schema change goes through `prisma migrate dev --create-only` + hand-edited SQL. **`prisma db push` is never run** — it would drop the exclusion constraint (`data-model_v2.md` §2.1).

## Stack decisions (override before Task 1 if you disagree)

| Choice | Decision | Why |
|---|---|---|
| Migrations | Prisma migrations, SQL hand-edited before applying | The exclusion constraint, partial indexes, CHECKs and the view are not expressible in Prisma's DSL |
| Booking totals | One exported `bookingTotals()` function, status-aware | A view could not express "nothing is owed on a no-show" and would sit outside Prisma's types |
| Admin session | JWT (HS256, signed with `SESSION_SECRET`), 8 h, sent as `Authorization: Bearer`. Stateless: no session table, no TOTP, no session-epoch column. Carries an HMAC fingerprint of the password hash | One user. A changed password invalidates every issued token (its fingerprint stops matching); rotating `SESSION_SECRET` invalidates all of them. No server-side logout — signing out is the client discarding its token |
| Auth transport | Cross-site. Bearer token in the `Authorization` header — no cookie is involved in admin auth, so there is no CSRF token flow. A CORS allowlist scoped to `WEB_ORIGIN` (origin echoed, never `*`, credentials **not** enabled) | Frontend and backend are two separately-deployed apps on two separate domains. A header the client attaches in code is never sent by the browser on its own, so a forged cross-site request carries no credential: CSRF is removed rather than defended against, and browsers' third-party-cookie blocking no longer applies. The cost moves to XSS — script on the admin UI can read the token — so the CSP (Task 24) carries more weight |
| Tests | Vitest against the local PostgreSQL instance · Playwright for E2E | The critical logic is database behaviour; mocking the database would test nothing |
| Background work | `node-cron` inside the API process, single worker loop | One instance. Multi-worker claiming solves concurrency this deployment does not have |
| Email provider | Resend behind a `MailProvider` interface | Not named in the spec. Swappable in one file |
| Images | **No blob store, no uploads.** `cover_image_url` is a URL the admin pastes | The brief describes a service as "name, description, and price". An upload pipeline is a dependency bought for a field nobody specified |
| Shared code | **None.** No workspace package. The zod schemas, the quote function and the formatters exist twice — once per project | Chosen deliberately (no monorepo tooling). Contained by making the **server authoritative**: it recomputes every amount and revalidates every payload, and a fixture file at `docs/fixtures/` is asserted by both test suites so a divergence fails a test rather than reaching a client |
| Public page rendering | **R-7 is reopened** (`specs_v2.md` §8.2) — the SPA is client-rendered from a separately-hosted frontend again. Ship as-is; add prerendering/SSR only if search traffic starts to matter | The single deployable that had removed the problem is gone; solving it is out of scope for this change |

---

## Task 1 — Workspace scaffold and tooling

**Goal.** Stand up the two apps, the shared package, the toolchain and local Postgres, so every later task has somewhere to land and a way to be tested.

**Dependencies.** None.

**Verification.**
- `npm run dev` starts Vite on 5173 and Express on 4000; Vite proxies `/api` to Express, so `fetch('/api/health')` from the browser returns `{"ok":true}` without the browser making a cross-origin request at all — the dev proxy keeps the inner loop single-command even though the two apps deploy separately.
- `npm run build` in `frontend/` produces a static bundle deployable to any static host, with no Express involved; `npm run build` in `backend/` produces an API-only server with no reference to `frontend/dist`.
- `backend/` and `frontend/` each install, lint, typecheck and test independently — neither has a dependency on the other's build.
- `npx shadcn@latest add button` installs into `frontend/src/components/ui` and the button renders.
- Both `env.ts` files validate required variables at boot with zod: removing `DATABASE_URL` makes the API exit with a named error, not a later runtime crash.
- CORS is configured from `WEB_ORIGIN`: a request from the allowed origin gets `Access-Control-Allow-Origin` echoing it plus `Access-Control-Allow-Credentials: true`; a request from an unlisted origin gets neither header — it's the browser, not the server, that refuses it from there.

**Assumptions.** `PAYMENT_PROVIDER` is an environment variable on the API, never a database row (`data-model_v2.md` §5.2). Added to `.env.example` now as `mtn_momo_direct`.

---

## Task 2 — i18n, routing, and Kigali/RWF formatting

**Goal.** Put the i18n and formatting foundation in before any page exists, so French later is a content drop rather than a refactor (spec §7, A-14), and so no time or amount is ever rendered by ad-hoc code.

**Dependencies.** Task 1.

**Verification.**
- Page and email copy resolves through i18next with `en` as the only locale. **No locale-prefixed routing** — routes are plain paths; adding French later means adding routes, which is work rather than a rebuild (spec §7, R-2).
- Unit tests: `formatDateTime('2026-07-01T06:00:00Z')` returns `1 Jul 2026, 08:00` (Kigali, UTC+2, spec §6.5); `formatMoney(45000)` returns `45,000 RWF`; `formatMoney(45000.5)` throws — money is integer RWF only.
- The frontend and backend each hold a copy of the formatters, and both test suites assert against the **same** fixture file in `docs/fixtures/format.json` — a divergence between the two copies fails a test in both projects.

---

## Task 3 — Prisma schema and constraint migration

**Goal.** Create all 13 tables in `schema.prisma`, then hand-write the migration SQL for every guarantee Prisma cannot express — the exclusion constraint above all. This is the task that makes double booking impossible, which is the reason the project exists.

**Dependencies.** Task 1.

**Verification.**
- `npx prisma migrate reset --force` rebuilds from zero and applies cleanly; `npx prisma migrate deploy` on a fresh database produces an identical schema.
- `\dt` lists 14 tables — the 13 application tables plus Prisma's `_prisma_migrations`. `\dv` lists none: there is no view.
- **Constraint existence test:** a query against `pg_constraint` and `pg_indexes` asserts `booking_no_overlap` and all four partial unique indexes exist by name — `payment.provider_ref`, the succeeded booking fee, and the two on `working_hours` (`data-model_v2.md` §9.3). Prisma cannot report this; the test must.
- **Overlap test:** insert a `confirmed` booking 09:00–10:00 with `buffer_ends_at` 10:30; a second booking 10:00–11:00 fails with SQLSTATE `23P01`; one at 10:30–11:30 succeeds.
- **Buffer release test:** setting the first to `cancelled_by_client` then inserting 10:00–11:00 succeeds.
- **Double-deposit test:** two `payment` rows with `kind='booking_fee'`, `status='succeeded'` on one booking fail with `23505`.
- **Webhook idempotency test:** two `webhook_event` rows sharing `(provider, event_id)` fail with `23505`.
- **Nullability test:** `client.phone`, `webhook_event.payload` and `outbox.payload` all accept `null` — the erasure routine in Task 23 sets all three, and as `NOT NULL` every erasure raised `23502`.
- A test asserts the exclusion constraint's status list equals the occupying statuses in `data-model_v2.md` §7.1 — the guard against silently freeing occupied time when a status is added later.
- `npx prisma migrate diff` reports no drift after the constraint migration — the hand-written SQL is in migration history, not applied out of band.

---

## Task 4 — Seed data and settings access

**Goal.** Give the system its one admin, its one settings row and its Mon–Fri working hours, plus a typed accessor so no code reads a magic number.

**Dependencies.** Task 3.

**Verification.**
- `npx prisma db seed` creates 1 `admin_user`, 1 `setting`, 5 `working_hours` rows (weekday 1–5, `opens_minute = 540`, `closes_minute = 1020`, `is_open = true`).
- Running the seed twice leaves the same row counts — it is idempotent.
- `getSettings()` returns the five editable values `{ bookingFeeRate: 0.4, minLeadTimeMinutes: 120, holdMinutes: 30, bufferMinutes: 30, deliveryExpiryDays: 90 }`, with `bookingFeeRate` converted from Prisma's `Decimal` at the boundary so no caller ever handles a `Decimal`. Slot granularity (30) and access-token lifetime (365 days) are exported constants, not rows.
- Inserting a second `setting` row fails on `CHECK (id = 1)`.
- No business-logic module reads a fee rate, notice period, hold duration, buffer or expiry from anywhere but `getSettings()` — asserted by the settings module being the only importer of the `setting` table's repository.

---

## Task 5 — Availability engine

**Goal.** Implement the pure slot-generation function following the five-step resolution order (`data-model_v2.md` §8). Everything a visitor sees on the calendar comes from here, so it is built and tested in isolation before any UI exists.

**Dependencies.** Task 4.

**Verification.** Unit tests with an injected clock, one per rule:
- **Open window:** a Wednesday returns slots; a Saturday returns none.
- **Dated override, additive:** a `working_hours` row with `effective_date` on one Saturday and `is_open = true` returns slots for that Saturday only — the R-4 fix, and it must be proven.
- **Dated override, subtractive:** a row with `effective_date` on a Wednesday and `is_open = false` closes that day while other Wednesdays are unaffected.
- **Block:** a block 11:00–13:00 removes those starts; a multi-day block removes every covered day.
- **Occupancy and buffer:** a confirmed 09:00–10:00 booking reserves through 10:30, so on the 30-minute grid 09:30 and 10:00 are unavailable and **10:30 is the first free start**. (v2.0 asserted 10:15, a time the grid never produces.)
- **Lead time:** with `now` at 14:00, no start before 16:00 is returned.
- **Fit:** a 120-minute package returns no start after 15:00 on a day closing at 17:00 (`closes_minute = 1020`).
- **Impossible package:** a 600-minute package on an 8-hour day returns zero slots (spec §6.8).
- The function takes rows and a clock as arguments and touches no Prisma client — asserted by it running with no database connection open.

---

## Task 6 — Slot claim transaction and hold sweeper

**Goal.** Implement the transaction that claims a slot, including in-transaction expiry of stale holds, plus the sweeper job. This is the concurrency-correct core of the double-booking fix.

**Dependencies.** Task 5.

**Verification.**
- **Concurrency:** 20 parallel claims on one slot — exactly 1 succeeds, 19 receive a "slot taken" result, and exactly 1 booking row exists for that range.
- **Stale hold:** a `pending_payment` booking with `hold_expires_at` in the past, then a claim on the same slot **without running the sweeper** — the claim succeeds and the stale booking is now `expired` (`data-model_v2.md` §9.2).
- **Live hold:** same test with `hold_expires_at` in the future — the claim fails.
- The claim runs inside `prisma.$transaction` and surfaces `23P01` as a typed "slot taken" result rather than an unhandled Prisma error.
- The sweeper runs on the `node-cron` schedule and is also invocable directly in tests.
- Expiring a hold sends no email — asserted by an empty `outbox` after the sweep (spec §3.2).

---

## Task 7 — Admin authentication and API session layer

**Goal.** Email/password login with lockout and emailed reset, plus the bearer-token (JWT) session every later admin endpoint depends on (spec §2.1, §6.23, A-11).

**Dependencies.** Task 4.

**Verification.**
- Correct credentials return a JWT in the response body — `HS256`, issuer- and audience-scoped, 8 h `exp` — with `tokenType: 'Bearer'` and `Cache-Control: no-store`, and set **no cookie of any kind**, asserted by the absence of `Set-Cookie`.
- Wrong password increments `failed_login_count`; past the threshold `locked_until` is set and correct credentials are still refused until it passes.
- Changing the password invalidates any already-issued token on the next request, because the token carries an HMAC fingerprint of the password hash that `requireAdmin` checks against the current one.
- `GET /api/admin/*` without a valid `Authorization: Bearer` token returns 401 with a `WWW-Authenticate: Bearer` challenge and no redirect.
- The token is read from the `Authorization` header only — never a cookie, the query string or another header — and verification pins `HS256`: `alg: none`, any other algorithm, a wrong issuer or audience, a missing `exp`, and an expired, tampered or foreign-secret token are each a 401, never a 500. A cross-site request bearing a foreign `Origin` and whatever cookies the browser holds is a 401 — the bearer design has no ambient credential, so there is no CSRF token to test for. Asserted directly, and the CORS allowlist is asserted never to allow credentials.
- Password reset stores only a hash; the emailed token works once and is rejected on reuse and after expiry.
- `password_hash` appears in no API response — asserted by serialising the admin user through the public mapper.
- **Docs agree with code.** `specs_v2.md` §2.2 and §7, this plan's Stack decisions and this task, `data-model_v2.md` §5.1 and `audit-fixes.md` §9 describe bearer-token auth. No current-design passage in `docs/` describes an admin session cookie or a CSRF token flow — checked by grep; historical records (revision rows, `audit-fixes.md` §4 and §8, `old-drafts/`) keep what earlier revisions decided.

**Assumptions.** Argon2id via `@node-rs/argon2`. Lockout escalates 1 → 5 → 15 minutes; the spec says "rising interval" without values. No TOTP — removed in revision 2.1 as untraceable to any client requirement. JWTs via `jose`, not `jsonwebtoken`: ESM-native, actively maintained, and without `jsonwebtoken`'s history of algorithm-confusion footguns. HS256, because one service both issues and verifies. `jose` enforces no minimum HMAC key length, so the 32-character floor on `SESSION_SECRET` is the only guard and must not be relaxed. There is no logout endpoint: a stateless token cannot be revoked server-side, so signing out is the client discarding it, and revocation is a password change or a `SESSION_SECRET` rotation. The admin UI must hold the token and send `Authorization: Bearer` on every admin request — in memory, or `sessionStorage` so a reload does not sign him out, never `localStorage` — starting with whichever task builds the admin login screen; flagged here, not built here. **Revision 2.3** replaced the 2.2 design (a `SameSite=None` session cookie plus a double-submit CSRF token) — see `audit-fixes.md` §9.

---

## Task 8 — Admin availability and settings

**Goal.** Let the photographer set weekly hours, open or close individual dates, create blocks, and edit the five operating values — the admin half of the availability engine, plus the settings screen that P-15, P-24 and P-30 require and that no task previously owned (spec §3.3, §6.3, §6.4).

**Dependencies.** Tasks 5, 7.

**Verification.**
- Adding a weekday row for Saturday makes every Saturday bookable; deleting it closes them again.
- Adding an `effective_date` row for one Saturday with `is_open = true` opens that date only — verified by querying availability for two consecutive Saturdays.
- A payload with both `weekday` and `effective_date` is rejected by the zod schema with 400, and the database CHECK is proven to reject it too if the schema is bypassed.
- `opens_minute`/`closes_minute` accept `540`/`1020` and reject `1020`/`540` and any value above 1440.
- A full-day block and a 14:00–16:00 partial block remove exactly the expected slots.
- **Conflict warning (spec §6.4):** saving a block overlapping a `confirmed` booking returns 409 naming that booking and requires `confirm: true` to proceed; the booking is **not** cancelled and remains `confirmed`.
- `reason` never appears in the public availability response — asserted against the raw JSON.
- **Settings screen:** the booking-fee rate, minimum notice, hold duration, buffer and delivery-link lifetime are all editable and persist; each is range-validated server-side (a rate above 1 returns 422, not a `23514` from the database).
- Changing the buffer does **not** move an existing booking's `buffer_ends_at` — asserted against a booking created before the edit.

**Assumptions.** API only: no admin login screen exists yet (Task 7 deferred it), so the settings *screen* is its endpoint, and the UI arrives with whichever task builds the admin shell. Endpoints: `/api/admin/working-hours` and `/api/admin/blocks` (GET, POST, PUT `/:id`, DELETE `/:id`) and `/api/admin/settings` (GET, PATCH). One status rule for every admin write: **400** for a malformed payload (wrong type, unknown key, malformed date, both or neither of `weekday`/`effectiveDate`), **422** for a well-formed value outside its range. Full-day blocks arrive as inclusive Kigali dates and are converted server-side; partial blocks arrive as ISO instants with an explicit offset. The §6.4 warning measures overlap against a `confirmed` booking's session, not its buffer, and does not warn for a live `pending_payment` hold. The "public availability response" is `findAvailability()`, which never selects `reason`; the `GET /api/availability` route stays Task 12's and should return it unchanged. Settings carry no invented upper bounds beyond storage limits (`int4`, rate ≤ 1, three decimal places).

---

## Task 9 — Admin calendar views

**Goal.** Month, week and day views of bookings, holds and blocks, so the calendar is the single source of truth he actually looks at (spec §3.3 step 1, brief §4.2).

**Dependencies.** Task 8.

**Verification.**
- A month with 3 confirmed bookings, 1 live hold and 1 block renders 5 distinguishable entities, each labelled with its status.
- Times render in Africa/Kigali regardless of browser timezone — the Playwright test runs with `TZ=America/New_York` and asserts the same displayed time.
- One month issues a bounded number of Prisma queries (asserted with a query-event counter) and the endpoint returns in under 500 ms at p95 against a seeded 500-booking dataset (spec §7).
- A booking overlapping a block renders with a conflict marker (the §6.4 aftermath).

**Assumptions.** One endpoint, `GET /api/admin/calendar?from=&to=` (inclusive Kigali dates, at most 62 days), issuing two queries whatever the range holds. The calendar shows what occupies time: `confirmed`, `completed`, `no_show`, and `pending_payment` only while its hold is live; cancelled and expired bookings belong to the bookings list (Task 19). The conflict marker uses the same measure as the §6.4 warning: the booking's session overlapping a block, not its buffer. This task also builds the minimum admin shell the views need: `/admin/login`, the token in `sessionStorage`, and a layout that sends a signed-out visitor to login. The views are drawn by **FullCalendar** (MIT, v6.1): month grid, and hourly week and day grids that open scrolled to 08:00, running in Africa/Kigali through its Luxon plugin so no browser zone can shift a time or a day. It fetches each visible range once through an event source; every event shows its status as text, and a booking inside a block carries the conflict marker plus an outline that stays visible when an overlap narrows it. The calendar route is lazy-loaded, so its ~300 kB never reaches a public visitor. Playwright specs answer `/api/*` with `page.route` and emulate the browser zone with `timezoneId`, because the `TZ` variable is ignored by Chromium on Windows. `npm test` stays Vitest-only; browser tests run with `npm run test:e2e`.

---

## Task 10 — Admin catalogue CMS

**Goal.** Create, edit, reorder, activate and deactivate services, packages and add-ons — everything the photographer sells (spec §3.4, §6.14).

**Dependencies.** Task 7.

**Verification.**
- Creating a service with a package and two add-ons persists and appears on the public list (Task 11 consumes it).
- Editing a package price does **not** change any existing booking's `package_price_rwf` — asserted against a pre-existing booking row.
- Deactivating a service removes it from the public list while its bookings stay readable with their snapshots (spec §6.14).
- Hard-deleting a package referenced by a booking returns 409 and the row survives — Prisma surfaces the FK `RESTRICT` as `P2003`, mapped to 409 rather than a 500.
- **Impossible package warning (spec §6.8):** saving a package whose `duration_minutes` exceeds `max(closes_minute − opens_minute)` across open days returns a warning naming the longest window. Saving is still permitted; the warning is not a block.
- FR name fields exist in the zod schema as optional and are not rendered in the v1 UI.

**Assumptions.** `cover_image_url` is a URL the admin pastes. No upload pipeline and no blob store — the brief specifies a service as "name, description, and price", and an upload dependency was bought for a field nobody asked for. The URL must be `https://` (a plain `http:` image would load as mixed content). Endpoints: `GET /api/admin/catalogue` returns everything in one response, plus `POST`, `PATCH` (partial, so activating or reordering sends one field) and `DELETE` for services, packages and add-ons. Reordering is the display-order field. A hard delete is allowed only when nothing references the row; the `RESTRICT` foreign keys decide, answered as 409 `in_use`. A package's service and an add-on's scope (one service, or every service) are fixed at creation. The §6.8 warning compares against weekly rules plus today's and future dated overrides, since a past override opens nothing; it is returned when a package is saved, not shown permanently on the package. The admin types the fee override as a percentage (37.5 → 0.375). "The public list" is `listPublicCatalogue()` (active services with their active packages and add-ons); Task 11's route should serve it.

---

## Task 11 — Public service browsing and price summary

**Goal.** The public list and detail pages where a visitor picks a package and add-ons and sees a live total, booking fee and remaining session fee (spec §3.1 steps 1–3, 7).

**Dependencies.** Tasks 2, 10.

**Verification.**
- A 40,000 package plus a 10,000 add-on shows total 50,000 RWF, booking fee 20,000 RWF (40%), session fee 30,000 RWF.
- A service with `booking_fee_rate_override = 0.300` shows 15,000 RWF on the same 50,000 total.
- **The API is authoritative for money.** It recomputes the quote server-side and ignores any total the client sends — a request carrying a tampered total is priced from the catalogue, not from the payload. Both quote implementations are asserted against the same 20-basket fixture in `docs/fixtures/quotes.json`.
- No processing-fee line appears anywhere (spec §3.1 step 7, A-4b).
- The non-refundable notice is present on the summary before any payment control is reachable.
- Only `is_active` services and packages render; a deactivated slug returns not-found.
- Lighthouse mobile LCP under 2.5 s on service detail, served by Express from the built bundle.

---

## Task 12 — Public availability calendar and slot picker

**Goal.** Surface the availability engine to visitors: pick a date, see only genuinely bookable starts for the chosen package (spec §3.1 steps 4–5).

**Dependencies.** Tasks 5, 11.

**Verification.**
- `GET /api/availability?packageId=…&month=2026-10` returns only starts satisfying all five rules; a snapshot test pins the response for a fixture month.
- The response contains no block reasons, client names or booking ids — asserted against the raw JSON.
- Selecting a longer package re-queries and returns fewer starts on the same day.
- A slot confirmed between page load and click produces a clear "just taken" state with a refreshed calendar rather than a failed submit (spec §6.1, client half).
- The picker is fully keyboard-operable. (Accessibility is verified once, on the whole flow, in Task 24 — not re-checked per screen.)
- No caching layer. v2.0 required a cacheable availability endpoint with invalidation on confirmation: a second source of truth for availability, in a project whose entire premise is having one.

---

## Task 13 — Booking creation

**Goal.** Turn a chosen slot and a filled form into a `pending_payment` booking with a 30-minute hold, all snapshots written and the fee frozen (spec §3.1 steps 6–8, §6.13).

**Dependencies.** Tasks 6, 12.

**Verification.**
- A successful submit creates one `booking` (`pending_payment`), one `client` (or reuses one matched on lowercased email), and `booking_addon` rows with `stage = 'at_booking'`.
- Every snapshot column is populated: `service_name_snapshot`, `package_name_snapshot`, `package_price_rwf`, `package_duration_minutes`, `package_photo_count`, `contact_name`, `contact_email`, `contact_phone`, `booking_fee_rate`, `booking_fee_rwf`.
- Editing the package price afterwards leaves all of them unchanged.
- Changing the client's phone on a later booking does not alter the first booking's `contact_phone` (`data-model_v2.md` fix #9).
- `ends_at = starts_at + package_duration_minutes`; `buffer_ends_at = ends_at + 30 min`.
- `reference` matches `/^BKY-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$/` and a forced collision retries rather than failing.
- The API validates with its own zod schema and trusts nothing from the client; a request bypassing the UI with an out-of-hours or inside-lead-time slot is rejected 422. The frontend's schema is a UX convenience with no authority.
- The consent checkbox is required; omitting it returns 422, and a successful booking writes `consent_at`. Law N° 058/2021 requires consent to be **demonstrable** — a checkbox that persists nothing proves nothing.

---

## Task 14 — Outbox worker

**Goal.** Build the queue that delivers everything the system sends, with backoff, dedupe and an admin alert on exhaustion. Every later notification depends on it, and it is the only retry mechanism in the system (spec §6.17, `data-model_v2.md` §5.13).

**Dependencies.** Task 3.

**Verification.**
- Enqueuing twice with one `dedupe_key` inserts one row (`P2002` on the second) and the caller treats it as success.
- A throwing handler leaves the row `pending` with `attempts` incremented and `next_attempt_at` pushed out exponentially.
- Past the attempt ceiling the row becomes `failed` **and** an `admin_alert` row is enqueued carrying `last_error`.
- The queue query uses the partial index — `EXPLAIN` shows an index scan, not a sequential scan. (v2.0 tested this against 100,000 rows and tested two parallel workers; one Node process and a few thousand rows a decade justify neither.)
- The worker starts with the API process and stops cleanly on `SIGTERM` without abandoning a claimed row in `processing`.

---

## Task 15 — Email templates and rendering

**Goal.** Author and wire all ten transactional templates in English through the translation layer, so later tasks enqueue a template name rather than composing copy (spec §4.1).

**Dependencies.** Task 14.

**Verification.**
- All nine render from fixture payloads without error: `booking_confirmation`, `admin_new_booking`, `session_fee_request`, `payment_receipt`, `photo_delivery`, `cancellation`, `reschedule`, `access_link_resend`, `admin_alert`. (`booking_invite` is gone with the invite flow.)
- `admin_alert` covers every message addressed to the photographer that is not a new booking: payment received, retries exhausted, login lockout, refund due. Each variant renders from its own fixture.
- Every rendered email shows times in Africa/Kigali and integer RWF, asserted against the same `docs/fixtures/format.json` the frontend uses — snapshot-tested.
- `booking_confirmation` contains the reference, date/time, location, amount paid, amount outstanding and the access link, and contains the raw token nowhere except inside that link.
- A test asserts every `template` value in the `outbox` CHECK constraint has a matching template file, and vice versa.
- Links point at `WEB_ORIGIN`, never at the API host.

---

## Task 16 — Payment adapter and MTN MoMo direct

**Goal.** Define the `PaymentProvider` interface and implement MTN MoMo Collections against the sandbox, generating `our_ref` before the provider is called (spec §4.3, `data-model_v2.md` fix #3).

**Dependencies.** Task 13.

**Verification.**
- Initiating inserts a `payment` row with `status='initiated'`, `provider='mtn_momo_direct'` and a populated `our_ref` **before** any HTTP call — asserted by inspecting the row with the provider client stubbed to throw.
- A provider timeout leaves the row `failed` with `failure_reason` set, the booking still `pending_payment`, and the hold intact.
- `our_ref` is sent as the MTN `X-Reference-Id` header — asserted against the captured request.
- `amount_rwf` equals `booking_fee_rwf` exactly and is never updated afterwards.
- **Method gating (spec §6.19):** with `PAYMENT_PROVIDER=mtn_momo_direct` the pay page offers MTN MoMo only; Airtel and card controls are absent from the DOM, not disabled. The web app reads the available methods from an API capability endpoint rather than hardcoding them.
- A second initiate for a booking with a succeeded booking fee returns 409.
- **Confirmation page (spec §3.1 step 10):** the provider's return URL lands on a page that shows the booking as pending and polls its status. It never claims success before the webhook has confirmed one, states that MoMo settlement can take a minute, and tells the client the confirmation email is coming if they close the tab. Verified by holding the webhook back and asserting the page stays pending rather than showing a booking as confirmed.

**Assumptions.** MTN sandbox credentials via environment variables. Production MTN access depends on **R-3** and is not required here.

---

## Task 17 — Webhook ingestion and booking confirmation

**Goal.** Accept provider callbacks safely — store first, verify, dedupe, apply forward-only — then confirm the booking, generate the access token and enqueue both emails (spec §3.1 steps 10–11, §6.9, `data-model_v2.md` §7.3).

**Dependencies.** Tasks 15, 16.

**Verification.**
- A valid `succeeded` event moves the booking to `confirmed`, nulls `hold_expires_at`, sets `confirmed_at`, writes `access_token_hash` and `access_token_expires_at`, and enqueues `booking_confirmation` and `admin_new_booking`.
- **Duplicate delivery:** the same `(provider, event_id)` twice yields one `applied` and one `ignored` row, and one `booking_confirmation` outbox row.
- **Out of order and terminal statuses:** an event arriving for a payment already `succeeded`, `failed` or `refunded` is stored `ignored` and changes nothing (`data-model_v2.md` §7.3). Tested for all three, including the `failed → succeeded` case that v2.0's rank ladder would have wrongly applied.
- **Bad signature:** stored with `signature_valid = false`, status `ignored`, nothing applied, 200 returned so the provider stops retrying.
- **Unmatched event:** an event whose `our_ref` matches no payment is stored `ignored` and remains inspectable.
- **Late webhook, slot free (spec §6.9):** a `succeeded` event for an `expired` booking whose slot is still free re-confirms it.
- **Late webhook, slot taken:** leaves the booking `expired`, sets the payment `refund_due`, enqueues an `admin_alert`.
- The webhook route reads the **raw body** for signature verification — a test proves `express.json()` does not consume it first.
- The plaintext access token appears in the outbox payload and in no `booking` column — asserted by a column scan.

---

## Task 18 — Client booking page

**Goal.** The token-addressed page where a client checks status, cancels, pays the session fee and reaches their photos — the whole client-side return experience (spec §3.9, §6.10, §6.21).

**Dependencies.** Task 17.

**Verification.**
- A valid token renders that booking; `access_token_last_used_at` updates.
- An invalid, expired or superseded token renders a generic "link not valid" page and returns 404 — not 403, which would confirm the booking exists.
- Passing another booking's id or reference in any parameter changes nothing — scope comes from the token alone (spec §2.2 enforcement).
- The token travels in the URL path and is never sent to any analytics or error-tracking service — asserted by a scrubbing test on the error reporter.
- **Client cancel (spec §6.10):** confirming sets `cancelled_by_client`, releases the slot (verified by it reappearing in availability), enqueues both cancellation emails, and does **not** refund — the payment stays `succeeded`.
- The non-refundable warning appears in the cancel confirmation.
- **Cancelling with a session fee already paid (spec §6.10):** the booking fee stays `succeeded` and forfeited, while the paid session fee is marked `refund_due` and an `admin_alert` is enqueued. This case existed in the spec and was verified by no task.
- A booking with an outstanding session fee shows a payment control; a fully paid one does not.
- Amounts come from `bookingTotals()` on the server, never recomputed in the browser. A cancelled or no-show booking shows **nothing outstanding** — the bug v2.0's view would have produced.

---

## Task 19 — Admin bookings list, detail and lifecycle actions

**Goal.** Everything the photographer does to a booking after it exists: reschedule, cancel with refund flagging, complete, mark no-show, and resend the access link (spec §3.6, §6.11, §6.12, §6.16, §6.21).

**Dependencies.** Task 18.

**Verification.**
- **Reschedule:** a free slot keeps `id`, `reference`, `access_token_hash` and all payments; writes `original_starts_at` on the **first** move only and `rescheduled_at` on every move; **recomputes `buffer_ends_at` from the new `ends_at`**; releases the old slot; enqueues `reschedule`. A reschedule that moved the booking without moving the buffer would either hold time the booking no longer occupies or violate its own CHECK — undefined in v2.0. An occupied slot returns 409 from the surfaced `23P01`.
- **Admin cancel (spec §6.11):** sets `cancelled_by_admin`, releases the slot, enqueues `cancellation`, sets the booking-fee payment `refund_due` — the full-refund policy from A-5.
- **Record refund (spec §6.16):** entering a reference moves the payment to `refunded`, sets `refunded_at`, and `collected_rwf` drops accordingly. No provider API is called — asserted by a stub that fails the test if invoked.
- **No-show (spec §6.12):** sets `no_show`, the slot stays occupied (still absent from availability), the booking fee stays `succeeded`, no session fee is owed, no client email is enqueued.
- **Resend access link:** issues a new token, invalidates the old one (old URL now 404s), enqueues `access_link_resend`.
- The list filters by status and date range and paginates with a stable cursor.

---

## Task 20 — Post-shoot session fee

**Goal.** Complete the shoot, add post-shoot add-ons, request the remaining money and take it (spec §3.5 steps 1–4, §6.15).

**Dependencies.** Task 19.

**Verification.**
- Marking `completed` sets `completed_at` and unlocks the post-shoot add-on editor.
- Adding a 15,000 add-on with `stage='post_shoot'` raises `grandTotalRwf` and `outstandingRwf` by 15,000 — the v1 under-reporting bug is proven absent.
- "Request session fee" creates a `payment` with `kind='session_fee'` and `amount_rwf` equal to the then-outstanding amount, and enqueues `session_fee_request`.
- **Frozen amount:** adding another add-on after initiation does **not** change that payment's `amount_rwf`.
- **Second request (spec §6.15):** after the first session fee succeeds, adding an add-on and requesting again creates a **second** `session_fee` payment rather than editing the settled one, and both succeed without violating the booking-fee partial unique index.
- Paying enqueues `payment_receipt` and leaves `outstandingRwf` at 0.

---

## Task 21 — Photo delivery

**Goal.** Attach the external link with its expiry and send the branded delivery email — the last step of the job (spec §3.5 steps 5–7, §6.20, A-7, A-8).

**Dependencies.** Task 20.

**Verification.**
- Saving a link sets `delivery_url` and defaults `delivery_expires_on` to today + 90 days; the admin can override the date.
- A non-https URL is rejected 422 by both the zod schema and the database CHECK.
- "Send photos" enqueues `photo_delivery` containing the link **and the expiry date as text**, and sets `delivery_sent_at`.
- The client page shows the link before expiry and the expired message after — verified by advancing the injected clock past end-of-day Kigali.
- Replacing the link and resending creates a new outbox row with a distinct `dedupe_key`; the previous row is untouched.
- No download-count UI exists anywhere — the hybrid model cannot know it (`data-model_v2.md` §5.9).

---

## Task 22 — Google Calendar one-way push

**Goal.** Mirror confirmed bookings into the photographer's calendar so he sees them on his phone, without letting Google influence availability (spec §3.7, §6.17, A-9).

**Dependencies.** Tasks 14, 19.

**Verification.**
- Confirming enqueues `gcal_create`; processing stores `gcal_event_id` on the booking.
- Rescheduling enqueues `gcal_update` and moves the event; cancelling and no-show enqueue `gcal_delete`.
- The event body carries client name, service, package, location and reference, with times in Africa/Kigali.
- **Failure isolation (spec §6.17):** with the Google client stubbed to fail, the booking still confirms, the client still gets their confirmation email, the outbox row retries then fails, and an `admin_alert` is enqueued carrying the error.
- **No inbound path:** grep proves no code reads Google events; a test asserts availability output is identical with the calendar stub returning a conflicting event.
- With the credential absent from the environment, pushes are **skipped** rather than failed, and nothing else in the system changes behaviour — the calendar is a mirror, and its absence is not an error. (v2.0 verified "disconnecting", which no UI offers, because the credential lives in configuration.)

**Assumptions.** One admin, one calendar. **This task includes obtaining the credential**, which no task previously owned: creating the Google Cloud project, enabling the Calendar API, completing the OAuth consent screen, and running a one-off local script that exchanges an authorisation code for a refresh token, which is then stored encrypted in API environment configuration. Budget for the consent screen being the slow part.

---

## Task 23 — Privacy, consent, erasure and retention

**Goal.** Meet Law N° 058/2021 obligations concretely: the notice, the consent record and the erasure routine (spec §7, `data-model_v2.md` §10).

**Dependencies.** Task 21.

**Verification.**
- The privacy page states what is collected, the retention periods, and that photo files live with a third-party host the site cannot delete from.
- **Erasure:** running it on a client with two bookings and three payments anonymises `client`, sets both bookings' `contact_*` and `location_text` to `[erased]`, nulls `special_requests`, `access_token_hash` and `delivery_url`, nulls matching `webhook_event.payload` and `outbox.payload`, and sets `recipient` to `[erased]`.
- After erasure, `bookingTotals()` returns identical amounts — financial history survives (`data-model_v2.md` §10.2).
- Both access links 404 after erasure.
- **No purge job exists.** v2.0 specified three retention windows with boundary tests, on a database that holds a few thousand rows after five years. Scheduled deletion is not a legal obligation; erasure on request is, and it is built.
- `consent_at` **survives** erasure — it is the evidence that consent was given, and destroying it would defeat the obligation the checkbox exists to satisfy.
- There is no client-facing erasure control. P-14 is exercised by emailing the photographer, who runs the admin routine — matching spec §2.2, which v2.0 marked as a client capability that no task built.- Erasure runs in a single `prisma.$transaction` — a partial erasure is not a possible outcome.

---

## Task 24 — Security, accessibility, observability, and going live

**Goal.** Close out the non-functional requirements as testable behaviour rather than intentions, and put the thing on a server with a backup that has actually been restored (spec §7, §6.22, §2.2 enforcement).

**Dependencies.** Task 23.

**Verification.**
- **Three access modes, three tests:** every `/api/admin/*` route returns 401 unauthenticated; every client-token route returns 404 for an unknown, expired or superseded token; every public route is reachable anonymously. v2.0 required a table-driven test enumerating 30 permission rows × 3 roles — a permanent tax on adding an endpoint, for a system with exactly three access modes.
- **Rate limits (spec §6.22):** exceeding the booking-creation limit per IP and per email returns 429, and payment initiation and admin login are limited too. A public endpoint that creates rows and calls a payment provider needs this; the specific ceilings are developer defaults, not client requirements.
- Responses carry HSTS, `X-Content-Type-Options`, a restrictive `Referrer-Policy` and a CSP blocking inline script — default output from one middleware, and now required by spec §7 rather than appearing only here.
- Webhook and internal job endpoints reject unsigned or unauthenticated calls with no side effects.
- No stack trace, Prisma error text or SQL reaches a client response — the error middleware maps everything to a code and a message.
- One axe scan across the booking flow: zero critical violations, and the flow completes by keyboard alone. Checked once here rather than gated per screen in Tasks 11 and 12.
- Lighthouse mobile on the two heaviest public pages: LCP under 2.5 s, initial payload under 500 KB excluding images.
- An induced exception is logged as structured JSON to stdout; an induced payment-webhook failure raises an admin email alert. No third-party error-tracking vendor — none was budgeted, and one alert address covers a business with one operator.
- **Deployment:** the backend runs as its own API-only process on its host, reachable over HTTPS at its own domain; the frontend build deploys separately to a static host on a different domain. `WEB_ORIGIN` on the backend matches the frontend's deployed URL exactly — the CORS allowlist and every emailed link depend on it.
- **Backups:** a daily database dump with 7-day retention, and a restore **performed at least once** into a scratch database with the schema test suite passing against it. An untested backup is not a backup, and no task previously owned this.

---

## Task 25 — Flutterwave adapter and production cutover

**Goal.** Add the second `PaymentProvider` implementation, unlocking Airtel Money and cards, and prove the cutover leaves historic MTN payments intact (spec §4.3, §6.18, §6.19, C-4).

**Dependencies.** Tasks 17, 24.

**Verification.**
- With `PAYMENT_PROVIDER=flutterwave`, the capability endpoint reports MTN MoMo, Airtel Money and card, and the pay page renders all three; `our_ref` is sent as `tx_ref` and the returned id lands in `provider_ref`.
- **Cutover integrity (spec §6.18):** a database holding succeeded `mtn_momo_direct` payments still returns correct totals after the switch, and an in-flight MTN webhook arriving post-switch is still accepted by the MTN handler — both routes stay mounted.
- Refund flagging resolves against the payment's own `provider`, not the configured one.
- The Flutterwave webhook verifies its signature against the raw body; a forged payload is stored `signature_valid = false` and applies nothing.
- The runbook documents the switch, the rollback, and that card and Airtel acceptance testing is only possible after cutover (**R-3**).

**Assumptions.** Flutterwave test credentials in development. Production settlement account ownership is **R-3** and blocks go-live, not this task.

---

## Coverage map

Every spec §6 edge case has an owning task. Four are split across two tasks — the mechanism in one, the failure behaviour in the other — and are marked below.

| Spec ref | Task |
|---|---|
| §6.1 double booking · §6.2 abandoned payment | 6 |
| §6.3 blocks · §6.4 block over confirmed booking | 8 |
| §6.5 timezone | 2 |
| §6.6 lead time · §6.7 buffer | 5 |
| §6.8 package too long · §6.14 deactivation | 10 |
| §6.9 webhook duplicate/late | 17 |
| §6.10 client cancel · §6.21 lost link | 18 |
| §6.11 admin cancel/reschedule · §6.12 no-show · §6.16 refunds | 19 |
| §6.13 price change after booking | 13 |
| §6.15 post-shoot add-ons | 20 |
| §6.17 calendar push failure | 14 retry · 22 isolation — **split** |
| §6.18 provider cutover · §6.19 method gating | 16 MTN half · 25 Flutterwave half — **split** |
| §6.20 delivery expiry | 21 |
| §6.22 spam | 24 |
| §6.23 login attack | 7 lockout · 24 rate limit — **split** |

## Not in this plan, deliberately

Out of scope per spec §4.2 and therefore absent by design: French content, SMS and WhatsApp, built-in photo hosting, two-way calendar sync, admin-created bookings with offline payment records (**R-1**), automated refunds, client-initiated rescheduling, custom booking form fields, reviews, discounts, multi-day bookings, accounting exports, native apps.

Removed in revision 2.1 after the documentation audit, each because nothing in `brief.md` or `clien-answers.md` asked for it: TOTP two-factor and session-epoch revocation, the in-product offline invite link, scheduled data purging, uploads and blob storage, locale-prefixed routing and the no-hardcoded-strings rule, the `booking_totals` view, the four-rank webhook ladder, multi-worker outbox claiming, the availability response cache, the 30-row permission-matrix test, and a third-party error-tracking vendor. The exclusion constraint, the claim transaction, the price snapshots and Task 3's constraint tests were explicitly **not** cut — they cost about one task between them and they are the reason the client is paying for this.
