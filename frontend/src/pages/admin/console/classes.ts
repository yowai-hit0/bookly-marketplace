/**
 * Class strings shared by the admin console's pages
 * (design-system/bookly/admin-console.md). Pages use these rather than
 * retyping them, so the console's type and field rules stay in one place.
 */

/** The page column: 16px gutter on a phone, 48px from `lg`, sections 32px / 48px apart. */
export const PAGE = 'mx-auto flex w-full flex-col gap-8 px-4 py-8 lg:gap-12 lg:px-12 lg:py-12'

/** Mono uppercase micro-label: eyebrows, table headers, tile labels, group labels. */
export const EYEBROW = 'font-mono text-xs font-medium tracking-[0.1em] text-muted-foreground uppercase'

/** Page title: Geist 30px / 600 / -0.02em. */
export const TITLE = 'text-3xl leading-tight font-semibold tracking-[-0.02em] text-balance'

/** Section heading: Geist 20px / 500. */
export const SECTION_TITLE = 'text-xl font-medium'

/** Secondary meta: 14px muted. */
export const META = 'text-sm text-muted-foreground'

/** Data values: mono 15px with tabular figures (references, times, durations, money). */
export const DATA = 'font-mono text-[0.9375rem] tabular-nums'

/** A link in running text or a list: accent, no underline until hover. */
export const LINK =
  'rounded-xs text-console-link underline-offset-4 hover:text-console-link-hover hover:underline motion-safe:transition-colors motion-safe:duration-150'

/** A reference or ID link: mono and underlined at rest, as in the style guide. */
export const REF_LINK =
  'rounded-xs font-mono text-console-link underline underline-offset-4 hover:text-console-link-hover motion-safe:transition-colors motion-safe:duration-150'

/** A standalone muted link (back to sign in, forgot password). */
export const QUIET_LINK =
  'inline-flex min-h-6 items-center gap-1.5 self-start rounded-xs text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline max-lg:min-h-11 pointer-coarse:min-h-11'

/**
 * A text field in the console, added to `Input`, `Textarea` or a native select:
 * 40px from `lg`, 44px below it and on touch, no fill, a 3:1 `--input` edge
 * (decision 5), 15px text from `md` (16px on a phone so iOS does not zoom). An
 * invalid field shows its red edge without the primitive's red halo: the
 * console has no shadows, and the error sentence under it carries the meaning.
 */
export const FIELD =
  'h-11 lg:h-10 pointer-coarse:h-11 rounded-xs bg-transparent px-3 aria-invalid:ring-0 md:text-[0.9375rem]'

/** A textarea keeps its own height. */
export const TEXTAREA = 'rounded-xs bg-transparent px-3 py-2.5 aria-invalid:ring-0 md:text-[0.9375rem]'

/** A native select, styled as a console field. */
export const SELECT =
  'h-11 lg:h-10 pointer-coarse:h-11 w-full min-w-0 rounded-xs border border-input bg-transparent px-3 text-base outline-none aria-invalid:border-destructive md:text-[0.9375rem]'

/** A native radio or checkbox: violet when checked, the size of the text beside it. */
export const CHOICE = 'size-4 accent-(--console-link)'

/** The Radix `Checkbox` in the console: square, a 3:1 edge, violet when checked (selected state is violet). */
export const CHECKBOX =
  'size-4.5 rounded-xs border-input data-checked:border-console-link data-checked:bg-console-link data-checked:text-background'

/** A table header cell. */
export const TH = `px-4 py-3 text-left align-bottom ${EYEBROW}`

/** A table body row: hairline between rows, the whole row a hover target. */
export const TR = 'border-b last:border-b-0 hover:bg-accent motion-safe:transition-colors motion-safe:duration-100'

/** A table body cell. */
export const TD = 'px-4 py-4 align-top'

/**
 * A sub-surface inside a panel (an inline editor): the raised surface and a
 * hairline, never a second card.
 */
export const SUBPANEL = 'flex flex-col gap-4 rounded-xs border bg-console-surface p-4 lg:p-6'
