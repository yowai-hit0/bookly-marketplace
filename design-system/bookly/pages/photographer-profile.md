# Photographer Profile — Page Design

> **Project:** Bookly · **Route:** `/p/:handle` · **Files:** `frontend/src/pages/photographers/PhotographerProfile.tsx`, `Portfolio.tsx` (grid and lightbox), `PhotographerContact.tsx` (contact list, shared with the service page), `pages/services/ServiceCard.tsx`
> **Written:** 2026-10-22, Phase 6 (marketplace spec R6.2, R6.3, R6.4, R6.5, T6.4). Built inside `client-front.md`; where they disagree for this page, this file wins.
> **Replaces** the Phase 5 service list at `/p/:handle` (`ServiceList.tsx`, removed): its back link, its card and its unavailable and not-taking-bookings states carry over.

## What this page is

One photographer, from `GET /api/photographers/:handle` alone: who they are, where they work and what they shoot, their services with "from" prices, their work, their cancellation terms in plain words, and how to reach them. The services lead to `/p/:handle/:slug`, where booking happens.

**All text is plain text (R6.5, T6.4).** The name, bio, captions and service text are rendered as React text nodes: no `dangerouslySetInnerHTML`, no markdown. A bio containing `<script>` shows those characters. Line breaks in the bio are the photographer's own and are kept (`whitespace-pre-line`).

**Images are `https://` only**, through `safeHttpsUrl`, with `referrerpolicy="no-referrer"`; all but the cover are `loading="lazy"`. Any other URL is dropped (the cover shows no band; a portfolio image is left out).

## Layout

`main` (`container`, `pageY`, `flex-col gap-8`).

1. **Back link** "All photographers" → `/photographers` (first focusable in `main`).
2. **Cover:** when there is one, a full-width image, 16:9 on phones, 21:9 from `md`, `object-cover`, 2px. No cover: no band, the header leads (never an empty grey strip).
3. **Header:** mono eyebrow (`Camera`, "Photographer"); `h1` the display name (`pageTitle`, `wrap-anywhere`, balanced); a meta row with `MapPin` and every district (comma-separated, wraps); the categories as 13px hairline chips. The bio follows as the lead (17px secondary, `max-w-2xl`, `whitespace-pre-line`, `wrap-anywhere`). No bio: no paragraph.
4. **Not taking bookings:** the warning callout (`NotTakingBookingsNotice`) under the header for a past-due photographer. The services stay, each card reads "See details" instead of "Book".
5. **Two columns from `lg`:** `[1fr_20rem]`, `items-start`, `gap-12`. Below `lg`, one column in DOM order.
   - **Main column**
     - **Services** (`h2`): `ul`, 1 column, 2 from `sm`, `gap-6`, of `ServiceCard`s (`h3`): 4:3 cover or camera block, name, two-line description, "From **25,000 RWF**" or, when `fromPriceRwf` is null, "Price on request" (secondary, not mono), and "Book →" / "See details →". No services: info callout `services:empty`.
     - **Portfolio** (`h2`, only when at least one image survives the https check): a grid of up to 24, 2 columns on phones, 3 from `md`, `gap-3`; each a `figure` with a square-cornered 4:3 thumbnail **button** (its name "View photo 3 of 8") and, when there is one, the caption (13px secondary, two lines at most, full in the lightbox).
   - **Aside** (`flex-col gap-6`)
     - **Cancellation terms** panel (hairline, `p-5`): eyebrow "Cancellation", the policy sentence from `lib/cancellation.ts` `policySentence` (the same words the service page's summary uses), and "A photographer who cancels always refunds the booking fee in full." (the platform rule).
     - **Contact** panel (hairline, `p-5`), only when at least one channel is set: eyebrow "Contact", then one row per channel that is set (phone `tel:`, WhatsApp `https://wa.me/<digits>` opening in a new tab with `rel="noopener noreferrer"`, email `mailto:`), each a label and the value as a link, 44px on touch. Nothing set: no panel, no placeholder.

## The lightbox

The shared `Dialog`, on the dark scrim, panel `max-w-5xl`:

- The image `object-contain`, at most 75dvh, alt = the caption, else "Photo 3 by Kigali Lens"; the caption below it in full; a mono "3 of 8" counter.
- **Previous** and **Next** icon buttons (44px, named in words) and the **ArrowLeft / ArrowRight** keys move between images, wrapping at the ends; with one image they are absent.
- **Escape**, the × and the scrim close it; focus is trapped inside while open, and on close returns to the thumbnail of the image last shown.
- Nothing slides or zooms: the image swaps. Reduced motion changes nothing because nothing moves.

## States

| State | What shows |
|---|---|
| loading | back link, a title-sized skeleton bar, three service skeleton cards (`aria-hidden`) and a `role="status"` "Loading…" |
| loaded | as above |
| 404 | `PhotographerUnavailable`: "This photographer is unavailable", with Browse photographers / Home; meta `noindex` |
| failure | danger callout `photographers:loadPhotographerFailed` with **Try again** |
| no bio, no portfolio, no contact | those blocks are absent; the page is the header, services and cancellation terms |
| long name or bio | wraps inside the column (`wrap-anywhere`), never scrolls the page sideways |

## Meta (R6.6)

`<title>` "Kigali Lens · Bookly"; description the bio's first 155 characters (whitespace collapsed, cut at a word, with an ellipsis), else "See Kigali Lens's services, prices and free times, and book online."; `og:title`, `og:description`, `og:type=profile`, and `og:image` when the cover is https.

## Do not

- No HTML or markdown from profile text, ever. No `target="_blank"` without `rel="noopener noreferrer"`.
- No invented reviews, ratings, response times, "verified" marks or a contact form.
- No placeholder contact details: an unset channel is absent.
- No carousel or auto-advancing gallery.
