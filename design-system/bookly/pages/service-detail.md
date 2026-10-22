# Service Detail and Booking Funnel — Page Design

> **Project:** Bookly · **Route:** `/services/:slug`
> **Files (Phase 3 section 2):** `pages/services/ServiceDetail.tsx` (owns all state) and its parts `SlotPicker.tsx`, `BookingDetailsForm.tsx`, `PriceSummary.tsx`, `BookingHeld.tsx`
> Generator template: UI UX Pro Max, 2026-09-19. Its "Product Detail" text recommended WebGL/Three.js 3D, physics lighting and parallax. That is wrong for a booking funnel and contradicts MASTER's own "avoid 3D effects"; it has been removed.
> This file overrides `design-system/bookly/MASTER.md` for this page. Read MASTER's "Hand-review addendum" first.
> **Applied 2026-09-20 (Phase 3 section 2)** to all five files. The choices made beyond this file (the shared `BackLink` and `Callout`, the selectable-card and step-numeral recipes) are in `MASTER.md` section 11.
> **Overridden 2026-09-27 by `design-system/bookly/client-front.md`** (the client front redesign, light and dark): the board's selectable cards with tick and pop, a month grid with pips, a today mark and a legend, 52px time rows, callout messages, 48px fields in two columns from `md`, and the console-look summary (client-front.md §8.3). The "no today marker" rule is lifted (a derived date, no new logic). The one-page structure, DOM order and every rule under "Do not" still hold.

> **Amended 2026-10-22 by the marketplace (Phase 6, R6.3, R6.4, R6.5).** The page lives at `/p/:handle/:slug`. See "Under a photographer (Phase 6)" at the end; it wins where it differs.

## The funnel on one page

The generator's "Funnel (3-Step Conversion)" maps onto this page, but as three progressive groups on one route, not three pages:

1. **Choose**: package (radio cards, nothing preselected) and optional add-ons (checkbox rows).
2. **Pick a time**: month calendar, then the bookable starts for the chosen date. Appears only once a package is chosen; before that a placeholder heading + hint (`services:picker.choosePackageFirst`).
3. **Your details**: the booking form. Also appears only once a package is chosen.

The submit control lives in the price summary and is shown only once a start is chosen (otherwise the hint `services:booking.chooseTimeFirst`). On success the whole page is replaced by the held-booking summary (`BookingHeld`).

Step numbers: mark groups 1-3 with **CSS counters only** (numerals in the heading font, no new text). Add-ons belong visually to step 1 and are not numbered.

## Layout

- `main`, `max-w-5xl`, `px-4 py-8`, `gap-6`.
- Top: back link ("<- All services", muted sm; use the text-link treatment from `MASTER.md` section 11, with an `ArrowLeft` icon in place of the "←" character) -> header: cover image (`aspect-21/9`, `rounded-xl`, `object-cover`) -> `h1` (3xl semibold) -> description (`whitespace-pre-line`, muted).
- Below the header, from `lg`: grid `[1fr_22rem]`, `items-start`, `gap-6`. Left column = groups 1-3; right column = price summary, `lg:sticky lg:top-4`.
- Below `lg`: single column in DOM order: package -> add-ons -> picker -> form -> **price summary + submit last**. Keep that order (reading order and tab order follow it). Give the summary a clear top separation so it reads as the closing step.

## Selectable cards (packages, add-ons, and the same pattern in `PaymentFields`)

- Native radio/checkbox stays visible and keeps `accent-primary`. The card is the label.
- Selected state must not rely on the 1px border colour alone: add a tinted fill (`has-checked:bg-primary/5`) and keep the focus ring (`has-focus-visible:ring-3`).
- Package card: name (medium) + price (semibold, `tabular-nums`, right) on one wrapping row; then "N photos · duration" muted; then optional description (`whitespace-pre-line`).
- Add-on row: name (flex-1) + price (`tabular-nums`).

## Slot picker (`SlotPicker`)

- One bordered `rounded-xl` panel, `p-4`, `gap-3`: month row (icon-only outline prev/next buttons with `aria-label`, month title `aria-live="polite"`); 7-column day grid; then status lines.
- Day cell (`h-10`, `rounded-lg`, `tabular-nums`): **available** = bold text on the `muted` surface, hover darker; **unavailable** = disabled, muted at ~50%, no surface; **selected** = `bg-primary text-primary-foreground`. Available vs unavailable must differ by weight *and* surface, not colour alone. No "today" marker exists; do not add logic for one.
- Times: `grid-cols-3 sm:grid-cols-4`, outline buttons, selected = default variant, `aria-pressed`. **Make time buttons at least 44px tall** (today 32px, the `default` size); mobile is the main device.
- Messages: "just taken" and "check failed" are `role="alert"`, `text-destructive`, `font-medium`, and receive focus (`tabIndex=-1`); "checking" and "selected" are `role="status"`. Keep all of it.
- Empty month, loading and load-failed (alert + outline "Retry") states all stay.

## Details form (`BookingDetailsForm`)

- Single column, `gap-4`; label above each field; hints under the field; error under the field (destructive, linked with `aria-describedby`). Raise hints and errors from `text-xs` to `text-sm`.
- Fields: name, email, phone (hint), location, party size (hint, numeric), special requests (textarea, hint), consent checkbox row (whole row is the label, text `text-sm`, box `size-4`).
- Inputs at least 16px text on mobile and 44px tall (no iOS zoom). The form is `noValidate` and uncontrolled: keep.

## Price summary (`PriceSummary`)

- Card: `bg-card rounded-xl border p-4`, `gap-3`. Lines as a `dl`: label left, amount right, `tabular-nums`.
- Hierarchy: total row (`border-t`, base, semibold) > booking fee row (`font-medium`, this is "due now") > session fee row (regular, "after the shoot").
- The **non-refundable notice** is always visible and is rendered **before** the submit control; no control leading to payment may come before it. Give it a callout treatment: subtle tinted surface, full border, small icon (`aria-hidden`). **No left-border stripe** (Impeccable flags `side-tab`).
- Submit: full-width default button; `aria-disabled` while submitting (not `disabled`). Submission errors appear below it as `role="alert"`.

## Held booking (`BookingHeld`)

- Replaces the page content inside the same `main`; `section`, `max-w-2xl`, left-aligned. `h1` (3xl) takes focus on mount (`tabIndex=-1`, `outline-none`).
- The **reference** is the thing the client keeps: mono, semibold, larger than surrounding text.
- Summary `dl` card (reference, service, when, package, add-ons, total, booking fee, session fee) then: hold-expiry sentence (give it a callout with a clock icon, it is time-critical), non-refundable notice, then the **"Pay" button**, `size="lg"`, the only prominent action. It renders only when `checkoutToken` exists.
- No countdown timer: the API gives a time, not a live counter, and adding one is new logic.

## Page states to cover

loading; load failed (alert + retry); missing slug (renders `NotFound`); no packages (muted text); package chosen with no start; start chosen; submitting; submit refused (`failed`, `catalogueChanged`, invalid fields, slot taken); held.

## Do not

- No modal, wizard or stepper text, no new copy, no motion beyond 150-300ms state transitions.
- Do not move the price summary above the form on mobile (changes reading order).

## Under a photographer (Phase 6, 2026-10-22)

- **Route** `/p/:handle/:slug`; the booking flow (packages, add-ons, slot picker, form, summary, held page) is unchanged, and so is its tab order: the skip link, then **All services** (the back link, now to the photographer's profile), then the first package. Three e2e specs pin that order.
- **Whose service:** the mono eyebrow above the `h1` names the photographer (unchanged, not a link, so the tab order holds).
- **Your photographer panel**, new, in the right column under the price summary (below `lg`: after it, last on the page): a hairline panel, `p-5`, eyebrow "Your photographer", the display name as a link to `/p/:handle` ("View profile" is its visible verb line), then the profile's contact channels that are set (`PhotographerContact`: phone, WhatsApp in a new tab with `rel="noopener noreferrer"`, email). It comes after Confirm in the tab order, so nothing leading away sits before the payment notice.
- **The price summary loses its "Questions?" line.** It showed the placeholder `PHOTOGRAPHER_CONTACT` (R6.4 removes it); the panel above carries the photographer's real channels instead, and nothing when none are set.
- **Cover image:** only through `safeHttpsUrl`, `referrerpolicy="no-referrer"`. A non-https URL shows no cover.
- **Meta (R6.6):** "Portraits by Kigali Lens · Bookly"; the description is the service's own (first 155 characters), else "Choose a package and a free time to book Portraits with Kigali Lens."
