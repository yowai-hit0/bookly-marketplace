import type { LucideIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { EYEBROW, META, TITLE } from './classes'

/**
 * The admin console's page header (design-system/bookly/admin-console.md 6.3):
 * an eyebrow (icon + mono label), the page's only `h1` with its badges beside
 * it, an optional meta row, and the page's actions on the right (stacked full
 * width on a phone). The words are the page's own strings; this only lays them out.
 */
export function PageHeader({
  eyebrow,
  eyebrowIcon: EyebrowIcon,
  title,
  titleClassName,
  titleProps,
  badges,
  meta,
  actions,
  children,
  className,
}: {
  eyebrow: string
  eyebrowIcon: LucideIcon
  title: ReactNode
  titleClassName?: string
  /** Passed to the `h1` (a page that moves focus to its heading sets `tabIndex` here). */
  titleProps?: Omit<ComponentProps<'h1'>, 'children' | 'className'>
  badges?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  /** Anything that belongs to the header below the meta row (an intro sentence). */
  children?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between', className)}>
      <div className="flex min-w-0 flex-col gap-3.5">
        <p className={cn(EYEBROW, 'flex items-center gap-2')}>
          <EyebrowIcon aria-hidden="true" className="size-4 shrink-0" />
          {eyebrow}
        </p>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <h1 {...titleProps} className={cn(TITLE, 'min-w-0 wrap-anywhere', titleClassName)}>
            {title}
          </h1>
          {badges}
        </div>
        {meta !== undefined && <div className={cn(META, 'flex flex-wrap items-center gap-x-6 gap-y-2')}>{meta}</div>}
        {children}
      </div>
      {actions !== undefined && (
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:flex-wrap lg:justify-end">{actions}</div>
      )}
    </header>
  )
}

/** One icon + text pair in a header's meta row. */
export function MetaItem({ icon: Icon, children, className }: { icon: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </span>
  )
}
