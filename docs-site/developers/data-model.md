# Data model

The authoritative description is `docs/data-model_v2.md`; the schema itself is
`backend/prisma/schema.prisma` and the hand-written migration SQL under
`backend/prisma/migrations/`. This page is the orientation.

## The tables

Thirteen application tables (plus Prisma's own `_prisma_migrations`):

| Table | Holds |
|---|---|
| `admin_user` | The single photographer account: email, Argon2id hash, lockout and reset state. |
| `setting` | One row (`id = 1`): the five operating values (fee rate, lead time, hold, buffer, delivery-link lifetime). |
| `working_hours` | Weekly rules and one-date overrides. |
| `availability_block` | Time blocked off, with a private reason. |
| `service` → `package` → `addon` | The catalogue. Add-ons may belong to a service or be offered on all (`service_id` null). |
| `client` | One row per email address — a dedupe/linking record, not an account. It grants nothing. |
| `booking` | The heart of the model: schedule, snapshots, status, access token, delivery, lifecycle timestamps. |
| `booking_addon` | Add-ons on a booking, staged `at_booking` or `post_shoot`, each with its own price snapshot. |
| `payment` | Every payment attempt, from first instant. Append-only. |
| `webhook_event` | Every inbound provider callback, stored before it is interpreted. Append-only. |
| `booking_note` | Notes the photographer writes to a client; soft-deleted. |
| `outbox` | One queue and audit trail for everything the system sends. |

Three rules bind every role, including the admin: rows a booking references
cannot be hard-deleted (foreign keys are `RESTRICT`); `payment`, `webhook_event`
and `outbox` rows are never edited away — they are the audit trail; and no code
moves money, it only records that money moved.

## Snapshots: a booking is a contract, not a join

A booking copies everything it needs out of the catalogue at creation —
`service_name_snapshot`, `package_name_snapshot`, `package_price_rwf`,
`package_duration_minutes`, `package_photo_count`, the contact details, and the
resolved `booking_fee_rate`. Editing a price, renaming a service or deactivating
a package therefore never changes an existing booking; edits apply to new
bookings only. Amounts are always read from these snapshots, never from live
catalogue rows.

There is no `total_rwf` and no `session_fee_rwf` column. Totals are **derived**
by `bookingTotals()` (`booking/totals.ts`) from the snapshots, the booking's
add-ons and its payments, so a booking cannot hold a total that disagrees with
its own parts. A terminal-unpaid booking (cancelled, expired, no-show) owes
nothing, and a refund owed (`refundDueRwf`) is reported separately from money
collected rather than netted off.

## The one constraint everything rests on

Double booking is prevented in the database, not in application code
(`prisma/migrations/20260910141543_init/migration.sql`):

```sql
ALTER TABLE "booking" ADD CONSTRAINT "booking_no_overlap"
  EXCLUDE USING gist (tstzrange(starts_at, buffer_ends_at, '[)') WITH &&)
  WHERE (status IN ('pending_payment', 'confirmed', 'completed', 'no_show'));
```

No two bookings in an occupying status may hold overlapping `[starts_at,
buffer_ends_at)` ranges — the session plus its buffer. Any transaction that
tries raises `23P01`, whatever the application does, so no race in the API can
defeat it. The constraint ranges over a single expression, so no `btree_gist`
extension is needed.

The one thing the constraint cannot do is call `now()`: a `pending_payment` row
whose hold has lapsed still occupies its range until something flips it to
`expired`. That is the whole job of the claim transaction — see
[Booking lifecycle](./booking-lifecycle).

Because this constraint (and four partial unique indexes and dozens of CHECKs)
lives in SQL Prisma cannot see, two consequences follow: `prisma db push` is
banned (it would drop them), and the schema tests run against real PostgreSQL,
because the thing under test *is* the database.

## Enumerations are text + CHECK

Statuses, kinds and methods are `text` columns with CHECK constraints, not
native Postgres enums: adding a value is then one line, not an `ALTER TYPE` that
locks and will not roll back inside a transaction. The allowed values live in
`src/db/statuses.ts` and `src/payments/provider.ts`.

## Nullable because erasure

`client.phone`, `webhook_event.payload` and `outbox.payload` are nullable
specifically because the erasure routine (Law N° 058/2021, deletion on request)
sets them to null. `booking.consent_at`, by contrast, is kept through erasure —
destroying the proof of consent would defeat the obligation it exists to
satisfy.
