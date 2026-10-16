# Architecture

## Two apps and a database

| Part | Stack | Responsibility | Deployed on |
|---|---|---|---|
| `frontend/` | React + Vite SPA | Public booking flow, the client's token page, the admin panel | Vercel (static) |
| `backend/` | Express 5 + Prisma 7 | The `/api/*` API, all business logic, the single source of truth | Render |
| PostgreSQL 15+ | — | Every row, and the constraints that guarantee correctness | Neon |
| `docs-site/` | VitePress | This documentation and the API reference | — |

The frontend and backend deploy independently to **separate domains**. There is
deliberately no shared package and no monorepo tooling: the zod schemas, the
quote function and the formatters exist once per app. That duplication is
contained by making the server authoritative — it recomputes every amount and
revalidates every payload — and by a fixture under `docs/fixtures/` that both
test suites assert, so a divergence fails a test rather than reaching a client.

In development, Vite proxies `/api` to the backend on `localhost:4000`, so the
browser makes same-origin requests and the inner loop is one command per app. In
production the two are genuinely cross-site, so the API carries a CORS allowlist
scoped to `WEB_ORIGIN` (the frontend's origin, echoed, credentials not enabled)
and the admin authenticates with a bearer token rather than a cookie — which is
what keeps the deployment free of a CSRF-token flow and of third-party-cookie
blocking.

## How a request flows

The app is assembled in [`backend/src/app.ts`](https://github.com/) by
`createApp(options)`, which mounts routers in a deliberate order:

1. `cors` (allowlisted to `WEB_ORIGIN`).
2. **Webhook routes** (`/api/webhooks/*`) — mounted *before* the JSON parser,
   because signature verification needs the raw request bytes.
3. `express.json()`.
4. Public routes (catalogue, availability, bookings, checkout, booking-links,
   email-confirmations, the client token page).
5. Admin routes (`/api/admin/*`), gated by `requireAdmin`.
6. A catch-all `404` and a final error handler that answers exposed client
   errors as `4xx` and everything else as a generic `500` — never echoing the
   body or a stack.

`createApp` takes its collaborators as options (the Prisma client, the payment
provider, a `now()` clock), which is what lets the tests build the app with a
stubbed provider and a fixed clock. `src/server.ts` is the production entry
point: it parses and validates the environment (`src/env.ts`), constructs the
real providers, starts the HTTP server, and starts three background loops.

## Background loops

One Node process runs the API and three schedulers (`src/server.ts`):

- **Hold sweeper** (`booking/hold-sweeper.ts`) — expires lapsed
  `pending_payment` holds once a minute. This is tidiness, not correctness: the
  claim transaction expires stale holds in its own path, so a slot is never
  unclaimable merely because the sweeper has not run.
- **Payment reconciler** (`payments/reconcile.ts`) — settles payments whose
  webhook was lost, and the MTN sandbox (which sends no callbacks), by polling
  the provider's status endpoint.
- **Outbox worker** (`outbox/worker.ts`) — delivers queued email and calendar
  jobs with retry and backoff. See [Email and the outbox](./email-and-outbox).

All three are shut down cleanly on `SIGTERM`/`SIGINT`; the outbox worker
finishes the message in hand before the connection closes, so no row is left
claimed in `processing`.

## Why PostgreSQL specifically

The double-booking guarantee is a GiST **exclusion constraint** over a time
range, which exists in no other engine the project would otherwise consider.
That is why `prisma db push` is never run (it would drop the constraint, which
Prisma does not model) and why the schema tests run against real PostgreSQL
rather than a mock. See [Data model](./data-model).
