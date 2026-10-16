# Admin Settings — Page Design

> **Project:** Bookly · **Phase 3 section:** 5 (with the admin shell and login)
> **Route:** `/admin/settings` (inside `AdminLayout`)
> **File:** `frontend/src/pages/admin/AdminSettings.tsx` (shared `AdminField.tsx`)
> **Added by the discovery rule (2026-09-21):** the page shipped as feature work on `main` (commit `d02bd41`) and had no design file, so Section 5 would have restyled it blind.
> This file overrides `design-system/bookly/MASTER.md` for this page. Read MASTER's "Hand-review addendum" first.
> **Overridden 2026-09-26 by `design-system/bookly/admin-console.md` (admin console redesign), which wins where they conflict:** Restyled per `admin-console.md`: the card becomes a flat bordered panel, hints are 13px muted, and the saved confirmation is the console success callout (still `role="status"`, still above the button). Field behaviour and `disabled` while saving hold.

Five numbers that change what every future booking costs and when it can be made: the booking-fee percentage, the minimum notice, how long a hold lasts, the buffer between shoots, and how long a photo link keeps working. Nothing already booked moves when they change — a booking snapshots its own fee and buffer.

## Layout (keep the order)

`main`, `max-w-3xl`, `px-4 py-6`, `flex-col gap-4`. Order: page heading + intro -> loading / load-failed -> one `Card` holding the whole form.

- **Page heading:** `h1` at **`text-2xl`** (the shipped page uses `text-xl`; see `docs/redesign-pending.md` section 5). Intro `text-sm muted`, not `text-xs`.
- **One card, one form.** `Card` -> `CardContent` -> `form` (`aria-label` = the page title, `noValidate`). No `CardHeader`: the page heading already names it, and a second title would repeat it.
- Fields: `grid gap-3 sm:grid-cols-2`. Five fields means the last one sits alone on the second column's row — that is fine and better than a single 3xl-wide column of short number inputs. Do not stretch any field to full width to "balance" the grid.
- Below the grid, in this order: the saved confirmation, the form error, the submit button (`self-start`).

**Changed 2026-09-27 (admin console fixes, item 3, user decision):** on screens of at least 1280x720 the whole page shows without page scroll, idle or just saved. The column is `max-w-5xl` (was `3xl`), the five fields sit three to a row from `lg` (two from `sm`, one below), and the page's vertical rhythm is tighter from `lg` (32px padding and section gap instead of 48px). No field, hint or behaviour changed; smaller screens scroll as before.

## Fields

Every field goes through `AdminField` — label above, **hint below the input**, error under the hint. The hints are the whole reason this page is usable; they are not optional chrome.

- Hints are `text-xs muted` and must stay **at least 4.5:1** on the card. They say the unit ("in hours", "in minutes", "a percentage"), which is what stops a photographer typing `0.375` into a field that wants `37.5`.
- Inputs are `type="text" inputMode="decimal"` — deliberate, so the number spinner never appears and a comma or a stray space can be rejected with a sentence instead of being silently coerced. Do not change them to `type="number"`.
- Input height **44px** with 16px text on a phone (the primitive is 32px). These are five short numeric values: keep them narrow-ish inside the grid cell rather than full-bleed, and `tabular-nums` so typed digits do not shift.
- Errors are per-field and come from either the local schema or the API's named fields; both land in the same place. A field in error gets `aria-invalid` (the primitive already draws the destructive border and ring) — never colour alone, so the sentence under it always appears too.

## Saving

- The submit button is the page's single primary action, `self-start`, and is the one place in admin that uses real `disabled` while in flight (matching login). Label swaps to the saving string.
- **The saved confirmation** (`role="status"`) sits directly above the button so it appears where the eye already is. Give it a success treatment that is not new colour invention: a `Check` icon (`size-4`) plus the existing text, in `text-sm`. It must not look like an error, and it must not be a toast — this branch adds no toast system.
- After a save the inputs are redrawn from what the API stored, not from what was typed. Visually nothing may jump: the grid must not change height between idle and saved, so reserve the confirmation's line or let it push only the button down.

## States

loading (`role="status"`), load failed (destructive + Retry), idle, field-invalid (one or more), saving, saved, save failed (`role="alert"`).

## Admin nav

This page is nav item **five** of five: calendar, bookings, catalogue, availability, **settings**. Icon `Settings` (`size-4`, `aria-hidden`). It is last in the list, and it is the only nav item that is not day-to-day work — leave it last.

## Do not

- No tabs, no sections, no "advanced" disclosure: five fields do not need dividing.
- No sliders, steppers or unit dropdowns — they would change what is submitted, which is logic.
- No autosave, no dirty-state warning, no reset button: none exist, and each is behaviour.
- No new copy. Every string already exists under `admin:settings.*`.
