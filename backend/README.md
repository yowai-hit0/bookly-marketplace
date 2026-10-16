# Bookly backend

The Express 5 + Prisma 7 API behind Bookly, backed by PostgreSQL. It is
API-only (`/api/*`); the frontend is a separate app. See the repository
[README](../README.md) for the big picture and the
[API reference](openapi/openapi.yaml) for the endpoints.

## Setup

Node 22+ and a local PostgreSQL 15+.

```sh
cp .env.example .env     # set DATABASE_URL; see the file's comments for the rest
npm install
npm run db:deploy        # apply migrations (never `prisma db push` — it drops the exclusion constraint)
npm run db:seed          # one admin, settings, Mon–Fri hours, and demo data outside production
npm run dev              # tsx watch, API on http://localhost:4000
```

### Environment

`src/env.ts` validates configuration at boot and is the authoritative list.
`.env.example` documents every variable. The essentials:

- `DATABASE_URL` — PostgreSQL connection string. `DIRECT_URL` is the unpooled
  connection the Prisma CLI migrates through (set it when `DATABASE_URL` goes
  through a pooler, as Neon does).
- `TEST_DATABASE_URL` — **local** database for the test suite. Required so tests
  never run against production; the schema tests truncate tables.
- `SESSION_SECRET` — ≥ 32 characters; signs admin JWTs and derives payment
  tokens. Rotating it invalidates every issued admin token.
- `WEB_ORIGIN` — the frontend's origin, allowlisted by CORS and used in emailed
  links. `API_ORIGIN` — this API's public origin, where payment providers call
  back (required in production).
- Payments (`MTN_MOMO_*`, `FLUTTERWAVE_*`) and email (`RESEND_API_KEY` **or**
  `BREVO_API_KEY`) — optional in development; with no mail key, emails are
  written to `MAIL_OUTPUT_DIR` instead of sent.

> [!IMPORTANT]
> Never point development or tests at the production (Neon) database. Override
> `DATABASE_URL`, `DIRECT_URL` and `TEST_DATABASE_URL` with a local Postgres.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run the API with reload (`tsx watch`). |
| `npm run build` / `npm start` | Compile to `dist/` and run it. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint. |
| `npm test` | Vitest against `TEST_DATABASE_URL` (creates and migrates it first). |
| `npm run db:migrate` | Create/apply a migration in development. |
| `npm run db:deploy` | Apply existing migrations (production and CI). |
| `npm run db:seed` | Seed the admin, settings, working hours and demo data. |
| `npm run db:studio` | Prisma Studio. |

## Layout

- `src/routes/` — one router per area; `src/app.ts` mounts them and `src/server.ts` boots.
- `src/auth/` — admin login, lockout, password reset, JWTs, `requireAdmin`.
- `src/booking/`, `src/availability/`, `src/catalogue/`, `src/payments/`,
  `src/email/`, `src/outbox/` — the domain.
- `src/db/` — the Prisma client (`prisma/schema.prisma`, `prisma/migrations/`).
- `openapi/` — the hand-written OpenAPI 3.1 spec. `src/openapi.test.ts` holds the
  code and the spec to each other (route parity both ways, and responses
  validated against the schemas), so the published API reference cannot drift.

## The OpenAPI spec

`openapi/openapi.yaml` is the source of truth for the published reference. When
you add or change a route, update the matching operation under `openapi/paths/`
and the schemas under `openapi/components/`; `npm test` will tell you precisely
what is out of step. Lint it with `redocly lint openapi/openapi.yaml` (the docs
site provides this as `npm run api:lint`).
