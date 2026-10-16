# Prompt: admin console redesign (developer-console look, light + dark)

You are working in the Bookly repo (React 19 + Vite + React Router 7 + Tailwind v4 + shadcn/Radix frontend in
`frontend/`, Express backend in `backend/`). Redesign the **admin side only** (`/admin/*`, including
`/admin/login` and `/admin/reset-password`) so it has the look and feel of a developer-hosting console: the
two reference screenshots in `docs/prompts/admin-console/` (`reference-dark.png`, `reference-light.png`). Open
both with the Read tool before doing anything else, and have every subagent open them too.

**The user's own style guide is the source of truth for tokens and sizes:** the design canvas
<https://claude.ai/artifact/QVwFvLqQwHAmLHnUUhRua2> ("Bookly Admin Style Guide"). Read it with the Artifact tool
(`action: "read"`, then `paths: ["project/Main.dc.html", "project/Sample.dc.html", "project/Prompt.dc.html"]`) and
pass its URL to every subagent. It has three boards:
- **`Main.dc.html`, the style guide:** colors for both themes, type scale, buttons, badges, inputs, sidebar, metadata
  tile, banner, table row, spacing and shape. Match these values exactly.
- **`Sample.dc.html`, a sample Bookings screen (dark):** the target composition. Its nav items (Services,
  Customers, Payments, Activity, Reports), its workspace switcher, help button and avatar are **illustrative
  only**. Bookly keeps its real five links, and §1.4 below decides which controls exist.
- **`Prompt.dc.html`, the draft v1 prompt:** superseded by this file. Where they conflict (⌘K palette,
  collapsible sidebar, drawer, dashboard/customers/payments screens, toasts, live log tailing, dismissible promo
  cards), **this file wins**. Its visual specifics still apply.

The screenshots show a third-party product's dashboard. Copy its **visual language** (structure, density,
borders, type, color logic). Do **not** copy its logo, product name, copy or promotional content. Everything shown
is still Bookly's own content and strings.

Work on a new branch `redesign/admin-console` off `main`. Commit as described under "Commits". Do not push or merge
without asking. Where this prompt leaves a decision open, or the code contradicts it, **stop and ask the user**; do
not guess.

---

## 1. Decisions already made by the user (do not re-litigate)

1. **Theme:** ship **both light and dark**. Default follows the OS (`prefers-color-scheme`, updated live). A
   three-way toggle (**System / Light / Dark**) overrides it, remembered per device in `localStorage`.
2. **Accent:** adopt **violet** as the admin accent (active nav, links, selected state, brand badge, info
   banners, focus ring). Green is kept only for success and status meaning. The client side keeps its current
   look; admin and client are allowed to look like different products.
3. **Type:** a neutral grotesk plus a mono, admin only: **Geist** for UI text and **Geist Mono** for uppercase
   eyebrow labels, table headers, booking references, times, durations, prices and IDs, as in the style guide
   canvas. Use the self-hosted Fontsource packages (`@fontsource-variable/geist`,
   `@fontsource-variable/geist-mono`), never a Google Fonts link. If those packages are unavailable, fall back to
   Inter + JetBrains Mono and tell the user. Client pages keep Poppins / Open Sans and must not change.
4. **New features:** only **one**, a **breadcrumb top bar**. Explicitly **out of scope**: ⌘K search or a command
   palette, a collapsible sidebar, copy-to-clipboard buttons, a workspace switcher, a "+ New" menu, avatars, help
   buttons and upgrade prompts. **Do not add inert look-alike controls** (a search box that does nothing, for
   example). If the reference has a control Bookly has no function for, leave it out.

## 2. Ground rules (read first)

- **Read before writing:** `PRODUCT.md`, `DESIGN.md`, `design-system/bookly/MASTER.md` (its hand-review
  addendum), every `design-system/bookly/pages/admin-*.md` plus `availability.md` and `settings.md`, and
  `docs/redisign.md` (the earlier redesign's process and guardrails). This redesign **overrides** those admin page
  files wherever they conflict. Record each override in the file with today's date, the way earlier decisions
  there are recorded.
- **Client pages must not change at all.** Every public route in `frontend/src/routes.tsx` must render
  pixel-identical before and after. Take baseline screenshots of every client route at 375px and 1280px **before
  the first code change**, and compare at the end (see §8).
- **Theme token quirk (important):** commit `dc69157` ("make dark mode default") swapped selectors in
  `frontend/src/index.css`. The Bookly light "sky" palette now sits under `.dark`, which nothing applies, and
  `:root` holds shadcn's stock neutral dark palette. So Tailwind's `dark:` variant (`@custom-variant dark
  (&:is(.dark *))`) does **not** mean "dark theme" in this codebase. **Do not fix or rename those client
  selectors**, because that would change the client site. **Do not use `dark:` utilities for admin theming.** Use
  the scoped admin tokens described in §4.
- **i18n:** `frontend/src/i18n/locales/en.json` takes **additive new keys only**, for example the theme toggle
  labels and the breadcrumb `aria-label`. **Never edit an existing string.** Reuse existing strings where one fits:
  `admin:nav.*` already has Calendar, Bookings, Catalogue, Availability, Settings, Sign out, and Admin.
- **Protected files.** These must be absent from every diff:
  - `frontend/src/catalogue/{api,bookings,availability,payments}.ts` (+ `.test.ts`)
  - `frontend/src/admin/{api,session,catalogue,calendar-dates,calendar-events}.ts` (+ `.test.ts`)
  - `frontend/components.json`, `frontend/vite.config.ts`
  - all of `backend/`
- **Allowed to change:** `frontend/src/index.css`, `frontend/src/components/ui/*` (only under the rule below),
  `frontend/src/pages/admin/*`, `frontend/src/admin/AdminLayout.tsx`, new files under `frontend/src/admin/`
  (theme and breadcrumb code), `en.json` (additive only), `design-system/`, `DESIGN.md`, and
  `frontend/package.json` + `package-lock.json`, but **only** to add the two font packages, in their own commit.
- **Shared UI components** (`components/ui/*`) are also used by client pages. Their **default rendering must not
  change**. Restyle admin through the scoped tokens first. Where tokens are not enough, add an opt-in variant (for
  example a `size="console"` or a `variant="console"` prop via `cva`) that only admin files use.
- **Behavior is preserved.** Every existing flow keeps working: filters, search, booking actions, forms,
  validation, calendar clicks, "Block time", the overlap warning, sign out, the session guard, and the skip link.
  Keep the DOM order and accessible names that tests rely on (the nav `aria-label="Admin"` and its link order;
  `aria-current="page"` on the active link; one `h1` per page; the skip link first in tab order, targeting
  `#admin-content`; the Sign out button). A unit test that asserts a **styling class** (for example
  `AdminLayout.test.tsx` checking `font-medium` or `text-destructive`) may be updated to the new styling **only
  if** the behavior it guards is still asserted. List every test you change, and why, in your final report.
- **Accessibility floor:** WCAG AA contrast (4.5:1 text, 3:1 UI boundaries and focus rings) in **both** themes;
  visible focus on every interactive element; touch targets ≥ 44px below `lg` (the shell already uses
  `min-h-11`); `prefers-reduced-motion` respected; no horizontal page scroll at 375px.

## 3. Design analysis of the references (the target)

### 3.1 Overall character
A dense, calm developer console. It is built from **flat planes and 1px hairlines, not cards and shadows**.
Full-bleed border lines split the screen into a grid of cells: the top bar is a row of bordered cells, the sidebar
is a bordered column, and the content has full-width divider bands. Corners are **square or nearly square**. Color
is almost entirely neutral; **one saturated violet** does all the accenting, and green appears only as "success /
live". Uppercase **monospace micro-labels** give it the "engineering tool" voice. No gradients, no shadows, no
illustrations (the only decorative element, a promo card, is to be omitted).

### 3.2 Color (from the style guide canvas; convert to oklch like the rest of `index.css`, verify AA)

Dark is the look the canvas designs first. Light must be equally finished.

| Role | Dark | Light |
|---|---|---|
| Canvas (page / shell background) | `#0A0A0B` | `#FFFFFF` |
| Sidebar background | same as canvas (separated by a border) | `#FAFAFA` |
| Surface (row hover, raised panels) | `#131315` | `#FAFAFA` (derive; not in the canvas) |
| Icon tile / chip / neutral badge | `#27272A` | `#F4F4F5` |
| Hairline border (dividers, cells) | `#27272A` | `#E4E4E7` |
| Strong border (inputs, secondary buttons) | `#3F3F46` | `#D4D4D8` (derive; not in the canvas) |
| Text | `#F4F4F5` | `#18181B` |
| Muted text (meta, labels, "MONITOR") | `#A1A1AA` | `#71717A` (check 4.5:1 on `#FAFAFA`; darken if it fails) |
| Accent text / links | `#B9A2FF` (hover `#D4C6FF`) | `#7C3AED` (hover `#5B21B6`) |
| Accent fill (active nav, info banner) | `#3A1784` bg, `#D4C6FF` text in nav, `#F4F4F5` text in banner | accent soft `#F1ECFE` bg, `#7C3AED` text in nav, `#18181B` text in banner |
| Strong accent (the one "headline" badge) | `#5B21B6` bg, white text | `#7C3AED` bg, white text |
| Success ("Live", confirmed, completed) | `#4ADE80` on `#0F2E1C` | `#16A34A` on `#EAF8EF` |
| Warning / danger | amber and red pairs in the same fill-plus-text style (derive both themes) | same |
| Primary button | **inverted neutral**: `#FAFAFA` bg, `#0A0A0B` text | `#18181B` bg, white text |
| Destructive button | red text on a faint red tint, as today | same |

The accent is used **sparingly**: links, the active nav item, info banners, and at most one headline badge.
Status color never carries meaning alone; always pair it with an icon or a word.

The **primary action button is inverted neutral**, not violet ("Manual Deploy" in the reference). Violet marks
*where you are* and *what is linked*, not *the main action*. This matters for the shadcn tokens: today
`--primary` drives both buttons and the active nav (`bg-primary/10 text-primary`). Inside the admin scope, set
`--primary` to the inverted neutral and add dedicated tokens (for example `--console-accent`,
`--console-accent-foreground`, `--console-accent-tint`, `--console-link`, `--console-success`,
`--console-success-tint`, `--console-info`) for violet and status. Audit every `primary` usage under
`src/pages/admin/` and in the shared components they use, so nothing turns into white-on-white.

### 3.3 Typography (the canvas's scale)
- **Page title (`h1`):** Geist 30px / 600 / `-0.02em`.
- **Section heading (`h2`):** Geist 20px / 500.
- **Nav items, row titles, body:** Geist 16px / 400.
- **Secondary metadata:** Geist 14px, muted color ("bk_8f2a91c · Booked 6h ago").
- **Uppercase labels:** Geist Mono 12px / 500, uppercase, `letter-spacing: 0.1em`, muted color. Used for the page
  eyebrow (preceded by a 16px outline icon, for example "BOOKING" above a booking reference), table headers,
  metadata-tile labels ("STATUS", "DURATION"), and sidebar group labels. A count chip can sit next to a table
  label ("BOOKING `24`"): mono 12px on the chip color, square.
- **Data values:** Geist Mono 15px: booking references, durations, amounts, times. Tabular numbers
  (`font-variant-numeric: tabular-nums`).
- **Log / history lines,** if a page already lists timestamped events: Geist Mono 13px.
- **Links:** accent color with no underline, **except** IDs/references and links inside banners, which are
  underlined.
- Headings in admin use Geist, not Poppins. The global `h1, h2, h3 { font-heading }` rule must be overridden
  inside the admin scope only.

### 3.4 Shape, borders, spacing, elevation (the canvas's numbers)
- **4px base grid:** 4, 8, 12, 16, 24, 32, 48, 64. Sections are 48–64px apart; tiles and panels are padded 24–28px.
- Radius: **0–2px** for buttons, inputs, badges, banners, panels and tiles. Set `--radius` to `0.125rem` inside
  the admin scope, so shadcn's derived radii all shrink with it. Only avatars and status icons are round.
  **No pill shapes.**
- Borders: 1px everywhere, hairline color for structure, strong border for inputs and secondary buttons. Regions
  are divided by borders, **never by shadows or background blocks**.
- **No shadows and no gradients** anywhere in admin (popovers get a border; at most a very subtle shadow in light
  mode only).
- **Shell:** top bar 56px; sidebar 260px; content gutter 48px on desktop and 16px on mobile. Content max width is
  about 900–1100px for detail and form pages, and tables and the calendar may run wider (each page keeps setting
  its own width, per `admin-shell.md`).
- **Controls:** buttons and inputs 40px tall on desktop (44px below `lg`); the search field 48px; nav items 44px;
  table rows about 64–72px with two lines.

### 3.5 Iconography
Outline icons only, via the existing `lucide-react`: **1.5px stroke** (set it once for `svg.lucide` inside the
admin scope), square line caps, 16px in breadcrumbs, meta rows and buttons, 18px in nav, and 20px in metadata
tiles. **Every breadcrumb level, nav item and metadata tile has an icon.** Icons inherit the text color; only
status icons use color. No emoji. Status icons (restyle `components/ui/status-icon.tsx` / `status-badge.tsx`,
keeping their status mapping):
- **filled check circle** = current / live (confirmed upcoming, paid)
- **outlined check circle** = earlier success (completed)
- **clock** = pending (pending payment, needs review)
- **cross circle** = failed / cancelled / expired / no-show (red for cancelled, muted for expired)

The exact mapping to Bookly's statuses and booking stages (in progress, needs review, completed, closed, and the
existing legend) is recorded in the spec; each status keeps its word label next to the icon.

### 3.6 Motion and interaction
Minimal and fast: 100–150ms color and background transitions only, with no lift, scale or slide. Hover states:
nav items and table rows get the raised-surface background; links underline; outline buttons get a slightly
lighter or darker surface. Focus: a 2px violet ring with an offset, clearly visible in both themes. Wherever a
relative time is already shown, the absolute time goes in a `title` (dotted underline, like "6h ago" in the
reference).

## 4. Theme mechanics (the one piece of new logic besides breadcrumbs)

- **Scope the tokens to the document root, not a wrapper div.** Radix popovers portal into `document.body`, so a
  wrapper-scoped variable would not reach them. While any admin route is mounted (the layout, login and reset
  password), set `document.documentElement.dataset.adminTheme = 'light' | 'dark'` (the resolved value), and
  remove it on unmount so client pages are untouched. Define the admin tokens under
  `:root[data-admin-theme="light"]` and `:root[data-admin-theme="dark"]` in `index.css`. These override the
  shadcn semantic variables (`--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--muted`,
  `--muted-foreground`, `--border`, `--input`, `--ring`, `--radius`, `--sidebar-*`, and so on) plus the new
  `--console-*` tokens, the font families, and `color-scheme` (so scrollbars and native controls match).
- Put the logic in a small module under `frontend/src/admin/` (for example `theme.ts` with a hook). Preference
  values: `system | light | dark`, stored under a namespaced key (for example `bookly.admin.theme`). **Wrap every
  `localStorage` read and write in `try/catch`**, falling back to `system`. When the preference is `system`,
  listen to `matchMedia('(prefers-color-scheme: dark)')` and update live. Resolve synchronously on first render,
  so there is no flash of the wrong theme.
- **Toggle UI:** a compact three-segment control (monitor / sun / moon icons, each with an accessible name from
  new `en.json` keys, forming a radio group or a toggle group with the selected state announced). Place it in the
  top bar's right-hand cell on desktop, and keep it reachable on mobile.
- Write unit tests for the theme module: default follows the OS, the stored preference wins, `localStorage`
  throwing does not crash, the attribute is removed on unmount, and a live OS change updates `system`.
- The FullCalendar theme in `index.css` already reads app tokens. Verify it in both themes and retune its rules to
  the console look (square cells, hairlines, mono time labels, square event chips with a status-colored left
  border).

## 5. Component and layout spec, mapped to Bookly

### 5.1 Shell (`frontend/src/admin/AdminLayout.tsx`)
Keep the existing contract from `admin-shell.md`: one `nav[aria-label="Admin"]` that reflows (a sidebar from
`lg`, a top bar below it); no drawer and no open/close state; the skip link first; `#admin-content` as the
focusable content wrapper; `min-w-0` on the content column; each page keeps its own `main` and width.

**Desktop (≥ lg):**
```
+--------+-----------------------------------------------------+--------------+
| [mark] | Admin  ›  [icon] Bookings  ›  BK-7F3Q                | [◐ ☀ ☾]      |  top bar, ~56px, bordered cells
+--------+--+--------------------------------------------------+--------------+
| Bookly    |                                                                  |
|           |   (page content: eyebrow, h1, badges, meta row, actions)        |
| ▣ Calendar|                                                                  |
| ▣ Bookings|   ─────────────── full-bleed divider band ───────────────        |
| ▣ Catalog |                                                                  |
| ▣ Availab.|                                                                  |
| ▣ Settings|                                                                  |
|           |                                                                  |
| ⎋ Sign out|                                                                  |
+-----------+------------------------------------------------------------------+
```
- **Top bar:** full width, a bottom hairline, and a row of cells separated by vertical hairlines (the reference
  puts logo | workspace | breadcrumbs | search | new | upgrade | help | avatar in cells). Bookly has three:
  **mark cell** (a square cell with a simple Bookly mark or monogram; no third-party logo), **breadcrumb cell**
  (flex-1), and **theme toggle cell**. Nothing else.
- **Sidebar:** 260px wide, a right hairline, sticky and full height, as in `Sample.dc.html`. At the top, the
  wordmark "Bookly" at 20px / 500 with its icon (keep it a `span`, which a test asserts). The five nav links follow
  in their current order: 44px tall, 16px text, 18px icon, square corners, full row width. **Active link:** the
  accent fill (dark `#3A1784` bg with `#D4C6FF` text; light `#F1ECFE` bg with `#7C3AED` text). Inactive: text
  color, surface background on hover. A mono group label ("MONITOR" style) is optional and must not reorder the
  links. **Sign out** is pinned to the bottom above a
  hairline, in the same position as "Collapse" in the reference, keeping its red text and red hover tint (ghost
  weight, not a solid fill). No promo card.
- **Below lg:** the existing reflow (wordmark + sign out on row one, links wrapping on row two). Add the
  breadcrumb as a slim row under it, showing only the last two segments, truncated with an ellipsis. The theme
  toggle must stay reachable (it can sit beside sign out).

### 5.2 Breadcrumbs (the new feature)
- Semantics: `nav aria-label="Breadcrumb"` (new `en.json` key) containing an `ol`. Separators are `aria-hidden`
  chevrons. The last item is plain text with `aria-current="page"`, and earlier items are links.
- Segments: **Admin** (reuse `admin:nav.label`) → the section, with its nav icon and the existing `admin:nav.*`
  label → for `/admin/bookings/:id`, the **booking reference** in mono.
- The reference is only known once `AdminBookingDetail` has loaded the booking. Provide a tiny context (or router
  outlet context) from the layout that the detail page calls to set its current crumb. While loading, show a
  neutral skeleton segment. On error, drop the segment. Do not add a second fetch.
- Derive the section from the route (a small map from path to nav item). Add a unit test covering each route's
  crumbs, including the detail page's reference.

### 5.3 Page header pattern (every admin page)
- **Eyebrow row:** a 16px icon plus a mono uppercase label (new `en.json` keys only if no existing string fits;
  otherwise reuse the nav label).
- **`h1`:** the page or entity name (for booking detail, the reference in mono, which it already is).
- **Inline badges** after the `h1`: rectangles (no pill radius), 14px / 500 text, 5px × 10px padding. For
  example: status (success pair plus icon), service type (neutral chip color), and payment state. The
  strong-accent badge is reserved for at most one "headline" badge per page.
- **Meta row:** icon + text pairs in secondary color, separated by generous gaps (client name, phone, email, date
  and time in mono, package), wrapping on mobile.
- **Actions:** right-aligned on desktop and stacked full-width on mobile. The **main action is the inverted
  neutral solid button**; secondary actions are outline buttons (with a chevron if they open a menu or popover).
  Destructive actions keep their red treatment.
- Below the header, an optional **full-bleed status band** (a hairline above and below, raised-surface or page
  bg) like the reference's "✓ Live · 0f95ea2 · 20.5s" strip. It suits booking detail: status badge, reference
  chip, date and duration in mono.

### 5.4 Callouts / banners (`components/ui/callout.tsx`)
Full content width, square, with no border in dark (solid tint) and a tint in light. A leading 18px info icon,
the message, and an optional trailing underlined link on the right. Variants: info (violet), success (green),
warning (amber), destructive (red). Use it for the notices that already exist (the overlap warning, payment
notices, and so on). Do not invent new notices.

### 5.5 Tables and lists (bookings list; catalogue lists where tabular)
- **Header row:** mono uppercase 12px labels, an optional count chip, a hairline below. No background fill.
- **Rows:** a hairline divider between rows (no zebra), with the whole row as a hover target (raised surface).
  First column: a filled status icon, then two lines: a primary line (client name or title, 15–16px) and a meta
  line (the **reference as an underlined mono link**, a `·` separator, and the date). Other columns: secondary
  text, with mono for times and money. Match the table in `Sample.dc.html` (column header row, count chip, row
  anatomy).
- The canvas shows a quiet action appearing on the right of a hovered row (Refund / Cancel). Add one **only** if
  that action already exists on the list page today; do not move detail-page actions onto the list. Any such
  action must also be reachable by keyboard, not only on hover.
- Keep the existing row click/link behavior and keyboard access exactly as it is.
- **Toolbar above the table:** filters and search joined into **one bordered strip** of cells (like the
  reference's "All logs ▾ | Search logs | date range | ⤢ | ⋯" bar): a select cell, a flex-1 search cell with a
  leading magnifier, then other filters. These are the existing filters restyled, not new ones.
- On mobile the table becomes stacked rows (it may already do this; keep the current approach and restyle it).

### 5.6 Stat grid (booking detail, settings summaries)
A two-column grid (one column on mobile) of items, each a **64px square icon tile** (48px on mobile; chip
color, 20px outline icon, tinted by state for status tiles), then a mono uppercase label above the value (mono
15px for data, Geist 16px for words), as in the canvas's metadata tile, for example STATUS "Confirmed", WHEN
"Sat 12 Oct · 14:00" (mono), DURATION "2h", PACKAGE, BOOKING FEE "RWF 40,000" (mono), SESSION FEE. Use only data
the page already has.

### 5.7 Forms (`AdminField`, `EntityForm`, `BlockForm`, `WorkingHoursForm`, settings, login)
Label above the field in 14px Geist medium (a mono uppercase label only for group headings). Inputs are square,
with a 1px strong border, no fill, 40px height (44px below `lg`), an accent focus ring, and a leading icon only where
the reference would have one (search). Help and error text is 13px, errors in red with an icon. Sections are
separated by full-bleed hairlines rather than cards.

### 5.8 Login and reset password
A centered narrow panel (about 400px) on the page background, bordered, square: the Bookly mark, a mono eyebrow
("ADMIN"), the `h1`, and the fields. The primary button is inverted neutral and full width. These pages apply the
theme (stored or system preference) but do not need the toggle.

### 5.9 Calendar
Square day and time cells, hairline grid, mono hour labels and date numbers, today marked with a violet date
number or chip. Events are square chips on a raised surface with a 3px left border in the booking's status color,
title in 13px Geist, time in mono. The toolbar (prev/next/today, view switch) becomes a joined bordered strip, with
the view switch as a segmented control whose active segment is filled.

## 6. Agent / subagent orchestration

You are the **lead**. You own everything shared; subagents own single pages. Subagents never run git commands,
and never edit files outside the list they are given; you review and commit.

**Phase 0: baseline (lead).** Read the files listed in §2. Run the app (`npm run dev` in `frontend/`) and take
baseline screenshots of **every client route** at 375px and 1280px, plus every admin route at the same widths,
saved to the scratchpad. Note: on a tall page, a Playwright `fullPage` screenshot switches touch emulation off, so
measure touch-target sizes **before** taking full-page shots.

**Phase 1: spec (lead, docs only).** Write `design-system/bookly/admin-console.md`: the token table for both
themes (final oklch values with measured contrast ratios), the type scale, the component specs from §5, and the
override notes for each `admin-*.md`. Update those page files with dated overrides. Commit it (`design:`).

**Phase 2: foundation (lead, serial).**
1. `deps:` add `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`. Import them in `index.css`
   (font files download only when a rule uses them, so client pages are not affected).
2. Theme module + tests (§4), the scoped token blocks in `index.css`, and admin-scope base rules (fonts, heading
   font override, lucide stroke width, focus ring).
3. The shell: top bar, breadcrumbs + tests, sidebar, and mobile reflow (§5.1–5.2).
4. The shared admin building blocks: opt-in console variants in `components/ui/*` (button, badge, input, callout,
   tabs, status badge/icon, card→panel), plus small admin-only compositions if useful (for example
   `frontend/src/pages/admin/console/PageHeader.tsx`, `StatGrid.tsx`, `DataTable` styles, `Toolbar.tsx`). Also
   the shared form files `AdminField.tsx`, `EntityForm.tsx`, `BlockForm.tsx`, `WorkingHoursForm.tsx`.
5. **Checkpoint: stop and show the user** screenshots of the shell + one page (bookings) in both themes at 1280px
   and 375px, side by side with `Sample.dc.html`. Continue only after they approve.

**Phase 3: pages (parallel subagents).** Spawn one `general-purpose` subagent per group, in the background, all
at once. Give each: this prompt's path, the two reference images, the style guide canvas URL (with the read
instructions from the top of this prompt), `design-system/bookly/admin-console.md`, the
list of shared building blocks it must use (not fork), and **its exclusive file list**:
- A: `AdminCalendar.tsx` (+ test) and the FullCalendar block in `index.css`, and **only that block**
- B: `AdminBookings.tsx` (+ test)
- C: `AdminBookingDetail.tsx` (+ test), including calling the breadcrumb context
- D: `AdminCatalogue.tsx` (+ test)
- E: `AdminAvailability.tsx`, `AdminSettings.tsx` (+ tests)
- F: `AdminLogin.tsx`, `AdminResetPassword.tsx` (+ tests)

Each subagent must: preserve behavior and accessible names; run `npm run typecheck`, `npm run lint`, and
`npx vitest run <its test files>` from `frontend/`; take 375px and 1280px screenshots of its pages in both themes;
and return a short report: files changed, tests changed and why, any shared-component change it **needed but did
not make** (you make those), and open questions. If a subagent needs a shared change, it reports it rather than
making it.

**Phase 4: review and polish (lead).** Apply the requested shared changes. Then spawn a fresh reviewer subagent
(`impeccable-finish-reviewer` if available, otherwise `general-purpose`) with the references, the style guide
canvas, the spec, and
screenshots of every admin route in both themes, asking for an ordered list of material deviations (consistency
of radius, borders, type, accent use, spacing, contrast). Fix them. Optionally run the `impeccable` skill's polish
or audit pass over the admin pages. Finally, have `impeccable-documenter` (or you) add an "Admin console" section
to `DESIGN.md` derived from what shipped.

## 7. Commits

One concern per commit, prefixed like the repo's history: `design:` (spec docs), `deps:` (fonts), `feat(admin):`
(theme module, breadcrumbs), `style(admin):` (shell, shared variants, then one commit per page group). Read the
full `git diff` before staging, stage explicit paths, and never `git add -A`. End each commit message with the
attribution line given in your system instructions.

## 8. Verification (all must pass before you report done)

- From `frontend/`: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`.
- `git diff main --stat`: no protected file appears; nothing outside the allowed list from §2.
- **Client identity:** re-screenshot every client route at 375px and 1280px and compare against the Phase 0
  baseline. They must be pixel-identical (a byte or pixel diff, not an eyeball check). Any difference is a bug.
- **Admin:** every admin route at 375px and 1280px in **light and dark**. Check that there is no horizontal
  scroll, that touch targets are ≥ 44px below `lg`, and that focus is visible when tabbing through each page.
  Contrast ratios for text, links, badges, the active nav and the focus ring are recorded in the spec.
- Theme: system default, override persisting across reload, live OS switch, `localStorage` blocked (for example
  a private window) still rendering, and visiting a client page after admin shows no admin tokens (the attribute
  is removed).
- Final report to the user: what changed per page, every test changed and why, screenshots (both themes, both
  widths), and anything deferred or uncertain.
