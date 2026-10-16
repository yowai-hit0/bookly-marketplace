# Prompt: client front redesign (the console language, made public-facing)

You are working in the Bookly repo (React 19 + Vite + React Router 7 + Tailwind v4 + shadcn/Radix frontend in
`frontend/`, Express backend in `backend/`). Redesign the **client side**: every route inside `ClientShell` in
`frontend/src/routes.tsx` (`/`, `/services`, `/services/:slug`, `/checkout/*`, `/my-booking`,
`/email-confirm/:token`, `/booking/*`, `*`). It should take the look and feel of the user's design canvas. The admin
side was redesigned in this language already (see "What already exists"), and **must not change**.

Work on a new branch `redesign/client-front` off `main`. Commit as described under "Commits". Do not push or merge
without asking. Where this prompt leaves a decision open, or the code contradicts it, **stop and ask the user**; do
not guess.

## 0. The design source

The user's canvas: <https://claude.ai/artifact/QVwFvLqQwHAmLHnUUhRua2> ("Bookly Admin Style Guide"). Read it with the
Artifact tool (`action: "read"`, `url` as above, then `paths: ["project/Client-Home.dc.html",
"project/Client-Booking.dc.html", "project/Main.dc.html"]`), and pass the URL and these read instructions to every
subagent. The boards you need:

- **`Client-Home.dc.html` (light, 1440px):** the target for the header, hero, services grid, "How booking works",
  "Good to know", the "Already booked?" band and the footer. Match its layout, type scale, spacing and states.
- **`Client-Booking.dc.html` (light, interactive):** the target for **how the booking components look**: service
  tabs, package cards, add-on cards, the month grid, time slots, fields, the summary panel, the held/pay/waiting/
  confirmed states. Its **5-step wizard structure is not adopted** (decision 2 below). Take its components, not its
  flow.
- **`Main.dc.html`:** the shared style guide: tokens, badges, metadata tiles, banners.
- `Sample.dc.html` and `Prompt.dc.html` are admin material; ignore them here.

The boards contain **illustrative copy and data** (package names, prices, "Signature", "BK-7Q4M2", a 5-step
counter, "[YOUR PHOTO]", "[Photographer name]"). Real content comes from the API and from existing `en.json`
strings. Never ship a board's sample data.

## 1. Decisions already made by the user (do not re-litigate)

1. **Theme:** ship **light and dark**. The default follows the visitor's OS (`prefers-color-scheme`, live). A
   System / Light / Dark control in the header overrides it per device. The boards are light, so derive dark from
   the shipped admin dark tokens (§3).
2. **The booking funnel keeps its current structure.** `/services/:slug` stays **one page**: the three numbered
   groups (package + add-ons, date and time, details) with the price summary beside them. Then the held page, the
   checkout and payment progress, **restyled** with the board's components. There is no wizard, no Back/Continue,
   and no new Review step. Keyboard order, radios, buttons and accessible names stay as they are (§2, e2e).
3. **Motion is selective:**
   - Kept: entrance fade-ups (hero on load, with a short stagger), hover lift on cards, the arrow nudge on card
     hover, the 1px button lift, the "pop" and tick scale-in when a package, day or time is selected, and the
     staggered rise of time slots when a day is chosen.
   - Dropped: **no endless loops**. That rules out the marquee strip, floating hero cards, the pinging dot, the
     blinking "live" dot, the camera-shutter/flash loop, the draining bar, the phone "buzz", the payment "wave"
     rings, and the toast sliding in. The error "shake" is dropped too.
   - A functional spinner or indeterminate indicator where a wait is real (payment progress) is allowed.
   - Everything that moves is off under `prefers-reduced-motion: reduce`, leaving only colour changes.
4. **Home builds all four board additions:**
   - **Hero** with the calendar mock-up (§5.2).
   - **"How booking works"** as the board's four numbered steps, with a "How booking works" link in the header.
   - **"Already booked?"** band linking to the lost-link page.
   - **Footer with contact details:** only real details (§5.8). Nothing is invented; missing details simply don't
     render.
5. **Carried over from the admin redesign and the canvas:** Geist + Geist Mono (already installed), the violet
   accent, 0-2px corners, 1px hairlines, no shadows, mono uppercase labels, outline icons at 1.5px stroke, and
   inverted-neutral primary buttons.

## 2. Ground rules (read first)

- **Read before writing:**
  - `PRODUCT.md` and `DESIGN.md`, including its "Admin console" section.
  - `design-system/bookly/admin-console.md`: the shipped admin spec. Its tokens, contrast measurements, status
    mapping (§5) and decisions 5-9 are the starting point for this work.
  - `design-system/bookly/MASTER.md`.
  - Every client page file in `design-system/bookly/pages/`: `client-shell.md`, `home.md`, `services.md`,
    `service-detail.md`, `booking.md`, `checkout.md`, `my-booking.md`, `email-confirm.md`, `not-found.md`.
  - `docs/redisign.md`: process and guardrails.

  This redesign **overrides** those client page files wherever they conflict. Record each override in the file
  with today's date, as earlier decisions are recorded. Their *structural* rules still hold unless this prompt
  says otherwise.
- **The admin must not change at all.** Take baseline screenshots of every admin route (light **and** dark) at
  375px and 1280px **before the first code change**, and compare at the end: pixel-identical. The following are
  **off-limits** except where noted:
  - `frontend/src/admin/*`. The exception is `admin/theme.ts`, which may become a thin wrapper over shared theme
    code; its behaviour, storage key `bookly.admin.theme`, attribute `data-admin-theme` and existing tests must stay
    unchanged and passing.
  - `frontend/src/pages/admin/*`.
  - The `:root[data-admin-theme…]` blocks in `index.css`.
- **The theme-token quirk ends here.** Commit `dc69157` swapped the selectors in `index.css`: the old Bookly light
  "sky" palette sits under `.dark` (never applied), and `:root` holds shadcn's stock neutral dark. That is why the
  client renders dark today. This redesign **replaces both blocks** with real client tokens:
  - Put them under `:root[data-theme="light"]` and `:root[data-theme="dark"]`, set on `<html>` by the client theme
    hook.
  - Give plain `:root` the **light** values, so jsdom tests and first paint have sane tokens.
  - Make sure the admin blocks still win on admin routes. The client attribute is removed when `ClientShell`
    unmounts, but also check `/admin/login`, which sits outside both shells until its own hook runs.
  - Redefine `@custom-variant dark` to `(&:where([data-theme=dark], [data-theme=dark] *))`, so shadcn's built-in
    `dark:` utilities finally mean "client dark". Audit every `dark:` class this switches on across
    `components/ui/*` and the client pages. The admin never sets `data-theme`, so it is unaffected. Verify that on
    the admin screenshots.
- **i18n:** `frontend/src/i18n/locales/en.json` takes **additive new keys only**. **Never edit an existing string.**
  - **Reuse** existing copy wherever a section already exists: `landing:hero.*`, `landing:how.*` (the four steps),
    `landing:trust.*` (becomes "Good to know"), `landing:closing.*`, `services:*`, `shell:*`.
  - The board's headlines differ from the live copy ("Book your shoot online. Your date can't be double-booked.").
    **Keep the live copy.** At the checkpoint, ask the user whether they want the board's wording. If they say yes,
    it arrives as new keys that replace the old keys' *usage*, never as edits to them.
  - New keys only for things that have no string yet: the hero's service-chip label, the hero's two fact lines, the
    "Already booked?" band, section eyebrows, the theme control, footer column labels and contact labels.
- **Protected files.** These must be absent from every diff:
  - `frontend/src/catalogue/{api,bookings,availability,payments,booking-access,booking-links}.ts` (+ `.test.ts`)
  - `frontend/src/lib/{format,quote,stored-booking,seen-notices,report-error}.ts` (+ `.test.ts`)
  - everything under `frontend/src/admin/` and `frontend/src/pages/admin/`, except `admin/theme.ts` as described
    above
  - `frontend/e2e/*`, `frontend/components.json`, `frontend/vite.config.ts`
  - all of `backend/`
- **Allowed to change:**
  - `frontend/src/index.css` (client tokens, base rules, the `dark` variant; not the admin blocks)
  - `frontend/src/components/ui/*`
  - `frontend/src/pages/*.tsx` (not `pages/admin/`) and `frontend/src/pages/{services,checkout,booking}/*`
  - new files under `frontend/src/lib/` (shared theme logic, the contact config) and `frontend/src/pages/`
    (client building blocks, for example `pages/client/`)
  - `en.json` (additive only)
  - `design-system/` and `DESIGN.md`
  - `frontend/package.json` + lockfile, only to **remove** Poppins / Open Sans once nothing imports them, in their
    own commit
- **Shared UI components are now shared both ways.** The client uses their **default** variants, and the admin uses
  the opt-in `console` variants plus some defaults under its own tokens. You may change default rendering, but the
  admin screenshots must stay identical. If a default change leaks into admin, move the change into a client-side
  class or a new variant instead.
- **Behaviour is preserved.** The whole funnel works as it does now: service list, package and add-on selection,
  month navigation, day and time pick, the live re-check and "just taken" message, the details form and consent,
  hold, checkout, payment progress, the held countdown, the booking page and its actions, notices, email change and
  confirm, the lost-link email, and the stored booking link. The Render cold-start skeletons stay.
- **The e2e suite is the contract, and it is not edited.** `npm run test:e2e` must pass unchanged. What it pins:
  - **Keyboard order:** Tab from load is the skip link. After Enter, the next Tabs are "All services" (the back
    link) → the package radios → … (`booking.spec.ts`, `services.spec.ts`). New header items sit *before* the skip
    target, so they do not disturb this. Never put a focusable element inside `main` ahead of the back link.
  - **Radios are counted page-wide** (`checkout.spec.ts`: exactly one radio on the checkout page). So the client
    theme control **cannot be a radio group**, unlike the admin's (§4).
  - **Buttons:** `client-booking.spec.ts` asserts `main` has no button on the invalid-link page, and
    `booking.spec.ts` asserts the summary has no button until a time is chosen.
  - **Structure:** one `main` per page; **no wrapping `main`** in the shell; no `dl` in the header or footer
    (`booking.spec.ts` reads `dl dt` page-wide); nothing named exactly **"All services"** outside the back link.
  - **Forbidden words:** header, footer and `main` never contain "processing", "card" or "airtel".

  If a spec fails, the redesign is wrong, not the spec. The one exception is a spec that asserts a styling detail
  the user has asked to change: stop and ask.
- **Accessibility floor:**
  - WCAG AA in both themes: 4.5:1 for text; 3:1 for field edges, focus rings and meaningful UI boundaries. Measure
    and record every pair, as `admin-console.md` §2.3 does.
  - Visible focus everywhere. Reuse the admin's single 2px violet outline rule, re-scoped to the client.
  - Touch targets ≥ 44px on coarse pointers.
  - No horizontal scroll at 375px.
  - Headings in order, one `h1` per page (the header wordmark is never an `h1`).
  - Decorative art is `aria-hidden`, and status is never conveyed by colour alone.

## 3. Tokens

The same family as the admin (zinc neutrals + violet), tuned for a public page: roomier, with a violet hero action.
Convert to oklch like the rest of `index.css`, measure every pair, and darken anything that fails (the admin spec's
decisions 5, 7 and 8 already found three failures in these colours; apply the same fixes).

Consider defining the palette once as primitives and mapping both the client and the admin semantic tokens onto them.
Do that **only** if the admin still renders pixel-identical; otherwise leave the admin blocks exactly as they are.

| Role | Light (from the boards) | Dark (derived from `admin-console.md` §2) |
|---|---|---|
| Canvas | `#FFFFFF` | `#0A0A0B` |
| Band / surface ("How booking works", card hover, summary panel) | `#FAFAFA` | `#131315` |
| Chip / icon tile / neutral badge | `#F4F4F5` | `#27272A` |
| Hairline | `#E4E4E7` | `#27272A` |
| Field edge (inputs, checkboxes, day and slot cells' resting edge when it must be seen) | `#8E8E96` (the board's `#D4D4D8` fails 3:1: admin decision 5) | `#63636B` |
| Text | `#18181B` | `#F4F4F5` |
| Secondary text (body copy under headings, footer) | `#52525B` | `#A1A1AA` |
| Muted text (captions, eyebrows) | `#71717A` (never on the chip colour: admin decision 8) | `#A1A1AA` |
| Link | `#6D28D9`, hover `#4C1D95` | `#B9A2FF`, hover `#D4C6FF` |
| Violet action fill (the hero CTA, selected time slot, checked boxes, today pip) | `#7C3AED`, hover `#6D28D9`, white label | `#7C3AED`, hover `#6D28D9`, white label (verify 3:1 edge on canvas) |
| Accent soft (hero eyebrow chip, icon-tile hover) | `#F1ECFE` | `#3A1784` |
| Selected card (package / add-on) | `#F7F3FF` fill + `#7C3AED` 1px edge | a violet tint over canvas (≈ `#1A1230`) + `#B9A2FF` edge |
| Primary button (inverted neutral: "Book now", Confirm, Pay) | `#18181B`, hover `#3F3F46`, white label | `#FAFAFA`, hover `#E4E4E7`, `#0A0A0B` label |
| Inverted band ("Already booked?") | `#0A0A0B` bg, `#F4F4F5` text, CTA `#FAFAFA` / `#0A0A0B`, outline CTA `#3F3F46` edge | `#131315` bg + hairline edge (an inverted light band would glare) |
| Success | `#15803D` on `#EAF8EF` (admin decision 7) | `#4ADE80` on `#0F2E1C` |
| Warning ("Just taken") | `#B45309` on `#FFFBEB` | `#FBBF24` on `#2A2110` |
| Danger | `#B91C1C` on `#FEF2F2` | `#F87171` on `#2A1215` |
| Hero dot grid | `radial-gradient(#E4E4E7 1px, transparent 1px)` at 24px | the same with `#27272A` |
| Focus | 2px `#7C3AED` outline, 2px offset; fields also take a violet edge | 2px `#B9A2FF` outline |
| Radius | `0.125rem` (2px): the admin's token. The boards draw 0; 2px keeps one token. Only status dots, pips and the round step/confirm icons are round. | same |

**Violet vs. inverted neutral:** the page's **one** hero action ("See open dates" / the existing hero CTA) and
**selected** states are violet. Every other primary action (header "Book now", Confirm booking, Pay, "Find my
booking") is inverted neutral, as on the boards. Links are violet text.

## 4. Theme mechanics (client)

- **Shared logic:** move the pure parts of `frontend/src/admin/theme.ts` (preference parsing, guarded
  `localStorage`, live `matchMedia`, synchronous first resolve) into `frontend/src/lib/theme.ts`, parameterised by
  storage key and attribute name. `admin/theme.ts` keeps its exact API, key and attribute on top of it, and its
  tests pass unchanged. The client uses key `bookly.theme` and attribute `data-theme`. They are separate
  preferences on purpose: the photographer's admin choice should not repaint the public site.
- `ClientShell` sets `data-theme` on `<html>` while mounted and removes it on unmount. It also sets `color-scheme`.
- **Control: one `button`, not radios** (checkout counts radios page-wide):
  - Label the button with the current state, for example `aria-label="Theme: System"` via new keys.
  - The icon shows the current state (Monitor / Sun / Moon).
  - Choose one of these behaviours and record it:
    1. **(Preferred)** Clicking cycles System → Light → Dark.
    2. Clicking opens a small Radix popover **menu** (`role="menu"` with `menuitemradio` items, which the e2e
       `getByRole('radio')` does not match; check that).
  - 44px square on coarse pointers, and placed in the header's right cluster.
- Unit tests: follows the OS by default; the stored choice wins; blocked storage doesn't crash; the attribute is
  removed on unmount; a live OS change updates `system`; the admin theme tests are still green.

## 5. Page-by-page spec

Container: `max-w-6xl` (1152px) centred, with a **16px** gutter on phones, **32px** at `md` and **48px** at `lg`
(the board's 120px gutter at 1440 is this container). Section rhythm: **104px** vertical padding from `lg`, 64px at
`md`, 48px on phones. Type (Geist unless marked mono):

| Role | Size / weight / tracking |
|---|---|
| Hero `h1` | 56px / 600 / -0.035em, line-height 1.05 (40px below `md`, 34px below `sm`) |
| Section `h2` | 44px / 600 / -0.03em (32px below `md`) |
| Page `h1` (non-Home pages) | 30-36px / 600 / -0.02em |
| Card / step `h3` | 20-22px / 500 |
| Body, lead | 16px (lead 17-18px), secondary colour |
| Nav links | 15px |
| Eyebrow | **Geist Mono** 12px / 500 / uppercase / 0.1em, muted: "PHOTOGRAPHER · KIGALI, RWANDA", "01 — SERVICES" |
| Data | **Geist Mono**: prices, times, references, countdown, step numerals `01`-`04`, calendar day numbers, weekday heads |

### 5.1 Shell: header and footer (`pages/ClientShell.tsx`)

`client-shell.md`'s structural rules hold:
- the skip link first;
- the header, `div#main-content` and the footer are **siblings**, with no wrapping `main`;
- the header is **static** (not sticky);
- no drawer or hamburger;
- the wordmark is a link, not an `h1`;
- `/admin/login` no longer wears `ClientHeader` (admin decision 6), so `ClientHeader`'s `showAdminLogin` prop may go
  if nothing else uses it.

- **Header** (board): 72px tall, a bottom hairline, and a canvas background.
  - Left: the wordmark (Geist 20px / 600 / -0.02em, with a small `aria-hidden` mark), linking to `/`.
  - Then, from `md`, text links at 15px:
    - **Services** → `/services`, using the existing `services:title` string. Never "All services".
    - **How booking works** → `/#how`, using the existing `landing:how.title` string. React Router does not scroll
      to a hash, so Home needs a small effect that scrolls to and focuses `#how` when the hash is present. Honour
      reduced motion: no smooth scroll.
  - Right cluster: **My booking** (with an icon, keeping its stored-token logic), **Admin login** (quiet, 14px,
    muted; still hidden below `sm` and moved to the footer), the **theme button**, and **Book now** (inverted
    neutral, 44px).
  - Phones: must fit 375px with no horizontal scroll. Services and How-it-works are hidden below `md` (Book now and
    Home cover them). Measure the rest. If the theme button does not fit beside "My booking" and "Book now", tell
    the user the trade-off; do not hide it silently.
- **Footer** (board): a top hairline and a canvas background, three columns from `md` that stack on phones.
  1. The wordmark, the existing `shell:footer.note`, and the **contact block** (§5.8).
  2. Column **BOOK** (mono label): Services (`shell:footer.services`, "Browse services") and My booking.
  3. Column **ABOUT**: **Privacy notice**, only if a privacy page exists (it does not today: `specs_v2.md` lists it
     as in scope but unbuilt, so omit the link and tell the user). Admin login appears here only below `sm`, as
     now.

  No buttons, no `dl`, and none of the three forbidden words. Links are 44px tall on coarse pointers.

### 5.2 Home (`pages/Home.tsx`)

Order: hero → services → How booking works → Good to know → Already booked? → footer.

1. **Hero:** two columns from `lg` (text | mock-up), stacking below with the mock-up after the text. It sits on the
   dot-grid background, with a `fu` stagger on load.
   - Text column:
     - Mono eyebrow chip (accent soft): "PHOTOGRAPHER · KIGALI, RWANDA" (new key; both facts are true).
     - `h1`: `landing:hero.title`.
     - Lead: `landing:hero.body`.
     - **"What do you need?"** (mono label, new key) followed by **service chips**: one per real service from the
       `fetchServices` call Home already makes. Each is a link to `/services/:slug`, a rectangle with a hairline
       edge that hovers to a violet edge. While loading, show skeleton chips; on failure, show no chips.
     - The **violet** CTA → `/services`, using `landing:hero.cta`.
     - Two small fact lines with check icons: "Only free times are shown" and "Pay with MTN MoMo" (new keys; both
       true today: MTN MoMo is the only live method). Then `landing:hero.aside`.
   - **Mock-up (decorative, `aria-hidden`, pure HTML/CSS, no image file):**
     - A bordered month card: mono header with the **current** month name and "KIGALI TIME", weekday initials, a
       grid with a few days marked open (pip) and one selected (inverted), and three mono time chips with one in
       violet.
     - Overlapping it, a small "held" card: service name, date and time, and a "Your date is held" line.
     - Use the first real service's name if loaded, otherwise a generic label (new key), and today's date, via the
       existing format helpers. So it never shows a stale or fake date.
     - No looping motion (decision 3); a one-time fade-up only. It is hidden below `sm` if it crowds the phone
       layout.
2. **Services (`#services`):**
   - Eyebrow "01 — SERVICES" (new key), then the `h2` (`landing:preview.title`) and a one-line lead (new key, only
     if needed). Right-aligned: "Browse services →" (`landing:preview.more`; never "All services").
   - Three-column grid from `lg`: the existing `ServiceCard`, restyled in `ServiceList.tsx` as the board's card
     (see §5.3).
   - Keep the skeletons and the quiet failure.
3. **How booking works (`#how`):**
   - A full-bleed band on the surface colour, with hairlines above and below.
   - Eyebrow "02 — HOW BOOKING WORKS", `h2` from `landing:how.title`.
   - Four columns from `lg` (two at `md`, one on phones). Each has a mono numeral `01`-`04` in a bordered square
     (violet on hover), then `h3` and body from `landing:how.step1..4`.
   - `tabIndex={-1}` on the section heading, so the hash link can focus it.
4. **Good to know:**
   - Eyebrow "03 — GOOD TO KNOW", `h2` from `landing:trust.title`.
   - The four `landing:trust.*` items as the board's "fact" rows: an icon tile (chip colour; on hover it takes the
     violet fill with a white icon), then a 20px title and a body, in a 2×2 grid from `md`.
   - The unfavourable rule (the booking fee is not refunded) keeps its full weight; do not bury it.
5. **Already booked?** An inverted band (§3) inside the container:
   - Eyebrow "ALREADY BOOKED?", `h2` (new key, for example "Find your booking any time."), and one line (new key)
     explaining that a fresh link is emailed.
   - Two 52px CTAs: **outline** "Find my booking" → `/my-booking`, and **inverted** Book now (reuse
     `landing:closing.cta`).
   - The existing closing section (`landing:closing.title`) is **merged** into this band: its title may become the
     band's secondary line. Don't render two closing sections.

### 5.3 Services list (`pages/services/ServiceList.tsx`)

- Page header: eyebrow, the `h1` from `services:title`, and the intro `services:intro`.
- **Card (the board's `lift` card):**
  - A 1px hairline, square, with no shadow.
  - The real service image at 4:3 on top (`object-cover`, lazy, with a real `alt` or `alt=""` if decorative per
    `services.md`). If there is no image, show a chip-coloured block with a camera icon, never "[YOUR PHOTO]".
  - Then `h3` (22px / 500), the description (secondary, 2-line clamp), and a hairline row: "From **price**" (price
    in mono) with "Book →" on the right.
  - Hover and focus-visible: lift -6px, violet edge, arrow nudges 5px. Reduced motion: edge only.
  - The whole card stays one link, as it is now.
- Skeletons match the card's shape. Error and empty states use the restyled callout plus the existing retry button.

### 5.4 Service page, the one-page funnel (`ServiceDetail.tsx`, `SlotPicker.tsx`, `BookingDetailsForm.tsx`, `PriceSummary.tsx`, `step-number.ts`)

Layout from `lg`: main column plus a **sticky** summary column (about 360px) on the right. The summary is sticky
inside the page, not the header, so it doesn't obscure focus. Below `lg` the summary comes last, as now.

- **Back link** "All services" stays first in `main` (keyboard spec). It is restyled as a quiet link with an arrow.
- **Page head:** the service name as `h1` (30-36px), its description, and a mono line with "ALL TIMES IN KIGALI
  TIME" (reuse `services:picker.timezone` if it fits, else a new key).
- **Step labels:** the existing CSS counter (`step-number.ts`) renders the board's mono label style "1 · PACKAGE",
  keeping the existing legend and heading text.
- **Packages (radios, unchanged semantics):** board `card` style.
  - Resting: hairline edge, canvas background. Hover: `#A1A1AA` edge and a 2px lift.
  - **Checked:** violet edge + selected tint, a violet check square scales in (`tick`), and a one-time `pop`.
  - Name 18px / 500, meta line (photos · duration) secondary, price in mono on the right.
  - The focus-visible outline goes on the card (the radio is visually hidden, as now).
- **Add-ons (checkboxes):** the same card, with a square box that fills violet when checked.
- **Month grid (`SlotPicker`):**
  - A bordered panel. The header has the month name, with prev/next as 44px square outline icon buttons (existing
    names).
  - Weekday heads in mono uppercase 12px.
  - Day cells 44px:
    - **Open:** hairline edge, text colour, 500 weight, and a 4px violet pip under the number.
    - **Unavailable:** faint text, no edge, disabled.
    - **Selected:** inverted neutral fill with a lavender pip, and a `pop`.
    - **Today:** a violet underline or pip variant, recorded in the spec.
  - The legend row ("Has open times" / "Selected") appears only if the page already has one; otherwise add it with
    new keys under the grid.
- **Time slots:**
  - A list of 52px rows, **mono 16px** time on the left and a secondary caption on the right (whatever the current
    markup shows; don't add "Kigali time" to each if the page states it once).
  - Hover: violet edge + violet text. **Selected:** violet fill, white text, `pop`.
  - Staggered `rise` (50ms steps) when a day is chosen; none under reduced motion.
  - The live re-check ("Checking … is still free") and the **"Just taken"** message use the warning callout.
    The "is free, you'll hold it when you submit" line uses the success callout. These are existing strings and
    existing logic.
- **Details form:**
  - Fields 48px on desktop (≥ 44px everywhere), square, 1px field edge, a violet edge plus the focus outline on
    focus. Labels 14px / 500 above. Errors 13px danger with an icon.
  - Consent checkbox restyled as the add-on box.
  - Layout: name full width, email | phone side by side from `md`, location | people side by side, special requests
    full width.
- **Summary panel (`PriceSummary`)** = the board's "YOUR BOOKING" card:
  - Surface colour, hairline edge. A mono label, the service and package, then rows (package, each add-on, when)
    with prices in mono right-aligned.
  - A hairline, then **Total** (bold), **Booking fee, due now (x%)**, and **Session fee, after** (existing
    strings), each value in mono.
  - The refund note in 13px secondary.
  - The **Confirm** button (inverted neutral, full width, 48px), which appears exactly when it does now (spec: no
    button before a time is picked).
  - A "Questions?" contact line **only** when contact details exist (§5.8).
  - **Keep the `dl > div > dt + dd` markup** of the summary, the held page and the booking facts exactly.
    `services.spec.ts` reads the summary's `dl > div` rows by their `dt`, and `booking.spec.ts` reads every `dl dt`
    on the page as an exact array. Restyle them with CSS only; never add or remove a row, or wrap one in a new
    `dl`.

### 5.5 Held → checkout → payment progress (`BookingHeld.tsx`, `CheckoutPage.tsx`, `PaymentFields.tsx`, `BookingFacts.tsx`, `PaymentProgressPage.tsx`)

- **Held** (board "Your date is held"):
  - A success callout band with the reference in mono, underlined.
  - A **TIME LEFT** stat: mono 28-32px countdown, the existing logic untouched.
  - Then the "Pay the booking fee" block with the fee in mono.
- **Checkout:**
  - Booking facts (`BookingFacts.tsx`, already a `dl`) styled as the admin-style **metadata rows**: mono uppercase
    `dt` labels with values. This is CSS only: the `dl`/`dt`/`dd` structure and row set stay (see §5.4).
  - The payment method is the **single** radio, rendered as a selected card with a provider chip. No third-party
    logo artwork: a text chip is enough.
  - The MoMo number field, and **Pay** (inverted neutral, full width). The "Not ready? Your hold ends by itself"
    note stays, in secondary text.
- **Payment progress:**
  - "Approve the payment on your phone" state: a large icon tile with a **functional** spinner (reduced motion: a
    static clock) and the existing live status text.
  - Confirmed: a success tile with a check (a one-time `draw` of the check is allowed), then the "Booking
    confirmed" `h1`, the reference in mono, and a "View my booking" inverted CTA plus a "Back to home" outline CTA,
    only where those links already exist.
  - Failed and expired use the danger and muted callouts. Existing strings throughout.

### 5.6 Booking page and friends (`BookingPage.tsx`, `Notices.tsx`, `MyBookingPage.tsx`, `EmailConfirmPage.tsx`)

- **BookingPage:**
  - A page header like the admin's: mono eyebrow, the reference as `h1` in mono, and the status badge beside it.
    Use the **console status mapping** (`admin-console.md` §5: rectangles with the four shapes), switching the
    client from the old pill to `StatusBadge variant="console"`. The client **stage legend** (`StageLegend`) shows
    the same badges.
  - Facts as a **metadata tile grid** (64px icon tiles, mono labels, the admin's `StatGrid` look, re-implemented or
    shared from a client-safe location, **not** imported from `pages/admin/`).
  - Money rows in mono. Actions: inverted primary, outline secondary, destructive keeps red, and the two-step
    cancel stays.
  - The photographer's notes and notices as console callouts.
  - The delivery link, when present, as a success panel with an inverted "Open your photos" CTA (existing string).
- **MyBookingPage (lost link):** a narrow centred panel: eyebrow, `h1`, one email field (48px), an inverted submit,
  and the same 202 "check your inbox" state as a success callout. It is also the target of the "Already booked?"
  band.
- **EmailConfirmPage:** the same narrow panel pattern, success or danger outcome.
- **NotFound:** a large mono "404" eyebrow, the `h1`, the body, and an inverted "Home" / outline "Browse services"
  pair using existing strings (§2: no button inside `main` on the invalid-link page: links only).

### 5.7 Components (`components/ui/*`, client defaults)

- **Button:**
  - default = inverted neutral; add a `violet` variant for the hero action; outline = 1px `#D4D4D8` / `#3F3F46`
    edge, transparent.
  - Heights: 44px default, 52px `lg`, 40px `sm`, and never under 44px on coarse pointers.
  - Motion: `motion-safe:hover:-translate-y-px`, colour transitions 150ms.
- **Badge / StatusBadge:** rectangles, 2px radius, 13-14px / 500 (§5.6).
- **Callout:** the board's banner (full width, 18px icon, optional trailing underlined link). Tones: info (accent
  soft), success, warning, danger.
- **Selectable card, checkbox, input, textarea, tabs, popover, skeleton, back-link, skip-link:** restyled per §5.4.
  The skip link is a rectangle with the violet outline, top left.
- **Icons:** lucide at stroke 1.5, square caps, set once for `svg.lucide` in the client scope (as the admin does).
  Every section eyebrow, fact row and metadata tile has one; icons inherit colour.

### 5.8 Contact details (the footer and the "Questions?" line)

The photographer's name, phone/WhatsApp and email are **not in the codebase** and must not be invented.

- Add `frontend/src/lib/contact.ts` exporting a typed `PHOTOGRAPHER_CONTACT` whose fields are `null`.
- The footer's contact block and the summary's "Questions?" line render **only the fields that are set**:
  - phone as `tel:`;
  - WhatsApp as `https://wa.me/<digits>`;
  - email as `mailto:`.
- New `en.json` keys hold the labels, never the values.
- **At the checkpoint, ask the user for the real details.** If they give them, fill them in; if not, ship with
  `null`, so nothing shows.

## 6. Agent / subagent orchestration

You are the **lead**: you own everything shared, and subagents own page groups. Subagents never run git commands and
never edit outside their file list. You review and commit.

**Phase 0: baseline (lead).**
1. Read §2's files and the three boards.
2. Run `npm run dev` in `frontend/`.
3. Screenshot **every admin route in light and dark** and **every client route** as it is today, at 375px and
   1280px, saved to the scratchpad. The admin set is the pixel-identity baseline; the client set is the "before".
4. On a tall page, a Playwright `fullPage` screenshot turns touch emulation off, so measure touch-target sizes
   **before** taking full-page shots.

**Phase 1: spec (lead, docs only).**
1. Write `design-system/bookly/client-front.md`: decisions (§1), the token table for both themes with final oklch
   values and **measured contrast**, the theme mechanics, the type scale, the motion inventory (kept vs. dropped,
   with durations and easings from the boards: fade-up 450-700ms `cubic-bezier(.2,.7,.2,1)`, stagger 80ms, pop
   300ms, lift 200-250ms), and the component specs from §5.
2. Add dated overrides to each client page file and to `MASTER.md`.
3. Commit (`design:`).

**Phase 2: foundation (lead, serial).**
1. Shared theme logic + the client hook + the theme button + tests (§4).
2. Client tokens in `index.css`, replacing the swapped `.dark` / `:root` blocks; the `dark` variant; client base
   rules (Geist everywhere on the client, heading font, icon stroke, focus rule, the motion utilities with their
   reduced-motion guard).
3. Shared components' client defaults (§5.7) and `lib/contact.ts`.
4. The shell: header + footer (§5.1).
5. Home (§5.2): it is the showcase and exercises most tokens.
6. **Checkpoint: stop and show the user:**
   - Home and the header/footer in both themes at 1280px and 375px, side by side with `Client-Home.dc.html`.
   - The admin screenshots re-taken, with a pixel diff against baseline (must be zero).

   Ask the three open questions: (a) the board's headline copy or the live copy, (b) contact details, and (c) the
   theme-button behaviour if you had to trade anything on phones. Continue only after they answer.

**Phase 3: pages (parallel subagents).** Spawn one `general-purpose` subagent per group, in the background, all at
once. Give each:
- this prompt's path;
- the canvas URL with the read instructions;
- `design-system/bookly/client-front.md`;
- the list of shared pieces it must use (not fork);
- **its exclusive file list**:
  - **A:** `services/ServiceList.tsx`, `services/ServiceDetail.tsx`, `services/SlotPicker.tsx`,
    `services/BookingDetailsForm.tsx`, `services/PriceSummary.tsx`, `services/step-number.ts` (+ their tests)
  - **B:** `services/BookingHeld.tsx`, `checkout/CheckoutPage.tsx`, `checkout/PaymentFields.tsx`,
    `checkout/BookingFacts.tsx`, `checkout/PaymentProgressPage.tsx` (+ tests)
  - **C:** `booking/BookingPage.tsx`, `booking/Notices.tsx` (+ tests)
  - **D:** `booking/MyBookingPage.tsx`, `booking/EmailConfirmPage.tsx`, `NotFound.tsx` (+ tests)

  `StageLegend.tsx` and `ServiceCard` (exported from `ServiceList.tsx`, used by Home) are shared: A owns
  `ServiceCard` and must keep its props; you own `StageLegend` (it serves the admin too, and the admin must not
  change).

Each subagent must:
- preserve behaviour, accessible names and tab order;
- run `npm run typecheck`, `npm run lint`, `npx vitest run <its test files>`, and **the e2e specs that cover its
  pages** (`npx playwright test e2e/<spec>`);
- screenshot its pages at 375px and 1280px in both themes;
- return a short report: files changed, tests changed and why, shared changes it **needed but did not make**, and
  open questions.

**Phase 4: review and polish (lead).**
1. Apply the requested shared changes.
2. Spawn a fresh reviewer subagent (`impeccable-finish-reviewer` if available, otherwise `general-purpose`) with the
   boards, the spec and screenshots of every client route in both themes. Ask for an ordered list of material
   deviations: consistency of radius, edges, type, violet usage (one hero action, selected states, links only),
   spacing, motion (no loops), contrast and phone layout.
3. Fix what it finds. Optionally run the `impeccable` skill's polish/audit pass on the client pages.
4. Have `impeccable-documenter` (or you) **rewrite the client sections of `DESIGN.md`** from what shipped. The
   sky/green description is obsolete; the "Admin console" section stays.
5. If nothing imports Poppins / Open Sans any more, remove them in a `deps:` commit.

## 7. Commits

One concern per commit, prefixed like the repo's history:
- `design:` for the spec docs;
- `feat(client):` for the theme and contact config;
- `style(client):` for tokens and components, the shell, Home, then one commit per page group;
- `deps:` for the font removal.

Read the full `git diff` before staging, stage explicit paths, and never `git add -A`. End each commit message with
the attribution line given in your system instructions.

## 8. Verification (all must pass before you report done)

- From `frontend/`: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run test:e2e`, **with no e2e file
  changed**.
- `git diff main --stat`: no protected file; nothing outside the allowed list (§2).
- **Admin identity:** every admin route in light and dark at 375px and 1280px, pixel-identical to the Phase 0
  baseline (a real pixel diff).
- **Client:**
  - every client route at 375px and 1280px in **light and dark**;
  - no horizontal scroll;
  - touch targets ≥ 44px on coarse pointers;
  - visible focus when tabbing each page;
  - the keyboard booking journey works end to end;
  - the contrast table is complete in the spec.
- **Motion:**
  - with `prefers-reduced-motion: reduce` emulated, nothing moves;
  - without it, no animation loops (inspect for `infinite`: only the payment-progress spinner may use it).
- **Theme:**
  - the system default applies;
  - an override survives a reload;
  - a live OS switch updates the page;
  - blocked storage still renders;
  - the client and admin preferences are independent;
  - leaving the client for `/admin/*` leaves no `data-theme` behind (and the reverse).
- **Content:** no board sample data shipped (grep for "Signature", "BK-7Q4M2", "[YOUR", "[Photographer"); contact
  details appear only if the user supplied them; no Privacy link unless the page exists.
- Final report to the user:
  - what changed on each page;
  - every test changed and why;
  - the answers to the checkpoint questions;
  - anything deferred or uncertain.

french translation to come