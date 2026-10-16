# Security and your responsibilities

You are the only administrator, so the security of the whole business's data
rests on your account and a few habits. None of this is technical to follow.

## Your login

You sign in with your **email and a password**. The password is stored only in a
hashed form (Argon2id) — it is never kept in readable form, and no one,
including a developer with database access, can read it back.

- **Repeated wrong passwords lock the account** for a short, rising interval, and
  Bookly **emails you** when that happens — so if a lockout email arrives when it
  wasn't you, someone is trying to get in.
- **Forgot your password?** Use the reset link; it's emailed to you, works once,
  and expires. Setting a new password immediately **signs out every existing
  session**, everywhere.
- Choose a strong, unique password. There is one admin account, so it is the
  entire lock on the door.

## Keeping the admin panel safe

- Your signed-in session is held **only in the browser tab** you logged in on.
  Closing the tab or browser signs you out; it isn't shared to other devices.
- Sign in on **your own trusted device**, not a shared or public computer.
- If you ever suspect your session was exposed, **change your password** — that
  alone invalidates any active session.
- The admin panel is served over HTTPS, and its pages are told not to be cached,
  so client details don't linger in a shared cache.

## A client's booking link

Each booking is reached by a private link you can **resend** from the booking
("resend access link"). Resending immediately **invalidates the old link**, so if
a client tells you their link may have been seen by someone else, resending is
the fix. The link also expires on its own after a long period.

## Your data-protection responsibilities

Bookly collects only what a shoot needs — name, email, phone, location, party
size, special requests — and records that the client **consented** at booking.
Under Rwanda's Law N° 058/2021:

- **Deletion on request.** If a client asks to be forgotten, you carry it out;
  their personal details are removed from the booking records. The bare fact that
  consent was given is kept (the law requires consent to stay demonstrable), but
  without their contact details.
- **Retention.** Keep booking data only as long as you need it to run and account
  for the work.
- **Controller registration.** Registering as a data controller with the National
  Cyber Security Authority is **your** obligation, not something the software does
  — noted here so it isn't missed.

---

*Developers: how sessions, tokens and hashing work is in the
[Auth and security](/developers/auth-and-security) developer page.*
