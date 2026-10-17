import { ArrowRight, Camera, CalendarCheck, CircleAlert, Info } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'
import {
  type PublicPhotographerProfile,
  type PublicService,
  fetchPhotographer,
  fetchServices,
  servicePath,
} from '@/catalogue/api'
import { BackLink } from '@/components/ui/back-link'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { container, eyebrow, lead, pageTitle, pageY } from '@/pages/client/classes'
import { NotFound } from '@/pages/NotFound'

/**
 * One photographer's services (plan.md Task 11, spec §3.1 step 1; marketplace
 * brief decision 9), at `/p/:handle` under the photographer's name. What is
 * listed is what the API lists -- that photographer's active services only;
 * nothing is filtered or hidden here (spec §2.2: no permission is enforced by
 * hiding UI alone).
 *
 * An unknown handle, and a photographer who cannot be booked, are the
 * not-found page: the API answers 404 for both, and says nothing more.
 */

type Loaded = { handle: string } & (
  | { status: 'ok'; photographer: PublicPhotographerProfile; services: PublicService[] }
  | { status: 'missing' }
  | { status: 'failed' }
)

/** Placeholder cards while the list loads: one row at the widest breakpoint. */
const SKELETON_COUNT = 3

export function ServiceList() {
  const { t } = useTranslation()
  const { handle = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([fetchPhotographer(handle, controller.signal), fetchServices(handle, controller.signal)])
      .then(([photographer, services]) => {
        if (controller.signal.aborted) return
        setLoaded(
          photographer === null || services === null
            ? { handle, status: 'missing' }
            : { handle, status: 'ok', photographer, services },
        )
      })
      .catch(() => !controller.signal.aborted && setLoaded({ handle, status: 'failed' }))
    return () => controller.abort()
  }, [handle, attempt])

  function retry() {
    setLoaded(null)
    setAttempt((n) => n + 1)
  }

  // A load for another handle is stale: moving between photographers shows
  // loading, not the previous one's services.
  const current = loaded?.handle === handle ? loaded : null

  if (current?.status === 'missing') return <NotFound />

  return (
    <main className={cn(container, pageY, 'flex flex-col gap-8')}>
      <BackLink to="/photographers">{t('photographers:all')}</BackLink>
      <header className="flex flex-col gap-3">
        <p className={eyebrow}>
          <CalendarCheck aria-hidden="true" />
          {t('photographers:servicesEyebrow')}
        </p>
        {current === null ? (
          // The name is not known yet: a bar the size of the title, so nothing jumps when it arrives.
          <Skeleton aria-hidden="true" className="h-9 w-64 max-w-full md:h-10" />
        ) : (
          <h1 className={pageTitle}>{current.status === 'ok' ? current.photographer.displayName : t('services:title')}</h1>
        )}
        {current?.status === 'ok' && (
          <p className={cn(lead, 'max-w-2xl whitespace-pre-line')}>{current.photographer.bio ?? t('services:intro')}</p>
        )}
      </header>

      {current === null && (
        <div aria-busy="true">
          {/* The wait is announced once, in words; the cards are decoration. */}
          <p className="sr-only" role="status">
            {t('services:loading')}
          </p>
          <ServiceGridSkeleton count={SKELETON_COUNT} />
        </div>
      )}

      {current?.status === 'failed' && (
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
          <p>{t('services:loadFailed')}</p>
        </Callout>
      )}

      {current?.status === 'ok' &&
        (current.services.length === 0 ? (
          <Callout variant="console" tone="info" icon={Info}>
            <p>{t('services:empty')}</p>
          </Callout>
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {current.services.map((service, index) => (
              <li key={service.id}>
                <ServiceCard handle={handle} service={service} priority={index === 0} />
              </li>
            ))}
          </ul>
        ))}
    </main>
  )
}

/**
 * One service, linking to its page under its photographer's handle.
 * `headingLevel` is 3 under a section's `h2` and 2 under the list's `h1`, so
 * the outline never skips a level.
 */
export function ServiceCard({
  handle,
  service,
  priority,
  headingLevel = 2,
}: {
  /** The photographer the service belongs to: its page lives under their handle. */
  handle: string
  service: PublicService
  priority: boolean
  headingLevel?: 2 | 3
}) {
  const { t } = useTranslation()
  const lowestPrice = service.packages.length === 0 ? null : Math.min(...service.packages.map((pkg) => pkg.priceRwf))
  const Heading = headingLevel === 3 ? 'h3' : 'h2'

  return (
    // The heading's link is stretched over the whole card, so the card is one
    // tab stop with the service's name as its accessible name. The board's
    // lift card (client-front.md 8.2): hover and keyboard focus lift it 6px,
    // turn its edge violet and nudge the arrow; reduced motion keeps the edge.
    // The link hands its focus outline to the card (`data-focus-ring`).
    <article className="group/card bg-background relative flex h-full flex-col overflow-hidden rounded-xs border has-[a:focus-visible]:border-ring has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring has-[a:hover]:border-ring motion-safe:transition-[border-color,translate] motion-safe:duration-250 motion-safe:ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-safe:has-[a:focus-visible]:-translate-y-1.5 motion-safe:has-[a:hover]:-translate-y-1.5">
      {service.coverImageUrl !== null ? (
        <img
          src={service.coverImageUrl}
          alt=""
          className="bg-muted aspect-4/3 w-full object-cover"
          fetchPriority={priority ? 'high' : 'auto'}
          loading={priority ? 'eager' : 'lazy'}
        />
      ) : (
        // No photo supplied: a quiet block with a camera, never a placeholder label.
        <div aria-hidden="true" className="bg-muted text-muted-foreground flex aspect-4/3 w-full items-center justify-center">
          <Camera className="size-8" />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-3.5 p-6">
        <Heading className="text-[1.375rem] leading-tight font-medium tracking-[-0.01em] text-balance">
          <Link
            to={servicePath(handle, service.slug)}
            data-focus-ring="parent"
            className="outline-none after:absolute after:inset-0"
          >
            {service.nameEn}
          </Link>
        </Heading>
        {service.descriptionEn !== null && (
          <p className="text-subtle-foreground line-clamp-2 text-[0.9375rem] leading-relaxed">{service.descriptionEn}</p>
        )}
        <div className="mt-auto flex items-center justify-between gap-3 border-t pt-3.5">
          {lowestPrice !== null ? (
            <p className="font-mono text-sm">{t('services:fromPrice', { price: formatMoney(lowestPrice) })}</p>
          ) : (
            <span />
          )}
          <span aria-hidden="true" className="text-console-link flex items-center gap-1.5 text-[0.9375rem] font-medium">
            {t('services:book')}
            <ArrowRight className="size-4 motion-safe:transition-transform motion-safe:duration-250 motion-safe:group-has-[a:hover]/card:translate-x-1.25 motion-safe:group-has-[a:focus-visible]/card:translate-x-1.25" />
          </span>
        </div>
      </div>
    </article>
  )
}

/**
 * The grid of placeholder cards shown while services load: the same grid and
 * card frame as the real list, so the page does not jump when they arrive.
 * Hidden from assistive technology; the caller announces the wait.
 */
export function ServiceGridSkeleton({ count }: { count: number }) {
  return (
    <ul aria-hidden="true" data-testid="service-skeletons" className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, index) => (
        <li key={index}>
          <div className="bg-background flex h-full flex-col overflow-hidden rounded-xs border">
            <Skeleton className="aspect-4/3 w-full rounded-none" />
            <div className="flex flex-col gap-3.5 p-6">
              {/* A 22px title, two lines of description, then the price row. */}
              <Skeleton className="h-7 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <div className="mt-2 flex justify-between border-t pt-3.5">
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="h-5 w-12" />
              </div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
