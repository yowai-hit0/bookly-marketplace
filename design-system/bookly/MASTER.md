# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/bookly/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Bookly
**Generated:** 2026-09-19 15:12:03
**Category:** Booking & Appointment App

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#0284C7` | `--color-primary` |
| On Primary | `#000000` | `--color-on-primary` |
| Secondary | `#0EA5E9` | `--color-secondary` |
| On Secondary | `#000000` | `--color-on-secondary` |
| Accent/CTA | `#059669` | `--color-accent` |
| On Accent/CTA | `#000000` | `--color-on-accent` |
| Background | `#F0F9FF` | `--color-background` |
| Foreground | `#0F172A` | `--color-foreground` |
| Card | `#FFFFFF` | `--color-card` |
| Card Foreground | `#0F172A` | `--color-card-foreground` |
| Muted | `#EFF7FB` | `--color-muted` |
| Muted Foreground | `#475569` | `--color-muted-foreground` |
| Border | `#E0F0F8` | `--color-border` |
| Destructive | `#DC2626` | `--color-destructive` |
| On Destructive | `#FFFFFF` | `--color-on-destructive` |
| Ring | `#0284C7` | `--color-ring` |

**Color Notes:** Calendar blue + available green

### Typography

- **Heading Font:** Poppins
- **Body Font:** Open Sans
- **Mood:** modern, professional, clean, corporate, friendly, approachable
- **Google Fonts:** [Poppins + Open Sans](https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;500;600;700&family=Poppins:wght@400;500;600;700&display=swap)

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;500;600;700&family=Poppins:wght@400;500;600;700&display=swap');
```

### Spacing Variables

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` / `0.25rem` | Tight gaps |
| `--space-sm` | `8px` / `0.5rem` | Icon gaps, inline spacing |
| `--space-md` | `16px` / `1rem` | Standard padding |
| `--space-lg` | `24px` / `1.5rem` | Section padding |
| `--space-xl` | `32px` / `2rem` | Large gaps |
| `--space-2xl` | `48px` / `3rem` | Section margins |
| `--space-3xl` | `64px` / `4rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: var(--color-accent);
  color: var(--color-on-accent);
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: var(--color-primary);
  border: 2px solid var(--color-primary);
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: var(--color-card);
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow-md);
}

/* Only cards that are links/buttons (the service card on /services) get pointer + hover. */
.card--interactive {
  transition: box-shadow 200ms ease;
  cursor: pointer;
}

.card--interactive:hover {
  box-shadow: var(--shadow-lg);
}
```

### Inputs

```css
.input {
  padding: 12px 16px;
  border: 1px solid var(--color-input);
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: #0284C7;
  outline: none;
  box-shadow: 0 0 0 3px #0284C720;
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Soft UI Evolution

**Keywords:** Evolved soft UI, better contrast, modern aesthetics, subtle depth, accessibility-focused, improved shadows, hybrid

**Best For:** Modern enterprise apps, SaaS platforms, health/wellness, modern business tools, professional, hybrid

**Key Effects:** Improved shadows (softer than flat, clearer than neumorphism), modern (200-300ms), focus visible, measured contrast targets

### Page Pattern

**Pattern Name:** Funnel (3-Step Conversion)

- **Conversion Strategy:** Progressive disclosure. Show only essential info per step. Use progress indicators. Multiple CTAs.
- **CTA Placement:** Each step: mini-CTA. Final: main CTA
- **Section Order:** Hero > Step 1 (problem) > Step 2 (solution) > Step 3 (action) > CTA progression

> **Hand-review note:** this pattern is a landing-page recipe and is **not applied literally**. Bookly has no landing page. See addendum section 8 for the patterns the app really uses.

---

## Anti-Patterns (Do NOT Use)

- ❌ Complex shadows
- ❌ 3D effects

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile

---

## Hand-review addendum (Phase 2a)

> Written by hand on 2026-09-19 from the shipped code and measured contrast, after reviewing the generator output. **Where this addendum and the generated text above disagree, this addendum wins.** A file in `pages/` wins over both, for its own page.
> **Status: Phase 2b is applied (commit `3ce6cd3`) with the recommended option for decisions 1-3. Decisions 4-11 in section 9 were answered on 2026-09-20. Section 10 records what 2b did. Section 11 records what each Phase 3 section applied.**

### 1. Corrections made in place to the generated text

| Where | Generated | Now | Why |
|-------|-----------|-----|-----|
| Header "LOGIC" line | `design-system/pages/[page-name].md` | `design-system/bookly/pages/[page-name].md` | The real path includes the project slug. The same wrong path was in every generated page file. |
| `.btn-primary` | `background: #059669; color: white` | `var(--color-accent)` / `var(--color-on-accent)` | White on `#059669` is 3.77:1, failing this file's own 4.5:1 rule. The palette table says the on-accent colour is black. |
| `.btn-secondary` | hard-coded `#0284C7` | `var(--color-primary)` | Tokens, not raw hex (this file's own rule). Blue text on white is only 4.10:1, see section 3. |
| `.card` | `background: #F0F9FF` (the page background), pointer, lift on every card | `var(--color-card)`; pointer and lift only on `.card--interactive` | The palette says Card is `#FFFFFF`; a card the colour of the page is invisible. Only the service card on `/services` is clickable. |
| `.input` | `border: 1px solid #E2E8F0` | `var(--color-input)` | 1.23:1 against white. A control's boundary needs 3:1 (WCAG 1.4.11). |
| Page Pattern | "Funnel (3-Step Conversion)": Hero > Step 1 (problem) > ... | kept, with a note | It is a landing-page recipe. See section 8. |

The generated page files were also wrong and are replaced: 1200px widths that match no page, "Landing / Marketing" for Home, "WebGL/Three.js 3D, physics lighting, parallax" for the booking funnel, and "add padding-top for the nav" for a page with no nav.

### 2. Constraints that override the generator

- **No new user-visible strings.** `frontend/src/i18n/locales/en.json` is protected. Restyle existing text; decoration must be non-textual (icons with `aria-hidden`, CSS counters, borders, fills, dots). **Exception (user decision, 2026-09-20, section 9 item 10): new keys may be added, additive only, when a change truly needs them (the skip-to-content link, later contact details). Existing strings are never edited.**
- **Behaviour is fixed.** Keep DOM order, `role` / `aria-*`, focus management (headings with `tabIndex=-1` that receive focus), `aria-disabled` instead of `disabled` during requests (15 places in four files), `noValidate` forms and list `key`s.
- **Light theme only.** `.dark` is unreachable (nothing adds the class). No dark palette was generated. Leave the `.dark` block untouched in Phase 2b unless the user asks for dark mode; it will stay grayscale.
- **No modals** on the client side (the app uses inline confirmation and one `window.confirm`). **Changed 2026-09-27 (admin console fixes, item 1, user decision):** the admin's create and edit forms open in dialogs (`admin-console.md` §6.11). Otherwise **no 3D, parallax or scroll-driven effects.** Motion is 150-300ms state transitions only, behind `motion-safe` / `prefers-reduced-motion`.
- **Avoid what Impeccable's detector flags** (from `.claude/skills/impeccable/reference/hooks.md`): gradient text, glow shadows, one-sided accent borders ("side-tab"), clipped or overflowing content, contrast failures.
- **Widths stay as shipped** per page (`max-w-md` / `sm` / `2xl` / `3xl` / `5xl` / `6xl` / `7xl`). Ignore the generator's 1200px.
- **Icons: lucide only** (already a dependency). No emoji.
- **Protected files** (see `docs/redisign.md`): never touched by any design step.

### 3. Contrast audit of the generated palette (WCAG 2.x, computed)

| Pair | Ratio | Result |
|------|-------|--------|
| foreground `#0F172A` on background `#F0F9FF` / card `#FFFFFF` | 16.75 / 17.85 | pass |
| muted-foreground `#475569` on background / card / muted | 7.11 / 7.58 / 6.99 | pass |
| black on Primary `#0284C7` | 5.13 | pass |
| **white** on Primary `#0284C7` | 4.10 | **fail** |
| black on Accent/CTA `#059669` | 5.57 | pass |
| **white** on Accent/CTA `#059669` (the generated `.btn-primary`) | 3.77 | **fail** |
| white on Destructive `#DC2626` (solid) | 4.83 | pass |
| Destructive text on page background | 4.53 | pass, barely |
| **Destructive text on its own 10% tint** (the tinted Button / Badge variants) over card / page | 4.13 / 3.89 | **fail** |
| **`#0284C7` as text on white** (links) | 4.10 | **fail** |
| **`#059669` as text** on white / page | 3.77 / 3.53 | **fail** |
| **Default Button hover** (`bg-primary/80`) with a white label, on `#059669` / on `#047857` | 2.86 / 3.75 | **fail** |
| Ring `#0284C7` against the page (needs 3:1) | 3.84 | pass |
| **Generated `border` `#E0F0F8`** against white / page (needs 3:1 only for control edges) | 1.17 / 1.10 | fail for controls; acceptable for decorative dividers |
| **Generated `muted` `#EFF7FB`** against the page background | 1.02 | **not perceivable** |

Consequences: the app uses `text-primary` for links, `bg-muted` for the waiting banner, status pill, ghost and outline hover, table-row hover and the FullCalendar neutral background, the tinted destructive variant for the cancel actions, and destructive-coloured text for refund-due amounts. All of those are affected.

### 4. Proposed shadcn token mapping (input to Phase 2b)

**The trap.** The generator's role names do not match shadcn's. In shadcn, `--accent` is the **hover / highlight surface** (ghost and outline hover, menu items); `--primary` is the **default button, selected state, checked native controls (`accent-primary`), `text-primary` links, the FullCalendar active button and today tint**. Mapping "Accent/CTA" to `--accent` mechanically would turn every hover surface green. The CTA colour belongs on `--primary`.

Values are the MASTER hex converted to oklch to four decimals; each was checked to convert back to its hex with zero error, and they are the numbers in `frontend/src/index.css`. Lightness and hue match Tailwind v4's published sky, emerald, slate and red values; chroma is lower because Tailwind defines those colours slightly outside the sRGB gamut. Achromatic colours use hue 0.

| Token | Hex | oklch | Source and note |
|-------|-----|-------|-----------------|
| `--background` | `#F0F9FF` | `oklch(0.9771 0.0125 236.62)` | MASTER Background |
| `--foreground` | `#0F172A` | `oklch(0.2077 0.0398 265.75)` | MASTER Foreground |
| `--card`, `--popover` | `#FFFFFF` | `oklch(1 0 0)` | MASTER Card |
| `--card-foreground`, `--popover-foreground` | `#0F172A` | same as foreground | |
| `--primary` | `#047857` | `oklch(0.5081 0.1049 165.61)` | MASTER Accent/CTA `#059669`, one Tailwind step darker (D1, D2) |
| `--primary-foreground` | `#FFFFFF` | `oklch(1 0 0)` | 5.48:1 on `#047857` |
| `--secondary` | `#0EA5E9` | `oklch(0.6847 0.1479 237.32)` | MASTER Secondary, literal. **Unused today**: no page uses a `secondary` Button or Badge. |
| `--secondary-foreground` | `#000000` | `oklch(0 0 0)` | 7.58:1 |
| `--muted` | `#E0F2FE` | `oklch(0.9514 0.0250 236.82)` | D3 |
| `--muted-foreground` | `#475569` | `oklch(0.4455 0.0374 257.28)` | MASTER |
| `--accent` | = `--muted` | | shadcn hover surface, **not** the CTA colour |
| `--accent-foreground` | = `--foreground` | | |
| `--destructive` | `#B91C1C` | `oklch(0.5054 0.1905 27.52)` | D4 |
| `--border` | `#E0F0F8` | `oklch(0.9456 0.0201 229.04)` | MASTER Border, literal. Decorative dividers and card edges only. |
| `--input` | `#7A8BA0` | `oklch(0.6305 0.0374 253.82)` | D5 |
| `--ring` | `#0284C7` | `oklch(0.5876 0.1389 241.97)` | MASTER Primary (brand blue) |
| `--radius` | `0.5rem` | | was `0.625rem`. Gives 8px buttons and inputs and about 11px cards, matching MASTER's component specs (8px / 12px). |
| `--chart-*` | leave | | no chart exists in the app |
| `--sidebar` | `#FFFFFF` | `oklch(1 0 0)` | admin sidebar surface = card white (`pages/admin-shell.md`) |
| `--sidebar-foreground` | `#0F172A` | same as foreground | |
| `--sidebar-primary`, `--sidebar-primary-foreground` | `#047857`, `#FFFFFF` | same as `--primary` | the plain-markup sidebar does not use these; keep them coherent |
| `--sidebar-accent`, `--sidebar-accent-foreground` | = `--muted`, = `--foreground` | | hover surface for nav items |
| `--sidebar-border` | = `--border` | | |
| `--sidebar-ring` | = `--ring` | | |

**Deviations from the generated hex** (each has a measured reason; reverting any one is a one-line change):

- **D1.** `--primary` is the CTA green, not the brand blue. MASTER's own `.btn-primary` and its palette label ("Accent/CTA") both make the CTA green. The brand blue (`#0284C7`) then appears as the focus ring, the "info / waiting" tone, calendar event edges and decorative accents. For any blue **text**, use `#0369A1` (5.93:1 on white). See section 9.
- **D2.** `--primary` `#059669` -> `#047857`. White label 3.77 -> 5.48; link text on white 3.77 -> 5.48; badge text on its tint 3.33 -> 4.78. This is the only change that lets a conventional white button label and `text-primary` links pass AA.
- **D3.** `--muted` `#EFF7FB` -> `#E0F2FE`. Against the page background 1.02:1 -> 1.08:1, so banners, pills and hover rows become visible. Text on it still passes (foreground 15.56, muted-foreground 6.60).
- **D4.** `--destructive` `#DC2626` -> `#B91C1C`. Tinted Button / Badge text 4.13 / 3.89 -> 5.45 / 5.13; solid fill with white text 4.83 -> 6.47. The cancel actions and the refund-due amounts depend on this.
- **D5.** `--input` is a new value: `#7A8BA0`, 3.48:1 against white and 3.27:1 against the page. The generated palette has no input token, and its `.input` border was 1.23:1.

### 5. Fonts

Heading **Poppins**, body **Open Sans** (as generated).

- **Today:** `index.css` line 4 is `@import "@fontsource-variable/geist"` (npm package, self-hosted through Vite). `@theme inline` already defines `--font-heading: var(--font-sans)` and `--font-sans: 'Geist Variable', sans-serif`; `card.tsx` `CardTitle` already uses `font-heading`.
- **Proposed `@theme inline`:** `--font-sans: 'Open Sans Variable', sans-serif` and `--font-heading: 'Poppins', sans-serif` (Google Fonts names would be `'Open Sans'` / `'Poppins'`).
- **Apply headings once:** add `h1, h2, h3 { font-family: var(--font-heading); }` to the existing `@layer base` block, so pages do not need `font-heading` on every heading. Existing structure, no new mechanism.
- **Delivery (needs a decision, section 9):** the generator's `@import url('https://fonts.googleapis.com/...')` is a third-party request on first load, unlike today's self-hosting. Self-hosting the new pair (`@fontsource/poppins`, `@fontsource-variable/open-sans`) needs new dependencies, which changes `package.json` and the lockfile; the guardrails say those are reviewed separately, never inside a visual commit.
- **Weights:** the generator requests Open Sans 300-700 and Poppins 400-700. Request only what the app uses (400, 500, 600; search for `font-bold` before deciding on 700).
- **Checked (2026-09-20, with the Impeccable detector):** Poppins and Open Sans are not flagged by its `overused-font` rule. That rule's list names Inter, Roboto, Fraunces, Geist, Plus Jakarta Sans and Space Grotesk, so moving off Geist also removed a flagged font. A fixture using only Poppins and Open Sans, and `frontend/src/index.css`, both scan clean.

### 6. Notes for `components/ui` (Phase 2b scope)

- **`button.tsx`**
  - Default hover is `hover:bg-primary/80`, which lightens the fill and drops the white-label contrast to 3.75:1. Make hover **darken** (the `secondary` variant already uses a `color-mix` pattern).
  - Pages use `aria-disabled` (not `disabled`) during requests, but the variants only style `disabled:`. Buttons look fully active while busy. Add `aria-disabled:opacity-50 aria-disabled:cursor-not-allowed` (do not add `pointer-events-none`; the handlers already ignore repeat presses).
  - Sizes are `h-8` (32px), `sm` `h-7`, `lg` `h-9`: below 44px for touch. Add `pointer-coarse:` heights (Tailwind v4) so desktop keeps its density and phones get 44px.
  - The `destructive` variant is tinted. Fine with D4 for the opener. **Irreversible confirmations** (cancel booking, in `BookingPage` and `AdminBookingDetail`) should be solid destructive via a `className` override at those two call sites rather than a new variant.
- **`input.tsx`, `textarea.tsx`:** text is already 16px on mobile (`text-base md:text-sm`). Height is `h-8`: add `pointer-coarse:h-11`. The field is `bg-transparent`, so on the tinted page it shows the page tint: give fields a `bg-card` fill so they read as fields. The border already uses `--input`, so D5 applies automatically.
- **`card.tsx`:** the primitive draws its edge with `ring-1 ring-foreground/10`; the hand-rolled cards on client pages and booking detail use `border`. **Two card looks.** Pick one edge treatment in 2b and make the hand-rolled cards match it in Phase 3. Surface `bg-card`, `rounded-xl`, `p-4`, at most `shadow-sm`.
- **`badge.tsx`:** pages use only `default` (active) and `outline` (every booking status). Statuses need section 7.
- **`checkbox.tsx`, `label.tsx`:** no palette work beyond tokens. Pages mostly use native checkbox / radio with `accent-primary`, which follows `--primary`.
- **`tabs.tsx`:** **no consumers anywhere in the app** (verified by search). Leave untouched; editing it is diff noise.

### 7. Booking status treatments (one system for client, admin and calendar)

The seven statuses today all render as the same plain badge or pill (and in the calendar, identical FullCalendar-blue events). One shared treatment, used by the client booking page pill, the admin list and detail badges and the calendar events. **Accepted as proposed by the user on 2026-09-20 (section 9, item 11); `/impeccable critique` can still refine it at Section 7.**

Rules: the text label is **always** shown; the statuses must stay distinguishable **in greyscale** (fill vs none, solid vs dashed vs dotted edge, a different icon each); text on its own fill is >= 4.5:1; no status uses a 2px destructive edge (reserved for the calendar conflict outline).

| Status | Meaning | Badge / pill | Calendar event | Icon (lucide, `aria-hidden`) |
|--------|---------|--------------|----------------|------------------------------|
| `pending_payment` | unpaid hold | outline, **dashed** edge, foreground text | card fill + **dashed** brand-blue edge | `Clock` |
| `confirmed` | paid, on the calendar | `primary` 10% tint, solid `primary` 30% edge, dark green text | primary tint + solid primary edge | `CircleCheck` |
| `completed` | done | `muted` fill, no edge, foreground text | muted fill + muted-foreground edge | `CheckCheck` |
| `no_show` | client absent | destructive 10% tint, destructive text, no edge | destructive tint + 1px destructive edge | `UserX` |
| `expired` | hold lapsed | no fill, **dotted** edge, muted-foreground text | card fill + dotted muted edge, muted text | `Hourglass` |
| `cancelled_by_client` | cancelled | outline, solid destructive 40% edge, destructive text | card fill + solid destructive 40% edge, muted text | `CircleX` |
| `cancelled_by_admin` | cancelled | outline, solid neutral edge, muted-foreground text | card fill + solid neutral edge, muted text | `Ban` |

**Display stages (2026-09-25, user decisions; `docs/prompts/client-access-and-admin-polish.md` item 7).** Badges and pills now show a *stage*, computed from the stored status and the clock by `backend/src/booking/stage.ts` and sent by the API as `stage`. The stored statuses and every rule on them are unchanged. The stages reuse the treatments above and add three:

| Stage | Meaning | Badge / pill | Icon |
|-------|---------|--------------|------|
| `awaiting_payment` | `pending_payment` under its stage name | as `pending_payment` | `Clock` |
| `in_progress` | confirmed, the shoot happening now | **solid** `primary` fill, `primary-foreground` text (the only solid fill) | `Camera` |
| `needs_review` | confirmed, the shoot over, not yet marked completed or no-show. **Admin only**: the client sees `completed` | `ring` 10% tint, `ring` 40% edge, foreground text | `ClipboardCheck` |
| `closed` | completed, and the photos email has gone | `muted` fill, no edge, **muted-foreground** text | `Archive` |

`completed` now means "shoot done, photos not yet sent", whatever is still owed; money owed shows in the payment section, never hidden by the stage. A **legend** ("What the statuses mean", `pages/StageLegend.tsx`) sits beside the admin list's Status column header, the admin detail badge and the client pill: an info-icon button opening a popover (click, tap, Enter, Space; not a hover-only tooltip) that lists every stage its reader can meet, as the badge plus one sentence.

Calendar blocks are not a status: muted fill with a diagonal hatch (pattern, not only colour). The dashed cue for `pending_payment` only works because its fill differs from its edge; see `pages/admin-calendar.md`.

**Shipped (Section 4, 2026-09-20):** the client pill, as the shared `StatusBadge` (`components/ui/status-badge.tsx`; see section 11). The admin badges (Section 7) and the calendar events (Section 6) still have to adopt it.

### 8. Patterns Bookly really uses (replaces the generated "Funnel")

- **Public pages:** a single centred column, mobile-first at 375px. `max-w-2xl` for flows (pay, progress, my booking), `max-w-5xl` for the list and the service detail. There is no site header or footer; do not add one.
- **The booking funnel** is three progressive groups on one route: Choose (package, add-ons) -> Pick a time -> Your details, then submit -> held -> pay -> progress. Detail in `pages/service-detail.md` and `pages/checkout.md`.
- **Admin:** a navigation **sidebar** from `lg` (15rem, sticky; the same `nav` reflows to a top bar below `lg`), then a per-page `main` that centres in the remaining column with its own width (`7xl` calendar, `6xl` bookings, `5xl` catalogue, `3xl` booking detail). Denser than public pages: use the low end of the spacing scale. Detail in `pages/admin-shell.md`.
- **Card surface:** `bg-card`, `rounded-xl`, `p-4`, one edge treatment (section 6). Only clickable cards get hover.
- **Callout** (non-refundable notice, hold expiry, warnings, the "waiting" banner): tinted fill, full 1px edge, small `aria-hidden` icon. **No left-edge stripe.**
- **Money rows:** label left, amount right, `tabular-nums`; the total is semibold above a `border-t`; an amount is never conveyed by colour alone (its label is always there).
- **Selectable card** (packages, add-ons, payment methods): a label wrapping the native input; selected = tinted fill + ring, not the 1px edge colour alone.
- **Field:** label above; hint below; error below in destructive, linked with `aria-describedby`; 16px text; 44px touch height.
- **Reference numbers** (booking references, payment refs) are monospace and semibold.

### 9. Open decisions (needed before Phase 2b)

1. **Which colour is `--primary`?** Recommended: the CTA green (D1). Alternative: the brand blue. Swapping the two roles changes only the `--primary`, `--primary-foreground` and `--ring` rows of section 4; nothing else moves. This is the largest visible identity choice in the redesign. **Applied in Phase 2b: green.**
2. **AA-safe darker green, or the generated hex?** Recommended: `#047857` (D2). Keeping `#059669` means black button labels (5.57:1) and darker text for links, badges and hover states everywhere `text-primary` is used. **Applied in Phase 2b: `#047857`.**
3. **Font delivery.** Self-host through fontsource (recommended: matches today, no third-party request; needs a separate `chore:` commit for `package.json` and the lockfile) or the generator's Google Fonts `@import url(...)` (no dependency change; third-party request; must be the first statement in `index.css`). **Applied in Phase 2b: fontsource, with separate `chore:` commits for the dependencies.**
4. **Home.** It is an API-health stub, not a landing page (see `pages/home.md`). A real landing page is a separate task with its own copy (`en.json` is protected). **Decided 2026-09-20: restyle the stub only.** A real landing page is tracked in `docs/redesign-pending.md`.
5. **`NotFound` has no way out** (no link home). Adding one needs a string in `en.json`, unless an existing key can be reused. **Decided 2026-09-20: add an "All services" link that reuses the existing string `services:allServices`** (no new copy).

**Features with no interface** (found by auditing the design files against the backend routes and the spec's permission table). None of these blocks Phase 2b, and none can be built inside the visual-only branch: each needs a new page and new `en.json` copy, which this redesign forbids. They are listed so "no design file" is not mistaken for "no feature".

6. **Admin screens with a backend and no page:** weekly working hours and dated open/close overrides (`/api/admin/working-hours`), availability blocks with the overlap warning (`/api/admin/blocks`), and settings (`/api/admin/settings`: fee rate, minimum notice, hold, buffer, delivery days). Decide whether to build them before Phase 3 section 5 (the admin nav grows from 3 to 5 links and the calendar gains "create a block") or after (they then get their own `pages/*.md` from this file). Recommended: before. The seeded Mon-Fri 09:00-17:00 hours cannot be changed without them. **Decided 2026-09-20: build them before Phase 3 section 5, and tell the user when the implementation reaches it** (the gate is in `docs/redisign.md`; checklist in `docs/redesign-pending.md`).
7. **Calendar events do not open the booking.** There is no `eventClick` or `url` in `AdminCalendar.tsx` or `calendar-events.ts`, so the only way to a booking is the bookings list. `pages/admin-calendar.md` bans popovers and now also designs the click-through states (decided below). Linking a booking event to `/admin/bookings/:id` is a behaviour change, not a styling one. **Decided 2026-09-20: add click-through with the other admin work (item 6); `pages/admin-calendar.md` now designs the hover and focus states.**
8. **`/admin/reset-password` is not a route.** The backend's password-reset email links to it (it renders `NotFound`), and the login page has no "Forgot password" link (`pages/admin-login.md` now leaves the link to the reset-password page's design). Belongs with decision 6. **Decided 2026-09-20: build it with item 6**, including a "Forgot password" link on the login page.
9. **No way to reach the photographer.** Three client messages say "contact the photographer" (`checkout:closed.body`, `booking:delivery.expired`, `booking:cancel.notCancellable`), but no page shows a phone number, WhatsApp or email. Needs real details from the client and new copy. **Decided 2026-09-20: defer until the client gives details;** tracked in `docs/redesign-pending.md`.
10. **`en.json` policy. Decided 2026-09-20: new keys may be added, additive only**, when a change truly needs them: the skip-to-content link (`pages/admin-shell.md`) and, later, contact details (item 9). Existing strings are never edited. The guardrails in `docs/redisign.md` are updated to match.
11. **Booking status treatments. Decided 2026-09-20: accept section 7 as proposed.** Phase 3 section 4 (client booking page) implements it first.
12. **The `outline` Button variant's faint edge. Decided 2026-09-20 (at Phase 3 section 3): fix the variant itself.** It drew a Hairline Blue edge (`border-border`) on a page-coloured fill, about 1.1:1, so every outline button read as floating text. It is now `border-input bg-card` (a Field Slate edge on white, 3.27:1 on the page, the same as a text field); hover, `aria-expanded` and the dark variants are unchanged. This also changes the admin's outline buttons ahead of their own sections, which the user accepted.

### 10. Phase 2b: what was applied (commit `3ce6cd3`)

- **Tokens:** the section 4 table, written to `:root` in `frontend/src/index.css`. `.dark` is untouched (unreachable).
- **Fonts:** Poppins 400 / 500 / 600 and Open Sans (variable), self-hosted through fontsource. Geist was removed. `h1`, `h2` and `h3` use the heading font through the existing `@layer base` block.
- **Choices Phase 3 must follow:**
  - **The card edge is `border` + `shadow-sm`** (`card.tsx`). The hand-rolled cards on the client pages and the booking detail already use `border`; add `shadow-sm` to match them (Phase 3 sections 2-4 and 7).
  - **`--input` is now a mid slate**, so `disabled:bg-input/50` became `disabled:bg-muted` in `input.tsx` and `textarea.tsx`. Any Phase 3 markup that relies on `bg-input/...` should use `muted` instead.
  - Fields have a `bg-card` fill. Buttons and inputs are 44px on coarse pointers (`pointer-coarse:`) and 32px otherwise.
  - The default Button hover darkens (a `color-mix` with black) instead of lightening, and `aria-disabled` is styled.
- **Not done in 2b (Phase 3):** the status treatments (section 7), solid destructive confirm buttons (call-site overrides), callouts, the FullCalendar CSS block, the admin sidebar, and the layout of every page. `text-primary` links are unchanged and now pass AA (`#047857` is 5.48:1 on white).
- **Verified:** typecheck, lint, 1135 tests and a production build. In Chromium, `/` and `/admin/login` load the new fonts (Latin subsets only), and the tokens resolve to the intended sRGB (background `#F0F9FF`, primary `#047857`, input border `#7A8BA0`). Radius is 8px on controls and 11.2px on cards, and buttons and inputs measure 44px under touch emulation and 32px on desktop. Nothing else has been rendered yet.

### 11. Phase 3: what each section applied

**Section 1: Home + NotFound (2026-09-20).** Two files, class names and non-textual decoration only. Choices that later sections reuse:

- **Text link** (a standalone link, not one inside a sentence): muted `text-sm`, underline on hover with `underline-offset-4` (the same as the Button's `link` variant). Keyboard focus is a full-strength `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring` (3.84:1 on the page). The Button's `ring-3 ring-ring/50` is not used for links: at 50% it measures about 1.9:1 on the page. Height is `min-h-6` (24px, WCAG 2.5.8) and `pointer-coarse:min-h-11` (44px).
- **Decorative icons** are lucide with `aria-hidden="true"`. A leading arrow on a link is an icon, not a "←" character, so a screen reader hears only the words. The service page's back link uses the icon too (Section 2, through the shared `BackLink`).
- **Optical alignment:** a 40px lucide glyph has about 6px of built-in padding, so a large icon above a heading takes `-ml-1` to line up with the text's left edge.
- **Raw strings** (API errors, anything unpredictable) sit in a shrinkable flex child: `min-w-0 wrap-anywhere`. A 200-character error at 320-1440px causes no horizontal scroll.
- **Status dot** repeats the words and is never the only signal: `primary` when reachable, `destructive` on failure, `muted-foreground` while checking, with a 200ms colour transition that is off under `motion-reduce`. Rendered contrast on the page: 5.14 / 6.07 / 7.11, error text 6.07.
- **A standalone button on a public page** hugs its label (`self-start`) instead of stretching across the column, as `BookingPage` already does.
- **Tests:** `NotFound.test.tsx` is new (the page had none): the copy, one link named "All services" pointing at `/services`, and that clicking it navigates. The suite is 1137 tests.
- **Verified** (Chromium, `/api` mocked, 1280px and 375px touch): the fonts load, the heading is Poppins 600 (30px on Home, 24px on NotFound), the tokens resolve to the intended sRGB, and the button measures 32px on desktop and 44px under touch. NotFound renders both as the `*` route and inside `/services/:slug` when the API answers 404, and never overflows horizontally at 320, 375, 768, 1024 or 1440px.

**Section 2: Services and the booking flow (2026-09-20).** Six page files, two shared components and one class-string module. Choices that later sections reuse:

- **`BackLink`** (`components/ui/back-link.tsx`) is the text-link treatment above as a component: the `ArrowLeft` icon plus the words. NotFound and the service page use it; Section 7's "back to bookings" link should too. Its accessible name is just the words, with no arrow character, so the two unit assertions and three e2e locators that named it "← All services" were updated.
- **`Callout`** (`components/ui/callout.tsx`) is the section 8 callout: `border-ring/30 bg-ring/5`, a 16px `text-ring` icon (3.85:1 on the tint), Ink Navy text (16.8:1) and no side stripe. It carries the non-refundable notice (`Info`) and the hold expiry (`Clock`). Sections 3, 4 and 7 reuse it for the waiting banner and the delivery and refund notes.
- **Selectable card** is the shared `SelectableCard` (`components/ui/selectable-card.tsx`, a `label`; package and add-on rows now, `PaymentFields` in Section 3). Rest: `bg-card border shadow-sm`. Hover: 60% Powder Blue mixed into the card's white (`#ECF7FE`). Selected: a 2px green edge (`border-primary` plus a 1px ring) and a 5% green tint mixed into the card's white (`#F4F8F6`), on top of the native radio or checkbox mark. Keyboard focus: the border turns Calendar Blue with the 3px ring (which overrides the checked ring, verified), and the native input's own faint outline is hidden so there is one indicator. **Both fills are opaque mixes with `--card`, not `bg-primary/5`:** a translucent fill replaces the white and lands on the page colour, which rendered the selected card `#E3F2F6` and made it look like the hovered one. Real pixels were sampled to check this.
- **`color-mix` and `--card`:** `--card` is `oklch(1 0 0)`, an explicit hue of 0 (red). Mixing a coloured token into it with `in oklch` drifts the hue (the selected card came out pink `#FAF5F6`, the hovered one lavender), so mix against `--card` or `--background` in `oklab`. Mixing with the keyword `black` in `oklch` is fine (it has no hue), which is how the Button and calendar-day hovers work.
- **Step numerals:** `pages/services/step-number.ts` exports the class string that draws a 24px Powder Blue disc with the counter numeral before a heading, and the container sets `[counter-reset:step]`. The numeral is generated content, so no text was added. Browsers include it in the heading's accessible name ("2 Choose a date and time"), which the e2e locators still match by substring. Add-ons are not numbered.
- **Fieldset legends** now use `font-heading`, matching `h2` (the inconsistency `DESIGN.md` recorded).
- **The one clickable card** (a service on the list) has `shadow-sm` at rest and `has-[a:hover]:shadow-md` on hover (200ms, `motion-safe`); on keyboard focus its border turns `border-ring` with the 3px ring. `pages/services.md` allows this single exception to "border plus `shadow-sm`".
- **Slot picker:** bookable days are `bg-muted font-semibold` (hover 8% darker), unavailable days are `disabled` with 50% text and no surface, and the selected day is `bg-primary`. Day cells are 40px (44px on touch) and take the same focus edge as controls; time buttons are `h-11` (44px everywhere, as the page file says). The time and month buttons are plain outline buttons, white with a Field Slate edge (3.27:1 on the page), because the outline variant itself was fixed in Section 3: its original Hairline Blue edge was about 1.1:1 and made the times look like floating text. The selected time is the default green button.
- **Step rhythm:** the three numbered groups are 32px apart (`gap-8`); the add-ons sit 16px from the packages because they belong to step 1; below `lg` the closing price summary is spaced like a step (`max-lg:mt-2`). The service name is `text-wrap: balance` (`text-balance`), and the heading has 16px above it under the cover image (`mt-1`). A package price is `ml-auto`, so it stays right-aligned when a long name pushes it to its own line.
- **A bare native checkbox** (the consent row) gets `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`: the base layer's `outline-ring/50` gives the browser's `auto` outline only about 1.9:1.
- **Money rows** (price summary and held page): the booking-fee row is `font-medium` as a whole (it is due now), the total is semibold above a `border-t`, the session fee is regular. The held page's reference is `text-lg` mono semibold, on a shared baseline with its label (`items-baseline`). Form hints and errors are `text-sm`, up from `text-xs`.
- **Tooling gotcha (not a design choice):** in Playwright, a `fullPage` screenshot of a page taller than the viewport turns touch emulation off for that page (`pointer: coarse` becomes false, and `setViewportSize` does not restore it), so a touch-size measurement taken afterwards reads 32px instead of 44px. Measure first, or give the mobile profile a viewport tall enough that nothing has to resize.
- **Verified** (Chromium, `/api` mocked, 1280px, 768px and 375px touch): the list is 3, 2 and 1 columns with equal-height cards; the funnel is two columns with a sticky summary at 1280px and one column with the summary last at 768px and 375px; touch targets are 44px (fields, day cells, time buttons, Pay, back link); there is no horizontal scroll at 320-1440px even with very long package and add-on names. Unit tests (1137), typecheck, lint and the whole e2e suite (38) pass.

**Section 3: Checkout (2026-09-20).** Three page files, one shared card, one shared icon, and one decision (section 9, item 12). Choices that later sections reuse:

- **The outline Button variant is fixed at the source** (`border-input bg-card`), so nothing overrides it page by page; Section 2's local overrides were removed.
- **`StatusIcon`** (`components/ui/status-icon.tsx`) opens every status view: 40px, stroke 1.5, `-ml-1 mb-2`, always `aria-hidden`. Tones: `info` Calendar Blue, `positive` Available Green, `destructive` Cancel Red, `neutral` Slate Text. NotFound uses it too. Section 4's booking-page status views reuse it.
- **The invariant** (`pages/checkout.md`): the design never implies success while the outcome is unknown, and green is `positive` only. Checked in the browser for every view: a green icon appears only on the confirmed booking and on the already-paid notice. Waiting is a blue spinner, received is a blue receipt, refund, duplicate and refund-other are a blue return arrow, failed is a red cross, and closed, expired and invalid link are neutral.
- **Icons by view:** waiting `LoaderCircle` (`motion-safe:animate-spin`) with a still `Smartphone` shown only under `motion-reduce`, so the visitor asking for less motion gets a phone, not a frozen spinner; confirmed and paid `CircleCheck`; received `ReceiptText` (lucide's plain `Receipt` carries a dollar sign, wrong for francs); refund views `Undo2`; failed `CircleX`; closed `Lock`; expired `Hourglass`; invalid link `Unlink`. The spinner is the only moving element on the page.
- **`BookingFacts`** (`pages/checkout/BookingFacts.tsx`) is the reference, service and when card used by the pay page and the progress page, with a slot for extra rows: `bg-card border shadow-sm`, the reference `text-lg` mono semibold on the label's baseline, and long values `min-w-0 wrap-anywhere`. The pay page adds the fee as an emphasised row (`text-lg font-semibold`); it is the number the client is about to pay.
- **The pay page's notices are `Callout`s** (hold expiry `Clock`, non-refundable `Info`, and the "request already waiting on your phone" banner `Smartphone`, with its link inline, `text-primary`, and a full-strength focus outline). Their order (before the form) is unchanged. The pay button is `size="lg"`.
- **A forward text link inside a notice** ("Choose a time") is `Button asChild variant="link"` with `-ml-2.5 self-start`: the primitive supplies the 44px touch height and a blue focus border, and the negative margin lines the text up with the heading.
- **`PaymentFields`** uses the shared `SelectableCard`; its legend uses the heading font; the phone hint and error are `text-sm`. With one method the card is selected from the start (mint fill, green edge, verified).
- **Verified** (Chromium, `/api` mocked, 1280px and 375px touch): 17 states rendered (pay page in five states, four notices, seven progress outcomes and the invalid link); the pay button is 44px and full width on touch, the phone field 44px; no horizontal scroll at 320-1440px with a very long package name; every non-waiting outcome moves focus to its heading and the waiting view does not (unchanged); exactly one `role="status"` region in the waiting view; no `disabled` or `aria-disabled` element on the initial pay page. Unit tests (1137), typecheck, lint and the e2e suite pass.
- **Polish (same day):** status words share one measure, `max-w-xl` (36rem, about 72ch) with `text-pretty`, and status headings are `text-balance`, so a phone no longer strands "ended" or "again." on a last line (checked by counting words per rendered line). The pay page's three notices are one group, 8px apart (`gap-2`) and 16px above the form. The green inline link on the callout tint measures 4.83:1. Icon ink offsets were measured, not nudged: round glyphs hang about 2px left of the heading edge and rectangular ones sit about 3px right, which is optical variance between shapes, so `StatusIcon` keeps one `-ml-1` and no per-icon offsets.

**Section 4: The client booking page (2026-09-20).** One page file, one new shared component and one extended one. This is the first section to use the section 7 status treatments. Choices that later sections reuse:

- **`StatusBadge`** (`components/ui/status-badge.tsx`) is section 7 as a component, built on the existing `Badge` (`badge.tsx` is untouched). It takes a `status` and the translated label as its children (the client and the admin word some statuses differently), sets `data-status`, and renders an unknown status as a plain outline instead of failing. Two sizes: `sm`, the 20px badge for tables, and `md`, the page pill (28px, 14px text, 16px icons). Sections 6 and 7 reuse it for the calendar events and the admin badges.
- **The seven, as rendered** (text on its own fill; pills with no fill sit on the page): `confirmed` `CircleCheck`, a 30% green edge on a mint fill (`#E9F1ED`, 4.77:1); `pending_payment` `Clock`, dashed slate edge, no fill (16.75:1); `completed` `CheckCheck`, Powder Blue fill and no edge (15.56:1); `no_show` `UserX`, a red tint (`#FBEAE8`) and no edge (5.56:1); `expired` `Hourglass`, dotted slate edge (7.11:1); `cancelled_by_client` `CircleX`, a 40% red edge and no fill (6.07:1); `cancelled_by_admin` `Ban`, a solid slate edge (7.11:1). Viewed in greyscale, all seven stay apart by edge style, icon and label; `confirmed` and `no_show` are both filled, and differ by icon and word. The green and red tints are opaque mixes into `--card` in `oklab` (the section 3 gotcha applies), never a translucent fill.
- **Never a green that is not confirmed.** Green appears in the pill only for `confirmed`, and the section 7 rule that no status uses a heavy red edge holds (the cancelled edge is 1px at 40%). A test that reads the page text finds each status word once (`getByText('Confirmed')`, `getByText('Cancelled by you')`), so the pill carries the word and nothing else repeats it.
- **The header row** is `items-center` (a pill is a shape, not a line of text, so it centres on the heading rather than sharing its baseline) with `gap-x-4 gap-y-2`; when the pill does not fit beside the title (as with "Cancelled by you" on a phone) it wraps under it.
- **`Callout` has a tone.** `info` is the default and is unchanged. `destructive` is `border-destructive/30 bg-destructive/5` with a Cancel Red icon; the text stays Ink Navy in both (16.34:1 on the red tint; the icon is 5.92:1), so the icon carries the tone and the words carry the meaning. The page uses four callouts: the cancel warning (`TriangleAlert`, destructive), the expired delivery link (`Info`), the refund note (`Undo2`) and the waiting banner (`Smartphone`, with its link inline and a full-strength focus outline, as on the pay page).
- **The irreversible confirm is solid red**, as section 6 asked: a `className` override on the destructive `Button` at the call site (`bg-destructive text-white`, hover a 12% black mix, focus border Calendar Blue with the 3px ring), not a new variant. White on Cancel Red is 6.47:1, and the DOM order and the focus that moves to it on open are unchanged. `AdminBookingDetail` does the same in Section 7.
- **Money.** "Still to pay" is semibold while it is above zero and regular at zero, so the actionable number stands out and a settled booking stays quiet. "Refund due to you" is Cancel Red text, medium weight (6.47:1 on white), because `pages/booking.md` calls it informational and destructive-toned. Every amount is `shrink-0 tabular-nums`, and a long package or add-on name wraps in its own `min-w-0 wrap-anywhere` `dt` instead of squeezing the amount.
- **Details card.** The reference is `text-lg` mono semibold on its label's baseline, as on the pay page. Every value is `min-w-0 wrap-anywhere`, so a long location, a photographer's note or a URL wraps in the card. All the cards on the page are `bg-card border shadow-sm`, the one card look.
- **The invalid link** is the status-view pattern: a neutral `Unlink` `StatusIcon`, a balanced `h1` and a `max-w-xl` body. It does not take focus (unchanged), and it still shows no booking word.
- **"Open your photos"** ends in an `ExternalLink` icon (`aria-hidden`); it still opens in a new tab with `rel="noreferrer noopener"`.
- **Polish (same day):**
  - **The cancel confirmation stacks on a phone.** Confirm and keep are `flex-col sm:flex-row`: full width on a phone like the pay button (two equal 44px targets, 8px apart, edges lined up with the warning above), a row from `sm`. The DOM order and the focus that moves to confirm are unchanged.
  - **No stranded last word.** `main` sets `text-pretty`, which is inherited. The cancel warning left "book." alone on a last line at 375px; a probe that counts the words on the last rendered line of every text block found none left in nine states.
  - **The method legend is one step down inside a card that has its own `h2`.** In the session-fee card it is 16px under the 18px "Pay the rest"; on the pay page, where it is the first heading, it stays 18px. It is a `[&_legend]:text-base` on the form, not a new prop on `PaymentFields`.
  - **Judged and left as designed.** The inline error lines (load failed, cancel refused, cancel failed, pay failed, no methods) are bare red `role="alert"` paragraphs, exactly as on the pay page and every other client page, and `pages/booking.md` describes load failed as "destructive alert + outline retry". Turning them into callouts would have to happen on every page at once, so it is not a Section 4 change. The refund is shown twice on purpose: a red ledger row (the page file: informational, destructive-toned) and a blue callout that says what happens next.
  - **Measured.** "Follow that payment" is 5.15:1 on the callout tint and 3.26:1 against the sentence around it (WCAG 1.4.1 asks for 3:1 when a link has no underline at rest; it gains one on hover and a full outline on focus). The dashed (pending) and dotted (expired) pill edges are different at 1x, and neither pill looks disabled (ink text on pending, 7.11:1 Slate on expired). Error text is 6.07:1 on the page. The error states have no horizontal scroll at 320, 375, 768 or 1440px.
- **Verified** (Chromium, `/api` mocked): 14 states at 1280px (the seven statuses, a live and an expired delivery link, the refund, the waiting banner, no payment methods, the cancel confirmation, a long-content booking, the invalid link and the load failure) and six at 375px touch. Every pill is 28px tall and centred on its heading (offset 0); buttons and the phone field are 44px on touch; there is no horizontal scroll at 320, 375, 768, 1024 and 1440px for the long-content booking, the longest status label ("Cancelled by the photographer") and a full confirmed booking; the invalid page contains no booking words. Unit tests (1137), typecheck, lint and the whole e2e suite (38) pass.

**Section 4 milestone: the client journey end to end (2026-09-20).** Every client page is now done, so the whole journey was clicked through by script (Chromium, `/api` mocked with a stateful mock, 1280px and 375px touch on a tall viewport, no `fullPage`): `/`, the service list, a service, package, add-on, date and time, the details and consent, Confirm, the held page, the pay page, the payment-progress page waiting and then confirmed, the emailed `/booking/:token`, paying the session fee, its progress page waiting and then confirmed, the booking page again, the two-step cancel, and the cancelled booking with its refund. Fifteen steps at each size.

- **Held:** no console error or page error; no horizontal scroll; every card has the shared `shadow-sm`; the heading font (Poppins), the body font (Open Sans) and the page colour are the same on every page; focus moves to the heading on every outcome and stays put while a payment is waiting; exactly one `role="status"` region while waiting; green appears only on the pay buttons and on confirmed states, and waiting is blue.
- **Two defects found and fixed, both in Section 2 files:** the held page's total, booking-fee and session-fee amounts lacked `shrink-0` (its package and add-on rows had it, and `PriceSummary` had it on every row), so at 375px the fee row broke "20,000 / RWF" over two lines; and the consent row was 40px tall on touch (`pointer-coarse:min-h-11`, so it is 44px, and unchanged on a mouse).
- **Known and left:** at 375px a calendar day cell is 44px tall and 41px wide, because seven columns cannot each be 44px wide in a 309px card (the WCAG 2.5.8 minimum is 24px); a service card's link measures 78x25 but is stretched over the whole card (`after:absolute after:inset-0`), so the target is the card.
- **Not fixed, because it is behaviour and this redesign is visual-only:** after "Yes, cancel my booking" the confirm button unmounts, so keyboard focus falls to the page body and nothing announces the change (the pill and the summary do change). A fix (move focus to the heading, or a live region) is logic work for the feature branch.
- **Not run:** the journey against the real backend and database. That is a manual pass, and it is the one thing this mocked run cannot show.

### 12. The admin console (2026-09-26)

**The admin no longer shares the client's look.** The brief `docs/prompts/admin-console-redesign.md` (user decisions 1-4) gives every `/admin/*` route, including login and reset password, its own developer-console system: light and dark themes (following the OS, with a System / Light / Dark toggle), a violet accent, Geist and Geist Mono, a 2px radius, hairline borders and no shadows. Section 8's "Admin: ... denser, never different in kind" and section 2's "Light theme only" no longer describe admin. The system lives in `design-system/bookly/admin-console.md`, which wins over this file and over the admin page files for the admin; the client side and everything above still hold for it, unchanged.

The admin tokens are scoped to `:root[data-admin-theme]`, set only while an admin route is mounted, so client pages never see them. Two contrast decisions were taken with the user on 2026-09-26 (field edges at 3:1; login drops the client header), and three values were darkened to pass AA; all are recorded in `admin-console.md` section 0.

### 13. The client front (2026-09-27)

**The client now speaks the console's language, public-facing.** The brief `docs/prompts/client-front-redesign.md` gives every client route (everything inside `ClientShell`) the admin's family: Geist and Geist Mono, zinc neutrals with one violet, a 2px radius, 1px hairlines, no shadows, mono uppercase labels, inverted-neutral primary buttons, and **light and dark themes** that follow the OS with a System / Light / Dark button in the header. The sky / green palette, Poppins and Open Sans, the 8px radius, the card `shadow-sm`, section 2's "Light theme only" and section 11's per-page recipes no longer describe the client. The system lives in `design-system/bookly/client-front.md`, which wins over this file and over the client page files; each carries a dated note. The funnel's structure, the protected behaviour and every accessibility rule above still hold.
