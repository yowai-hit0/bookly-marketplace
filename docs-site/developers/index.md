# Developer guide

How Bookly is built, for someone about to change it. It is written from the
code; where a detail matters, it names the file so you can read the source
next to the prose. The authoritative design records — `specs_v2.md`,
`data-model_v2.md`, `plan.md` — live in the repository's `docs/` folder; this
guide is the working map of the running system.

## Start here

- **[Architecture](./architecture)** — the two apps, the database, how a request
  flows, and what is deployed where.
- **[Local setup](./local-setup)** — prerequisites, environment, database,
  running the apps, and the golden rule about which database the tests use.
- **[Data model](./data-model)** — the thirteen tables, the snapshot discipline,
  and the one constraint the whole product rests on.
- **[Booking lifecycle](./booking-lifecycle)** — statuses, display stages, and
  every transition the admin and the system can make.
- **[Payments](./payments)** — providers, how an attempt is started, how a
  webhook is applied safely, refunds and cash.
- **[Email and the outbox](./email-and-outbox)** — the single queue everything
  outbound goes through, and its worker.
- **[Auth and security](./auth-and-security)** — admin JWTs, capability tokens,
  and where authorization is enforced.
- **[Testing](./testing)** — how the suites run against real PostgreSQL, and the
  test that keeps the API and its docs in step.

## The shape of it in one paragraph

Bookly is two separately deployed apps — a React SPA (`frontend/`) and an
Express + Prisma API (`backend/`) over PostgreSQL — plus this documentation
site. Clients never log in: a booking is reached through an unguessable token
emailed at confirmation. The one admin authenticates with a bearer JWT. The
server is authoritative for every amount and revalidates every request, so the
two apps can keep their own copies of a schema without trusting each other. The
hardest problem — never double-booking a slot — is solved in the database with
a GiST exclusion constraint, not in application code, so no race in the API can
defeat it.
