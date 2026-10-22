import { Camera, CircleAlert, Info, MapPin, MessageCircle, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { type PublicPhotographerProfile, fetchPhotographer } from '@/catalogue/api'
import { BackLink } from '@/components/ui/back-link'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { policySentence } from '@/lib/cancellation'
import { contactLinks } from '@/lib/contact'
import { excerpt, useDocumentMeta } from '@/lib/document-meta'
import { safeHttpsUrl } from '@/lib/safe-url'
import { cn } from '@/lib/utils'
import { container, eyebrow, pageTitle, pageY, panel, panelTitle } from '@/pages/client/classes'
import { ServiceCard, ServiceGridSkeleton } from '@/pages/services/ServiceCard'
import { NotTakingBookingsNotice, PhotographerUnavailable } from './notices'
import { ContactList } from './PhotographerContact'
import { Portfolio } from './Portfolio'

/**
 * One photographer's profile at `/p/:handle` (`design-system/bookly/pages/
 * photographer-profile.md`; marketplace spec R6.2, R6.3, R6.5), from
 * `GET /api/photographers/:handle` alone: who they are, where they work and
 * what they shoot, their services with "from" prices, their portfolio, their
 * cancellation terms in plain words and the contact channels they set.
 *
 * **Every text field is rendered as text** (R6.5, T6.4): the bio, captions
 * and names are React text nodes, never HTML or markdown, so a bio holding
 * `<script>` shows those characters. Line breaks in the bio are kept.
 * Images reach an `src` only as `https://`, without a Referer.
 *
 * An unknown handle and a photographer who is not listed are one page saying
 * the photographer is unavailable: the API answers 404 for both. A past-due
 * photographer (`takingBookings: false`) keeps the profile, with a notice and
 * no card offering to book.
 */

type Loaded = { handle: string } & (
  | { status: 'ok'; photographer: PublicPhotographerProfile }
  | { status: 'missing' }
  | { status: 'failed' }
)

export function PhotographerProfile() {
  const { t } = useTranslation()
  const { handle = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchPhotographer(handle, controller.signal)
      .then((photographer) => {
        if (controller.signal.aborted) return
        setLoaded(photographer === null ? { handle, status: 'missing' } : { handle, status: 'ok', photographer })
      })
      .catch(() => !controller.signal.aborted && setLoaded({ handle, status: 'failed' }))
    return () => controller.abort()
  }, [handle, attempt])

  function retry() {
    setLoaded(null)
    setAttempt((n) => n + 1)
  }

  // A load for another handle is stale: moving between photographers shows loading.
  const current = loaded?.handle === handle ? loaded : null

  if (current?.status === 'missing') return <PhotographerUnavailable />
  if (current?.status === 'ok') return <ProfileView photographer={current.photographer} />

  return (
    <main className={cn(container, pageY, 'flex flex-col gap-8')}>
      <BackLink to="/photographers">{t('photographers:all')}</BackLink>
      {current === null ? (
        <div aria-busy="true" className="flex flex-col gap-8">
          <p className="sr-only" role="status">
            {t('photographers:loading')}
          </p>
          <div aria-hidden="true" className="flex flex-col gap-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-9 w-72 max-w-full md:h-10" />
            <Skeleton className="h-5 w-56 max-w-full" />
          </div>
          <ServiceGridSkeleton count={3} />
        </div>
      ) : (
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
          <p>{t('photographers:loadPhotographerFailed')}</p>
        </Callout>
      )}
    </main>
  )
}

function ProfileView({ photographer }: { photographer: PublicPhotographerProfile }) {
  const { t } = useTranslation()
  const cover = safeHttpsUrl(photographer.coverImageUrl)
  const bio = photographer.bio?.trim() ? photographer.bio : null
  const takingBookings = photographer.takingBookings !== false
  const portfolio = (photographer.portfolio ?? []).filter((image) => safeHttpsUrl(image.url) !== null)
  const services = photographer.services ?? []
  const districts = photographer.districts ?? []
  const categories = photographer.categories ?? []

  useDocumentMeta({
    title: t('meta:titleSuffix', { title: photographer.displayName }),
    description: bio !== null ? excerpt(bio) : t('meta:profile.description', { name: photographer.displayName }),
    image: cover,
    type: 'profile',
  })

  return (
    <main className={cn(container, pageY, 'flex flex-col gap-8')}>
      <BackLink to="/photographers">{t('photographers:all')}</BackLink>

      <header className="flex flex-col gap-6">
        {cover !== null && (
          <img
            src={cover}
            alt=""
            referrerPolicy="no-referrer"
            fetchPriority="high"
            className="bg-muted aspect-video w-full rounded-xs object-cover md:aspect-21/9"
          />
        )}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <p className={eyebrow}>
              <Camera aria-hidden="true" />
              {t('profile:eyebrow')}
            </p>
            <h1 className={cn(pageTitle, 'wrap-anywhere')}>{photographer.displayName}</h1>
          </div>
          {(districts.length > 0 || categories.length > 0) && (
            <div className="flex flex-col gap-3">
              {districts.length > 0 && (
                <p className="text-subtle-foreground flex min-w-0 items-start gap-2 text-[0.9375rem]">
                  <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span className="sr-only">{t('directory:card.districts')} </span>
                  <span className="min-w-0 wrap-anywhere">{districts.map((district) => district.name).join(', ')}</span>
                </p>
              )}
              {categories.length > 0 && (
                <ul aria-label={t('directory:card.categories')} className="flex flex-wrap gap-1.5">
                  {categories.map((category) => (
                    <li key={category.slug} className="text-subtle-foreground rounded-xs border px-2.5 py-1 text-[0.8125rem] wrap-anywhere">
                      {category.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {/* Plain text, verbatim (T6.4): a text node, so markup shows as the characters it is. */}
          {bio !== null && (
            <p className="text-subtle-foreground max-w-2xl text-base leading-relaxed whitespace-pre-line wrap-anywhere md:text-[1.0625rem]" data-bio="">
              {bio}
            </p>
          )}
        </div>
      </header>

      {!takingBookings && <NotTakingBookingsNotice />}

      {/* Services, then the terms and contact, then the portfolio: on a phone
          what a client needs before booking comes before up to 24 photos. From
          `lg` the terms and contact sit in a column beside the other two. */}
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <section aria-labelledby="profile-services" className="flex min-w-0 flex-col gap-5 lg:col-start-1 lg:row-start-1">
          <h2 id="profile-services" className={panelTitle}>
            {t('profile:services')}
          </h2>
          {services.length === 0 ? (
            <Callout variant="console" tone="info" icon={Info}>
              <p>{t('services:empty')}</p>
            </Callout>
          ) : (
            <ul className="grid gap-6 sm:grid-cols-2">
              {services.map((service, index) => (
                <li key={service.slug}>
                  <ServiceCard
                    handle={photographer.handle}
                    service={service}
                    priority={cover === null && index === 0}
                    headingLevel={3}
                    takingBookings={takingBookings}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="flex min-w-0 flex-col gap-6 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <section aria-labelledby="profile-cancellation" className={cn(panel, 'flex flex-col gap-3 p-5')}>
            <h2 id="profile-cancellation" className={eyebrow}>
              <Undo2 aria-hidden="true" />
              {t('profile:cancellation')}
            </h2>
            <p className="text-[0.9375rem] leading-relaxed">{policySentence(t, photographer.cancellationPolicy)}</p>
            <p className="text-subtle-foreground text-sm leading-relaxed">{t('profile:photographerCancels')}</p>
          </section>

          {contactLinks(photographer).length > 0 && (
            <section aria-labelledby="profile-contact" className={cn(panel, 'flex flex-col gap-3 p-5')}>
              <h2 id="profile-contact" className={eyebrow}>
                <MessageCircle aria-hidden="true" />
                {t('profile:contact')}
              </h2>
              <ContactList contact={photographer} />
            </section>
          )}
        </aside>

        {portfolio.length > 0 && (
          <section aria-labelledby="profile-portfolio" className="flex min-w-0 flex-col gap-5 lg:col-start-1 lg:row-start-2">
            <h2 id="profile-portfolio" className={panelTitle}>
              {t('profile:portfolio')}
            </h2>
            <Portfolio images={portfolio} name={photographer.displayName} headingId="profile-portfolio" />
          </section>
        )}
      </div>
    </main>
  )
}
