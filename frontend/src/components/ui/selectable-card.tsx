import * as React from "react"
import { cn } from "cn"

/**
 * An option card around a native radio or checkbox (design-system MASTER.md
 * sections 8 and 11): the whole card is the label, and the caller gives it its
 * padding. Selected is a 2px green edge and a faint green tint, mixed into the
 * card's own white rather than laid over the page, so it stays a white card and
 * never reads like the blue hover surface. The mixes are in oklab on purpose:
 * `--card` is `oklch(1 0 0)`, an explicit hue of 0, and an oklch mix would drift
 * the tint toward pink. Keyboard focus turns the border blue
 * with a ring, and replaces the native input's own faint outline so there is one
 * clear indicator, not two.
 */
function SelectableCard({
  className,
  ...props
}: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="selectable-card"
      className={cn(
        "flex cursor-pointer gap-3 rounded-xl border bg-card shadow-sm has-checked:border-primary has-checked:bg-[color-mix(in_oklab,var(--primary)_5%,var(--card))] has-checked:ring-1 has-checked:ring-primary has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/50 not-has-checked:hover:bg-[color-mix(in_oklab,var(--muted)_60%,var(--card))] motion-safe:transition-colors motion-safe:duration-150 [&_input:focus-visible]:outline-none client:rounded-xs client:bg-background client:shadow-none client:has-checked:border-selected-edge client:has-checked:bg-selected client:has-checked:ring-0 client:has-focus-visible:border-selected-edge client:has-focus-visible:ring-0 client:has-focus-visible:outline-2 client:has-focus-visible:outline-offset-2 client:has-focus-visible:outline-ring client:not-has-checked:hover:border-muted-foreground client:not-has-checked:hover:bg-background client:motion-safe:transition-[border-color,background-color,translate] client:motion-safe:duration-200 client:motion-safe:hover:-translate-y-0.5 client:motion-safe:has-checked:animate-pop",
        className
      )}
      {...props}
    />
  )
}

export { SelectableCard }
