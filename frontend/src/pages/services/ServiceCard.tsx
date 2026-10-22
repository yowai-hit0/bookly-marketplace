import { ArrowRight, Camera } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { type PublicServiceSummary, servicePath } from '@/catalogue/api'
import { Skeleton } from '@/components/ui/skeleton'
import { formatMoney } from '@/lib/format'
import { safeHttpsUrl } from '@/lib/safe-url'
import { liftCard } from '@/pages/photographers/PhotographerCard'

/**
 * One service on a photographer's profile (`client-front.md` §8.2;
 * `pages/photographer-profile.md`), linking to its page under their handle.
 * The heading's link is stretched over the whole card, so the card is one tab
 * stop with the service's name as its accessible name; hover and keyboard
 * focus lift it 6px, turn its edge violet and nudge the arrow (reduced motion
 * keeps the edge). The cover is a pasted link: only `https://`, no Referer.
 *
 * `fromPriceRwf` is the API's cheapest active package; null while the service
 * has none, which reads "Price on request".
 */
export function ServiceCard({
  handle,
  service,
  priority,
  headingLevel = 2,
  takingBookings = true,
}: {
  /** The photographer the service belongs to: its page lives under their handle. */
  handle: string
  service: PublicServiceSummary
  priority: boolean
  headingLevel?: 2 | 3
  /** False while the photographer is not taking bookings: the card offers the details, not "Book". */
  takingBookings?: boolean
}) {
  const { t } = useTranslation()
  const cover = safeHttpsUrl(service.coverImageUrl)
  const Heading = headingLevel === 3 ? 'h3' : 'h2'

  return (
    <article className={liftCard}>
      {cover !== null ? (
        <img
          src={cover}
          alt=""
          referrerPolicy="no-referrer"
          className="bg-muted aspect-4/3 w-full object-cover"
          fetchPriority={priority ? 'high' : 'auto'}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
        />
      ) : (
        // No photo supplied: a quiet block with a camera, never a placeholder label.
        <div aria-hidden="true" className="bg-muted text-muted-foreground flex aspect-4/3 w-full items-center justify-center">
          <Camera className="size-8" />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-3.5 p-5 md:p-6">
        <Heading className="text-[1.375rem] leading-tight font-medium tracking-[-0.01em] text-balance wrap-anywhere">
          <Link
            to={servicePath(handle, service.slug)}
            data-focus-ring="parent"
            className="outline-none after:absolute after:inset-0"
          >
            {service.nameEn}
          </Link>
        </Heading>
        {service.descriptionEn !== null && service.descriptionEn.trim() !== '' && (
          <p className="text-subtle-foreground line-clamp-2 text-[0.9375rem] leading-relaxed wrap-anywhere">{service.descriptionEn}</p>
        )}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t pt-3.5">
          {service.fromPriceRwf !== null ? (
            <p className="font-mono text-sm tabular-nums">{t('services:fromPrice', { price: formatMoney(service.fromPriceRwf) })}</p>
          ) : (
            <p className="text-subtle-foreground text-sm">{t('profile:priceOnRequest')}</p>
          )}
          <span aria-hidden="true" className="text-console-link flex items-center gap-1.5 text-[0.9375rem] font-medium">
            {/* Nothing to book without a package: the card offers the details instead. */}
            {takingBookings && service.fromPriceRwf !== null ? t('services:book') : t('services:seeDetails')}
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
export function ServiceGridSkeleton({ count, columns = 3 }: { count: number; columns?: 2 | 3 }) {
  return (
    <ul
      aria-hidden="true"
      data-testid="service-skeletons"
      className={columns === 3 ? 'grid gap-6 sm:grid-cols-2 lg:grid-cols-3' : 'grid gap-6 sm:grid-cols-2'}
    >
      {Array.from({ length: count }, (_, index) => (
        <li key={index}>
          <div className="bg-background flex h-full flex-col overflow-hidden rounded-xs border">
            <Skeleton className="aspect-4/3 w-full rounded-none" />
            <div className="flex flex-col gap-3.5 p-5 md:p-6">
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
