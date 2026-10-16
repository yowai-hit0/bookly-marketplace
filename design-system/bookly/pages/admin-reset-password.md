# Admin Reset Password — Page Design

> **Project:** Bookly · **Phase 3 section:** 5 (with the admin shell and login)
> **Route:** `/admin/reset-password` — declared **outside** `AdminLayout` (signed out by definition, so no sidebar and no session guard)
> **File:** `frontend/src/pages/admin/AdminResetPassword.tsx` (shared `AdminField.tsx`)
> **Added by the discovery rule (2026-09-21):** the page shipped as feature work on `main` (commit `d02bd41`) and had no design file, so Section 5 would have restyled it blind.
> This file overrides `design-system/bookly/MASTER.md` for this page. Read MASTER's "Hand-review addendum" first.
> **Overridden 2026-09-26 by `design-system/bookly/admin-console.md` (admin console redesign), which wins where they conflict:** The card becomes the console panel shared with login (`admin-console.md` §6.8). Login no longer wears the client header (decision 6), so "visibly the same place" holds again. The three shapes, the back link and every security rule on the token hold.

One route doing two jobs, told apart by whether the emailed link carried a token in the URL **fragment**: ask for the link, or choose the new password. The fragment is never sent to a server, so it reaches no log, proxy or referrer — nothing in the visual pass may put the token into a link, a heading, an `img` URL or anything else that navigates.

## Layout — the same frame as login

`main`, `max-w-sm`, `min-h-svh`, vertically centred, `p-6`. One `Card` on the tinted page background, with real separation (border/ring plus `shadow-md`), not a hairline. This page and `/admin/login` must be visibly the same place: same width, same centring, same card, same optional wordmark above it. A photographer arrives here *from* login, and arriving somewhere that looks different reads as a phishing page.

`Card` -> `CardHeader` (`CardTitle` wrapping the `h1`) -> `CardContent` (`flex-col gap-4`).

Each of the three shapes ends with the **"Back to sign in"** link, muted `text-sm`, `underline-offset-4 hover:underline`, as the last thing in the card. It is the only way out and it is always present.

## Shape 1 — request the link (no token)

`h1` = request title -> body `p` (`text-sm muted`) -> form: one email field -> error -> submit (full width, `disabled` while submitting, label swaps).

- The email input is `type="email" autoComplete="username"`, 44px tall, 16px text. Password managers must keep working.
- **After a successful request the form is replaced** by the confirmation (`role="status"`, `text-sm`), with the back link below it. Give it a `MailCheck` icon (`size-4`) above or beside the sentence, and keep the card the same width so nothing jumps.
- **The confirmation says the same thing whether or not that address can sign in.** The API answers 202 either way. Nothing in the visual treatment may hint at the difference — no "we found your account" tone, no different icon, no different colour. This is a security property of the page, not a copy preference.
- The failure message (`role="alert"`, destructive, `text-sm`) means our side broke and no email is coming; it sits directly above the button.

## Shape 2 — choose the new password (token present)

`h1` = choose title -> body `p` -> form: new password, confirm password, error, submit.

- Both inputs `type="password" autoComplete="new-password"`, 44px, 16px. No "show password" toggle: that is new state and a new string.
- The **12-character rule is a hint on the first field** (`AdminField`'s hint slot), visible before anything is typed — not an error that only appears after a failed attempt. The mismatch error belongs to the second field.
- Validation errors are local and instant; the token errors are not. Keep them in different places: field errors under their field, the invalid/expired-token and request-failed messages in one `role="alert"` above the button.
- **An invalid or expired token is the page's dead end**, and it must not look like a typo. It keeps the form on screen (retyping will not help, but hiding the form loses the person entirely) and the alert carries a `TriangleAlert` icon; the back link below it is the real exit.

## Shape 3 — done

`h1` = done title -> confirmation `p` (`role="status"`) -> a **primary button** to `/admin/login` (`asChild` on a `Link`, `self-start`).

This is the one shape where the way out is a button, not the muted link — the job is finished and there is exactly one thing to do next. Do not also render the muted back link here; two controls to the same place is a false choice.

## States

request: idle, submitting, sent, failed.
choose: idle, too-short, mismatch, submitting, invalid token, failed, done.

## Login's side of it

The login page gets the **"Forgot your password?"** link this page pays for: muted `text-sm`, below the submit button, left-aligned, never styled as a second button. Recorded here rather than in `pages/admin-login.md`, which says the link "comes with the reset-password page" — that page now exists.

## Do not

- No sidebar, no nav, no skip link: this page is outside the shell.
- No password-strength meter, no "show password" toggle, no email re-entry field: each is new state or new copy.
- Never render, echo, link or log the token. It exists only in the fragment and in one POST body.
- No new copy. Every string already exists under `admin:resetPassword.*`.
