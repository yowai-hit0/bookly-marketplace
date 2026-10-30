# Platform Photographer Detail — Page Design

> **Project:** Bookly · **Route:** `/platform/photographers/:id` (inside `PlatformLayout`) · **Files:** `frontend/src/pages/platform/PlatformPhotographerDetail.tsx`, `frontend/src/pages/platform/PhotographerModeration.tsx` (shared with the list), `frontend/src/platform/photographers.ts`
> **Written:** 2026-10-27, Phase 9 (marketplace spec R9.1, R9.4; user decision 4). Built inside `admin-console.md`; where they disagree for this page, this file wins.

## What this page is

Everything a platform admin weighs before approving, suspending or paying one photographer, from one read (`GET /api/platform/photographers/:id`), with the same three moderation actions as the list. Read-only otherwise.

## Getting here and back

- Each row of `/platform/photographers` names the photographer as a link (the display name, accent, no underline until hover) to this page. The link carries the list's view in router state (`?review=` or `?status=`), so **Back to photographers** returns to the same view. Arriving any other way (a reload, the Activity page, a pasted link), Back goes to the plain list.
- The Activity page links each entry's photographer here.

## Layout

`main`, `PAGE max-w-5xl`. `BackLink` first. Then:

1. **`PageHeader`:** eyebrow `Users` + "PHOTOGRAPHERS"; `h1` the display name; beside it the status badge (the list's: pending = chip + `Clock`, approved = success tint + `CircleCheck`, suspended = danger tint + `CircleX`) and, while pending, submitted and renamed, the list's warning badge "Handle changed since submission". Meta row: `/p/<handle>` (mono), the login email, and, for an approved studio only, "View public profile" (opens `/p/<handle>`; for anyone else it would be a 404). **Actions** (right from `lg`, stacked full width on a phone): the moves the API allows from this status, the list's buttons and dialogs exactly (Approve / Suspend / Reactivate, outline; Approve disabled with "Not submitted for review yet" beside it while the studio has not submitted).
2. **Notice:** after an action, success (`role="status"`) or warning (`role="alert"`: stale, `409 not_submitted`). After any action the page reads the detail again, quietly (the content stays until the answer lands).
3. **Payout warning:** when `methodChangedRecently`, a console warning callout (`TriangleAlert`) "The payout method was changed in the last 72 hours…". It sits high because it matters before money moves.
4. **Sections**, each an `h2` under a full-bleed hairline (`border-t pt-8 lg:pt-12`), in this order:
   - **Timeline:** an `ol`, oldest first, each row a 16px icon, the event in words and the Kigali date and time in mono. Events present only when their date is: signed up (`UserPlus`), submitted for review (`Send`; "Not submitted for review yet" muted when null), handle changed (`PencilLine`, "Handle changed to /p/<handle>"), approved (`CircleCheck`, "Approved by <email>"; "by a platform admin" when the approver is unknown), suspended (`CircleX`, with "Reason: …" below as plain text, `wrap-anywhere`, `whitespace-pre-line`).
   - **Profile:** a `dl` in two columns from `md`: bio (pre-line, or "No bio yet" muted), contact phone, WhatsApp, contact email (each "Not given" muted when null), districts (comma list), categories (chips; an inactive one gets a dotted edge and the word "hidden", because the public no longer sees it, decision 3), and the cover photo as a 4:3 thumbnail (https only, `no-referrer`, the broken-image box when it fails; "No cover photo" when null).
   - **Setup:** "4 of 6 done" (`h3`, tabular), then the six items in the studio checklist's order and words, each with `CircleCheck` (success) or `Circle` (muted) and a mono DONE / TO DO word. No links: they point into the studio.
   - **Subscription:** `null` says "No subscription yet: it starts when the studio is approved." Otherwise a `StatGrid`: status (the console subscription badge), period ends, hidden after, taking bookings (Yes / No). Then the periods table (Period, Dates, Price, Paid), newest first, reflowing to stacked rows inside its own `@container` under 40rem.
   - **Payout method (masked, decision 4):** the provider (MTN MoMo, Airtel Money or the bank's name, with `Smartphone` / `Landmark`), the account name, and `•••• 1234` in mono (the `••••` is `aria-hidden`; the accessible text is "ending in 1234"). A muted line says the full number is on the payouts screen. `null`: "No payout method yet."
   - **Bookings and services:** a `dl` grid (two columns, four from `md`) of the eight booking statuses with their counts in mono (zeros shown, muted), then "3 services, 2 active".
   - **Earnings:** `StatGrid` of Payable now, In a draft payout, Paid out (mono money). A **negative** payable takes the danger tone (tile tint and red value with a leading minus) and the line "Reversals outweigh new earnings: they are netted from the next payout." under the grid.
   - **Recent activity:** the latest 20 entries in the Activity page's row style (sentence, actor, Kigali time; no photographer link, since it is this page), then **See all activity for this photographer** (link to `/platform/activity?photographerId=<id>`, carrying the name in router state). Empty: "Nothing recorded for this photographer yet."

## States

loading (header and three sections as skeletons, `LoadingRegion`), load failed (+ Try again), not found (a 404, or a 400 for a malformed id: the header says "This photographer doesn't exist"), the page, action saving, action done, action stale, not submitted (409), gone (404 during an action: the not-found view and a warning).

## Do not

- No full payout number on this page (decision 4); the payouts screen shows it, where money is sent.
- No editing of the photographer's profile from here.
- No booking cancellation (decision 2).
- No user text as markup: bio, reason and names render as plain text.
