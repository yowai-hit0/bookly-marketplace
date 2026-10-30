# Platform Categories — Page Design

> **Project:** Bookly · **Route:** `/platform/categories` (inside `PlatformLayout`) · **Files:** `frontend/src/pages/platform/PlatformCategories.tsx`, `frontend/src/platform/categories.ts`
> **Written:** 2026-10-27, Phase 9 (marketplace spec R9.2; user decision 3). Built inside `admin-console.md`; where they disagree for this page, this file wins.

## What this page is

The kinds of photography a studio can tag itself with, which the public directory filters by: create, rename, reorder, deactivate and reactivate, and delete one nobody has. Active and inactive alike, in the platform's order (`GET /api/platform/categories`).

## Layout

`main`, `PAGE max-w-4xl`. `PageHeader`: eyebrow `Tags` + "PLATFORM", `h1` "Categories", a mono count chip "6 categories", an intro, and the page's one action **New category** (`Plus`, inverted neutral; right from `lg`, full width on a phone).

Then: the polite sr-only announcement region (moves), the page notice, the list.

- **List:** an `ol` (`aria-label` "Categories") in one hairline panel, a row per category. Each row: the name (16px, `wrap-anywhere`; muted when inactive) with the state badge beside it, **Active** (success tint, `Check`) or **Inactive** (dotted `--input` edge, muted, `EyeOff`); then a meta line with the slug in mono, `·`, the photographer count ("3 photographers", "No photographers"). On the right from `md` (below on a phone): **Rename** (`Pencil`), **Deactivate** (`EyeOff`) or **Reactivate** (`Eye`), **Delete** (`Trash2`, outline with red text) only when the count is 0, then **Move up** / **Move down** (icon buttons, named "Move Wedding up") at the far right, so the arrows line up from row to row whether or not Delete is there (screenshot review, 2026-10-30). On a phone the edits share a row, half each, and the moves take the next. All 44px below `lg` and on touch; the row's buttons wrap, never scroll.
- **Empty:** a dashed hairline box with `Tags` and "No categories yet. Create the first one."

## Dialogs (admin-console 6.11)

- **New category:** Name (1 to 80 characters), then Slug (mono, `spellcheck=false`), with the hint "Lowercase letters and numbers, words joined by hyphens, up to 64 characters. It can't be changed later." Until the slug is edited by hand it follows the name (lowercased, accents dropped, other characters to hyphens). Checked before sending: the name trimmed 1-80 code points; the slug `^[a-z0-9]+(-[a-z0-9]+)*$` and at most 64. `409 slug_taken` marks the slug ("That slug is already used by another category, active or not."); `400` marks the slug; `422` marks its fields. Created: it is appended last and "Category created." shows.
- **Rename:** Name prefilled; the slug shown read-only beneath (mono, in a `--console-surface` sub-surface) with "The slug can't change: it's in every shared directory link." `404`: closes, reloads, "That category no longer exists." `422`: the name.
- **Deactivate a category in use** (count > 0) confirms first: "Deactivate Wedding?", body "It's hidden from the directory and from the studios' category picker. The 3 photographers who have it keep the tag; reactivating it brings it back for them." Confirm is outline-weight inverted neutral (it is reversible). An unused category deactivates at once, like Reactivate, with the success notice; focus stays on the button, whose word flips.
- **Delete:** "Delete Portrait?" / "It's removed for good. Nobody has it, so no studio changes." Cancel and **Delete category** (solid destructive). A `409 category_in_use` (someone tagged it meanwhile) keeps the dialog open with a warning "3 photographers now have this category, so it can't be deleted. Deactivate it instead to hide it." and a **Deactivate instead** button; the row's count updates, so Delete leaves the row.

Each dialog: Cancel first in the DOM, the action last; stacked full width on a phone. Focus returns to the button that opened it (after a delete, to the New category button, since the row is gone).

## Reordering

The studio portfolio's pattern (`studio-portfolio.md`): one place at a time, the new order shown at once and saved with one `PUT /order` carrying every id, inactive ones included. While it saves the move buttons are `aria-disabled`. Focus stays on the moved category's same button (the other one at an end). The polite region says "Wedding moved to position 2 of 6." A `422` (the list changed elsewhere) reloads with a warning; any other failure puts the old order back with "Could not save the new order…".

## States

loading (four skeleton rows in the panel), load failed (+ Try again), empty, list, creating, created, create refused (slug taken / invalid), renaming, renamed, gone, deactivating (confirm when in use), deactivated, reactivated, toggle failed, deleting, deleted, delete refused (in use), moving, order changed elsewhere, order failed.

## Do not

- No slug editing after creation (it is in shared directory links).
- No drag handle; no bulk actions.
- No French name field (`name_fr` stays unused, English only).
