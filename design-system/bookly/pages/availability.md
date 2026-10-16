# Admin Availability — Page Design

> **Project:** Bookly · **Phase 3 section:** 5 (with the admin shell and login)
> **Route:** `/admin/availability` (inside `AdminLayout`)
> **Files:** `frontend/src/pages/admin/AdminAvailability.tsx`, `WorkingHoursForm.tsx`, `BlockForm.tsx` (and the shared `AdminField.tsx`)
> **Added by the discovery rule (2026-09-21):** the page shipped as feature work on `main` (commit `d02bd41`) and had no design file, so Section 5 would have restyled it blind.
> This file overrides `design-system/bookly/MASTER.md` for this page. Read MASTER's "Hand-review addendum" first.
> **Overridden 2026-09-26 by `design-system/bookly/admin-console.md` (admin console redesign), which wins where they conflict:** Restyled per `admin-console.md`: the two cards become flat bordered panels, the `h1` is 30px Geist, the overlap warning is the console destructive callout with the solid confirm (`--console-danger-solid`), and closed rows keep their `CircleSlash` state marker. The two-lists-on-one-page rule, inline forms and `window.confirm` hold.

Two things on one screen — the weekly/dated **working hours** and the dated **blocks** — because between them they answer one question: when can a client book? Reading either alone gives the wrong answer (`AdminAvailability.tsx` header comment; user decision, 2026-09-21).

## Layout (keep the order)

`main`, `max-w-5xl`, `px-4 py-6`, `flex-col gap-4`. Order: page heading + intro -> action error -> loading / load-failed -> **Working hours** card -> **Blocks** card.

- **Page heading:** `h1` at **`text-2xl`**, matching bookings and booking detail. The shipped page uses `text-xl`; that is the admin title inconsistency recorded in `docs/redesign-pending.md` section 5, and this page is on the 1.5rem side of it. The intro under it moves from `text-xs` to `text-sm muted` — `text-xs` body copy is too small for a sentence someone actually reads.
- **Two cards, not tabs.** Both lists must be visible at once; a tab would hide half the answer. `Card` -> `CardHeader` (`CardTitle` wrapping the `h2`, intro `p` under it) -> `CardContent`.
- Card intros are `text-sm muted`, same change as the page intro.

## Rows (both lists)

Each list is a `ul`; each row is a `li`, `flex-wrap items-center justify-between gap-2`, `border-b py-2 last:border-b-0`. Keep the semantics — these are lists, not tables, and they never scroll sideways.

- **Left, the description** (`flex-wrap items-center gap-2`): the primary text in `font-medium`, then the qualifiers muted at `text-sm`.
  - Working hours: name ("Every Monday" / a date) -> `Badge variant="outline"` reading Weekly or Dated -> the window ("09:00 to 17:00") or "Closed" -> an optional note after a `·`.
  - Blocks: the date or date range, then the reason (or "No reason given") muted.
- **Closed and blocked rows must not read as normal ones.** A closed weekday and an open one differ only in a word today. Give the *state* a treatment, not the row: the Weekly/Dated badge stays neutral, and "Closed" takes a muted-but-distinct pill or a `CircleSlash` icon (`size-4`, `aria-hidden`) before the word. Never colour alone, and never dim the whole row — a closed day is not less important.
- **Right, the actions:** `flex-wrap gap-1`, Edit (`size="sm" variant="outline"`) then Delete (`size="sm" variant="destructive"`). Both already carry a row-naming `aria-label`; keep those names exactly. At `< sm` the two buttons may wrap under the description, and each must stay a **44px touch target** (the `sm` primitive is 32px: raise it here with `className`, as the client pages do).
- Delete goes through `window.confirm`. That is logic, not visuals: do not replace it with a dialog in this branch.

## The two forms (`WorkingHoursForm`, `BlockForm`)

**Changed 2026-09-27 (admin console fixes, item 1, user decision):** working hours (new and edit) and editing an existing block open in a dialog (`admin-console.md` §6.11); **"Add block" stays inline** under its list, as below. The rest of this section describes the inline case.

Both open **inline**, in place of the row being edited or under the list for a new one, and only one is open at a time. Keep that: an inline form keeps the surrounding rows visible, which is the whole reason the two lists share a page.

- Form shell: `flex-col gap-3 rounded-md border p-3`, `aria-label={title}`, `h3` at `text-sm font-medium`. Inside a card, the form's border needs to read as a nested surface — use `bg-muted/40` with the border, or `rounded-lg` and a slightly heavier border. It must not look like a second card floating in the first.
- **Fieldset legends use the heading font** (fixed in Section 2, MASTER addendum). The kind/mode radio rows are `flex-wrap gap-4`, `Label` per option, native radio at `size-4 accent-primary`. On a phone the row wraps; each label keeps a 44px hit area.
- Field grids: `grid gap-3 sm:grid-cols-2` (dates and times), `sm:grid-cols-3` where `BlockForm` uses it. All labelling goes through `AdminField` — label above, hint below, error below that. Do not wire `aria-describedby` by hand.
- Buttons row at the bottom: submit (default) then Cancel (outline), `flex gap-2`, left aligned.
- **Native `date` and `time` inputs stay native.** They are 32px today via `Input`; they need 44px and 16px text on a phone, or iOS zooms on focus.

## The overlap warning (spec §6.4) — the one thing on this page that must not be quiet

When the API answers 409, `BlockForm` shows the confirmed bookings the block would cover and asks. This is the page's only destructive-consequence moment, so it outranks everything around it:

- `role="alert"` container, `border-destructive`, plus a **tinted destructive surface** (`bg-destructive/5`) so it is not just an outlined box among outlined boxes. A `TriangleAlert` icon (`size-4`) sits with its heading line.
- The named bookings are a `ul` at `text-sm`, each line the client and the time. Keep every name: this list is the evidence, not decoration.
- Two buttons: "Block anyway" (**destructive, solid**) and Cancel (outline). The destructive one is the same solid red the client's cancel confirmation uses — irreversible actions look the same everywhere.
- The warning never replaces the form; it appears above the buttons with the typed values still on screen.

## States

loading (`role="status"`), load failed (destructive + Retry), idle, one form open (new or editing), saving, field-invalid, save failed, overlap-refused, action failed (the page-level `role="alert"` above the cards).

## Admin nav

This page is nav item **four** of five: calendar, bookings, catalogue, **availability**, settings. Icon `CalendarClock` (`size-4`, `aria-hidden`) — it is the hours-and-dates page, and it must not collide with the calendar's `CalendarDays`. Verify the five links still wrap acceptably at 375px (`pages/admin-shell.md`, "Below lg").

## Do not

- No tabs, accordion or drawer for the two sections: both lists stay visible and nothing here gets open/close state.
- No calendar-style grid preview of the week. It would be a second calendar, and Section 6 owns that.
- No new copy. Every string already exists under `admin:availability.*`.
