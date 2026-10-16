# My Booking (client magic-link page) — Page Design

> **Project:** Bookly · **Phase 3 section:** 4
> **Route:** `/booking/:token` (the emailed private link). Its child `/booking/:token/payments/:ourRef` renders `PaymentProgressPage`; design that in `checkout.md`.
> **File:** `frontend/src/pages/booking/BookingPage.tsx` (contains `BookingView`, `Amounts`, `Delivery`, `SessionFee`, `Cancel`).
> Generator template: UI UX Pro Max, 2026-09-19 ("General", 1200px grid). Replaced: this is a single narrow account-style page.
> This file overrides `design-system/bookly/MASTER.md` for this page. Read MASTER's "Hand-review addendum" first.
> **Applied 2026-09-20 (Phase 3 section 4).** The status pill is the shared `StatusBadge`; the choices made beyond this file (the destructive `Callout` tone, the solid confirm button, the refund and expired-link notes) are in `MASTER.md` section 11.
> **Overridden 2026-09-27 by `design-system/bookly/client-front.md`** (the client front redesign, light and dark): a page header with the console status badge, facts as metadata tiles, console callouts and inverted / outline actions (client-front.md §8.5).

## Who and how

The client opens this from an email, usually on a phone. The token in the URL is the whole of their identity, so the page shows no navigation and an invalid, expired or replaced link gets the same "link is not valid" page as one that never existed. Design for 375px first.

## Layout

`main`, `max-w-2xl`, `px-4 py-8`, `gap-6`. Sections in DOM order (keep it), each present only when relevant:

1. **Header row**: `h1` (3xl) + status pill (right, wraps under the title on narrow screens).
2. **Details card** (`dl`): reference (mono, semibold), service, when, location, people (if any), photos, requests (if any, `whitespace-pre-line`).
3. **Amounts card** (`dl`): package, add-ons, **total** (`border-t`, semibold), paid, **outstanding** (`font-medium`), refund due (only if > 0). Amounts right-aligned, `tabular-nums`. Outstanding is the actionable number: emphasise it when > 0. Refund due is informational: destructive-toned text plus its existing label.
4. **Delivery** (if `delivery`): title, optional note, then either "expired" text or the "Open photos" button (`asChild` external link, `target="_blank"`) with a muted expiry date.
5. **Session fee** (if `sessionFee`): card with title, intro carrying the amount, optional waiting banner, then `PaymentFields` and the pay button (`w-full sm:w-auto`), same look as the checkout page.
6. **Cancel** (if `canCancel`): a two-step control. Step 1 is an outline button. Step 2 shows the warning (`font-medium`, states the non-refundable fee) in a destructive-tinted callout, a **destructive** confirm button and an outline "keep" button. Confirm takes focus (`confirmRef`); keep that.
7. **Refused alert** and 8. **Cancelled summary** (if `cancelledAt`: title, reason, refund-due sentence).

Cards: one visual definition shared with the rest of the app (see MASTER "Card surface").

## Notices (2026-09-25, user decisions; prompt item 8)

Under the title and pill, above the booking facts (`Notices.tsx`): a list, newest first, of what has happened, as the API builds it from what it sent the client (`backend/src/booking/notices.ts`: moved, a fee asked for, a payment received, photos sent, cancelled by the photographer), money still owed once the shoot is done ("33,000 RWF is still to pay. Pay now", linking to `#pay`), and the photographer's notes ("From your photographer:", plain text, line breaks kept).

- Each is a small card: an icon, one sentence, when, and a ghost "Dismiss" (X) button.
- Shown until dismissed, or until a day after this device first showed it, remembered in `localStorage` per booking reference. **Money still owed is never hidden by time**, only by dismissing it, and a new amount shows again.
- Nothing to show: nothing renders, no empty box.
- The API copies only each kind's own fields; no email payload reaches the page (several hold a link token).

## Your email (2026-09-25, user decisions; prompt item 6)

A card after the booking facts and amounts (`ContactEmail` in `BookingPage.tsx`), only while the booking is `confirmed` or `completed`: an `h2` "Your email", one line "We write to a•••••@example.com about this booking.", and an outline `sm` "Change email" that opens an inline form (New email, a hint that nothing changes until the new address uses our link, **Send the link** default `sm`, **Keep this email** outline `sm`).

- **The page never carries a full email** (user decision, 2026-09-25, keeping the older "no email in the view" rule in spirit): the API sends `maskedEmail` and `pendingMaskedEmail`, the first character, five dots and the domain. A forwarded or leaked link does not give the address away. The one exception is on the client's own screen: straight after they type a new address, the "check your inbox" message repeats what they typed.
- After asking: an info callout (`role="status"`), "Check <typed address> for our link to confirm the change. Until then we keep writing to <masked current>." While a change waits, on any later visit: "Waiting for you to confirm <masked pending> from its inbox…".
- The change takes effect only from the link sent to the new address (`/email-confirm/:token`, `pages/email-confirm.md`); the old address is told once it does. The booking's own link keeps working.
- Refusals in words: an invalid address on the field; three requests a day, then "Try again tomorrow"; "That is already the email we write to."

## Status pill

**Since 2026-09-25** the pill shows the display stage (MASTER section 7): in progress while the shoot runs, completed once it has ended (the client never sees `needs_review`), closed once the photos email has gone. An info button beside it opens "What the statuses mean".

Today every status renders in one `bg-muted rounded-full` style, and `muted` is nearly invisible on the page background. Use the shared treatments in MASTER "Booking status treatments". The text label is always shown; tone and icon are secondary. This pill and the admin badges must look like the same system.

## States

loading (muted `role="status"`); load failed (destructive alert + outline retry); invalid link (`h1` + muted body); ok; cancelling; cancel failed / refused; session fee: waiting payment, no methods, phone invalid, start failed.

## Do not

- No account chrome, avatar or logout: the client has no account.
- Do not compute or "fix up" any amount; every number is the API's.
- No new copy; no confirmation dialog (the two-step inline control is the design).
