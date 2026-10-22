import { CalendarOff, UserX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { useDocumentMeta } from '@/lib/document-meta'
import { cn } from '@/lib/utils'
import { container, pageY, statusTitle } from '@/pages/client/classes'

/**
 * What the public pages say about a photographer who cannot be booked
 * (marketplace spec R5.5).
 *
 * - **Not taking bookings:** listed, but the subscription is past due
 *   (`takingBookings: false`). The profile and services stay visible; no
 *   booking is offered. Worded without a reason: a client is never told about
 *   anyone's billing (R3.4 as built).
 * - **Unavailable:** the API's 404 for the photographer. An unknown handle, a
 *   pending or suspended photographer and an expired subscription are the
 *   same answer, so the page cannot tell them apart and words them all softly.
 *   A really unknown path stays the not-found page.
 */

/** The notice on a photographer's own pages: a profile, a service. */
export function NotTakingBookingsNotice({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <Callout variant="console" tone="warning" icon={CalendarOff} data-not-taking-bookings="" className={className}>
      <p className="font-medium">{t('photographers:notTakingBookings')}</p>
      <p>{t('photographers:notTakingBookingsBody')}</p>
    </Callout>
  )
}

/** In place of a profile or a service whose photographer the API does not serve. */
export function PhotographerUnavailable() {
  const { t } = useTranslation()
  // Out of search results: the page says nothing about who it was (R6.6).
  useDocumentMeta({
    title: t('meta:titleSuffix', { title: t('meta:unavailable.title') }),
    description: t('photographers:unavailable.body'),
    noindex: true,
  })
  return (
    <main className={cn(container, pageY, 'flex min-h-112 flex-col items-center justify-center text-center')} data-photographer-unavailable="">
      <UserX aria-hidden="true" strokeWidth={1.5} className="text-muted-foreground size-10" />
      <h1 className={cn(statusTitle, 'mt-4')}>{t('photographers:unavailable.title')}</h1>
      <p className="text-subtle-foreground mt-2 max-w-md text-pretty">{t('photographers:unavailable.body')}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button asChild>
          <Link to="/photographers">{t('shell:footer.photographers')}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/">{t('shell:footer.home')}</Link>
        </Button>
      </div>
    </main>
  )
}
