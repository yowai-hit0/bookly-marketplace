# Platform Activity — Page Design

> **Project:** Bookly · **Route:** `/platform/activity` (inside `PlatformLayout`) · **Files:** `frontend/src/pages/platform/PlatformActivity.tsx`, `frontend/src/pages/platform/AuditEntryRow.tsx` (shared with the photographer detail), `frontend/src/platform/audit.ts`
> **Written:** 2026-10-27, Phase 9 (marketplace spec R9.4; user decision 1). Built inside `admin-console.md`; where they disagree for this page, this file wins.

## What this page is

The platform's audit trail, read-only: every platform action that changed something, newest first, 50 a page (`GET /api/platform/audit?action=&photographerId=&page=`). A refused or no-op action has no entry.

## URL state

`?action=`, `?photographerId=`, `?page=` hold the view, so a reload or a shared link keeps it. A value the API would refuse (an action outside the vocabulary, a malformed id, a page that is not a whole number from 1 to 1,000,000) is dropped from the request rather than shown as an error. Changing a filter goes back to page 1 and replaces the history entry; paging pushes one.

## Layout

`main`, `PAGE max-w-5xl`. `PageHeader`: eyebrow `History` + "PLATFORM", `h1` "Activity", a mono count chip "128 entries" once loaded, an intro "Every change made in the platform console, newest first. Refused and unchanged requests aren't recorded."

- **Filters:** the `Toolbar` strip: an **Action** select (`All actions`, then `optgroup`s by area: Photographers, Payouts and refunds, Settings, Categories) and, when a photographer filter is set, a cell "Filtered to Kigali Lens" with a **Clear** button (`X`, 44px below `lg`). The name comes from the detail page's link (router state), else from the first entry, else "one photographer".
- **List:** an `ol` (`aria-label` "Activity") in one hairline panel. Each row: a 16px icon for the area (`Users`, `Banknote`, `Undo2`, `SlidersHorizontal`, `Tags`) in a 32px chip tile, then the **sentence** (16px, plain text; e.g. "Approved Kigali Lens; the free trial ends 26 Nov 2026, 10:00", "Changed the monthly price from 10,000 to 12,000 RWF", "Marked a 45,000 RWF payout to Kigali Lens paid (ref TX-123)"), any detail lines under it (a suspension's reason; one line per changed setting when several changed), then a meta line: the actor's email, `·`, the Kigali date and time in mono, and, when the entry concerns a photographer, a link to their detail page (the display name).
- **Pagination** (only when `pageCount > 1`): a `nav` "Pages" with Previous / Next as outline buttons-as-links (44px below `lg`), disabled-looking `aria-disabled` spans at the ends, and "Page 2 of 3" in mono between them.
- **Empty:** a dashed hairline box with `History`: "Nothing recorded yet." (no filter), "No entries match this filter." (a filter), or, on a page past the end, "This page is past the end of the list." with a link to the first page.

## Sentences

Built from `platform:activity.sentence.*` keys with the entry's own values, never raw JSON. Money is `formatMoney`, instants `formatDateTime` (Kigali). Each builder reads its fields defensively: a missing or mistyped field drops the clause that needs it (e.g. "Approved Kigali Lens" without a trial date), an unknown action reads "Recorded “<action>”", and an unknown setting reads "Changed <field>". Nothing throws.

## States

loading (six skeleton rows), load failed (+ Try again), refused (400/422: "That filter can't be used." with a link to the unfiltered list), empty (three wordings above), list, paged.

## Do not

- No editing or undo: the trail is read-only.
- No raw JSON, ids or hashes in the sentence (a reorder says "Reordered the categories", not the ids).
- No user text as markup.
