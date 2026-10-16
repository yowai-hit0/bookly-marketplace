/**
 * Numbers a booking-funnel group's heading with a CSS counter
 * (design-system/bookly/pages/service-detail.md; client-front.md section 8.3):
 * the board's mono "1 · " label, generated content so no new text exists, in
 * front of the existing legend or heading words. The container that holds the
 * groups sets `[counter-reset:step]`; each numbered heading adds this class.
 * The heading's own words keep their own size and weight (20px / 500); only
 * the counter prefix is mono, muted and 12px.
 */
export const stepNumber =
  'before:font-mono before:text-xs before:font-medium before:tracking-[0.1em] before:text-muted-foreground before:content-[counter(step)_"_·_"] before:[counter-increment:step]'
