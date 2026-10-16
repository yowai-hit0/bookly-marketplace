# Testing

## Against real PostgreSQL, not a mock

The backend suite runs against a real local PostgreSQL, because much of the
behaviour under test *is* the database — the exclusion constraint, the partial
unique indexes, the CHECKs — none of which Prisma models and a mock would not
exercise. Vitest's global setup (`src/test/global-setup.ts`) creates the test
database if absent and brings it to the head of migration history with
`prisma migrate deploy` (the same command production runs — never `db push`).
Schema tests truncate between tests, so files run serially.

The database is chosen by `TEST_DATABASE_URL` (`src/test/database.ts`). It must
be local: the suite truncates every table. See [Local setup](./local-setup).

```sh
cd backend && npm run typecheck && npm run lint && npm test
```

The frontend runs Vitest for components and units and Playwright for end-to-end
specs (`npm test`, `npm run test:e2e`); its Playwright specs stub `/api` with
`page.route` and pin the browser zone to Africa/Kigali.

## Fixtures

`src/test/payment-fixtures.ts` seeds a small world (settings, the admin, a
service, a package, two add-ons, a client) and inserts bookings, tokens and
payments directly in whatever state a test needs — holds stamped on the
*database* clock, so "live" and "lapsed" mean what they mean to the code under
test. A shared fixture under `docs/fixtures/` is asserted by both the backend
and frontend suites, so the duplicated quote logic cannot silently diverge.

## The OpenAPI drift test

`src/openapi.test.ts` (with helper `src/test/openapi.ts`) keeps the published
[API reference](/api/) honest. It:

1. validates `openapi/openapi.yaml` as OpenAPI 3.1;
2. checks **route parity both ways** — it reads every `router.<method>('…')` out
   of `src/routes/` and resolves each against a mount-prefix table, then fails if
   a route has no operation, an operation has no route, or a router is missing
   from the table (so a new router cannot be added unnoticed);
3. validates **real responses** against the spec's schemas, driving one success
   case per public and client operation plus admin login, `/me`, the bookings
   list and a booking detail.

So when you add or change a route, update the matching operation under
`openapi/paths/` and the schemas under `openapi/components/`; `npm test` names
exactly what is out of step. Lint the spec with `npm run api:lint` from
`docs-site`.

## What runs in CI before a change lands

Per the project convention, a change to an app runs that app's
`npm run typecheck`, `npm run lint` and `npm test`. A security or behaviour fix
adds a regression test that fails before the fix and passes after, written
against the real local database like the rest of the suite — not a mock.
