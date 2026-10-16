import { Check, CircleAlert } from 'lucide-react'
import { type FormEvent, useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { DetailField } from '@/catalogue/bookings'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { panelTitle } from '@/pages/client/classes'
import { stepNumber } from './step-number'

/**
 * The booking form (plan.md Task 13, spec §3.1 step 6; restyled per
 * design-system/bookly/client-front.md §5.4 and §8.3): name, email, phone,
 * location, number of people, special requests and consent.
 *
 * Inputs are uncontrolled and the form stays mounted while a package is chosen,
 * so what the visitor typed survives a slot being taken and chosen again. The
 * submit control lives in the price summary, after the non-refundable notice
 * (plan.md Task 11), and reaches this form through its `form` attribute.
 */

type Props = {
  id: string
  /** Fields to mark wrong: the form's own check, or the API's 422. */
  invalid: ReadonlySet<DetailField>
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

type TextField = {
  name: Exclude<DetailField, 'consent'>
  type?: 'email' | 'tel'
  autoComplete?: string
  inputMode?: 'numeric'
  multiline?: boolean
  hint?: boolean
  /** Announced as required; `noValidate` keeps the browser's own bubbles away. */
  required?: boolean
  /** Full width in the two-column grid from `md`: the name and the requests. */
  wide?: boolean
}

const TEXT_FIELDS: readonly TextField[] = [
  { name: 'fullName', autoComplete: 'name', required: true, wide: true },
  { name: 'email', type: 'email', autoComplete: 'email', required: true },
  { name: 'phone', type: 'tel', autoComplete: 'tel', hint: true, required: true },
  { name: 'location', required: true },
  { name: 'partySize', inputMode: 'numeric', hint: true },
  { name: 'specialRequests', multiline: true, hint: true, wide: true },
]

export function BookingDetailsForm({ id, invalid, onSubmit }: Props) {
  const { t } = useTranslation()
  const idPrefix = useId()
  const headingId = `${idPrefix}heading`

  return (
    <form id={id} noValidate onSubmit={onSubmit} aria-labelledby={headingId} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className={cn(panelTitle, stepNumber)}>
          {t('services:booking.title')}
        </h2>
        <p className="text-subtle-foreground text-sm">{t('services:booking.intro')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {TEXT_FIELDS.map((field) => {
          const inputId = `${idPrefix}${field.name}`
          const isInvalid = invalid.has(field.name)
          const describedBy = [field.hint ? `${inputId}-hint` : null, isInvalid ? `${inputId}-error` : null]
            .filter(Boolean)
            .join(' ')
          const common = {
            id: inputId,
            name: field.name,
            required: field.required,
            'aria-invalid': isInvalid || undefined,
            'aria-describedby': describedBy || undefined,
          }
          return (
            <div key={field.name} className={cn('flex flex-col gap-1.5', field.wide && 'md:col-span-2')}>
              <Label htmlFor={inputId} className="text-sm font-medium">
                {t(`services:booking.fields.${field.name}`)}
              </Label>
              {field.multiline ? (
                <Textarea {...common} rows={3} />
              ) : (
                <Input {...common} type={field.type ?? 'text'} autoComplete={field.autoComplete} inputMode={field.inputMode} />
              )}
              {field.hint && (
                <p id={`${inputId}-hint`} className="text-muted-foreground text-[0.8125rem]">
                  {t(`services:booking.hints.${field.name}`)}
                </p>
              )}
              {isInvalid && (
                <p id={`${inputId}-error`} className="text-destructive flex items-center gap-1.5 text-[0.8125rem]">
                  <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                  {t(`services:booking.invalid.${field.name}`)}
                </p>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="group relative flex cursor-pointer items-start gap-3 text-sm pointer-coarse:min-h-11">
          <span
            aria-hidden="true"
            className="border-input group-has-checked:border-brand group-has-checked:bg-brand group-has-focus-visible:outline-ring flex size-5 shrink-0 items-center justify-center border motion-safe:transition-colors motion-safe:duration-150 group-has-focus-visible:outline-2 group-has-focus-visible:outline-offset-2"
          >
            <Check
              aria-hidden="true"
              strokeWidth={3}
              className="text-brand-foreground size-3 scale-40 opacity-0 motion-safe:transition motion-safe:duration-250 motion-safe:ease-[cubic-bezier(0.2,0.7,0.2,1.4)] group-has-checked:scale-100 group-has-checked:opacity-100"
            />
          </span>
          <span>{t('services:booking.consent')}</span>
          {/* Stretched and invisible, not `sr-only`: a clipped-to-1px hidden input's hit
              point can land on the visible content painted above it, which breaks a real
              mouse click (Playwright's e2e suite included) even though native label
              delegation still reaches it. This keeps the input's name, focus and checked
              state; only its hiding technique changed. */}
          <input
            type="checkbox"
            name="consent"
            required
            aria-invalid={invalid.has('consent') || undefined}
            aria-describedby={invalid.has('consent') ? `${idPrefix}consent-error` : undefined}
            data-focus-ring="parent"
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        {invalid.has('consent') && (
          <p id={`${idPrefix}consent-error`} className="text-destructive flex items-center gap-1.5 text-[0.8125rem]">
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            {t('services:booking.invalid.consent')}
          </p>
        )}
      </div>
    </form>
  )
}
