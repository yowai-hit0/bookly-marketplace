import { ArrowRight, Camera, Check, CircleAlert, Clock, UserRound } from 'lucide-react'
import type { TFunction } from 'i18next'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'
import {
  type PublicPhotographerProfile,
  type PublicServiceDetail,
  fetchPhotographer,
  fetchService,
  photographerPath,
} from '@/catalogue/api'
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
import { excerpt, useDocumentMeta } from '@/lib/document-meta'
import { formatMoney } from '@/lib/format'
import { safeHttpsUrl } from '@/lib/safe-url'
import { cn } from '@/lib/utils'
import { container, eyebrow, pageTitle, pageY, panel, panelTitle } from '@/pages/client/classes'
import { NotFound } from '@/pages/NotFound'
import { NotTakingBookingsNotice, PhotographerUnavailable } from '@/pages/photographers/notices'
import { ContactList } from '@/pages/photographers/PhotographerContact'
import { BookingDetailsForm } from './BookingDetailsForm'
import { BookingHeld } from './BookingHeld'
import { PriceSummary } from './PriceSummary'
import { SlotPicker, type SlotPickerHandle } from './SlotPicker'
import { stepNumber } from './step-number'

/**
 * One service's packages and add-ons, with a total that updates as they are
 * chosen (plan.md Task 11, spec §3.1 steps 2, 3 and 7; restyled per
 * design-system/bookly/client-front.md §8.3, the board's booking components).
 * It lives at `/p/:handle/:slug`, under the photographer who sells it
 * (marketplace brief decision 9).
 *
 * An unknown or deactivated slug is the not-found page: the API answers 404
 * for both, so a retired service does not exist to the public (spec §6.14).
 * A photographer the API does not serve (an unknown handle, or one not listed)
 * is the "unavailable" page instead (marketplace spec R5.5): the profile's 404
 * tells the two apart. A photographer who is listed but not taking bookings
 * (`takingBookings: false`, a past-due subscription) keeps the packages and
 * the prices on screen, with a notice in place of the slot picker and the
 * booking form. If that happens while the page is open, the API refuses the
 * package (`422 packageId`) on the calendar or the booking: the page reads the
 * profile again, and shows the same notice when it says so. The
 * photographer's profile is read alongside the service for their name and
 * their cancellation policy, which the summary and the held booking state
 * before anything is paid (R1.8).
 * Nothing is preselected -- the visitor picks the package they are buying.
 * Once a package is chosen, the slot picker offers its bookable starts
 * (plan.md Task 12), and the booking form below it creates the booking once a
 * start is chosen (Task 13); the page then becomes the held booking's summary.
 */

type Loaded = { key: string } & (
  | { status: 'ok'; photographer: PublicPhotographerProfile; service: PublicServiceDetail }
  | { status: 'missing' }
  /** The photographer is not served at all: unknown, or not listed. */
  | { status: 'unavailable' }
  | { status: 'failed' }
)

export function ServiceDetail() {
  const { t } = useTranslation()
  const { handle = '', slug = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${handle}/${slug}`

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([fetchPhotographer(handle, controller.signal), fetchService(handle, slug, controller.signal)])
      .then(([photographer, service]) => {
        if (controller.signal.aborted) return
        setLoaded(
          photographer === null
            ? { key, status: 'unavailable' }
            : service === null
              ? { key, status: 'missing' }
              : { key, status: 'ok', photographer, service },
        )
      })
      .catch(() => !controller.signal.aborted && setLoaded({ key, status: 'failed' }))
    return () => controller.abort()
  }, [handle, slug, key, attempt])

  function retry() {
    setLoaded(null)
    setAttempt((n) => n + 1)
  }

  // A load for another service is stale: moving between services shows
  // loading, not the previous service.
  const current = loaded?.key === key ? loaded : null

  if (current?.status === 'unavailable') return <PhotographerUnavailable />
  if (current?.status === 'missing') return <NotFound />
  if (current?.status === 'ok') {
    return <ServiceView key={current.service.id} handle={handle} photographer={current.photographer} service={current.service} />
  }

  return (
    <main className={cn(container, pageY, 'flex flex-col gap-6')}>
      <AllServicesLink handle={handle} />
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

type ViewProps = {
  handle: string
  photographer: PublicPhotographerProfile
  service: PublicServiceDetail
}

function ServiceView({ handle, photographer, service }: ViewProps) {
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
  /** Learned after the page loaded: the API refused the package, and the profile says no bookings now. */
  const [stopped, setStopped] = useState(false)
  const takingBookings = !stopped && photographer.takingBookings !== false && service.takingBookings !== false

  const cover = safeHttpsUrl(service.coverImageUrl)
  useDocumentMeta({
    title: t('meta:titleSuffix', { title: t('meta:service.title', { service: service.nameEn, name: photographer.displayName }) }),
    description: service.descriptionEn?.trim()
      ? excerpt(service.descriptionEn)
      : t('meta:service.description', { service: service.nameEn, name: photographer.displayName }),
    image: cover ?? photographer.coverImageUrl,
  })

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
    if (fields.includes('packageId') && (await recheckPhotographer())) return
    const details = DETAIL_FIELDS.filter((field) => fields.includes(field))
    const catalogueChanged = fields.includes('packageId') || fields.includes('addonIds')
    if (catalogueChanged) setSubmitError('catalogueChanged')
    if (details.length > 0) markInvalid(form, details)
    if (fields.includes('startsAt')) picker.current?.reportTaken(startsAt)
    if (!catalogueChanged && details.length === 0 && !fields.includes('startsAt')) setSubmitError('failed')
  }

  /**
   * After a `422 packageId`: is it the photographer, not the package? A profile
   * that is gone or not taking bookings says so, and the page shows the notice.
   * A failed read proves nothing, and leaves the page as it is.
   */
  async function recheckPhotographer(): Promise<boolean> {
    try {
      const fresh = await fetchPhotographer(handle)
      if (fresh !== null && fresh.takingBookings !== false) return false
    } catch {
      return false
    }
    setStopped(true)
    setStartsAt(null)
    return true
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
        <BookingHeld booking={held} cancellationPolicy={photographer.cancellationPolicy} />
      </main>
    )
  }

  return (
    <main className={cn(container, pageY, 'flex flex-col gap-8')}>
      <AllServicesLink handle={handle} />
      <header className="flex flex-col gap-4">
        {cover !== null && (
          <img
            src={cover}
            alt=""
            referrerPolicy="no-referrer"
            className="bg-muted aspect-21/9 w-full rounded-xs object-cover"
            fetchPriority="high"
          />
        )}
        <div className="flex flex-col gap-3">
          {/* Whose service this is: on a marketplace, the one fact a visitor must not have to guess. */}
          <p className={eyebrow}>
            <Camera aria-hidden="true" />
            {photographer.displayName}
          </p>
          <h1 className={cn(pageTitle, 'wrap-anywhere')}>{service.nameEn}</h1>
          {service.descriptionEn !== null && (
            <p className="text-subtle-foreground max-w-2xl whitespace-pre-line wrap-anywhere">{service.descriptionEn}</p>
          )}
          <p className={eyebrow}>
            <Clock aria-hidden="true" />
            {t('services:picker.kigaliTime')}
          </p>
        </div>
      </header>

      {!takingBookings && <NotTakingBookingsNotice />}

      {service.packages.length === 0 ? (
        <div className="flex flex-col gap-6">
          <p className="text-subtle-foreground">{t('services:noPackages')}</p>
          <YourPhotographer handle={handle} photographer={photographer} className="max-w-sm" />
        </div>
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

            {!takingBookings ? null : chosenPackage === null ? (
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
                  onPackageRefused={() => void recheckPhotographer()}
                />
                <BookingDetailsForm id={formId} invalid={invalid} onSubmit={(event) => void submit(event)} />
              </>
            )}
          </div>

          {/* Below lg it is the last thing on the page, the closing step, so it is spaced like the steps above it. */}
          <div className="flex flex-col gap-4 max-lg:mt-2 lg:sticky lg:top-6">
            <PriceSummary
              pkg={chosenPackage}
              addons={chosenAddons}
              bookingFeeRate={service.bookingFeeRate}
              cancellationPolicy={photographer.cancellationPolicy}
            >
              {takingBookings &&
                chosenPackage !== null &&
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
              {takingBookings && chosenPackage !== null && submitError !== null && (
                <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
                  <p>{t(`services:booking.${submitError}`)}</p>
                </Callout>
              )}
            </PriceSummary>
            <YourPhotographer handle={handle} photographer={photographer} />
          </div>
        </div>
      )}
    </main>
  )
}

/**
 * Whose service this is, and how to reach them (Phase 6, R6.4): the name as
 * a link to their profile, then the contact channels set on it -- never a
 * placeholder. After the price summary, so it follows Confirm in the tab
 * order and nothing leading away comes before the payment notice.
 */
function YourPhotographer({
  handle,
  photographer,
  className,
}: {
  handle: string
  photographer: PublicPhotographerProfile
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="your-photographer" className={cn(panel, 'flex flex-col gap-3 p-5', className)} data-your-photographer="">
      <h2 id="your-photographer" className={eyebrow}>
        <UserRound aria-hidden="true" />
        {t('profile:yourPhotographer')}
      </h2>
      <Link
        to={photographerPath(handle)}
        className="group/profile hover:text-console-link inline-flex min-h-6 items-center gap-2 self-start rounded-xs text-lg font-medium wrap-anywhere pointer-coarse:min-h-11 motion-safe:transition-colors"
      >
        {photographer.displayName}
        <span className="sr-only">, {t('profile:viewProfile')}</span>
        <ArrowRight
          aria-hidden="true"
          className="text-console-link size-4 shrink-0 motion-safe:transition-transform motion-safe:duration-250 motion-safe:group-hover/profile:translate-x-1"
        />
      </Link>
      <ContactList contact={photographer} />
    </section>
  )
}

/** Back to the photographer's own list: on a marketplace, "all services" are theirs. */
function AllServicesLink({ handle }: { handle: string }) {
  const { t } = useTranslation()
  return <BackLink to={photographerPath(handle)}>{t('services:allServices')}</BackLink>
}

/** `90` → `1 h 30 min`; `120` → `2 hours`; `45` → `45 min`. */
function formatDuration(t: TFunction, minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return t('services:duration.minutes', { count: minutes })
  if (rest === 0) return t('services:duration.hours', { count: hours })
  return t('services:duration.hoursAndMinutes', { hours, minutes: rest })
}
