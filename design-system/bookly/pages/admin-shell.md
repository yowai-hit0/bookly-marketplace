# Admin Shell (layout route) — Page Design

> **Project:** Bookly · **Phase 3 section:** 5 (with admin login)
> **Route:** `/admin` layout route; wraps `calendar`, `catalogue`, `bookings`, `bookings/:id` through `<Outlet />`. `/admin` itself redirects to `calendar`.
> **File:** `frontend/src/admin/AdminLayout.tsx`
> **Added by the discovery rule:** it is a route in `routes.tsx` but was not on the Phase 2a page list. It is in the Phase 3 table (row 5, "Admin shell + login") but had no design file.
> **Revised at the user's request:** navigation is a **sidebar** (the shipped shell and the first version of this file used a top header bar).
> Generator template: UI UX Pro Max, 2026-09-19 ("Dashboard / Data View"). The 1200px width is wrong here; each admin page sets its own width.
> This file overrides `design-system/bookly/MASTER.md` for this page. Read MASTER's "Hand-review addendum" first.
> **Overridden 2026-09-26 by `design-system/bookly/admin-console.md` (admin console redesign), which wins where they conflict:** Sidebar is **260px** (was 240px); the active link is the violet `--sidebar-primary` fill (was `bg-primary/10 text-primary`); a **56px top bar** is added from `lg` (mark cell, breadcrumbs, theme toggle), with a slim breadcrumb row below `lg`. *Do not*'s "no breadcrumbs" is lifted for the breadcrumbs only (the brief's one new feature); a theme toggle is added. The skip link, the one reflowing `nav`, the link order, `aria-current`, `min-w-0`, per-page widths and the red ghost Sign out all hold. See `admin-console.md` §6.1-6.2.

## Structure

`AdminLayout.tsx` keeps one navigation element and lets it **reflow**: a sidebar from `lg` (1024px) up, a top bar below.

```
>= lg (sidebar)                      < lg (top bar)
+-----------+--------------------+   +-----------------------------+
| Bookly    |                    |   | Bookly           [Sign out] |
| Calendar  |  <Outlet />        |   | Calendar Bookings Catalogue |
| Bookings  |  (the page's own   |   +-----------------------------+
| Catalogue |   main, centred    |   |  <Outlet />                 |
|           |   in this column)  |   |                             |
| Sign out  |                    |   +-----------------------------+
+-----------+--------------------+
```

- **One `nav[aria-label]`, one DOM, responsive classes only.** No drawer, no off-canvas menu, no open/close state. A drawer needs state, a focus trap, Escape handling and scroll lock (a `Sheet` primitive this project does not have): that is logic, and this branch is visual-only.
- Wrapper `div.min-h-svh` becomes `lg:flex`. The nav container is `lg:sticky lg:top-0 lg:h-svh lg:w-60 lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:border-r`. The content wrapper around `<Outlet />` is `min-w-0 flex-1`; **`min-w-0` is required**, or the calendar and the bookings table push the flex row wider than the viewport.
- DOM order stays: wordmark -> links -> sign-out. In the sidebar, sign-out is pinned to the bottom (`lg:mt-auto`); in the top bar it sits at the right (`ml-auto`).
- Each child page still renders its **own** `main` with its **own** width: calendar `max-w-7xl`, bookings `max-w-6xl`, catalogue `max-w-5xl`, booking detail `max-w-3xl`. The shell must not impose a width on them; they centre inside the content column, not the viewport.
- The session guard (`Navigate` to `/admin/login`) and `signOut` are logic; do not touch.
- Landmarks: keep `nav` with its `aria-label`. The wrapper around it may be `aside`. Each page keeps its own `main`.

## Sidebar (`lg` and up)

- **Size and surface:** `w-60` (15rem = 240px), full viewport height, sticky, its own vertical scroll if the window is short. Surface `bg-sidebar` (= card white) with `border-r border-sidebar-border`, so it separates from the tinted page background. Uses the existing `--sidebar-*` tokens; values in MASTER section 4.
- **Top:** the wordmark (`common:appName`, heading font, semibold, `text-lg`), `px-4 py-4`. A small decorative icon before it (`CalendarCheck`, `aria-hidden`) is optional.
- **Links:** a vertical list, `gap-1`. Each `NavLink`: `flex items-center gap-3 rounded-lg px-3 py-2 text-sm`, a lucide icon (`size-4`, `aria-hidden`) **and** the existing label. Icon and text are always both present. Calendar `CalendarDays`, Bookings `ClipboardList`, Catalogue `Package`. Order is unchanged: calendar, bookings, catalogue. **Decided 2026-09-20:** the availability, working-hours, blocks and settings pages are built before this section (MASTER section 9, items 6-8), so the list grows to five or more; their icons and order are set in their own design files. Design the list for five from the start.
- **States:**
  - default: muted text (7.58:1 on white);
  - hover: `bg-sidebar-accent` (the `muted` surface);
  - **active** (`aria-current="page"`, set by `NavLink`): `bg-primary/10 text-primary font-medium`, icon in the same colour. `#047857` on its own 10% tint is 4.78:1, so it passes AA. The indicator is a **filled pill plus heavier weight**, so it is not colour alone.
  - keyboard focus: the ring (`focus-visible:ring-3 ring-ring/50`).
- **No left-edge stripe** for the active item: Impeccable's detector flags one-sided accent borders (`side-tab`). Do not use a solid green fill either: the active item would compete with the page's primary action (one primary CTA per screen).
- Bookings stays highlighted on `/admin/bookings/:id` (`NavLink` matches by prefix; leave `end` off).
- **Sign-out:** bottom of the sidebar, `border-t` above it, ghost button, full width, left-aligned, `LogOut` icon + `admin:nav.signOut`.  **Red since 2026-09-25 (user request):** `text-destructive`, hover `bg-destructive/10`. Still ghost weight, never a solid fill, which is reserved for confirming something irreversible.

## Below lg (top bar; verify at 375px)

Wordmark + three links + sign-out is too wide for one row today. Allow the nav to wrap or tighten gaps, keep each link a comfortable touch target (>= 44px tall), and at `< sm` hide the sign-out **text** visually (`sr-only sm:not-sr-only`) so only the icon remains; the accessible name stays.

The nav has three links because three admin pages exist. If Availability and Settings pages are added (MASTER section 9, decision 6) it becomes five links: recheck the wrap at 375px before adding them.

The same `nav`, horizontal: row 1 wordmark left and sign-out right, row 2 the links (`flex-wrap`, icon + label). Surface `bg-card`, `border-b`. Not sticky (static is the safe default: no focus-not-obscured risk over long forms and the calendar).

## Width budget

From `lg` the sidebar takes 240px, so the content column is the viewport minus 240px.

- **Calendar:** 784px wide at a 1024px viewport. `max-w-7xl` (1280px) only binds from a 1520px viewport. Verify the toolbar wrap and the week view at 1024px and 1280px.
- **Bookings table:** `min-w-[48rem]` plus the page's `px-4` needs 800px, so it stops scrolling sideways from a 1040px viewport. At 1024-1039px it scrolls by a few pixels, which is acceptable inside `overflow-x-auto`.
- Catalogue and booking detail have room to spare.

## Skip link (decided 2026-09-20)

A **skip-to-content link** is the first focusable element in the shell: visually hidden until focused (`sr-only focus:not-sr-only`), then shown as a button-styled pill at the top left, above the sidebar, with a visible focus ring. It targets the content wrapper around `<Outlet />` (give it an `id` and `tabIndex={-1}`). Its label is a **new `en.json` key**: the user allowed additive keys for this (MASTER section 9, item 10). Existing strings are not edited.

## Login

`/admin/login` is declared outside `AdminLayout`: **no sidebar there.** The shell only wraps pages that already require a session.

## Do not

- No drawer or off-canvas menu, no collapse / expand toggle, no icon-only rail: each needs state or a stored preference.
- Do not add shadcn's `sidebar` component (`npx shadcn add sidebar` brings new files, hooks and dependencies, outside the visual-only scope). Plain markup with the existing `--sidebar-*` tokens is enough.
- No breadcrumbs, user avatar, notification badge, search box, section headings or footer links: none exist, and most would need copy.
- No new copy except the skip-link key below.
