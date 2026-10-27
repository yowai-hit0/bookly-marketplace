import { CircleAlert } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { fieldError, fieldLabel } from './SelectField'

/**
 * One labelled field on a client form (`client-front.md` §5.4): the 14px
 * label above, the 13px muted hint below, then the 13px danger error with its
 * icon. The control is a render prop handed its id and its ARIA wiring, so a
 * field can never be labelled or described by hand and get it wrong: the hint
 * and the error are both named by `aria-describedby`.
 *
 * The client's own copy of the admin's `AdminField` pattern, so no client
 * page imports from `pages/admin/`.
 */

export type FieldControlProps = {
  id: string
  'aria-invalid'?: true
  'aria-describedby'?: string
}

export function ClientField({
  label,
  hint,
  error = null,
  className,
  children,
}: {
  label: string
  hint?: ReactNode
  /** The message to show, or null when the field is fine. */
  error?: string | null
  className?: string
  children: (props: FieldControlProps) => ReactNode
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [hint === undefined ? null : hintId, error === null ? null : errorId].filter(Boolean).join(' ')

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={id} className={fieldLabel}>
        {label}
      </Label>
      {children({
        id,
        ...(error === null ? {} : { 'aria-invalid': true as const }),
        ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }),
      })}
      {hint !== undefined && (
        <p id={hintId} className="text-muted-foreground text-[0.8125rem] leading-snug wrap-anywhere">
          {hint}
        </p>
      )}
      {error !== null && (
        <p id={errorId} className={fieldError}>
          <CircleAlert aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}
