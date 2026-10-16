import * as React from "react"
import {
  Archive,
  Ban,
  Camera,
  CheckCheck,
  ClipboardCheck,
  CircleCheck,
  CircleX,
  Clock,
  Hourglass,
  UserX,
  type LucideIcon,
} from "lucide-react"
import { cn } from "cn"
import { Badge } from "./badge"
import { StatusBadgeVariantContext } from "./status-badge-context"

type Treatment = { icon: LucideIcon | null; className: string }

/**
 * The seven booking statuses, one look for the client's pill and (in a later
 * section) the admin's badges and calendar events (design-system MASTER.md
 * section 7). The label is always shown and the icon only repeats it. The seven
 * stay apart in greyscale: a dashed edge, a dotted edge, a tinted fill, a plain
 * muted fill and no fill, and a different icon each. Tinted fills are mixed into
 * the card's white in oklab, never laid over the page and never mixed in oklch
 * against `--card` (see MASTER section 11). No status uses a heavy red edge; that
 * belongs to the calendar's conflict outline.
 */
const TREATMENTS = new Map<string, Treatment>([
  // An unpaid hold.
  ["pending_payment", { icon: Clock, className: "border-dashed border-muted-foreground bg-transparent text-foreground" }],
  ["confirmed", { icon: CircleCheck, className: "border-primary/30 bg-[color-mix(in_oklab,var(--primary)_10%,var(--card))] text-primary" }],
  ["completed", { icon: CheckCheck, className: "border-transparent bg-muted text-foreground" }],
  ["no_show", { icon: UserX, className: "border-transparent bg-[color-mix(in_oklab,var(--destructive)_10%,var(--card))] text-destructive" }],
  // A hold that lapsed.
  ["expired", { icon: Hourglass, className: "border-dotted border-muted-foreground bg-transparent text-muted-foreground" }],
  ["cancelled_by_client", { icon: CircleX, className: "border-destructive/40 bg-transparent text-destructive" }],
  ["cancelled_by_admin", { icon: Ban, className: "border-input bg-transparent text-muted-foreground" }],
  // The display stages (2026-09-25, `backend/src/booking/stage.ts`): each keeps
  // the rule above -- apart in greyscale by edge, fill and icon.
  // `awaiting_payment` is `pending_payment` under its stage name.
  ["awaiting_payment", { icon: Clock, className: "border-dashed border-muted-foreground bg-transparent text-foreground" }],
  // Happening now: the only solid fill.
  ["in_progress", { icon: Camera, className: "border-transparent bg-primary text-primary-foreground" }],
  // Admin only: the shoot is over and waits on the photographer.
  ["needs_review", { icon: ClipboardCheck, className: "border-ring/40 bg-[color-mix(in_oklab,var(--ring)_10%,var(--card))] text-foreground" }],
  // Photos sent: done, and quieter than completed.
  ["closed", { icon: Archive, className: "border-transparent bg-muted text-muted-foreground" }],
])

/** A status the API adds later still renders, as a plain outline. */
const FALLBACK: Treatment = { icon: null, className: "border-input bg-transparent text-foreground" }

const SIZES = {
  /** The 20px badge, for tables. */
  sm: "",
  /** The header pill on a page: 28px, 14px text and 16px icons. */
  md: "h-7 gap-1.5 px-3 has-data-[icon=inline-start]:pl-2.5 text-sm [&>svg]:size-4!",
} as const

// --- The admin console (design-system/bookly/admin-console.md section 5) -------

/**
 * Four icon shapes carry the console's status language: a filled check is the
 * current, live state; an outlined check is an earlier success; a clock is
 * waiting; a cross is failed, cancelled or lapsed. The icon takes the tone;
 * the word is always there.
 */
type ConsoleShape = "current" | "earlier" | "waiting" | "failed"
type ConsoleTreatment = { shape: ConsoleShape | null; icon: string; className: string }

const CONSOLE_TREATMENTS = new Map<string, ConsoleTreatment>([
  ["confirmed", { shape: "current", icon: "text-console-success", className: "border-transparent bg-console-success-tint text-console-success" }],
  // Happening now: the one solid status.
  ["in_progress", { shape: "current", icon: "text-background", className: "border-transparent bg-console-success text-background" }],
  ["awaiting_payment", { shape: "waiting", icon: "text-muted-foreground", className: "border-dashed border-input bg-transparent text-foreground" }],
  ["pending_payment", { shape: "waiting", icon: "text-muted-foreground", className: "border-dashed border-input bg-transparent text-foreground" }],
  ["needs_review", { shape: "waiting", icon: "text-console-warning", className: "border-transparent bg-console-warning-tint text-console-warning" }],
  ["completed", { shape: "earlier", icon: "text-console-success", className: "border-transparent bg-console-chip text-foreground" }],
  ["closed", { shape: "earlier", icon: "text-muted-foreground", className: "border-border bg-transparent text-muted-foreground" }],
  ["no_show", { shape: "failed", icon: "text-destructive", className: "border-transparent bg-console-danger-tint text-destructive" }],
  ["cancelled_by_client", { shape: "failed", icon: "text-destructive", className: "border-destructive/40 bg-transparent text-destructive" }],
  ["cancelled_by_admin", { shape: "failed", icon: "text-destructive", className: "border-border bg-transparent text-muted-foreground" }],
  ["expired", { shape: "failed", icon: "text-muted-foreground", className: "border-dotted border-input bg-transparent text-muted-foreground" }],
])

const CONSOLE_FALLBACK: ConsoleTreatment = { shape: null, icon: "", className: "border-border bg-transparent text-foreground" }

const CONSOLE_SIZES = {
  sm: "h-auto gap-1.5 rounded-xs px-2 py-0.5 text-[0.8125rem] [&>svg]:size-3.5!",
  md: "h-auto gap-1.5 rounded-xs px-2.5 py-[5px] text-sm [&>svg]:size-4!",
} as const

/**
 * The console status icon on its own, for the leading column of a table row.
 * Decorative: the row's badge or text says the status in words.
 */
function StatusGlyph({ status, className }: { status: string; className?: string }) {
  const { shape, icon } = CONSOLE_TREATMENTS.get(status) ?? CONSOLE_FALLBACK
  if (shape === null) return null
  // In a badge with a solid fill the glyph takes the label's colour; alone it takes the tone.
  const tone = status === "in_progress" ? "text-console-success" : icon
  return <ConsoleShapeIcon shape={shape} className={cn("size-5.5 shrink-0", tone, className)} />
}

const SHAPE_TONES = {
  success: "text-console-success",
  muted: "text-muted-foreground",
  warning: "text-console-warning",
  danger: "text-destructive",
} as const

const DEFAULT_TONE: Record<ConsoleShape, keyof typeof SHAPE_TONES> = {
  current: "success",
  earlier: "success",
  waiting: "muted",
  failed: "danger",
}

/**
 * One of the four console status shapes, for things that are not bookings
 * (payments, messages) but speak the same language: filled check done,
 * outlined check an earlier success, clock waiting, cross failed. Decorative:
 * the word beside it says the status.
 */
function StatusShapeGlyph({
  shape,
  tone = DEFAULT_TONE[shape],
  className,
}: {
  shape: ConsoleShape
  tone?: keyof typeof SHAPE_TONES
  className?: string
}) {
  return <ConsoleShapeIcon shape={shape} className={cn("size-4 shrink-0", SHAPE_TONES[tone], className)} />
}

/**
 * Filled shapes are drawn here rather than taken from lucide, whose outline
 * icons cannot hold a check in the page colour inside a filled circle.
 */
function ConsoleShapeIcon({
  shape,
  ink = "var(--background)",
  className,
}: {
  shape: ConsoleShape
  /** The check inside a filled circle: the page colour, or the badge fill on a solid badge. */
  ink?: string
  className?: string
}) {
  if (shape === "current") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="inline-start" data-shape={shape} className={className}>
        <circle cx="12" cy="12" r="10" fill="currentColor" />
        <path d="M7.5 12.2l3 3 6-6.4" fill="none" stroke={ink} strokeWidth="2.2" />
      </svg>
    )
  }
  const Icon = shape === "earlier" ? CircleCheck : shape === "waiting" ? Clock : CircleX
  return <Icon aria-hidden="true" data-icon="inline-start" data-shape={shape} className={className} />
}

function StatusBadge({
  status,
  size = "sm",
  variant,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & {
  status: string
  size?: keyof typeof SIZES
  variant?: "default" | "console"
  /** The translated label. The client and the admin word some statuses differently. */
  children: React.ReactNode
}) {
  const inherited = React.useContext(StatusBadgeVariantContext)
  if ((variant ?? inherited) === "console") {
    const { shape, icon, className: treatment } = CONSOLE_TREATMENTS.get(status) ?? CONSOLE_FALLBACK
    return (
      <Badge
        variant="outline"
        data-status={status}
        data-variant="console"
        className={cn(treatment, CONSOLE_SIZES[size], className)}
        {...props}
      >
        {shape !== null && (
          <ConsoleShapeIcon
            shape={shape}
            className={icon}
            {...(status === "in_progress" ? { ink: "var(--console-success)" } : {})}
          />
        )}
        {children}
      </Badge>
    )
  }

  const { icon: Icon, className: treatment } = TREATMENTS.get(status) ?? FALLBACK

  return (
    <Badge
      variant="outline"
      data-status={status}
      className={cn(treatment, SIZES[size], className)}
      {...props}
    >
      {Icon !== null && <Icon aria-hidden="true" data-icon="inline-start" />}
      {children}
    </Badge>
  )
}

export { StatusBadge, StatusGlyph, StatusShapeGlyph }
export type { ConsoleShape as StatusShape }
