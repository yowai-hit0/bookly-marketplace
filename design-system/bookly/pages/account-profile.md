# Account Profile and Privacy — Page Design

> **Project:** Bookly · **Routes:** `/account/profile`, `/account/email-confirm/:token`, `/account/deleted` · **Files:** `frontend/src/pages/account/AccountProfile.tsx`, `AccountEmailConfirmPage.tsx`, `AccountDeletedPage.tsx`, `frontend/src/pages/client/Field.tsx` (`ClientField`)
> **Written:** 2026-10-27, Phase 8 (marketplace spec R8.3, T8.3, T8.4; user decisions 1, 2 and 4 of 2026-10-27). Built inside `client-front.md` (fields §5.4).
> **API:** `GET`/`PATCH /api/account/profile`, `POST /api/account/password`, `POST /api/account/password/set`, `POST /api/account/email`, `POST /api/account/email/confirm` (no session), `GET /api/account/export`, `POST /api/account/delete`, and `/me` for `hasPassword`, `pendingEmail` and the address.

## Layout

`main` (`container`, `pageY`, `max-w-3xl`, `flex-col gap-8`), under the account nav, Profile current. Head: eyebrow `Settings2` "Account", `h1` "Profile", lead "Your details, how you sign in, and your data." Then five hairline panels (`Section`: `p-5 sm:p-6`, `gap-5`, an `h2` at 20px / 500 and a 14px secondary intro), in this order:

### 1. Your details

Intro: "We fill these in for you when you book. Bookings you have already made keep the details they were made with." (decision 1: the phone and name prefill the booking form; a booking keeps its own contact snapshot.) Two fields side by side from `md`: **Full name** (`autocomplete=name`, 200), **Phone number** (`type=tel`, mono, 40, hint "Optional. A Rwandan number like 078 123 4567, or any number starting with + and the country code."). Inverted **Save details** (full width below `sm`). On success the success callout "Your details are saved." (`role="status"`), the fields show the API's stored values (the phone in `+250…`), and `/me` is read again so the header's name and the booking form's prefill follow. A blank phone is sent as `null` (cleared). A blank name is refused on the field before sending (an account that never had one simply keeps none). The API's `422` marks the field it names and focuses it.

### 2. Password

- **With a password:** intro "Changing your password signs you out on every other device." **Current password** and **New password** (hint `auth:signup.passwordHint`, 12-1,024) side by side from `md`; **Change password**. Success: the new token from the answer is kept (old ones are revoked), the fields clear, and the success callout says so. Wrong current: on that field, "That is not your current password." Locked, changed elsewhere, rate limited, failed: a destructive callout.
- **Google-only (`hasPassword` false):** intro "You sign in with Google. Add a password to sign in with your email and password too." **New password** alone; **Add password**. Success keeps the fresh token and `/me` (already in the answer) turns the section into the change form, with "Password added. You can sign in with your email and password, or with Google." kept above it.

### 3. Email

Intro: "You sign in with aline@example.com." While a change waits (`pendingEmail`): the info callout "Waiting for you to confirm new@example.com from its inbox. Until then you sign in with aline@example.com."

- **With a password:** one line on how it works, **New email** and **Your password** side by side from `md`, **Send the link**. The answer is `202` whether or not the address can be used, so the page says only "If new@example.com can be used, we've sent a link to it. Open it within 24 hours to finish the change." (info, `role="status"`), never "sent". Its own address (any case) and a malformed one are refused on the field before sending; a wrong password on the password field.
- **Google-only:** no form, one line: "Your email is the one you signed up with through Google. To change it here, add a password first: it confirms the change."

### 4. Your data

"Download everything your account holds, your details, bookings and payments, as one JSON file." An outline **Download my data** (`Download`). The file comes through a `fetch` with the bearer header, then a blob and an object URL clicked as a download (`bookly-account-YYYY-MM-DD.json`, the Kigali date): **the token never goes in a URL**. Success "Your download has started."; `429` "Too many attempts from here…"; other failures a destructive callout.

### 5. Delete account

The panel's edge is `destructive/40`. "Removes your name, phone number and sign-in details for good. Photographers keep the records of bookings made with them." The tinted **destructive** "Delete my account" opens the shared `Dialog`:

- `h2` "Delete your account?", description "This cannot be undone. Your name, phone number and sign-in details are removed, and you are signed out."
- An info callout (decision 4): "Upcoming bookings carry on. Open them from the links in your booking emails; the photographer still has the details you booked with." and "We send a confirmation to aline@example.com once it is done." (the API emails the deleted address, 2026-10-27).
- The confirmation, focused on open: **Enter your password to confirm** (`type=password`) with a password; for a Google-only account **Type your email to confirm** with the hint "Your email is aline@example.com." (compared trimmed and in any case before sending; a mismatch sends nothing).
- The solid red **Yes, delete my account** and an outline **Keep my account** (closes), stacked full width on a phone. Wrong password / address: on the field; locked, rate limited, failed: a destructive callout; the dialog stays.
- **Success (`204`):** to `/account/deleted`, which forgets the session once it is on screen (forgetting it on the profile would have that page's guard send the visitor to the login first).

## `/account/deleted`

The account's narrow centred panel (`AuthFrame`, as the sign-in pages): eyebrow "Account", `h1` "Your account is deleted", "We have removed your details, signed you out and emailed a confirmation to your address. Upcoming bookings carry on: open them from the links in your booking emails." Then an inverted **Home** and an outline **Get my booking links** → `/my-booking`. Outside the account guard; opening it by hand signs no one out.

## Confirming a new email: `/account/email-confirm/:token`

Where the address-change email's link lands, in any tab, signed in or not. **Opening it changes nothing** (mail scanners open links): the change is the button's `POST` with the token from the path and the account's password. The narrow panel: `h1` "Confirm your new email", "Enter your Bookly password to finish changing the email you sign in with.", **Password**, the full-width inverted **Confirm and sign in**.

- Success: the answer is a login; this tab is signed in with it and lands on `/account/profile`, which shows the success callout "Your email is changed. You now sign in with new@example.com."
- `400` (expired, replaced, used, wrong password, all alike): "That did not work. The link may have expired, been replaced or used already, or the password is not this account's."
- `409 email_taken`: "Another account now uses that address, so the change was withdrawn. You still sign in with your old email."
- `429`, failure: the shared words. An empty password: on the field, nothing sent.

`email-confirm` and `deleted` are signed-out pages for the return-path rule (`auth/areas.ts`): a login never returns to them.

## Do not

- No "your address is taken" / "we sent it": the email change never enumerates.
- No email change for a Google-only account.
- No `disabled` buttons mid-request (`aria-disabled`, so focus stays).
