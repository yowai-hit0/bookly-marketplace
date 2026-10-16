# Auth and security

Full rules for callers are in the [API conventions](/api/conventions); this page
is how it is built and where to change it. The design decisions are recorded in
`specs_v2.md` §7 and `audit-fixes.md` §9.

## Admin: a bearer JWT

`src/auth/`. Login (`attemptLogin`) verifies the email case-insensitively and
the password with Argon2id, then issues an HS256 JWT (`token.ts`): 8-hour
expiry, issuer- and audience-scoped, signed with `SESSION_SECRET`. It is
returned in the login response body and sent as `Authorization: Bearer` — never
a cookie, so there is no ambient credential for a cross-site request to borrow
and no CSRF-token flow to maintain.

`requireAdmin` (`auth/middleware.ts`) gates every `/api/admin/*` route except
the three `/auth/*` ones. It is mounted once in `routes/admin.ts`, and
everything registered after it is protected by construction — including paths
that do not exist, which answer `401` rather than revealing whether a route is
there.

Verification (`verifyAdminToken`) **pins the algorithm** to HS256, so a token
declaring `alg: none` or any other algorithm is refused before its signature is
considered, and requires `exp`. There are two revocation paths and no server-side
logout: the token carries an HMAC **fingerprint of the password hash**, checked
against the current hash on every request, so changing the password invalidates
every issued token on its next use; and rotating `SESSION_SECRET` invalidates
all signatures at once.

### Lockout and reset

Repeated failed logins lock the account for a rising interval
(`auth/admin-auth.ts`); the failure is claimed in one atomic UPDATE *before*
Argon2 runs, so a burst of concurrent guesses cannot all slip past the check.
Unknown email, wrong password and a locked account return one indistinguishable
`invalid_credentials`, and the unknown-email path still spends an Argon2 hash so
timing does not reveal which. Password reset is a single-use, time-limited token
stored only as a SHA-256 hash; the link carries the plaintext in a URL fragment,
which never reaches a server log.

## Clients: capability tokens

A client has no account. Scope comes entirely from an unguessable token in the
URL:

- **Access token** (`booking/access-token.ts`) — 256 random bits, base64url;
  only its SHA-256 is stored. It is the client's whole identity. `access.ts`
  resolves a booking from the hash and stamps `access_token_last_used_at`; an
  unknown, expired or superseded token returns `404`, never `403` (a `403`
  would confirm a booking exists). No route reads a booking id, reference or
  email from the request, so nothing a caller adds can widen scope.
- **Checkout token** (`payments/checkout-link.ts`) — an HMAC of the reference,
  good only for paying the booking fee while the hold lasts.
- **Email-change token** — confirms a change of contact email from the *new*
  address, so a link-holder who is not the client cannot redirect the booking's
  mail without also owning the new inbox.

All three derive from `SESSION_SECRET` via per-purpose keys (`payments/keys.ts`),
so a signature for one purpose is useless for another. Comparisons are
constant-time.

## HTTP hardening

- **CORS** (`app.ts`) — allowlisted to `WEB_ORIGIN`, origin echoed, never a
  wildcard, credentials not enabled.
- **Webhooks** mount before `express.json()` and read the raw body with a 64 kB
  cap, so signatures verify against the exact bytes sent.
- **Errors** — the final handler answers exposed client errors as `4xx` and
  everything else as a generic `500 internal_error`, never echoing the body,
  path or a stack.
- **`sessionStorage`, not `localStorage`** — because the admin token is readable
  by script, XSS matters more than with a cookie, which is why the frontend
  keeps it in `sessionStorage` and the Content-Security-Policy is load-bearing.

Secrets live only in environment variables; `src/env.ts` enforces the ≥
32-character floor on `SESSION_SECRET` — the only guard on the HMAC key length,
so do not relax it.

---

*Not a developer? The user-facing side: clients see
[Privacy and payment safety](/help/privacy-and-safety); the photographer sees
[Security and responsibilities](/guide/security).*
