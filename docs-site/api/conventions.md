# API conventions

Rules that hold across every operation. Read these once and the per-endpoint
pages in the [reference](/api/) stay short.

## Base URLs

| Environment | Base URL |
|---|---|
| Production | `https://api.bookly.example` |
| Local development | `http://localhost:4000` |

Every path below is relative to one of these, and every path begins with
`/api`. In local development the frontend's Vite dev server proxies `/api` to
the backend, so the browser makes same-origin requests; in production the two
are separate origins and the API allows the frontend's origin through CORS
(`WEB_ORIGIN`, echoed, no credentials).

## Who may call what

There are three kinds of caller, and an operation belongs to exactly one.

- **Public** — anonymous. Browsing the catalogue, checking availability,
  creating a booking, and everything under checkout. No credential.
- **A booking's client** — identified by a **capability token** in the path, not
  by an account. The confirmation email carries the token; whoever holds the URL
  is the client, so treat it as a secret.
- **The admin** (the photographer) — a JWT bearer token from
  `POST /api/admin/auth/login`, sent as `Authorization: Bearer <token>` on every
  `/api/admin/*` call.

### Admin tokens

Login returns an HS256 JWT valid for 8 hours. Send it in the `Authorization`
header; it is never set as a cookie. A missing or refused token is a `401` with
a `WWW-Authenticate` header: `Bearer realm="bookly-admin"` when none was sent,
and `…, error="invalid_token"` when one was sent but rejected (expired, tampered,
or issued before a password change — changing the password revokes every token
already issued). Hold the token in memory or `sessionStorage`, never
`localStorage`.

### Capability tokens

Three flows use an unguessable token in the URL rather than a login:

- the **access token** for a client's own booking (`/api/booking/{token}` and
  its actions) — 256 random bits, emailed at confirmation, valid 365 days, and
  reissued (invalidating the old one) when the photographer resends the link;
- the **checkout token** for paying a booking fee
  (`/api/checkout/{reference}/{token}`) — an HMAC of the reference, good only
  while the hold lasts;
- the **email-confirmation token** for confirming a change of contact email.

An unknown, expired or superseded token is always a `404` — never a `403`, which
would confirm that a booking exists.

## Errors

Every error body is `{ "error": "<code>" }` with a stable, machine-readable
code. Validation failures add the offending fields:

```json
{ "error": "validation_failed", "fields": ["email", "startsAt"] }
```

Values are never echoed back.

### 400 versus 422

The two are deliberately different:

- **`400 invalid_request`** — the request is not the right *shape*: invalid JSON,
  a wrong type, an unknown or missing key, a malformed id or date.
- **`422 validation_failed`** — the shape is right but a *value* breaks a rule: a
  mistyped email, a fee rate above 1, a slot that is not on offer. The `fields`
  array names what to mark on a form.

A rule that the database would otherwise enforce (a check constraint) is checked
in the API first, so it surfaces as a `422` rather than a `500`.

### Other common statuses

| Status | Meaning |
|---|---|
| `401 unauthenticated` | No valid admin token (admin routes only). |
| `404 not_found` | Nothing there — including a token that does not resolve. |
| `409` | A conflict with current state; the body's `error` says which, and admin and client actions include the resource as it now stands so a stale screen can refresh. |
| `429 too_many_requests` | A rate limit was hit. |
| `500 internal_error` | An unexpected fault. The body never leaks internals. |

## Money and time

- **Money** is always a whole number of Rwandan francs (RWF) — never a float, never a string.
- **Instants** are ISO-8601 in UTC (`2026-10-14T07:00:00.000Z`). A request body
  that carries a time must include an explicit offset.
- **Dates** without a time (a block's day, a delivery expiry) are calendar dates
  in Africa/Kigali (UTC+2, no DST), written `YYYY-MM-DD`.

## Payments and webhooks

Payments settle out of band: a `POST …/payments` call starts an attempt and
returns an `ourRef`; the booking or payment is confirmed later by a provider
**webhook**, and the client polls `GET /api/payments/{ourRef}` meanwhile. Mobile
Money settlement routinely takes 30 seconds or more.

Webhooks are called by the providers, not by browsers. Each delivery is stored
before it is interpreted and keyed on the provider's own event id, so a repeat
is a no-op and an event for an already-settled payment is recorded and ignored.
The endpoint answers `200` whenever the delivery is on record — applied, ignored,
or refused as unsigned — so the provider stops retrying; a `500` asks for the
retry that processes it again.

## Caching

Responses that carry personal data, a credential or a live link are sent
`Cache-Control: no-store`: the admin login, the whole of checkout, and every
client-booking route.
