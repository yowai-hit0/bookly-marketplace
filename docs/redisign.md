# Bookly Visual Redesign — UI UX Pro Max → Impeccable

## Context

The Bookly frontend (`frontend/`, a Vite + React 19 + TypeScript SPA) has never had a real visual design pass — Tailwind v4 + shadcn/ui (`radix-nova` style) is wired up correctly, but `frontend/src/index.css` is still pure grayscale (`oklch(... 0 0)` everywhere) and page markup is mostly bare Tailwind utility classes. The goal is a full visual redesign of both the client-facing booking flow and the admin panel — **without touching any business/data logic** — using two third-party Claude Code skills the user wants to bring in:

- **UI UX Pro Max** (`github.com/nextlevelbuilder/ui-ux-pro-max-skill`) — a *generator*: picks a page layout pattern, a UI style, an industry-tuned color palette, and a font pairing, writes them to a persisted design-system doc (`design-system/bookly/MASTER.md` + per-page `pages/*.md`), then applies it.
- **Impeccable** (`impeccable.style`) — a *polisher*: works on an existing system, respects tokens/`DESIGN.md`, and cleans up spacing/typography/consistency + generic "AI-slop" patterns via `/impeccable polish`/`critique`/`distill`.

Decisions already confirmed with the user:
- Use **both**, in sequence: generate the system once, then polish page-by-page.
- **One unified visual system** across client + admin (they already share `components/ui/*` and one token file, so this is the natural fit, not extra work).
- Let UI UX Pro Max **auto-pick** the style/palette for a services/booking business — no manual brand direction.
- Roll out **client-facing pages first**, admin second.

## Verified codebase facts

- One SPA, no separate admin app. Routes centrally declared in `frontend/src/routes.tsx` — **that file is the source of truth for the route list** (13 routes today, including NotFound).
- All design tokens live in **one file**: `frontend/src/index.css` — confirmed structure: `@import` block (`tailwindcss`, `tw-animate-css`, `shadcn/tailwind.css`, Geist font) → `@custom-variant dark` → `@theme inline` (token→CSS-var mapping + radius scale) → `:root` (light tokens) → `.dark` (dark tokens, currently unreachable — nothing in source adds a `dark` class) → `@layer base` → FullCalendar override block at **lines 131–179** (color vars inherit from tokens automatically; `font-size: 0.875rem`/`1.125rem` are hardcoded, independent of any type-scale token).
- `frontend/components.json` confirms shadcn `style: radix-nova`, `baseColor: neutral`, `cssVariables: true`, `tailwind.config: ""` (Tailwind v4 CSS-first — **no `tailwind.config.js` exists or should be created**).
- Shared primitives: `frontend/src/components/ui/{button,card,input,label,checkbox,textarea,tabs,badge}.tsx`, used by both client and admin pages.
- Client routes (8): `pages/Home.tsx` (`/`), `pages/services/{ServiceList,ServiceDetail,SlotPicker,BookingDetailsForm,PriceSummary,BookingHeld}.tsx` (`/services`, `/services/:slug`), `pages/checkout/{CheckoutPage,PaymentProgressPage,PaymentFields}.tsx` (`/checkout/:reference/:token` and its `/payments/:ourRef` child), `pages/booking/BookingPage.tsx` (the client's private booking link: `/booking/:token`, plus `/booking/:token/payments/:ourRef` which reuses `PaymentProgressPage`), `pages/NotFound.tsx`.
- Admin routes (5, under `/admin`, shell `frontend/src/admin/AdminLayout.tsx`): `pages/admin/AdminLogin.tsx`, `pages/admin/AdminCalendar.tsx` (wraps FullCalendar), `pages/admin/{AdminCatalogue,EntityForm}.tsx`, `pages/admin/AdminBookings.tsx` (`/admin/bookings`), `pages/admin/AdminBookingDetail.tsx` (`/admin/bookings/:id` — reschedule, cancel/refund, session fee, add-ons, photo delivery).
- **Never touch** (pure logic, has matching `.test.ts` files): `frontend/src/catalogue/{api,bookings,availability,payments}.ts`, `frontend/src/admin/{api,session,catalogue,calendar-dates,calendar-events}.ts`, `frontend/src/i18n/locales/en.json` (copy, not visual; exception, user decision 2026-09-20: new keys may be added when a change truly needs them, existing strings are never edited).
- `package.json` scripts confirmed: `dev`, `build`, `typecheck` (`tsc -b --noEmit`), `lint` (`oxlint`), `test` (`vitest run`), `test:e2e` (`playwright test`).

## Phase 0 — Branch & rollback scaffolding

1. Confirm clean working tree, branch off `main` as `redesign/visual-only`. All work happens here; `main` untouched until final merge.
2. Commit convention: `chore:` (skill install), `design:` (UI UX Pro Max), `polish:` (Impeccable). One invocation per commit — never batch two tool runs into one commit.
3. Stage explicit paths only (never `git add -A`), so an unexpected touched file is visible before it enters history.

## Phase 1 — Install the skills

Install **UI UX Pro Max first**; install **Impeccable right before Phase 3** (it scans for an existing design system, so it should see UI UX Pro Max's finished, committed output, not a half-applied one).

**UI UX Pro Max** — pick one path (needs explicit approval; touches outside the repo / hits network):
- Plugin marketplace (global `~/.claude` config): `/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill` then `/plugin install ui-ux-pro-max@ui-ux-pro-max-skill`.
- Global npm CLI (writes into repo's `.claude/skills/` — do not hand-edit those files): `npm install -g ui-ux-pro-max-cli` then `uipro init --ai claude`.

**Impeccable**: `npx impeccable install` from the repo root, right before Phase 3. Verify with the read-only `/impeccable critique` before ever running `/impeccable polish`.

## Phase 2 — Foundation pass (UI UX Pro Max, run once)

This is the one point where layout/style/palette/type get decided — must happen exactly once so the whole app stays one system.

### 2a — Generate and persist the design system (docs only, no code touched)

Run the generator with `--persist` so the result is a reviewable file, not just chat output:

```bash
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<services/booking business>" --design-system --persist -p "Bookly"
# then one run per route, adding --page:
... --design-system --persist -p "Bookly" --page "home"
```

Pages to generate: `home`, `services`, `service-detail`, `checkout` (also covers `PaymentProgressPage` and `PaymentFields`), `booking`, `admin-login`, `admin-calendar`, `admin-bookings`, `admin-booking-detail`, `admin-catalogue`.

**Discovery rule — pages not on this list.** Before generating (and again before each Phase 3 apply), compare `frontend/src/routes.tsx` and `frontend/src/pages/**` against this list and the Phase 3 table. For any route or page that isn't listed:
- do not skip it, and do not fold it silently into another page's file;
- create its design file `design-system/bookly/pages/<page>.md` (layout, and only deviations from `MASTER.md`);
- add it to the Phase 3 table (client pages before admin pages), or note where it belongs;
- **tell the user** which unlisted pages were found and which files were created. This is a report, not a blocking question — then continue;
- commit the new page files as a docs-only `design:` commit. The protected-file list below still applies.

Expected output (new directory at the repo root, docs only):

```
design-system/
└── bookly/                     # One folder per project (slug of -p "Bookly")
    ├── MASTER.md               # Global source of truth (colors, typography, spacing, components, layout rules)
    └── pages/                  # Page-specific overrides (only deviations from Master)
        ├── home.md
        ├── services.md
        ├── service-detail.md
        ├── checkout.md
        ├── booking.md
        ├── admin-login.md
        ├── admin-calendar.md
        ├── admin-bookings.md
        ├── admin-booking-detail.md
        └── admin-catalogue.md
```

- `MASTER.md` — global rules: **color palette**, **font pairing**, spacing, component styles, UI style, effects, anti-patterns, global layout rules.
- `pages/<page>.md` — per-page **layout description** (section order, structure). Records only what differs from `MASTER.md`; a page file wins over `MASTER.md` for that page.

If the generator's output doesn't match this tree, move or rename files to match before committing.

**Review by hand before continuing.** The skill's layout "pattern" is landing-page oriented: Home and ServiceList map well, but the booking funnel (SlotPicker → BookingDetailsForm → PriceSummary), checkout, the client booking page and the admin pages need hand-written layout notes in their `pages/*.md`. `admin-bookings` and `admin-booking-detail` are data-dense operate screens (status badges, money due/refund-due amounts, destructive cancel/refund actions), so they need the most care. Commit as `design:` (docs only) before any code changes.

### 2b — Apply tokens and fonts (driven by `MASTER.md`)

**Before running**: explicitly instruct it to only:
- rewrite oklch values inside `:root`/`.dark`;
- swap the font `@import` (Geist → the chosen pairing) and set the font families in `@theme inline` (`--font-sans`, plus a heading font var if the pairing has one);
- change Tailwind classNames in existing files.

It must not introduce a new theming mechanism, not bypass shadcn conventions, not scaffold a `tailwind.config.js` (Tailwind v4 + `@tailwindcss/vite` means such a file would silently do nothing — a false-positive "it worked" trap), and not delete the `@import "shadcn/tailwind.css"` line (a tool may mistake it for a duplicate of the `tailwindcss` import).

- **Scope**: `frontend/src/index.css` (token values + font import/family vars) + `frontend/src/components/ui/*.tsx`.
- **Explicitly out of scope**: everything under `frontend/src/pages/` (page layouts are applied in Phase 3, from `pages/<page>.md`), `frontend/src/admin/AdminLayout.tsx`, `components.json`, and the full protected/logic list below.

**Checkpoint**: `npm run dev`, visually check `/` and `/admin/login` (both consume the same primitives/tokens, so global changes should already show). Confirm the new fonts load. Run `npm run typecheck && npm run lint && npm run test`. Diff-review, commit, tag `redesign-foundation-done`.

## Phase 3 — Section-by-section rollout (client → admin)

Install Impeccable now if not already. Loop per section: **UI UX Pro Max scoped apply → checkpoint → Impeccable polish → checkpoint → commit**.

Each apply step must first read `design-system/bookly/MASTER.md` and that page's `design-system/bookly/pages/<page>.md`, and implement the layout described there (page file wins over MASTER). Layout is applied here, not in Phase 2. Re-run the **Discovery rule** (Phase 2a) before each apply: any page found that isn't in this table gets its own `pages/<page>.md`, a row here, and a report to the user.

| # | Section | Files |
|---|---------|-------|
| 1 | Home + NotFound | `pages/Home.tsx`, `pages/NotFound.tsx` |
| 2 | Services / booking flow | `pages/services/{ServiceList,ServiceDetail,SlotPicker,BookingDetailsForm,PriceSummary,BookingHeld}.tsx` |
| 3 | Checkout flow | `pages/checkout/{CheckoutPage,PaymentProgressPage,PaymentFields}.tsx` |
| 4 | My booking (client magic-link page) | `pages/booking/BookingPage.tsx` (its `/payments/:ourRef` route reuses `PaymentProgressPage` from Section 3) |
| 5 | Admin shell + login | `admin/AdminLayout.tsx`, `pages/admin/AdminLogin.tsx` |
| 5b | Admin availability, settings, reset password | `pages/admin/{AdminAvailability,AdminSettings,AdminResetPassword,WorkingHoursForm,BlockForm,AdminField}.tsx` — added by the discovery rule 2026-09-21 (shipped as feature work in `d02bd41` with no design file). Design files: `pages/{availability,settings,admin-reset-password}.md`. Restyle with section 5, after the shell and login. |
| 6 | Admin calendar | `pages/admin/AdminCalendar.tsx` + FullCalendar CSS block (`index.css` lines 131–179) — needs an explicit named pass since a tool scanning only `.tsx` files won't touch it |
| 7 | Admin bookings | `pages/admin/{AdminBookings,AdminBookingDetail}.tsx` |
| 8 | Admin catalogue | `pages/admin/{AdminCatalogue,EntityForm}.tsx` |

> **Gate before Section 5 (user decision 6, 2026-09-20):** stop and tell the user before starting Section 5. The Working hours, Availability blocks, Settings and reset-password pages, and the calendar click-through, are built first as feature work (see `docs/redesign-pending.md`, including its branch note), then get design files in `design-system/bookly/pages/` and join Section 5.

After each section's apply: dev-server visual check of that section's routes, full test gate, diff-review, commit. After each section's polish: re-check, optionally re-run `/impeccable critique`, same gate, commit.

**Milestone after Section 4** (all client pages done — user's stated priority): full manual click-through of the live booking funnel (Home → ServiceList → ServiceDetail → SlotPicker → BookingDetailsForm → PriceSummary → BookingHeld → Checkout → PaymentProgress), then the emailed booking link (`/booking/:token` → BookingPage, including its payment-progress route), since layout breaks in stateful multi-step flows may only appear mid-flow. Run `npm run test:e2e`. Tag `redesign-client-done`.

**Milestone after Section 6**: verify `.bookly-event--conflict` (destructive outline) and `.bookly-event--pending_payment` (dashed border) — functional visual cues, not decoration — stay legible against the new palette.

**Milestone after Section 7**: verify the seven booking statuses (`pending_payment`, `confirmed`, `completed`, `no_show`, `expired`, `cancelled_by_client`, `cancelled_by_admin`) stay distinguishable as Badges, and that "still to pay" / "to refund" amounts and the destructive cancel/refund states stay legible against the new palette.

**Milestone after Section 8**: verify EntityForm's destructive/error states and Tabs/Badge usage stay legible and consistent.

## Phase 4 — Final cross-cutting pass

Once all 8 sections are done, run `/impeccable distill` once across the whole app to consolidate redundant patterns. Then: full test gate (`typecheck`, `lint`, `test`, `test:e2e`), `git diff main --stat` to confirm the touched-file list matches expectations (zero hits on the protected list), one more full visual pass over every route in `routes.tsx` (13 today) for consistent radius/color/spacing/type. Only then merge `redesign/visual-only` into `main`.

## Guardrails — protected files (verify absent from every diff, every invocation)

- `frontend/src/catalogue/{api,bookings,availability,payments}.ts` (+ `.test.ts`)
- `frontend/src/admin/{api,session,catalogue,calendar-dates,calendar-events}.ts` (+ `.test.ts`)
- `frontend/src/i18n/locales/en.json` — copy/content, not visual. **Exception (user decision, 2026-09-20): additive new keys are allowed when a change truly needs them (skip-to-content link, later contact details); existing strings are never edited.**
- `frontend/components.json`, `frontend/vite.config.ts`, lockfiles — review separately if touched, never accept as part of a visual commit

Allowed new directory: `design-system/` (repo root, docs only — the persisted design system from Phase 2a). Nothing else outside `frontend/src/{index.css,components/ui,pages,admin/AdminLayout.tsx}` should appear in a diff.

State this list verbatim in every prompt given to either skill. Working tree must be clean before every invocation so its diff is fully attributable; read the full `git diff` (not skim) before staging explicit paths.

## Rollback strategy

- All work on `redesign/visual-only`; `main` stays deployable throughout.
- Two commits per section (apply + polish) → fine-grained `git revert` of one tool's pass without touching neighbors.
- Tags at `redesign-foundation-done` (end of Phase 2) and `redesign-client-done` (end of Section 4) as safe fallback points.
- `design-system/` is tracked by git and reverts with the branch (Phase 2a is its own docs-only commit).


## Verification

- After every section: `npm run typecheck && npm run lint && npm run test` from `frontend/`.
- After client sections complete and again at the end: `npm run test:e2e` (Playwright) plus a manual click-through of the booking funnel in `npm run dev`.
- Final check before merge: `git diff main --stat` shows no hits on the protected file list; full visual pass across every route in `routes.tsx` (13 today).
