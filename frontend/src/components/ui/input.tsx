import * as React from "react"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 pointer-coarse:h-11 w-full min-w-0 rounded-lg border border-input bg-card px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-transparent dark:disabled:bg-muted dark:aria-invalid:border-destructive dark:aria-invalid:ring-0 client:h-11 client:md:h-12 client:pointer-coarse:h-11 client:bg-transparent client:px-3.5 client:md:text-base client:aria-invalid:ring-0 client:motion-safe:transition-[border-color] client:motion-safe:duration-150",
        className
      )}
      {...props}
    />
  )
}

export { Input }
