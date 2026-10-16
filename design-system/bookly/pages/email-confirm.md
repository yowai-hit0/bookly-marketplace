# Confirm a new email — Page Design

> **Route:** `/email-confirm/:token`, inside the client shell · **File:** `frontend/src/pages/booking/EmailConfirmPage.tsx`
> **Added 2026-09-25** (user decision; `docs/prompts/client-access-and-admin-polish.md`, item 6).
> **Overridden 2026-09-27 by `design-system/bookly/client-front.md`** (the client front redesign, light and dark): the narrow centred panel and success / danger callouts (client-front.md §8.5).

Where the link in a contact-email confirmation lands. The client asked, on their booking page, to use a new address; this link went to that address, and following it is the proof it is theirs.

## The one rule: opening the page changes nothing

The change is made by the **button**, a `POST /api/email-confirmations/:token`. Mail scanners open links, and some run scripts, so a page that confirmed on load could be confirmed by a machine rather than a person.

## Layout and states

- One `main`, `max-w-xl`. `h1` "Confirm your new email", one muted line, and one default button "Confirm this email" (`aria-disabled` while confirming).
- confirmed: an info `Callout` (`role="status"`, `CircleCheck`), "Done. We will write to your new address from now on." The button goes.
- invalid (unknown, expired, used or replaced, all alike): the dead-link pattern of `booking.md`, a neutral `Unlink` icon, `h1` "This confirmation link is not valid" and a muted line pointing back to the booking page. No button.
- failed: a `role="alert"` line above the button, which stays for a retry.
