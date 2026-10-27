# Studio Profile — Page Design

> **Project:** Bookly · **Route:** `/studio/profile` (inside `AdminLayout`) · **Files:** `frontend/src/pages/admin/AdminProfile.tsx`, `frontend/src/admin/profile.ts`
> **Written:** 2026-10-25, Phase 7 (marketplace spec R7.2). Built inside `admin-console.md`; where they disagree for this page, this file wins. The fields, sections and states follow `settings.md` and `AdminPayoutMethod`.

## What this page is

The photographer's public profile as they edit it: the handle, the display name and bio, the cover image, the districts they work in, the categories they shoot, and the public contact details. `GET /api/studio/profile` with the public `GET /api/categories` and `GET /api/districts` (all three load together; any failure is one load-failed state with Retry). What is typed here is what `/p/:handle` shows (`photographer-profile.md`).

## Layout

`main`, `PAGE max-w-3xl`. `PageHeader`: eyebrow `UserRound` + "STUDIO", `h1` "Profile", intro (14px muted, `max-w-prose`). Then one `form` (`aria-label` "Profile", `noValidate`) of five sections, each an `h2` (20px/500) split from the next by a full-bleed hairline (admin-console 6.7: no nested cards):

1. **About you:** Handle, Display name, Bio (textarea, 6 rows, line breaks kept).
2. **Cover image:** the link (mono), then a **live preview** (below).
3. **Districts** (`id="districts"`): the district picker (below).
4. **Categories** (`id="categories"`): a checkbox grid, 2 columns (3 from `lg`).
5. **Contact details:** a one-line intro ("Every contact detail is optional…"), Phone and WhatsApp side by side from `sm`, Contact email full width below (`max-w-md`).

Below the last section, above a hairline: the notice (saved, nothing changed, refused, failed) directly above the **Save profile** button (inverted neutral, `self-start` from `sm`, full width on a phone; real `disabled` while saving, label "Saving…").

`#districts` and `#categories` (the setup checklist's links) scroll their section into view once the form exists and move focus to it (`tabIndex=-1`, no ring: a place, not a control).

## Fields

Every text field goes through `AdminField` (label above, 13px hint, 13px error with `CircleAlert`, both in `aria-describedby`). Inputs are the console `FIELD` (40px from `lg`, 44px below and on touch).

- **Handle, editable** (never approved): mono input, `sm:max-w-sm`, the hint gives the rule, and "Your profile address: /p/…" follows as typed.
- **Handle, under review** (editable, `status` pending and `submittedAt` set): a second hint line with a `BellRing` icon, "Your studio is waiting for review. If you change your handle now, the platform team is told the old and the new one." It is part of the field's description for screen readers. The save is not blocked: the API stamps `handle_changed_at` and emails every platform admin (decided 2026-10-27: the handle is the one crucial detail).
- **Handle, read-only** (`handleEditable` false, ever approved): the same input `readOnly`, muted on the raised surface, still labelled and in the tab order (it can be selected and copied), with a `Lock` icon and "Your handle is fixed now that your studio has been approved: it is in every link to your profile." The API refuses a different handle with `409 handle_locked`; the page never sends one.
- **Phones:** `type="tel"`, tabular figures. The hint says a Rwandan local number is fine.
- **Contact email:** says it is not the sign-in address.

## Cover preview

Shown only while the link is a valid `https:` URL (`isHttpsLink`), 400ms after typing pauses (a paste shows at once on the next tick of the timer, not on every keystroke). A `figure` with a mono "COVER PREVIEW" caption and the image at the profile's own 21:9, `object-cover`, hairline, `referrerPolicy="no-referrer"`. **Broken image:** the `onError` replaces it with a raised-surface box of the same size, `ImageOff` and "This image could not be loaded. Check that the link opens the image itself." (`role="status"`). A new link tries again.

## District picker (30 districts, five provinces)

A `fieldset` (sr-only legend "Districts"; the section `h2` names it visually) with the hint and a live "3 SELECTED" mono count, then a labelled **search box** ("Find a district", `type="search"`, `Search` icon, Enter does not submit). Typing narrows the list case-insensitively; a ticked district hidden by the search stays ticked. Each province is a nested `fieldset` with a mono legend and a checkbox grid (2 columns, 3 from `lg`). Nothing matches: "No district matches "…"." (`role="status"`). Each checkbox is a native input (violet `accent`) wrapped in its label, the row a 44px target on touch (36px on a desktop pointer). Keyboard: Tab through the boxes, Space toggles.

**Why checkboxes, not a combobox:** 30 options in five named groups fit on one screen, every choice stays visible, and native checkboxes need no ARIA pattern to be keyboard- and screen-reader-correct. The search covers "find it quickly".

## Saving

- **Only changed fields are sent** (`profilePatch`): text compared trimmed, a blank optional field sent as `null` (clears), the handle lowercased (the current handle in any case is not a change), and the two lists compared as sets. Nothing changed: an info notice "Nothing has changed since the last save." and no request.
- **Checked before sending** (`invalidProfileFields`), where the API would answer an unlabelled 400: handle format, display name 1-80 and bio ≤ 2,000 (code points, as the API counts), phone shape and ≤ 40, email shape, cover `https:` ≤ 2,000. The first field in error takes focus.
- **Refusals land on their field:** `409 handle_taken` → the handle ("That handle is unavailable. Try another."); `422 { fields }` → each named field (a list item path `districts.3` marks the list); `409 handle_locked` (approved meanwhile) → the handle reverts, turns read-only, and a warning notice says why; a `400` → "Some details were not accepted…"; anything else → "Could not save your profile…".
- **After a save** the form is redrawn from what the API stored (its trimmed, E.164, lowercased values), with the success notice (`role="status"`).

## States

loading (skeleton of the sections, `LoadingRegion`), load failed (destructive line + Retry), idle, field-invalid, nothing to save, saving, saved, handle locked meanwhile, save refused (400), save failed.

## Studio nav

Item **Profile** (`UserRound`), after Availability: see `admin-shell.md`.

## Do not

- No autosave, no dirty-state prompt, no reset button.
- No image upload: links only (marketplace spec, no file storage).
- No markdown or HTML in the bio: plain text, as the public page renders it.
