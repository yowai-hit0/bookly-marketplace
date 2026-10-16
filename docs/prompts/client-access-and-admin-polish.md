# Prompt: client access, loading states and admin polish

You are working in the Bookly repo (Express 5 + Prisma 7 + PostgreSQL backend in `backend/`, React + Vite +
React Router frontend in `frontend/`). Build the eight changes below. Work on a new branch `feat/client-access` off
`main`, with one commit per numbered item, and do not push without asking. Where this prompt leaves a decision
open, or the code contradicts it, **stop and ask the user**; do not guess.

## Ground rules (read first)

- **Read before writing:** `design-system/bookly/MASTER.md` (hand-review addendum), `design-system/bookly/pages/client-shell.md`,
  `admin-shell.md`, `booking.md`, `home.md`, `services.md`. When a change contradicts one of these files, update the
  file and record the decision with today's date, as earlier decisions there are recorded.
- **i18n:** `frontend/src/i18n/locales/en.json` and `backend/src/i18n/locales/en.json` take **new keys only**.
  Never edit an existing string.
- **Database:** schema changes go through a new Prisma migration (`npm run db:migrate` in `backend/`). **Never
  `prisma db push`**: it drops the exclusion constraint. The outbox's `template` column has a CHECK constraint
  listing every template (`outbox_template_allowed`, in the init migration). A new template means a migration that
  drops and recreates that constraint, plus entries in `backend/src/outbox/enqueue.ts` and `backend/src/email/render.ts`.
- **Tests:** backend DB tests run against real PostgreSQL. Point `TEST_DATABASE_URL` at a **local** database
  (for example `postgresql://postgres:<pw>@localhost:5432/bookly_test`). **Never run the suite against the Neon
  `DATABASE_URL`** in `backend/.env`: the live site uses it. Match the existing test style: a header comment saying
  what is proven, and real PostgreSQL rather than mocks.
- **e2e constraints** (`frontend/e2e/`), which the shell tests guard: one `main` per page; no buttons, radios or `dl`
  in the client header or footer; no link named "All services"; header and footer text never contains
  "processing", "card" or "airtel". Keyboard specs take the skip link first, so new header links don't disturb them.
- **Security invariants:** an access token's plaintext is never stored, only its SHA-256
  (`backend/src/booking/access-token.ts`). "Unknown", "expired" and "replaced" answer identically. No public
  endpoint may reveal whether an email address has bookings.
- Run before each commit: `npm run typecheck`, `npm run lint`, `npm test` in both packages, and
  `npx playwright test` in `frontend/`. For UI changes, screenshot at 375 px and 1280 px, checking for no horizontal
  scroll.

---

## 1. Loading skeletons for services (home preview and `/services`)

**Why:** the API is on Render's free tier, and a cold start can take close to a minute. Today `/services` shows a
text line (`services:loading`), and the home preview renders nothing until the data arrives.

- Add a `Skeleton` primitive at `frontend/src/components/ui/skeleton.tsx` (the shadcn one: `bg-muted rounded-md
  animate-pulse`, with `motion-reduce:animate-none`).
- `frontend/src/pages/services/ServiceList.tsx`: while loading, render placeholder cards with the **same size and
  grid** as the real `ServiceCard` (image block, title line, two text lines, price line), so nothing jumps when data
  arrives. Keep an `sr-only` live region announcing the existing `services:loading` text. Put `aria-busy="true"`
  on the list container, and hide the skeletons from assistive technology (`aria-hidden`).
- `frontend/src/pages/Home.tsx`: the preview section currently appears only when services exist. Show it with
  skeleton cards (the same count as the preview limit) **while loading**, and keep hiding it when the fetch fails
  or returns nothing.
- Tests: both pages render skeletons while `fetch` is pending and replace them with cards; a failed fetch shows the
  existing error state; on Home, a failed or empty fetch shows no preview section. Existing Home, ServiceList and
  e2e tests must still pass; e2e `services.spec.ts` counts elements page-wide, so check it.

## 2. Red sign-out button in admin

- `frontend/src/admin/AdminLayout.tsx`: the sign-out `Button` is `variant="ghost"`. Keep it ghost weight (not a
  solid fill: it is not a destructive confirmation), but give it red text and a red hover tint:
  `text-destructive hover:bg-destructive/10 hover:text-destructive`, with the focus ring kept. Check contrast in
  both themes, and record the change in `admin-shell.md`.
- Test: `AdminLayout.test.tsx` asserts the button still exists and carries the destructive styling class.

## 3. Admin photo delivery: discoverability, and confirming the recipient

**Current behaviour** (explain this in the PR): the delivery form (`DeliveryForm` in
`frontend/src/pages/admin/AdminBookingDetail.tsx`) appears only when the booking's status is `completed`
(`canEditDelivery` in `backend/src/booking/admin-view.ts`). The photographer must first click "Mark completed".

- **Hint:** on a `confirmed` booking whose shoot has started, show a short muted line in place of the delivery
  section: "Photo delivery opens once you mark this booking completed." (new i18n key).
- **Confirm step before sending:** clicking "Send" (or "Send again") no longer sends straight away. It opens an
  inline confirm step, using the pattern of the cancel confirmation already in that file (`confirming` state, no
  modal library). The step shows "Send the photo link to:" with an email `Input` prefilled with the booking's
  `contactEmail`, plus a Confirm and a Back button. Validate as an email before enabling Confirm.
- **User decision:** a changed address applies to **this one email only**. The booking's `contact_email` is
  **not** changed.
- Backend: `POST /api/admin/bookings/:id/delivery/send` accepts an optional body `{ recipient?: string }`
  (`z.email()`, trimmed; 422 `validation_failed` otherwise). `sendDelivery` in `backend/src/booking/delivery.ts`
  uses `recipient ?? booking.contactEmail` as the outbox recipient, and nothing else changes. If the admin booking
  view shows sent-email history, show the recipient there.
- Tests: the route sends to the override, with the booking row unchanged; no body sends to `contactEmail`; an
  invalid recipient returns 422 and enqueues nothing. UI: Send opens the confirm step prefilled; Back cancels
  without a request; Confirm posts `{ recipient }` only when it differs.

## 4. "My booking" page: email me my links (public)

**User decisions:** the client enters their email and receives **one email with a fresh link for each upcoming
booking**. Old links are replaced, since only a fingerprint is stored and a new token is the only way to hand the
link out again. The endpoint is **rate limited**. This reverses the 2026-09-21 decision in `client-shell.md`,
which was that there is no public resend endpoint. Record that in the file.

- **Refactor first:** extract the token-rotation part of `resendAccessLink`
  (`backend/src/booking/admin-actions.ts`) into a shared helper, e.g. `issueAccessToken(tx, bookingId, now)` in
  `backend/src/booking/access-link.ts`, which returns the plaintext. Use it in both places.
- **Endpoint:** `POST /api/booking-links` with `{ email }`, mounted with the other public routes in
  `backend/src/app.ts`.
  - Always answer **202 `{ sent: true }`**, with the same body and status whether there are matches, no matches, or
    the rate limit was hit. 422 only for a malformed email.
  - Match with `lower(trim(contact_email)) = lower(trim(:email))` and either `status = 'confirmed'` with
    `starts_at > now()`, or (**user decision, 2026-09-25**) `status = 'completed'` with an outstanding balance or a
    photo link not yet expired (`delivery_url` set and `delivery_expires_on` today or later in Kigali).
  - In one transaction: rotate each matched booking's token, then enqueue **one** email (new template
    `booking_links`) to the address **on the booking** (never the typed string, though they match
    case-insensitively). Its payload lists each booking's reference, service, date and link. The plaintext tokens
    exist only in that payload, as in `access_link_resend`.
  - **Rate limit, per email** (this is what protects clients): skip, silently, if a `booking_links` outbox row went
    to this recipient in the last 10 minutes, or 5 in the last 24 hours. Compute it from the `outbox` table
    (`recipient`, `template`, `created_at`); no new infrastructure.
  - **Rate limit, per IP** (this protects the Brevo quota): a small in-memory fixed window, e.g. 10 requests per
    hour per `req.ip`, with no new dependency. Render sits behind a proxy, so set `app.set('trust proxy', 1)` and
    check that nothing else depends on the old behaviour. Over the limit also answers 202.
- **Email template** `booking_links` in `backend/src/email/templates/`, following `access-link-resend.ts`:
  subject, a list of bookings with one button or link each, and a note that earlier links no longer work. Add a
  render snapshot test, and include it in `catalogue.test.ts`.
- **Frontend:** a new page at `/my-booking` inside `ClientShell` (`frontend/src/routes.tsx`). It has one `main`, an
  `h1`, an email field and a submit button. After submitting it always shows the same message: "If we found an
  upcoming booking for that address, we've emailed you a link." On the invalid-link page
  (`BookingPage.tsx`, `booking:invalidLink`), add a link "Get a new link" pointing to `/my-booking`, as a **new**
  key.
- Tests (backend, real PostgreSQL): 202 for match, no match and limited alike, with byte-identical bodies. The
  match rotates the token (old link now 404, new link from the outbox payload works) and sends one email listing
  all upcoming bookings. Past, cancelled and `pending_payment` bookings are excluded. The per-email limit holds
  across case and whitespace variants of the address. The per-IP limit applies. No response or log line contains a
  token. Frontend: the form, the same message regardless of outcome, validation, and the new link on the
  invalid-link page.

## 5. Remember the booking link on this device, and "My booking" in the header

- When `BookingPage` loads a booking successfully (`GET /api/booking/:token` 200), store the token under
  `localStorage` key `bookly.bookingToken`, the most recently opened booking. Wrap every read and write in
  try/catch, because storage can be unavailable. When a load of the **stored** token answers "not found", remove
  it.
- `ClientHeader` (`frontend/src/pages/ClientShell.tsx`) gains a **"My booking"** link (ghost, placed before
  "Admin login"). It goes to `/booking/<stored token>` when one is stored, otherwise to `/my-booking` (item 4). It
  is a link, not a button. Keep the header reactive: a small hook that reads storage and listens to the `storage`
  event and to a custom event fired by `BookingPage` after it writes.
- At 375 px the bar now holds the wordmark and three links: check it fits on one row with no horizontal scroll. If
  it doesn't, **ask the user** before adding a menu (the design file forbids drawers).
- Tests: `ClientShell.test.tsx` updates its link count and order (`Bookly`, `My booking`, `Admin login`, `Book
  now`). The link targets the stored booking or `/my-booking`. Opening a booking stores its token; a stored token
  that answers 404 is cleared. Storage that throws breaks nothing.
- Note in `client-shell.md`: the token sits in `localStorage` on this device. On a shared device the next person
  can open the booking. It was already in the browser history, so this adds little exposure, but say so.

## 6. Clients change their email, confirmed through the new address

**User decision:** a change takes effect only after the client confirms it from the new address, and the old
address is told.

- **Migration:** add to `booking` the columns `pending_contact_email text`, `pending_email_token_hash text UNIQUE`
  and `pending_email_expires_at timestamptz`, with a CHECK that all three are null or all three are set. The same
  migration adds the new outbox templates: `booking_links` (item 4), `email_change_confirm` and
  `email_changed_notice`. `client_note` (item 8) is added in item 8's migration, the one that creates `booking_note`.
  Each migration drops and recreates `outbox_template_allowed` with the full list so far.
- **Request:** `POST /api/booking/:token/email` with `{ email }` in `backend/src/routes/client-booking.ts`,
  resolving the booking from the token like every route there. Allowed while the booking is `confirmed` or
  `completed`; otherwise 409. If the email equals the current one, answer 200 and do nothing. Otherwise store the
  pending email, a fresh token hash (reuse `generateAccessToken` / `hashAccessToken`) and an expiry 24 hours
  ahead, replacing any earlier request. Enqueue `email_change_confirm` **to the new address**, carrying a link to
  `${WEB_ORIGIN}/email-confirm/<token>`. Rate limit: at most 3 requests per booking per 24 hours, counted from the
  outbox. Answer 202 `{ pendingEmail }`.
- **Confirm:** `POST /api/email-confirmations/:token` (public). Look up the booking by hash with the expiry still in
  the future. Then set `contact_email` to the pending email, clear the three pending columns, enqueue
  `email_changed_notice` to the **old** address (saying which address it changed to, and what to do if it wasn't
  them), and answer 200. An unknown or expired token answers 404, identically. The booking's access link is **not**
  rotated. `client.email` is **not** changed: only this booking's contact email.
- **Frontend:** on `BookingPage`, a "Contact email" line with a "Change" action that opens an inline form. After
  submitting, it shows "Check <new email> to confirm the change; until then we keep writing to <old email>." When a
  change is pending, the page shows it, which means the client booking view must expose `pendingContactEmail`. A
  new route `/email-confirm/:token` posts the token and shows success or "This confirmation link is not valid".
- **Email templates:** `email_change_confirm` and `email_changed_notice`, following the existing templates, with
  snapshot tests.
- Tests: the request stores the pending state and emails only the new address; a second request replaces the
  first; the rate limit holds; confirming swaps the email, emails the old address and clears the pending state; an
  expired or unknown token answers 404 with nothing changed; the confirmation token can't be used as an access
  token (or the reverse); later emails (receipts, delivery) go to the new address; a cancelled booking answers 409.

## 7. Booking stages: in progress, completed, closed, with a legend on both pages

**User decisions:** the stages are a **display stage computed from data that already exists**. The stored
`booking.status` values, their CHECK constraint and every rule that reads them stay exactly as they are. Photo
delivery still requires `status = 'completed'`, and the admin's "Mark completed" and "No-show" actions are
unchanged.

- **Stages**, derived from status, the shoot times, `now` and `delivery_sent_at`:

  | Stage | When | Client sees | Admin sees |
  |---|---|---|---|
  | `awaiting_payment` | `pending_payment` | yes | yes |
  | `confirmed` | `confirmed` and now < `starts_at` | yes | yes |
  | `in_progress` | `confirmed` and `starts_at` ≤ now < `ends_at` | yes | yes |
  | `needs_review` | `confirmed` and now ≥ `ends_at` (the photographer has not marked it completed or no-show) | **shown as `completed`** | yes |
  | `completed` | `completed` and `delivery_sent_at` is null | yes | yes |
  | `closed` | `completed` and `delivery_sent_at` is set (the photos email went out) | yes | yes |
  | `no_show`, `expired`, `cancelled_by_client`, `cancelled_by_admin` | as stored | yes | yes |

  "Completed" means the shoot is done, whatever is still owed (**user decision**). An outstanding balance is never
  hidden: it shows in the payment section and as a notice (item 8).
- **One source of truth:** a pure function `bookingStage(booking, now, audience: 'client' | 'admin')` in
  `backend/src/booking/stage.ts`. Expose `stage` in the client view (`backend/src/booking/client-view.ts`), the admin
  detail view (`admin-view.ts`) and each row of the admin list (`admin-list.ts`). Keep `status` in the responses too:
  existing code and tests read it.
- **Admin list filtering:** the status filter in `frontend/src/pages/admin/AdminBookings.tsx` switches to filtering by
  stage. Express each stage as a SQL predicate in `admin-list.ts` (same `now` as the display), and add a parity test
  that checks every stage's predicate against `bookingStage()` over fixtures covering every row of the table above.
  Keep accepting the old `status` query values, so existing links don't break.
- **Badges:** extend `frontend/src/components/ui/status-badge.tsx` with treatments for `in_progress`, `needs_review`
  and `closed` (for example the lucide `Camera`, `ClipboardCheck` and `Archive` icons). Follow the file's rule: every
  stage must stay distinguishable in greyscale (a different edge, fill and icon each), with no heavy red edge. Render
  badges from `stage`, and add labels as **new** keys (`booking:stage.*`, `admin:bookings.stage.*`). The old
  `status.*` keys stay untouched.
- **Legend ("what do these mean?"):** a small info-icon trigger next to the **Status column header** of the admin
  bookings table, and next to the status pill on the client booking page. Use Radix `Popover` from the installed
  `radix-ui` package, not a hover-only tooltip: it must open on click or tap and on keyboard (Enter/Space), and may
  also open on hover. It needs an `aria-label` such as "What the statuses mean". Its content lists each stage the
  audience can see, as the badge plus a one-sentence meaning (new i18n keys). The client never sees `needs_review`.
  Check that no e2e spec counts buttons page-wide on these pages (`client-booking.spec.ts` counts them on the
  invalid-link page only).
- Update `design-system/bookly/MASTER.md` section 7 (statuses) and the admin-bookings and booking page files.
- Tests: `bookingStage()` for every row of the table, including the boundaries at exactly `starts_at` and `ends_at`,
  and the client/admin difference for `needs_review`; each view exposes `stage`; the list filter's parity test;
  badges and legends render and open with keyboard and pointer; the legend's content matches the audience.

## 8. Notifications on the client booking page, and photographer notes

**User decisions:** notices are **automatic** (built from what the system already sends) **plus notes the
photographer writes**. A client can **close** a notice, and a notice they have seen **stops showing a day after
they first saw it**. Both are remembered per device.

- **Automatic notices.** The client view (`GET /api/booking/:token`) gains `notices: { id, kind, at, data }[]`,
  newest first, built on the server from:
  - this booking's `outbox` rows (never deleted, so they are the history) whose template is client-facing, not
    counting cancelled rows: `reschedule` (moved to the new time), `session_fee_request` (the amount asked),
    `payment_receipt` (the amount received), `photo_delivery` ("your photos are ready: check your email"),
    `cancellation` when the photographer cancelled. **Never pass an outbox payload through**: several payloads hold
    a plaintext access token. Map each kind to an explicit allowlist of safe fields.
  - a derived `balance_due` notice while `outstandingRwf > 0` and the stage is `completed` or `closed`. Its id
    includes the amount, so a new balance counts as a new notice.
  - photographer notes (below).
  Ids are stable: `outbox:<id>`, `note:<id>`, `balance:<amount>`.
- **Photographer notes.** This needs a migration: a new table `booking_note` with `id`, `booking_id` (FK, cascade),
  `body` (text, CHECK 1–1000 characters), `emailed` (boolean), `created_at` and `deleted_at` (nullable). A new
  outbox template `client_note` goes into the same constraint update as item 6's templates.
  - Admin API: `POST /api/admin/bookings/:id/notes` with `{ body, email: boolean }` creates the note and, when
    `email` is true, enqueues `client_note` to the booking's contact email. `DELETE
    /api/admin/bookings/:id/notes/:noteId` soft-deletes it, which hides it from the client. The admin booking detail
    view lists the notes.
  - Admin UI (`AdminBookingDetail.tsx`): a "Messages to the client" section with the list (time, text, "emailed"),
    a textarea with a character count, an "Also email it to the client" checkbox (**ticked by default**, user
    decision 2026-09-25), Send, and a delete action per
    note using the file's inline-confirm pattern.
  - The body is plain text everywhere: render it as text, never HTML, in the page and in the email template (escape
    it).
- **Client UI** (`frontend/src/pages/booking/BookingPage.tsx`): a notices list at the top of the page's `main`,
  above the booking facts. Each notice has an icon, a sentence, its time, and a close button (`aria-label`
  "Dismiss"). A `balance_due` notice links to the payment section. Per device, in `localStorage` under
  `bookly.notices.<booking reference>`, keep `{ [noticeId]: { firstSeenAt, dismissed } }`, and wrap every read and
  write in try/catch. Show a notice unless it has been dismissed or it was first seen more than 24 hours ago. Stamp
  `firstSeenAt` the first time it renders. **Exception (user decision): `balance_due` is never hidden by time**;
  only closing it hides it. Notes are labelled "From your photographer". When nothing is left to show, render nothing (no empty box).
- Tests (backend): each outbox kind maps to its notice with only allowlisted fields, and no token ever appears in
  the response (assert against the raw JSON); cancelled outbox rows and admin-only templates are excluded; the
  balance notice appears and disappears with the balance; notes can be created, emailed or not, soft-deleted and
  hidden, and the admin routes need a session; a note body at 1001 characters answers 422. Frontend: notices render
  newest first; dismissing hides and remembers; a notice first seen over 24 hours ago is hidden; storage that
  throws still renders the notices; the admin notes form (send, email checkbox, delete with confirm).

---

## Open questions to ask the user before starting
1. ~~Lookup scope~~ **Answered 2026-09-25:** yes. Include completed bookings that still owe money or whose photo
   link is live (item 4).
2. Items 4, 6 and 8: draft the wording of the new emails (`booking_links`, `email_change_confirm`,
   `email_changed_notice`, `client_note`) and ask the user to review it before merging.
3. ~~Note author~~ **Answered 2026-09-25:** notes say "From your photographer". A photographer profile and a
   contact for issues or questions will come later; leave room for them, but build nothing for them now.
   "Also email it" starts ticked.
4. ~~24 hours for the balance notice~~ **Answered 2026-09-25:** `balance_due` stays until the balance is paid. It
   can be closed, but is never hidden by time; if the amount changes, it is a new notice and shows again.

## Done when
All eight items are merged on the branch with tests. The four suites pass (backend and frontend vitest, e2e,
typecheck and lint). The design files record the reversed decisions and the new stages. Screenshots at 375 px and
1280 px show the header, `/my-booking`, the skeletons, the delivery confirm step, both status legends open, the
client notices and the admin notes section.

## As built (2026-09-25)

All eight items are on `feat/client-access`, one commit each. Where the build differs from the text above:

- **Item 1:** the placeholder cards have no image block: no service has a cover image, and `services.md` forbids an empty top band.
- **Item 4:** the per-IP limit is 20 requests an hour (not 10), so visitors behind one shared address are not cut off. The `booking_links` email is stored with no `booking_id`, because it is about an address and may cover several bookings.
- **Item 5:** below `sm` the header's "Admin login" moves to the footer (user decision): four items do not fit at 375 px.
- **Item 6:** the booking page never carries a full email (user decision): the API sends `maskedEmail` and `pendingMaskedEmail` (`a•••••@example.com`), and the 202 no longer echoes the typed address. The `/email-confirm/:token` page confirms on a **button**, never on load, because mail scanners open links.
- **Item 7:** old `?status=` links open on the stages their status now spans.
- **Item 8:** the admin section is titled "Notes to the client", to keep it apart from the existing "Messages sent". A note is refused (409) on a booking that was never confirmed. The client-note email carries no link, because no token plaintext exists to link with.
- **Deploy:** three new migrations (`booking_links_email`, `contact_email_change`, `booking_notes`, all `20260925…`) need `prisma migrate deploy` against the production database before the new API starts.

