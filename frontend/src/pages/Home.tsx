import {
  ArrowRight,
  CalendarCheck,
  CalendarDays,
  Check,
  Hourglass,
  Info,
  Link2,
  MapPin,
  Tag,
  type LucideIcon,
} from 'lucide-react'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import { kigaliDateOf } from '@/admin/calendar-dates'
import { type PublicService, fetchServices } from '@/catalogue/api'
import { kigaliMonthOf, monthGrid } from '@/catalogue/availability'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate, formatMonth } from '@/lib/format'
import { cn } from '@/lib/utils'
import { container, eyebrow, sectionTitle, sectionY } from '@/pages/client/classes'
import { ServiceCard, ServiceGridSkeleton } from '@/pages/services/ServiceList'

/**
 * The public entry point (`design-system/bookly/pages/home.md`, restyled by
 * `client-front.md` section 8.1).
 *
 * Nothing here is invented. There is no photographer name, logo, portfolio,
 * testimonial or review to show, so none appears. The service names and prices
 * are the API's, fetched with the same call `/services` makes, and every claim
 * is a rule the code enforces -- including the unfavourable one, that the
 * booking fee is not refunded. The hero's calendar is decoration built from
 * today's date and the first real service, so it never shows a stale date.
 */

/** How many services the preview shows before sending people to the full list. */
const PREVIEW_COUNT = 3

/** The hero's entrance, 80ms apart (client-front.md section 6). */
function stagger(step: number): CSSProperties {
  return { animationDelay: `${step * 80}ms` }
}
const fadeUp = 'motion-safe:animate-fade-up'

export function Home() {
  const { t } = useTranslation()
  // Null while loading. The API can take close to a minute to wake (Render's
  // free tier), so the preview shows placeholder cards meanwhile (decided
  // 2026-09-25, reversing `home.md`'s "render nothing while loading").
  const [services, setServices] = useState<PublicService[] | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchServices(controller.signal)
      .then((all) => !controller.signal.aborted && setServices(all))
      // Deliberately quiet: this is a marketing page, not the funnel. A
      // failure here renders nothing, and `/services` shows the real error
      // with the real retry.
      .catch(() => !controller.signal.aborted && setServices([]))
    return () => controller.abort()
  }, [])

  const loading = services === null
  const preview = services?.slice(0, PREVIEW_COUNT) ?? []
  const hasPreview = loading || preview.length > 0

  // The header's "How booking works" is `/#how`. React Router does not scroll
  // to a fragment, so this does, and hands focus to the section's heading. No
  // smooth scrolling: a jump is what reduced motion asks for anyway.
  const location = useLocation()
  const howHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (location.hash !== '#how') return
    const heading = howHeading.current
    if (heading === null) return
    heading.closest('section')?.scrollIntoView({ block: 'start' })
    heading.focus({ preventScroll: true })
  }, [location.hash, location.key])

  return (
    <main className="flex flex-col text-pretty">
      {/* Hero ----------------------------------------------------------- */}
      <section className="bg-[radial-gradient(var(--dot)_1px,transparent_1px)] bg-size-[24px_24px]">
        <div className={cn(container, 'grid items-center gap-12 py-12 md:py-18 lg:grid-cols-2 lg:gap-16 lg:py-22')}>
          <div className="flex min-w-0 flex-col items-start gap-6">
            <p
              className={cn(eyebrow, 'bg-console-accent text-console-accent-foreground px-2.5 py-1.5', fadeUp)}
              style={stagger(0)}
            >
              <MapPin aria-hidden="true" />
              {t('landing:hero.eyebrow')}
            </p>
            <h1
              className={cn(
                'text-[2.125rem] leading-[1.05] font-semibold tracking-[-0.035em] text-balance sm:text-[2.5rem] md:text-[3.5rem]',
                fadeUp,
              )}
              style={stagger(1)}
            >
              {t('landing:hero.title')}
            </h1>
            <p className={cn('text-subtle-foreground max-w-xl text-lg leading-relaxed', fadeUp)} style={stagger(2)}>
              {t('landing:hero.body')}
            </p>

            {(loading || (services?.length ?? 0) > 0) && (
              <div className={cn('flex w-full flex-col gap-2.5', fadeUp)} style={stagger(3)}>
                <p className="text-muted-foreground font-mono text-xs font-medium tracking-[0.1em] uppercase">
                  {t('landing:hero.need')}
                </p>
                {loading ? (
                  <div aria-hidden="true" className="flex flex-wrap gap-2">
                    {[28, 36, 24].map((width) => (
                      <Skeleton key={width} className="h-11" style={{ width: `${width * 0.25}rem` }} />
                    ))}
                  </div>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {services.map((service) => (
                      <li key={service.id}>
                        <Link
                          to={`/services/${service.slug}`}
                          className="bg-background hover:border-ring hover:text-console-link inline-flex min-h-11 items-center rounded-xs border px-4 text-[0.9375rem] motion-safe:transition-colors motion-safe:duration-150"
                        >
                          {service.nameEn}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className={cn('flex flex-col items-start gap-5', fadeUp)} style={stagger(4)}>
              <Button asChild variant="brand" size="lg">
                <Link to="/services">
                  <CalendarDays aria-hidden="true" className="size-4.5" />
                  {t('landing:hero.cta')}
                </Link>
              </Button>
              <ul className="text-subtle-foreground flex flex-wrap gap-x-7 gap-y-2 text-sm">
                {(['factFree', 'factMomo'] as const).map((fact) => (
                  <li key={fact} className="flex items-center gap-2">
                    <Check aria-hidden="true" className="text-console-success size-4.5" />
                    {t(`landing:hero.${fact}`)}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground text-sm">{t('landing:hero.aside')}</p>
            </div>
          </div>

          <HeroMockup serviceName={services?.[0]?.nameEn ?? null} />
        </div>
      </section>

      {/* Services ------------------------------------------------------- */}
      {hasPreview && (
        <section id="services" className={cn(container, sectionY, 'flex flex-col gap-10')}>
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div className="flex flex-col gap-3.5">
              <p className={eyebrow}>
                <CalendarCheck aria-hidden="true" />
                {t('landing:preview.eyebrow')}
              </p>
              <h2 className={sectionTitle}>{t('landing:preview.title')}</h2>
            </div>
            <Link
              to="/services"
              className="group/more text-console-link hover:text-console-link-hover inline-flex min-h-11 shrink-0 items-center gap-2 self-start rounded-xs text-base md:self-auto"
            >
              {t('landing:preview.more')}
              <ArrowRight
                aria-hidden="true"
                className="size-4 motion-safe:transition-transform motion-safe:duration-250 motion-safe:group-hover/more:translate-x-1.25"
              />
            </Link>
          </div>
          {loading ? (
            <div aria-busy="true">
              <p className="sr-only" role="status">
                {t('services:loading')}
              </p>
              <ServiceGridSkeleton count={PREVIEW_COUNT} />
            </div>
          ) : (
            <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {preview.map((service, index) => (
                <li key={service.id}>
                  <ServiceCard service={service} priority={index === 0} headingLevel={3} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* How booking works ---------------------------------------------- */}
      <section id="how" className={cn('bg-accent border-y', sectionY)}>
        <div className={cn(container, 'flex flex-col gap-12 lg:gap-14')}>
          <div className="flex flex-col items-center gap-3.5 text-center">
            <p className={eyebrow}>
              <Hourglass aria-hidden="true" />
              {t('landing:how.eyebrow')}
            </p>
            <h2 ref={howHeading} tabIndex={-1} className={cn(sectionTitle, 'outline-none')}>
              {t('landing:how.title')}
            </h2>
          </div>
          {/* A hairline strip: 1px gaps over the hairline colour draw the dividers
              at every column count. */}
          <ol className="bg-border grid gap-px border md:grid-cols-2 lg:grid-cols-4">
            {([1, 2, 3, 4] as const).map((step) => (
              <li key={step} className="group/step bg-background flex flex-col gap-4.5 p-7 lg:px-8 lg:py-9">
                {/* The list already carries the order for a screen reader. */}
                <span
                  aria-hidden="true"
                  className="group-hover/step:border-ring group-hover/step:text-console-link flex size-12 items-center justify-center rounded-xs border font-mono text-lg motion-safe:transition-colors motion-safe:duration-200"
                >
                  {String(step).padStart(2, '0')}
                </span>
                <h3 className="text-xl font-medium tracking-[-0.01em]">{t(`landing:how.step${step}.title`)}</h3>
                <p className="text-subtle-foreground text-[0.9375rem] leading-relaxed">{t(`landing:how.step${step}.body`)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Good to know --------------------------------------------------- */}
      <section className={cn(container, sectionY, 'flex flex-col gap-10')}>
        <div className="flex flex-col gap-3.5">
          <p className={eyebrow}>
            <Info aria-hidden="true" />
            {t('landing:trust.eyebrow')}
          </p>
          <h2 className={sectionTitle}>{t('landing:trust.title')}</h2>
        </div>
        <ul className="bg-border grid gap-px border md:grid-cols-2">
          <Fact icon={Tag} name="price" />
          <Fact icon={CalendarCheck} name="hold" />
          {/* The one unfavourable term, said here rather than only at checkout,
              at the same weight as the others: it is a fact, not an error. */}
          <Fact icon={Info} name="fee" />
          <Fact icon={Link2} name="link" />
        </ul>
      </section>

      {/* Already booked? (the old closing section, merged) --------------- */}
      <section className={cn(container, 'pb-12 md:pb-16 lg:pb-26')}>
        <div className="bg-band text-band-foreground relative flex flex-col gap-8 overflow-hidden rounded-xs px-6 py-10 md:px-12 md:py-14 lg:flex-row lg:items-center lg:justify-between lg:gap-12 lg:px-18 lg:py-16 dark:border">
          <svg
            aria-hidden="true"
            viewBox="0 0 420 420"
            className="pointer-events-none absolute -top-30 -right-20 hidden size-105 text-[oklch(0.3364_0.1647_288.7)] md:block"
          >
            <circle cx="210" cy="210" r="200" fill="none" stroke="currentColor" strokeWidth="1" />
            <circle cx="210" cy="210" r="150" fill="none" stroke="currentColor" strokeWidth="1" />
            <circle cx="210" cy="210" r="100" fill="none" stroke="currentColor" strokeWidth="1" />
            <circle cx="210" cy="210" r="50" fill="currentColor" />
          </svg>
          <div className="relative flex max-w-2xl flex-col gap-4">
            <p className={cn(eyebrow, 'text-band-accent')}>
              <CalendarCheck aria-hidden="true" />
              {t('landing:booked.eyebrow')}
            </p>
            <h2 className="text-[1.875rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance md:text-[2.5rem]">
              {t('landing:booked.title')}
            </h2>
            <p className="text-band-muted text-[1.0625rem] leading-relaxed">{t('landing:booked.body')}</p>
            <p className="text-band-foreground text-[1.0625rem]">{t('landing:closing.title')}</p>
          </div>
          <div className="relative flex flex-col gap-3 sm:flex-row lg:shrink-0">
            <Button
              asChild
              variant="outline"
              size="lg"
              className="border-band-edge text-band-foreground hover:bg-band-edge/40 hover:text-band-foreground dark:hover:bg-band-edge/40 bg-transparent"
            >
              <Link to="/my-booking">{t('landing:booked.cta')}</Link>
            </Button>
            <Button asChild size="lg" className="bg-band-foreground text-band hover:bg-band-foreground/85">
              <Link to="/services">
                {t('landing:closing.cta')}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  )
}

/** One fact in "Good to know": an icon tile paired with words, never alone. */
function Fact({ icon: Icon, name }: { icon: LucideIcon; name: string }) {
  const { t } = useTranslation()
  return (
    <li className="group/fact bg-background hover:bg-accent flex gap-5 p-6 motion-safe:transition-colors motion-safe:duration-250 md:p-9">
      <span
        aria-hidden="true"
        className="bg-muted group-hover/fact:bg-brand group-hover/fact:text-brand-foreground flex size-13 shrink-0 items-center justify-center rounded-xs motion-safe:transition-colors motion-safe:duration-250 [&_svg]:size-5.5"
      >
        <Icon />
      </span>
      <div className="flex flex-col gap-2">
        <h3 className="text-xl font-medium tracking-[-0.01em]">{t(`landing:trust.${name}.title`)}</h3>
        <p className="text-subtle-foreground text-[0.9375rem] leading-relaxed">{t(`landing:trust.${name}.body`)}</p>
      </div>
    </li>
  )
}

/**
 * The hero's calendar (decorative, `aria-hidden`, pure HTML and CSS): the
 * current Kigali month, the two weeks from today's, today chosen, the days
 * after it that are not Sundays marked open, three start times, and a small
 * "held" card with the first real service and today's date. Nothing loops.
 */
function HeroMockup({ serviceName }: { serviceName: string | null }) {
  const { t } = useTranslation()
  const now = new Date()
  const today = kigaliDateOf(now)
  const month = kigaliMonthOf(now)
  const grid = monthGrid(month)
  const todayIndex = grid.indexOf(today)
  const rowStart = todayIndex - (todayIndex % 7)
  const cells = Array.from({ length: 14 }, (_, index) => grid[rowStart + index] ?? null)
  const weekdays = (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map((day) =>
    t(`services:picker.weekdays.${day}`).slice(0, 1),
  )

  return (
    <div
      aria-hidden="true"
      className={cn('relative hidden h-110 w-full max-w-120 justify-self-center select-none sm:block lg:justify-self-end', fadeUp)}
      style={stagger(3)}
    >
      <div className="bg-console-accent dark:bg-selected absolute top-2 right-0 bottom-4 left-10" />
      <div className="bg-background border-foreground absolute top-12 left-0 flex w-[min(24rem,85%)] flex-col gap-4 border p-5.5">
        <div className="flex items-center justify-between font-mono text-xs tracking-[0.1em] uppercase">
          <span>{formatMonth(month)}</span>
          <span className="text-muted-foreground text-[0.6875rem]">{t('landing:hero.mockup.timezone')}</span>
        </div>
        <div className="grid grid-cols-7 gap-1.5 text-center text-sm">
          {weekdays.map((day, index) => (
            <span key={index} className="text-muted-foreground font-mono text-[0.6875rem]">
              {day}
            </span>
          ))}
          {cells.map((date, index) => {
            if (date === null) return <span key={index} />
            const isToday = date === today
            const open = date > today && index % 7 !== 6 && Number(date.slice(8)) % 4 !== 3
            return (
              <span
                key={date}
                className={cn(
                  'flex flex-col items-center gap-0.5 py-1.5 font-mono',
                  isToday && 'bg-primary text-primary-foreground font-medium',
                  !isToday && !open && 'text-muted-foreground/60',
                )}
              >
                {Number(date.slice(8))}
                <span
                  className={cn(
                    'size-1 rounded-full',
                    isToday ? 'bg-band-accent dark:bg-brand' : open ? 'bg-brand' : 'bg-transparent',
                  )}
                />
              </span>
            )
          })}
        </div>
        <div className="bg-border h-px" />
        <div className="grid grid-cols-3 gap-2 text-center font-mono text-sm">
          <span className="border py-2.5">08:00</span>
          <span className="border-brand bg-brand text-brand-foreground border py-2.5 font-medium">10:00</span>
          <span className="border py-2.5">14:00</span>
        </div>
      </div>
      <div className="bg-background border-foreground absolute right-0 bottom-10 flex w-72 flex-col gap-2.5 border px-4.5 py-4">
        <div className="flex items-center gap-3">
          <span className="bg-console-accent text-console-accent-foreground flex size-8 shrink-0 items-center justify-center">
            <Hourglass className="size-4" />
          </span>
          <span className="text-[0.9375rem] font-semibold">{t('landing:hero.mockup.held')}</span>
        </div>
        <span className="text-sm font-medium">{serviceName ?? t('landing:hero.mockup.service')}</span>
        <span className="text-muted-foreground font-mono text-xs">{formatDate(today)} · 10:00</span>
      </div>
    </div>
  )
}
