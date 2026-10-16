import type { LucideIcon } from "lucide-react"
import { cn } from "cn"

const tones = {
  /** Information and waiting: Calendar Blue. */
  info: "text-ring",
  /** Only ever for an outcome the API has confirmed. */
  positive: "text-primary",
  destructive: "text-destructive",
  neutral: "text-muted-foreground",
} as const

/**
 * The large icon that opens a status view (design-system MASTER.md section 11):
 * 40px, a light stroke, a little left overhang so the glyph's ink lines up with
 * the heading below it, and always `aria-hidden`, because the words carry the
 * meaning. Green (`positive`) is reserved for an outcome that has been
 * confirmed; a view that is still waiting or only partly resolved never uses it.
 */
function StatusIcon({
  icon: Icon,
  tone,
  className,
}: {
  icon: LucideIcon
  tone: keyof typeof tones
  className?: string
}) {
  return (
    <Icon
      data-slot="status-icon"
      aria-hidden="true"
      strokeWidth={1.5}
      className={cn("mb-2 -ml-1 size-10", tones[tone], tone === "positive" && "client:text-console-success", className)}
    />
  )
}

export { StatusIcon }
