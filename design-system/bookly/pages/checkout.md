# Checkout and Payment Progress — Page Design

> **Project:** Bookly · **Phase 3 section:** 3
> **Routes:** `/checkout/:reference/:token` (pay page) and `/checkout/:reference/:token/payments/:ourRef` (progress). The progress page is **also reused** at `/booking/:token/payments/:ourRef` (see `booking.md`), so it must work for both the booking fee and the session fee.
> **Files:** `pages/checkout/CheckoutPage.tsx`, `pages/checkout/PaymentProgressPage.tsx`, `pages/checkout/PaymentFields.tsx`. `PaymentFields` is also used by `BookingPage`; one visual definition for both.
> Generator template: UI UX Pro Max, 2026-09-19 (1200px width replaced by the shipped `max-w-2xl`; the "admin feedback" effect note was boilerplate).
> This file overrides `design-system/bookly/MASTER.md` for these pages. Read MASTER's "Hand-review addendum" first.
> **Applied 2026-09-20 (Phase 3 section 3).** Two things the file left open were decided while applying it: the icon and tone of each view, and the reduced-motion fallback for the spinner. Both are in `MASTER.md` section 11.
> **Overridden 2026-09-27 by `design-system/bookly/client-front.md`** (the client front redesign, light and dark): facts as metadata rows, the method as a selected card with a text chip, icon-tile status views and a one-time check draw on confirmed (client-front.md §8.4), which lifts "no animated checkmarks" for that single draw only.

## Shared shell

`main`, `max-w-2xl`, `px-4 py-8`. A single narrow column is right for payment: no side content, no site navigation (none exists). Keep.

## Pay page (`CheckoutPage`)

Order: `h1` (3xl) -> summary card -> hold-expiry line -> non-refundable line -> optional "waiting" banner -> payment form.

- **Summary card** (`dl`, `bg-card rounded-xl border p-4`): reference (mono, semibold), service, when, then the **fee row** (`border-t`, semibold, `tabular-nums`). The fee is the amount the client is about to pay; it is the emphasised number on the page.
- Hold-expiry and non-refundable lines: same callout treatment as the service-detail price summary (tinted surface, full border, small `aria-hidden` icon; no left-stripe). Non-refundable stays before the form.
- **Waiting banner** (`checkout.waitingPayment`): an info callout on the `muted` surface with the existing link "follow payment". Needs a distinct surface from the page background (see MASTER addendum, section 3 and D3: the generated `muted` is 1.02:1 against the page).
- **Form**: `PaymentFields` (fieldset with legend, radio cards, conditional phone field) then the pay button. Pay button: `w-full` on mobile, `sm:w-auto sm:self-start` from `sm`; label carries the amount; `aria-disabled` while submitting (not `disabled`); error below as `role="alert"`.
- Usually only one method (MTN MoMo) is offered; it still renders as a radio card. No methods -> destructive `role="alert"` text.

### Notice states (`Notice`): paid, closed, expired, invalid link

- Centred status message: `h1` (2xl, takes focus) + muted body; `expired` also has a text link to `/services`. Decorative icon above the heading is fine (`aria-hidden`).
- Tone: paid = positive, expired = warning, closed and invalid link = neutral. Words always carry the meaning.

## Payment fields (`PaymentFields`)

- Fieldset legend: lg semibold. Radio cards use the shared selectable-card pattern from `service-detail.md` (tinted selected fill + focus ring, not border colour alone).
- Phone: label, `Input type="tel"` (16px text, 44px tall), hint (`text-sm` muted), error (destructive, linked by `aria-describedby`). Renders only when the chosen method needs a phone.

## Progress page (`PaymentProgressPage`)

This page is the whole experience of a Mobile Money wait that routinely takes 30s or more. It polls every 3s and says "confirmed" only when the API reports success.

**Hard invariant: the visual design must never imply success while the outcome is unknown.** No green tick, no celebratory colour, no "done" iconography in `waiting`. Success styling is reserved for `confirmed`.

Structure per outcome: status block (icon + `h1` + body copy) then the booking summary card (reference mono, service, when).

| View | Tone | Notes |
|------|------|-------|
| waiting | neutral / brand blue | indeterminate progress indicator (spinner or bar) that stops under `prefers-reduced-motion`; `role="status" aria-live="polite"`; the three body lines keep their order (pending, wait, leave-if-you-like). No `h1` focus move while waiting. |
| waiting, gave up | neutral | "still waiting" line + outline `sm` "Check again". |
| confirmed | positive | the only success treatment. `h1` takes focus. |
| received | info | payment received but booking not confirmed / expired: must **not** look like `confirmed`. |
| failed | destructive | default-variant "Try again" link-button (`asChild`). |
| refund, refundOther, duplicate | warning / neutral | amount shown in the copy; no success colour. |
| loading, couldNotCheck, connection trouble, invalid link | neutral | `couldNotCheck` has an outline "Check again". |

Every outcome change moves focus to its `h1` (`tabIndex=-1`); keep that.

## Do not

- No confetti, animated checkmarks, countdowns or auto-redirects. The page says "confirmed" only when the API reports success, never on a timer, redirect or guess (plan.md Tasks 16-17).
- No new copy. No reordering of the notice before the form.
