# Admin Bookings List — Page Design

> **Project:** Bookly · **Phase 3 section:** 7 (with booking detail)
> **Route:** `/admin/bookings` · **File:** `frontend/src/pages/admin/AdminBookings.tsx`
> Generator template: UI UX Pro Max, 2026-09-19 ("Dashboard / Data View", 1200px). Replaced by the shipped `max-w-6xl`.
> This is a **data-dense operate screen** (statuses, money due, refunds). Legibility beats decoration.
> This file overrides `design-system/bookly/MASTER.md` for this page. Read MASTER's "Hand-review addendum" first.
> **Overridden 2026-09-26 by `design-system/bookly/admin-console.md` (admin console redesign), which wins where they conflict:** Restyled per `admin-console.md` §6.5: the date and search filters join one bordered toolbar strip; the header row is mono uppercase with a count chip; rows lead with a filled status icon and two lines (the reference as an underlined mono link in the meta line); status badges are the console treatments (§5). The stage toggles stay, pressed = inverted neutral with a check. Table semantics, the URL filters, the order and Load more hold.

**Changed 2026-09-27 (admin console fixes, item 5, user decisions):** the list is paged by number with a total (`page` + `pageSize`; "Showing 21–40 of 132" and ‹ 1 2 … 7 ›) in a pager pinned to the bottom of the screen, always there, its arrows disabled on a single page, and in the URL beside the filters; a change of filter goes back to page 1. "Load more" and the cursor are gone. The ten stage chips became one multi-select dropdown ("Status: All" / "Status: N selected", checkboxes with the status glyphs) in the filter strip, with a ❔ beside it that opens the legend: every stage as its badge, what it means and what to do. The reference column is gone and the client column shows the name only; the whole row opens the booking through one real link stretched over it (named by the reference), with a hover and focus state and an arrow at its end. At 1280px every column, money included, fits with no sideways scroll; phones keep the stacked rows. Search by reference still works.

## Layout (keep the order)

`main`, `max-w-6xl`, `px-4 py-6`, `gap-4`. Order: `h1` (2xl) -> filter section -> failed alert -> loading / empty text -> table -> "Load more".

**Width budget (admin sidebar):** from `lg` the sidebar (`pages/admin-shell.md`) takes 240px. The table needs 800px (`min-w-[48rem]` plus the page's `px-4`), so it stops scrolling sideways from a 1040px viewport; at 1024-1039px it scrolls by a few pixels inside `overflow-x-auto`, which is acceptable.

### Filter section (`aria-label`)

- Row 1: **stage toggle buttons** (ten since 2026-09-25, one per display stage, MASTER section 7; the URL carries `?stage=`, and an older `?status=` link opens on the stages that status now spans), `flex-wrap`, `size="sm"`. Pressed = default (filled) variant, unpressed = outline. Pressed vs unpressed must differ by more than hue: fill vs outline is enough; a small check icon on pressed is a good extra. Do not shorten labels.
- Row 2: From date, To date (`w-44`), search (`w-64`) + outline "Apply", and a ghost "Clear" that appears only when a filter is active. Labels above inputs, `items-end` so buttons align with inputs.
- Filters live in the URL; the layout must not depend on any local-only state.

### Table

- Inside `overflow-x-auto`, `min-w-[48rem]`, `border-collapse`, `text-sm`. **Keep real table semantics** (caption, `th scope="col"`); on phones the table scrolls horizontally rather than turning into cards. Make the scroll obvious (edge fade or visible scrollbar).
- Header row: `border-b`, muted, medium weight. Body rows: `border-b`, `hover:bg-muted/50` (hover must be visible: see MASTER addendum D3 on `muted`), `align-top`, `py-2` to `py-3`.
- Columns: **When** (date, then time range muted, `whitespace-nowrap`), **Reference** (link, mono, medium, underline on hover and visible focus), **Client** (name, email muted; let long emails wrap), **Service** (name, package muted), **Status** (badge), **Money**.
- **Money column** (right-aligned, `tabular-nums`): grand total, then "still to pay" (muted, only if > 0), then "to refund" (destructive text, only if refund due). Both extra lines keep their words; colour is secondary. Destructive text must be >= 4.5:1 on the row background.
- **Status badge:** all seven currently render as the same `outline` badge. Use the shared treatments in MASTER "Booking status treatments". They must stay distinguishable in greyscale (fill / outline / dashed / dotted plus a different icon each).

### Load more

Outline button, `self-start`, `aria-busy` while loading.

## States

loading (first load), filtered-empty (muted sentence), load failed (destructive `role="alert"`), loading more, filters active (Clear visible).

## Do not

- No zebra striping that competes with row hover, no sticky columns, no bulk-select, sorting or export: none exist.
- No new copy; do not change the URL-filter behaviour.
