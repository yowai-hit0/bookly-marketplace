import * as React from "react"
import { cn } from "cn"

/**
 * A grey block standing in for content that is still loading. Decorative only:
 * whoever renders skeletons announces the wait once, in words, and hides the
 * blocks from assistive technology. The pulse stops for reduced motion.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-muted animate-pulse rounded-md motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Skeleton }
