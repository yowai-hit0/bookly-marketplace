import { CircleAlert } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { z } from 'zod'
import { ApiError, UnauthenticatedError } from '@/admin/api'
import type { FormValues } from '@/admin/catalogue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { CHECKBOX, FIELD, SUBPANEL, TEXTAREA } from './console/classes'
import { useInDialog } from './console/in-dialog'

/**
 * The one form behind every catalogue editor (plan.md Task 10). Inputs are
 * uncontrolled; on submit their strings go through the entity's schema, which
 * marks the wrong fields or produces the API payload. A 422 from the API marks
 * the fields it names, and a taken slug marks the slug.
 */

export type FieldSpec = {
  name: string
  kind: 'text' | 'textarea' | 'number' | 'checkbox'
  /** Renders `admin:catalogue.hints.<name>` under the input. */
  hint?: boolean
}

type Props<T> = {
  title: string
  submitLabel: string
  fields: readonly FieldSpec[]
  values: FormValues
  schema: z.ZodType<T>
  /** Throws `ApiError` when the API refuses the save. */
  onSave: (payload: T) => Promise<void>
  onCancel: () => void
}

/** The API names the stored field; the form names what he types. */
const FORM_FIELD_FOR: Record<string, string> = { bookingFeeRateOverride: 'bookingFeePercent' }

export function EntityForm<T>({ title, submitLabel, fields, values, schema, onSave, onCancel }: Props<T>) {
  const { t } = useTranslation()
  const inDialog = useInDialog()
  const navigate = useNavigate()
  const idPrefix = useId()
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set())
  const [slugTaken, setSlugTaken] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const input = Object.fromEntries(
      fields.map((field) => [
        field.name,
        field.kind === 'checkbox' ? data.get(field.name) === 'on' : String(data.get(field.name) ?? ''),
      ]),
    )

    setSlugTaken(false)
    setFormError(null)
    const parsed = schema.safeParse(input)
    if (!parsed.success) {
      setInvalid(new Set(parsed.error.issues.map((issue) => String(issue.path[0]))))
      return
    }
    setInvalid(new Set())

    setSaving(true)
    try {
      await onSave(parsed.data)
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        navigate('/admin/login', { replace: true })
        return
      }
      const named = error instanceof ApiError ? error.fields.map((f) => FORM_FIELD_FOR[f] ?? f) : []
      if (error instanceof ApiError && error.message === 'slug_taken') {
        setSlugTaken(true)
      } else if (named.length > 0 && named.every((name) => fields.some((field) => field.name === name))) {
        setInvalid(new Set(named))
      } else {
        setFormError(t('admin:catalogue.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className={inDialog ? 'flex flex-col gap-4' : SUBPANEL} aria-label={title} noValidate onSubmit={onSubmit}>
      {/* In a dialog the dialog's own title names the form. */}
      {!inDialog && <h3 className="text-base font-medium">{title}</h3>}
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((field) => {
          const inputId = `${idPrefix}-${field.name}`
          const errorId = `${inputId}-error`
          const showsSlugTaken = field.name === 'slug' && slugTaken
          const isInvalid = invalid.has(field.name) || showsSlugTaken
          const label = t(`admin:catalogue.fields.${field.name}`)

          if (field.kind === 'checkbox') {
            return (
              <div key={field.name} className="flex min-h-11 items-center gap-2.5 sm:col-span-2 lg:min-h-8">
                <Checkbox id={inputId} name={field.name} className={CHECKBOX} defaultChecked={values[field.name] === true} />
                <Label htmlFor={inputId}>{label}</Label>
              </div>
            )
          }

          const inputProps = {
            id: inputId,
            name: field.name,
            defaultValue: String(values[field.name] ?? ''),
            'aria-invalid': isInvalid || undefined,
            'aria-describedby': isInvalid ? errorId : undefined,
          }

          return (
            <div key={field.name} className={cn('flex flex-col gap-2', field.kind === 'textarea' && 'sm:col-span-2')}>
              <Label htmlFor={inputId}>{label}</Label>
              {field.kind === 'textarea' ? (
                <Textarea {...inputProps} className={TEXTAREA} />
              ) : (
                <Input
                  {...inputProps}
                  className={cn(FIELD, field.kind === 'number' && 'tabular-nums')}
                  type="text"
                  inputMode={field.kind === 'number' ? 'numeric' : undefined}
                />
              )}
              {field.hint && (
                <p className="text-muted-foreground text-[0.8125rem] leading-snug">{t(`admin:catalogue.hints.${field.name}`)}</p>
              )}
              {isInvalid && (
                <p id={errorId} className="text-destructive flex items-start gap-1.5 text-[0.8125rem] leading-snug">
                  <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                  <span>
                    {t(showsSlugTaken ? 'admin:catalogue.invalid.slugTaken' : `admin:catalogue.invalid.${field.name}`)}
                  </span>
                </p>
              )}
            </div>
          )
        })}
      </div>
      {formError !== null && (
        <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {formError}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <Button type="submit" size="console" disabled={saving}>
          {saving ? t('admin:catalogue.saving') : submitLabel}
        </Button>
        <Button type="button" variant="console-outline" size="console" onClick={onCancel}>
          {t('admin:catalogue.cancel')}
        </Button>
      </div>
    </form>
  )
}
