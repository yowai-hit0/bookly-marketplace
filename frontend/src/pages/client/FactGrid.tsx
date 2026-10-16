import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { eyebrow } from './classes'

/**
 * Metadata tiles for the client (design-system/bookly/client-front.md 5.7):
 * the admin's `StatGrid` look, re-implemented here so no client page imports
 * from `pages/admin/`. A square icon tile, then a mono label above the value;
 * two columns from `sm`. A `dl` of `div > dt + dd`, so each label names its
 * value for a screen reader.
 */
export function FactGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('grid gap-x-8 gap-y-6 sm:grid-cols-2', className)}>{children}</dl>
}

const TONES = {
  neutral: 'bg-muted text-foreground',
  success: 'bg-console-success-tint text-console-success',
  warning: 'bg-console-warning-tint text-console-warning',
  danger: 'bg-console-danger-tint text-destructive',
} as const

export function FactTile({
  icon: Icon,
  label,
  children,
  mono = false,
  tone = 'neutral',
  className,
}: {
  icon: LucideIcon
  label: string
  children: ReactNode
  /** Data (times, money, references) in mono; words in Geist. */
  mono?: boolean
  tone?: keyof typeof TONES
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-4 sm:gap-5', className)}>
      <IconTile icon={Icon} tone={tone} size="md" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <dt className={eyebrow}>{label}</dt>
        <dd className={cn('min-w-0 wrap-anywhere', mono ? 'font-mono text-[0.9375rem] tabular-nums' : 'text-base')}>
          {children}
        </dd>
      </div>
    </div>
  )
}

/**
 * A square icon tile (always `aria-hidden`): 48px, 64px from `sm` (`md`), or
 * 64px everywhere (`lg`, the status views). The icon inherits the tone.
 */
export function IconTile({
  icon: Icon,
  tone = 'neutral',
  size = 'md',
  className,
  children,
}: {
  icon?: LucideIcon
  tone?: keyof typeof TONES | 'accent'
  size?: 'md' | 'lg'
  className?: string
  /** A ready element in place of the icon (a spinner, a drawn check). */
  children?: ReactNode
}) {
  const toneClass = tone === 'accent' ? 'bg-console-accent text-console-accent-foreground' : TONES[tone]
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-xs',
        size === 'md' ? 'size-12 sm:size-16 [&_svg]:size-5' : 'size-16 [&_svg]:size-7',
        toneClass,
        className,
      )}
    >
      {Icon !== undefined ? <Icon /> : children}
    </div>
  )
}
