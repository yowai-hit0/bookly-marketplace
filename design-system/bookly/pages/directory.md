# Directory — Page Design

> **Project:** Bookly · **Route:** `/photographers?category&district&min&max&date&page` · **Files:** `frontend/src/pages/photographers/PhotographerList.tsx` (the page), `DirectoryFilters.tsx` (bar, sheet, chips), `PhotographerCard.tsx` (card and skeleton), `directory-query.ts` (URL ↔ filters)
> **Written:** 2026-10-22, Phase 6 (marketplace spec R6.1, R6.3, R6.5, R6.6). Built inside `client-front.md`: its tokens, type, radius, flat panels, 44px controls and motion rules hold here unchanged. Where this file and `client-front.md` disagree for this page, this file wins.
> **Replaces** the Phase 5 placeholder list (a name and a cover per card, no filters).

## What this page is

The marketplace's catalogue: every photographer the API lists, 24 a page, bookable ones first and then by "from" price. A client narrows it by **category**, **district**, **price range** (the cheapest active package, inclusive bounds) and **a date they are free**. The URL is the state: a filtered page is shareable and every filter change is a history entry, so Back undoes it.

**Nothing is invented.** Names, districts, categories, prices and covers come from the API. Covers are pasted links: they reach an `src` only through `safeHttpsUrl`, with `referrerpolicy="no-referrer"` (R6.5). No ratings, review counts, "featured" or "popular" labels: none exist.

## Decision: the first client modals (user decision, Phase 6)

`client-front.md` keeps the client modal-free. The Phase 6 brief asks for two exceptions, and they are recorded here: the **mobile filter sheet** (this page) and the **portfolio lightbox** (`photographer-profile.md`). Both are the shared Radix `Dialog` (`components/ui/dialog.tsx`): focus is trapped, Escape and the × close it, and focus returns to the control that opened it. Nothing else on the client opens a dialog.

## Layout

Inside the client shell; the page renders its own `main` (`container`, `pageY`, `flex-col gap-8`).

1. **Head:** mono eyebrow (`Users` icon, "Photographers"), `h1` "Photographers" (`photographers:title`, `pageTitle`), lead (new key: "Filter by what you need, where, your budget and a date. Prices are each photographer's cheapest package.").
2. **Filters**
   - **From `lg` (1024px): an inline bar.** A bordered panel (`rounded-xs border p-5`), four columns: Category | District | Price (a `fieldset` with two inputs, "Lowest" and "Highest", side by side) | Available on. Labels above (14px/500), fields 48px (`client:` input height), hints and errors 13px under each.
   - **Below `lg`: a "Filters" button** (outline, 44px, `SlidersHorizontal` icon) with the **active-filter count** as a mono count badge; its name says it in words ("Filters, 2 active"). It opens the **sheet**: a bottom-anchored dialog, full width, at most 90dvh, scrolling inside; header "Filters" with the ×; the same four fields stacked; a footer with **Clear** (outline) and **Show photographers** (primary, the apply button) side by side, 44px. Closing without applying discards the draft.
3. **Active filters:** a row of removable chips (one per active filter; the price range is one chip), then a **Clear filters** text button. Each chip is a 40px button (44px on touch), hairline edge, the value and an `X` icon; its name is "Remove filter: Wedding". The row is absent with no filter. A chip whose filter the API refused (422) takes the danger edge.
4. **Result count:** a `role="status"` line (`aria-live="polite"`), 15px secondary: "12 photographers" when the API sends `total`; with a date (no `total`), "Showing 24 photographers free on Wednesday, 7 October 2026" (page 1, nothing more) or "Showing 25–48, free on …" when there are pages around it. While loading, "Loading…".
5. **Results:** `ul` grid, 1 column, 2 from `sm`, 3 from `lg`, `gap-6`. One `PhotographerCard` each.
6. **Pagination:** a `nav` "Pages" under the grid: **Previous** and **Next** (outline buttons as links, 44px) around a mono "Page 2 of 5" (or "Page 2" without `total`). Next exists only while `hasMore`; Previous only from page 2. Following one moves focus to the results heading (an `sr-only` `h2` "Results", `tabIndex=-1`) and scrolls to it, so a keyboard user is not left at the bottom.

**Pattern choice: numbered pages, not load-more.** The URL carries `page`, so pages are shareable and Back-safe, and the API's `hasMore` drives Next exactly; a load-more list cannot be restored from a URL without refetching every earlier page.

## How filters apply

- **Selects and the date apply at once** (inline bar). **Prices apply on Enter or when the field is left**, so typing "25000" is one request, not five.
- In the **sheet**, nothing applies until **Show photographers**.
- Every change resets `page`. **Empty values are never written to the URL or sent** (the API answers an empty value with 400). Unknown URL keys are not sent either.
- A price must be whole digits; anything else is refused in the field ("Enter a whole number of RWF, digits only.") and never sent.
- The date field's `min` is today in Kigali and its `max` 365 days ahead, matching the API.

## The card (`PhotographerCard`)

The service card's frame and lift (`client-front.md` §8.2): hairline, 2px, no shadow, `-6px` lift and a violet edge on hover and keyboard focus (edge only under reduced motion), one stretched link (the name), one tab stop.

- **Cover:** 4:3 (`aspect-4/3 object-cover`), `loading="lazy"` except the first card (eager, high priority), `referrerpolicy="no-referrer"`, only through `safeHttpsUrl`. No usable URL: the quiet chip-coloured block with a 32px `Camera` icon, same 4:3, so rows stay aligned.
- **Body** (`p-5`, `gap-3`): the name (`h2`, 22px/500, `wrap-anywhere`, two lines at most); districts (`MapPin`, the first two, then "+N more"); categories (13px hairline chips, the first three, then "+N"); the **"Not taking bookings"** badge (warning tint, `CalendarOff`, the words always) for a past-due photographer; then a hairline row: "From **35,000 RWF**" (mono) left and "View profile →" right, in the link colour.
- **Past-due photographers** are listed last by the API and are absent once a date is chosen; the card only shows the badge.

## States

| State | What shows |
|---|---|
| loading | six skeleton cards in the same grid and frame (`aria-hidden`), the status line says "Loading…" |
| results | the grid, the count, pagination when there is more than one page |
| empty, no filters | info callout `photographers:empty` |
| empty, filters | info callout "No photographers match these filters." and a suggestion row: **Remove the date** (when a date is set: the commonest cause), **Remove the price range** (when one is set), **Clear filters** |
| page past the end | info callout "There is nothing on this page." and a **Back to the first page** link |
| 422 `validation_failed` | each named field gets its sentence under it, `aria-invalid`, linked with `aria-describedby`; the results area shows a danger callout "Some filters can't be used. Change the ones marked, or clear them." with **Clear filters**; below `lg`, where the fields are in the closed sheet, the callout also lists each field's sentence and offers **Edit filters**, which opens the sheet |
| 400 `invalid_request` | danger callout "This search link isn't valid." with **Clear filters** (a hand-edited or truncated URL) |
| other failure | danger callout `photographers:loadFailed` with **Try again** |

**422 wording, per field:** category "That category isn't offered any more. Choose another."; district "Choose a district from the list."; `min` or `max` alone "That amount is too large."; both, with the lowest above the highest, "The lowest price is above the highest." under the price group; date "Choose a date from today up to a year ahead."; page "That page doesn't exist." (with **Back to the first page**).

## Meta (R6.6)

`<title>` follows the filters once the category and district names are known: "Wedding photographers in Gasabo · Bookly", "Photographers in Gasabo · Bookly", "Wedding photographers · Bookly", else "Find photographers across Rwanda · Bookly". The description and `og:*` match.

## Accessibility

- One `h1`. The bar's fields have visible labels; the price pair is a `fieldset` with a legend. District options are grouped by province with `optgroup`.
- Tab order: the bar's fields left to right (or the Filters button), the chips, Clear filters, the cards, Previous, Next.
- After a chip is removed, focus moves to the next chip, else to the results heading, never to the page body.
- Count changes are announced once by the status line; skeletons are hidden from assistive technology.
- Touch: every control is at least 44px on a coarse pointer; chips 40px on a mouse.

## Do not

- No sorting control, search box, map, ratings or "featured" ordering: none exist.
- No infinite scroll, no auto-applying price field on every keystroke.
- No empty `?category=` or other blank parameter, ever.
- Do not reuse the bar for the landing page's quick search: Home has its own two-select form that links here.
