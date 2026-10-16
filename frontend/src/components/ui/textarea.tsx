import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-card px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-transparent dark:disabled:bg-muted dark:aria-invalid:border-destructive dark:aria-invalid:ring-0 client:min-h-24 client:bg-transparent client:px-3.5 client:py-3 client:md:text-base client:aria-invalid:ring-0",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
