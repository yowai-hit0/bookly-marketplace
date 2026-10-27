# Studio Portfolio — Page Design

> **Project:** Bookly · **Route:** `/studio/portfolio` (inside `AdminLayout`) · **Files:** `frontend/src/pages/admin/AdminPortfolio.tsx`, `frontend/src/admin/portfolio.ts`
> **Written:** 2026-10-25, Phase 7 (marketplace spec R7.2). Built inside `admin-console.md`; where they disagree for this page, this file wins.

## What this page is

Up to **24** photos for the public profile's portfolio (`photographer-profile.md`), each a pasted `https://` link with an optional caption (≤ 200 characters), in the order the profile shows them. Bookly stores the links, never the files. `GET /api/studio/portfolio`; add `POST`, caption `PATCH /:id`, remove `DELETE /:id`, reorder `PUT /portfolio/order { ids }`.

## Layout

`main`, `PAGE max-w-4xl`. `PageHeader`: eyebrow `Images` + "STUDIO", `h1` "Portfolio", beside it a mono count chip **"5 of 24 photos"**, the intro, and the page's one action **Add a photo** (`ImagePlus`, inverted neutral; right from `lg`, full width on a phone).

Then, in order: the polite sr-only announcement region (moves), the **full** callout (only at the limit), the page notice, and the list.

- **List:** an `ol` (`aria-label` "Portfolio") in one hairline panel, a row per photo, hairlines between rows. Each row: a 4:3 thumbnail (96px, 128px from `sm`; `object-cover`, hairline, `referrerPolicy="no-referrer"`, `loading="lazy"`; alt = the caption, else "Photo 3"), then a mono "PHOTO 3" label and the caption (15px, three lines at most, `wrap-anywhere`) or "No caption" (muted italic). On the right from `sm` (below the photo on a phone: the two moves on one row, Edit caption and Remove sharing the next, half each): **Move up**, **Move down** (44px / 40px icon buttons, `ArrowUp` / `ArrowDown`, named "Move photo 3 up"), **Edit caption** (`Pencil`) and **Remove** (`Trash2`, outline with red text: it opens a confirmation, it does not remove).
- **Empty:** a dashed hairline box with `Images` and "No photos yet. Add your first one by its link."
- **Broken image:** a raised-surface box the thumbnail's size with `ImageOff` and "This image could not be loaded." The row stays: it can still be moved, captioned or removed.

## At the limit

When the count reaches the API's `limit` (24): **Add a photo** is `disabled`, `aria-describedby` the info callout "Your portfolio is full. Remove a photo to add another." (the reason is visible text, since a disabled button cannot be focused). A `409 portfolio_full` from a race (another tab filled it) closes the dialog, reloads the list, and says "Your portfolio is already full, so the photo was not added."

## Dialogs (admin-console 6.11)

- **Add a photo:** Image link (mono, `type="url"`), a preview once typing pauses (400ms; the same thumbnail, full width, with its broken state), Caption (textarea, optional). Checked before sending: an `https:` link ≤ 2,000, a caption ≤ 200 code points. A 422 marks its fields; a 400 marks the link. On success the photo is appended last and "Photo added." shows.
- **Edit the caption:** the thumbnail, the caption prefilled; a blank caption clears it. A `404` (removed elsewhere) closes, reloads, and says "That photo was already removed…".
- **Remove this photo?** Description: it leaves the profile; the hosted image is not touched. The thumbnail, Cancel and **Remove photo** (solid destructive, the irreversible confirm). `404` as above.

Each dialog: Cancel first in the DOM, the action last; stacked full width on a phone, a row from `sm`. Focus returns to the button that opened it.

## Reordering

Move up / Move down, one place at a time, keyboard-first; **no drag** (optional in the brief, and a keyboard path is required either way).

- The new order shows at once and the whole order is saved with one `PUT` (`ids` in their new places). While it saves, the move buttons are `aria-disabled` (presses ignored), so moves never race.
- **Focus stays with the photo:** after the move, focus is on the same button of the moved photo in its new row; if that button is now disabled (the photo reached the top or bottom), on the other one. The polite region says "Photo moved to position 2 of 5."
- **422** (not exactly this studio's set any more: a photo added or removed elsewhere): the list is reloaded and a warning says so. Any other failure puts the old order back with "Could not save the new order…".
- The first photo's Move up and the last photo's Move down are `disabled`.

## States

loading (three skeleton rows), load failed (+ Retry), empty, list, full, moving, order changed elsewhere, order failed, adding, added, add refused, full meanwhile, caption saved, caption refused, removed, already removed.

## Studio nav

Item **Portfolio** (`Images`), after Profile: see `admin-shell.md`.

## Do not

- No upload, no crop, no image hosting.
- No drag handle without the buttons; no autoscroll.
- No captions as markup: plain text.
