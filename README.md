# Bookly Marketplace

A booking marketplace for photographers in Rwanda. Photographers subscribe, list
their services and packages, set their own hours and policies, and manage their
bookings from one calendar. Clients browse a directory of photographers, filter
by category, district, price and date, and book and pay a booking fee to hold a
slot -- by mobile money or card. The platform collects payments and pays each
photographer out; it takes no commission.

> **Status: in progress.** The code today is the single-photographer Bookly this
> grew from, with the security baseline in place. The marketplace is being built
> phase by phase from [`docs/marketplace-spec.md`](docs/marketplace-spec.md); the
> schema changes are in [`docs/marketplace-data-model.md`](docs/marketplace-data-model.md).
> Until those phases land, the app still runs as one photographer's site, and the
> rest of this README describes that.

Clients book as guests through a private emailed link (optional accounts are
coming). Prices are in RWF; times are Africa/Kigali.

## The three apps

| Folder | What it is | Deployed on |
|---|---|---|
| [`backend/`](backend/) | Express 5 + Prisma 7 API (`/api/*`), PostgreSQL | Render |
| [`frontend/`](frontend/) | React + Vite single-page app | Vercel |
| [`docs-site/`](docs-site/) | VitePress documentation site, incl. the API reference | Cloudflare |

They deploy independently to separate domains; in development Vite proxies
`/api` to the backend so the inner loop is one command per app. There is no
shared package — the server is authoritative for every amount and revalidates
every request, so each app keeps its own copy of a schema without trusting the
other.

## Quickstart

You need Node 22+ and a local PostgreSQL 15+ (the double-booking guarantee uses
an exclusion constraint that only PostgreSQL has).

```sh
# Backend
cd backend
cp .env.example .env            # then set DATABASE_URL to your local Postgres
npm install
npm run db:deploy               # apply migrations
npm run db:seed                 # admin user, settings, demo catalogue
npm run dev                     # API on http://localhost:4000

# Frontend (second terminal)
cd frontend
npm install
npm run dev                     # app on http://localhost:5173, proxying /api

# Docs site (optional)
cd docs-site
npm install
npm run dev                     # docs on http://localhost:5173 (or next free port)
```

> [!IMPORTANT]
> Point development and tests at a **local** database only. `backend/.env` may
> hold a production (Neon) `DATABASE_URL`; the test suite reads
> `TEST_DATABASE_URL`, which must be local — the schema tests truncate tables.

## Documentation

- **API reference** — the full HTTP API, interactive: run the docs site
  (`cd docs-site && npm run dev`) and open `/api`, or read the spec at
  [`backend/openapi/openapi.yaml`](backend/openapi/openapi.yaml).
- **API conventions** — auth, error shapes, time and money, webhooks:
  [`docs-site/api/conventions.md`](docs-site/api/conventions.md).
- **Developer guide** — architecture, local setup, data model, booking
  lifecycle, payments, the outbox, auth and testing:
  [`docs-site/developers/`](docs-site/developers/).
- **Design and product background** — the authoritative spec and data model live
  in [`docs/`](docs/) (`specs_v2.md`, `data-model_v2.md`, `plan.md`). These are
  internal design records and are not published.

A photographer's guide and a client help centre, in English and French, are
planned follow-ups to this first documentation release.

## Tests

Each app runs its own suite against real local PostgreSQL (no mocks for the
database, because much of the behaviour under test *is* the database):

```sh
cd backend  && npm run typecheck && npm run lint && npm test
cd frontend && npm run typecheck && npm run lint && npm test
```

The backend suite includes `src/openapi.test.ts`, which fails if the API ever
drifts from the OpenAPI spec — a route without an operation, an operation
without a route, or a response that no longer matches its schema.
