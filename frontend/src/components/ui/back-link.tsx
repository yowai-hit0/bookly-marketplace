import * as React from "react"
import { ArrowLeft } from "lucide-react"
import { Link } from "react-router"
import { cn } from "cn"

/**
 * A standalone "back" link (design-system MASTER.md section 11): muted text,
 * underlined on hover, a full-strength focus outline (the Button's 50% ring is
 * too faint for text) and 44px tall on touch. The arrow is an icon, so a screen
 * reader hears only the words.
 */
function BackLink({
  to,
  className,
  children,
}: {
  to: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      data-slot="back-link"
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 self-start rounded-sm text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11 client:gap-2 client:text-subtle-foreground client:hover:text-console-link client:hover:no-underline client:motion-safe:transition-colors",
        className
      )}
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      {children}
    </Link>
  )
}

export { BackLink }
