# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Clients** are public visitors who book photo shoots (portraits, corporate, events, product) with a photographer in Kigali, Rwanda. They use phones and desktops in roughly equal measure, and some may have non-Rwandan phone numbers. Booking is guest-only: no account, just name, email and phone, and each booking gets a private magic link (emailed) to return to it. Most clients are expected to book once or occasionally.

**The admin** is one non-technical photographer who runs the business: bookings, calendar, catalogue and post-shoot delivery. There is exactly one admin; multiple staff accounts are out of scope.

## Product Purpose

Replaces the photographer's WhatsApp + personal-calendar workflow, which caused double bookings. Clients self-serve: pick a service and package, see live availability, and pay a booking fee to hold the slot. The photographer works from one calendar as the single source of truth and handles the post-shoot steps (session fee, photo delivery) in the same place.

Success means no double bookings and fewer back-and-forth messages.

## Positioning

*Inferred from the brief and spec; not yet confirmed.* Availability is checked live against confirmed bookings, live holds and the photographer's own blocks. A slot is held while the client pays the booking fee, and the hold expires by itself if they don't. A WhatsApp thread plus a personal calendar cannot offer a slot only once.

## Operating Context

- Times are Africa/Kigali (UTC+2, no DST). Prices are in RWF.
- **Booking fee:** 40% of the total by default, changeable globally and per service. Paid up front to confirm the slot. Not refundable if the client cancels (the client's own answer). If the photographer cancels, the fee is owed back in full (a developer-proposed default, spec A-5).
- **Session fee:** the remainder of the total, paid after the shoot. Post-shoot add-ons can raise it.
- **Refunds** are made by the photographer outside the system; the system only records that one was issued.
- **Photos** are delivered as an external link the photographer pastes (he has used WeTransfer). The site sends a branded email and shows the expiry date; the default is 90 days.
- **Payments:** Mobile Money is required. Only MTN MoMo (direct) is live today. Airtel Money and card (the client said yes to card) are planned via Flutterwave and not built.
- **Emails** go to the client (confirmation, payment receipt, reschedule, cancellation, session-fee request, photo delivery, access-link resend) and to the admin (new booking, alerts). The client uses Google Calendar; a one-way push of confirmed bookings is planned and not built.
- **Availability defaults:** 30-minute start grid, 30-minute buffer between shoots, 2 hours' minimum notice, 30-minute hold. Working hours are seeded Mon–Fri 09:00–17:00, which the developer chose and the photographer has not confirmed (events often fall on weekends, spec R-4).

## Capabilities and Constraints

- **Catalogue:** Service -> Packages (price, photo count, duration) + Add-ons (per service or shared). Admin-editable; something in use is deactivated, not deleted.
- **Terminology:** booking fee (paid to hold), session fee (paid after), reference (booking id shown to the client), hold, magic link. Statuses: `pending_payment`, `confirmed`, `completed`, `no_show`, `expired`, `cancelled_by_client`, `cancelled_by_admin`.
- **Admin surfaces built:** calendar (month, week, day; read-only), bookings list with filters and search, booking detail (reschedule, cancel, complete, no-show, resend link, post-shoot add-ons, session-fee request, record refund, attach and send delivery link), catalogue editing.
- **Specified, backend exists, no UI yet:** weekly working hours and dated open/close overrides, availability blocks (with an overlap warning), settings (fee rate, notice, hold, buffer, delivery days), admin password reset.
- **Specified, not built:** privacy notice and erasure routine.
- **Visual redesign guardrails:** behaviour and copy are protected. Business logic in `frontend/src/{catalogue,admin}/*.ts` and `frontend/src/i18n/locales/en.json` must not change (see `docs/redisign.md`).
- **Undecided:** SMS/WhatsApp notifications (client: "both would be ideal"; the brief lists them out of scope). French (the client wants English and French; English only at launch). A real landing page (Home is an API-status stub; `/services` is the actual entry point). A way to reach the photographer.

## Brand Commitments

The name is "Bookly" (final). No logo, brand colours, or social/portfolio links exist. Copy is plain, direct and second-person, and states money and time explicitly: what is owed, when, and what is non-refundable. Existing copy lives in `frontend/src/i18n/locales/en.json`.

## Evidence on Hand

- Real product copy: `frontend/src/i18n/locales/en.json`.
- Requirements and client answers: `docs/brief.md`, `docs/clien-answers.md`, `docs/specs_v2.md`.
- Service cover images are URLs the admin pastes.
- **Absent; must not be fabricated:** portfolio, testimonials, logo, photographer's name, real service names and prices (spec R-6), any contact channel for the photographer, social links.

## Product Principles

1. A slot is never sold twice; availability truth outranks everything else.
2. Say what is owed, when, and what is non-refundable, in plain words, before the client commits.
3. One-time clients get zero friction: no account, one link back to their booking.
4. The admin tool serves one non-technical person: few steps, plain language, no jargon.
5. Nothing is claimed that isn't real: no invented proof, and nothing says "confirmed" until the API does.
