import { Check, CircleAlert, Clock } from 'lucide-react'
import type { TFunction } from 'i18next'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { type PublicServiceDetail, fetchService } from '@/catalogue/api'
import {
  DETAIL_FIELDS,
  type DetailField,
  type HeldBooking,
  parseBookingDetails,
  submitBooking,
} from '@/catalogue/bookings'
import { BackLink } from '@/components/ui/back-link'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { SelectableCard } from '@/components/ui/selectable-card'
import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { container, eyebrow, pageTitle, pageY, panelTitle } from '@/pages/client/classes'
import { NotFound } from '@/pages/NotFound'
import { BookingDetailsForm } from './BookingDetailsForm'
import { BookingHeld } from './BookingHeld'
import { PriceSummary } from './PriceSummary'
import { SlotPicker, type SlotPickerHandle } from './SlotPicker'
import { stepNumber } from './step-number'

/**
 * One service's packages and add-ons, with a total that updates as they are
 * chosen (plan.md Task 11, spec §3.1 steps 2, 3 and 7; restyled per
 * design-system/bookly/client-front.md §8.3, the board's booking components).
 *
 * An unknown or deactivated slug is the not-found page: the API answers 404
 * for both, so a retired service does not exist to the public (spec §6.14).
 * Nothing is preselected -- the visitor picks the package they are buying.
 * Once a package is chosen, the slot picker offers its bookable starts
 * (plan.md Task 12), and the booking form below it creates the booking once a
 * start is chosen (Task 13); the page then becomes the held booking's summary.
 */

type Loaded =
  | { slug: string; status: 'ok'; service: PublicServiceDetail }
  | { slug: string; status: 'missing' }
  | { slug: string; status: 'failed' }

export function ServiceDetail() {
  const { t } = useTranslation()
  const { slug = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchService(slug, controller.signal)
      .then((service) => {
        if (controller.signal.aborted) return
        setLoaded(service === null ? { slug, status: 'missing' } : { slug, status: 'ok', service })
      })
      .catch(() => !controller.signal.aborted && setLoaded({ slug, status: 'failed' }))
    return () => controller.abort()
  }, [slug, attempt])

  function retry() {
    setLoaded(null)
    setAttempt((n) => n + 1)
  }

  // A load for another slug is stale: moving between services shows loading,
  // not the previous service.
  const current = loaded?.slug === slug ? loaded : null

  if (current?.status === 'missing') return <NotFound />
  if (current?.status === 'ok') return <ServiceView key={current.service.id} service={current.service} />

  return (
    <main className={cn(container, pageY, 'flex flex-col gap-6')}>
      <AllServicesLink />
      {current === null ? (
        <p className="text-subtle-foreground text-sm" role="status">
          {t('services:loading')}
        </p>
      ) : (
        <Callout
          variant="console"
          tone="destructive"
          icon={CircleAlert}
          role="alert"
          action={
            <Button variant="outline" size="sm" onClick={retry}>
              {t('services:retry')}
            </Button>
          }
        >
          <p>{t('services:loadServiceFailed')}</p>
        </Callout>
      )}
    </main>
  )
}

function ServiceView({ service }: { service: PublicServiceDetail }) {
  const { t } = useTranslation()
  const [packageId, setPackageId] = useState<string | null>(null)
  const [addonIds, setAddonIds] = useState<ReadonlySet<string>>(new Set())
  /** The chosen start, an ISO instant, confirmed free by the API when chosen. */
  const [startsAt, setStartsAt] = useState<string | null>(null)
  const formId = useId()
  const picker = useRef<SlotPickerHandle>(null)
  const [invalid, setInvalid] = useState<ReadonlySet<DetailField>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<'failed' | 'catalogueChanged' | null>(null)
  /** The booking the API created; the page becomes its confirmation. */
  const [held, setHeld] = useState<HeldBooking | null>(null)

  const chosenPackage = service.packages.find((pkg) => pkg.id === packageId) ?? null
  // Catalogue order, whatever order they were ticked in.
  const chosenAddons = service.addons.filter((addon) => addonIds.has(addon.id))

  /**
   * Creates the booking (plan.md Task 13). The form's own check runs first as a
   * convenience; the API's answer is what counts. A start the API refuses --
   * taken in a race (409), or no longer offered (422 on `startsAt`) -- is the
   * picker's "just taken" state with a refreshed calendar, never a dead end
   * (spec §6.1). What the visitor typed stays in the form either way.
   */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    if (submitting || chosenPackage === null || startsAt === null) return
    setSubmitError(null)

    const parsed = parseBookingDetails(new FormData(form))
    if (!parsed.ok) {
      markInvalid(form, parsed.fields)
      return
    }
    setInvalid(new Set())

    setSubmitting(true)
    const result = await submitBooking({
      packageId: chosenPackage.id,
      addonIds: chosenAddons.map((addon) => addon.id),
      startsAt,
      ...parsed.details,
    })
    setSubmitting(false)

    if (result.status === 'created') {
      setHeld(result.booking)
      return
    }
    if (result.status === 'failed') {
      setSubmitError('failed')
      return
    }

    const fields: readonly string[] = result.status === 'slot_taken' ? ['startsAt'] : result.fields
    const details = DETAIL_FIELDS.filter((field) => fields.includes(field))
    const catalogueChanged = fields.includes('packageId') || fields.includes('addonIds')
    if (catalogueChanged) setSubmitError('catalogueChanged')
    if (details.length > 0) markInvalid(form, details)
    if (fields.includes('startsAt')) picker.current?.reportTaken(startsAt)
    if (!catalogueChanged && details.length === 0 && !fields.includes('startsAt')) setSubmitError('failed')
  }

  function markInvalid(form: HTMLFormElement, fields: readonly DetailField[]) {
    setInvalid(new Set(fields))
    const first = fields[0] === undefined ? null : form.elements.namedItem(fields[0])
    if (first instanceof HTMLElement) first.focus()
  }

  function toggleAddon(id: string, checked: boolean) {
    setAddonIds((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  if (held !== null) {
    return (
      <main className={cn(container, pageY, 'flex flex-col gap-6')}>
        <BookingHeld booking={held} />
      </main>
    )
  }

  return (
    <main className={cn(container, pageY, 'flex flex-col gap-8')}>
      <AllServicesLink />
      <header className="flex flex-col gap-4">
        {service.coverImageUrl !== null && (
          <img
            src={service.coverImageUrl}
            alt=""
            className="bg-muted aspect-21/9 w-full rounded-xs object-cover"
            fetchPriority="high"
          />
        )}
        <div className="flex flex-col gap-3">
          <h1 className={pageTitle}>{service.nameEn}</h1>
          {service.descriptionEn !== null && (
            <p className="text-subtle-foreground max-w-2xl whitespace-pre-line">{service.descriptionEn}</p>
          )}
          <p className={eyebrow}>
            <Clock aria-hidden="true" />
            {t('services:picker.kigaliTime')}
          </p>
        </div>
      </header>

      {service.packages.length === 0 ? (
        <p className="text-subtle-foreground">{t('services:noPackages')}</p>
      ) : (
        <div className="grid gap-10 lg:grid-cols-[1fr_22.5rem] lg:items-start">
          {/* The counter numbers the three groups: choose, pick a time, your details (step-number.ts). */}
          <div className="flex flex-col gap-8 [counter-reset:step]">
            {/* The add-ons belong to the package step, so they sit closer to the packages than the steps sit to each other. */}
            <div className="flex flex-col gap-5">
              <fieldset className="flex flex-col gap-3">
                <legend className={cn(panelTitle, stepNumber)}>{t('services:choosePackage')}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {service.packages.map((pkg) => (
                    <SelectableCard key={pkg.id} className="group relative flex-col items-stretch gap-3 p-4.5">
                      <span className="flex items-start justify-between gap-3">
                        <span className="text-[1.125rem] font-medium">{pkg.nameEn}</span>
                        <span
                          aria-hidden="true"
                          className="bg-brand text-brand-foreground flex size-6 shrink-0 scale-40 items-center justify-center opacity-0 motion-safe:transition motion-safe:duration-250 motion-safe:ease-[cubic-bezier(0.2,0.7,0.2,1.4)] group-has-checked:scale-100 group-has-checked:opacity-100"
                        >
                          <Check strokeWidth={2.75} className="size-3.5" />
                        </span>
                      </span>
                      <span className="text-subtle-foreground flex-1 text-sm">
                        {t('services:photos', { count: pkg.photoCount })} · {formatDuration(t, pkg.durationMinutes)}
                      </span>
                      {pkg.descriptionEn !== null && (
                        <span className="text-subtle-foreground text-sm whitespace-pre-line">{pkg.descriptionEn}</span>
                      )}
                      <span className="font-mono text-base font-medium">{formatMoney(pkg.priceRwf)}</span>
                      {/* Last in the DOM (not `sr-only`) and stretched over the whole card: a
                          clipped-to-1px hidden input's hit point lands on the visible content
                          above it, which Playwright's mouse click cannot get past (real touch/
                          click still reaches it via native label delegation either way, but the
                          e2e suite drives this with real coordinates too). Invisible, not removed
                          from hit-testing -- the name, price and tick still carry the meaning. */}
                      <input
                        type="radio"
                        name="package"
                        value={pkg.id}
                        checked={packageId === pkg.id}
                        onChange={() => setPackageId(pkg.id)}
                        data-focus-ring="parent"
                        className="absolute inset-0 cursor-pointer opacity-0"
                      />
                    </SelectableCard>
                  ))}
                </div>
              </fieldset>

              {service.addons.length > 0 && (
                <fieldset className="flex flex-col gap-3">
                  <legend className={panelTitle}>{t('services:chooseAddons')}</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {service.addons.map((addon) => (
                      <SelectableCard key={addon.id} className="group relative items-center gap-3 p-3.5">
                        <span
                          aria-hidden="true"
                          className="border-input group-has-checked:border-brand group-has-checked:bg-brand flex size-5 shrink-0 items-center justify-center border motion-safe:transition-colors motion-safe:duration-150"
                        >
                          <Check
                            strokeWidth={3}
                            className="text-brand-foreground size-3 scale-40 opacity-0 motion-safe:transition motion-safe:duration-250 motion-safe:ease-[cubic-bezier(0.2,0.7,0.2,1.4)] group-has-checked:scale-100 group-has-checked:opacity-100"
                          />
                        </span>
                        <span className="flex-1 text-[0.9375rem]">{addon.nameEn}</span>
                        <span className="text-subtle-foreground font-mono text-sm">{formatMoney(addon.priceRwf)}</span>
                        {/* Stretched and invisible, not `sr-only`: see the note on the package card above. */}
                        <input
                          type="checkbox"
                          checked={addonIds.has(addon.id)}
                          onChange={(event) => toggleAddon(addon.id, event.target.checked)}
                          data-focus-ring="parent"
                          className="absolute inset-0 cursor-pointer opacity-0"
                        />
                      </SelectableCard>
                    ))}
                  </div>
                </fieldset>
              )}
            </div>

            {chosenPackage === null ? (
              <section className="flex flex-col gap-1">
                <h2 className={cn(panelTitle, stepNumber)}>{t('services:picker.title')}</h2>
                <p className="text-subtle-foreground text-sm">{t('services:picker.choosePackageFirst')}</p>
              </section>
            ) : (
              <>
                <SlotPicker
                  ref={picker}
                  packageId={chosenPackage.id}
                  durationMinutes={chosenPackage.durationMinutes}
                  value={startsAt}
                  onChange={setStartsAt}
                />
                <BookingDetailsForm id={formId} invalid={invalid} onSubmit={(event) => void submit(event)} />
              </>
            )}
          </div>

          {/* Below lg it is the last thing on the page, the closing step, so it is spaced like the steps above it. */}
          <div className="max-lg:mt-2 lg:sticky lg:top-6">
            <PriceSummary pkg={chosenPackage} addons={chosenAddons} bookingFeeRate={service.bookingFeeRate}>
              {chosenPackage !== null &&
                (startsAt === null ? (
                  <p className="text-subtle-foreground text-sm">{t('services:booking.chooseTimeFirst')}</p>
                ) : (
                  <Button
                    type="submit"
                    form={formId}
                    className="h-12 w-full"
                    // Not `disabled`: that would drop keyboard focus mid-submit.
                    // `submit` ignores a second press instead.
                    aria-disabled={submitting}
                    aria-busy={submitting}
                  >
                    {t(submitting ? 'services:booking.submitting' : 'services:booking.submit')}
                  </Button>
                ))}
              {/* Outside the start check: a refusal can clear the start and still need saying. */}
              {chosenPackage !== null && submitError !== null && (
                <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
                  <p>{t(`services:booking.${submitError}`)}</p>
                </Callout>
              )}
            </PriceSummary>
          </div>
        </div>
      )}
    </main>
  )
}

function AllServicesLink() {
  const { t } = useTranslation()
  return <BackLink to="/services">{t('services:allServices')}</BackLink>
}

/** `90` → `1 h 30 min`; `120` → `2 hours`; `45` → `45 min`. */
function formatDuration(t: TFunction, minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return t('services:duration.minutes', { count: minutes })
  if (rest === 0) return t('services:duration.hours', { count: hours })
  return t('services:duration.hoursAndMinutes', { hours, minutes: rest })
}
