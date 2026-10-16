import { CircleAlert, TriangleAlert } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ApiError, UnauthenticatedError } from '@/admin/api'
import {
  type BlockFormValues,
  type BlockPayload,
  type OverlappingBooking,
  blockFormSchema,
  overlappingBookingsOf,
} from '@/admin/availability'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatDateTime, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminField } from './AdminField'
import { CHOICE, EYEBROW, FIELD, SUBPANEL, TEXTAREA } from './console/classes'
import { useInDialog } from './console/in-dialog'

/**
 * Creating or editing one block (plan.md Task 8, spec §3.3 step 3, §6.4). The
 * availability page and the calendar both open this, so a block is described
 * one way wherever it is made.
 *
 * Whole days and part of a day are one form with two shapes rather than two
 * forms, because the choice is a property of the block, not a different task.
 *
 * Spec §6.4: a block never silently cancels a paid booking. When the API
 * answers 409 it names the confirmed bookings the block would cover, and this
 * shows them and asks. Saying yes resends the same payload with `confirm`, and
 * those bookings stay booked and become calendar conflicts.
 */

type Props = {
  title: string
  submitLabel: string
  values: BlockFormValues
  /** Throws `ApiError` when the API refuses the save. */
  onSave: (payload: BlockPayload) => Promise<void>
  onCancel: () => void
}

/** The API names the stored instant; the form names the date and time he types. */
const FORM_FIELD_FOR: Record<string, string> = { startsAt: 'startTime', endsAt: 'endTime' }

export function BlockForm({ title, submitLabel, values, onSave, onCancel }: Props) {
  const { t } = useTranslation()
  const inDialog = useInDialog()
  const navigate = useNavigate()
  const [mode, setMode] = useState(values.mode)
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set())
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** The 409's bookings and the payload that caused it, held for "Block anyway". */
  const [overlap, setOverlap] = useState<{ bookings: OverlappingBooking[]; payload: BlockPayload } | null>(null)

  async function save(payload: BlockPayload) {
    setSaving(true)
    try {
      await onSave(payload)
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        navigate('/admin/login', { replace: true })
        return
      }
      const bookings = overlappingBookingsOf(error)
      if (bookings !== null) {
        setOverlap({ bookings, payload })
        return
      }
      const named = error instanceof ApiError ? error.fields.map((field) => FORM_FIELD_FOR[field] ?? field) : []
      if (named.length > 0) setInvalid(new Set(named))
      else setFormError(t('admin:availability.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const read = (name: string) => String(data.get(name) ?? '')

    setFormError(null)
    setOverlap(null)
    const parsed = blockFormSchema.safeParse({
      mode,
      startDate: read('startDate'),
      endDate: read('endDate'),
      date: read('date'),
      startTime: read('startTime'),
      endTime: read('endTime'),
      reason: read('reason'),
    })
    if (!parsed.success) {
      setInvalid(new Set(parsed.error.issues.map((issue) => String(issue.path[0]))))
      return
    }
    setInvalid(new Set())
    void save(parsed.data)
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
        <legend className={cn(EYEBROW, 'mb-1')}>{t('admin:availability.fields.mode')}</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          {(['all-day', 'time-range'] as const).map((option) => (
            <Label key={option} className="min-h-11 items-center gap-2.5 text-base font-normal lg:min-h-8">
              <input
                type="radio"
                name="mode"
                value={option}
                checked={mode === option}
                onChange={() => setMode(option)}
                className={CHOICE}
              />
              {t(option === 'all-day' ? 'admin:availability.fields.modeAllDay' : 'admin:availability.fields.modeTimeRange')}
            </Label>
          ))}
        </div>
      </fieldset>

      {mode === 'all-day' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <AdminField label={t('admin:availability.fields.startDate')} error={errorFor('startDate')}>
            {(props) => <Input {...props} className={FIELD} name="startDate" type="date" defaultValue={values.startDate} />}
          </AdminField>
          <AdminField
            label={t('admin:availability.fields.endDate')}
            hint={t('admin:availability.hints.endDate')}
            error={errorFor('endDate')}
          >
            {(props) => <Input {...props} className={FIELD} name="endDate" type="date" defaultValue={values.endDate} />}
          </AdminField>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <AdminField label={t('admin:availability.fields.date')} error={errorFor('date')}>
            {(props) => <Input {...props} className={FIELD} name="date" type="date" defaultValue={values.date} />}
          </AdminField>
          <AdminField label={t('admin:availability.fields.startTime')} error={errorFor('startTime')}>
            {(props) => <Input {...props} className={FIELD} name="startTime" type="time" defaultValue={values.startTime} />}
          </AdminField>
          <AdminField label={t('admin:availability.fields.endTime')} error={errorFor('endTime')}>
            {(props) => <Input {...props} className={FIELD} name="endTime" type="time" defaultValue={values.endTime} />}
          </AdminField>
        </div>
      )}

      <AdminField
        label={t('admin:availability.fields.reason')}
        hint={t('admin:availability.hints.reason')}
        error={errorFor('reason')}
      >
        {(props) => <Textarea {...props} className={TEXTAREA} name="reason" defaultValue={values.reason} />}
      </AdminField>

      {overlap !== null && (
        // The page's one destructive-consequence moment (pages/availability.md):
        // the console's danger tint with a full danger edge, so it outranks
        // every other box on the page.
        <div className="border-destructive bg-console-danger-tint flex flex-col gap-3 rounded-xs border p-4" role="alert">
          <p className="flex items-center gap-2.5 text-base font-medium">
            <TriangleAlert aria-hidden="true" className="text-destructive size-4.5 shrink-0" />
            {t('admin:availability.blocks.overlapTitle', { count: overlap.bookings.length })}
          </p>
          <ul className="flex flex-col gap-1.5 font-mono text-[0.8125rem] tabular-nums">
            {overlap.bookings.map((booking) => (
              <li key={booking.id}>
                {booking.reference} · {booking.contactName} · {formatDateTime(booking.startsAt)} to{' '}
                {formatTime(booking.endsAt)}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-sm">{t('admin:availability.blocks.overlapBody')}</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {/* Irreversible, so it is the solid red variant (MASTER section 6). */}
            <Button
              type="button"
              variant="console-destructive-solid"
              size="console"
              disabled={saving}
              onClick={() => void save({ ...overlap.payload, confirm: true })}
            >
              {saving ? t('admin:availability.blocks.overlapSaving') : t('admin:availability.blocks.overlapConfirm')}
            </Button>
            <Button type="button" variant="console-outline" size="console" onClick={() => setOverlap(null)}>
              {t('admin:availability.blocks.overlapCancel')}
            </Button>
          </div>
        </div>
      )}

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
