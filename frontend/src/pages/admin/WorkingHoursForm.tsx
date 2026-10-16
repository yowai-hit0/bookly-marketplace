import { CircleAlert } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ApiError, UnauthenticatedError } from '@/admin/api'
import {
  WEEKDAY_ORDER,
  type WorkingHoursFormValues,
  type WorkingHoursPayload,
  workingHoursFormSchema,
} from '@/admin/availability'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { AdminField, SELECT_CLASS } from './AdminField'
import { CHECKBOX, CHOICE, EYEBROW, FIELD, SUBPANEL, TEXTAREA } from './console/classes'
import { useInDialog } from './console/in-dialog'

/**
 * One working-hours row: a weekly rule, or one date that differs from it
 * (plan.md Task 8, spec §3.3, §6.3).
 *
 * The two are one form with one key between them, because the API takes a
 * union of strict objects: sending both a weekday and a date is a malformed
 * request, not a choice it resolves. A closed day keeps no window at all, so
 * the times disappear rather than sitting there greyed out and meaningless.
 */

type Props = {
  title: string
  submitLabel: string
  values: WorkingHoursFormValues
  /** Throws `ApiError` when the API refuses the save. */
  onSave: (payload: WorkingHoursPayload) => Promise<void>
  onCancel: () => void
}

export function WorkingHoursForm({ title, submitLabel, values, onSave, onCancel }: Props) {
  const { t } = useTranslation()
  const inDialog = useInDialog()
  const navigate = useNavigate()
  const openId = useId()
  const [kind, setKind] = useState(values.kind)
  const [isOpen, setIsOpen] = useState(values.isOpen)
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set())
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const read = (name: string) => String(data.get(name) ?? '')

    setFormError(null)
    const parsed = workingHoursFormSchema.safeParse({
      kind,
      weekday: read('weekday'),
      effectiveDate: read('effectiveDate'),
      isOpen,
      opens: read('opens'),
      closes: read('closes'),
      note: read('note'),
    })
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
      if (error instanceof ApiError && error.message === 'working_hours_exists') {
        setFormError(t('admin:availability.hours.exists'))
      } else if (error instanceof ApiError && error.fields.length > 0) {
        setInvalid(new Set(error.fields.map((field) => (field === 'closesMinute' ? 'closes' : field))))
      } else {
        setFormError(t('admin:availability.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  const errorFor = (field: string) => (invalid.has(field) ? t(`admin:availability.invalid.${field}`) : null)

  return (
    <form
      className={inDialog ? 'flex flex-col gap-4' : SUBPANEL}
      aria-label={title}
      noValidate
      onSubmit={onSubmit}
    >
      {/* In a dialog the dialog's own title names the form. */}
      {!inDialog && <h3 className="text-base font-medium">{title}</h3>}

      <fieldset className="flex flex-col gap-2">
        <legend className={cn(EYEBROW, 'mb-1')}>{t('admin:availability.fields.kind')}</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          {(['weekday', 'date'] as const).map((option) => (
            <Label key={option} className="min-h-11 items-center gap-2.5 text-base font-normal lg:min-h-8">
              <input
                type="radio"
                name="kind"
                value={option}
                checked={kind === option}
                onChange={() => setKind(option)}
                className={CHOICE}
              />
              {t(option === 'weekday' ? 'admin:availability.fields.kindWeekday' : 'admin:availability.fields.kindDate')}
            </Label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        {kind === 'weekday' ? (
          <AdminField label={t('admin:availability.fields.weekday')} error={errorFor('weekday')}>
            {(props) => (
              <select {...props} name="weekday" defaultValue={values.weekday} className={SELECT_CLASS}>
                {WEEKDAY_ORDER.map((day) => (
                  <option key={day} value={day}>
                    {t(`admin:availability.weekdays.${day}`)}
                  </option>
                ))}
              </select>
            )}
          </AdminField>
        ) : (
          <AdminField label={t('admin:availability.fields.effectiveDate')} error={errorFor('effectiveDate')}>
            {(props) => <Input {...props} className={FIELD} name="effectiveDate" type="date" defaultValue={values.effectiveDate} />}
          </AdminField>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex min-h-11 items-center gap-2.5 lg:min-h-8">
          <Checkbox id={openId} className={CHECKBOX} checked={isOpen} onCheckedChange={(checked) => setIsOpen(checked === true)} />
          <Label htmlFor={openId}>{t('admin:availability.fields.isOpen')}</Label>
        </div>
        <p className="text-muted-foreground text-[0.8125rem] leading-snug">{t('admin:availability.hints.isOpen')}</p>
      </div>

      {isOpen && (
        <div className="grid gap-4 sm:grid-cols-2">
          <AdminField label={t('admin:availability.fields.opens')} error={errorFor('opens')}>
            {(props) => <Input {...props} className={FIELD} name="opens" type="time" defaultValue={values.opens} />}
          </AdminField>
          <AdminField label={t('admin:availability.fields.closes')} error={errorFor('closes')}>
            {(props) => <Input {...props} className={FIELD} name="closes" type="time" defaultValue={values.closes} />}
          </AdminField>
        </div>
      )}

      <AdminField
        label={t('admin:availability.fields.note')}
        hint={t('admin:availability.hints.note')}
        error={errorFor('note')}
      >
        {(props) => <Textarea {...props} className={TEXTAREA} name="note" defaultValue={values.note} />}
      </AdminField>

      {formError !== null && (
        <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {formError}
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <Button type="submit" size="console" disabled={saving}>
          {saving ? t('admin:availability.saving') : submitLabel}
        </Button>
        <Button type="button" variant="console-outline" size="console" onClick={onCancel}>
          {t('admin:availability.cancel')}
        </Button>
      </div>
    </form>
  )
}
