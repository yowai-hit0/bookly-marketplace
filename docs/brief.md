# Project Brief: Photographer Booking Platform

## 1. Project Overview

The client is a professional photographer based in Kigali, Rwanda, offering photoshoots, event coverage, and product photography services.

Bookings are currently managed manually via WhatsApp and a personal calendar. This process has led to **double bookings**, since there is no single source of truth for which dates/times are already reserved.

The client needs a website that lets clients book his services directly, checks availability automatically, and gives him an admin panel to manage bookings, availability, services, pricing, payments, and photo delivery — replacing the WhatsApp/calendar workflow.

## 2. Goals

- Eliminate double bookings by centralizing all booking requests and availability in one system.
- Let clients self-serve: browse services, check availability, and submit a booking request online.
- Give the photographer full control over his services, pricing, and calendar from an admin panel.
- Streamline the post-shoot workflow: requesting the final payment and delivering photos.

## 3. User Roles

| Role | Description |
|---|---|
| **Client** | Public visitor who browses services and submits booking requests. |
| **Admin** (the photographer) | Manages bookings, availability, services, pricing, and post-shoot communication. |

*(Whether clients need an account or can book as guests is an open question — see `questions.md`.)*

## 4. Core Features

### 4.1 Client Booking Flow
- Client browses available services (photoshoots, events, product shoots).
- Client selects a service and requests a date/time.
- The system checks the admin's availability (booked dates + dates the admin has manually blocked) and prevents requests for unavailable slots — this is the core fix for the double-booking problem.
- Client submits the booking request, which goes to the admin for confirmation.

### 4.2 Admin Panel — Booking & Availability Management
- View incoming booking requests (pending/confirmed/declined).
- Confirm or decline booking requests.
- Manually block or set dates/times as unavailable (e.g. personal time off, existing offline commitments).
- A single calendar view is the source of truth, preventing any date from being double-booked.

### 4.3 Service Management
- Admin can add, edit, and remove services.
- Each service has a name, description, and price.
- Pricing is configurable per service based on factors such as number of photos delivered, session duration, etc.

### 4.4 Fees & Payments
- **Booking fee**: paid by the client at the time of booking, to confirm/hold the date.
- **Session fee**: paid by the client after the photoshoot is completed.
- Exact rules for how these fees are calculated, whether they're refundable, and what happens on cancellation are **not yet defined by the client** — see `questions.md` (Fees & Payments section) before implementation.
- **Payment method**: Mobile Money (MTN MoMo / Airtel Money) is required. Support for card payments is an open add-on question for the client.

### 4.5 Post-Shoot Workflow
- After the photoshoot, the admin sends the client an email requesting the session fee payment.
- The admin delivers the final photos to the client, either by:
  - Uploading photos directly and sending a download link, or
  - Sending a link to the photos (hosted elsewhere) via email or copy/paste.
- The exact photo delivery mechanism (built-in hosting vs. external link) is **not yet defined** — see `questions.md`.

### 4.6 Notifications (inferred, not explicitly requested)
- Email confirmation to the client when a booking request is submitted/confirmed.
- Email/alert to the admin when a new booking request comes in.
- *(To be confirmed with the client — see `questions.md`.)*

## 5. Assumptions & Open Questions

The following are not yet defined by the client and should not be assumed during implementation. Full detail in `questions.md`:

- Booking fee / session fee structure: fixed vs. percentage, refund policy, cancellation/no-show handling.
- Photo delivery mechanism: built-in file storage vs. pasting an external link.
- Whether clients need accounts, or can book as guests.
- Whether card payments (in addition to Mobile Money) are needed.

## 6. Out of Scope (for now)

Not mentioned in the original brief, and not assumed as requirements unless confirmed by the client:
- Multiple photographers/staff accounts.
- SMS or WhatsApp Business API integration.
- Multi-language support.
- Client reviews/testimonials or a public portfolio/gallery beyond the service listings.
