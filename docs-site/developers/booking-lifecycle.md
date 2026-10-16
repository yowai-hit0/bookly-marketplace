# Booking lifecycle

A booking's `status` is one of seven stored values; the admin UI also shows a
derived **stage** that folds in the clock. Keep the two ideas apart: status is
what is written, stage is what is shown.

## Statuses

`src/db/statuses.ts`:

```
pending_payment → confirmed → completed
                            ↘ no_show
pending_payment → expired
confirmed → cancelled_by_client | cancelled_by_admin
```

The four **occupying** statuses — `pending_payment`, `confirmed`, `completed`,
`no_show` — are those the exclusion constraint counts as holding time. `expired`
and the two cancellations free the slot.

## Stages (display only)

`bookingStage()` in `src/booking/stage.ts` derives a stage from status and time:
`awaiting_payment`, `confirmed`, `in_progress`, `needs_review`, `completed`,
`closed`, plus the terminal statuses as themselves. `needs_review` is
admin-only — a client never sees it. The client view and the admin list filter
by stage; there is one definition and a test holds the SQL filter to it.

## Creation and the claim

`POST /api/bookings` → `booking/create.ts` → `booking/claim.ts`.

Creation prices the basket from the catalogue, checks the start is one the
availability engine currently offers, writes every snapshot, and inserts a
`pending_payment` row holding its slot for `holdMinutes`. The insert goes
through the **claim transaction**, which is the concurrency-correct core:

1. Take a transaction-scoped advisory lock, so concurrent claims serialise
   instead of deadlocking on each other's uncommitted rows.
2. Expire any *stale* holds overlapping the requested range — a lapsed
   `pending_payment` the constraint still sees as occupying.
3. Insert. The `booking_no_overlap` constraint is the real guarantee; a loser
   meets the winner's committed row and gets `23P01`, surfaced as `409 slot_taken`.

Correctness does not depend on the hold sweeper's cadence — the claim expires
what stands in its way itself. The sweeper (`hold-sweeper.ts`) only keeps the
table tidy and sends nothing (an abandoned checkout gets no email).

## Confirmation

A booking is confirmed only by a signature-verified `succeeded` booking-fee
webhook (`payments/webhooks.ts`), never by the client's browser. In one
transaction it sets `status = confirmed`, nulls `hold_expires_at`, stamps
`confirmed_at`, writes the hashed access token, and enqueues the confirmation
and admin-alert emails. The plaintext access token exists only in the
confirmation email's outbox payload — never in a column.

A fee arriving *after* the hold expired reconfirms the booking only if the slot
is still free (checked under the same advisory lock); otherwise the booking
stays `expired`, the payment is marked `refund_due`, and the admin is alerted.

## Admin transitions

`src/booking/admin-actions.ts`. Each guards on the current status and answers a
typed result the route maps to `200` or `409`:

| Action | Precondition | Effect |
|---|---|---|
| Reschedule | `confirmed` | Keeps id, reference, token and payments; moves the slot **and recomputes `buffer_ends_at`**; writes `original_starts_at` on the first move only; releases the old slot; emails the client. An occupied target is `409 slot_taken`. |
| Cancel | `confirmed` | → `cancelled_by_admin`, releases the slot, marks succeeded payments `refund_due` for a full refund, emails the client. |
| Complete | `confirmed`, shoot started | → `completed`. "Completed means paid": money still owed is `409 balance_due`. |
| No-show | `confirmed`, shoot started | → `no_show`. |
| Resend link | has a link | Issues a fresh token (old link now 404s) and emails it. |

Completion is also reached automatically: a session-fee `succeeded` webhook that
leaves nothing outstanding completes a booking whose shoot has begun, in the
same transaction (`booking/auto-complete.ts`).

## Post-shoot

Once a booking is `confirmed` and its shoot has begun, the add-on set is
editable (`post_shoot` add-ons, `booking/addons.ts`); it locks when the booking
becomes `completed`. Photo delivery needs `completed`: save an https link
(`PUT …/delivery`), then send it (`POST …/delivery/send`). The link is live
through the end of its expiry day, Kigali time.

## Money events

Money is only ever *recorded*, never moved by the system. Session fees are
collected online (`payments/session-fee.ts`) or in cash (`payments/cash.ts`,
which voids any open online request so the same money cannot be taken twice).
Refunds are made by the photographer by hand; `POST /api/admin/payments/:id/refund`
records that one happened, with its reference. See [Payments](./payments).
