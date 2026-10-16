import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Loading states for the admin pages (admin console fixes, item 2,
 * 2026-09-27): the page's real layout with placeholder blocks where its data
 * will be, so nothing jumps when the data arrives -- you see the shape of the
 * page, not its content.
 *
 * The region is `aria-busy`; the blocks are hidden from assistive tech; the
 * page's own loading sentence is announced once through a visually hidden
 * live region. `Skeleton` already stops pulsing under reduced motion.
 */
export function LoadingRegion({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div aria-busy="true">
      <p className="sr-only" role="status">
        {label}
      </p>
      {/* A real box, not `display: contents`, so `aria-hidden` reliably hides the blocks. */}
      <div aria-hidden="true" className={className}>
        {children}
      </div>
    </div>
  )
}

/** A line of text: `w` is its width, the height is one line of body type. */
export function Line({ w, className }: { w: string; className?: string }) {
  return <Skeleton data-slot="skeleton-line" className={cn('h-4 rounded-xs', w, className)} />
}

/** A bordered console panel with a title bar and `rows` hairline rows, as `Card variant="console"` draws them. */
export function PanelSkeleton({ rows = 3, rowHeight = 'h-16', actions = true }: { rows?: number; rowHeight?: string; actions?: boolean }) {
  return (
    <div className="flex flex-col rounded-xs border">
      <div className="flex flex-col gap-2 border-b p-4 sm:p-6">
        <Line w="w-40" className="h-6" />
        <Line w="w-72 max-w-full" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={cn('flex items-center justify-between gap-4 border-b px-4 last:border-b-0 sm:px-6', rowHeight)}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Line w="w-48 max-w-full" />
            <Line w="w-32" className="h-3" />
          </div>
          {actions && (
            <div className="hidden gap-2 sm:flex">
              <Skeleton className="h-8 w-14 rounded-xs" />
              <Skeleton className="h-8 w-16 rounded-xs" />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
