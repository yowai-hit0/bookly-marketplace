# Home / Landing — Page Design

> **Project:** Bookly · **Route:** `/` · **File:** `frontend/src/pages/Home.tsx` · **Phase 3 section:** 1
> Generator template: UI UX Pro Max, 2026-09-19 ("Landing / Marketing", 1200px). Its pattern was wrong for the stub and set aside; **it applies now** and the notes below are the hand-written version of it.
> This file overrides `design-system/bookly/MASTER.md` for this page. Read MASTER's "Hand-review addendum" first.
> **Superseded 2026-09-21.** The 2026-09-20 decision recorded here was "restyle the stub only", because a landing page needed copy that did not exist. The user has now asked for the landing page and authorised new `en.json` keys under a new namespace, so the stub is replaced. Section 1's applied styling (the type scale, the button that hugs its label) carries forward; this is not a restart.
> **Applied 2026-09-20 (Phase 3 section 1)** to the stub. What was chosen beyond this file is in `MASTER.md` section 11.
> **Overridden 2026-09-27 by `design-system/bookly/client-front.md`** (the client front redesign, light and dark): the hero with its decorative calendar mock-up and service chips, section eyebrows, "How booking works" as a numbered strip, "Good to know" fact rows and the "Already booked?" band that absorbs the closing section (client-front.md §8.1). "No illustration" is lifted for the data-true mock-up only; entrance fade-ups are allowed on the hero.

> **Overridden 2026-10-22 by the marketplace (Phase 6, R6.3, R6.4).** Bookly is now many photographers across Rwanda, so the single-studio framing goes. The section "Marketplace landing (Phase 6)" below wins over everything above it for this page; where it is silent, the older text and `client-front.md` §8.1 still hold.

## What this page is now

The public entry point. Before this, `/` was an API health check (`home:apiStatus`, `home:recheck`) with no link to anything, and the page clients actually used was `/services`. The health stub is gone from the page; **its `home:*` keys stay in `en.json`** — existing strings are never edited or removed, and nothing else reads them.

**Nothing on this page may be invented.** There is no photographer name, no logo, no portfolio, no testimonial and no review (`docs/redesign-pending.md` section 2: brand assets are still outstanding). Every claim below is a fact the code already enforces, and the service names and prices are **fetched from the API**, never written into the page.

## Layout (section order)

Inside the client shell (`pages/client-shell.md`), so the header and footer are not this page's business. The page renders its own `main`, `flex-col`, sections separated by `py-16` / `sm:py-20` rhythm, each section's inner width `mx-auto max-w-6xl px-4`.

1. **Hero**
2. **Services preview**
3. **How it works**
4. **What you can count on** (trust)
5. **Closing call to action**

### 1. Hero

- Typographic, not photographic: there is no image to use, and a stock photo would be a claim about work that was never supplied.
- `h1` at `text-4xl sm:text-5xl`, heading font, semibold, `text-balance`, `max-w-3xl`. One supporting paragraph, `text-lg muted`, `max-w-xl`, `text-pretty`.
- One primary button: **"Book now" -> `/services`**. The same label as the header's button, deliberately — it is the same action, and a second name for it would be a second thing to learn. Tests must scope by landmark (`banner` vs `main` vs `contentinfo`), because this label exists three times on this page.
- A quiet secondary line under the button may name the booking-fee mechanic in one sentence. **No second button**: one primary action per screen (MASTER).
- Background: the page's tinted `--background`, with the hero optionally lifted on a soft `--primary`-tinted wash. No gradient text, no blurred blobs, no animated mesh (MASTER anti-patterns).
- On a phone the hero starts at `py-12`, not a full viewport height. A 100svh hero that shows nothing but a sentence is a wasted screen.

### 2. Services preview

- **Real data, from `fetchServices`** — the same call `/services` makes. Show the **first three** services, in the API's order, in the **same `ServiceCard` presentation** the service list uses. Reusing that card is the point: a client who taps through sees the thing they just saw, not a different design of it.
- Section heading `h2`. A "see the rest" link to `/services` sits after the grid. **Its accessible name must not be "All services"** — that exact name is matched page-wide by three e2e specs.
- **Degrade quietly.** This is a marketing section, not the booking funnel: if the API fails, render **nothing at all** — no red alert, no retry button, no empty-state apology. The hero and its CTA still work, and `/services` shows the real error with the real retry. Same when the list is empty.
- Grid: `sm:grid-cols-2 lg:grid-cols-3`, matching the list page.

### 3. How it works

- Four steps, as an ordered list (`ol`), `sm:grid-cols-2 lg:grid-cols-4`, each a number, a short heading (`h3`) and one sentence.
- The steps are the real flow and nothing else: choose a service and package -> pick a date and time -> pay the booking fee to hold the time -> get a private link to the booking, and the photos when they are ready.
- The step number is decorative (`aria-hidden`) — the `ol` already carries the order for a screen reader.

### 4. What you can count on

- Three or four short items, each a heading and a sentence. **Facts, not promises**, each one true of the shipped code:
  - the full price is shown before anything is paid;
  - the time is held while payment goes through;
  - the booking fee is non-refundable if the client cancels — **stated here, not only at checkout.** Putting the one unfavourable term on the landing page is the whole point of the section; a trust block that lists only good news is marketing, and this app takes money from people;
  - every booking has a private link, and it can be cancelled from there.
- Icons optional, `size-5`, `aria-hidden`, always paired with words. Cards or plain blocks, not a bordered grid that reads as a pricing table.
- **No testimonials, no counters ("200+ shoots"), no badges, no five-star rows.** None of it exists.

### 5. Closing call to action

- One band, `bg-primary`-tinted surface or `bg-card`, a single line and the same "Book now" button. Short. It exists because the page is long enough that the hero's button has scrolled away.

## Type and rhythm

Section headings `h2` at `text-2xl sm:text-3xl`, heading font. Body `text-base`, muted where it supports a heading. Vertical rhythm comes from MASTER's spacing scale; sections alternate `bg-background` and `bg-card` at most once, and never more than twice on the page.

## States

The page has effectively one state. The services preview has three (loading, some, none/failed). **Loading shows the section with placeholder cards** (`ServiceGridSkeleton`, one per preview slot, `aria-hidden`, the wait announced once in an `sr-only` status); some shows the cards; none/failed renders nothing, no alert, no retry.

**Decided 2026-09-25 (user), reversing "loading renders nothing":** the API sits on Render's free tier and can take close to a minute to wake, and an empty band for that long read as a broken page. The cost is accepted: when the fetch fails or returns nothing, the placeholder section goes and the page below moves up once.

## Accessibility

- Exactly **one `h1`** on the page, and it is the hero's. The header's wordmark is a link.
- "Book now" appears in the header, the hero and the closing band. All three go to the same place, so three identical accessible names are correct; do not disambiguate them with invented suffixes like "Book now (hero)".
- Every section that is a real region gets a heading; do not use `aria-label` to name a section that already has an `h2`.

## Do not

- No photographer name, logo, portfolio, testimonial, review, price or service name written into the page or into `en.json`. Prices and names come from the API.
- No hero image, stock photography or illustration.
- No newsletter signup, chat widget, cookie banner, or "as seen in" row.
- No scroll-jacking, parallax, count-up animation or entrance animation on every section.
- Do not restore the API status check; do not delete the `home:*` keys it used.

## Marketplace landing (Phase 6, 2026-10-22)

The brand stays **Bookly**; the tagline is "Find and book photographers across Rwanda". Everything is still fetched or true of the code: no photographer, price or category is written into the page.

### Order

Hero → Who you can book (featured strip) → How booking works → Good to know → For photographers (the inverted band) → Already booked? (a quiet panel) → footer.

### 1. Hero

- Dot-grid section, two columns from `lg` (text | the decorative calendar mock-up, unchanged, hidden below `sm`).
- Eyebrow chip (`MapPin`): "Photographers across Rwanda" (new key). `h1` the tagline (new key), lead (new key): compare by what they shoot, where they work and what they charge; pick a free time; hold it with a booking fee paid by MoMo.
- **Quick search**, a bordered panel on the canvas (`p-4 md:p-5`): a `form` with two labelled native selects, **Category** ("Any category" + the active categories) and **District** ("Anywhere in Rwanda" + the 30 districts grouped by province with `optgroup`), and the **brand** button "Find photographers" (the page's one violet action, 52px). Side by side from `md` (`[1fr_1fr_auto]`), stacked on phones with the button full width. Submitting goes to `/photographers` with only the chosen values (`?category=wedding&district=gasabo`; nothing chosen is the bare path). The lists come from `GET /api/categories` and `GET /api/districts`; while they load, or if they fail, each select holds only its "any" option and the form still works.
- Under it: the two success-ticked facts ("Only free times are shown", "Pay with MTN MoMo") and the aside line, unchanged.
- The Phase 5 hero chips (one per photographer) are removed: the featured strip and the search replace them.

### 2. Who you can book

Eyebrow "01 — Photographers", `h2` "Who you can book", "Browse photographers →" right-aligned from `md`. The first three photographers of the directory's first page (`GET /api/photographers`), in the directory's `PhotographerCard` (`h3`): cover, name, districts, categories, "from" price, the "Not taking bookings" badge. Loading: three skeleton cards and an `sr-only` status. Empty or failed: the section goes, quietly (unchanged rule).

### 3. How booking works (`#how`)

The same numbered strip, with marketplace steps (new keys): **Find a photographer** (filter by what, where, budget and date) → **Choose a service and a time** (every package and price listed, only free times shown) → **Pay the booking fee by MoMo** (it holds the date; the rest after the shoot) → **Get your link** (`landing:how.step4`, unchanged). The `h2` keeps `tabIndex=-1` and the header's `/#how` focus behaviour.

### 4. Good to know

Four fact rows in the 2×2 hairline grid: **Cancellation terms, up front** (`landing:trust.policy`, each photographer's own terms, shown before booking and before paying), **Pay by MTN MoMo** (new), **The price is the price** (`landing:trust.price`), **One private link, yours** (`landing:trust.link`).

### 5. For photographers (the inverted band)

Eyebrow "For photographers", `h2` "List your studio on Bookly", one line on what it gives them (their services, prices and hours; clients book free times and pay the booking fee by MoMo; one calendar). CTAs: **List your studio** (band fill) → `/studio/signup`, and outline **Studio sign in** → `/studio/login`. Static rings as before. No pricing, commission or subscription claims: those live on the studio's own pages.

### 6. Already booked?

A hairline panel inside the container, `p-6 md:p-8`, text left and the outline **Find my booking** → `/my-booking` right from `md`: eyebrow, `h2` (`landing:booked.title`, 24px/500), `landing:booked.body`.

### Meta (R6.6)

`<title>` "Bookly: find and book photographers across Rwanda"; a description to match; `og:type=website`.

### Do not (marketplace)

- No single-studio wording ("Photographer · Kigali", "the photographer"), no placeholder studio name or contact.
- No counts ("120 photographers"), ratings or testimonials: none are real.
