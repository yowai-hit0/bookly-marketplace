# Redesign: what still needs your attention

## Run state

Append-only. The newest entry is last. Progress lives here and in git history, never only in a context window.

### Stage 0 — clear the open items (2026-09-21) — DONE

- Pushed `main`, `feature/admin-availability-settings-reset` and `redesign/visual-only` to origin (all were ahead).
- `docs: track the user-journeys write-up` (`0611cf5`) — the file was untracked, so Stage 4's rewrite would have had no reviewable diff.
- `fix: move focus to the cancelled heading after a client cancels` (`5873373`) — `BookingPage.tsx`, plus a Vitest case asserting focus. Gate green: 1269 vitest tests.
- `design:` (this commit) — discovery rule: wrote `pages/{availability,settings,admin-reset-password}.md`, added row 5b to the Phase 3 table.
- **Decision, not in the diff:** the three new page files put availability and settings on the 1.5rem `h1` side of the admin title inconsistency (section 5 below), and set the last two nav icons (`CalendarClock`, `Settings`) that `admin-shell.md` deferred to them.
- **Next action:** Stage 2 — the client shell, landing page and tokenless lookup page. First check the backend for an existing resend / magic-link endpoint; if none exists, stop and report.

### Stage 2 — client shell and landing page (2026-09-21) — DONE

Stage 0's docs commit was `06f958a`.

- `design:` page files `client-shell.md` and a rewritten `home.md`, then `feat:` (this commit): `pages/ClientShell.tsx`, a rewritten `pages/Home.tsx`, the layout route in `routes.tsx`, two new `en.json` namespaces (`shell`, `landing`, 67 lines added, nothing edited).
- **Blocking check, answered:** there is **no public resend / magic-link endpoint**. The only resend is `POST /api/admin/bookings/:id/resend-link`, inside `adminRouter` behind the session guard; no public route takes an email or a reference. **User decision, 2026-09-21: ship the shell with one nav link ("Book now") and no lookup page** rather than invent an endpoint or fake the page. Section 2 below carries the follow-up.
- **Decisions not obvious from the diff:**
  - `ClientShell.tsx` lives in `pages/`, not `components/`, to stay inside the plan's allowed paths; `components/` holds only shadcn primitives.
  - The five e2e tab-order tests were repaired by **taking the skip link**, not by loosening them: Tab, assert the skip link, Enter, then the original sequence. The journey is still keyboard-only from page load.
  - Six page-wide e2e assertions (button, radio, list and text counts) were **scoped to `main`**. They still passed unscoped; scoping makes them pass by design rather than by luck of the footer's wording.
  - Testing Library reports a page's inner `<header>` as a `banner`, so the routing test names the shell by its nav label instead. The DOM is correct; the role engine is loose.
- **Counts:** vitest 1285 passed (39 files), playwright 38 passed. Typecheck and lint clean.
- **Next action:** Stage 3 — spawn the Section 5 subagent (admin shell + login, plus the three pages from row 5b), sonnet, thinking high, one at a time.

### Stage 3, Section 5 — admin shell, login, availability, settings, reset password (2026-09-21) — DONE

Stage 2's commits were `e7ca0e1` (design) and `4ead62e` (feat).

- Subagent restyled 9 files; `index.css` needed nothing. One additive `en.json` key, `admin.skipToContent`. No protected file in the diff, no unit test changed, **no e2e spec needed repair** — all 38 passed first time, including `admin-catalogue.spec.ts:157`, which navigates by the nav links.
- **`AdminLayout.tsx` is the real change:** top bar -> one `nav` that reflows (sidebar from `lg`, top bar below), a skip link to a new `#admin-content` wrapper, a lucide icon per link, and the active pill. The wordmark stayed a `<span>`; an `h1` there would have made `admin-bookings.spec.ts` lines 357 and 403 strict-mode ambiguous.
- **Two things I changed after the subagent returned:**
  - sign-out had no `ml-auto`, so on the top bar it sat beside the wordmark instead of at the right edge as `admin-shell.md` specifies. Added `ml-auto lg:ml-0`. Verified at 412px: sign-out at x=360, five nav links wrapping to two rows, every one 44px tall.
  - `AdminLayout` had **no unit test at all**, so the new skip link and the wordmark-is-not-an-`h1` rule were covered by nothing. Added `src/admin/AdminLayout.test.tsx` (6 cases), which pins both, plus the five link names the e2e suite navigates by.
- **Accepted deviation from the page files:** `admin-login.md` and the other admin page files say "inputs 44px, the primitive is 32px today, fix it here". That note is stale — Phase 2b gave `Input` and `Button` `pointer-coarse:h-11`, so they are 44px on touch and 32px on a fine pointer, like every other form in the app. Only `AdminField.tsx`'s hand-rolled `SELECT_CLASS` had genuinely been missed, and it was fixed.
- **Counts:** vitest 1291 passed (40 files), playwright 38 passed. Typecheck and lint clean.
- **Next action:** Section 6 — the admin calendar, including the FullCalendar CSS block in `index.css`. Warn the subagent about `.bookly-event--conflict` (`admin-calendar.spec.ts:207`), `.fc-toolbar-title`, `.fc-daygrid-day`, `.fc-timegrid-col` and the `[data-kind]` chip innerText assertions.

### Stage 3, Section 6 — admin calendar (2026-09-21) — DONE

Section 5's commit was `8e79c87`.

- Two files: `pages/admin/AdminCalendar.tsx` and the FullCalendar block in `index.css`. No protected file, **no new `en.json` key**, no e2e or unit assertion changed — all 38 e2e passed first time.
- **The `!important` decision, and why it is not laziness.** `admin/calendar-events.ts` is protected and sets `backgroundColor` / `borderColor` / `textColor` per status in its `COLOURS` map; FullCalendar applies those as literal inline styles on the event element, which beats any class selector. `!important` in the CSS is the only lever that changes an event's look without editing a protected file. Verified by reading `calendar-events.ts:45-50`. It is documented in a comment at the top of the block.
- **Only four booking statuses can reach the calendar** — `calendar-events.ts:13` types `BookingStatus` as `pending_payment | confirmed | completed | no_show`; cancelled and expired bookings never appear. The seven-status check belongs to Section 7, which is where the doc's own milestone puts it.
- **Greyscale check, done by me, not taken on trust.** Rendered all four statuses plus a block and a conflict, then applied a real `grayscale(1)` filter. The hold's dashed edge and the conflict's 2px inset outline both read clearly, and the block's diagonal hatch is the only non-solid fill. Honest limit: completed / no-show / confirmed are close in the fill-and-border channel alone; what separates them in greyscale is the icon and the always-present text label, which is what MASTER section 7 asks for. Also confirmed the chips' `innerText` is unchanged by the new icons (`"09:00 Grace M Confirmed Conflicts with a block"`), which is what the `[data-kind]` assertions read.
- **A stale design file corrected, not the code.** `pages/admin-calendar.md` said "block events are not clickable: default cursor, no hover state". The feature work in `d02bd41` made blocks clickable (a block opens the availability page that edits it — your decision, section 1 below), so the page file was written before the behaviour and was wrong. The subagent kept blocks looking clickable and flagged it; I corrected the page file rather than styling a working affordance as inert.
- **Counts:** vitest 1291 passed (40 files), playwright 38 passed. Typecheck and lint clean.
- **Next action:** Section 7 — `AdminBookings` and `AdminBookingDetail`. Warn the subagent about `section`-filtered-by-`h2` locators (`:358,382,405,427,444`), glued `dt`+`dd` strings like `'Total40,000 RWF'` (`:383,:406-417`), and the unqualified `heading level 1` lookups at `:357` and `:403`.

### Stage 3, Section 7 — admin bookings list and detail (2026-09-21) — DONE

Section 6's commit was `65e4150`.

- Two files: `AdminBookings.tsx` and `AdminBookingDetail.tsx`. **`status-badge.tsx` was not touched**, so the client pill is provably unchanged — the admin simply adopts it, which was the point of this section. No protected file, no new `en.json` key, no e2e or unit assertion changed; all 38 e2e passed first time, including the glued-string and `section`-filter locators.
- **The milestone checks, done by me rather than taken on trust.** The subagent reported its contrast figures but said it had *not* re-run a greyscale pass, arguing the component file was unchanged. That argument does not cover how the badges read in the admin's own context, so I rendered all seven statuses in the real list and checked both myself:
  - **Contrast, measured from what Chromium actually paints** (computed styles come back as `oklch`, so each colour was painted to a canvas and read as sRGB): "still to pay" `#475569` on the page background `#F0F9FF` = **7.11:1**; "to refund" `#B91C1C` on the same = **6.07:1**. Both clear 4.5:1. These match the subagent's numbers exactly.
  - **Greyscale:** under a real `grayscale(1)`, the seven stay apart — dashed (hold) and dotted (expired) are unmistakable, and the rest separate by fill, edge weight and a distinct icon. Honest limit, the same one as Section 6: completed vs no-show, and the two cancelled states, are close in the fill-and-edge channel alone; the icon and the always-present label carry the distinction. That is what MASTER section 7 specifies, so it passes, but it is not a strong pattern difference.
- The money column was never actually right-aligned (it had `tabular-nums` but no `text-align`); it is now, header included. The detail page's `Line` values gained the `tabular-nums` the page file had always asked for.
- **Counts:** vitest 1291 passed (40 files), playwright 38 passed. Typecheck and lint clean.
- **Next action:** Section 8 — `AdminCatalogue` and `EntityForm`. Warn the subagent about `[data-slot="card"]` (`admin-catalogue.spec.ts:99`, a shadcn internal), `'Weddings Active'` (`:100`) and the `·`-separated line (`:113`), all of which are concatenated visual text.

### Stage 3, Section 8 — admin catalogue and EntityForm (2026-09-22) — DONE

Section 7's commit was `0422665`.

- **Found on resume, before any work:** `frontend/src/index.css` had an uncommitted change nobody in this run made (mtime 2026-09-21 23:34) that **swapped the `:root` and `.dark` selector names**, making the undesigned dark palette the app default — `/` painted `rgb(10,10,10)`. All 1291 vitest and 38 playwright passed with it in place, so **nothing in the gate catches a palette swap.** Reported and reverted on your instruction. Worth knowing: no test in this repo asserts a colour.
- A genuinely small section: the page was already conformant. Verified rather than assumed — Edit and Activate are `outline sm`, Delete is `destructive sm`, the badge is `default`/`outline`, and `Card` usage is untouched shadcn, so `[data-slot="card"]` still matches. No protected file, no `components/ui/` file, no new `en.json` key, no e2e or unit assertion changed.
- `EntityForm` becomes a filled sub-surface (`bg-muted/40`, `rounded-lg`, no border) so a nested form stops reading as a nested card, and its hint and error both move to `text-sm`.
- **Contrast**, on the two real backgrounds the form sits on: destructive error **6.15:1** in a card, **5.90:1** on the page; muted hint **7.19:1** and **6.91:1**. All clear 4.5:1.
- **The title inconsistency, mostly closed.** `docs/redesign-pending.md` section 5 flagged four admin pages at 1.25rem. Availability and Settings moved in Section 5, Catalogue moves here, so **only AdminCalendar is left at `text-xl`**. I also moved the catalogue intro from `text-xs` to `text-sm` to match Availability and Settings, and corrected `pages/admin-catalogue.md`, whose "h1 (xl) + text-xs intro" was the generator's original and never a deliberate choice. `pages/admin-calendar.md` line 11 still carries the same stale pair.
- **Counts:** vitest 1291 passed (40 files), playwright 38 passed. Typecheck and lint clean.
- **Next action:** Phase 4 — `/impeccable distill` across the whole app, then the full gate including e2e. **Carry into it:** AdminCalendar's `h1` is the last `text-xl` and its intro the last `text-xs`; fix both there and correct `pages/admin-calendar.md` line 11. Then `git diff main --stat` for protected-file hits, and a visual pass over every route.

### Phase 4 — distill and the cross-cutting pass (2026-09-22) — DONE

Section 8's commit was `d3c542d`.

- **The title inconsistency is closed.** AdminCalendar was the last page at `text-xl` with a `text-xs` intro; it now matches the other five in-shell admin pages at `text-2xl` / `text-sm`, and `pages/admin-calendar.md` line 11 is corrected. Login and reset password stay at `text-xl`: they sit outside the shell on a card, which is a different thing.
- **Three real duplications removed** (the whole point of distill — nothing was removed for its own sake):
  - the solid-red irreversible confirmation was an identical hand-written `className` in **three** files (client cancel, admin cancel, "Block anyway"). It is now a `destructive-solid` Button variant. The tinted `destructive` opens the question; the solid one answers it.
  - the skip link was the same long class list in both shells; it is now `components/ui/skip-link.tsx`.
  - `AdminBookingDetail`'s add-on `<select>` hand-rolled what `SELECT_CLASS` already provided. Measured before and after: **223px both ways**, so no layout change.
- **Visual pass, all 13 routes at 1280px and at Pixel 7:** no React error boundary and no horizontal overflow anywhere. (Two crashes during the pass were my own mock's payload shape, not the app; the second was `sharedAddons`.)
- **`git diff main` scope check.** No hit on the logic files or `components.json` / `vite.config.ts`. `en.json` is **68 added, 0 removed**. Outside the normally allowed paths: `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json`, this file, the e2e specs — all already on the pre-merge list below — **plus `frontend/package.json` and `frontend/package-lock.json`**, which are the Phase 2 font swap (Geist out, Poppins and Open Sans in) in commits `c37410b` and `2bb949e`. The guardrail asks that lockfiles never ride along in a visual commit; they did not, so this is accounted for rather than a violation. Add it to the pre-merge list.
- **DESIGN.md and its sidecar corrected, not regenerated.** Six claims had gone false: "no site header or footer on public pages" (a rejection the client shell overturned on your instruction), "all admin pages are still their pre-redesign layouts", the 1.25rem titles, the public-page layout description, the destructive override, and the admin cards' missing shadow. The sidecar also carried a **"Don't add ... a site header or footer on public pages"** rule, which would have told a future Impeccable run to delete the client shell. **I corrected those in place rather than re-running `/impeccable document`,** because a full regeneration rewrites all 310 lines and discards the hand-review that `MASTER.md` cites. If you want the regeneration anyway, it is still open.
- **Final counts:** typecheck clean, lint clean, **vitest 1291 passed (40 files)**, **playwright 38 passed**. No `.skip`, `.only` or `fixme` anywhere in either suite.
- **Next action:** Stage 4 — walk the shipped app against `docs/user-journeys.md` sections 5, 6 and 7, rewrite its route map and gap list, then the closing test sweep.

### Stage 4 — journey reconciliation and the closing test pass (2026-09-23) — DONE

Phase 4's commit was `56ecb21`.

- **Walked, not remembered.** Chromium with `/api` mocked, at 1280px and emulated Pixel 7. Every route in section 1 was opened and every gap-list row re-checked. One first reading was wrong and was corrected: the signed-out redirect looked like it had not happened because I read the URL before it settled; checked properly, `/admin/settings` does land on `/admin/login`, and carries nothing about the destination, so **gap 11 is genuinely still open**.
- **Four gaps closed**, each verified rather than assumed: 1 (availability and settings pages render), 2 (login carries one "Forgot your password?" link to a real reset page), 3 (one click on a month-view booking landed on `/admin/bookings/b9`), 6 (`/` is a landing page with three routes into `/services`).
- **Sixteen still open**, each with what I saw. The sharpest: `/privacy` still answers Not found; no contact detail exists anywhere on the client side; the `confirmed` payment view still has no link onward; the calendar opens in Month view on a phone, not day.
- **Ideal-journey steps the app still cannot do** are listed at the end of section 7 — seven of them, five client and two admin.
- **Sections 2 and 3 contradicted the rewrite** (a mermaid node calling `/` a status stub, a line saying "Home has nothing that leads to `/services`", a row saying `/admin/reset-password` shows "Page not found"). Those three were corrected in place and marked, rather than shipping a doc that argues with itself. The rest of sections 2-6 still date from 2026-09-20 and the header now says so.
- **Coverage for the closed gaps.** Gaps 1, 3 and 6 were already covered (`AdminSettings.test.tsx` and `AdminAvailability.test.tsx` render through the real routes; `AdminCalendar.test.tsx:393` asserts the click-through; Home, ClientShell and routes specs cover the landing page). **Gap 2's entry point was covered by nothing** — the reset page had its own spec but no test proved the way in existed. Added one to `AdminLogin.test.tsx`.
- **Loosening sweep.** Eleven assertions changed across the branch's e2e specs. Five are the tab-order repairs, which **assert more** than before, not less (the skip link exists, is first, and Enter on it hands focus to the page). Six narrowed a page-wide count to `main`; the coverage they gave up is re-established in `ClientShell.test.tsx`, which asserts the header and footer contain no button, radio, form control, `aria-disabled`, `dl`, or the words "processing", "airtel" and "card". I extended that test during this sweep to cover form controls and `aria-disabled`, which was the one part of the arrangement not yet proved. **Nothing was loosened without its coverage moving somewhere explicit.**
- **Final counts:** typecheck clean, lint clean, **vitest 1292 passed (40 files)**, **playwright 38 passed**. No `.skip`, `.only`, `fixme` or `todo` in either suite.
- **Next action:** none — the run is finished. What remains is on the list below, and the pre-merge item in section 5 now includes `frontend/package.json` and `frontend/package-lock.json` (the Phase 2 font swap).

---

Updated 2026-09-21, after the Section 5 feature work. The reasoning behind each item is in `design-system/bookly/MASTER.md`, section 9. This file is the checklist; tick items off as they are done.

## 1. Before Phase 3 section 5 -- done (2026-09-21)

Decisions 6, 7 and 8, built as feature work on `main` (commit `d02bd41`) and merged into `redesign/visual-only`. Every endpoint already existed, so none of it touched the backend. Each page still needs a design file in `design-system/bookly/pages/` and joins Section 5.

- [x] **Working hours** (weekly hours and dated open/close overrides). `/admin/availability`.
- [x] **Availability blocks**, with the overlap warning (spec 6.4: named, never silently saved over a confirmed booking). Same page, plus "Block time" on the calendar.
- [x] **Settings** (booking-fee rate, minimum notice, hold, buffer, delivery days). `/admin/settings`.
- [x] **Password reset page** at `/admin/reset-password`, plus "Forgot your password?" on the login page. The token travels in the URL fragment, so it reaches no server log or referrer.
- [x] **Calendar click-through:** a booking event opens `/admin/bookings/:id`. A block opens the availability page that edits it, so every event FullCalendar puts in the tab order leads somewhere.
- [x] **The final admin nav** is five links: calendar, bookings, catalogue, availability, settings. **Your decision, 2026-09-21: working hours and blocks share one Availability page,** because between them they answer one question -- when can a client book?

**Still to design (Section 5 and after).** These shipped wearing the pre-redesign admin styling, which is what Section 5 onward restyles. ~~`availability.md` and `settings.md` do not exist yet; write them before Section 5 applies anything to those two pages.~~ **Done 2026-09-21:** `pages/availability.md`, `pages/settings.md` and `pages/admin-reset-password.md` are written and the Phase 3 table has a row 5b. Section 5 no longer restyles these three pages blind.

**Branch note (settled).** The work touched `en.json` and `index.css`, so it was built on `main` and merged in; `git diff main` on the visual branch is unchanged by it, and the protected-file check still passes.

## 2. Waiting on you or the client

- [ ] **Photographer contact details** (decision 9): phone, WhatsApp and/or email. Three messages tell clients to "contact the photographer" (`checkout:closed.body`, `booking:delivery.expired`, `booking:cancel.notCancellable`), but no page shows a contact detail. When you have them, choose where they appear. New `en.json` keys are allowed (additive only).
- [x] **A real landing page for `/`** (decision 4). **Built 2026-09-21.** Hero, services preview, how-it-works, what-you-can-count-on, closing call to action, inside a new client shell (header and footer on every client page). Copy is new `en.json` keys under `landing:` and `shell:`. Nothing was invented: no portfolio, testimonial, photographer name, logo or written-in price, and the preview's service names and prices are **fetched from the API**. **Still yours:** the wording is the developer's, written to state only what the code already enforces. Replace any of it with your own — the keys are `landing:*` in `en.json`.
- [ ] **"My booking" needs a public resend endpoint.** The header was designed with a second link, to a page where a client who lost their emailed link types their email or booking reference and has it re-sent. **No such endpoint exists** (checked 2026-09-21): the only resend is `POST /api/admin/bookings/:id/resend-link`, behind the admin session guard. Your decision, 2026-09-21: ship without it. When the endpoint is built — 202 whatever the input, like the admin password reset, so it cannot reveal who has a booking — the header grows the link and the page gets its own design file.
- [ ] **Brand assets:** a logo and any brand colours the client already has (the current palette was picked by the design tool), the photographer's name, social links.
- [ ] **Real service names, prices and cover images** (spec R-6). Cover images are URLs the admin pastes.
- [ ] **Confirm working hours** with the photographer. Mon-Fri 09:00-17:00 was the developer's choice, and events often fall on weekends (spec R-4).

## 3. Decided; done during Phase 3 (nothing needed from you)

- NotFound gets an "All services" link, reusing the existing string `services:allServices`.
- Home is restyled only.
- The admin shell gets a skip-to-content link (a new `en.json` key, additive).
- The seven booking statuses share one look, first used in Section 4 (`MASTER.md` section 7). Built: the client pill uses the shared `StatusBadge`. Still to adopt it: the calendar events (Section 6) and the admin badges (Section 7).
- The admin sidebar reflows to a top bar below 1024px. No drawer, no collapse toggle.

## 4. Product gaps outside the redesign (from `PRODUCT.md`)

- Airtel Money and card payments (via Flutterwave) are planned, not built. Only MTN MoMo is live.
- The one-way push of confirmed bookings to Google Calendar is planned, not built.
- SMS / WhatsApp notifications are undecided (the client said "both would be ideal"; the brief lists them out of scope).
- French: the client wants English and French; English only at launch.
- Privacy notice and erasure routine: specified, not built.
- If the photographer cancels, the fee is owed back in full. That is a developer-proposed default (spec A-5), not confirmed.
- The positioning statement in `PRODUCT.md` is inferred, not confirmed.

## 5. Redesign housekeeping

- [x] Impeccable: the engine (0.1.5) is installed and its checksum matches the release; its design hooks are switched back on (2026-09-20). Nothing to install.
- [x] Checked 2026-09-20: Impeccable's overused-font rule does not flag Poppins or Open Sans (it does flag Geist, which the redesign replaced).
- [ ] Dark mode is not designed (`.dark` is unreachable). Say so if you want it.
- [x] The Section 4 milestone: the whole client journey clicked through by script with `/api` mocked, at 1280px and 375px touch, plus `npm run test:e2e` (2026-09-20; the record is in `MASTER.md` section 11). **Still yours:** the same click-through once against the real backend and database.
- [x] **After cancelling, keyboard focus falls to the page body and nothing announces the change** (the booking page, `BookingPage.tsx`). Fixed 2026-09-21 (`5873373`): focus moves to the heading of the section that replaces the cancel button, which is also what announces the outcome. A Vitest case asserts it. Committed as `fix:` on its own, so it reverts without touching any visual work.
- [ ] Before merging `redesign/visual-only`: `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json`, this file, `docs/user-journeys.md`, five e2e specs (`frontend/e2e/{booking,services,slot-picker,checkout,client-booking}.spec.ts`) and **`frontend/package.json` with its lockfile** sit outside the plan's normally allowed paths (keep or move them). The lockfile pair is the Phase 2 font swap — Geist out, Poppins and Open Sans in — in commits `c37410b` and `2bb949e`; the guardrail asks only that lockfiles never ride along inside a visual commit, and they did not. The plan's protected-file check already allows additive `en.json` keys.
- [ ] `DESIGN.md` and its sidecar were written after Section 1 and hand-updated after Sections 2, 3 and 4 (2026-09-20). Re-run `/impeccable document` at the Section 4 milestone and in Phase 4 so they describe what has shipped by then.
- [ ] **Four** admin pages title at 1.25rem while the others use 1.5rem: calendar and catalogue (Sections 6 and 8), and availability and settings (added 2026-09-21, restyled with Section 5). The new page files put availability and settings on the 1.5rem side; calendar and catalogue are still open. Fieldset legends now use the heading font, fixed in Section 2.
- [x] **The `outline` Button variant was nearly invisible on the page.** Decided 2026-09-20, at Section 3: fix the variant itself. It is now `border-input bg-card` (a slate edge on white, 3.27:1), so every outline button improved at once, and the local overrides from Section 2 were removed. The admin's outline buttons changed slightly ahead of their own sections.
- [ ] On a 900px-tall desktop the service page's 21:9 cover image (about 425px at full width) puts the first package right at the fold. A `max-h` on the cover would bring the first step up. It is a page-file decision, so it stays as designed until you say.
