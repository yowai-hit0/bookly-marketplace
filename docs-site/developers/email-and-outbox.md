# Email and the outbox

Everything the system sends — client emails, admin alerts, and (when built) the
Google Calendar mirror — goes through **one queue and audit trail**, the
`outbox` table. A queued message and a sent message are the same row at
different times.

## Enqueue, never send inline

Business code never calls an email provider directly. It calls `enqueue()`
(`src/outbox/enqueue.ts`) inside the same transaction as the state change the
message is about, so the row that confirms a booking and the message announcing
it commit together or not at all. Each row carries a `dedupe_key` (e.g.
`email:booking_confirmation:<booking_id>`) with a unique index, which makes
"send exactly once" a database guarantee rather than a hope — a duplicate
enqueue is a no-op, not an error.

The payload holds everything the worker needs, resolved at enqueue time. The one
sensitive value that ever appears there is a freshly generated plaintext token
(an access link, a reset link, an email-change confirmation); it lives only in
the payload until delivery and never in a durable column.

## The worker

`src/outbox/worker.ts` is the only retry mechanism in the system — one process,
one loop. It claims a batch of `pending` rows whose `next_attempt_at <= now()`,
incrementing `attempts` at claim time so a crash mid-send cannot spin a row
forever, and hands each to a handler by `kind`:

- **success** → `done`;
- **retryable failure** (provider hiccup, rate limit) → back to `pending` with
  exponential backoff — one minute doubling to a cap, eight attempts, the last
  about two hours after the first;
- **permanent failure** (`PermanentOutboxError`: a payload that will never
  render, an invalid recipient) → `failed` at once, no retries;
- **attempts exhausted** → `failed`, and the photographer gets an admin alert.

On shutdown the worker finishes the row in hand before the process exits, so
nothing is left stuck in `processing`.

## Providers and local development

The handler talks to a `MailProvider` (`src/email/mailer.ts`): **Resend** or
**Brevo**, chosen by which API key is set (exactly one in production). With
neither key — development and test — rendered emails are written to
`MAIL_OUTPUT_DIR` as files instead of sent, so you can open their links. Email
HTML is built by templates under `src/email/templates/` and escaped in
`src/email/layout.ts`, so a client-supplied name or note reaching the
photographer's inbox cannot inject markup.

## The nine templates

Booking confirmation, new-booking admin alert, session-fee request, payment
receipt, photo delivery, cancellation, reschedule, access-link resend, and a
catch-all `admin_alert` (payment received, retries exhausted, login lockout,
refund due). Calendar kinds (`gcal_create/update/delete`) share the same queue;
their handler arrives with the Google Calendar task.
