import { Check, CircleAlert, Info, SlidersHorizontal, TriangleAlert } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminField } from '@/pages/admin/AdminField'
import { EYEBROW, FIELD, META, PAGE } from '@/pages/admin/console/classes'
import { PageHeader } from '@/pages/admin/console/PageHeader'
import { Line, LoadingRegion } from '@/pages/admin/console/Skeletons'
import {
  NUMBER_FIELDS,
  PLACEHOLDER_PRICES,
  type PlatformSettings as Settings,
  type SettingsField,
  type SettingsFormValues,
  type SettingsProblem,
  changedSettings,
  hasPlaceholderPrices,
  parseSettingsForm,
  platformSettingsApi,
  problemsFromFields,
  settingsFormValues,
} from '@/platform/settings'

/**
 * `/platform/settings` (marketplace spec Phase 5: R5.1, R5.4, R9.3): the values
 * the platform runs on -- how long a checkout holds its time, the free trial a
 * newly approved photographer starts with, the plan's monthly and yearly
 * prices, the grace days after a period ends and the reminder days before it.
 *
 * Every field is checked against the API's own bounds before anything is
 * sent, and a save sends only the fields that changed. What the API refuses
 * (`422 fields`) is worded under the field it names; a reminder day is named
 * by its position and the value at it. The page redraws from what the API
 * stored, never from what was typed.
 *
 * The prices the seed writes are placeholders (marketplace spec Phase 5, as
 * built): while either still holds its placeholder, the page says to set the
 * real prices before launch.
 */

type Loaded = { attempt: number; settings: Settings | null }

const GROUPS: { key: 'checkout' | 'subscription'; fields: SettingsField[] }[] = [
  { key: 'checkout', fields: ['holdMinutes'] },
  {
    key: 'subscription',
    fields: ['trialDays', 'subscriptionMonthlyPriceRwf', 'subscriptionYearlyPriceRwf', 'subscriptionGraceDays', 'subscriptionReminderDays'],
  },
]

export function PlatformSettings() {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [problems, setProblems] = useState<SettingsProblem[]>([])
  const [notice, setNotice] = useState<'saved' | 'unchanged' | null>(null)
  const [formError, setFormError] = useState<'saveFailed' | 'badRequest' | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    platformSettingsApi.load().then(
      (settings) => !cancelled && setLoaded({ attempt, settings }),
      (error: unknown) => {
        // A 401 has dropped the platform session; the route's guard sends him to sign in.
        if (cancelled || error instanceof UnauthenticatedError) return
        setLoaded({ attempt, settings: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  const current = loaded !== null && loaded.attempt === attempt ? loaded : null
  const stored = current?.settings ?? null

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || stored === null) return
    const data = new FormData(event.currentTarget)
    const values = Object.fromEntries(
      [...NUMBER_FIELDS, 'subscriptionReminderDays'].map((field) => [field, String(data.get(field) ?? '')]),
    ) as SettingsFormValues

    setNotice(null)
    setFormError(null)
    const parsed = parseSettingsForm(values)
    if (!parsed.ok) {
      setProblems(parsed.problems)
      return
    }
    setProblems([])

    const update = changedSettings(stored, parsed.settings)
    if (Object.keys(update).length === 0) {
      setNotice('unchanged')
      return
    }

    setSaving(true)
    try {
      const settings = await platformSettingsApi.save(update)
      // Redraw from what was stored, not from what was typed.
      setLoaded({ attempt, settings })
      setNotice('saved')
    } catch (error) {
      if (error instanceof UnauthenticatedError) return
      if (error instanceof ApiError && error.status === 400) {
        setFormError('badRequest')
        return
      }
      const named = error instanceof ApiError && error.status === 422 ? problemsFromFields(error.fields, update) : []
      if (named.length > 0) setProblems(named)
      else setFormError('saveFailed')
    } finally {
      setSaving(false)
    }
  }

  /** The words under one field: each of its problems, in order. */
  function errorFor(field: SettingsField): string | null {
    const mine = problems.filter((problem) => problem.field === field)
    if (mine.length === 0) return null
    return mine
      .map((problem) =>
        'index' in problem
          ? t('platform:settings.invalid.reminderDay', { position: problem.index + 1, value: problem.value })
          : t(`platform:settings.invalid.${field}`),
      )
      .join(' ')
  }

  return (
    <main className={cn(PAGE, 'max-w-4xl')}>
      <PageHeader eyebrow={t('platform:nav.label')} eyebrowIcon={SlidersHorizontal} title={t('platform:settings.title')}>
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('platform:settings.intro')}</p>
      </PageHeader>

      {current === null && (
        <LoadingRegion label={t('platform:settings.loading')} className="flex flex-col gap-6 rounded-xs border p-4 sm:p-6">
          <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="flex flex-col gap-2">
                <Line w="w-44" />
                <Skeleton className="h-11 w-full max-w-48 rounded-xs lg:h-10" />
                <Line w="w-56 max-w-full" className="h-3" />
              </div>
            ))}
          </div>
        </LoadingRegion>
      )}

      {current !== null && stored === null && (
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4" role="alert">
          <p className="text-destructive flex items-start gap-2 text-sm">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:settings.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('platform:settings.retry')}
          </Button>
        </div>
      )}

      {stored !== null && (
        <SettingsForm
          // Keyed on what is stored, so a save redraws every input from the API's answer.
          key={JSON.stringify(stored)}
          stored={stored}
          saving={saving}
          errorFor={errorFor}
          notice={notice}
          formError={formError}
          onSubmit={(event) => void onSubmit(event)}
        />
      )}
    </main>
  )
}

function SettingsForm({
  stored,
  saving,
  errorFor,
  notice,
  formError,
  onSubmit,
}: {
  stored: Settings
  saving: boolean
  errorFor: (field: SettingsField) => string | null
  notice: 'saved' | 'unchanged' | null
  formError: 'saveFailed' | 'badRequest' | null
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const { t } = useTranslation()
  const values = settingsFormValues(stored)

  return (
    <form className="flex flex-col gap-8 rounded-xs border p-4 sm:p-6" aria-label={t('platform:settings.title')} noValidate onSubmit={onSubmit}>
      {GROUPS.map((group) => (
        <fieldset key={group.key} className="flex flex-col gap-5">
          <legend className={cn(EYEBROW, 'mb-4')}>{t(`platform:settings.groups.${group.key}`)}</legend>
          {group.key === 'subscription' && hasPlaceholderPrices(stored) && (
            <Callout variant="console" tone="warning" icon={TriangleAlert} data-placeholder-prices="">
              <p>
                {t('platform:settings.placeholder', {
                  monthly: formatMoney(PLACEHOLDER_PRICES.monthly),
                  yearly: formatMoney(PLACEHOLDER_PRICES.yearly),
                })}
              </p>
            </Callout>
          )}
          <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
            {group.fields.map((field) => (
              <AdminField
                key={field}
                label={t(`platform:settings.fields.${field}`)}
                hint={t(`platform:settings.hints.${field}`)}
                error={errorFor(field)}
                className={field === 'subscriptionReminderDays' ? 'sm:col-span-2' : undefined}
              >
                {(props) => (
                  <Input
                    {...props}
                    name={field}
                    type="text"
                    inputMode={field === 'subscriptionReminderDays' ? 'text' : 'numeric'}
                    className={cn(FIELD, 'tabular-nums', field === 'subscriptionReminderDays' ? 'max-w-sm' : 'max-w-48')}
                    defaultValue={values[field]}
                  />
                )}
              </AdminField>
            ))}
          </div>
        </fieldset>
      ))}

      <div className="-mx-4 flex flex-col gap-4 border-t px-4 pt-4 sm:-mx-6 sm:px-6 sm:pt-6">
        {notice === 'saved' && (
          <Callout variant="console" tone="success" icon={Check} role="status">
            {t('platform:settings.saved')}
          </Callout>
        )}
        {notice === 'unchanged' && (
          <Callout variant="console" tone="info" icon={Info} role="status">
            {t('platform:settings.unchanged')}
          </Callout>
        )}
        {formError !== null && (
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t(`platform:settings.${formError}`)}
          </p>
        )}
        <Button type="submit" size="console" className="sm:min-w-36 sm:self-start" disabled={saving}>
          {saving ? t('platform:settings.saving') : t('platform:settings.save')}
        </Button>
      </div>
    </form>
  )
}
