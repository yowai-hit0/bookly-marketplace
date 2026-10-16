# Prompt: admin console fixes (loading, modals, fit-to-screen, bookings list, completion rules)

You are working in the Bookly repo (Express 5 + Prisma 7 + PostgreSQL in `backend/`, React + Vite + React Router + FullCalendar 6 in `frontend/`). Build the seven changes below on a new branch `feat/admin-console-fixes` off `redesign/client-front`. Make one commit per numbered item, and do not push without asking. Where this prompt leaves a decision open, or the code contradicts it, **stop and ask the user**. Do not guess. The user's decisions are final. Do not argue them again.

User decisions (2026-09-27):
- "In progress" stays automatic, worked out from the clock. Nothing to build for it.
- No-show and Mark completed timing stays as it is (from the start time). No change.
- Add a "Record cash payment" action.
- Add-ons can be edited while `confirmed` once the shoot has started. They lock once the booking is `completed`.
- A booking can only be `completed` when nothing is owed. It completes automatically when a session fee or cash payment clears the balance after the shoot has started. Otherwise the admin clicks Mark completed, which is only enabled when nothing is owed.
- Pagination: numbered pages plus a total, in a pager pinned to the bottom of the screen.
- Status filter: a multi-select dropdown plus a ❔ legend popover.
- Modals are used for both create and edit forms. The availability page's "Add block" stays inline.
- "No page scroll" applies to screens of at least 1280×720.
- Bookings table: all columns fit with no horizontal scroll. Phones keep the stacked cards.

## Token budget (read first, follow strictly)
- Do the work yourself, inline. Use subagents only when a task is bounded and self-contained, and **always pass `model: "sonnet"`** (use `"haiku"` for a single lookup like "find where X is defined"). Never start an Opus subagent. Run at most one subagent at a time unless two are truly independent. Give each one exact file paths, and ask for an answer of 200 words or less, with no file dumps.
- Use `Grep` with narrow patterns, and `Read` with `offset`/`limit`. `AdminBookingDetail.tsx` is about 1,240 lines, and its test file is about 1,700 lines, so never read either whole. Don't re-read a file you just edited.
- While you iterate, run only the tests for the files you touched (`npx vitest run <file>`, `npx playwright test <spec>`). Run the full gates once per commit. Use quiet reporters, and read only the failures.
- The finish review is one Sonnet agent per commit at most, and only for items 5–7.

## Ground rules
- **Read before writing:** `DESIGN.md` (Admin console section), `design-system/bookly/admin-console.md`, and the `design-system/bookly/pages/admin-*.md` file for each page you touch. When a change contradicts one of them, update that file and record the decision dated 2026-09-27.
- **i18n:** both `en.json` files take **new keys only**. Never edit an existing string. Leave unused keys in place.
- **Database:** schema changes go through a new Prisma migration (`npm run db:migrate`). **Never `prisma db push`**, because it drops the exclusion constraint. Look for CHECK constraints (for example on `payment.provider` or `payment.kind`) before you add a value.
- **Tests:** run backend DB tests against a **local** `TEST_DATABASE_URL`. **Never use the Neon `DATABASE_URL`** in `backend/.env`. Match the existing test style: a header comment saying what is proven, and real PostgreSQL rather than mocks. Update any e2e specs (`frontend/e2e/admin-*.spec.ts`) that break because of intended changes.
- Gates before each commit: `npm run typecheck`, `npm run lint` and `npm test` in both packages, plus `npx playwright test` in `frontend/`. For UI changes, screenshot at 1280×720 and 375 px, and check there is no horizontal scroll. A `fullPage` screenshot on a tall page turns touch emulation off, so measure touch target sizes before you take one.

---

## 1. Dialog primitive and modals everywhere applicable
- Add `frontend/src/components/ui/dialog.tsx`: the shadcn Dialog built on the installed `radix-ui` package, styled in the console look (tokens from `admin-console.md`). It closes on the ×, on Esc, on an overlay click and on Cancel. It traps focus and returns focus to the button that opened it. It scrolls inside itself on short screens.
- Move every create and edit form into a modal, opened by its button. After a successful save, close the modal and refresh the data. Closing without saving discards the changes. Forms in scope:
  - Calendar "Block time" (`BlockForm`).
  - Catalogue: new or edit service, package and add-on (`EntityForm`).
  - Availability: working hours edit (`WorkingHoursForm`) and editing an existing block.
  - Booking detail: the forms that are panels today (reschedule, cancel with reason, add add-on, delivery edit), plus the new cash payment form from item 7.
- **Exception:** the availability page's **"Add block"** stays inline, as it is today.
- One-click actions (Mark completed, No-show, Resend link) stay buttons. Don't wrap them in a modal unless one already asks for confirmation.

## 2. Skeleton loading on every admin page
- The admin pages are Calendar, Bookings, Booking detail, Availability, Catalogue and Settings. Leave out login and reset.
- While data loads, keep the shell (nav, header, breadcrumbs) real, and render the page's **real layout** with placeholder blocks. Use the existing `frontend/src/components/ui/skeleton.tsx`. Each placeholder matches the size and grid of what replaces it, so nothing jumps when data arrives. The pattern to follow is the YouTube one: you see the layout, but no content.
- Bookings: when filters or the page change, only the table rows switch to skeleton rows. The filters and the pager stay put.
- Accessibility: put `aria-busy="true"` on the loading region, `aria-hidden` on the skeletons, and an `sr-only` live region with a new loading key. Honour `motion-reduce:animate-none`.
- If there's repetition, put the shared pieces in `frontend/src/pages/admin/console/`.

## 3. Settings fits the screen
- On screens of at least 1280×720, `AdminSettings.tsx` shows everything **without page scroll**. Re-lay it out (grouped cards in a two- or three-column grid, tighter vertical rhythm). Don't remove fields or change behaviour. Smaller screens scroll normally.

## 4. Calendar with no double scroll
- On screens of at least 1280×720, the admin calendar page itself **never scrolls**. The calendar fills the height left under the shell and toolbar (`100dvh` minus the chrome, done with flex and `min-h-0`, or FullCalendar's `height="100%"`/`expandRows`).
- **Month view:** the whole month is visible with no scrolling anywhere. Rows stretch or shrink to fit, and busy days use FullCalendar's "+N more" (`dayMaxEvents`).
- **Week and day views:** only FullCalendar's own time-grid scroller scrolls. Keep the current scroll-to-08:00 behaviour.
- Below 1280×720, the page may scroll, but never both the page and the calendar for the same content.

## 5. Bookings list
Files: `frontend/src/pages/admin/AdminBookings.tsx`, `backend/src/booking/admin-list.ts`, `backend/src/routes/admin-bookings.ts`.
- **Client column:** show the name only. Remove the email underneath it.
- **Remove the reference column.** The whole row becomes clickable and opens the booking detail. Use one real link per row, stretched over the row, so keyboard, middle-click and open-in-new-tab all work. Show a hover and focus state, and a chevron arrow at the row's end. Search by reference still works.
- **Fit:** on screens of at least 1280 px, every column (money included) is visible with no horizontal scroll. Tighten or reflow the columns to get there. Phones keep the stacked-card layout.
- **Numbered pagination:** switch the list from cursor paging to `page` + `pageSize` with a total count. The response gives `total`, `page` and `pageCount`, and ordering stays deterministic (start, then id). Update the header comment that explains why it was a cursor. The pager shows "‹ 1 2 … 7 ›" with "Showing 21–40 of 132". It is **pinned to the bottom of the screen**, always rendered (buttons disabled on a single page), and lives in the URL search params next to the existing filters. Changing a filter resets to page 1. Update the backend tests.
- **Status filter:** replace the row of status chips with **one multi-select dropdown**, built on the existing `popover.tsx` + `checkbox.tsx`. The button reads "Status: All" or "Status: N selected". It keeps today's filtering, since the backend already accepts `stages[]`. Next to it goes a **❔ icon button** (lucide `CircleHelp`, with an accessible name) that opens a legend popover. The legend lists every admin stage with its console status glyph (`StatusShapeGlyph`/status badge) and one line on what it means and what the admin should do. Use `backend/src/booking/stage.ts` as the source of truth for the meanings. Add new i18n keys.

## 6. Booking detail: add-ons and "completed means paid"
Files: `backend/src/booking/admin-view.ts` (action flags), `admin-actions.ts` (`close()`), `addons.ts`, the payment-success path (find where a `succeeded` session-fee payment is applied: `payments/webhooks.ts` or `reconcile.ts`), and `AdminBookingDetail.tsx`.
- **No change** to No-show or Mark completed timing (both appear once the shoot has started), and **no change** to the "in progress" stage, which is automatic.
- **Add-ons:** you can add or remove them when `status === 'confirmed'` and the shoot has started. They are **locked once `completed`**. Change the gate in `addons.ts` and `canEditAddons` together. `canEditDelivery` keeps needing `completed`, so separate it from `editableAddons`. The add-ons section and its "Add add-on" modal are visible whenever they are editable. After an add-on is added, the page points the admin to "Request session fee".
- **Completed requires nothing outstanding:** `close(…, 'completed')` refuses when `outstandingRwf > 0`, with a new result such as `balance_due`, and the route maps it. `canComplete` also requires nothing to be owed. When money is owed, the button shows disabled with a hint giving the amount (new key).
- **Auto-complete:** when a session fee (or a cash payment, item 7) succeeds, check the booking in the same transaction. If it is `confirmed`, the shoot has started, and `outstandingRwf` is now 0, set `status='completed'` and `completedAt`, exactly as `close()` does. If the balance is cleared before the shoot starts, the booking stays `confirmed` until the admin marks it completed. The webhook must be idempotent, so a replay doesn't complete it twice.
- Legacy `completed` bookings that still owe money keep the ability to request a session fee. Don't migrate the data.
- Record in the spec (grep `§6.15` / `§3.5` under `docs/`) that post-shoot add-ons now come before completion.
- Tests: the add-on gate, `balance_due`, auto-complete on the webhook, a webhook replay, and no auto-complete before the shoot starts.

## 7. Record cash payment
- A new admin action: `POST /admin/bookings/:id/payments/cash` with `{ amountRwf, note? }`. It is allowed on a `confirmed` booking (or a legacy `completed` one that owes money), for an amount from 1 up to what is outstanding. It writes a `succeeded` payment row with a cash provider or kind. Add a migration if a CHECK needs the new value.
- It runs item 6's auto-complete check in the same transaction.
- If an online session-fee request is `initiated`, refuse while a provider prompt is in flight (reuse `in_progress` from `payments/session-fee.ts`). Otherwise supersede or void the open request, so the client can't pay the same balance twice. The client booking page then shows nothing to pay.
- It shows in the booking's payment history labelled "Cash", and refund logic treats it like any other succeeded payment. Don't send the client an email unless the user asks.
- Booking detail gets a "Record cash payment" button (shown when money is owed) that opens a modal (item 1) with the amount prefilled to what is outstanding.
- Tests: over-payment refused, the in-flight refusal, superseding the open request, and auto-complete.

---
When done, list anything you deferred or asked about, and the screenshots taken.
