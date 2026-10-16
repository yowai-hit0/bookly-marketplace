import { Check, CircleAlert, Settings as SettingsIcon } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ApiError, UnauthenticatedError } from '@/admin/api'
import {
  FORM_FIELD_FOR,
  SETTINGS_FIELDS,
  type SettingsFormValues,
  settingsApi,
  settingsFormSchema,
  settingsFormValues,
} from '@/admin/settings'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { AdminField } from './AdminField'
import { FIELD, META, PAGE } from './console/classes'
import { Skeleton } from '@/components/ui/skeleton'
import { LoadingRegion, Line as SkeletonLine } from './console/Skeletons'
import { PageHeader } from './console/PageHeader'

/**
 * The five operating values (plan.md Task 8, spec P-30): the booking-fee rate,
 * the minimum notice, how long a hold lasts, the buffer between shoots, and how
 * long a photo link keeps working.
 *
 * The fee is typed as a percentage and stored as a rate, because "37.5%" is how
 * the photographer thinks about it and `0.375` is how the column stores it.
 *
 * A save sends all five. Changing one value does not disturb the others, and
 * nothing already booked moves: a booking snapshots its own fee and buffer when
 * it is created.
 */

export function AdminSettings() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [version, setVersion] = useState(0)
  /** The latest load; `values` is null when it failed. */
  const [loaded, setLoaded] = useState<{ values: SettingsFormValues | null } | null>(null)
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set())
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    settingsApi
      .load()
      .then(({ settings }) => !cancelled && setLoaded({ values: settingsFormValues(settings) }))
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof UnauthenticatedError) {
          navigate('/admin/login', { replace: true })
          return
        }
        setLoaded({ values: null })
      })
    return () => {
      cancelled = true
    }
  }, [version, navigate])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const input = Object.fromEntries(SETTINGS_FIELDS.map((field) => [field, String(data.get(field) ?? '')]))

    setFormError(null)
    setSaved(false)
    const parsed = settingsFormSchema.safeParse(input)
    if (!parsed.success) {
      setInvalid(new Set(parsed.error.issues.map((issue) => String(issue.path[0]))))
      return
    }
    setInvalid(new Set())

    setSaving(true)
    try {
      const { settings } = await settingsApi.save(parsed.data)
      // Redraw from what was stored, not from what was typed.
      setLoaded({ values: settingsFormValues(settings) })
      setSaved(true)
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        navigate('/admin/login', { replace: true })
        return
      }
      const named = error instanceof ApiError ? error.fields.map((field) => FORM_FIELD_FOR[field] ?? field) : []
      if (named.length > 0) setInvalid(new Set(named))
      else setFormError(t('admin:settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const values = loaded?.values ?? null

  return (
    // At 1280x720 and up the whole page fits without scrolling (item 3,
    // 2026-09-27): the five fields sit three to a row from `lg`, in a wider
    // column, so they take two rows instead of three.
    <main className={cn(PAGE, 'max-w-5xl lg:gap-8 lg:py-8')}>
      <PageHeader eyebrow={t('admin:nav.label')} eyebrowIcon={SettingsIcon} title={t('admin:settings.title')}>
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('admin:settings.intro')}</p>
      </PageHeader>

      {loaded === null && (
        <LoadingRegion label={t('admin:settings.loading')} className="flex flex-col gap-6 rounded-xs border p-4 sm:p-6">
          <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            {SETTINGS_FIELDS.map((field) => (
              <div key={field} className="flex flex-col gap-2">
                <SkeletonLine w="w-44" />
                <Skeleton className="h-11 w-full max-w-40 rounded-xs lg:h-10" />
                <SkeletonLine w="w-56 max-w-full" className="h-3" />
              </div>
            ))}
          </div>
          <div className="-mx-4 border-t px-4 pt-4 sm:-mx-6 sm:px-6 sm:pt-6">
            <Skeleton className="h-11 w-full rounded-xs sm:w-36 lg:h-10" />
          </div>
        </LoadingRegion>
      )}
      {loaded !== null && values === null && (
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4" role="alert">
          <p className="text-destructive flex items-start gap-2 text-sm">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('admin:settings.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setVersion((n) => n + 1)}>
            {t('admin:settings.retry')}
          </Button>
        </div>
      )}

      {values !== null && (
        <Card variant="console">
          <CardContent>
            <form
              className="flex flex-col gap-6"
              aria-label={t('admin:settings.title')}
              noValidate
              onSubmit={(event) => void onSubmit(event)}
            >
              <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
                {SETTINGS_FIELDS.map((field) => (
                  <AdminField
                    key={field}
                    label={t(`admin:settings.fields.${field}`)}
                    hint={t(`admin:settings.hints.${field}`)}
                    error={invalid.has(field) ? t(`admin:settings.invalid.${field}`) : null}
                  >
                    {(props) => (
                      <Input
                        {...props}
                        name={field}
                        type="text"
                        inputMode="decimal"
                        // Five short numbers: narrow inside their cell, not
                        // full-bleed, with figures that do not shift as typed.
                        className={cn(FIELD, 'max-w-40 tabular-nums')}
                        // Keyed on the loaded values, so a save redraws the
                        // inputs from what the API stored.
                        key={values[field]}
                        defaultValue={values[field]}
                      />
                    )}
                  </AdminField>
                ))}
              </div>

              {/* The saved line, the error and the button share one region under
                  a hairline, so a confirmation only ever pushes the button down:
                  the fields above never move. */}
              <div className="-mx-(--card-spacing) flex flex-col gap-4 border-t px-(--card-spacing) pt-(--card-spacing)">
                {saved && (
                  <Callout variant="console" tone="success" icon={Check} role="status">
                    {t('admin:settings.saved')}
                  </Callout>
                )}
                {formError !== null && (
                  <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
                    <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    {formError}
                  </p>
                )}

                <Button type="submit" size="console" className="sm:min-w-36 sm:self-start" disabled={saving}>
                  {saving ? t('admin:settings.saving') : t('admin:settings.save')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </main>
  )
}
