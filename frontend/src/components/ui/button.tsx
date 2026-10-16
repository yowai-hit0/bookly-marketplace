import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 client:text-[0.9375rem] client:transition-[color,background-color,border-color,translate] client:duration-150 client:active:not-aria-[haspopup]:translate-y-0 client:motion-safe:hover:not-aria-disabled:not-disabled:-translate-y-px",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklch,var(--primary),black_12%)] client:hover:bg-primary-hover",
        outline:
          "border-input bg-card hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground client:border-console-border-strong client:bg-transparent dark:bg-transparent dark:hover:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        // The confirmation of something irreversible: a solid fill, white label
        // (6.47:1), so it cannot be mistaken for the tinted `destructive` that
        // merely opens the question. Three pages hand-wrote this override
        // before it was a variant; it keeps their focus ring the neutral one,
        // since the button is already red.
        "destructive-solid":
          "bg-destructive text-white hover:bg-[color-mix(in_oklch,var(--destructive),black_12%)] focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-console-danger-solid dark:hover:bg-[color-mix(in_oklch,var(--console-danger-solid),black_12%)]",
        // The client's one violet action: the hero CTA (client-front.md 5.1).
        brand: "bg-brand text-brand-foreground hover:bg-brand-hover",
        link: "text-primary underline-offset-4 hover:underline client:text-console-link client:hover:text-console-link-hover",
        // Admin console only (design-system/bookly/admin-console.md 6.10).
        // Its outline edge is the canvas's strong border, which a labelled
        // button may use although it is under 3:1; fields keep `--input`.
        "console-outline":
          "border-console-border-strong bg-transparent hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        // The irreversible confirm in the console: `--destructive` is a text
        // colour there (dark #F87171 cannot carry a white label), so the fill
        // has its own token (white on it: 4.83:1 dark, 6.47:1 light).
        "console-destructive-solid":
          "bg-console-danger-solid text-white hover:bg-[color-mix(in_oklch,var(--console-danger-solid),black_12%)]",
      },
      size: {
        default:
          "h-8 pointer-coarse:h-11 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 client:h-11 client:gap-2 client:px-5",
        xs: "h-6 pointer-coarse:h-9 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 pointer-coarse:h-11 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5 client:h-10 client:pointer-coarse:h-11 client:gap-1.5 client:px-4 client:text-sm client:[&_svg:not([class*='size-'])]:size-4",
        lg: "h-9 pointer-coarse:h-11 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 client:h-13 client:pointer-coarse:h-13 client:gap-2.5 client:px-6 client:text-base",
        icon: "size-8 pointer-coarse:size-11 client:size-10 client:pointer-coarse:size-11",
        "icon-xs":
          "size-6 pointer-coarse:size-9 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 pointer-coarse:size-11 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg client:size-10 client:pointer-coarse:size-11",
        "icon-lg": "size-9 pointer-coarse:size-11 client:size-11",
        // Admin console only: 40px from `lg`, 44px below it and on touch, no
        // press nudge, and colour-only transitions behind `motion-safe` (the
        // console moves colour, never position, and never animates focus).
        console:
          "h-11 lg:h-10 pointer-coarse:h-11 gap-2 px-4 text-[0.9375rem] transition-none motion-safe:transition-colors motion-safe:duration-150 active:not-aria-[haspopup]:translate-y-0",
        "console-sm":
          "h-11 lg:h-8 pointer-coarse:h-11 gap-1.5 px-3 text-sm transition-none motion-safe:transition-colors motion-safe:duration-150 active:not-aria-[haspopup]:translate-y-0",
        "console-icon":
          "size-11 lg:size-10 pointer-coarse:size-11 transition-none motion-safe:transition-colors motion-safe:duration-150 active:not-aria-[haspopup]:translate-y-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
