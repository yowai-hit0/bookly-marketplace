# Account Booking — Page Design

> **Project:** Bookly · **Routes:** `/account/bookings/:reference`, and `/account/bookings/:reference/payments/:ourRef` (the payment's progress) · **Files:** `frontend/src/pages/account/AccountBookingPage.tsx`, the shared `frontend/src/pages/booking/BookingView.tsx`, `pages/checkout/PaymentProgressPage.tsx`
> **Written:** 2026-10-27, Phase 8 (marketplace spec R8.1, T8.1, T8.2). The booking's own look is `booking.md` and `client-front.md` §8.5; this file says only what differs.
> **API:** `GET /api/account/bookings/:reference` → `{ booking, photographer: { handle, displayName, contactPhone, whatsappPhone, email }, checkoutPath }`; `POST …/cancel`; `POST …/payments { method, phone }`; the progress polls the public `GET /api/payments/:ourRef`.

## One view, two doors

`booking` is **exactly** the guest page's view (the backend compares the two byte for byte), so the page is drawn by the guest page's own parts: `BookingView` (header, notices, facts, amounts, delivery, session fee, the two-step cancel, the cancelled summary), refactored out of `BookingPage.tsx` in Phase 8. The guest page and this one differ only in:

- **how they act** (`BookingActions`): the guest page posts to `/api/booking/<token>/…`, this one to `/api/account/bookings/<reference>/…` under the bearer token. The outcomes are the same, so every message is the same;
- **where a payment is followed**: `/account/bookings/<reference>/payments/<ourRef>`;
- **what sits after the amounts** (`afterSummary`): the guest page's "Your email" (the booking's contact email stays on the guest page: the booking's emails are the booking's, not the account's), and here the hold notice and **Your photographer**.

## Layout

`main` (`container`, `pageY`, `max-w-3xl`, `flex-col gap-6`), under the account nav, Bookings current.

1. **Back link** "All bookings" → `/account`, first in `main`.
2. The shared view, in its order (`booking.md`), with after the amounts:
   - **Not confirmed yet** (only `pending_payment` with a safe `checkoutPath`): a hairline panel, `h2`, the info callout "This time is held for you, but not booked yet. Pay the booking fee before the hold ends to confirm it." and the inverted **Finish payment** → the checkout. The detail carries no hold time; the checkout page shows it.
   - **Your photographer**: a hairline panel, `h2`, the display name (16px / 500), then `ContactList` (the profile's own component: phone `tel:`, WhatsApp `https://wa.me/…` in a new tab with `rel="noopener noreferrer"`, email `mailto:`, only the channels set, 44px on touch). None set: one secondary line, "They have not shared contact details on Bookly yet. Their profile has their services and terms." Always the text link **See their profile** → `/p/:handle`.
3. Cancelling follows **that photographer's policy as the booking kept it** (`cancellation.deadline`, `bookingFeeRefundable`): the terms sentence above the button, the warning naming the fee "is not refunded" or "is refunded to you", then the solid red confirm (T8.2: both branches tested).

## The payment's progress

`/account/bookings/:reference/payments/:ourRef` is `PaymentProgressPage` with two props: **pay again** leads back to this booking (not the checkout or the guest link), and a **Back to your booking** back link sits under the booking facts on every settled or waiting view. Polling, wording and outcomes are the guest flow's.

## States

loading (`booking:loading`, `role="status"`); failed (destructive callout + Try again); **not found**: a reference that is not the account's is the API's one `404`, the same as one that names nothing, so the page shows a neutral `SearchX` tile, `h1` "Booking not found", "There is no booking with that reference on this account. It may belong to another account, or the address may be mistyped." and nothing about any booking (no amount, no button); a cancel or payment answered 404 turns the page into the same state. Everything else is `booking.md`'s.

## Do not

- No access token anywhere: the page has none, and never asks for one.
- No contact-email change here.
- No second copy of any guest-page section: changes go in `BookingView.tsx`, so both pages follow.
