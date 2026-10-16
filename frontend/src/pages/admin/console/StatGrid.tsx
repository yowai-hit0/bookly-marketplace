import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { DATA, EYEBROW } from './classes'

/**
 * Metadata tiles (design-system/bookly/admin-console.md 6.6): a square icon
 * tile, then a mono label above the value. Two columns from `sm`, one below.
 * A `dl`, so each label names its value for a screen reader.
 */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('grid gap-x-8 gap-y-6 sm:grid-cols-2', className)}>{children}</dl>
}

const TONES = {
  neutral: 'bg-console-chip text-foreground',
  success: 'bg-console-success-tint text-console-success',
  warning: 'bg-console-warning-tint text-console-warning',
  danger: 'bg-console-danger-tint text-destructive',
} as const

export function StatTile({
  icon: Icon,
  glyph,
  label,
  children,
  mono = false,
  tone = 'neutral',
  className,
}: {
  /** A 20px outline icon for the tile... */
  icon?: LucideIcon
  /** ...or a ready element instead (a status glyph). */
  glyph?: ReactNode
  label: string
  children: ReactNode
  /** Data (times, money, durations) in mono; words in Geist. */
  mono?: boolean
  tone?: keyof typeof TONES
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-4 sm:gap-5', className)}>
      <div aria-hidden="true" className={cn('flex size-12 shrink-0 items-center justify-center rounded-xs sm:size-16', TONES[tone])}>
        {Icon !== undefined ? <Icon className="size-5" /> : glyph}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <dt className={EYEBROW}>{label}</dt>
        <dd className={cn('min-w-0 wrap-anywhere', mono ? DATA : 'text-base')}>{children}</dd>
      </div>
    </div>
  )
}
