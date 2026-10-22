import { ChevronDown } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * A native `select` as a client field (`client-front.md` §5.4): square, the
 * `--input` edge (3:1), 44px (48px from `md`, 44px on touch), 16px text, a
 * `--ring` edge and the violet outline on focus, a danger edge when invalid.
 * Native on purpose: keyboard, type-ahead, `optgroup` and the phone's own
 * picker all come for free. The chevron is decoration.
 */
export function SelectField({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <div className={cn('relative min-w-0', className)}>
      <select
        {...props}
        className="border-input bg-background text-foreground hover:border-muted-foreground focus-visible:border-ring aria-invalid:border-destructive h-11 w-full min-w-0 cursor-pointer appearance-none truncate rounded-xs border pr-10 pl-3.5 text-base outline-none md:h-12 pointer-coarse:h-11 motion-safe:transition-[border-color] motion-safe:duration-150"
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="text-muted-foreground pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2"
      />
    </div>
  )
}

/** The sentence under a field that is wrong: danger, 13px, with its icon; linked by `aria-describedby`. */
export const fieldError = 'text-destructive flex items-start gap-1.5 text-[0.8125rem] leading-snug [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0'

/** A field's label: 14px / 500. */
export const fieldLabel = 'text-sm font-medium'
