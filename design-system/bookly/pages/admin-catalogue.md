# Admin Catalogue — Page Design

> **Project:** Bookly · **Phase 3 section:** 8
> **Route:** `/admin/catalogue` · **Files:** `frontend/src/pages/admin/AdminCatalogue.tsx` and `EntityForm.tsx` (the one form behind every editor)
> Generator template: UI UX Pro Max, 2026-09-19 ("Dashboard / Data View", 1200px). Replaced by the shipped `max-w-5xl`.
> This file overrides `design-system/bookly/MASTER.md` for this page. Read MASTER's "Hand-review addendum" first.
> **Overridden 2026-09-26 by `design-system/bookly/admin-console.md` (admin console redesign), which wins where they conflict:** Restyled per `admin-console.md`: service cards become flat bordered panels (no `shadow-sm`, 2px radius); `EntityForm` is a raised-surface sub-panel with a hairline (§6.7); active/inactive badges become the console success and chip badges. Order, row actions and `window.confirm` hold.

## Layout (keep the order)

`main`, `max-w-5xl`, `p-4`, `gap-4`.

1. **Header row:** `h1` + intro on the left; "Add service" (default) on the right, hidden while the new-service form is open. Wraps on narrow screens.

   **Corrected 2026-09-22, at the Section 8 apply.** This line said `h1` **xl** and a `text-xs` intro. Both were the generator's originals and neither was ever a deliberate hierarchy choice. Availability, Settings, Bookings and Booking detail all title at **`text-2xl`** with a **`text-sm`** intro, and `text-xs` is too small for a sentence someone actually reads. The catalogue now matches them. `pages/admin-calendar.md` line 11 still carries the same stale pair; that one belongs to Section 6's file and is closed in Phase 4.
2. Action error (`role="alert"`, destructive), then the **new-service `EntityForm`** when open.
3. Loading / load failed (alert + outline retry) / empty.
4. **One `Card` per service**, then a final card for **shared add-ons** (hint text + the add-on section).

### Service card

- `CardHeader`: either the edit `EntityForm`, or a title row: `h2` (heading font; name + status badge), subtitle muted (`/slug · fee default or override · order`), and row actions on the right (wrap below the title on narrow screens).
- `CardContent`: a **Packages** section (`h3` sm semibold, list, "Add package") and an **Add-ons** section (same shape).
- List rows (`li`, `border-b`, last row none): name (medium) + status badge + muted meta line (`price · N photos · duration · order`), actions on the right. A duration warning sits under its row (destructive, `role="alert"`).

### Row actions: Edit, Activate/Deactivate, Delete

Three buttons on every row is visual noise. Keep all three reachable and labelled (each has an `aria-label` naming the item), but make them quiet: Edit and Activate/Deactivate outline or ghost `sm`; **Delete** the tinted destructive variant. Delete uses `window.confirm` (native); leave that.

### Status badge

Active = default (filled, primary tint) and inactive = outline. With the recommended `--primary` this reads as "live" vs "off". Words always shown.

## `EntityForm` (inline editor)

- Today: `rounded-md border p-3`, i.e. a second border and a smaller radius inside cards that use `rounded-xl`. Make it a **filled sub-surface** (`muted` or `muted/40`, `rounded-lg`, no extra border) so nested forms do not look like nested cards, and the radii agree with the rest of the app.
- Fields: `grid sm:grid-cols-2 gap-3`; the textarea and the checkbox span both columns. Label above, `Input` (16px mobile text, 44px touch height), hint under the field (`text-xs` -> `text-sm`), error under it (destructive, linked by `aria-describedby`). **The error moves to `text-sm` with the hint** (applied 2026-09-22): they stack under one field in the same role, and leaving the error a size smaller than the hint above it would be an inconsistency invented at the apply.
- Form-level failure: destructive `role="alert"`. Footer: submit (default; it uses `disabled` while saving) + "Cancel" (ghost).
- Only one form is open at a time; opening another replaces it in place. Keep it findable: same position in the card, no layout jump to unrelated sections.

## Tabs and Badge

`tabs.tsx` has **no consumers** anywhere in the app (verified by search), so there is nothing to design or check for Tabs. Badge is used only here and in the bookings pages.

## States

loading, failed, empty, service with no packages, package with a duration warning, action error (`inUse` / `actionFailed`), form open (new / edit), form invalid, form failed, slug taken, saving.

## Do not

- No drag-to-reorder (ordering is the display-order field), no bulk actions, no new copy.
- **Changed 2026-09-27 (admin console fixes, item 1, user decision):** the editor **is** a modal now (`admin-console.md` §6.11): new and edit service, package and add-on each open `EntityForm` in a dialog from their button. "Add service" stays visible while its dialog is open, so focus can return to it.
