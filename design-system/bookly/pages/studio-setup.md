# Studio Setup — Page Design

> **Project:** Bookly · **Route:** `/studio/setup` (inside `AdminLayout`) · **Files:** `frontend/src/pages/admin/AdminSetup.tsx`, `frontend/src/admin/setup.ts`
> **Written:** 2026-10-25, Phase 7 (marketplace spec R7.3, T7.1). Built inside `admin-console.md`; where they disagree for this page, this file wins.

## What this page is

The pending studio's to-do list before the Bookly team reviews it: six items, each judged by the API from the studio as it is now (`GET /api/studio/setup`), each linking to the page that fixes it, then the one **Submit for review** (`POST /api/studio/setup/submit`).

| Item | Done when (API) | Link |
|---|---|---|
| Your profile | display name and bio both set | `/studio/profile` |
| Categories | at least one active category | `/studio/profile#categories` |
| Districts | at least one district | `/studio/profile#districts` |
| Payout method | a current payout method | `/studio/payout-method` |
| Services | an active service with an active package | `/studio/catalogue` |
| Working hours | an open weekly rule | `/studio/availability` |

## Layout

`main`, `PAGE max-w-3xl`. `PageHeader`: eyebrow `ListChecks` + "STUDIO", `h1` "Set up your studio", intro. Then:

1. **Notice** (after a submit: success "Your studio is submitted for review."; after a `409 not_pending`: a warning, and the page reloads).
2. **State callout**, when past setting up: awaiting review (info, `Clock`: "You submitted your studio for review on 25 Oct 2026, 10:00. … You can keep editing meanwhile."), approved (success, `CircleCheck`), suspended (destructive, `CircleX`). Nothing while still setting up.
3. **Progress:** an `h2` "4 of 6 done" (tabular), then a 6px bar (chip track, success fill, 300ms width transition behind `motion-safe`), `aria-hidden`: the words carry it.
4. **Checklist:** an `ol` in one hairline panel. Each row: `CircleCheck` (success) or `Circle` (muted) icon, an `h3` with the item's name and a mono **DONE** / **TO DO** word (green for done; the word, not the colour, is the state), one muted line on what is needed, and the fix link as an outline button with `ArrowRight` ("Add a payout method"), right-aligned from `sm`, under the text on a phone. Done items keep their link: things can be changed after.
5. **Submit section** (only pending and not yet submitted), under a hairline: the missing list when the API refused, the failure line, then **Submit for review** (`Send`, inverted neutral, real `disabled` unless `canSubmit` or while submitting) with "Finish every step to submit." beside it (`aria-describedby`) while it is disabled.

## Submitting

- Enabled only when the API's `canSubmit` is true (pending, not submitted, every item done).
- **`422 setup_incomplete { missing }`** (something was undone between the read and the press, T7.1): a warning callout (`role="alert"`) "These steps still need finishing before you can submit:" with each missing item as a link to its page, and the checklist is read again so the rows match.
- **200:** the page shows the answer (awaiting review) and asks the layout to read `/me` again, so the banner turns from "finish your setup" to waiting for review.
- **`409 not_pending`** (approved or suspended meanwhile): a warning, the checklist reloads into its approved or suspended state, and the layout reads `/me` again.

## States

loading (skeleton of the progress and six rows), load failed (+ Retry), setting up (some to do), ready to submit, submitting, submit refused (missing list), submit failed, awaiting review, approved, suspended.

## Studio nav and banner (decision)

**Both:** Setup is the **first** nav item while the studio is pending (`ListChecks`; it is the pending photographer's main task and must be one tap away on every page), and the pending-not-submitted banner on every other page links to it ("Go to setup"). Once approved or suspended the nav link goes; the route still answers and shows the approved or suspended state. On this page the layout drops its pending banners, since the page says it all. See `admin-shell.md`.

## The platform side (review)

`/platform/photographers` has three linked views kept in `?review=`: All photographers, Awaiting review (`review=awaiting`, the target of the submission email) and Still setting up (`review=setting_up`). The status filter shows only in All. The Submitted column reads "Not submitted" when there is no date. For a studio that hasn't submitted, Approve is disabled with the reason beside it, and a `409 not_submitted` shows a message and refreshes the row. If a submitted, pending studio changes its handle, the row gets a warning-tint badge "Handle changed since submission" and the line "Now /p/<handle>, changed <date>". The badge shows only while the studio is pending and submitted, and the timestamp stays on record after approval.

## Do not

- No auto-submit when the last item is done: submitting emails the platform admins, so it is the photographer's call.
- No item marked done by the page itself: only the API judges.
