# Admin Console — Design Spec

> **Project:** Bookly · **Scope:** every `/admin/*` route, including `/admin/login` and `/admin/reset-password`. Client pages are out of scope and must not change by a single pixel.
> **Written:** 2026-09-26, from `docs/prompts/admin-console-redesign.md` (the brief), the reference screenshots in `docs/prompts/admin-console/`, and the user's style guide canvas <https://claude.ai/artifact/QVwFvLqQwHAmLHnUUhRua2> (boards `Main.dc.html`, `Sample.dc.html`; `Prompt.dc.html` is superseded by the brief).
> **Precedence:** this file overrides `MASTER.md` and every `pages/admin-*.md`, `pages/availability.md` and `pages/settings.md` wherever they conflict. Each of those files carries a dated note pointing here. Where this file is silent, the page file still holds (layout order, states, behaviour, "Do not" lists).

## 0. Decisions

From the brief (§1, not re-opened):

1. **Both themes.** Light and dark; the default follows `prefers-color-scheme` live; a System / Light / Dark toggle overrides it per device (`localStorage`).
2. **Violet accent** for where you are and what is linked (active nav, links, selected state, info banners, focus ring, one headline badge). Green only for success and status. The primary action is **inverted neutral**, never violet.
3. **Geist + Geist Mono**, admin only, self-hosted with `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`.
4. **One new feature: the breadcrumb top bar.** No ⌘K, no collapsible sidebar, no copy buttons, no workspace switcher, no "+ New", no avatar, no help, no upgrade prompt, no inert look-alike controls.

Asked and answered on 2026-09-26:

5. **Field edges pass 3:1.** The canvas's strong border (#3F3F46 dark, #D4D4D8 light) measures 1.89:1 and 1.48:1 against the page. Inputs, selects, textareas, checkboxes and the joined filter strip use `--input` at **#63636B dark (3.32:1) / #8E8E96 light (3.25:1)**. Outline and secondary buttons keep the canvas values, as `--console-border-strong`, because their label already identifies them.
6. **Login drops the client header.** `/admin/login` and `/admin/reset-password` become the same place: a centred console panel. This supersedes the 2026-09-25 decision in `pages/admin-login.md` that login wears `ClientHeader`.

Derived under the brief's own "darken if it fails" rule (recorded, not asked):

7. **Light success is #15803D**, not the canvas's #16A34A, which measures 3.01:1 on its #EAF8EF tint (text needs 4.5:1). #15803D is 4.58:1 on the tint and 5.02:1 on white. It is used for success text and success icons alike.
8. **Muted text never sits on the chip colour in light.** #71717A is 4.63:1 on #FAFAFA and 4.83:1 on white, as the canvas says, but 4.40:1 on the #F4F4F5 chip. Chips carry text-colour type; muted type goes on the canvas or the surface.
9. **The solid destructive confirm in dark** uses #DC2626 with a white label (4.83:1). The dark `--destructive` (#F87171) is a text colour and cannot carry a white label.

## 1. Theme mechanics

- While any admin route is mounted (the layout, login, reset password), `document.documentElement.dataset.adminTheme` is `'light'` or `'dark'` (the resolved value). It is removed on unmount, so a client page after admin carries no admin token.
- Tokens are declared under `:root[data-admin-theme="light"]` and `:root[data-admin-theme="dark"]` in `frontend/src/index.css`, on the document root and not a wrapper, because Radix popovers portal into `body`.
- They override the shadcn semantic variables and add the `--console-*` set below, the font families and `color-scheme`.
- **`dark:` utilities are never used for admin theming.** In this codebase `.dark` holds the client's light palette (commit `dc69157`), so `dark:` does not mean "dark theme".
- Preference: `system | light | dark`, key `bookly.admin.theme`, every `localStorage` access in `try/catch` falling back to `system`. Resolved synchronously on first render, so there is no flash of the other theme. Module: `frontend/src/admin/theme.ts`.
- The toggle is a three-segment radio group (Monitor / Sun / Moon icons, each named by a new `en.json` key), in the top bar's right-hand cell from `lg` and beside Sign out below it. Login and reset password apply the theme but show no toggle.

## 2. Tokens

Values are the canvas hex converted to oklch (four decimals). Contrast is WCAG 2.x, measured on the exact hex. "Canvas" means the page background.

### 2.1 shadcn semantic tokens, overridden in the admin scope

| Token | Dark | Light | Role |
|---|---|---|---|
| `--background` | #0A0A0B `oklch(0.1452 0.0021 286.13)` | #FFFFFF `oklch(1 0 0)` | canvas |
| `--foreground` | #F4F4F5 `oklch(0.9674 0.0013 286.38)` | #18181B `oklch(0.2103 0.0059 285.89)` | text |
| `--card` | = canvas | = canvas | panels are flat planes; a border, not a fill, sets them apart |
| `--popover` | #131315 `oklch(0.1876 0.004 286.01)` | #FFFFFF | raised surface + hairline (light may add a very soft shadow) |
| `--primary` | #FAFAFA `oklch(0.9851 0 0)` | #18181B | **inverted neutral**: the main action |
| `--primary-foreground` | #0A0A0B | #FFFFFF | label on the main action |
| `--secondary` | #27272A `oklch(0.2739 0.0055 286.03)` | #F4F4F5 `oklch(0.9674 0.0013 286.38)` | chip |
| `--secondary-foreground` | = text | = text | |
| `--muted` | #27272A | #F4F4F5 | chip / icon tile / neutral badge; ghost and outline hover |
| `--muted-foreground` | #A1A1AA `oklch(0.7118 0.0129 286.07)` | #71717A `oklch(0.5517 0.0138 285.94)` | meta, labels, "MONITOR" |
| `--accent` | #131315 | #FAFAFA | raised surface: row and nav hover |
| `--accent-foreground` | = text | = text | |
| `--destructive` | #F87171 `oklch(0.7106 0.1661 22.22)` | #B91C1C `oklch(0.5054 0.1905 27.52)` | danger text and edges |
| `--border` | #27272A | #E4E4E7 `oklch(0.9197 0.004 286.32)` | hairline: every structural divider |
| `--input` | #63636B `oklch(0.5025 0.0126 285.94)` | #8E8E96 `oklch(0.6493 0.0118 286.07)` | field edges (decision 5) |
| `--ring` | #B9A2FF `oklch(0.7679 0.1322 294.45)` | #7C3AED `oklch(0.5413 0.2466 293.01)` | focus: violet |
| `--radius` | `0.125rem` | `0.125rem` | 2px; every shadcn derived radius shrinks with it |
| `--sidebar` | = canvas | #FAFAFA `oklch(0.9851 0 0)` | |
| `--sidebar-foreground` | = text | = text | |
| `--sidebar-primary` | #3A1784 `oklch(0.3364 0.1647 288.7)` | #F1ECFE `oklch(0.9522 0.0245 298.61)` | active nav fill |
| `--sidebar-primary-foreground` | #D4C6FF `oklch(0.857 0.0795 295.94)` | #7C3AED | active nav text |
| `--sidebar-accent` | #131315 | #F4F4F5 | nav hover |
| `--sidebar-accent-foreground` | = text | = text | |
| `--sidebar-border` | = border | = border | |
| `--sidebar-ring` | = ring | = ring | |
| `color-scheme` | `dark` | `light` | scrollbars, native date/time pickers |

### 2.2 Console tokens (new, admin only)

| Token | Dark | Light | Role |
|---|---|---|---|
| `--console-surface` | #131315 | #FAFAFA | raised surface, status band |
| `--console-chip` | #27272A | #F4F4F5 | count chips, icon tiles, neutral badges |
| `--console-border-strong` | #3F3F46 `oklch(0.3703 0.0119 285.81)` | #D4D4D8 `oklch(0.8711 0.0055 286.29)` | outline / secondary buttons (decision 5) |
| `--console-link` | #B9A2FF | #7C3AED | link text, accent icons |
| `--console-link-hover` | #D4C6FF | #5B21B6 `oklch(0.432 0.2106 292.76)` | |
| `--console-accent` | #3A1784 | #F1ECFE | accent fill: active nav, info banner |
| `--console-accent-foreground` | #D4C6FF | #7C3AED | text on the accent fill in the nav |
| `--console-info-foreground` | #F4F4F5 | #18181B | text on the accent fill in a banner |
| `--console-info-icon` | #F4F4F5 | #7C3AED | the banner's icon |
| `--console-accent-strong` | #5B21B6 | #7C3AED | the one headline badge, white label |
| `--console-success` | #4ADE80 `oklch(0.8003 0.1821 151.71)` | #15803D `oklch(0.5273 0.1371 150.07)` | success text and icons (decision 7) |
| `--console-success-tint` | #0F2E1C `oklch(0.2718 0.0501 155.43)` | #EAF8EF `oklch(0.9662 0.0189 157.88)` | |
| `--console-warning` | #FBBF24 `oklch(0.8369 0.1644 84.43)` | #B45309 `oklch(0.5553 0.1455 49)` | |
| `--console-warning-tint` | #2A2110 `oklch(0.2535 0.0317 82.37)` | #FEF5E7 `oklch(0.9734 0.0209 79.1)` | |
| `--console-danger-tint` | #2A1215 `oklch(0.2189 0.0398 12.97)` | #FDECEC `oklch(0.9566 0.0185 17.48)` | |
| `--console-danger-solid` | #DC2626 `oklch(0.5771 0.2152 27.33)` | #B91C1C | fill of the irreversible confirm, white label (decision 9) |
| `--font-sans` (admin) | `'Geist Variable'`, system-ui, sans-serif | same | |
| `--font-mono` (admin) | `'Geist Mono Variable'`, ui-monospace, monospace | same | |

### 2.3 Measured contrast

| Pair | Dark | Light | Needs |
|---|---|---|---|
| text on canvas | 18.00 | 17.72 | 4.5 |
| text on chip | 13.55 | 16.12 | 4.5 |
| muted on canvas | 7.72 | 4.83 | 4.5 |
| muted on surface (row hover / sidebar) | 7.24 | 4.63 | 4.5 |
| muted on chip | 5.81 | **4.40, not used** (decision 8) | 4.5 |
| link on canvas | 9.12 | 5.70 | 4.5 |
| link on surface | 8.55 | 5.46 | 4.5 |
| link hover on canvas | 12.55 | 8.98 | 4.5 |
| `in_progress` label on solid success | 11.36 (canvas colour on #4ADE80) | 5.02 (white on #15803D) | 4.5 |
| active nav text on accent fill | 8.14 | 4.93 | 4.5 |
| banner text on accent fill | 11.68 | 15.33 | 4.5 |
| white on strong accent badge | 8.98 | 5.70 | 4.5 |
| success on success tint | 8.44 | 4.58 | 4.5 |
| success on canvas | 11.36 | 5.02 | 4.5 |
| warning on warning tint | 9.51 | 4.65 | 4.5 |
| danger on canvas | 7.15 | 6.47 | 4.5 |
| danger on danger tint | 6.35 | 5.66 | 4.5 |
| white on solid danger | 4.83 | 6.47 | 4.5 |
| primary button label on its fill | 18.96 | 17.72 | 4.5 |
| field edge (`--input`) on canvas | 3.32 | 3.25 | 3.0 |
| field edge on surface | 3.12 | 3.11 | 3.0 |
| focus ring on canvas | 9.12 | 5.70 | 3.0 |
| focus ring on chip | 6.86 | 5.18 | 3.0 |
| outline-button edge on canvas | 1.89 (exempt: labelled) | 1.48 (exempt) | — |
| hairline on canvas | 1.33 (decorative) | 1.27 (decorative) | — |

## 3. Type

Geist replaces Open Sans and Poppins inside the admin scope. Headings take Geist too: `h1`-`h3` and `.font-heading` are overridden in the admin scope, in `@layer base` so a utility such as `font-mono` on an `h1` still wins.

| Role | Face | Size / weight / tracking | Used for |
|---|---|---|---|
| Page title (`h1`) | Geist | 30px / 600 / -0.02em, line-height 1.2 | one per page |
| Section heading (`h2`) | Geist | 20px / 500 | panel and section titles |
| Sub-heading (`h3`, legends) | Geist | 16px / 500 | |
| Body, nav, row titles | Geist | 16px / 400 | |
| Secondary meta | Geist | 14px, muted | "BKY-… · 14 Oct" lines, intros, hints |
| Help and error text | Geist | 13px | under fields |
| Eyebrow / table header / tile label / group label | Geist Mono | 12px / 500 / uppercase / 0.1em, muted | |
| Data values | Geist Mono | 15px, `tabular-nums` | references, times, durations, money, IDs |
| Log / history lines | Geist Mono | 13px | message and payment history rows |
| Link | inherits | accent colour, no underline; hover underline | **except** references/IDs and links inside banners: underlined at rest |

Mono data values use the existing `admin:*` strings; the mono face is styling, not new copy.

## 4. Shape, borders, spacing, motion, icons

- **Grid:** 4px steps: 4, 8, 12, 16, 24, 32, 48, 64. Sections 48px apart (`gap-12`) on desktop, 32px on mobile. Panels and tiles padded 24px.
- **Radius:** 2px (`--radius` 0.125rem) for buttons, inputs, badges, banners, panels, tiles. Round only for status icons. **No pills:** console badges set their own `rounded-[2px]`.
- **Borders:** 1px. Hairline (`--border`) for structure; `--input` for field edges; `--console-border-strong` for outline buttons. Regions are divided by borders, never by shadows or fills.
- **No shadows, no gradients** in admin. Card `shadow-sm` is removed by the console panel treatment; popovers get a border (and, in light only, `0 4px 12px rgb(0 0 0 / 0.06)` at most).
- **Shell:** top bar 56px; sidebar 260px; content gutter 48px desktop (`lg:px-12`), 16px mobile (`px-4`). Page widths stay per page (`admin-shell.md`), padding changes only.
- **Controls:** buttons and inputs 40px tall from `lg`, 44px below it and on coarse pointers; the search cell 48px; nav items 44px; table rows about 64-72px with two lines.
- **Motion:** 100-150ms colour and background transitions only, behind `motion-safe`. No lift, scale, slide or `translate-y-px` press nudge in console variants.
- **Focus:** a 2px violet outline, offset 2px, on every interactive element, in both themes. Set once in the admin scope as an unlayered `:focus-visible` rule (so it beats `outline-none` utilities) that also zeroes the 50% ring shadow, so there is one indicator. Elements with `tabindex="-1"` (the content wrapper, focused headings) are excluded.
- **Icons:** lucide, outline, `stroke-width: 1.5` and `stroke-linecap: square` for every `svg.lucide` in the admin scope. 16px in breadcrumbs, meta rows and buttons; 18px in nav and banners; 20px in stat tiles. Icons inherit text colour; only status icons are coloured. Every breadcrumb level, nav item and stat tile has an icon.
- **Relative times:** where a relative time is already shown, its absolute time goes in a `title` with a dotted underline. (Today no admin page shows relative times, so this is a rule for later.)

## 5. Status mapping

Every stage keeps its word; the icon repeats it. The console treatment is an opt-in `variant="console"` on `StatusBadge`, so the client pill does not change. Badges are rectangles, 2px radius, `px-2.5 py-[5px]` 14px/500 at `md`, `px-2 py-0.5` 13px/500 at `sm`.

| Stage / status | Icon (lucide) | Badge |
|---|---|---|
| `confirmed` | `CircleCheck`, **filled** success (current) | success tint, success text |
| `in_progress` | `CircleCheck`, filled | **solid** success fill, canvas-colour text (the one solid status) |
| `awaiting_payment`, `pending_payment` | `Clock` | no fill, **dashed** `--input` edge, text colour |
| `needs_review` | `Clock` | warning tint, warning text |
| `completed` | `CircleCheck`, **outlined** success (earlier success) | chip fill, text colour |
| `closed` | `CircleCheck`, outlined, muted | no fill, hairline edge, muted text |
| `no_show` | `CircleX` red | danger tint, danger text |
| `cancelled_by_client` | `CircleX` red | no fill, danger text, danger 40% edge |
| `cancelled_by_admin` | `CircleX` red | no fill, muted text, hairline edge |
| `expired` | `CircleX` muted | no fill, **dotted** `--input` edge, muted text |
| unknown | none | hairline edge, text colour |

In greyscale they stay apart by fill (solid, tint, chip, none), edge (dashed, dotted, solid, none) and icon (filled check, outlined check, clock, cross), and always by the word. Filled icons are drawn as a filled circle with a canvas-coloured check (as in the canvas), with `aria-hidden`.

**Payments and messages** use the same four shapes for their own words: succeeded / sent = filled check; refunded = outlined check; pending / queued = clock; failed = red cross. The word is always shown.

The legend popover (`StageLegend`) lists the console badges on admin pages (it passes `variant="console"` through when its audience is admin).

## 6. Components

### 6.1 Shell (`AdminLayout.tsx`)

The contract in `pages/admin-shell.md` holds: one `nav[aria-label="Admin"]` that reflows, no drawer or open/close state, skip link first to `#admin-content`, `min-w-0` content column, each page keeps its own `main` and width, Sign out last.

```
>= lg
+------+--------------------------------------------------------+-----------+
| mark | Admin  >  [icon] Bookings  >  BKY-2610-00042            | [M][S][D] |  56px, cells split by hairlines
+------+----+---------------------------------------------------+-----------+
| [cal] Bookly   |                                                          |
|                |  (page)                                                   |
| [i] Calendar   |                                                          |
| [i] Bookings   |                                                          |
| [i] Catalogue  |                                                          |
| [i] Availab.   |                                                          |
| [i] Settings   |                                                          |
|----------------|                                                          |
| [->] Sign out  |                                                          |
+----------------+----------------------------------------------------------+
```

- **Top bar (from `lg`):** full width, sticky, 56px, `border-b`. Three cells separated by vertical hairlines: the **mark cell** (56px square, a decorative Bookly monogram, `aria-hidden`; never a second "Bookly" text node, because a test finds the wordmark by that text), the **breadcrumb cell** (`flex-1`, `px-6`) and the **theme cell** (the toggle, `px-3`). Nothing else.
- **Sidebar (from `lg`):** 260px, `border-r`, `bg-sidebar`, sticky below the top bar, full remaining height, own scroll. Top: the wordmark span "Bookly" at 20px/500 with a `CalendarCheck` icon (20px). Then the five links, in their current order: 44px tall, 16px text, 18px icon, `px-3.5`, square, full width, `gap-1` between rows. **Active:** `bg-sidebar-primary text-sidebar-primary-foreground font-medium` (violet fill, not colour alone: fill + weight + `aria-current`). **Inactive:** text colour, `hover:bg-sidebar-accent`. **Sign out** pinned to the bottom above a hairline, ghost weight, `text-destructive`, `hover:bg-destructive/10`, 44px, full width.
- **Below `lg` (as shipped, 2026-09-26):** row 1 is the top bar itself: the breadcrumb (the last two segments, the last truncating; the Admin crumb is icon-only below `sm`, still named "Admin", and a 44px square) and the theme toggle. Row 2 is the wordmark with Sign out on the right (icon-only below `sm`, as `admin-shell.md` already had it); row 3 the five links wrapping. The brief suggested the breadcrumb as a row *under* the nav; moving it there with `order-*` would make Tab visit it before the links it sits below, so DOM order and reading order were kept equal instead (raised at the checkpoint; see §9). All touch targets 44px.
- **Content:** `#admin-content` stays the focusable wrapper; the page's `main` gets `px-4 lg:px-12` and `py-8 lg:py-12`.

### 6.2 Breadcrumbs (new)

- `nav aria-label={t('admin:breadcrumb.label')}` ("Breadcrumb") > `ol`. Separators are `ChevronRight` 16px, `aria-hidden`, in `li` of their own with `role="presentation"`, or as `aria-hidden` spans inside items.
- Segments: **Admin** (`admin:nav.label`, link to `/admin`) → **section** with its nav icon and the `admin:nav.*` label → on `/admin/bookings/:id`, the **booking reference** in mono. Earlier items are links; the last is plain text with `aria-current="page"`. On a section page the section is the last item.
- The reference comes from `AdminBookingDetail`'s own fetch through a small context provided by the layout (`useBreadcrumbTail`). While loading, the tail is a neutral skeleton block (`aria-hidden`, 96×16px). On error or 404 the tail is dropped. No second fetch.
- Section from the route: a map from path prefix to nav item, shared with the sidebar (`frontend/src/admin/nav.ts`).

### 6.3 Page header

- **Eyebrow row:** 16px icon + mono uppercase label (§3). Reuse the nav label or an existing string; add an `en.json` key only if none fits.
- **`h1`:** page or entity name (booking detail: the reference, mono).
- **Inline badges** after the `h1`, rectangles (`StatusBadge variant="console" size="md"`, neutral chip badges, at most one strong-accent badge per page).
- **Meta row:** icon + text pairs, 14px muted, `gap-x-6 gap-y-2`, wrapping.
- **Actions:** right-aligned on desktop, full-width stack on mobile. Main action = `Button` default (inverted neutral); secondary = `outline`; destructive keeps its red.
- **Status band (optional, booking detail):** full-bleed within the content column (`-mx-4 lg:-mx-12`, `border-y`, `bg-console-surface`), 56px: status badge, the reference as a chip, date and duration in mono.
- Shared as `frontend/src/pages/admin/console/PageHeader.tsx`.

### 6.4 Callout / banner (`callout.tsx`)

A new opt-in `variant="console"` (the default rendering is untouched): full width, 2px radius, `px-4 py-3.5`, 18px icon, 14-15px text, an optional trailing action slot (underlined link) on the right. Tones: `info` (accent fill, info foreground, no border in dark; `--console-accent` fill in light), `success`, `warning`, `destructive` (their tints, text colour for words, tone colour for the icon). Used only for notices that already exist.

### 6.5 Tables and lists

- **Toolbar:** filters joined into one bordered strip (`Toolbar.tsx`): cells split by `--input` hairlines, 48px tall from `lg`; a flex-1 search cell with a leading `Search` icon. Existing controls restyled, nothing new. Below `lg` the cells stack, each full width.
- **Header row:** mono uppercase 12px muted labels, optional count chip (mono 12px on `--console-chip`, square), hairline below, no fill.
- **Rows:** hairline between rows, no zebra, whole-row hover `bg-accent`. First column: status icon (filled, §5) then two lines: primary (16px) and meta (14px muted: the **reference as an underlined mono link**, `·`, the date). Other columns secondary text, mono for times and money.
- No row actions are added: the bookings list has none today.
- **Narrow widths (user request, 2026-09-26: mobile-friendly):** the bookings table stacks each row into one block when *its own container* is under 56rem (a container query, not a viewport breakpoint: with the sidebar, the column between `lg` and about 1150px is narrower than a tablet's). Stacked, only the Status header stays visible (it carries the legend), and cells are indented past the status glyph. Explicit `role="table"`/`row`/`cell` keep the table semantics after the `display` change. Cells are `px-3` so the six columns fit a 1280px screen; amounts never break inside themselves, the words beside them may. This replaces the sideways scroll of `pages/admin-bookings.md`.

### 6.6 Stat grid (`StatGrid.tsx`)

Two columns from `sm`, one below. Each item: a 64px square icon tile (48px below `sm`; `--console-chip`, 20px icon; status tiles take the status tint and icon), then a mono label above the value (mono 15px for data, Geist 16px for words). Only data the page already has; labels from existing strings.

### 6.7 Forms

Label above (14px Geist medium); inputs square, 1px `--input` edge, **no fill** (`bg-transparent`), 40px (44px below `lg` and on touch), violet focus; hint 13px muted; error 13px danger with a `CircleAlert` 14px icon. Group headings may use the mono label. Sections are divided by full-bleed hairlines, not nested cards; an inline editor inside a panel is a `--console-surface` sub-surface with a hairline, never a second card.

### 6.8 Login and reset password

A centred 400px panel on the canvas, `border`, 2px radius, `p-8` (`p-6` below `sm`): the Bookly monogram with the word "Bookly" as a **real link to `/`** (with the client header gone it is the only way back to the site), a mono eyebrow `ADMIN` (`admin:nav.label`), the `h1` at **24px**/600 (the page title's 30px wraps "Choose a new password" to three lines in a 288px phone panel), the fields; the primary button inverted neutral and full width; the "Forgot your password?" / "Back to sign in" links muted, underlined on hover, 44px below `lg`. No client header and so no skip link (decision 6). The theme applies; no toggle. Both pages share `pages/admin/console/AuthFrame.tsx`.

### 6.9 Calendar

Square cells, hairline grid, mono hour labels and date numbers, today marked by a violet date chip. Events are square chips on `--console-surface` with a 3px left edge in the status colour (the one sanctioned side edge in admin: it is an event's status key in a dense grid, and the status word and icon are still inside the event), 13px Geist title, mono time. The conflict outline (2px danger) and the block hatch keep their meaning. The toolbar is a joined bordered strip; the view switch is a segmented control whose active segment is filled `--primary`.

### 6.11 Dialogs (2026-09-27)

User decision: every create and edit form in the admin opens in a modal dialog, opened by its button; the one exception is the availability page's "Add block", which stays inline. One-click actions (Mark completed, No-show, Resend link) stay plain buttons.

- `components/ui/dialog.tsx` is the shadcn Dialog over Radix, in the console look: a `--popover` panel with a hairline and 2px corners over a 60% black scrim, no shadow. It closes on the ×, Escape, a click on the scrim and the form's own Cancel; Radix traps focus inside it.
- `pages/admin/console/FormDialog.tsx` wraps a form: a header with the title (and the × at 44px below `lg`), then a body that scrolls inside the panel on a short screen, never the page. It returns focus to the button that opened it (Radix does so only for its own trigger), so that button stays mounted while the dialog is open.
- Closing without saving discards what was typed; a successful save closes the dialog and the page shows what the API answered. A refused save keeps the dialog open and shows the refusal inside it, where the eye is.
- The shared forms (EntityForm, BlockForm, WorkingHoursForm) drop their own heading and panel frame inside a dialog (`InDialogContext`), since the dialog titles them.

### 6.12 Loading (2026-09-27)

User decision (admin console fixes, item 2): while an admin page loads, the shell (nav, top bar, breadcrumb) and the page header stay real, and the page's own layout is drawn with placeholder blocks where its data will be (`components/ui/skeleton.tsx`), each the size and grid of what replaces it, so nothing jumps when the data arrives. Shared pieces are in `pages/admin/console/Skeletons.tsx`: `LoadingRegion` (`aria-busy`, blocks `aria-hidden`, the page's existing loading sentence announced once in a visually hidden `role="status"`), `Line` and `PanelSkeleton`. The pulse stops under reduced motion.

- Bookings: only the rows are placeholders; the filters stay.
- Booking detail: header, status band, the shoot's tiles and two sections.
- Catalogue and availability: their panels with hairline rows.
- Settings: its panel of fields.
- Calendar: FullCalendar's grid is the real layout from the first paint, so the wait for events is announced (`aria-busy` on the region), not drawn; the old visible line pushed the grid down on every range load.

### 6.10 Buttons (`button.tsx`, opt-in `size="console"` and `variant` additions)

- Default (inverted neutral), `console-outline` (`--console-border-strong` edge, transparent, hover `bg-muted`), ghost, destructive (tint + red text), and `console-destructive-solid` (`--console-danger-solid` fill, white label) for the irreversible confirm. The client's `destructive-solid` is never used in admin: the dark `--destructive` is a text colour.
- `size="console"`: 40px (`lg`), 44px below `lg` and on coarse pointers, `px-4`, 15px/500, `gap-2`, 16px icons. `size="console-sm"`: 32px from `lg`, 44px below. `console-icon`: 40px / 44px. No press nudge; colour-only transitions behind `motion-safe`.

## 7. Overrides recorded in the page files (2026-09-26)

| File | What this redesign overrides |
|---|---|
| `admin-shell.md` | Sidebar 240px → 260px; active item `bg-primary/10 text-primary` → violet `--sidebar-primary` fill; adds the top bar (mark, breadcrumbs, theme toggle); "No breadcrumbs" in *Do not* is lifted for breadcrumbs only; theme toggle added. Everything else holds. |
| `admin-login.md` | The client header is removed (decision 6); the card becomes the console panel (§6.8). |
| `admin-reset-password.md` | The card becomes the console panel; the "same place as login" rule now holds again. |
| `admin-calendar.md` | Heading-font toolbar title → Geist; FullCalendar chrome and events per §6.9; status colours per §5. |
| `admin-bookings.md` | Header row, row anatomy and filter strip per §6.5; stage toggles stay (restyled: pressed = inverted neutral with a check, unpressed = outline); status badges per §5. |
| `admin-booking-detail.md` | `rounded-xl` cards → flat sections split by hairlines; a page header with a status band; Shoot / Money as stat grid where it fits (§6.6); status per §5. Order, gating and the two-step cancel hold. |
| `admin-catalogue.md` | Service cards → bordered flat panels; `EntityForm` sub-surface per §6.7; active/inactive badges → console success / chip badges. |
| `availability.md` | Cards → flat panels; the overlap warning is a console destructive callout with the solid confirm; `h1` 30px. |
| `settings.md` | Card → flat panel; hints 13px muted; saved confirmation → console success callout. |
| `MASTER.md` | Admin is no longer "the same system, denser": it has its own palette, type, radius and elevation (this file). The client side is unchanged. |

## 8. Guardrails

- Client routes render pixel-identical before and after (byte/pixel diff at 375px and 1280px).
- Protected files never appear in a diff (brief §2). Only `index.css`, `components/ui/*` (opt-in variants only), `pages/admin/*`, `admin/AdminLayout.tsx`, new files under `admin/`, `en.json` (additive), `design-system/`, `DESIGN.md`, and the font dependencies change.
- Behaviour and accessible names are preserved (brief §2).

## 9. Accepted adaptations (finish review, 2026-09-27)

A fresh reviewer compared the shipped admin with the brief, this spec, the style guide and the references. What it found was fixed, except these, which are kept on purpose:

| Where | What differs from the letter of this spec | Why it stays |
|---|---|---|
| Shell below `lg` | Breadcrumb and toggle on the first row, above the wordmark (§6.1) | Tab order equals reading order; raised with the user at the Phase 2 checkpoint, who approved continuing. |
| Calendar on a phone | Month events show the time and status glyph, week events the glyph only; the status word is `sr-only` there (visible in day view and from `sm`) | A 48px month cell cannot hold "Confirmed" legibly, and a truncated "Con…" says less than the glyph. The four glyph shapes differ per status, the word stays in the accessible name, and a tap opens the booking. The 3px status edge is kept. |
| Booking detail status band | The band holds the reference chip, start and duration, not the status badge (§6.3) | The badge sits beside the `h1`; a second copy made the e2e's `getByText('Cancelled by you')` ambiguous, and e2e files are outside this redesign. |
| Section page eyebrows | "ADMIN" on calendar, bookings, catalogue, availability and settings; "BOOKINGS" on booking detail | No existing string names a category above a section, the nav label would repeat the `h1`, and new copy was not warranted. |
| Narrow pages | Settings (`max-w-3xl`) and booking detail centre in the content column, so their `h1` starts right of the wide pages' | `pages/admin-shell.md`: each page keeps its own width and centres in the column. |
| Mono data values | A time or amount that is interpolated inside one translated sentence ("30,000 RWF still to pay", a block's "…, 09:30 to 11:00", "Live until …") stays in Geist | Splitting a translated sentence to style part of it risks the translation; where the value could be isolated without changing text (catalogue meta, money columns) it is mono. |
| Auth panel title | 24px, not 30px (§6.8) | See §6.8. |
| Catalogue "Active" badge | A plain `Check` beside the word, on the success tint | It is not one of the four status shapes (§5 uses `CircleCheck`), so it does not borrow booking-status meaning; the word carries it. |
