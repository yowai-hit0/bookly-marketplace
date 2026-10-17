import { ArrowRight, Camera, CircleAlert, Info, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { type PublicPhotographerSummary, fetchPhotographers, photographerPath } from '@/catalogue/api'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { safeHttpsUrl } from '@/lib/safe-url'
import { cn } from '@/lib/utils'
import { container, eyebrow, lead, pageTitle, pageY } from '@/pages/client/classes'
import { ServiceGridSkeleton } from '@/pages/services/ServiceList'

/**
 * The photographers who can be booked (marketplace brief decision 9), as
 * `GET /api/photographers` lists them: a name and a cover each, linking to that
 * photographer's services. Deliberately minimal -- Phase 6 builds the real
 * directory with its filters -- but drawn with the service list's own grid,
 * card and states, so it is one product.
 *
 * A cover is a pasted link, so it reaches an `src` only through
 * `safeHttpsUrl`; anything else shows the quiet camera block instead.
 */

type Loaded = { status: 'ok'; photographers: PublicPhotographerSummary[] } | { status: 'failed' }

/** Placeholder cards while the list loads: one row at the widest breakpoint. */
const SKELETON_COUNT = 3

export function PhotographerList() {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchPhotographers(controller.signal)
      .then((photographers) => !controller.signal.aborted && setLoaded({ status: 'ok', photographers }))
      .catch(() => !controller.signal.aborted && setLoaded({ status: 'failed' }))
    return () => controller.abort()
  }, [attempt])

  function retry() {
    setLoaded(null)
    setAttempt((n) => n + 1)
  }

  return (
    <main className={cn(container, pageY, 'flex flex-col gap-8')}>
      <header className="flex flex-col gap-3">
        <p className={eyebrow}>
          <Users aria-hidden="true" />
          {t('photographers:title')}
        </p>
        <h1 className={pageTitle}>{t('photographers:title')}</h1>
        <p className={lead}>{t('photographers:intro')}</p>
      </header>

      {loaded === null && (
        <div aria-busy="true">
          {/* The wait is announced once, in words; the cards are decoration. */}
          <p className="sr-only" role="status">
            {t('photographers:loading')}
          </p>
          <ServiceGridSkeleton count={SKELETON_COUNT} />
        </div>
      )}

      {loaded?.status === 'failed' && (
        <Callout
          variant="console"
          tone="destructive"
          icon={CircleAlert}
          role="alert"
          action={
            <Button variant="outline" size="sm" onClick={retry}>
              {t('photographers:retry')}
            </Button>
          }
        >
          <p>{t('photographers:loadFailed')}</p>
        </Callout>
      )}

      {loaded?.status === 'ok' &&
        (loaded.photographers.length === 0 ? (
          <Callout variant="console" tone="info" icon={Info}>
            <p>{t('photographers:empty')}</p>
          </Callout>
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {loaded.photographers.map((photographer, index) => (
              <li key={photographer.handle}>
                <PhotographerCard photographer={photographer} priority={index === 0} />
              </li>
            ))}
          </ul>
        ))}
    </main>
  )
}

/**
 * One photographer: the cover, the name as a link stretched over the card, and
 * where it leads. The service card's frame and lift (client-front.md 8.2),
 * exported so the landing page shows the same card. `headingLevel` is 3 under
 * a section's `h2` (Home) and 2 under the list's `h1`.
 */
export function PhotographerCard({
  photographer,
  priority,
  headingLevel = 2,
}: {
  photographer: PublicPhotographerSummary
  priority: boolean
  headingLevel?: 2 | 3
}) {
  const { t } = useTranslation()
  const cover = safeHttpsUrl(photographer.coverImageUrl)
  const Heading = headingLevel === 3 ? 'h3' : 'h2'

  return (
    <article className="group/card bg-background relative flex h-full flex-col overflow-hidden rounded-xs border has-[a:focus-visible]:border-ring has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring has-[a:hover]:border-ring motion-safe:transition-[border-color,translate] motion-safe:duration-250 motion-safe:ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-safe:has-[a:focus-visible]:-translate-y-1.5 motion-safe:has-[a:hover]:-translate-y-1.5">
      {cover !== null ? (
        <img
          src={cover}
          alt=""
          className="bg-muted aspect-4/3 w-full object-cover"
          fetchPriority={priority ? 'high' : 'auto'}
          loading={priority ? 'eager' : 'lazy'}
        />
      ) : (
        // No usable cover: a quiet block with a camera, never a placeholder label.
        <div aria-hidden="true" className="bg-muted text-muted-foreground flex aspect-4/3 w-full items-center justify-center">
          <Camera className="size-8" />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-3.5 p-6">
        <Heading className="text-[1.375rem] leading-tight font-medium tracking-[-0.01em] text-balance">
          <Link
            to={photographerPath(photographer.handle)}
            data-focus-ring="parent"
            className="outline-none after:absolute after:inset-0"
          >
            {photographer.displayName}
          </Link>
        </Heading>
        <div className="mt-auto flex items-center justify-end gap-3 border-t pt-3.5">
          <span aria-hidden="true" className="text-console-link flex items-center gap-1.5 text-[0.9375rem] font-medium">
            {t('photographers:viewServices')}
            <ArrowRight className="size-4 motion-safe:transition-transform motion-safe:duration-250 motion-safe:group-has-[a:hover]/card:translate-x-1.25 motion-safe:group-has-[a:focus-visible]/card:translate-x-1.25" />
          </span>
        </div>
      </div>
    </article>
  )
}
