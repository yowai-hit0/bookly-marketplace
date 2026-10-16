import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "cn"

const tones = {
  /** Information and waiting: Calendar Blue, the `ring` token. */
  info: { box: "border-ring/30 bg-ring/5", icon: "text-ring" },
  /** A warning about something that cannot be undone. */
  destructive: { box: "border-destructive/30 bg-destructive/5", icon: "text-destructive" },
} as const

/**
 * The admin console's banner (design-system/bookly/admin-console.md 6.4): a
 * solid tint with no edge, square, an 18px icon, and an optional action on
 * the right. The words stay in the text colour; the icon carries the tone.
 */
const consoleTones = {
  info: { box: "bg-console-accent text-console-info-foreground", icon: "text-console-info-icon" },
  success: { box: "bg-console-success-tint text-foreground", icon: "text-console-success" },
  warning: { box: "bg-console-warning-tint text-foreground", icon: "text-console-warning" },
  destructive: { box: "bg-console-danger-tint text-foreground", icon: "text-destructive" },
} as const

type CalloutProps = React.ComponentProps<"div"> & { icon: LucideIcon } & (
    | { variant?: "default"; tone?: keyof typeof tones; action?: never }
    | {
        variant: "console"
        tone?: keyof typeof consoleTones
        /** A trailing control (an underlined link), right-aligned from `sm`. */
        action?: React.ReactNode
      }
  )

/**
 * A notice inside a page (design-system MASTER.md section 8): a tinted fill, a
 * full 1px edge and a small icon, never a coloured stripe down one side. The
 * text stays Ink Navy in every tone; the icon carries the tone, and the words
 * carry the meaning.
 */
function Callout({ icon: Icon, variant = "default", tone = "info", action, className, children, ...props }: CalloutProps) {
  if (variant === "console") {
    const { box, icon } = consoleTones[tone as keyof typeof consoleTones]
    return (
      <div
        data-slot="callout"
        data-variant="console"
        className={cn(
          "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xs px-4 py-3.5 text-[0.9375rem] leading-snug",
          box,
          className
        )}
        {...props}
      >
        <Icon aria-hidden="true" className={cn("mt-px size-4.5 shrink-0", icon)} />
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">{children}</div>
        {action !== undefined && <div className="shrink-0 max-sm:basis-full max-sm:pl-7.5">{action}</div>}
      </div>
    )
  }

  const toneClasses = tones[tone as keyof typeof tones]
  return (
    <div
      data-slot="callout"
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-sm",
        toneClasses.box,
        className
      )}
      {...props}
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", toneClasses.icon)} />
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
    </div>
  )
}

export { Callout }
