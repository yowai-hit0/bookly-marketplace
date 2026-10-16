import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { cn } from "cn"

/**
 * The shadcn dialog over Radix, in the admin console's look
 * (design-system/bookly/admin-console.md): a flat panel with a hairline and
 * 2px corners on a dimmed page. Radix traps focus inside it, closes it on
 * Escape and on a click outside, and returns focus to whatever opened it. A
 * tall form scrolls inside the panel, never the page behind it.
 */
function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogContent({
  className,
  children,
  closeLabel,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** The close button's accessible name (it shows only an ×). */
  closeLabel: string
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-black/60 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0"
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xs border outline-none",
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label={closeLabel}
          className="text-muted-foreground hover:text-foreground hover:bg-muted absolute top-2 right-2 flex size-11 items-center justify-center rounded-xs lg:top-3 lg:right-3 lg:size-9 motion-safe:transition-colors"
        >
          <XIcon aria-hidden="true" className="size-4.5" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex shrink-0 flex-col gap-1.5 border-b px-4 py-4 pr-14 sm:px-6", className)}
      {...props}
    />
  )
}

/** The scrolling middle: a tall form scrolls here, inside the panel. */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-body" className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6", className)} {...props} />
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-xl font-medium", className)} {...props} />
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger }
