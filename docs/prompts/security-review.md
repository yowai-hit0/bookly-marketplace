# Security review: Bookly (code, dependencies, local exploits, passive live checks)

You are doing a full security review of Bookly, a photography booking site. It has:
- a React/Vite SPA (`frontend/`, deployed on Vercel)
- an Express 5 + Prisma 7 API (`backend/`, deployed on Render, free tier)
- PostgreSQL on Neon

There are clients, who book and pay without an account and use emailed links, and one admin, the photographer.
Payments go through MTN MoMo and Flutterwave. Email goes through Resend or Brevo via an outbox worker.

Live deployment (passive checks only, see rule 2):
- Frontend: <https://bookly.example>
- API: <https://api.bookly.example>

## Hard rules, which override anything else in this prompt
1. **Never use the Neon database.** `backend/.env` points at production. For anything that runs the app or the tests, override `DATABASE_URL`, `DIRECT_URL` and `TEST_DATABASE_URL` with a local Postgres (for example `postgresql://postgres:<pw>@localhost:5432/bookly_security`). If no local Postgres is reachable, stop and ask me. Do not fall back to `.env`.
2. **The live site gets passive traffic only:**
   - `GET`/`HEAD`/`OPTIONS` requests that any visitor's browser could make
   - at most a few dozen requests in total, spaced out
   - no `POST`/`PUT`/`PATCH`/`DELETE`
   - no login attempts
   - no injection payloads
   - no fuzzing, brute force or load
   - no requests carrying tokens or booking references

   Every attack is proven against the local copy.
3. **No real side effects.** Locally, unset `RESEND_API_KEY` and `BREVO_API_KEY` so mail goes to the file provider (`MAIL_OUTPUT_DIR`). Leave the payment credentials unset, or use sandbox credentials only. Never contact a real payment provider with production keys.
4. **Do not print secrets.** Never echo the values in `.env` files, tokens or keys into the transcript or the report. Refer to them by variable name.
5. **Report first.** Do not change application code until I have approved the report (see Output).

## Method
- Start by reading `docs/specs_v2.md`, `docs/plan.md` and `docs/audit-fixes.md`. They record deliberate security decisions, for example "no CSRF middleware because admin auth is a bearer token". Test whether each decision actually holds; don't re-report a decision as a bug unless you can show it fails.
- Map the attack surface from the code: every route in `backend/src/routes/` and `backend/src/app.ts`, its auth requirement, its input validation (`routes/validation.ts`, zod), and the data it touches.
- For each finding, decide **Confirmed** (you ran a proof of concept against the local copy, or the code path is unambiguous) or **Suspected** (it needs a condition you couldn't reproduce). No speculative filler. A short report of real issues beats a long one of theoretical ones.
- Read the code that a vulnerability would go through; don't infer it from names.

## Areas to cover (at minimum)
**Admin authentication** (`backend/src/auth/`)
- JWT issuance and verification with `jose`: algorithm pinning, expiry, `SESSION_SECRET` handling
- revocation through the password-hash fingerprint
- login lockout: race conditions, whether the unknown-email path is distinguishable by timing or response
- password reset: token entropy, single use, expiry, user enumeration
- Argon2 cost and use
- token storage in `sessionStorage` (`frontend/src/admin/session.ts`)

**Access control**
- Every `/api/admin/*` route requires auth.
- IDOR on nested ids (`/bookings/:id/notes/:noteId`, `/bookings/:id/addons/:addonId`, `/payments/:id/refund`, catalogue ids): can a child that belongs to a *different* booking be touched?
- Client endpoints (`/api/booking/:token`, `.../cancel`, `.../email`, `.../payments`) reach only their own booking.

**Client capability tokens** (`booking/access-token.ts`, `access-link.ts`, `link-lookup.ts`, `email-change.ts`, `payments/checkout-link.ts`)
- entropy, constant-time comparison, expiry and rotation
- leakage through URLs: Referer, logs, the `localStorage` storage in `frontend/src/lib/stored-booking.ts`
- enumeration and abuse of "email me my links" and its rate limiter
- the email-change confirmation flow, including takeover of a booking by changing its email

**Payments** (`backend/src/payments/`)
- Webhook authenticity: the Flutterwave hash check, the MTN `/:ourRef/:signature` callback URL.
- Replay, and out-of-order events.
- Whether the amount and currency are verified against what is owed.
- Whether a client can set a price or amount (quote, basket, session fee, add-ons).
- Double settlement, and races between a webhook, the reconciler and a cash payment.
- Refunds and cash payments: who can trigger them, and what limits apply.

**Booking logic**
- double booking and hold races (`claim.ts`, `hold-sweeper.ts`)
- state-machine bypass (cancel, reschedule, complete, no-show on the wrong status)
- negative or huge quantities, and pagination or limit abuse in list endpoints

**Injection**
- every `$queryRaw`, `$executeRaw`, `Prisma.raw`, `Prisma.sql` and `$queryRawUnsafe`
- HTML injection into email templates (client-supplied names and notes reaching the admin's inbox), and email header injection
- XSS in the SPA: rendered user content, and `href`s built from stored URLs such as the photo-delivery link (`javascript:` schemes)
- open redirects
- SSRF wherever the server fetches a URL

**HTTP hardening**
- the CORS config in `app.ts`
- whether `trust proxy` is correct behind Render, and whether it can be spoofed to bypass rate limits through `X-Forwarded-For`
- security headers on the API and in `frontend/vercel.json` (CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, frame-ancestors)
- the body-size limit on `express.json()`
- error responses leaking internals
- logs containing PII or tokens

**Secrets and build**
- secrets anywhere in git history (`git log -p`), not just the working tree
- `.env` files committed or not ignored
- `VITE_*` variables that end up in the bundle
- source maps shipped in `frontend/dist`
- the Neon `sslmode` and connection settings
- privileges of the database user

**Dependencies**
- `npm audit` in `backend/` and `frontend/`
- for each high or critical advisory, whether the vulnerable code path is actually reachable in this app

**Passive live checks**
- response headers and TLS on both URLs
- a CORS preflight from a foreign `Origin`
- exposed files (`/.env`, `/.git/HEAD`, `*.map`)
- what `/api/health` and the error responses reveal
- whether the deployed headers match the repo config

## Output
1. Write `docs/security-review-<YYYY-MM-DD>.md`:
   - **Summary:** counts by severity, and the top three risks in plain words.
   - **Findings**, ranked Critical, then High, Medium, Low, Info. Each finding has: title, severity, Confirmed or Suspected, location (`file:line`), how an attacker exploits it (concrete steps), the proof-of-concept request or script you ran locally, the impact, and the recommended fix.
   - **Checked and fine:** areas you verified as sound, one line each, so I know they were covered.
   - **Out of scope / not tested,** and why.
2. Then stop and give me the summary in chat. Wait for my approval before fixing anything.
3. When I approve fixes: one finding per commit. Add a regression test that fails before the fix and passes after, using real local PostgreSQL like the existing tests, not mocks. Run `npm run typecheck`, `npm run lint` and `npm test` in the affected app.
