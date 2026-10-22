import { ArrowRight, CalendarOff, Camera, MapPin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { type PublicPhotographerSummary, photographerPath } from '@/catalogue/api'
import { Skeleton } from '@/components/ui/skeleton'
import { formatMoney } from '@/lib/format'
import { safeHttpsUrl } from '@/lib/safe-url'
import { cn } from '@/lib/utils'

/**
 * One photographer on the directory and the landing page's featured strip
 * (`design-system/bookly/pages/directory.md`, "The card"): the service card's
 * frame and lift, one stretched link (the name), one tab stop.
 *
 * The cover is a pasted link, so it reaches an `src` only through
 * `safeHttpsUrl`, and never sends a Referer (R6.5). Anything else, or none,
 * is the quiet camera block at the same 4:3, so a row stays aligned. Every
 * text value is the photographer's, rendered as text.
 */

/** How many districts and categories a card names before "+N more". */
const DISTRICTS_SHOWN = 2
const CATEGORIES_SHOWN = 3

/** The card's frame: hairline, 2px, the -6px lift and violet edge on hover and keyboard focus. */
export const liftCard =
  'group/card bg-background relative flex h-full flex-col overflow-hidden rounded-xs border has-[a:focus-visible]:border-ring has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring has-[a:hover]:border-ring motion-safe:transition-[border-color,translate] motion-safe:duration-250 motion-safe:ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-safe:has-[a:focus-visible]:-translate-y-1.5 motion-safe:has-[a:hover]:-translate-y-1.5'

export function PhotographerCard({
  photographer,
  priority,
  headingLevel = 2,
}: {
  photographer: PublicPhotographerSummary
  /** The first card: loaded eagerly, at high priority. */
  priority: boolean
  /** 3 under a section's `h2` (Home), 2 under a page's `h1`. */
  headingLevel?: 2 | 3
}) {
  const { t } = useTranslation()
  const cover = safeHttpsUrl(photographer.coverImageUrl)
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  const districts = photographer.districts ?? []
  const categories = photographer.categories ?? []
  const moreDistricts = districts.length - DISTRICTS_SHOWN
  const moreCategories = categories.length - CATEGORIES_SHOWN

  return (
    <article className={liftCard} data-photographer={photographer.handle}>
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
        <div aria-hidden="true" className="bg-muted text-muted-foreground flex aspect-4/3 w-full items-center justify-center">
          <Camera className="size-8" />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-3 p-5 md:p-6">
        <Heading className="line-clamp-2 text-[1.375rem] leading-tight font-medium tracking-[-0.01em] text-balance wrap-anywhere">
          <Link
            to={photographerPath(photographer.handle)}
            data-focus-ring="parent"
            className="outline-none after:absolute after:inset-0"
          >
            {photographer.displayName}
          </Link>
        </Heading>

        {districts.length > 0 && (
          <p className="text-subtle-foreground flex min-w-0 items-start gap-2 text-sm">
            <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="sr-only">{t('directory:card.districts')} </span>
            <span className="min-w-0 wrap-anywhere">
              {districts
                .slice(0, DISTRICTS_SHOWN)
                .map((district) => district.name)
                .join(', ')}
              {moreDistricts > 0 && <span className="text-muted-foreground"> {t('directory:card.more', { count: moreDistricts })}</span>}
            </span>
          </p>
        )}

        {categories.length > 0 && (
          <ul aria-label={t('directory:card.categories')} className="flex flex-wrap gap-1.5">
            {categories.slice(0, CATEGORIES_SHOWN).map((category) => (
              <li key={category.slug} className="text-subtle-foreground rounded-xs border px-2 py-0.5 text-[0.8125rem] wrap-anywhere">
                {category.name}
              </li>
            ))}
            {moreCategories > 0 && (
              <li className="text-muted-foreground px-1 py-0.5 text-[0.8125rem]">+{moreCategories}</li>
            )}
          </ul>
        )}

        {photographer.takingBookings === false && <NotTakingBookingsBadge />}

        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t pt-3.5">
          {typeof photographer.fromPriceRwf === 'number' ? (
            <p className="font-mono text-sm tabular-nums">{t('services:fromPrice', { price: formatMoney(photographer.fromPriceRwf) })}</p>
          ) : (
            <span />
          )}
          <span aria-hidden="true" className="text-console-link flex items-center gap-1.5 text-[0.9375rem] font-medium">
            {t('directory:card.viewProfile')}
            <ArrowRight className="size-4 motion-safe:transition-transform motion-safe:duration-250 motion-safe:group-has-[a:hover]/card:translate-x-1.25 motion-safe:group-has-[a:focus-visible]/card:translate-x-1.25" />
          </span>
        </div>
      </div>
    </article>
  )
}

/**
 * "Not taking bookings": a past-due photographer, listed last and never with
 * a date filter (R5.5, Phase 6). The words carry it; the warning tint and the
 * icon only repeat them. Never a reason: a client is not told about billing.
 */
export function NotTakingBookingsBadge({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <p
      data-not-taking-bookings=""
      className={cn(
        'bg-console-warning-tint text-console-warning inline-flex w-fit items-center gap-1.5 rounded-xs px-2 py-1 text-[0.8125rem] font-medium',
        className,
      )}
    >
      <CalendarOff aria-hidden="true" className="size-3.5 shrink-0" />
      {t('directory:card.notTaking')}
    </p>
  )
}

/**
 * Placeholder cards in the directory's grid while a page loads, the same
 * frame as the real card so nothing jumps. Hidden from assistive technology;
 * the page announces the wait in words.
 */
export function PhotographerGridSkeleton({ count }: { count: number }) {
  return (
    <ul aria-hidden="true" data-testid="photographer-skeletons" className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, index) => (
        <li key={index}>
          <div className="bg-background flex h-full flex-col overflow-hidden rounded-xs border">
            <Skeleton className="aspect-4/3 w-full rounded-none" />
            <div className="flex flex-col gap-3 p-5 md:p-6">
              <Skeleton className="h-7 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <div className="flex gap-1.5">
                <Skeleton className="h-6 w-16" />
                <Skeleton className="h-6 w-20" />
              </div>
              <div className="mt-2 flex justify-between border-t pt-3.5">
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="h-5 w-20" />
              </div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
