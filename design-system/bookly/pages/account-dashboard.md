# Account Dashboard (bookings) — Page Design

> **Project:** Bookly · **Route:** `/account` (the index of the account layout) · **Files:** `frontend/src/pages/account/AccountDashboard.tsx`, `AccountLayout.tsx` (the account nav), `parts.tsx` (page head, states, pager, payment badge)
> **Written:** 2026-10-27, Phase 8 (marketplace spec R8.1, R8.4). Built inside `client-front.md`; where they disagree for this page, this file wins. The shell and the account nav are in `client-shell.md`, "Account nav".
> **API:** `GET /api/account/bookings?scope=upcoming|past&page=N` (bearer account token) → `{ scope, bookings, total, page, pageSize: 20, pageCount }`.

## What this page is

A signed-in client's bookings with every photographer, in one list: the ones still ahead (and live holds) under **Upcoming**, everything else under **Past**. Each row leads to that booking's own page (`account-booking.md`). A guest booking made later with the account's verified email appears here by itself (R8.4): nothing on the page has to say so.

**All user text is plain text**: the photographer's name, the service and package names are React text nodes. Every amount is the API's; nothing is added up.

## Layout

`main` (`container`, `pageY`, `flex-col gap-8`), under the account nav.

1. **Head** (`PageHead`): mono eyebrow `UserRound` "Account"; `h1` the greeting, "Hello, Aline Uwase" (`account:home.greeting`), "Hello" while the account loads or when it has no name; the lead "Your bookings with every photographer, in one place."
2. **Tabs row**, `flex-wrap justify-between`: the scope control, and the count ("3 bookings", mono 14px muted, `role="status"`) once the list has any.
   - **The scope control** is a `nav[aria-label="Which bookings"]` with two **links**, Upcoming and Past, in one hairline box (`p-1`): the current one inverted neutral (`bg-primary`), `aria-current="page"`; the other secondary text, chip on hover. 36px, 44px on touch. **Links, not radios and not ARIA tabs**: each is a URL, and the client e2e suite counts radios page-wide.
3. **The list**: `ul[aria-label="Bookings"]`, `flex-col gap-4`, one hairline panel per booking (`p-5 sm:p-6`, `gap-4`):
   - top row: the photographer (a `Camera` 16px icon and their display name as a violet text link to `/p/:handle`), then the `h2` "Portraits, Standard" (18px / 500) as the link to `/account/bookings/:reference` (44px tall on touch); the **status badge** (console mapping, `booking:stage.*`) on the right, wrapping under on a phone.
   - facts (14px secondary): `CalendarClock` + "Wednesday, 7 October 2026, 09:30 to 11:00, Kigali time" (`booking:whenValue`); `Hash` + the reference in mono, text colour (its label `sr-only`).
   - **a live hold** (`checkoutPath` set): the info callout `Clock` "Held until 27 Oct 2026, 12:30. Pay the booking fee to confirm it." Information, never success: a hold is not a booking.
   - money row, a hairline above (`border-t pt-4`): a `dl` of mono labels over mono values, Total, Paid, **Still to pay** (only while above 0, semibold), Refund due to you (only while above 0). The `booking:labels.*` words, so the list and the booking page say the same thing.
   - **Finish payment** (inverted primary, trailing arrow, full width below `sm`) → the `checkoutPath`, only when the API sends one **and** it is the app's own `/checkout/<reference>/<token>` (`safeCheckoutPath`); anything else is dropped, never linked.
4. **Pager** (`Pagination`): only when `pageCount > 1`. `nav[aria-label="Pages"]`: an outline `sm` "Previous page" link on the left, "Page 2 of 3" mono muted in the middle, "Next page" on the right. An end has **no link**, never a dead one. The page answered is the one shown (past the end, the API answers the last).

## URL

`/account?scope=past&page=2`. Upcoming and page 1 are the defaults and are left out of the URL. The URL is read once per render: an unknown scope reads as upcoming, a page that is not a whole number from 1 to 1,000,000 reads as 1, so nothing the API would refuse (400 / 422) is ever sent. The back button, a reload and a shared link all land on the same list.

## States

| State | What shows |
|---|---|
| loading | three skeleton panels in the row's shape (`aria-busy`), "Loading your bookings…" `sr-only` `role="status"` |
| failed | the destructive console callout "Could not load your bookings. Check your connection and try again." (`role="alert"`) with an outline `sm` **Try again** |
| empty, upcoming | `EmptyState`: a 48/64px `CalendarDays` tile, `h2` "No upcoming bookings", one line, and the inverted **Find a photographer** → `/photographers` |
| empty, past | the same, "No past bookings yet", "A booking moves here once its shoot is over or it is cancelled.", and the same link |
| ok | the list and the pager |
| 401 | `apiFetch` drops the session; the guard sends the visitor to `/account/login` |

An `expired` hold is in neither list (backend design decision): there is no row for it, and its reference still opens its page.

## Responsive

375px: the tabs and the count wrap onto two lines when they must; the status badge wraps under the title; the money `dl` wraps; Finish payment is full width. No horizontal scroll (checked at 375 touch, light and dark).

## Do not

- No "Cancel" or "Pay" on the list: both live on the booking's page, after its terms.
- No total across bookings, no sums: every amount is the API's.
- No radios, no ARIA tablist, no `dl` outside the money rows.
