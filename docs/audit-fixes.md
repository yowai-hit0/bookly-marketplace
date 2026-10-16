# Audit response — revision 2.1

What changed in `specs_v2.md`, `data-model_v2.md` and `plan.md` after the documentation audit, and what deliberately did not.

**Skipped on instruction:** audit finding 2.2 (consolidating to one payment provider). The MTN-direct-then-Flutterwave phasing stays as specified — it is a deliberate choice, not an oversight.

---

## 1. Defects that would have failed at runtime

| # | Problem | Fix |
|---|---|---|
| 1.2 | `client.phone`, `webhook_event.payload` and `outbox.payload` were `NOT NULL`, but the erasure and purge routines set all three to `null`. Every erasure would raise `23502`, and Task 23 verified those exact nullings as passing behaviour. | All three columns are now nullable, with the reason recorded next to each: they are nullable *because* erasure touches them. Task 3 gained a nullability test. |
| 1.3 | `booking_totals` computed `outstanding = grand_total − collected` with no status filter — reporting the session fee as owed on a `no_show`, contradicting spec §6.12. Worse, `collected` counted only `succeeded`, so an admin cancellation flipping a payment to `refund_due` made `outstanding` **jump by the fee** before any money moved. | Totals are now a status-aware function (`data-model_v2.md` §6.1). Terminal-unpaid statuses owe nothing; `refundDueRwf` is reported separately rather than netted off, because a refund owed is not the same fact as a refund made. |
| 1.4 | The payment state machine made `failed` terminal; the rank ladder ranked `failed` below `succeeded`, so a stray event could resurrect a dead payment. Nothing tested it. | The ladder is gone. One rule replaces it: an event for a payment already `succeeded`, `failed` or `refunded` is recorded and ignored. Task 17 now tests all three, including `failed → succeeded`. |
| 1.9 | Consent had no storage anywhere. Law N° 058/2021 requires consent to be **demonstrable**; a checkbox that persists nothing proves nothing. | `booking.consent_at` added, written on booking, and explicitly **kept** through erasure — destroying it would defeat the obligation it exists to satisfy. |
| 1.12 | Task 5 verified that a 09:00–10:00 booking makes "10:00 and 10:15 unavailable" — on a 30-minute grid that never produces 10:15. | Corrected to 09:30 and 10:00 unavailable, 10:30 the first free start. |
| 1.7 | Three wrong cross-references: §6.8 cited for booking-fee forfeiture (it is the long-session rule), §6.7 for late webhooks (it is the buffer rule), and R-6/R-7 transposed in §8.2. | All corrected. Four `§5.x` references orphaned by the §5 rewrite now point at `data-model_v2.md`. |
| 1.15 | Task 3 asserted `\dt` lists 13 tables. Prisma creates `_prisma_migrations`. | Now asserts 14: 13 application tables plus Prisma's. |
| 1.18 | `buffer_ends_at` on reschedule was undefined in every document. A reschedule that moved the booking without moving the buffer would hold time the booking no longer occupies, or violate its own CHECK. | Defined as recomputed from the new `ends_at`, and verified in Task 19. |

---

## 2. Documents realigned

**`specs_v2.md` §5 has been gutted.** It described fourteen entities against a model that has thirteen — still listing `delivery`, `notification_log` and `booking_access_token` as tables, still asserting that a unique `provider_ref` makes webhooks idempotent (the data model calls that a defect), still giving `working_hours` a shape that cannot express the dated overrides the whole R-4 answer depends on. Five separate audit findings collapsed into one root cause: a duplicated schema drifts.

§5 is now half a page — the shape of the model and a pointer to `data-model_v2.md`, which is authoritative. Behavioural rules stayed in §6 where they belong.

Also realigned: spec §3.1 step 4 listed a narrower occupancy set than the exclusion constraint enforces (missing `completed` and `no_show`); §2.2's enforcement paragraph named `notification_log`, a table deleted two revisions ago; §4.1 listed eight email templates against the model's ten.

---

## 3. Work that had no owner

Four things the documents required and no task built.

| Gap | Now owned by |
|---|---|
| **The settings screen.** P-15, P-24 and P-30 all require editing settings; Task 4 built a seed and a read accessor. | Task 8, renamed "Admin availability and settings" |
| **The post-checkout confirmation page.** The screen a client watches for 30+ seconds while a MoMo webhook settles. Spec §4.1 listed it; nothing built it. | Task 16, with a test that holds the webhook back and asserts the page stays pending |
| **Google OAuth setup.** Task 22 assumed a refresh token already existed. | Task 22, explicitly: Cloud project, API enablement, consent screen, one-off token exchange |
| **Deployment and backups.** Spec §7 promised daily backups with a documented restore. | Task 24, requiring a restore actually performed into a scratch database with the schema tests passing against it |

---

## 4. Removed

Each of these was untraceable to `brief.md` or `clien-answers.md`, or disproportionate for one photographer with a handful of bookings a week.

| Removed | What is lost | Why |
|---|---|---|
| Two deployables → **one** | Nothing | Express serves the built bundle. Removes the CORS allowlist, the CSRF token flow, the cross-origin cookie argument, and **closes R-7 entirely** — prerendering was only a question because the pages came from a different origin than their data |
| TOTP + `session_epoch` | Two-factor; "log out everywhere" | One user, one browser. A changed password already invalidates the cookie. Nothing in the brief or answers raises admin security at all |
| The offline invite link | A pre-filled URL and funnel tracking | Pasting the booking URL into WhatsApp does the same job in zero lines. R-1 never established anyone would follow such a link |
| `booking_totals` view | SQL-level reporting | A view could not express "nothing is owed on a no-show" and sat outside Prisma's types. Spec §4.2 excludes the revenue dashboard that would justify it |
| The four-rank webhook ladder | Nothing | One terminal-status guard covers every case and does not contradict itself |
| Scheduled purge jobs | Bounded growth | Three retention windows and boundary tests on a database that holds a few thousand rows after five years. Erasure on request is the legal obligation, and it stays |
| Uploads and blob storage | An image pipeline | The brief specifies a service as "name, description, and price". `cover_image_url` is now a URL the admin pastes |
| Locale-prefixed routing + the no-hardcoded-strings rule | Cheapest possible path to French | The expensive half of i18n readiness, paid for a deliverable R-2 concedes may never ship. The cheap half — a translation layer and nullable `_fr` columns — stays |
| Multi-worker outbox claiming, the 100k-row `EXPLAIN` test | Horizontal scaling | One Node process. The row count targeted arrives in roughly 200 years |
| The availability response cache | Latency | It was a second source of truth for availability, in a project whose premise is having one |
| The 30-row permission-matrix test | Exhaustive coverage | Replaced by three tests for three access modes. The matrix stays as documentation; the enumerating test was a permanent tax on adding an endpoint |
| Third-party error tracking | A dashboard | Structured JSON to stdout plus an email alert. No vendor was budgeted; one alert address covers one operator |
| `admin_user_id` on `working_hours` and `availability_block` | A second photographer | Spec §4.2 forbids one. Two FKs and a join predicate in every availability query for a role that cannot exist |
| WCAG gating on every screen | Per-screen enforcement | One axe scan across the booking flow in Task 24, instead of the same check in three tasks |

---

## 5. Not changed, deliberately

**The core is untouched.** The GiST exclusion constraint, the claim transaction with in-transaction stale-hold expiry, the price snapshots, and Task 3's overlap, buffer-release, double-deposit and predicate-agreement tests. They cost about one task between them and they are the entire reason the project exists.

**The payment phasing** (audit 2.2) stays as specified, on instruction.

**`webhook_event`** survives the cull of its rank ladder. MoMo disputes are real and storing the raw callback is cheap.

---

## 6. Provenance flags added

The audit's sharpest point: several "resolved" decisions were made **for** the photographer, not **by** him. Three are now marked ⚠ in spec §8.1, and the sign-off says approving the document approves them too.

| Decision | What he actually said |
|---|---|
| **A-8** — 90-day delivery-link expiry | Nothing. The answer to the expiry question is blank. This is a developer default recorded as settled |
| **A-10 / R-4** — Mon–Fri 09:00–17:00 | Only "as long as a day is available, or maybe 2 hours before when it's working hours" — which sets the notice period and nothing else. The brief sells **event coverage**; Kigali events are weekend work. As seeded, nobody can book a Saturday wedding |
| **C-1** — removing approve/decline | A "yes" to an either/or question. `brief.md` names "confirm or decline booking requests" as a core feature **twice**. A paid deposit is a strong argument for auto-confirming, but it is our argument |

---

## 7. Still needs a human

- **R-3** — whose MTN and Flutterwave accounts settle the money, and when the cutover happens. Blocks production, not development.
- **R-4** — the working-hours conversation above. A settings edit, not a code change, but it must happen before launch content goes live.
- **R-6** — no service names, prices, durations, photo counts or image URLs exist. All 25 tasks can pass with nothing sellable on the site.
- **C-1** — confirm the removal of approve/decline directly with the photographer.

---

## 8. Addendum — revision 2.2: two deployables, reinstated

This does not rewrite §4's "Two deployables → one" row above — that row is an
accurate record of what revision 2.1 decided and why it seemed right at the
time. It is superseded by `specs_v2.md` revision 2.2: the frontend and backend
are two separately-deployed apps on two separate domains again — not
subdomains of one registrable domain, so this is cross-site, not merely
cross-origin.

- **R-7 is reopened, not solved** (`specs_v2.md` §8.2). Public-page SEO is an
  open question again; this change adds no SSR or prerendering.
- **CORS is reinstated**: the API allowlists `WEB_ORIGIN` with credentials
  enabled, echoing that single origin — never a wildcard.
- **The admin session cookie (Task 7, not yet built) becomes
  `SameSite=None; Secure`**, which needs a CSRF token flow that `SameSite=Lax`
  was previously providing for free — see `plan.md` Task 7.
- `backend/` no longer serves the built frontend at all; it is API-only. The
  static-serving block that was in `backend/src/app.ts` and its unused imports
  have been removed, not toggled behind an environment check.

---

## 9. Addendum — revision 2.3: bearer tokens replace the session cookie

This does not rewrite §8 above. §8 is an accurate record of what revision 2.2
decided: a `SameSite=None; Secure` admin session cookie, with a double-submit
CSRF token to replace what `SameSite=Lax` had provided for free. That design
was built as Task 7 and is superseded by `specs_v2.md` revision 2.3.

- **Admin auth is a JWT in `Authorization: Bearer`.** HS256 via `jose`, 8 hours,
  issuer- and audience-scoped, algorithm pinned on verification. It is returned
  in the login response body, never set as a cookie. No cookie is involved in
  admin auth at all.
- **The CSRF token flow is removed, not moved.** A browser never attaches a
  header the client sets in code, so a forged cross-site request arrives with no
  credential and is a 401. There is nothing left for a CSRF token to protect.
- **CORS stays allowlisted to `WEB_ORIGIN`, without credentials.** §8's
  "credentials enabled" existed only for the cookie.
- **Password-change revocation is kept.** The cookie's signature covered the
  password hash; the token instead carries an HMAC fingerprint of it, checked
  against the current hash on every request. A password change still revokes
  every issued token on the next request.
- **Logout is gone as an endpoint.** It only ever cleared cookies. A stateless
  token cannot be revoked server-side, so signing out is the client discarding
  it; revocation is a password change or rotating `SESSION_SECRET`.
- **Two consequences worth naming.** The third-party-cookie blocking that would
  have broken the admin session in Safari on a cross-site deployment no longer
  applies, whatever the two domains are. In exchange, script on the admin UI can
  read the token, so XSS matters more: the CSP in `specs_v2.md` §7 is now
  load-bearing, and the admin UI keeps the token in memory or `sessionStorage`,
  never `localStorage`.

Updated to match: `specs_v2.md` revision row, §2.2 enforcement and §7 (Security,
Implementation stack); `plan.md` Stack decisions (Admin session, Auth transport)
and Task 7; `data-model_v2.md` §5.1.
