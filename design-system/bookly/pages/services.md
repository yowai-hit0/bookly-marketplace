# Services — Page Design

> **Project:** Bookly · **Route:** `/services` · **File:** `frontend/src/pages/services/ServiceList.tsx` · **Phase 3 section:** 2
> Generator template: UI UX Pro Max, 2026-09-19 (1200px width replaced by the shipped `max-w-5xl`).
> This file overrides `design-system/bookly/MASTER.md` for this page. Read MASTER's "Hand-review addendum" first.
> **Applied 2026-09-20 (Phase 3 section 2).** The choices made beyond this file are in `MASTER.md` section 11.
> **Overridden 2026-09-27 by `design-system/bookly/client-front.md`** (the client front redesign, light and dark): the card becomes the board's lift card: 4:3 image or icon block, 22px `h3`, a mono "From" and "Book →" row, and a -6px lift on hover and focus (client-front.md §8.2), which lifts this file's "no translate lift" rule except under reduced motion.

## Layout

- `main`, `max-w-5xl`, `px-4 py-8`, `gap-6`. Keep.
- Header: `h1` (`services:title`, 3xl semibold, heading font) + muted intro (`services:intro`).
- Grid: `ul`, 1 column, `sm:` 2 columns, `lg:` 3 columns, `gap-4` (use `gap-6` from `lg`).
- This is the one page where the generator's grid-of-cards pattern fits as is.

## Service card (`ServiceCard`, an `article`)

- Surface: `bg-card`, `rounded-xl`, 1px border, `overflow-hidden`, equal heights (`h-full`, flex column).
- Cover image (optional): `aspect-3/2`, `object-cover`, `bg-muted` placeholder. The first card keeps `fetchPriority="high"` / `loading="eager"`.
- Body `p-4`, `gap-2`: `h2` (lg semibold, heading font) whose link is stretched over the whole card; description muted, `line-clamp-3`; the "From X RWF" line pinned to the bottom (`mt-auto`), `font-medium`, `tabular-nums`.
- Cards without a cover image must still look intentional: no empty top band; the body simply leads.
- **The whole card is one link and one tab stop.** Keep the stretched-link pattern and `has-[a:focus-visible]:ring-3`.
- Hover: this is the only card in the app that is clickable, so it alone gets the hover affordance (`has-[a:hover]:shadow-md` or a border-colour shift, 150-200ms, `motion-safe`). No `translate` lift that moves the card under the pointer.

## States

- loading: placeholder cards (`ServiceGridSkeleton` in `ServiceList.tsx`, three, same grid and card frame, `aria-hidden`), with the `role="status"` line kept for screen readers only (`sr-only`). Built 2026-09-25 (user request: the API's cold start can take close to a minute). No image block in the placeholder, per the no-cover rule below.
- failed: inline `role="alert"`, destructive text + outline `sm` "Retry" button.
- empty: muted sentence.

## Do not

- No filters, search, categories or sorting: none exist.
- Do not filter or reorder services in the UI (spec 2.2).
