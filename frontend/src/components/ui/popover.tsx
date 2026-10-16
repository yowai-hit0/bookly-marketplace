import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { cn } from "cn"

/**
 * The shadcn popover over Radix: opens on click, tap, Enter and Space, closes
 * on Escape or a click outside, and returns focus to its trigger. Used for
 * short explanations a hover-only tooltip would hide from touch and keyboard.
 */
function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={16}
        className={cn(
          "bg-card text-foreground z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border p-4 text-sm shadow-md outline-none client:bg-popover",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
