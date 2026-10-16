import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Filters joined into one bordered strip (design-system/bookly/admin-console.md
 * 6.5): cells split by the field edge, a flex-1 search cell, 48px tall from
 * `lg`. The controls inside are the page's own, drawn without their own edge
 * (the strip is their boundary, at 3:1), and their focus outline is drawn
 * inside the cell so the strip does not clip it. Below `lg` the cells stack.
 */
export function Toolbar({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'border-input divide-input flex flex-col divide-y rounded-xs border lg:flex-row lg:divide-x lg:divide-y-0',
        '[&_input]:border-0 [&_input]:bg-transparent [&_select]:border-0 [&_select]:bg-transparent',
        '[&_:focus-visible]:outline-offset-[-2px]!',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/** One cell. `grow` takes the free width (the search cell). */
export function ToolbarCell({
  children,
  grow = false,
  className,
}: {
  children: ReactNode
  grow?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-3 px-3 lg:min-h-12', grow && 'lg:flex-1', className)}>{children}</div>
  )
}
