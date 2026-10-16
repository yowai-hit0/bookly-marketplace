# Client Shell (layout route) — Page Design

> **Project:** Bookly · **Phase 3 section:** 1 (revisited, 2026-09-21)
> **Route:** a new pathless layout route wrapping `/`, `/services`, `/services/:slug`, `/checkout/*`, `/booking/*` and `*`
> **File:** `frontend/src/pages/ClientShell.tsx` (new), wired in `frontend/src/routes.tsx`. It sits in `pages/` rather than `components/` to stay inside the plan's allowed paths; `components/` holds only the shadcn `ui/` primitives.
> **Added by the discovery rule (2026-09-21):** no client layout existed — every client page rendered alone, with no way to reach any other page except the service links inside it.
> This file overrides `design-system/bookly/MASTER.md` for these pages. Read MASTER's "Hand-review addendum" first.
> **Overridden 2026-09-27 by `design-system/bookly/client-front.md`** (the client front redesign, light and dark): the 72px canvas bar with a mark, Services / How booking works links, the theme button, "My booking" as an icon below `sm`, and a three-column footer with a contact block (client-front.md §7). The structural rules below (siblings, skip link, static, no radios, no `dl`, button-free footer) still hold.

The admin has a shell (`pages/admin-shell.md`); the client had none. A client who lands on `/checkout/...` or `/booking/...` from an email has, today, no route to anything else. This adds the header and footer, and nothing more.

## The hard structural rule: siblings, never a wrapper

The header and the footer are **siblings of each page's own `main`**, inside a plain `div.min-h-svh.flex.flex-col`:

```
div.flex-col.min-h-svh
├── a.skip-link            (first focusable in the document)
├── header  > nav
├── div#main-content       (tabIndex -1, flex-1) → <Outlet /> → the page's own <main>
└── footer
```

**Do not add a wrapping `<main>`.** Each client page already renders its own, and `frontend/e2e/checkout.spec.ts` and `client-booking.spec.ts` call `page.locator('main').innerText()`, which throws on two matches. The container around `<Outlet />` is a `div`, not a landmark.

## Skip link

First focusable element in the document: a plain `<a href="#main-content">` (not a router `Link` — the browser's own fragment navigation is what moves focus). `sr-only focus:not-sr-only`, and when shown a pill at the top left with a visible ring, above everything. Target is `#main-content`, which carries `tabIndex={-1}` so focus actually lands there.

This is not decoration. It is what keeps the keyboard journeys honest once a header sits above every page: Tab once from load reaches the skip link, Enter jumps the nav, and the next Tab is the page's first control. The e2e specs assert exactly that sequence.

## Header

- `header` > one `nav[aria-label]`. `bg-card`, `border-b`, **not sticky** (a sticky bar over the slot picker and the payment form risks obscuring focus; static is the safe default, same reasoning as the admin top bar).
- Inner row: `mx-auto max-w-6xl px-4`, `flex items-center justify-between gap-4`, `h-16`.
- **Left: the wordmark**, `common:appName` (existing key), heading font, semibold, `text-lg`, wrapped in a `Link` to `/`. It is a link, not an `h1` — **the page's `h1` belongs to the page.** An `h1` here would make two on the landing page and would break `admin-bookings.spec.ts`-style unqualified level-1 lookups on the client side too.
- **Right: "Book now"** -> `/services`, styled as a `Button` (`asChild` on a `Link`), default variant, the one primary action in the bar.
- **Before it: "Admin login"** -> `/admin/login` (`shell:nav.adminLogin`), `ghost` variant so it never competes with "Book now". Still a link, not a button. **User decision, 2026-09-25.** Labelled "Admin", not a bare "Log in": clients have no accounts, and a bare "Log in" would send them to a form that is not theirs.
- The header is the exported `ClientHeader` (in `ClientShell.tsx`), so `/admin/login` wears the same bar (see below).
- **"My booking" (2026-09-25, user decision; prompt item 5):** a `ghost` link, first after the wordmark. It goes to the booking this device last opened (its token kept in `localStorage` under `bookly.bookingToken`, written when a booking page loads, removed when that token answers "not found"), otherwise to `/my-booking`. Order: Bookly, My booking, Admin login, Book now.
- **Phones (2026-09-25, user decision):** the four items need about 413px. Below `sm` the header's "Admin login" is hidden and the same link appears as the last item of the footer's list instead; from `sm` up it is in the bar and not in the footer. No menu or drawer.
- **Shared devices:** a remembered token lets anyone at this device open that booking from the header. The link was already in the browser's history, so this adds little exposure, but it is exposure: stated here so it is a choice, not a surprise.
- **No "My booking" link.** "My booking" was designed to point at a tokenless lookup page where a client re-sends their own magic link. **No such endpoint exists** (checked 2026-09-21: the only resend is `POST /api/admin/bookings/:id/resend-link`, behind the admin session guard). **User decision, 2026-09-21: ship the shell without it** rather than invent an endpoint or fake the page. When a public resend endpoint exists, this bar grows a second link and the lookup page gets its own file. Tracked in `docs/redesign-pending.md`.
  **Superseded 2026-09-25 (user decision):** the public resend now exists, `POST /api/booking-links` (one email with a fresh link per current booking, rate limited per address and per IP, the same 202 whatever it finds), and the lookup page is `/my-booking` (`pages/my-booking.md`). The header's "My booking" link arrives with item 5 of `docs/prompts/client-access-and-admin-polish.md`.
- At 375px the wordmark and both links fit on one row (checked 2026-09-25, no horizontal scroll). No menu, no drawer, no hamburger: one link does not need disclosure, and a drawer is state, a focus trap and scroll lock — logic this branch does not add.
- **No radio inputs anywhere in the header.** `services.spec.ts` and `checkout.spec.ts` count radios page-wide.

## Footer

- `footer`, `bg-card`, `border-t`, `mt-auto` so it sits at the bottom of a short page. Inner `mx-auto max-w-6xl px-4 py-8`.
- Three things, in this order: the wordmark line, a short link list, and the fine print. `flex-col gap-6`, becoming `sm:flex-row sm:justify-between` for the first two.
- **Link list:** a `ul` of plain text links — services, and back to the top of the current page is *not* a link (no `#` anchors that do nothing). Keep it to the routes that exist. Every link is a real route; no placeholder `#`, no "coming soon".
- **The services link must not be named "All services."** That exact accessible name is matched page-wide by `services.spec.ts`, `booking.spec.ts` and `slot-picker.spec.ts`. Use the footer's own key.
- **No `<dl>` in the footer.** `booking.spec.ts` reads `dl dt` page-wide and compares an exact eight-row array.
- **No buttons in the footer.** `client-booking.spec.ts` asserts the invalid-link page offers no button; scoping that assertion to `main` is the proper fix, but a button-free footer keeps the page honest anyway — there is no action down here.
- Fine print: `text-xs muted`, the app name and nothing legal that has not been written. **No copyright year invented against a name that does not exist**, no social icons, no address, no phone. The photographer's contact details are still an open question (`docs/redesign-pending.md` section 2); when they arrive, they belong here.
- Footer copy must avoid the words **"processing"**, **"card"** and **"airtel"**: `services.spec.ts` and `checkout.spec.ts` assert those never appear (scoped to `main` as part of this change, but the words have no business here either).

## Which routes it wraps

All of them on the client side, including `*` (NotFound) — a visitor who mistypes a URL is exactly the visitor who most needs a way out. **`/admin/*` is untouched**: it has its own shell, and `/admin/reset-password` is deliberately bare. **`/admin/login` wears the client header only (user decision, 2026-09-25)**, with the admin link hidden because it would point at itself. It gets no footer and stays outside the layout route.

The checkout and booking pages get the shell too. They are reached from an email, and the header is the only thing on them that leads anywhere. It must not compete with the page's own action: static bar, one button, no second colour.

## Do not

- No language switcher (English is the only locale that ships).
- No search, no account menu, no cart, no breadcrumb: none exist.
- No newsletter form, no social links, no logo image — there is no logo.
- No new `main`, no sticky anything, no scroll-triggered header changes.
