# Admin Login — Page Design

> **Project:** Bookly · **Phase 3 section:** 5 (with the admin shell)
> **Route:** `/admin/login` (declared **outside** `AdminLayout` and outside the client layout route; since 2026-09-25 it renders the client `ClientHeader`, see Layout)
> **File:** `frontend/src/pages/admin/AdminLogin.tsx`
> Generator template: UI UX Pro Max, 2026-09-19 ("Dashboard / Data View", 1200px). Wrong for a single sign-in card; replaced.
> This file overrides `design-system/bookly/MASTER.md` for this page. Read MASTER's "Hand-review addendum" first.
> **Overridden 2026-09-26 by `design-system/bookly/admin-console.md` (admin console redesign), which wins where they conflict:** **The client header is removed** (user decision, 2026-09-26, reversing the 2026-09-25 one): login and reset password are one place again, a centred 400px console panel with the Bookly monogram, a mono `ADMIN` eyebrow, the `h1`, the fields and an inverted-neutral full-width submit. The theme applies; there is no toggle. See `admin-console.md` §6.8 and decision 6.

## Layout

- **The client top bar (user decision, 2026-09-25).** `div.flex-col.min-h-svh` > skip link (`#main-content`) > `ClientHeader showAdminLogin={false}` > `main#main-content[tabIndex=-1]`. No client footer.
- `main`, `max-w-sm`, `flex-1` (was `min-h-svh`, now the wrapper's job), vertically and horizontally centred, `p-6`.
- One `Card` (the `card.tsx` primitive): `CardHeader` -> `CardTitle` wrapping the `h1` (`admin:signIn.title`) -> `CardContent` with the form.
- Form (`gap-4`): email field, password field (label above each), optional `role="alert"` message, submit button.
- The card sits on the tinted page background and is the page's only surface. Give it real separation (border/ring plus `shadow-md`), not a hairline.
- ~~Optional brand touch: the wordmark above the card.~~ Removed 2026-09-25: the header's wordmark replaces it.

## Details

- Inputs 44px tall, 16px text (the primitive is 32px tall today; fix in the primitive, Phase 2b, or with `className` here).
- Submit is full width. It is the one button in the app that uses `disabled` while submitting; keep it.
- Error text (`admin:signIn.invalid`, `failed`): destructive, `text-sm`, `role="alert"`, directly above the button. The API answers unknown email, wrong password and locked account identically; the page must not distinguish them.
- Password managers and paste must keep working: keep `autoComplete="username"` / `"current-password"`; add nothing that blocks paste.

## States

idle, submitting (button label swaps), invalid credentials, request failed.

## Do not

- No social login, remember-me or illustration.
- A **"Forgot password" link** comes with the reset-password page (decided 2026-09-20, MASTER section 9, item 8: built before Phase 3 section 5). Design it in that page's own design file; until it exists, the login has none.
