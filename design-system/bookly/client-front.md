# Client Front — Design Spec

> **Project:** Bookly · **Scope:** every route inside `ClientShell` (`/`, `/services`, `/services/:slug`, `/checkout/*`, `/my-booking`, `/email-confirm/:token`, `/booking/*`, `*`). The admin (`/admin/*`, login and reset password included) must not change by a single pixel.
> **Written:** 2026-09-27, from `docs/prompts/client-front-redesign.md` (the brief) and the user's canvas <https://claude.ai/artifact/QVwFvLqQwHAmLHnUUhRua2> (boards `Client-Home.dc.html`, `Client-Booking.dc.html`, `Main.dc.html`).
> **Precedence:** this file overrides `MASTER.md`, `DESIGN.md`'s client sections and every client page file in `pages/` wherever they conflict. Each of those files carries a dated note pointing here. Where this file is silent, the page file still holds (structure, states, behaviour, "Do not" lists). The admin keeps `admin-console.md`.

## 0. Decisions

From the brief (§1, not re-opened):

1. **Light and dark.** The default follows `prefers-color-scheme`, live. A System / Light / Dark control in the header overrides it on this device. Dark is derived from the admin's shipped dark tokens.
2. **The funnel keeps its structure.** `/services/:slug` stays one page with three numbered groups and the price summary beside them; then the held page, checkout and payment progress, restyled. The board's 5-step wizard, Back/Continue and Review step are **not** adopted: the boards give the components, not the flow.
3. **Selective motion** (§6): entrance fade-ups, hover lift, arrow nudge, the 1px button lift, pop and tick on selection, the staggered rise of time slots. No endless loops, no shake. One functional spinner while a payment is waited on. Nothing moves under `prefers-reduced-motion: reduce`.
4. **Home builds the four board additions:** the hero with the calendar mock-up, "How booking works" (and its header link), the "Already booked?" band, and a footer that shows contact details only when real ones exist.
5. **The console language, public-facing:** Geist + Geist Mono, the violet accent, 2px corners, 1px hairlines, no shadows, mono uppercase labels, lucide at 1.5px stroke, inverted-neutral primary buttons.

Derived here (recorded, not asked):

6. **The board's `#D4D4D8` field edge fails** (1.48:1). Fields, checkboxes and the resting edge of day and slot cells that must be seen use `--input`: **#8E8E96 light (3.25:1) / #63636B dark (3.32:1)**, as admin decision 5. Outline buttons keep `#D4D4D8` / `#3F3F46` (`--console-border-strong`): their label identifies them.
7. **Light success is #15803D** (4.58:1 on its tint), as admin decision 7.
8. **Muted text never sits on the chip colour in light** (4.40:1), as admin decision 8. The board's `#A1A1AA` text on white (weekday heads, "(optional)", captions) is **2.56:1** and is replaced by muted `#71717A` (4.83:1). A disabled day number keeps a faint `#A1A1AA`: inactive controls are exempt, and it is still legible.
9. **The client's solid "Yes, cancel my booking" in dark** is `#DC2626` with a white label (4.83:1): the dark `--destructive` (#F87171) is a text colour and cannot carry white, as admin decision 9.
10. **The selected day in dark** is the inverted neutral fill (#FAFAFA); its pip is `#7C3AED` (5.46:1), not the board's lavender (2.08:1 on that fill).
11. **Scoping without touching the admin.** Client-only rendering in the shared primitives is written with a `client:` Tailwind variant, `(&:where([data-theme], [data-theme] *))`, and `dark:` becomes `(&:where([data-theme=dark], [data-theme=dark] *))`. `ClientShell` sets `data-theme` on `<html>`; the admin never does, so neither variant can match on an admin page. The admin's own blocks in `index.css` are left exactly as they were (no shared primitives layer: the pixel identity is the rule, and restructuring those blocks buys nothing the client needs).

Asked and answered at the checkpoint (2026-09-27):

12. **The live copy stays.** The board's headlines are not adopted; Home uses the existing `landing:*` strings.
13. **Contact details ship as placeholders.** `lib/contact.ts` holds dummy values ("Studio name", `+250 700 000 000`, `hello@example.com`), shown in the footer and the summary's "Questions?" line, to be replaced with the photographer's real details before launch. This departs from the brief's "nothing invented", at the user's request.
14. **"My booking" is an icon below `sm`** so the theme button fits the 375px bar (its words stay its accessible name; the footer carries it in words).
15. **The booking page's `h1` stays "Your booking"** (`client-booking.spec.ts` pins it and reads the reference once): a mono "My booking" eyebrow, the `h1`, the status badge beside it; the reference stays in the facts, in mono.
16. **The held page shows "Held until" and the existing time**, mono 28-32px, and no countdown: none exists, and a ticking timer would be new logic.

## 1. Theme mechanics

- **Shared logic** `frontend/src/lib/theme.ts`: preference parsing, guarded `localStorage`, live `matchMedia`, a synchronous first resolve, and a hook factory parameterised by storage key and root attribute. `admin/theme.ts` keeps its exact exports (`useAdminTheme`, `readThemePreference`, `writeThemePreference`, `THEME_STORAGE_KEY`, `THEME_PREFERENCES`, the types), key `bookly.admin.theme` and attribute `data-admin-theme`, as a thin wrapper; its tests are unchanged.
- **Client:** key `bookly.theme`, attribute `data-theme` (`light` | `dark`, the resolved value), plus `color-scheme` from the token block. Set by `ClientShell` in a layout effect (before first paint) and removed on unmount. The two preferences are independent on purpose: the photographer's admin choice does not repaint the public site.
- **Control:** one `button` in the header's right cluster, **not radios** (`checkout.spec.ts` counts radios page-wide). Clicking **cycles System → Light → Dark → System** (the brief's preferred behaviour). Its accessible name states the current setting, "Theme: System" / "Theme: Light" / "Theme: Dark" (new `shell:theme.*` keys), mirrored in `title`. The icon shows the setting: `Monitor`, `Sun`, `Moon`. 40px square on a mouse, 44px on a coarse pointer, ghost.
- **First paint:** plain `:root` holds the **light** values, so jsdom tests and the instant before the effect have sane tokens. The attribute blocks are `:root[data-theme="light"]` and `:root[data-theme="dark"]`.
- **Crossing over:** leaving the client for `/admin/*` unmounts `ClientShell` (attribute removed) before the admin layout's effect sets `data-admin-theme`, and the reverse. `/admin/login` sits outside both shells and sets only its own attribute. The admin blocks are declared after the client ones at equal specificity, so they win even if both were ever present.

## 2. Tokens

Hex from the boards, converted to oklch (four decimals); contrast is WCAG 2.x measured on the exact hex. "Canvas" is the page background.

### 2.1 Semantic tokens (shadcn names), client scope

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | #FFFFFF `oklch(1 0 0)` | #0A0A0B `oklch(0.1452 0.0021 286.13)` | canvas |
| `--foreground` | #18181B `oklch(0.2103 0.0059 285.89)` | #F4F4F5 `oklch(0.9674 0.0013 286.38)` | text |
| `--card` | = canvas | = canvas | panels are flat; a border sets them apart |
| `--popover` | #FFFFFF | #131315 `oklch(0.1876 0.004 286.01)` | |
| `--primary` | #18181B | #FAFAFA `oklch(0.9851 0 0)` | inverted neutral: the main action |
| `--primary-foreground` | #FFFFFF | #0A0A0B | |
| `--primary-hover` (new) | #3F3F46 `oklch(0.3703 0.0119 285.81)` | #E4E4E7 `oklch(0.9197 0.004 286.32)` | |
| `--secondary`, `--muted` | #F4F4F5 `oklch(0.9674 0.0013 286.38)` | #27272A `oklch(0.2739 0.0055 286.03)` | chip, icon tile, neutral badge |
| `--muted-foreground` | #71717A `oklch(0.5517 0.0138 285.94)` | #A1A1AA `oklch(0.7118 0.0129 286.07)` | captions, eyebrows |
| `--accent` | #FAFAFA `oklch(0.9851 0 0)` | #131315 | the surface: bands, card hover, summary |
| `--destructive` | #B91C1C `oklch(0.5054 0.1905 27.52)` | #F87171 `oklch(0.7106 0.1661 22.22)` | danger text and edges |
| `--border` | #E4E4E7 | #27272A | hairline |
| `--input` | #8E8E96 `oklch(0.6493 0.0118 286.07)` | #63636B `oklch(0.5025 0.0126 285.94)` | field edge (decision 6) |
| `--ring` | #7C3AED `oklch(0.5413 0.2466 293.01)` | #B9A2FF `oklch(0.7679 0.1322 294.45)` | focus |
| `--radius` | `0.125rem` | `0.125rem` | 2px |
| `color-scheme` | `light` | `dark` | |

### 2.2 Family tokens (the admin's `--console-*` names, defined for the client too)

Defined in the client blocks so the shared console variants (`StatusBadge variant="console"`, `Callout variant="console"`, the console badges) render on client pages. Values match the admin's except where the brief tunes them for a public page (marked ★).

| Token | Light | Dark |
|---|---|---|
| `--console-surface` | #FAFAFA | #131315 |
| `--console-chip` | #F4F4F5 | #27272A |
| `--console-border-strong` | #D4D4D8 `oklch(0.8711 0.0055 286.29)` | #3F3F46 |
| `--console-link` ★ | #6D28D9 `oklch(0.4907 0.2412 292.58)` | #B9A2FF |
| `--console-link-hover` ★ | #4C1D95 `oklch(0.3796 0.1783 293.74)` | #D4C6FF `oklch(0.857 0.0795 295.94)` |
| `--console-accent` | #F1ECFE `oklch(0.9522 0.0245 298.61)` | #3A1784 `oklch(0.3364 0.1647 288.7)` |
| `--console-accent-foreground` ★ | #6D28D9 | #D4C6FF |
| `--console-info-foreground` | #18181B | #F4F4F5 |
| `--console-info-icon` | #7C3AED | #F4F4F5 |
| `--console-accent-strong` | #7C3AED | #5B21B6 `oklch(0.432 0.2106 292.76)` |
| `--console-success` | #15803D `oklch(0.5273 0.1371 150.07)` | #4ADE80 `oklch(0.8003 0.1821 151.71)` |
| `--console-success-tint` | #EAF8EF `oklch(0.9662 0.0189 157.88)` | #0F2E1C `oklch(0.2718 0.0501 155.43)` |
| `--console-warning` | #B45309 `oklch(0.5553 0.1455 49)` | #FBBF24 `oklch(0.8369 0.1644 84.43)` |
| `--console-warning-tint` ★ | #FFFBEB `oklch(0.9869 0.0214 95.28)` | #2A2110 `oklch(0.2535 0.0317 82.37)` |
| `--console-danger-tint` ★ | #FEF2F2 `oklch(0.9705 0.0129 17.38)` | #2A1215 `oklch(0.2189 0.0398 12.97)` |
| `--console-danger-solid` | #B91C1C | #DC2626 `oklch(0.5771 0.2152 27.33)` |

### 2.3 Client-only tokens (new)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--brand` | #7C3AED | #7C3AED | violet action fill: the hero CTA, selected time, checked boxes, pips |
| `--brand-hover` | #6D28D9 | #6D28D9 | |
| `--brand-foreground` | #FFFFFF | #FFFFFF | |
| `--subtle-foreground` | #52525B `oklch(0.4419 0.0146 285.79)` | #A1A1AA | secondary text: body copy under headings, footer |
| `--selected` | #F7F3FF `oklch(0.9707 0.0164 301.22)` | #1A1230 `oklch(0.2107 0.0575 293.11)` | a chosen package or add-on |
| `--selected-edge` | #7C3AED | #B9A2FF | its 1px edge |
| `--band` | #0A0A0B | #131315 | "Already booked?" |
| `--band-foreground` | #F4F4F5 | #F4F4F5 | |
| `--band-muted` | #A1A1AA | #A1A1AA | |
| `--band-accent` | #B9A2FF | #B9A2FF | the band's eyebrow |
| `--band-edge` | #3F3F46 | #3F3F46 | the band's outline CTA; the dark band's own edge is `--border` |
| `--dot` | #E4E4E7 | #27272A | hero dot grid, `radial-gradient(var(--dot) 1px, transparent 1px)` at 24px |

Fonts: `--font-sans` and `--font-heading` become `'Geist Variable'`; `--font-mono` becomes `'Geist Mono Variable'` on the client too. Poppins and Open Sans leave the bundle.

### 2.4 Measured contrast

| Pair | Light | Dark | Needs |
|---|---|---|---|
| text on canvas | 17.72 | 18.00 | 4.5 |
| text on surface | 16.97 | 16.88 | 4.5 |
| text on chip | 16.12 | 13.55 | 4.5 |
| text on accent soft | 15.33 | 11.68 | 4.5 |
| text on selected | 16.21 | 16.29 | 4.5 |
| secondary on canvas | 7.73 | 7.72 | 4.5 |
| secondary on surface | 7.41 | 7.24 | 4.5 |
| muted on canvas | 4.83 | 7.72 | 4.5 |
| muted on surface | 4.63 | 7.24 | 4.5 |
| muted on chip | **4.40, not used** (decision 8) | 5.81 | 4.5 |
| muted on selected | — | 6.98 | 4.5 |
| board `#A1A1AA` on white | **2.56, replaced** (decision 8) | — | 4.5 |
| link on canvas | 7.10 | 9.12 | 4.5 |
| link on surface | 6.81 | 8.55 | 4.5 |
| link on accent soft (eyebrow chip) | 6.15 | 8.14 (`#D4C6FF`) | 4.5 |
| link on selected | 6.50 | 8.25 | 4.5 |
| link hover on canvas | 10.95 | 12.55 | 4.5 |
| white on brand | 5.70 | 5.70 | 4.5 |
| white on brand hover | 7.10 | 7.10 | 4.5 |
| brand edge on canvas (selected slot, hero CTA) | 5.70 | 3.47 | 3.0 |
| brand edge on surface | 5.46 | 3.26 | 3.0 |
| primary label on primary | 17.72 | 18.96 | 4.5 |
| primary label on primary hover | 10.44 | 15.60 | 4.5 |
| field edge on canvas | 3.25 | 3.32 | 3.0 |
| field edge on surface | 3.11 | 3.12 | 3.0 |
| field edge on selected (unchecked box in a chosen card) | 2.98 ¹ | 3.01 | 3.0 |
| focus ring on canvas | 5.70 | 9.12 | 3.0 |
| focus ring on chip | 5.18 | 6.86 | 3.0 |
| focus ring on selected | 5.22 | 8.25 | 3.0 |
| selected edge on canvas | 5.70 | 9.12 | 3.0 |
| open-day pip on canvas | 5.70 | 3.47 | 3.0 |
| selected-day pip on its fill | 8.16 (`#B9A2FF` on #18181B) | 5.46 (`#7C3AED` on #FAFAFA, decision 10) | 3.0 |
| success on success tint | 4.58 | 8.44 | 4.5 |
| success on canvas | 5.02 | 11.36 | 4.5 |
| warning on warning tint | 4.84 | 9.51 | 4.5 |
| warning on canvas | 5.02 | — | 4.5 |
| danger on danger tint | 5.91 | 6.35 | 4.5 |
| danger on canvas | 6.47 | 7.15 | 4.5 |
| white on solid danger | 6.47 | 4.83 | 4.5 |
| band text on band | 18.00 | 16.88 | 4.5 |
| band muted on band | 7.72 | 7.24 | 4.5 |
| band eyebrow on band | 9.12 | 8.55 | 4.5 |
| band CTA label on its fill | 18.96 | 18.96 | 4.5 |
| outline-button edge on canvas | 1.48 (exempt: labelled) | 1.89 (exempt) | — |
| hairline on canvas | 1.27 (decorative) | 1.33 (decorative) | — |

¹ Only an add-on card that is selected *and* whose box is unticked could show it, and that cannot happen: a selected add-on card is a ticked one, whose box is filled violet (5.22:1). An unticked box always sits on the canvas (3.25:1).

## 3. Type

Geist everywhere on the client; Geist Mono for labels and data.

| Role | Size / weight / tracking |
|---|---|
| Hero `h1` | 56px / 600 / -0.035em, line-height 1.05 (40px below `md`, 34px below `sm`) |
| Section `h2` | 44px / 600 / -0.03em, line-height 1.1 (32px below `md`) |
| Band `h2` | 40px (30px below `md`) |
| Page `h1` (every other page) | 36px from `md`, 30px below / 600 / -0.02em, line-height 1.15 |
| Status-view `h1` (notices, payment outcomes) | 30px / 600 / -0.02em |
| In-page `h2` (summary, "Your email", cancel) | 20px / 500 |
| Card / step `h3` | 20-22px / 500 |
| Body | 16px, secondary colour under a heading; lead 17-18px |
| Nav links | 15px; "Admin login" 14px muted |
| Labels | 14px / 500 above fields; hints and errors 13px |
| Eyebrow | **Geist Mono** 12px / 500 / uppercase / 0.1em, muted, with a 14px icon |
| Data | **Geist Mono**, `tabular-nums`: prices, times, references, the countdown, step numerals `01`-`04`, calendar day numbers, weekday heads |

A mono data value interpolated inside one translated sentence stays in Geist (as the admin's §9 records): splitting a translated sentence to style part of it risks the translation.

## 4. Shape, space, icons, focus

- **Container:** `max-w-6xl` (1152px) centred, gutter 16px on phones, 32px at `md`, 48px at `lg` (`client-container` utility: `mx-auto w-full max-w-6xl px-4 md:px-8 lg:px-12`). The board's 120px gutter at 1440px is this container.
- **Section rhythm:** 104px vertical padding from `lg`, 64px at `md`, 48px on phones (`py-12 md:py-16 lg:py-26`).
- **Radius:** 2px everywhere (`--radius`). Round only for status dots, pips and the round step/confirm icons.
- **Borders:** 1px. Hairline for structure; `--input` for field edges; `--console-border-strong` for outline buttons. No shadows, anywhere on the client (the card `shadow-sm` of the old system goes).
- **Icons:** lucide, `stroke-width: 1.5`, `stroke-linecap: square`, set once for `svg.lucide` in the client scope. They inherit colour. Every section eyebrow, fact row and metadata tile has one.
- **Focus:** one 2px `--ring` outline, offset 2px, on every interactive element, in both themes: the admin's unlayered `:focus-visible:not([tabindex="-1"])` rule re-scoped to `:root[data-theme]`, which also zeroes the shadcn 50% ring. Fields also take a `--ring` edge on focus. Where the focused element is a visually hidden radio or checkbox, the card that labels it draws the outline (`has-focus-visible:`).
- **Touch:** every control is 44px on a coarse pointer; standalone links are `pointer-coarse:min-h-11`.

## 5. Components

### 5.1 Buttons (`button.tsx`, client defaults through the `client:` variant)

- **Default** = inverted neutral (`--primary`), hover `--primary-hover`. **`brand`** (new variant) = the violet hero action, hover `--brand-hover`, white label. **Outline** = `--console-border-strong` edge, transparent, hover `bg-muted`. **Ghost**, **destructive** (tint + red text), **destructive-solid** (dark: `--console-danger-solid`, decision 9), **link** (violet text).
- **Heights on the client:** 44px default, 52px `lg`, 40px `sm` on a mouse; never under 44px on a coarse pointer. `px-5`, 15px / 500, `gap-2`.
- **Motion:** `motion-safe:hover:-translate-y-px`, colour transitions 150ms. No press nudge.
- The console sizes and variants are untouched.

### 5.2 Badges and status

- Badges are rectangles, 2px radius, 13-14px / 500.
- **Status** on the client uses the console mapping (`admin-console.md` §5: four shapes, filled check / outlined check / clock / cross; dashed and dotted edges for a hold and a lapsed hold; the word always shown). `BookingPage` provides the console variant through `StatusBadgeVariantContext`, so its pill and the `StageLegend` popover both switch without `StageLegend` changing.

### 5.3 Callout

The console banner on the client: full width, 2px radius, `px-4 py-3.5`, 18px icon, optional trailing underlined link. Tones: `info` (accent soft), `success`, `warning`, `destructive`. The client pages switch to `variant="console"`; the old default rendering stays in the file for anything that still asks for it.

### 5.4 Fields

Label above (14px / 500); input 48px from `md` and 44px below (and on touch), square, 1px `--input` edge, transparent fill, 16px text; on focus a `--ring` edge plus the outline. Hint 13px muted; error 13px danger with a `CircleAlert` 14px icon. Textareas match. Checkbox: a 20px square with a 1.5px `--input` edge that fills `--brand` with a white tick when checked.

### 5.5 Selectable card (packages, add-ons, the payment method)

- Resting: hairline edge, canvas fill. Hover: `#A1A1AA`-strength edge (`--muted-foreground`) and a 2px lift (`motion-safe`).
- **Checked:** `--selected-edge` edge and `--selected` fill; a 24px `--brand` square with a white check scales in (`tick`), and the card plays one `pop`. The word, the native radio or checkbox state and the tick carry the meaning; the fill only repeats it.
- The native input is visually hidden; its focus draws the outline on the card.
- Package: name 18px / 500, meta line (photos · duration) secondary, price mono on the right, optional description. Add-on: the 20px box, name, mono price.

### 5.6 Skeleton, back link, skip link

- **Skeleton:** chip-coloured blocks, 2px radius, a colour-only pulse (off under reduced motion). Shapes match the thing they stand for.
- **Back link:** a quiet 14px secondary link with a leading `ArrowLeft`, violet on hover, 44px on touch.
- **Skip link:** a rectangle at the top left on the canvas, text colour, with the violet outline when focused.

### 5.7 Metadata tiles (client `FactGrid`, `pages/client/`)

The admin's `StatGrid` look, re-implemented for the client (never imported from `pages/admin/`): two columns from `sm`, a 64px icon tile (48px below `sm`) on the chip colour with a 20px icon, then a mono label above the value (mono 15px for data, Geist 16px for words). Status tiles take the status tint and icon.

### 5.8 Contact details

`frontend/src/lib/contact.ts` exports `PHOTOGRAPHER_CONTACT: { name, phone, whatsapp, email }`; it ships with placeholder values (decision 13). The footer's contact block and the summary's "Questions?" line render only the fields that are set (phone `tel:`, WhatsApp `https://wa.me/<digits>`, email `mailto:`), with labels from new `en.json` keys and never a value in `en.json`. With every field `null`, neither renders at all.

## 6. Motion

Durations and easings from the boards. Everything below sits behind `prefers-reduced-motion: no-preference`; under `reduce` nothing moves and only colour changes remain.

| Kept | Where | Spec |
|---|---|---|
| `fade-up` | Home hero on load (eyebrow, `h1`, lead, chips, CTA, facts, mock-up); a page head on load | 600ms `cubic-bezier(.2,.7,.2,1)`, from 16px below and transparent, `both`; stagger 80ms (`d1`-`d4`) |
| lift | service cards (-6px), package and add-on cards (-2px), buttons (-1px) | 250ms / 200ms / 150ms, `cubic-bezier(.2,.7,.2,1)` |
| arrow nudge | the "Book" arrow on a card, the "Browse services" arrow | 5px right, 250ms |
| `pop` | a package, a day or a time when chosen | 300ms ease, scale 1 → 1.04 → 1 |
| `tick` | the check square of a chosen card | 250ms `cubic-bezier(.2,.7,.2,1.4)`, scale .4 → 1 and fade in |
| `rise` | time slots when a day is chosen | 350ms ease, from 8px below, 50ms per slot |
| `draw` | the confirmed check, once | 600ms ease-out, 350ms delay |
| spinner | the waiting payment | `animate-spin` 1s linear, the **only** `infinite` animation; a still `Clock` under reduced motion |

**Dropped** (no loops, no shake): the marquee, floating hero cards, the pinging selected day, the blinking "live" dot, the shutter and flash, the draining bar, the phone "buzz", the payment "wave" rings, the sliding toast, the step bar, and the error shake.

## 7. Shell (`pages/ClientShell.tsx`)

Structure holds (`pages/client-shell.md`): skip link first; `header`, `div#main-content` and `footer` are siblings, no wrapping `main`; static header; no drawer; the wordmark is a link, never an `h1`; no `dl`, button-free footer, no radios anywhere.

- **Header:** 72px (64px below `md`), bottom hairline, canvas. Left: a 28px inverted square with a `Camera` mark (`aria-hidden`) and the wordmark (20px / 600 / -0.02em), linking to `/`. From `md`, 15px links: **Services** (`services:title`) → `/services`, **How booking works** (`landing:how.title`) → `/#how`. Right cluster: **My booking** (`CalendarDays` icon, stored-token logic kept), **Admin login** (14px muted, from `sm`), the **theme button**, **Book now** (inverted neutral, 44px, trailing arrow).
- **Phones (375px):** the wordmark, My booking, the theme button and Book now must fit in 343px. Below `sm` "My booking" shows its icon only, its words kept as the accessible name (`sr-only`), a 44px square. Measured in §10.
- **`/#how`:** Home scrolls to `#how` and focuses its heading when the hash is present (and when it changes), with no smooth scrolling (so reduced motion is honoured by default).
- **Footer:** top hairline, canvas, three columns from `md`, stacked on phones. (1) the wordmark, `shell:footer.note`, and the contact block (§5.8). (2) **BOOK** (mono label): Browse services (`shell:footer.services`), My booking. (3) **ABOUT**: Home (`shell:footer.home`), and "Admin login" below `sm` only. **No Privacy notice link**: no privacy page exists (`specs_v2.md` lists it as specified, not built). Links 15px secondary, violet on hover, 44px on touch.

## 8. Pages

### 8.1 Home (`pages/Home.tsx`)

Order: hero → services → How booking works → Good to know → Already booked? → footer. The old closing section merges into the band.

- **Hero** on the dot grid, `client-container`, two columns from `lg` (text | mock-up), stacked below with the mock-up after the text, hidden below `sm`.
  - Eyebrow chip (accent soft, link-coloured mono): `MapPin` + "Photographer · Kigali, Rwanda" (new key).
  - `h1` `landing:hero.title`; lead `landing:hero.body` (18px secondary).
  - "What do you need?" (mono label, new key) and one chip per real service from Home's `fetchServices`: a link to `/services/:slug`, hairline rectangle that hovers to a violet edge. Skeleton chips while loading; no chips on failure.
  - The **brand** CTA `landing:hero.cta` → `/services`, `size="lg"`, with a `CalendarDays` icon.
  - Two fact lines with success-coloured `Check` icons: "Only free times are shown", "Pay with MTN MoMo" (new keys), then `landing:hero.aside` (14px muted).
  - **Mock-up** (`aria-hidden`, pure HTML/CSS): an accent-soft backdrop square; a bordered month card with the **current** Kigali month and "KIGALI TIME", weekday initials, the current month's first 14 days from Monday, a few open (pip), today selected (inverted), and three mono time chips with the middle one violet; overlapping it, a small "held" card: the first real service's name (else a generic label, new key), today's date and 10:00 through the existing format helpers, and "Your date is held" (new key). One `fade-up`, nothing loops.
- **Services** (`#services`): eyebrow "01 — Services", `h2` `landing:preview.title`, and "Browse services →" (`landing:preview.more`) right-aligned from `md`; three columns from `lg` of `ServiceCard`; skeletons and the quiet failure kept.
- **How booking works** (`#how`): full-bleed surface band with hairlines above and below; eyebrow "02 — How booking works"; centred `h2` `landing:how.title` with `tabIndex={-1}`; an `ol` in one bordered strip on the canvas, four columns from `lg`, two at `md`, one on phones: a mono numeral `01`-`04` in a 48px bordered square (violet edge and numeral on hover), `h3` and body from `landing:how.step1..4`.
- **Good to know:** eyebrow "03 — Good to know", `h2` `landing:trust.title`; the four `landing:trust.*` items as fact rows in a 2×2 hairline grid from `md`: a 52px chip-coloured icon tile (brand fill, white icon on hover), 20px `h3`, body. The non-refundable rule is a full row like the others, never muted further.
- **Already booked?** Inside the container, the inverted band (§2.3): eyebrow "Already booked?", `h2` (new key, "Find your booking any time."), one line (new key) on the fresh link; then `landing:closing.title` as a secondary line (the merged closing section). Two 52px CTAs: outline "Find my booking" (new key) → `/my-booking`, and the band CTA `landing:closing.cta` → `/services`. Decorative concentric rings, static.

### 8.2 Services list (`services/ServiceList.tsx`)

Page head: eyebrow, `h1` `services:title`, `services:intro`. Grid 1/2/3 columns, `gap-6`. **ServiceCard** (props kept, one stretched link, one tab stop): hairline, square, no shadow; the image at 4:3 (`object-cover`, lazy except the first), or a chip-coloured block with a 32px `Camera` icon; then `h3` 22px / 500 (the link), description (secondary, 2-line clamp), and a hairline row: "From **price**" with the price mono, and "Book →" (new key) in the link colour. Hover and keyboard focus: -6px lift, violet edge, the arrow nudges 5px; reduced motion keeps the edge only. Skeletons match the card. Failure and empty use the console callout and the existing retry.

### 8.3 Service page, one-page funnel

Main column plus a sticky ~360px summary column from `lg` (`lg:sticky lg:top-6`, inside the page); below `lg` the summary comes last.

- **Back link** "All services" first in `main` (keyboard spec).
- **Head:** the cover image if any (21:9, no radius beyond 2px), `h1` (36px), description (secondary), and a mono eyebrow line with a `Clock` icon, "All times are Kigali time (UTC+2)." is **not** reused here: `slot-picker.spec.ts` reads that sentence inside the picker, and a second copy outside it would make page-wide lookups ambiguous. The head line uses a new key "All times in Kigali time".
- **Step labels:** `step-number.ts` draws the counter as the board's mono label, "1 · ", in front of the existing legend and heading text, muted 12px, and the heading keeps its words at 20px / 500.
- **Packages** and **add-ons:** §5.5, one column below `sm`, two from `sm`.
- **Month grid:** a bordered panel; the month name 16px / 500 between two 44px square outline icon buttons (existing names); weekday heads mono 12px muted uppercase; day cells 44px: **open** = hairline edge (field edge on hover), text colour, 500, a 4px brand pip under the number; **unavailable** = faint number, no edge, disabled; **selected** = inverted neutral with the pip (decision 10) and a `pop`; **today** = the number underlined (2px, `--ring` colour, offset 3px), in addition to its open or unavailable look. A legend row under the grid, "Has open times" / "Selected" (new keys, `aria-hidden` swatches, the words visible).
- **Times:** a list of 52px rows, two columns from `sm`, the mono 16px time on the left (the button's whole text, as now). Hover: violet edge and violet text. **Selected:** brand fill, white text, `pop`. Staggered `rise` when a day is chosen.
- **Messages:** "Checking…" plain muted status with a spinner-free `Clock`; "just taken" and "check failed" are the warning / destructive console callouts (still `role="alert"`, still focused); the "Selected: …" line is the success callout (`role="status"`).
- **Details form:** §5.4. Name full width; email | phone and location | people side by side from `md`; special requests full width; consent as the add-on box.
- **Summary** (`PriceSummary`): surface fill, hairline edge, `p-5`: the mono label (the existing heading, restyled), the service and package, then rows with mono amounts right-aligned; a hairline, **Total** (500, mono 20px), the booking-fee row (500), the session-fee row (secondary); the refund note 13px secondary; the Confirm button (inverted, full width, 48px) exactly when it appears now; a "Questions?" line only when contact details exist. The `dl > div > dt + dd` markup is kept exactly, restyled with CSS only.

### 8.4 Held → checkout → payment progress

- **Held:** a success band with the reference in mono, underlined; the "Pay the booking fee" block with the fee in mono and the inverted Pay button. A **HELD UNTIL** stat (new key `services:booking.held.heldUntil`) with the hold's end time in mono 28-32px (decision 16), beside the reference.
- **Checkout:** `BookingFacts` as metadata rows (CSS only: mono uppercase `dt`, values beside them, `dl`/`dt`/`dd` and the row set unchanged). The method is the single radio as a selected card with a text chip ("MTN"-style chips are not drawn: a text chip with the method's existing name is enough). The phone field, the inverted full-width Pay, and the "hold ends by itself" note.
- **Progress:** waiting = a 64px icon tile with the functional spinner (a still `Clock` under reduced motion) and the existing live text; confirmed = a success tile with a check drawn once, the `h1`, the reference in mono, and the existing links as an inverted / outline pair; failed and expired use the danger and muted callouts. Existing strings throughout.

### 8.5 Booking page and friends

- **BookingPage:** a page header with a mono eyebrow ("My booking"), the `h1` "Your booking" (decision 15), and the status badge (console mapping) beside it with `StageLegend`; facts as a `FactGrid`; money rows in mono; inverted primary, outline secondary, destructive kept red, the two-step cancel kept; notes and notices as console callouts; the delivery link as a success panel with an inverted "Open your photos".
- **MyBookingPage / EmailConfirmPage:** a narrow centred panel (`max-w-md`, hairline, `p-8`, `p-6` below `sm`): eyebrow, `h1`, one 48px field, an inverted submit; outcomes as success / danger callouts.
- **NotFound:** a large mono "404" eyebrow (new key), the `h1`, the body, and an inverted "Home" (`shell:footer.home`) / outline "Browse services" (`shell:footer.services`) pair of links. No button in `main`, and nothing named "All services".

## 9. Overrides recorded in the page files (2026-09-27)

| File | What this redesign overrides |
|---|---|
| `MASTER.md` | The client is no longer sky / green / Poppins / Open Sans / 8px radius / `shadow-sm` / light only: it takes this file's tokens, type, radius, flat elevation and both themes. |
| `client-shell.md` | `bg-card` 64px bar → 72px canvas bar with a mark; adds Services, How booking works and the theme button; "My booking" is an icon below `sm`; the footer becomes three columns with a contact block. "No sticky anything", siblings, skip link, no radios, no `dl`, button-free footer all hold. |
| `home.md` | Adds the hero mock-up and service chips, section eyebrows, "Already booked?" (merging the closing band), the brand CTA; "no illustration" is lifted for the decorative, data-true mock-up only; entrance fade-ups allowed on the hero. |
| `services.md` | The card: 4:3 image or icon block, 22px `h3`, "From" mono and "Book →" row, a -6px lift (the old "no translate lift" rule is lifted, reduced motion excepted). |
| `service-detail.md` | Board components: selectable cards with tick and pop, the month grid with pips and a today mark (the old "no today marker" rule is lifted: it is a derived date, no new logic), 52px time rows, callout messages, 48px fields in a two-column layout from `md`, the console-look summary. |
| `booking.md` | Page header with the console status badge, facts as metadata tiles, console callouts. |
| `checkout.md` | Metadata rows, the method card with a text chip, the icon-tile status views, the one-time check draw on confirmed (the old "no animated checkmarks" rule is lifted for that single draw). |
| `my-booking.md`, `email-confirm.md` | The narrow centred panel; outcomes as console callouts. |
| `not-found.md` | A mono "404" eyebrow (new key) and a Home / Browse services pair replace the icon and the "All services" link. |

## 10. Verification record

Filled in as the work ships.

- **Checkpoint (Phase 2, 2026-09-27):** admin 32/32 screenshots (8 routes × light, dark × 375, 1280) pixel-identical to the pre-change baseline. Home at 375px touch: no horizontal scroll; every header control 44px (wordmark link 44px tall, My booking 44×44, theme 44×44, Book now 44px tall). e2e 38/38, unchanged.

- **Final (2026-09-27):** typecheck and lint clean; unit tests 1,413 pass (three full runs in a row); e2e 38/38 with no e2e file changed. Admin 32/32 screenshots pixel-identical to the pre-change baseline after every foundation step and at the end. Every client route at 375px touch (dark): no horizontal scroll; the only boxes under 44px are the service cards' title links, which are stretched over the whole card. With `prefers-reduced-motion: reduce` nothing animates on any route; without it the only `infinite` animation is the payment-progress spinner. Theme: the OS default applies, a live OS switch updates the page, an override survives a reload and beats the OS, blocked storage still renders and still switches for the visit, the client and admin preferences are independent, and crossing client → admin → client leaves no stray attribute.
- **`dark:` audit:** the variant now matches only `[data-theme=dark]`. What it switches on: the button, input, textarea, checkbox and badge dark classes (rewritten to the client tokens where they read wrong), and the Tabs dark classes (no client page uses Tabs). The admin never sets `data-theme`, so none of it reaches an admin page (confirmed by the pixel diff).
- **Finish review (2026-09-27):** a hold is not a confirmed booking, so the held band takes the accent tint as on the board (the brief's "success band" wording is overridden by the status-honesty rule); "check your inbox" on My booking, a refund owed and a pending email change are `info`, never success; `Card` is 2px on the client.
- **Deferred / open:** the placeholder contact details must be replaced before launch (`lib/contact.ts`); no Privacy link until a privacy page exists; the confirmed payment view has no "View my booking" / "Back to home" pair because no such links exist there today (the brief allows them only where they already exist); the email-confirmation eyebrow reuses "Your email" for want of a purpose-built string.
