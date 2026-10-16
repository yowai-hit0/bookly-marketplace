---
name: Bookly
description: A plain, developer-console-styled front desk for one photographer in Kigali. A flat white/near-black page, one violet accent, inverted-neutral primary actions, and a matching dark theme.
colors:
  brand: "oklch(0.5413 0.2466 293.01)"
  brand-hover: "oklch(0.4907 0.2412 292.58)"
  brand-foreground: "oklch(1 0 0)"
  background-light: "oklch(1 0 0)"
  background-dark: "oklch(0.1452 0.0021 286.13)"
  foreground-light: "oklch(0.2103 0.0059 285.89)"
  foreground-dark: "oklch(0.9674 0.0013 286.38)"
  primary-light: "oklch(0.2103 0.0059 285.89)"
  primary-dark: "oklch(0.9851 0 0)"
  muted-foreground-light: "oklch(0.5517 0.0138 285.94)"
  muted-foreground-dark: "oklch(0.7118 0.0129 286.07)"
  destructive-light: "oklch(0.5054 0.1905 27.52)"
  destructive-dark: "oklch(0.7106 0.1661 22.22)"
  border-light: "oklch(0.9197 0.004 286.32)"
  border-dark: "oklch(0.2739 0.0055 286.03)"
  input-light: "oklch(0.6493 0.0118 286.07)"
  input-dark: "oklch(0.5025 0.0126 285.94)"
  console-success-light: "oklch(0.5273 0.1371 150.07)"
  console-success-dark: "oklch(0.8003 0.1821 151.71)"
  band-light: "oklch(0.1452 0.0021 286.13)"
  band-dark: "oklch(0.1876 0.004 286.01)"
typography:
  heroHeadline:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "3.5rem"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.035em"
  sectionHeadline:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "2.75rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.03em"
  pageTitle:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  cardTitle:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "1.25rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4286
    letterSpacing: "normal"
  eyebrow:
    fontFamily: "'Geist Mono Variable', monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.3333
    letterSpacing: "0.1em"
  data:
    fontFamily: "'Geist Mono Variable', monospace"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  all: "2px"
spacing:
  "1": "4px"
  "2": "8px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
  "12": "48px"
  "16": "64px"
components:
  button-primary:
    backgroundColor: "{colors.primary-light}"
    textColor: "{colors.background-light}"
    typography: "{typography.label}"
    rounded: "{rounded.all}"
    height: "44px"
    padding: "0 20px"
  button-brand:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.brand-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.all}"
    height: "44px"
    padding: "0 20px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.foreground-light}"
    typography: "{typography.label}"
    rounded: "{rounded.all}"
    height: "44px"
    padding: "0 20px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.foreground-light}"
    typography: "{typography.body}"
    rounded: "{rounded.all}"
    height: "44px"
    padding: "0 12px"
  card:
    backgroundColor: "{colors.background-light}"
    textColor: "{colors.foreground-light}"
    rounded: "{rounded.all}"
    padding: "16px"
  badge:
    textColor: "{colors.foreground-light}"
    typography: "{typography.eyebrow}"
    rounded: "{rounded.all}"
    height: "20px"
    padding: "2px 8px"
---

# Design System: Bookly

## Overview

**Creative North Star: "The Console, in Public"**

Since the 2026-09-27 redesign, the client side no longer looks like a separate, softer product from the admin: it speaks the same developer-console language the photographer already uses to run the business (flat planes, hairlines, 2px corners, Geist and Geist Mono, one violet accent) restyled for a visitor who is booking a session, not managing one. The surfaces are flat and quiet (white or near-black canvas, hairline borders, no shadows anywhere) so the things that matter — a time, a price, a status word — carry the page. Colour still means something specific: violet marks the one action the page wants you to take, links and selected state; green appears only for a confirmed or successful outcome.

Two people use Bookly. Clients book on a phone or a laptop, with no account, usually once. The photographer runs the business from the admin. The two sides now share one visual language (Geist, violet, 2px, flat) but remain two scopes: the client's tokens live under `:root, :root[data-theme="light"]` and `:root[data-theme="dark"]` in `frontend/src/index.css`, set by `ClientShell` on `<html data-theme>`; the admin's live under `:root[data-admin-theme="light"|"dark"]`, set by `src/admin/theme.ts` on `<html data-admin-theme>`. A `client:` Tailwind variant (`&:where([data-theme], [data-theme] *)`) scopes shared-component defaults to client pages only, and `dark:` is rescoped to `&:where([data-theme=dark], [data-theme=dark] *)` so it means the client's dark theme, not the admin's. Both sides still share the primitives in `components/ui`, which the admin restyles only through its own opt-in `console-*` variants — the same variants the client also uses for status badges, callouts and badges, since `client-front.md` §5.2 puts the client on the console's status mapping.

Visual rejections recorded in the design system (`design-system/bookly/MASTER.md` section 2; the first three are also enforced by Impeccable's design hook): no gradient text, no glow shadows, no coloured left-edge stripes, no modals, no 3D, parallax or scroll-driven effects, no emoji as icons. The client now ships **both a light and a dark theme**, following `prefers-color-scheme` live by default with a per-device System/Light/Dark override in the header; this replaces the earlier "light only" state, which is obsolete.

The palette, the Geist pairing and the violet accent are the admin's own shipped tokens, carried over to the client; light success, muted-on-chip and other fixes are the same measured corrections recorded in `design-system/bookly/admin-console.md` and reused here rather than re-derived. Contact details shown in the footer and the summary are **placeholders** (`frontend/src/lib/contact.ts`: "Studio name", `+250 700 000 000`, `hello@example.com`) to be replaced with the photographer's real details before launch — a deliberate, recorded exception to "nothing invented."

**Key Characteristics:**
- Flat white (light) or near-black (dark) canvas, 2px corners, 1px hairlines, no shadows anywhere on the client.
- Geist for everything, Geist Mono for labels, eyebrows and every data value (prices, times, references, step numerals).
- One violet accent (`--brand` / `--ring` / `--console-link`) for the hero CTA, links, selected state and focus; the primary action itself is inverted neutral (near-black on white in light, near-white on black in dark), never violet.
- 44px controls (48px fields from `md`, 52px large buttons; small buttons 40px on a mouse), and never under 44px on a coarse pointer — there is no 32px desktop size on the client.
- Every status and every amount is written in words; colour, icons and shape (four status glyphs, reused from the admin) only repeat them.

**State of the build.** The whole client journey — the landing page, the service list, the service page with its calendar and times, the details form, the price summary, the held booking, checkout and its payment-progress page, and the client booking page — shipped the console-styled redesign on branch `redesign/client-front` (`docs/prompts/client-front-redesign.md`; full token and decision record in `design-system/bookly/client-front.md`). The admin was verified pixel-identical before and after (32/32 screenshots, 8 routes × two themes × two widths).

## Colors

A flat white-or-near-black ground with one violet accent held for location and one action. Values are `oklch()` because `frontend/src/index.css` is the source of truth; hex is given for reference.

### Brand / accent
- **Brand violet** (`oklch(0.5413 0.2466 293.01)`, #7C3AED in both themes): the hero CTA fill, selected time slots, checked boxes, day pips, links (`--console-link`), and the focus ring (`--ring`; `#B9A2FF` in dark). White label on it is 5.70:1 (7.10:1 on hover, `#6D28D9`).
- **Primary — inverted neutral** (light `#18181B` on white; dark `#FAFAFA` on `#0A0A0B`): the main action button in both themes. Never violet; violet is reserved for location and linkage, per the same rule the admin already names.

### Status
- **Console success** (light `#15803D`, dark `#4ADE80`): a confirmed booking, a successful payment, the delivered-photos link. The same darkened value the admin uses, reused because the generic tint failed AA the same way here.
- **Console danger** (light `#B91C1C` text / `#B91C1C` solid confirm; dark `#F87171` text / `#DC2626` solid confirm): cancel, failure and refund-due. The dark solid confirm uses `#DC2626` rather than the dark `#F87171` text colour, because `#F87171` cannot carry a white label at 4.5:1 (client-front.md decision 9).
- **Console warning** (light `#B45309`, dark `#FBBF24`): "just taken" and slot-check-failed banners.

### Neutral
- **Background / canvas** (`#FFFFFF` light, `#0A0A0B` dark): the page. `--card` equals canvas in both themes — panels are flat, a hairline sets them apart, not a fill change.
- **Foreground** (`#18181B` light, `#F4F4F5` dark): primary text, 17.7:1+ on canvas in both themes.
- **Muted foreground / subtle foreground** (`#71717A` / `#52525B` light, `#A1A1AA` dark): captions, eyebrows, secondary body copy. Muted text never sits on the chip surface in light (4.40:1, below AA); it stays on canvas or the flat surface instead (client-front.md decision 8).
- **Border / input** (border `#E4E4E7` light / `#27272A` dark for hairlines; input `#8E8E96` light / `#63636B` dark for field edges, ~3.25:1): the board's own field-edge colour failed at 1.48:1, so fields, checkboxes and the resting edge of day/slot cells use the stronger `--input` value instead (decision 6). Outline buttons keep the weaker `--console-border-strong` edge, since their label already identifies them.
- **Band** (`#0A0A0B` light, `#131315` dark, with `#F4F4F5` text): the "Already booked?" band on Home, inverted from the page in both themes.

### Named Rules
**The Violet Is For Where You Are Rule.** Violet marks location and linkage: the hero CTA, links, selected controls (day pips, checked boxes, selected time and package edges), and the focus ring. The primary action button is never violet; it is the inverted-neutral fill, one per view — the same rule the admin already runs, now shared by the client.

**Green Only For Confirmed Rule.** Success green marks only an outcome the API has actually confirmed: a confirmed booking, a received payment, delivered photos. A payment that is pending, received-but-unconfirmed, refunded or duplicated is never green and never ticked; it is blue-gray/neutral or the waiting spinner instead.

**The Words Come First Rule.** Colour, an icon or a shape never carries a meaning alone. A status badge shows the word every time; a dot, tint or glyph only repeats it.

## Typography

**Font:** Geist Variable for all text; Geist Mono Variable for labels, eyebrows and every data value. Poppins and Open Sans have left the bundle entirely (`deps: remove Poppins and Open Sans, which nothing imports any more`).

**Character:** one typeface family in two optical roles — Geist for reading, Geist Mono (uppercase, tracked) for anything mechanical: an eyebrow, a price, a time, a reference, a step numeral. This is the same pairing convention the admin already used; the client now speaks it too.

### Hierarchy
- **Hero headline** (56px/600/-0.035em, 1.05 line-height; 40px `md`, 34px `sm`): Home's `h1` only.
- **Section headline** (44px/600/-0.03em; 32px `md`): Home's `h2`s ("What you can book", "How booking works", "What you can count on"); the band's own `h2` is 40px (30px `md`).
- **Page title** (36px `md` / 30px below, 600, -0.02em, 1.15): every other page's `h1` (services list, service detail, checkout, booking, the status views).
- **Card/step title** (20-22px/500): in-page `h2`s (price summary, "Your email", cancel), card and step `h3`s.
- **Body** (16px): the main reading size; secondary/subtle colour under a heading, lead copy 17-18px.
- **Label** (14px/500 above fields; nav links 15px; hints and errors 13px).
- **Eyebrow** (Geist Mono, 12px/500, uppercase, +0.1em, muted, with a 14px icon): every section and card header ("01 — Services", "MY BOOKING").
- **Data** (Geist Mono, `tabular-nums`): prices, times, references, step numerals `01`-`04`, calendar day numbers, weekday heads.

### Named Rules
**The Two Voices Rule (client version).** Geist Mono is reserved for anything mechanical — an eyebrow, a label, a number that must be read exactly. Everything a person reads as prose stays in Geist. A mono value interpolated inside one translated sentence stays in Geist rather than splitting the sentence, to protect the translation.

**The Numbers Stay Put Rule.** Amounts, times, references and counts use tabular figures so columns and totals do not shift as digits change.

## Layout

Mobile first, designed at 375px, container `max-w-6xl` (1152px) centred: 16px gutter on phones, 32px at `md`, 48px at `lg` (`container` in `pages/client/classes.ts`). Section rhythm is 48px vertical padding on phones, 64px at `md`, 104px at `lg`. Public pages sit inside `ClientShell`: a skip link, then `header`, `div#main-content` and `footer` as **siblings** (never a wrapper around `main`), so there is exactly one main-content region per page. The header is 72px (64px below `md`), canvas-coloured with a bottom hairline, static (no sticky anything). The footer is three columns from `md` (wordmark + contact block; Book; About), stacked on phones.

Admin pages are unchanged: each still centres in its own width and is denser than the client.

## Elevation & Depth

Flat. There are no shadows anywhere on the client — the old card `shadow-sm` is gone. Panels (cards, the summary, the callouts) sit on the same canvas colour as the page and are set apart only by a 1px hairline border. Hover and selected state are carried by an edge-colour change (hairline → muted-foreground on hover, hairline → brand-violet when selected/focused) and, on cards that move, a small lift, never a bigger shadow.

### Named Rules
**The Flat-Panel Rule.** A card, the summary and a callout are the canvas colour plus a 1px border; nothing is elevated with a shadow. The one exception recorded for a device, not a rule: a faint shadow on the admin's light popover, which the client does not use.

## Shapes

Everything derives from a single `--radius: 0.125rem` (2px), used on every control, card, badge and callout on the client — round shapes are reserved for status dots, pips, the round step/confirm icons and the hero's decorative dot grid. Edges are 1px: hairline (`--border`) for structure, `--input` for field edges, `--console-border-strong` for outline-button edges. Focus is one 2px `--ring` (violet) outline offset 2px on every interactive element in both themes — the admin's own focus rule, re-scoped to `:root[data-theme]`, which also zeroes the shadcn 50% ring the earlier client system used. Icons are lucide, 1.5px stroke, square caps (matching the admin), 16-20px beside text, `aria-hidden` when decorative. Dashed and dotted edges are reserved to mean something (a hold is dashed, a lapsed hold dotted, carried over from the console status mapping); they are never decorative.

## Components

### Buttons
- **Shape:** 2px radius, 1px edge where the variant has one, label in Geist medium 15px, `gap-2`.
- **Default (primary):** inverted-neutral fill (near-black on white / near-white on black), hover to `--primary-hover`. This is the main action on every non-Home page.
- **Brand:** the violet fill, white label, hover to a darker violet (`#6D28D9`) — reserved for the one hero CTA on Home ("Browse services →") and nothing else, per the Violet Is For Where You Are rule.
- **Outline:** transparent fill, `--console-border-strong` edge, hover fills `bg-muted`.
- **Ghost, destructive (tint), destructive-solid, link:** carried over; the dark theme's solid destructive confirm uses `#DC2626` rather than the dark destructive text colour (decision 9), used for the client's "Yes, cancel my booking."
- **Size:** 44px by default on the client (52px `lg`, 40px `sm` on a mouse only) — there is no separate 32px desktop size any more; every control stays at least 44px on a coarse pointer.
- **Motion:** a 1px hover lift (`motion-safe:hover:-translate-y-px`), 150ms colour transitions; no press nudge.

### Inputs / Fields
- **Style:** 2px radius, `--input` 1px edge, transparent fill, 16px text; 48px tall from `md`, 44px below and on touch. Label above (14px/500), hint below (13px muted), error below in danger (13px) with a `CircleAlert` icon, linked with `aria-describedby`.
- **Focus:** a `--ring` edge plus the 2px violet outline.
- **Checkbox:** a 20px square, 1.5px `--input` edge, fills brand violet with a white tick when checked.

### Cards / Containers
- **Corner style:** 2px radius, flat canvas fill, 1px hairline edge, no shadow.
- **Selectable card** (packages, add-ons, the payment method): resting is hairline + canvas; hover thickens the edge to muted-foreground with a 2px lift; checked switches to a violet edge and a tinted fill (`--selected`), with a 24px violet square and a white check that scales in (`tick`), the whole card playing one `pop`. The native input is visually hidden; focus draws the outline on the card via `has-focus-visible:`.

### Badges and status
- Rectangles, 2px radius, 13-14px/500. The client now uses the **console status mapping**, the same one the admin runs: four shapes carry the seven-to-however-many booking states — a filled check for a current success, an outlined check for an earlier one, a clock for waiting, a cross for failed/cancelled — with dashed and dotted edges keeping a hold and a lapsed hold apart in greyscale. The word is always shown; the shape and edge style only repeat it. `BookingPage` supplies the console variant through `StatusBadgeVariantContext` so the page pill and the `StageLegend` popover switch together.

### Callout
The console banner, full width, 2px radius, 18px icon, optional underlined trailing link. Tones: info (violet-tinted), success, warning, destructive. Used for the non-refundable notice, hold-expiry, "already waiting on your phone," the just-taken/check-failed slot messages, and the irreversible-cancel warning.

### Metadata tiles (FactGrid)
The admin's `StatGrid` look, re-implemented for the client (not imported from the admin): two columns from `sm`, a 64px (48px below `sm`) chip-coloured icon tile with a 20px icon, a mono label above the value. Status tiles take the status tint and icon. Used for booking facts, checkout facts and the held page's stats.

### Month grid and time slots (service page)
- **Days:** 44px square cells; open = hairline edge (strengthens on hover) with a 4px brand pip under the number; unavailable = faint disabled number, no edge; selected = inverted-neutral fill with the pip and a `pop`; today additionally gets a 2px violet underline offset 3px. A legend row states "Has open times" / "Selected" in words beside `aria-hidden` swatches.
- **Times:** 52px rows, two columns from `sm`, mono 16px time; hover takes a violet edge and violet text; selected is the brand fill with white text and a `pop`. Rows stagger in (`rise`) when a day is chosen.

### Money rows / step numerals
- Money rows: label left, mono amount right, tabular figures; the total is 500-weight mono 20px above a hairline. Step numerals are CSS-counter-generated mono `01`-`04` in a 48px bordered square, brand edge and numeral on hover.

### Status views (NotFound, pay notices, payment progress, invalid-link)
A 64px icon tile (or 40px bare icon on some status views) above the page title and body, then the booking facts. Tone: violet for waiting/information, danger for failure, muted for neutral, success only for an API-confirmed outcome. The waiting state's spinner is the one `animate-spin`, `infinite` motion on the client; it becomes a still `Clock` under reduced motion. The confirmed check draws once (`draw`, 600ms, one-time).

### Contact block (footer, summary "Questions?")
Renders only the fields set in `frontend/src/lib/contact.ts` (phone `tel:`, WhatsApp `wa.me`, email `mailto:`); with every field `null` neither renders at all. **The shipped values are placeholders** ("Studio name", `+250 700 000 000`, `hello@example.com`) to be replaced with the photographer's real contact details before launch — a recorded, deliberate exception to "nothing invented," not a design-system rule for other surfaces.

### Shell — header and footer
Public pages carry a shared header (wordmark, Services, How booking works, My booking, Admin login, the theme button, Book now) and a three-column footer (wordmark + contact block; Book; About), as siblings of `main`. Below `sm`, "My booking" collapses to its icon only (44px square, its words kept as the accessible name). **There is no Privacy link in the footer**: no privacy page exists in this build, so none is linked.

### Theme control
One button (not radios) in the header's right cluster, cycling System → Light → Dark → System, 44px square, ghost. Its accessible name and `title` state the current setting ("Theme: System" / "Theme: Light" / "Theme: Dark"); the icon shows the setting (`Monitor`/`Sun`/`Moon`). First paint is always light (`:root` default) before the layout effect resolves the real preference, so there is no flash and no dark-theme assumption at first render.

### Home — sections and the decorative mock-up
Hero (on a violet-hairline dot grid) → Services preview → How booking works → Good to know → Already booked? (an inverted band, merging the old closing section) → footer. The hero's mock-up is `aria-hidden`, pure HTML/CSS, and data-true, not invented: a month card built from the current Kigali month and real weekday/day math, with a small "held" preview card using the first real fetched service's name (or a generic fallback string) and today's date — not a fabricated photographer, portfolio or price. It plays one `fade-up` on load and otherwise never moves.

### Motion
Kept, behind `prefers-reduced-motion: no-preference` only: `fade-up` on hero/page-head load (600ms, staggered), a hover lift on cards and buttons, an arrow nudge on "Book" links, `pop` on selecting a package/day/time, `tick` on a chosen card's check square, staggered `rise` on time slots, a one-time `draw` on the confirmed check, and the single `animate-spin` waiting spinner (which itself falls back to a still `Clock` under reduced motion — the one animation not fully gated by the media query, by design, since it is the only functional one). Dropped entirely, not carried into the redesign: any looping/ambient motion — a marquee, floating hero cards, a pinging selected day, a blinking "live" dot, a shutter/flash, a draining bar, a phone "buzz," payment "wave" rings, a sliding toast, a step progress bar, and an error shake. Under `prefers-reduced-motion: reduce`, nothing moves; only colour changes remain.

## Do's and Don'ts

### Do:
- **Do** write every status, amount and time in words; let a badge shape, dot, tint or icon only repeat them.
- **Do** keep every client control at least 44px, on a mouse and on touch alike (48px fields from `md`).
- **Do** put keyboard focus in one 2px violet (`--ring`) outline offset 2px, on every interactive element in both themes.
- **Do** use tabular figures for amounts and times, and Geist Mono for eyebrows, labels-that-are-data, and references.
- **Do** reserve the brand-violet button fill for the one hero CTA; use the inverted-neutral fill for every other primary action.
- **Do** show green only for an outcome the API has actually confirmed.
- **Do** honour `prefers-reduced-motion: reduce` — no motion but colour change, except the one functional waiting spinner, which itself falls back to a still icon.
- **Do** keep icons lucide, 1.5px stroke, square caps, `aria-hidden="true"` when decorative.

### Don't:
- **Don't** use gradient text, glow shadows, a one-sided coloured stripe, modals, 3D/parallax/scroll-driven effects, or emoji icons — ruled out in `MASTER.md` section 2 and flagged by Impeccable's design hook.
- **Don't** add a shadow anywhere on the client; separation comes from a hairline edge, never elevation.
- **Don't** fill a primary action button with brand violet outside the one hero CTA.
- **Don't** show a green icon, tick or tint for a pending, received-but-unconfirmed, refunded or duplicated payment.
- **Don't** use the weak `--console-border-strong` edge on a field, checkbox or day/slot cell that must read at 3:1 unlabelled; use `--input`.
- **Don't** put muted text on the chip surface in light theme (4.40:1, below AA); keep it on canvas or the flat surface.
- **Don't** add a Privacy footer link until a privacy page exists (it is specified, not built).
- **Don't** treat the contact details in `lib/contact.ts` as final; they are placeholders and must be replaced before launch.
- **Don't** hard-code a colour, radius or font in a component; use the tokens in `index.css`.

## Admin console

Everything under `/admin`, sign in and reset password included, is a quiet developer console: flat planes split by 1px hairlines, 2px corners, no shadows or gradients, one violet accent and monospace for labels and machine values. It was built from the user's style guide and two reference screenshots (`docs/prompts/admin-console-redesign.md`). The full spec, with every token's oklch value and measured contrast, is `design-system/bookly/admin-console.md`; this section summarises what shipped. The 2026-09-27 client redesign adopted this same visual language for the public side (see the sections above) but the admin's own tokens, scope and behaviour below are unchanged and were verified pixel-identical across the change.

**How it is scoped.** While an admin page is mounted, `src/admin/theme.ts` sets `<html data-admin-theme="light|dark">`, and it removes the attribute when the page unmounts. Every admin token is declared under `:root[data-admin-theme=...]` in `index.css`, on the root rather than a wrapper, so Radix popovers portalled into `body` get them too. A client page never carries the attribute, and its screenshots were checked pixel-identical before and after the redesign. The `dark:` variant is scoped to the client's own `data-theme="dark"` and is never used for admin theming; the codebase's earlier `.dark` class block, which nothing applied, has been removed entirely (both palettes now live under explicit `data-theme`/`data-admin-theme` attributes, not `.dark`).

**Themes.** Light and dark follow the OS setting by default and change with it live. A System / Light / Dark control in the top bar overrides that per device (`localStorage`, key `bookly.admin.theme`). Blocked storage falls back to the OS setting without failing. The theme is applied before first paint.

### Admin colours
| Role | Dark | Light |
|---|---|---|
| Canvas | #0A0A0B | #FFFFFF |
| Raised surface (row hover, popover, status band) | #131315 | #FAFAFA |
| Chip / icon tile | #27272A | #F4F4F5 |
| Hairline | #27272A | #E4E4E7 |
| Field edge (3:1) | #63636B | #8E8E96 |
| Outline-button edge | #3F3F46 | #D4D4D8 |
| Text / muted | #F4F4F5 / #A1A1AA | #18181B / #71717A |
| Link and focus (violet) | #B9A2FF | #7C3AED |
| Active nav fill / text | #3A1784 / #D4C6FF | #F1ECFE / #7C3AED |
| Main action (inverted neutral) | #FAFAFA on #0A0A0B | #18181B on #FFFFFF |
| Success | #4ADE80 on #0F2E1C | #15803D on #EAF8EF |
| Danger text / solid confirm | #F87171 / #DC2626 | #B91C1C / #B91C1C |

**The Violet Is For Where You Are Rule.** Violet marks location and linkage: the active nav item, links, selected controls, info banners, the focus outline, and at most one headline badge on a page. The main action is never violet; it is the inverted neutral button, one per view. Green appears only for success and status.

### Admin type
Geist and Geist Mono, self-hosted with `@fontsource-variable`. The page title is 30px/600 at -0.02em (24px in the sign-in panel), a section heading 20px/500, body and nav 16px, and meta 14px muted. Eyebrows, table headers and tile labels are Geist Mono 12px/500, uppercase, at +0.1em, muted. Data values (references, times, durations, money) are Geist Mono 15px with tabular figures; history lines are 13px mono. Links are violet with no underline, except references, which are underlined mono.

### Admin shape, space and focus
- **Shape and depth:** 2px radius everywhere, with round shapes only for status icons. No shadows, except a faint one on the light popover.
- **Grid:** a 4px grid, sections 48px apart on desktop and 32px on a phone, panels padded 24px (16px on a phone).
- **Shell:** a 56px top bar of bordered cells (the mark, the breadcrumb, the theme toggle) over a 260px sidebar from `lg`. Below `lg` the same navigation reflows into rows. Content gutters are 48px on desktop and 16px on a phone.
- **Control sizes:** buttons and fields are 40px from `lg`, and 44px below it and on touch.
- **Focus:** one 2px violet outline, offset 2px, on every control in both themes. It is set once in `index.css`, where it beats the primitives' `outline-none`.
- **Icons:** lucide, drawn with a 1.5px stroke and square caps.

### Admin components
- **Shell and breadcrumb** (`src/admin/AdminLayout.tsx`, `breadcrumbs.tsx`): the breadcrumb reads Admin › section › booking reference. The booking page reports its reference through `useBreadcrumbTail`, so nothing is fetched twice.
- **Shared compositions** (`src/pages/admin/console/`): `PageHeader` (a mono eyebrow, the one `h1`, badges, a meta row and actions), `StatGrid` (square icon tiles, mono labels over values), `Toolbar` (filters joined into one bordered strip), `AuthFrame` (the sign-in and reset-password panel) and `classes.ts` (shared class strings for fields, links, table cells and type roles).
- **Opt-in variants in `components/ui`**, now shared with the client for status, badges and callouts:
  - Button: `console-outline` and `console-destructive-solid`, in sizes `console`, `console-sm` and `console-icon`.
  - Badge: `console`, `console-accent`, `console-success` and `console-count`.
  - `Callout variant="console"`: info, success, warning and destructive banners.
  - `Card variant="console"`: a flat panel.
- **Status** (`StatusBadge`, `StatusGlyph`, `StatusShapeGlyph`): the admin layout switches every badge under it, the legend popover included, to four shapes. A filled check is current, an outlined check an earlier success, a clock waiting, a cross failed or cancelled. Dashed and dotted edges keep a hold and a lapsed hold apart in greyscale, and the word is always there. The client now renders bookings through this same mapping.
- **Dialogs** (since 2026-09-27, `components/ui/dialog.tsx`, `console/FormDialog.tsx`): every admin create and edit form opens in a modal (the availability page's "Add block" stays inline). It closes on ×, Escape, the scrim and Cancel, scrolls inside itself on a short screen, and returns focus to its opener. Client pages still have no modals.
- **Calendar** (the FullCalendar block in `index.css`):
  - A hairline grid, mono hours and dates, and a violet chip for today.
  - Square events on the raised surface with a 3px status edge. A hold has a dashed edge, a block keeps its hatch, and a conflict is a 2px danger line inside the event.
  - A joined toolbar with a segmented view switch.

### Admin on a phone
Every admin page was checked at 320 and 375px in both themes: no horizontal scroll, every target at least 44px, and focus visible on every stop.
- **Bookings:** the table stacks each booking into one block whenever its own container is under 56rem, by container query. That covers phones, tablets and the narrow column beside the sidebar.
- **Forms and actions:** form button rows and page actions go full width on a phone.
- **Calendar:** month events shrink to the time and status glyph, with the status word kept for screen readers.
