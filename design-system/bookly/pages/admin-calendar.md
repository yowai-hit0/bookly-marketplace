# Admin Calendar — Page Design

> **Project:** Bookly · **Phase 3 section:** 6
> **Route:** `/admin/calendar` (lazy-loaded: FullCalendar and Luxon are the heaviest code in the app, so add no new imports to this chunk)
> **Files:** `frontend/src/pages/admin/AdminCalendar.tsx` **and the FullCalendar block in `frontend/src/index.css` (lines 131-179)**. A pass that only scans `.tsx` files will miss the CSS, which is where most of this page's look lives. Section 6 needs an explicit, named CSS pass.
> Generator template: UI UX Pro Max, 2026-09-19 ("Dashboard / Data View", 1200px). Replaced.
> This file overrides `design-system/bookly/MASTER.md` for this page. Read MASTER's "Hand-review addendum" first.
> **Overridden 2026-09-26 by `design-system/bookly/admin-console.md` (admin console redesign), which wins where they conflict:** The FullCalendar chrome and events are restyled to the console (`admin-console.md` §6.9): square hairline cells, mono hour labels and date numbers, a violet today chip, square events on the raised surface with a **3px left edge in the status colour** (the brief asks for it; it is the one sanctioned side edge in admin, since the word and icon are still inside the event), a joined toolbar strip with a segmented view switch. The toolbar title is Geist, not the heading font. Status colours follow §5 there. The conflict outline, the block hatch, click-through and the TSX constants hold.

## Layout (keep)

`main`, `max-w-7xl`, `p-4`, `gap-4`. Order: title block (`h1` semibold + muted timezone note) -> loading `role="status"` -> failed `role="alert"` with outline `sm` retry -> the calendar.

**Corrected 2026-09-22, in Phase 4.** This line said `h1` **xl** and a `text-xs` note. Both were the generator's originals, not a deliberate choice, and the calendar was the last admin page still wearing them. It now titles at **`text-2xl`** with a **`text-sm`** note, like every other page inside the admin shell. This closes the title inconsistency recorded in `docs/redesign-pending.md` section 5. The FullCalendar toolbar's own `1.125rem` title is a separate thing and stays as section 6 set it.

Do not change the constants in the TSX: `TIME_GRID_HEIGHT` (760), `SCROLL_TIME` (08:00), `HEADER_TOOLBAR`, the view options. They are behaviour, not styling.

**Width budget (admin sidebar):** from `lg` the sidebar (`pages/admin-shell.md`) takes 240px, so the calendar column is the viewport minus 240px: 784px at a 1024px viewport. `max-w-7xl` (1280px) now only binds from a 1520px viewport. Verify the toolbar wrap and the week view at 1024px and 1280px.

## Calendar chrome (CSS, `.fc` block)

The `.fc` block already reads the app tokens (`--fc-border-color`, `--fc-neutral-bg-color: var(--muted)`, `--fc-today-bg-color: primary 6%`, active button = `--primary`), so a token change carries most of it. What still needs deliberate CSS:

- **Toolbar on small screens:** three button groups plus the title do not fit one row at 375px. Let `.fc-toolbar` wrap, put the title on its own line, keep buttons >= 36px tall.
- **Typography:** `font-size: 0.875rem` and the title's `1.125rem` are hard-coded and independent of the type scale. Set the title in the heading font. Keep the sizes unless the scale demands otherwise.
- **Neutral surfaces:** `--fc-neutral-bg-color` uses `muted`. If MASTER's `muted` is left at its generated value it is invisible against the page (see MASTER addendum, section 3 and D3).
- Focus ring on toolbar buttons already uses `--ring`; keep.

## Events: the functional visual cues (Section 6 milestone)

Event DOM: `EventContent` renders time (tabular), contact name (truncated), a **status chip** (`border border-current`, visible text, never colour alone) and, when a booking overlaps a block, a **conflict badge** (`bg-destructive text-white` + `TriangleAlert` icon). Week and day views add "service · package · reference" (bookings) or the block's private reason.

Event classes (set in `calendar-events.ts`, do not edit): `bookly-event`, `bookly-event--block`, `bookly-event--<status>` for the seven statuses, `bookly-event--conflict`.

**Verified problem to fix:** today every event uses FullCalendar's default fill and border, `--fc-event-bg-color: #3788d8` and `--fc-event-border-color: #3788d8` (checked in the installed package). Only `conflict` and `pending_payment` have any rule in `index.css`. Consequences:

1. **`pending_payment` dashed border is invisible.** A dashed border in the same colour as the fill cannot be seen. The cue only works if the fill differs from the border. Design pending events as **outlined**: light or card fill with a **dashed** border in the brand colour.
2. All other statuses look identical apart from their chip text. Give them the shared treatments in MASTER "Booking status treatments" (fill, border style and tone), so the calendar, the bookings list and the booking page agree.

Set `--fc-event-bg-color`, `--fc-event-border-color` and `--fc-event-text-color` from tokens in `.fc`, then override per `.bookly-event--<status>`. Text on any event fill must stay >= 4.5:1.

- **Conflict** (`.bookly-event--conflict`): 2px `--destructive` outline, `outline-offset: -2px`, visible at any event size. It must stay readable on top of each fill, and no status treatment may use a 2px destructive border of its own (or the cue is lost). Check conflict + `confirmed` and conflict + `pending_payment` explicitly.
- **Block** (`.bookly-event--block`): muted fill plus a diagonal hatch (repeating gradient), so "blocked" is a pattern, not only a colour.
- **Chip sizes:** the chip and conflict badge are `0.65rem` (about 10px). Raise to `0.75rem` where the event has room (week, day). Month cells stay dense but not below `0.7rem`.

## Click-through (decided 2026-09-20)

Booking events will open the booking (`/admin/bookings/:id`). The behaviour is built as feature work with the other admin pages (MASTER section 9, item 7); design for it now.

**Corrected 2026-09-21, at the Section 6 apply.** The feature work that shipped in `d02bd41` makes **blocks clickable too**: a block opens the availability page that edits it, so every event FullCalendar puts in the tab order leads somewhere (the user's decision, `docs/redesign-pending.md` section 1). The line below saying blocks are not clickable was written before that and is wrong; blocks take the same pointer cursor, hover and focus ring as bookings. Styling a working click target as inert would hide a real affordance.

- The whole event is one click target, with a pointer cursor and a hover state (a slightly darker fill; never a size or layout change).
- A visible keyboard focus ring (`--ring`, 3px, drawn inside the event box).
- The status chip and the conflict badge stay inside the click target and keep their text.
- ~~Block events are not clickable: default cursor, no hover state.~~ **Superseded** — see the correction above. Blocks are clickable and look it.
- In month view the events stay small; the hit area is the event box, as large as the row allows.

## Fit to the screen (2026-09-27)

**Changed 2026-09-27 (admin console fixes, item 4, user decision):** on a screen of at least 1280x720 the calendar page itself never scrolls. The page is exactly the height under the 56px top bar, with a tighter rhythm from `lg`, and FullCalendar fills what is left (`height="100%"`, `expandRows`). Month shows every week with no scrolling anywhere: the cells drop their minimum height, busy days fold into "+N more" (`dayMaxEvents`), and a month event is one line (status glyph, start, name; the status word and a conflict stay in its accessible name). Week and day scroll only inside FullCalendar's own time grid and still open at 08:00. Below 1280x720 nothing changed: month grows to its weeks and the page scrolls; the hourly grids keep their fixed 760px and scroll inside it. `TIME_GRID_HEIGHT` and `SCROLL_TIME` are unchanged; the fit mode is read live from a media query (`console/use-fits-screen.ts`).

## Block time (2026-09-27)

**Changed 2026-09-27 (admin console fixes, item 1, user decision):** "Block time" opens `BlockForm` in a dialog (`admin-console.md` §6.11); the button stays in the header while it is open.

## States

loading, load failed (alert + retry), month / week / day views, all-day blocks, overlapping events, empty range.

## Do not

- No custom event popovers, drag-and-drop styling, resource views or extra plugins: none exist and each adds weight to the lazy chunk.
- No new copy.
