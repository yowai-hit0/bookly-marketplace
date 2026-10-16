# Bookly — Photographer Booking Platform
## Technical Specification (v2 — decisions resolved)

| | |
|---|---|
| **Client** | Bookly (single-photographer studio, Kigali, Rwanda) |
| **Source inputs** | `brief.md`, `clien-answers.md`, `spec.md` (v1), decision session 2026-09-08 |
| **Supersedes** | `spec.md` (v1). Where the two differ, this document wins. |
| **Status** | All 16 v1 ambiguities resolved (§8.1). Seven residual items remain open (§8.2) — none block the start of development. |
| **Revision** | 2.3 — admin authentication moved from a `SameSite=None` session cookie plus CSRF token to a JWT bearer token (§7). The CORS allowlist no longer enables credentials, and the CSRF token flow is removed, not reinstated. 2.2 — reverted frontend and backend to two separately-deployed apps on separate domains (was one deployable in 2.1). CORS allowlist and CSRF token flow reinstated in §7; **R-7 reopened** (§8.2), not solved. 2.1 — audit fixes. §5 gutted in favour of `data-model_v2.md`; seven cross-reference and consistency errors corrected; TOTP, the invite flow, scheduled purges and locale routing removed; R-7 closed (superseded by 2.2). |
| **Launch target** | No fixed date. Build to this spec; §4.2 is a quality boundary, not a deadline defence. |
| **Currency / timezone / language** | RWF only · Africa/Kigali (UTC+2, no DST) · **English at launch, French-ready architecture** |

### Settled operating values

| Value | Setting key | v1 value |
|---|---|---|
| Working days and hours | `working_hours` | Mon–Fri, 09:00–17:00 (Sat/Sun closed) |
| Slot start grid | `slot_granularity_minutes` | 30 |
| Buffer after each shoot | `buffer_minutes` | 30 |
| Minimum booking notice | `min_lead_time_minutes` | 120 |
| Unpaid slot hold | `hold_minutes` | 30 |
| Booking fee | `booking_fee_rate` | 0.40, overridable per service |
| Delivery link lifetime | `delivery_expiry_days` | 90 |

---

## 1. Overview

Bookly is a public booking website plus a private admin panel for a professional photographer in Kigali who currently takes bookings over WhatsApp against a personal calendar. Its users are two: prospective clients booking photoshoots, event coverage, and product photography, and the photographer himself as the sole administrator. The system exists to end double bookings by making one database the single source of truth for availability, to let clients self-serve from browsing a service through to paying a non-refundable 40% booking fee that locks the date, and to carry the job to its end — session-fee collection after the shoot and a branded photo-delivery email. Services are sold as admin-editable packages with optional add-ons, priced in RWF. Clients return to their booking through a secure per-booking link rather than an account. The site ships in English with its translation layer in place so French can be added without rework, and confirmed bookings are pushed one-way into the photographer's Google Calendar as a read-only convenience mirror.

---

## 2. Users & Roles

### 2.1 Roles

| Role | Identification | Can see | Can do |
|---|---|---|---|
| **Visitor** | None (anonymous) | Service list, service detail, packages, add-ons and prices, available dates and time slots, static pages, privacy notice | Browse services, check availability, start a booking, pay a booking fee |
| **Booking client** | A secure per-booking link (unguessable token, emailed at confirmation) — **one booking per link** | That one booking only: status, date/time, service and package, amounts due and paid, delivery link and its expiry date | Reopen that booking, download delivered photos, cancel it, pay its session fee |
| **Admin (photographer)** | Email + password | Everything: full calendar, all bookings, all client contact details, all payments, all deliveries, notification log, settings | Manage availability and blocks, cancel/reschedule/complete bookings, mark no-shows, create and edit services, packages and add-ons, adjust prices and per-service booking-fee rates, record payments and refunds, send session-fee requests, attach delivery links, resend emails |

**Constraints on roles:** exactly one admin account. No staff/second-photographer role, no permission tiers, no client-to-client visibility. A client holds one token per booking and never sees another booking, another client, or a block reason — blocked time is rendered simply as unavailable.

### 2.2 Permission matrix

**✓** = permitted · **●** = own booking only (the one the token addresses) · **—** = denied

| # | Capability | Visitor | Booking client | Admin |
|---|---|:---:|:---:|:---:|
| | **Public site** | | | |
| P-01 | Browse services, packages, add-ons, prices | ✓ | ✓ | ✓ |
| P-02 | View the availability calendar (free slots only) | ✓ | ✓ | ✓ |
| P-03 | See why a slot is blocked (block reason) | — | — | ✓ |
| | **Booking** | | | |
| P-04 | Create a booking and place a 30-minute slot hold | ✓ | ✓ | — <sup>1</sup> |
| P-05 | Pay the booking fee | ✓ | ✓ | — |
| P-07 | View a booking's details, status, and amounts | — | ● | ✓ |
| P-08 | Pay the session fee | — | ● | — |
| P-09 | Cancel a booking | — | ● | ✓ |
| P-10 | Reschedule a booking to a new slot | — | — <sup>2</sup> | ✓ |
| P-11 | Mark a booking `completed` or `no_show` | — | — | ✓ |
| P-12 | Open the delivery link and download photos | — | ● | ✓ |
| | **Client data** | | | |
| P-13 | View client name, email, phone | — | ● | ✓ |
| P-14 | Request erasure of own personal data (§7) | — | by email | ✓ |
| | **Availability** | | | |
| P-15 | Set weekly working hours and buffer | — | — | ✓ |
| P-16 | Create, edit, or delete availability blocks | — | — | ✓ |
| | **Catalogue & pricing** | | | |
| P-17 | Create or edit services, packages, add-ons | — | — | ✓ |
| P-18 | Activate or deactivate a service or package | — | — | ✓ |
| P-19 | Change prices | — | — | ✓ |
| P-20 | Set a per-service booking-fee rate | — | — | ✓ |
| P-21 | Add post-shoot add-ons to a booking | — | — | ✓ |
| | **Money** | | | |
| P-22 | View payment records and status | — | ● | ✓ |
| P-23 | Record a refund as issued | — | — | ✓ |
| P-24 | Change the global booking-fee rate | — | — | ✓ |
| | **Delivery** | | | |
| P-25 | Attach or update a delivery link and its expiry date | — | — | ✓ |
| P-26 | Send or resend the delivery email | — | — | ✓ |
| | **System** | | | |
| P-27 | Reach any `/admin` route | — | — | ✓ |
| P-28 | View the notification log | — | — | ✓ |
| P-29 | Resend any transactional email | — | — | ✓ |
| P-30 | Edit settings (fee rate, lead time, hold, buffer, expiry) | — | — | ✓ |

<sup>1</sup> There is no admin-side "book on behalf of a client" form in v1, and no in-product invite mechanism either. An offline enquiry is handled by sending the client the public booking URL by whatever channel the conversation is already happening on — usually WhatsApp — and letting them book and pay normally (§3.8). Admin-created bookings remain deferred: **R-1**. P-06 is withdrawn; permission ids are stable, so the gap is intentional.
<sup>2</sup> A client who needs a different date either cancels (forfeiting the booking fee, §6.10) and books again, or contacts the photographer, who reschedules on their behalf (§3.6).

**Enforcement.** Every permission above is checked server-side on the route and API handler; none is enforced by hiding UI alone. The booking client's scope is derived from the token in their return link and never from a booking id, reference, or email address supplied in the request. Admin routes are gated by a verified admin bearer token (§7), checked in middleware before any handler runs. Erasure is requested by emailing the photographer and carried out by him — there is no client-facing erasure control, and no table records a request. Three rules bind all roles including the admin: rows referenced by a booking cannot be hard-deleted; `payment`, `webhook_event` and `outbox` rows are never edited or deleted — they are the audit trail; and no role can move money, only record that money moved (§6.16).

---

## 3. User Flows

### 3.1 Booking a shoot (primary flow)

1. Visitor opens the site in English and browses the service list.
2. Visitor opens a service (e.g. *Personal photoshoot*, *Corporate*) and sees its packages: price in RWF, number of photos, session duration.
3. Visitor selects one package and any add-ons offered for that service. The running total updates as selections change.
4. Visitor opens the calendar. The system offers a slot only when **all** of these hold: it falls Mon–Fri inside 09:00–17:00; the whole session duration fits before 17:00; it does not overlap an availability block; it does not overlap any booking that occupies time — `pending_payment` (while its hold is live), `confirmed`, `completed` or `no_show` — **or that booking's 30-minute buffer**; and its start is at least 120 minutes from now. Start times sit on a 30-minute grid.
5. Visitor picks a date and start time. The slot length equals the selected package's duration.
6. Visitor fills the booking form: full name, email, phone, shoot location, number of people, special requests, and a consent checkbox.
7. The system shows a summary: service, package, add-ons, total price, **booking fee** (40% of total, or the service's own rate), and the remaining session fee due after the shoot. The advertised price is what the client pays — gateway fees are absorbed by the photographer and never appear at checkout. The summary states plainly that the booking fee is **non-refundable if the client cancels**.
8. Visitor confirms. The system creates the booking as `pending_payment` and holds the slot for **30 minutes**.
9. Visitor is redirected to the payment provider's hosted checkout and pays the booking fee. **Available methods depend on the active provider** — MTN MoMo only during the direct-API phase; MTN MoMo, Airtel Money, and cards after the Flutterwave cutover (§4.3).
10. The provider returns the visitor to a **confirmation page**, which shows the booking as pending and polls for its status. Mobile Money settlement routinely takes 30 seconds or more, so this screen is the client's whole experience of the wait: it states what is happening, never claims success before the webhook arrives, and tells them the confirmation email is coming if they leave.
11. On a signature-verified `succeeded` webhook, the system moves the booking to `confirmed`, records the payment, generates the client's access token, and permanently removes the slot from public availability.
12. The system sends the client a confirmation email containing the booking reference, date/time, location, amounts paid and outstanding, and their return link; and sends the admin a "new booking" alert.
13. The system pushes the booking to the photographer's Google Calendar as a one-way mirror (§3.7) and it appears on the admin calendar. No admin approval step exists — see **C-1**.

### 3.2 Payment abandoned or failed

1. Visitor reaches the hosted checkout and abandons it, or the payment fails.
2. The hold expires 30 minutes after the booking was created. A scheduled job moves the booking to `expired` and returns the slot to public availability.
3. No email is sent to the client, and no admin alert is raised. The record is retained for reporting.
4. A late `succeeded` webhook for an already-expired booking is handled per **§6.9**.

### 3.3 Admin manages availability

1. Admin signs in with email and password and opens the calendar in month, week, or day view.
2. Admin adjusts the weekly working hours (seeded Mon–Fri 09:00–17:00) and, on the settings screen, the five operating values: booking-fee rate, minimum notice, hold duration, inter-shoot buffer, and delivery-link lifetime.
3. Admin blocks time as unavailable, choosing either a **full day** (or a range of days) or a **specific time range within a day**, with an optional private reason.
4. Blocked and booked time disappears from the public calendar immediately on save.
5. If a new block overlaps an existing confirmed booking, the system warns and requires explicit confirmation — see **§6.4**.

### 3.4 Admin manages services and pricing

1. Admin opens Services and creates a service with a name, description, cover image, and display order, plus an optional booking-fee rate that overrides the global 40%.
2. Admin adds packages to that service, each with a price in RWF, a photo count, and a session duration.
3. Admin adds optional add-ons (price in RWF), selectable by the client at booking time or added by the admin after the shoot.
4. Admin edits prices at any time. Existing bookings keep the prices captured when they were made — see **§6.9**.
5. Admin deactivates a service or package rather than deleting it — see **§6.10**.

### 3.5 Post-shoot: session fee and photo delivery

1. Once the shoot has begun, the booking is still `confirmed`. The admin adds any post-shoot add-ons (extra photos, prints). The outstanding session fee recalculates.
2. Admin triggers "Request session fee". The system emails the client a branded request with the amount due and a payment link.
3. Client pays. The webhook records the session-fee payment and marks the booking fully paid; the admin receives a payment-received alert. Or the client pays in cash and the admin records it with "Record cash payment" (2026-09-27): any amount up to what is owed, refused while an online payment may be in flight, voiding an open online request so the same money cannot be taken twice, and emailing nobody. Cash is refunded like any other payment.
4. Paid in full, the booking is `completed`: by itself, in the same transaction as the payment that cleared the balance, or by the admin's "Mark completed" when the balance was cleared before the shoot began. "Mark completed" is refused while anything is owed.

> **Changed 2026-09-27 (admin console fixes, item 6).** Post-shoot add-ons now come *before* completion, and "completed" means paid. Add-ons are editable while the booking is `confirmed` and its shoot has begun, and locked once it is `completed`. A booking completed before this change that still owes money keeps its "Request session fee"; no data is migrated. Photo delivery (steps 5–7) still needs `completed`.
5. Admin uploads the shoot to their own external host (Drive, Dropbox, WeTransfer), pastes the resulting link into the booking, and sets the expiry date — defaulted by the system to **90 days** from today.
6. Admin triggers "Send photos". The system sends a branded delivery email containing the link and the stated expiry date, and logs the send.
7. Client opens their booking link or the delivery email and downloads the photos.

### 3.6 Cancellation and rescheduling

**Client-initiated cancellation:** client opens their booking, cancels, and confirms an on-screen notice that the booking fee is not refunded. The booking moves to `cancelled_by_client`, the slot and its buffer return to public availability immediately, the Google Calendar event is deleted, and both parties are emailed. Any session fee already paid is flagged to the admin for manual refund.

**Photographer-initiated:** the decided policy is **reschedule first, refund if nothing suits**.
1. Admin opens the booking and chooses "Reschedule" or "Cancel", entering a reason.
2. On reschedule: admin picks a new slot; the booking keeps its reference, token, payments, and amounts; `original_starts_at` and `rescheduled_at` are recorded; the old slot is released; the Google Calendar event is moved; the client is emailed the new date.
3. On cancel: the booking moves to `cancelled_by_admin`, the slot is released, the calendar event is deleted, and the client is emailed. **The booking fee is refunded in full.** The system marks the booking-fee payment `refund_due` and alerts the admin.
4. Admin issues the refund outside the system (MoMo or bank) and records it against the payment with a reference. The status moves to `refunded`. The system never moves money on its own — see **§6.16**.

### 3.7 Google Calendar mirror

One-way, site → Google. On confirm the system creates an event in the photographer's calendar; on reschedule it moves that event; on cancel or no-show it deletes it. The event carries the client name, service, package, location, and booking reference. **Nothing flows back:** personal Google events do not affect site availability, and edits made inside Google Calendar are overwritten on the next push. The Google Calendar is a read-only convenience mirror for glancing at bookings on his phone. Blocks, statuses, payments, clients, and every other function live on the site, which remains the single source of truth.

### 3.8 Offline enquiry (WhatsApp, phone, walk-in)

The photographer sends the enquirer the public booking URL — or the URL of the relevant service page — through whatever channel the conversation is already in. They book and pay exactly as in §3.1.

**Nothing is built for this.** v2.0 specified a signed, expiring, pre-filled invite link with its own settings value and its own email template. Pasting a URL into WhatsApp does the same job in zero lines of code, and **R-1** has never established that anyone will follow such a link rather than expecting the photographer to book for them. If it turns out they will not, the answer is an admin-side booking form (R-1 option B), not a fancier link.

### 3.9 Returning client access

The confirmation email contains a unique long-lived link. Opening it shows that booking's status, date and time, amounts paid and outstanding, the session-fee payment button when one is due, and the delivery link once photos are sent. One link addresses one booking; a client who books twice receives two links. If a client loses the email, the admin resends it from the booking (P-29).

---

## 4. Scope

### 4.1 In scope (v1)

- Public site in **English**, built on a translation layer so French is a content task later rather than a rebuild (§7, **R-2**).
- Service list, service detail with packages and add-ons, availability calendar, booking form, hosted-checkout payment, and the post-checkout confirmation page that polls while the webhook settles (§3.1 step 10).
- Availability engine: weekly working hours (Mon–Fri 09:00–17:00), 30-minute slot grid, 30-minute inter-shoot buffer, 120-minute minimum notice, full-day and partial-day blocks, and overlap prevention enforced at the database level.
- Booking lifecycle: `pending_payment` → `confirmed` → `completed`, plus `cancelled_by_client`, `cancelled_by_admin`, `no_show`, `expired`.
- Pricing: services → packages (price, photo count, duration) → optional add-ons, all admin-editable; global 40% booking-fee rate with a per-service override.
- Payments through a **provider adapter with two implementations**: MTN MoMo Collections API direct (development), Flutterwave (production cutover, adding Airtel Money and cards). Booking fee at booking time, session fee after the shoot.
- Non-refundable booking fee on client cancellation; full refund on photographer cancellation, executed manually and recorded in the system.
- Post-shoot workflow: mark complete, add add-ons, request session fee, record payment, attach an external delivery link with a 90-day default expiry, send and resend the branded delivery email.
- Admin panel: email/password login, calendar (month/week/day), booking list and detail, block management, service/package/add-on CMS, a settings screen for the five operating values, and the message history for each booking.
- One-way Google Calendar push for confirmed bookings.
- Transactional email, nine templates: booking confirmation, new-booking admin alert, session-fee request, payment receipt, photo delivery, cancellation, reschedule, access-link resend, and a catch-all admin alert covering payment received, exhausted retries, login lockout and refunds due. All sends logged.
- Prices in RWF only; all times displayed in Africa/Kigali.
- Privacy notice page, a consent checkbox at booking, and a stored `consent_at` so consent is demonstrable and not merely collected.

### 4.2 Out of scope (v1)

- **French (and any other) language content at launch.** The architecture supports it; the translations and the FR content are a later shipment — **R-2**.
- **Multiple photographers, staff accounts, or role permissions.** One admin account only.
- **SMS notifications** and **WhatsApp / WhatsApp Business API notifications.** Email only in v1.
- **Built-in photo hosting, upload, galleries, or proofing.** The site stores a link, never the files.
- **Two-way Google Calendar sync.** The push is one-way and nothing flows back from Google.
- **Admin-created bookings, offline payment records, and any in-product invite link.** Offline enquiries are handled by sending the public URL by hand (§3.8) — **R-1**.
- **Automated refunds.** The system flags and records refunds; the photographer moves the money.
- **Client-initiated rescheduling.** Clients cancel and rebook, or ask the photographer.
- **Per-service custom booking form fields.** The field set is fixed (§3.1 step 6).
- **Client reviews, testimonials, portfolio galleries, or a blog** beyond images attached to service listings.
- **Discount codes, vouchers, gift cards, seasonal promotions, or per-client pricing.**
- **Recurring or multi-day bookings**, group/multi-slot bookings, and waiting lists.
- **Invoicing, accounting exports, tax documents, or a revenue dashboard** beyond a bookings and payments list.
- **Native mobile apps.** The site is mobile-first and responsive.
- **Two-factor authentication on the admin account.** Password, Argon2id and lockout only.
- **Scheduled data purging.** Erasure on request is built; time-based deletion is not.
- **Uploads of any kind.** Service cover images are a URL the admin pastes, not a file the site stores.
- **Contracts, model releases, or e-signature.**

### 4.3 Payment provider phasing

| Phase | Provider | Methods available | Notes |
|---|---|---|---|
| Development | MTN MoMo Collections API (direct) | MTN MoMo only | Sandbox credentials. Airtel Money and cards cannot be exercised in this phase. |
| Production | Flutterwave | MTN MoMo, Airtel Money, card | Cutover before launch. Historic payments keep their original `provider` and `provider_ref` values and stay reconcilable. |

Both are implemented behind one `PaymentProvider` interface (initiate, verify, handle webhook, look up status). Provider selection is configuration, not a code branch in business logic. Card and Airtel acceptance testing is only possible after cutover — see **R-3**.

---

## 5. Data Model

**The authoritative data model is [`data-model_v2.md`](data-model_v2.md).** This section deliberately holds no entity list, no column list and no ER diagram.

It used to. The result was a section describing fourteen entities against a model that has thirteen — still listing `delivery`, `notification_log` and `booking_access_token` as tables months after they were folded into `booking` and `outbox`, still asserting that a unique `provider_ref` makes webhook handling idempotent when the data model calls that claim a defect, and still giving `working_hours` a shape that cannot express the dated overrides the whole "open a Saturday without a migration" argument rests on. A duplicated schema is a schema that drifts, and this one had.

What the reader needs from this section is the shape of the thing, not its columns:

- **Thirteen tables**, in six groups: identity and configuration, availability, catalogue, booking, money, and the work queue.
- **A booking is a snapshot.** Every name, price, duration and contact detail a client was shown is copied onto the booking at write time. Editing a service, a package or a price never changes a booking that already exists.
- **Money is whole RWF integers**, never floating point, and totals are computed by one function rather than stored — so a post-shoot add-on cannot silently fail to appear in what a booking is worth.
- **Occupancy is enforced by the database, not the application.** A range-exclusion constraint over each booking's time *plus its buffer* makes two overlapping bookings impossible whatever the code does. This is the single mechanism that fixes the problem in `brief.md` §1.
- **Every inbound provider callback is stored before it is interpreted**, keyed so a duplicate delivery is a no-op and a settled payment cannot be walked backwards.
- **Everything the system sends** — email and calendar pushes alike — goes through one queue that is also the audit trail.

Rules that constrain behaviour rather than storage stay here, in §6.

---

## 6. Edge Cases

| # | Edge case | Decided behavior |
|---|---|---|
| 6.1 | **Double booking (race condition)** | Two clients paying for the same slot simultaneously cannot both succeed. The slot is claimed inside a database transaction protected by an exclusion constraint over `[starts_at, buffer_ends_at)`; the loser's transaction fails, their payment is not captured (or is marked `refund_due` if already captured), and they see "this slot was just taken" with the calendar refreshed. |
| 6.2 | **Abandoned or failed payment** | A `pending_payment` booking holds its slot for 30 minutes. A scheduled job then expires the booking and releases the slot and its buffer. No client or admin email is sent. |
| 6.3 | **Blocked dates (full-day and partial-day)** | The admin blocks whole days/date ranges or a time range inside a day. Blocked time is subtracted from working hours before slots are generated, so it never reaches the public calendar. Block reasons stay private to the admin. |
| 6.4 | **Block overlapping an existing confirmed booking** | The system does not silently cancel a paid booking. Saving such a block raises a warning naming the affected bookings; the admin must cancel or reschedule them explicitly (§3.6), or save the block anyway, in which case the confirmed booking stands and shows on the calendar as a conflict. |
| 6.5 | **Timezone (Africa/Kigali)** | All instants are stored in UTC and rendered in `Africa/Kigali` (UTC+2, no DST) for every user regardless of device timezone. Every displayed time is labelled. Emails and Google Calendar events carry Kigali times. Date-only fields (delivery expiry) are evaluated at end of day Kigali time. |
| 6.6 | **Minimum lead time and same-day booking** | Slots starting sooner than 120 minutes from now are not offered and are rejected server-side if submitted. Same-day booking is permitted when the slot clears that threshold and falls inside Mon–Fri 09:00–17:00. |
| 6.7 | **Buffer between shoots** | Each confirmed booking reserves its duration **plus 30 minutes**. The next bookable start is the buffer end rounded up to the 30-minute grid. The buffer may extend past 17:00 — it blocks nothing after closing and is never shown to clients as a bookable or occupied slot, only omitted from availability. |
| 6.8 | **Session longer than the working window** | A package whose duration plus the closing boundary cannot fit inside 09:00–17:00 produces no availability at all. The admin sees a warning on the package when this is true, rather than clients meeting an empty calendar with no explanation — see **R-4**. |
| 6.9 | **Duplicate, out-of-order, or late payment webhook** | Every callback is stored before it is interpreted, keyed on the provider's own event id so a repeated delivery is a no-op, and an event for a payment already settled — succeeded, failed or refunded — is recorded and ignored rather than applied. A `succeeded` webhook arriving after the hold expired reinstates the booking to `confirmed` **only if** the slot is still free; otherwise the payment is recorded `succeeded` against an `expired` booking, set to `refund_due`, and the admin is emailed immediately. |
| 6.10 | **Client cancellation** | Available any time before the shoot. The booking fee is **not refunded** — displayed before payment and repeated in the cancellation confirmation. The slot and buffer return to availability immediately and the calendar event is deleted. Both parties are emailed. Any session fee already paid is marked `refund_due`. |
| 6.11 | **Photographer cancels or reschedules** | Reschedule keeps the booking, its reference, token, and payments, moves the slot **and its buffer**, moves the calendar event, records `original_starts_at`, and emails the client. Cancel releases the slot, deletes the calendar event, emails the client, and marks the booking-fee payment `refund_due` for a **full refund**. |
| 6.12 | **Client no-show** | The admin marks the booking `no_show`. The slot is not returned to availability — the time was consumed. The **booking fee is forfeited, no session fee is owed, and the booking closes.** No further email is sent beyond the admin's own record. |
| 6.13 | **Price, package, or fee rate changed after a booking exists** | Bookings are unaffected. Amounts are read from the booking's snapshot columns, including `booking_fee_rate`, never from live rows. Edits apply to new bookings only. |
| 6.14 | **Service or package deactivated with live bookings** | Deactivation removes it from the public site and keeps every existing booking intact and readable via its snapshots. Hard deletion of a referenced row is blocked. |
| 6.15 | **Post-shoot add-ons change the amount due** | The session fee recalculates each time the admin edits the add-on set, and locks once a `session_fee` payment reaches `succeeded`. An add-on added after full payment creates a second, separate session-fee request rather than editing the settled one. Since 2026-09-27 the add-on set is edited while the booking is `confirmed` and its shoot has begun, and locks once it is `completed` (§3.5). |
| 6.16 | **Refunds** | The system never moves money. It sets `refund_due`, alerts the admin, and exposes a "record refund issued" action taking a reference and date, which moves the payment to `refunded`. Reconciliation against the provider's own records is manual. |
| 6.17 | **Google Calendar push fails** | The push is asynchronous and never blocks a booking. A failed push is retried with backoff and, after exhausting retries, raises an admin alert; the booking stays `confirmed` and correct on the site. Events edited or deleted inside Google Calendar are overwritten on the next push — Google is a mirror, not an input. |
| 6.18 | **Payment provider cutover** | Payments keep the `provider` and `provider_ref` they were created with. After cutover, webhooks from both providers are accepted so in-flight MTN-direct payments settle correctly, and refunds are looked up against the provider that took the money. |
| 6.19 | **Method unavailable in the current phase** | During the MTN-direct phase, Airtel Money and card options are hidden at checkout rather than shown and failing. The checkout renders only the methods the active provider supports. |
| 6.20 | **Delivery link expired or email lost** | The delivery email states the expiry date explicitly. After expiry, the booking page shows "this link has expired — contact the photographer" instead of a dead link. The admin can replace the link and resend at any time. |
| 6.21 | **Client loses their access link** | The admin resends it from the booking, which regenerates the token and invalidates the old one. Tokens are never guessable and never enumerable from a booking reference. |
| 6.22 | **Spam or duplicate booking attempts** | The booking endpoint is rate-limited per IP and per email address, and one email address may hold at most 3 live `pending_payment` bookings. Unpaid holds never block a slot for longer than 30 minutes. |
| 6.23 | **Admin login attacked** | Failed logins increment `failed_login_count`; the account locks for a rising interval after repeated failures and the admin is emailed. Password reset is a single-use, time-limited emailed link. |

---

## 7. Non-Functional Requirements

**Performance.** Mobile-first and built for Rwandan mobile networks: Largest Contentful Paint under 2.5 s on 4G for service and calendar pages; initial payload under 500 KB excluding images; images served responsively in WebP/AVIF. A month of availability resolves in under 500 ms at the 95th percentile, backed by an index on `starts_at`.

**Availability.** Target 99.5% monthly uptime on managed hosting. Daily automated database backups with 7-day retention and a restore procedure that has been executed at least once against a scratch database — an untested backup is not a backup. No 24/7 on-call commitment in v1.

**Security.** HTTPS everywhere with HSTS. No card number, CVV, or Mobile Money PIN ever reaches the application — payment completes on the provider's hosted checkout, keeping the project in PCI DSS SAQ-A scope. Webhook endpoints verify provider signatures and reject unsigned or replayed calls. Admin passwords are hashed with Argon2id; login is rate-limited and lockable (§6.23). There is no two-factor: one user, and nothing in the brief or the client's answers raises admin security at all. The admin session is a signed JWT — HS256, 8 hours, issuer- and audience-scoped — returned at login and sent by the admin UI as `Authorization: Bearer`; no cookie is involved in admin auth. Verification pins the algorithm, so a token declaring `none` or any other algorithm is refused, and the token carries an HMAC fingerprint of the password hash, so a password change revokes every issued token. Server-side authorization runs on every admin route and API handler. Because a browser never attaches a bearer token on its own, a forged cross-site request carries no credential: CSRF does not arise, and there is no CSRF token flow. The API enforces a CORS allowlist (`WEB_ORIGIN`, origin echoed, never a wildcard, credentials not enabled). The trade is that script running on the admin UI can read the token, which makes the CSP below load-bearing rather than defence in depth; the admin UI holds the token in memory or `sessionStorage`, never `localStorage`. Responses carry HSTS, `X-Content-Type-Options`, a restrictive `Referrer-Policy` and a CSP that blocks inline script — all of it default output from one middleware. Client access tokens are at least 128 bits of entropy, stored hashed, single-purpose, and scoped to one booking. Secrets live in environment variables, never in the repository. Rate limiting on booking creation, payment initiation, token use, and admin login. Known critical CVEs in dependencies patched before launch.

**Privacy and compliance.** Personal data collected is limited to name, email, phone, shoot location, party size, and special requests. Rwanda's Law N° 058/2021 on the protection of personal data and privacy applies: a privacy notice page, an explicit consent checkbox at booking, a stated retention period, and deletion on request are in scope. Registration of the data controller with the National Cyber Security Authority is the photographer's own obligation and is named here so it is not missed.

**Internationalization readiness.** English ships; French does not. Page and email copy resolves through a translation layer, and admin-authored content carries `_en` and `_fr` columns with the FR side present and unwritten — both cost close to nothing and keep French a content task. What is **not** built: locale-prefixed routing, a second enabled locale, and a project-wide rule that no string may be written in a component. That rule is a tax on every component for a deliverable **R-2** concedes may never arrive; adding French later means adding routes and filling files, which is work, not a rebuild.

**Accessibility and compatibility.** The booking flow — service, slot picker, form, payment — is fully operable by keyboard, and colour contrast meets WCAG 2.1 AA. Checked once, at the end, on the booking flow rather than as a gate on every screen. Supported: current and previous major versions of Chrome, Safari, Firefox and Edge, with Android Chrome as the priority target.

**Observability.** Application errors, failed payment webhooks and exhausted retries are logged as structured JSON to stdout and raise an email alert to the photographer. No third-party error-tracking vendor: none was budgeted, and one alert address covers a business with one operator. Every outbound message is recorded in the work queue and visible per booking in the admin panel.

**Implementation stack.** React + TypeScript built with Vite, styled with Tailwind and shadcn/ui. Express + Prisma over PostgreSQL 15+ — Postgres is a requirement rather than a preference, because the range-exclusion constraint that makes double booking impossible exists in no other engine the project would plausibly use.

Two folders, `frontend/` and `backend/`, deployed as **two separate apps on two separate domains**: the frontend static-hosted (its build output), the backend an API-only Express process reachable at `/api/*`. In development Vite still proxies API calls to Express on localhost so the inner loop stays one command; in production the two are genuinely cross-site, so the API carries a CORS allowlist scoped to `WEB_ORIGIN`, and admin requests authenticate with a bearer token rather than a cookie — which is what keeps a cross-site deployment free of a CSRF token flow and of browsers' third-party-cookie blocking. The separate deployment reopens **R-7** (§8.2): the frontend is a client-rendered SPA again, so public/marketing pages are back to being an SEO question, not a settled one. There is no shared package and no monorepo tooling — the server is authoritative for every amount and revalidates every payload, so the two projects can hold their own copies of a schema without a client ever being trusted. No client-imposed technology constraint; this is the delivery team's stack.

---

## 8. Ambiguity Log

### 8.1 Resolved — decisions taken 2026-09-08

| ID | Question | Decision | Where it lands |
|---|---|---|---|
| A-1 | Pricing model | **Packages + add-ons.** Service → 2–3 packages (price, photo count, duration) + optional add-ons, all admin-editable. | §3.4, `data-model_v2.md` §5.5–5.7 |
| A-2 | Client identity | **Guest booking + secure per-booking link.** No accounts, no passwords for clients. One link per booking. | §2.1, §3.9, `data-model_v2.md` §5.9 |
| A-3 | Payment gateway | **MTN MoMo Collections API direct for development, migrating to Flutterwave for production.** Both behind one provider adapter. | §4.3, §6.18, §6.19 |
| A-4 | Booking-fee rate | **Global 40% with a per-service override.** | `data-model_v2.md` §5.5, §9.5 |
| A-4b | Gateway transaction fees | **Absorbed by the photographer.** The client pays the advertised price; no processing-fee line at checkout. | §3.1 step 7 |
| A-5 | Photographer cancels/reschedules | **Reschedule first; full refund of the booking fee if no date suits.** | §3.6, §6.11 |
| A-6 | Client no-show | **Booking fee forfeited, no session fee owed, booking closed.** | §6.12 |
| A-7 | Photo delivery | **Hybrid.** Files on an external host; the site holds the link and sends the branded delivery email. | §3.5, `data-model_v2.md` §5.9 |
| A-8 | Retention / link expiry | **90 days**, expiry date shown to the client at delivery. ⚠ **Developer default, not a client answer** — the client left this question blank. Confirm before launch. | §3.5, §6.20 |
| A-9 | Google Calendar | **One-way push, site → Google, bookings only.** A read-only mirror for glancing at his phone; everything else lives on the site. | §3.7, §6.17 |
| A-10 | Slots and hours | **Mon–Fri 09:00–17:00, 30-minute start grid, 30-minute buffer between shoots, 120-minute minimum notice.** ⚠ Only the 120 minutes traces to the client ("maybe 2 hours before when it's working hours"); the weekday 9-to-5 window was chosen by the developer. See **R-4**. | §3.1 step 4, §6.6, §6.7 |
| A-11 | Admin authentication | **Email + password**, Argon2id, with lockout and emailed reset. TOTP was specified in v2.0 and removed — untraceable to anything the client said, for a single-user panel. | §2.1, §6.23, §7 |
| A-12 | SMS / WhatsApp | **Email only in v1.** Both deferred to a costed phase 2. | §4.2 |
| A-13 | Booking form fields | **Fixed set:** name, email, phone, location, party size, special requests, consent. | §3.1 step 6 |
| A-14 | French content | **English only at launch**, with the translation layer and FR columns in place. Locale-prefixed routing and the no-hardcoded-strings rule were dropped as too expensive for a deliverable that may never ship — see **R-2**. | §4.2, §7 |
| A-15 | Timeline and budget | **No fixed launch date. Build to this spec.** §4.2 is a quality boundary. | Header |
| A-16 | Offline bookings | **Send the client the public booking URL by hand** (§3.8). The in-product signed invite link specified in v2.0 is withdrawn — it was code for something WhatsApp already does. Admin-created bookings stay deferred. | §3.8, **R-1** |

### 8.2 Residual open items

None of these blocks the start of development. Each names what would settle it.

| ID | Item | Severity | Options | Position |
|---|---|---|---|---|
| **R-1** | Admin-created bookings for offline jobs | Medium | **A.** Send the public URL by hand (v1 as built). **B.** Admin creates a full booking with an offline payment record. **C.** Offline jobs stay as blocks. | Building A, which is now zero code (§3.8). The question the photographer must answer is whether clients who reach him on WhatsApp will actually open a link and pay online, or will expect him to book for them. If a meaningful share will not, B is needed — an admin booking form plus an `offline_cash`/`offline_momo` payment method. Cheaper to decide before the payment adapter is finished than after. |
| **R-2** | French launch | Medium | **A.** Translate the launch content in a later phase. **B.** He writes the French himself. **C.** French never ships. | Deferred. Note the client asked for French outright ("English and French"); shipping English is the developer's sequencing choice, not his. v2.1 stopped paying the expensive half of the readiness cost (§7) while keeping the cheap half, so choosing later stays inexpensive. |
| **R-3** | Payment credentials and cutover | **High** | Not a choice — missing facts. | Three things are needed before production: whose MTN MoMo API/collection account is used and its onboarding status; whose Flutterwave account settles the money and in whose name; and when the cutover happens. Card and Airtel Money paths cannot be tested at all before cutover, so their acceptance testing sits at the end of the schedule. |
| **R-4** | Weekday-only hours vs. event work | **High** | **A.** Keep Mon–Fri 09:00–17:00. **B.** Add Saturday. **C.** Open individual weekend dates as they are booked. | **The photographer has not been asked.** His only statement about when he works is "as long as a day is available, or maybe 2 hours before when it's working hours" — which sets the notice period and nothing else. Mon–Fri 09:00–17:00 was chosen by the developer, and `brief.md` sells **event coverage**, which in Kigali is overwhelmingly weekend work. As seeded, nobody can book a Saturday wedding and any package over 8 hours yields an empty calendar (§6.8). Changing it is a settings edit, not a code change — but it must be settled before launch content goes live. |
| **R-5** | Refund execution channel | Low | **A.** Manual MoMo transfer, recorded in the system (current). **B.** Provider-initiated refund API once on Flutterwave. | A is built. B becomes available after the Flutterwave cutover and would remove a manual step; not worth building against MTN direct. |
| **R-6** | Launch content | **High** | Not a choice — missing material. | The service list, package names, photo counts, durations, prices in RWF and cover-image URLs do not exist yet. The client's answer was "does it matter? ... we can start with photoshoots." Nothing can go live without them, and the availability engine cannot be realistically exercised without at least three packages of differing durations. |
| **R-7** | Public-page rendering (SEO) | Medium | **A.** Ship as a client-rendered SPA and accept the SEO cost (v1 as built, again). **B.** Add prerendering or SSR for the public/marketing pages only. **C.** Static-generate the handful of public pages at build time. | **Reopened in revision 2.2, not solved.** Closed in 2.1 only because the API served the built bundle from the same origin as its data; that's no longer true — the frontend is a separately-deployed, statically-hosted SPA on its own domain again, so public/service pages are client-rendered and invisible to crawlers that don't execute JavaScript. Adding SSR/prerendering is out of scope for this change; revisit if organic search traffic starts to matter. |

### 8.3 Contradictions between the source documents

Logged so the resolution can be corrected if it is wrong.

| ID | `brief.md` says | `clien-answers.md` says | Resolution |
|---|---|---|---|
| C-1 | §4.1 / §4.2: booking requests go to the admin, who confirms or declines each one | Bookings auto-confirm on payment; the admin is notified by email and the calendar updates automatically | **Auto-confirm on successful booking-fee payment.** No approval queue, no `declined` status; the admin retains cancel and reschedule after the fact (§3.6). ⚠ **Ask the photographer directly.** The brief names "confirm or decline booking requests" as a core feature twice, and we removed it on the strength of a "yes" to an either/or question — the weakest answer in the document. A paid deposit is a strong argument for auto-confirming, but it is our argument, not his. |
| C-2 | §6: multi-language support is out of scope | "English and French" | **Superseded by the A-14 decision: English at launch, French later.** The brief and the Q&A are reconciled by shipping one language while building for two. |
| C-3 | §6: SMS and WhatsApp integration is out of scope | "both would be ideal" | **Out of scope for v1** (A-12). Read as a preference, not a launch requirement. |
| C-4 | §4.4: card payments are an open question | "yes" | **Cards are in scope**, arriving with the Flutterwave cutover (§4.3). They do not exist during the MTN-direct phase. |
| C-5 | §3: whether clients need accounts is an open question | "yes" — answered to an either/or question | **Resolved by the A-2 decision: no accounts.** Clients return through a secure per-booking link. |

---

## Sign-off

Approving this document confirms §1–§7 as the agreed build. The sixteen v1 ambiguities are resolved (§8.1). Seven residual items remain (§8.2); **R-3** (payment credentials), **R-4** (working hours) and **R-6** (launch content) need answers before launch, and none of them blocks the first tasks.

Three decisions in §8.1 are marked ⚠ because they were made **for** the photographer rather than **by** him — A-8 (90-day link expiry, his answer was blank), A-10/R-4 (weekday-only hours), and C-1 (removing the approve/decline step the brief names twice). Approving this document approves those three as well, so they are worth a direct conversation first.

| | Name | Date |
|---|---|---|
| Client | | |
| Developer | | |
