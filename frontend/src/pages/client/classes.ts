/**
 * Shared class strings for the client pages (design-system/bookly/client-front.md
 * sections 3 and 4), so every page draws the container, the section rhythm and
 * the type roles the same way. Page groups use these rather than re-typing them.
 */

/** `max-w-6xl` centred, a 16 / 32 / 48px gutter. */
export const container = 'mx-auto w-full max-w-6xl px-4 md:px-8 lg:px-12'

/** Section rhythm: 48px on phones, 64px at `md`, 104px from `lg`. */
export const sectionY = 'py-12 md:py-16 lg:py-26'

/** Page padding for a non-Home page: roomy, and less than a Home section. */
export const pageY = 'py-10 md:py-14'

/** Mono uppercase label with its icon, muted. */
export const eyebrow =
  'inline-flex items-center gap-2 font-mono text-xs font-medium tracking-[0.1em] uppercase text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0'

/** A Home section heading. */
export const sectionTitle = 'text-[2rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance md:text-[2.75rem]'

/** The `h1` of every page except Home. */
export const pageTitle = 'text-3xl leading-[1.15] font-semibold tracking-[-0.02em] text-balance md:text-4xl'

/** The `h1` of a status view (notices, payment outcomes). */
export const statusTitle = 'text-3xl leading-[1.15] font-semibold tracking-[-0.02em] text-balance'

/** An `h2` inside a page (the summary, "Your email", cancelling). */
export const panelTitle = 'text-xl font-medium tracking-[-0.01em]'

/** Body copy under a heading. */
export const lead = 'text-base text-subtle-foreground text-pretty md:text-lg'

/** A standalone text link: violet, 44px tall on touch, underlined on hover. */
export const textLink =
  'inline-flex min-h-6 items-center gap-2 rounded-xs text-console-link underline-offset-4 hover:text-console-link-hover hover:underline pointer-coarse:min-h-11'

/** A quiet link in the header or footer: secondary text, violet on hover. */
export const quietLink =
  'inline-flex min-h-6 items-center gap-2 rounded-xs text-subtle-foreground hover:text-console-link motion-safe:transition-colors motion-safe:duration-150 pointer-coarse:min-h-11 pointer-coarse:min-w-11'

/** A bordered flat panel. */
export const panel = 'rounded-xs border bg-background'

/** Mono data: amounts, times, references. */
export const data = 'font-mono tabular-nums'
