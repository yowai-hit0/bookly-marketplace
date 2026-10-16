# My booking (lost link) — Page Design

> **Route:** `/my-booking`, inside the client shell · **File:** `frontend/src/pages/booking/MyBookingPage.tsx`
> **Added 2026-09-25** (user decision; `docs/prompts/client-access-and-admin-polish.md`, item 4). Reverses the 2026-09-21 "no public resend" in `client-shell.md`.
> **Overridden 2026-09-27 by `design-system/bookly/client-front.md`** (the client front redesign, light and dark): the narrow centred panel, a 48px field, an inverted submit and a success callout (client-front.md §8.5).

A client who lost their booking link types the email they booked with and gets one email listing each current booking with a fresh link: confirmed bookings still ahead, and completed ones that still owe money or whose photos are still downloadable.

## Layout

- One `main`, `max-w-xl`, `px-4 py-8`, `gap-6`. An `h1` ("Find your booking") and one muted intro line.
- The form: `Label` + email `Input` (`autocomplete="email"`), a muted hint that older links stop working, the field error below it when present, and one default button, "Email me my links".
- After sending, the form is replaced by an info `Callout` (`role="status"`, `MailCheck` icon) and an outline `sm` "Use a different address".

## The one rule: say the same thing whatever happened

The API answers 202 for a match, no match and a rate-limited request alike, before doing any of the work. The page therefore shows **one** message after sending: "If we found a current booking for that address, we have emailed you a link." Never "we found your booking", never "no booking for that address". This page must not tell anyone who books.

## States

idle; sending (button label swaps, `aria-disabled`); sent (the callout); invalid (a field error, focus back on the field, nothing sent); failed (a `role="alert"` line, the form kept with its value).

## Reached from

- The invalid-link page (`BookingPage`, "Get a new link by email", a link, not a button: `client-booking.spec.ts` asserts that page has no button).
- The header's "My booking" link when this device holds no booking link (item 5).
