# Not Found — Page Design

> **Project:** Bookly · **Route:** `*` (and rendered inside `/services/:slug`) · **File:** `frontend/src/pages/NotFound.tsx` · **Phase 3 section:** 1
> **Added by the discovery rule:** it was not on the Phase 2a page list. It is in the Phase 3 table (row 1, "Home + NotFound") but had no design file.
> Generator template: UI UX Pro Max, 2026-09-19. Its recommendations ("padding-top for the nav", "AAA focus criterion", "word-break") were unrelated boilerplate; this page has no nav. Replaced below.
> This file overrides `design-system/bookly/MASTER.md` for this page.
> **Applied 2026-09-20 (Phase 3 section 1),** with the icon `FileQuestionMark` and the "All services" link. The link's focus and target-size treatment is in `MASTER.md` section 11.
> **Overridden 2026-09-27 by `design-system/bookly/client-front.md`** (the client front redesign, light and dark): a mono "404" eyebrow (new key) and a Home / Browse services pair of links replace the icon and the "All services" link (client-front.md §8.5).

## Layout

- Same shell as Home: `main`, `max-w-md`, `min-h-svh`, centred, `p-6`, `gap-2`.
- Order: `h1` (`notFound:title`, 2xl semibold, heading font) -> muted body (`notFound:body`).
- May gain a decorative icon above the heading (lucide, `aria-hidden`, muted, ~40px). No "404" numeral: it would be new text.

## Two callers, one component

`NotFound` is also returned by `ServiceDetail` when the API answers 404 for a slug (unknown or deactivated service, spec 6.14). It renders its own `main`, so it must stay self-contained and must not assume it is a top-level route.

## Way out (decided 2026-09-20)

Add a text link to `/services` using the **existing** string `services:allServices` ("All services"): no new copy. Style it like the back link on the service page (muted, `text-sm`, underline on hover, visible focus ring) and place it under the body text, with a `gap-2` to `gap-4` rhythm from it. It is the only interactive element on the page. The rest of the page stays as designed above.

## Do not

- No new copy, no illustration that carries meaning, no nav.
