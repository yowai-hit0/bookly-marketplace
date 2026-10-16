# Local setup

## Prerequisites

- **Node 22+**
- **PostgreSQL 15+**, local. The double-booking constraint is PostgreSQL-only,
  so a local Postgres is required — SQLite or a mock will not do.

## Backend

```sh
cd backend
cp .env.example .env         # then edit — see below
npm install
npm run db:deploy            # apply migrations to DATABASE_URL
npm run db:seed              # admin user, settings, Mon–Fri hours, demo catalogue
npm run dev                  # API on http://localhost:4000
```

`src/env.ts` validates the environment at boot and is the authoritative list;
`.env.example` documents every variable. What matters locally:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Local PostgreSQL. `DIRECT_URL` is the unpooled URL the Prisma CLI migrates through — set it when `DATABASE_URL` is pooled (Neon). |
| `TEST_DATABASE_URL` | **Local** database for the test suite. Required; the schema tests truncate tables. |
| `SESSION_SECRET` | ≥ 32 characters. Signs admin JWTs and derives payment tokens. |
| `WEB_ORIGIN` | The frontend origin; CORS allowlist and emailed links. Defaults to `http://localhost:5173`. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Read once by the seed to create the single admin. |
| Payment / email keys | Optional locally. With no mail key, emails are written to `MAIL_OUTPUT_DIR` instead of sent, so you can open the links. Leave payment credentials unset (attempts are recorded and fail at once) or use sandbox credentials. |

::: danger Never point development or tests at production
`backend/.env` may hold a production (Neon) `DATABASE_URL`. For anything that
runs the app or the tests, `DATABASE_URL`, `DIRECT_URL` and `TEST_DATABASE_URL`
must be a **local** Postgres. The schema tests truncate tables, and the seed
writes rows — neither belongs anywhere near production data.
:::

::: warning Never run `prisma db push`
It reconciles the database to `schema.prisma` and would silently drop the
`booking_no_overlap` exclusion constraint, which Prisma does not model. Every
schema change goes through `prisma migrate dev --create-only` plus hand-edited
SQL. See [Data model](./data-model).
:::

## Frontend

Run the backend first, then:

```sh
cd frontend
npm install
npm run dev                  # http://localhost:5173, proxying /api to :4000
```

`VITE_API_BASE_URL` points `/api` calls at the backend. It is the only `VITE_*`
variable and ships in the bundle — no secret belongs in frontend config.

## Docs site

```sh
cd docs-site
npm install
npm run dev                  # bundles the OpenAPI spec, then serves the docs
```

## Everyday commands

| In | Command | Does |
|---|---|---|
| `backend` | `npm run dev` | API with reload. |
| `backend` | `npm run db:migrate` | Create/apply a migration in development. |
| `backend` | `npm test` | Vitest against `TEST_DATABASE_URL`. |
| `backend` | `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint. |
| `frontend` | `npm run dev` / `build` / `preview` | Vite. |
| `frontend` | `npm test` / `npm run test:e2e` | Vitest / Playwright. |
| `docs-site` | `npm run dev` / `build` | VitePress. |
| `docs-site` | `npm run api:lint` | Redocly lint of the spec. |

## First run

After `db:seed`, the console prints the demo booking's client link. Log in to
the admin panel at `http://localhost:5173/admin/login` with `ADMIN_EMAIL` /
`ADMIN_PASSWORD`. See [Testing](./testing) for how the suites bootstrap their own
database.
