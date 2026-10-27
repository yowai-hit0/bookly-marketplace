import { ArrowRight, CalendarClock, CalendarDays, Camera, Clock, Hash, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { kigaliDateOf } from '@/admin/calendar-dates'
import {
  type AccountBookingRow,
  type AccountBookingsPage,
  type BookingScope,
  BOOKING_SCOPES,
  accountBookingPath,
  fetchAccountBookings,
  pageOf,
  safeCheckoutPath,
  scopeOf,
} from '@/account/dashboard'
import { useAccount } from '@/auth/account'
import { photographerPath } from '@/catalogue/api'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { StatusBadge } from '@/components/ui/status-badge'
import { StatusBadgeVariantContext } from '@/components/ui/status-badge-context'
import { formatDate, formatDateTime, formatMoney, formatTime } from '@/lib/format'
import { reportError } from '@/lib/report-error'
import { cn } from '@/lib/utils'
import { container, data, eyebrow, pageY, panel, textLink } from '@/pages/client/classes'
import { EmptyState, LoadFailed, LoadingRows, PageHead, Pagination } from './parts'

/**
 * `/account`, the client dashboard (marketplace-spec R8.1; design-system/
 * bookly/pages/account-dashboard.md): the client's bookings across every
 * photographer, upcoming or past, from `GET /api/account/bookings`.
 *
 * The tab and the page live in the URL (`?scope=past&page=2`), so a reload,
 * the back button and a shared link all land on the same list. Anything the
 * URL holds that the API would refuse (an unknown scope, a page that is not a
 * whole number in range) reads as the default instead of reaching the API.
 * Every amount is the API's; nothing here adds anything up.
 */

type Loaded = { key: string } & ({ status: 'ok'; page: AccountBookingsPage } | { status: 'failed' })

export function AccountDashboard() {
  const { t } = useTranslation()
  const account = useAccount()
  const [params] = useSearchParams()
  const scope = scopeOf(params.get('scope'))
  const page = pageOf(params.get('page'))
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${scope}:${page}:${attempt}`

  useEffect(() => {
    const controller = new AbortController()
    fetchAccountBookings(scope, page, controller.signal).then(
      (answer) => !controller.signal.aborted && setLoaded({ key, status: 'ok', page: answer }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        reportError(error, 'account_bookings_load_failed')
        setLoaded({ key, status: 'failed' })
      },
    )
    return () => controller.abort()
  }, [scope, page, key])

  const current = loaded?.key === key ? loaded : null
  const name = account.state === 'ready' ? (account.user.fullName?.trim() ?? '') : ''

  return (
    <StatusBadgeVariantContext.Provider value="console">
      <main className={cn(container, pageY, 'flex flex-col gap-8')}>
        <PageHead
          icon={UserRound}
          eyebrowText={t('auth:eyebrow.account')}
          title={name === '' ? t('account:home.greetingNoName') : t('account:home.greeting', { name })}
          lead={t('account:dashboard.lead')}
        />

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <ScopeTabs scope={scope} />
          {current?.status === 'ok' && current.page.total > 0 && (
            <p className="text-muted-foreground font-mono text-sm tabular-nums" role="status">
              {t('account:dashboard.count', { count: current.page.total })}
            </p>
          )}
        </div>

        {current === null && <LoadingRows label={t('account:dashboard.loading')} />}
        {current?.status === 'failed' && (
          <LoadFailed message={t('account:dashboard.loadFailed')} onRetry={() => setAttempt((n) => n + 1)} />
        )}
        {current?.status === 'ok' &&
          (current.page.bookings.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title={t(scope === 'upcoming' ? 'account:dashboard.emptyUpcomingTitle' : 'account:dashboard.emptyPastTitle')}
              body={t(scope === 'upcoming' ? 'account:dashboard.emptyUpcomingBody' : 'account:dashboard.emptyPastBody')}
            >
              <Button asChild>
                <Link to="/photographers">
                  {t('account:dashboard.findPhotographer')}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            </EmptyState>
          ) : (
            <>
              <ul aria-label={t('account:nav.bookings')} className="flex flex-col gap-4">
                {current.page.bookings.map((booking) => (
                  <BookingRow key={booking.reference} booking={booking} />
                ))}
              </ul>
              <Pagination page={current.page.page} pageCount={current.page.pageCount} hrefFor={(n) => listHref(scope, n)} />
            </>
          ))}
      </main>
    </StatusBadgeVariantContext.Provider>
  )
}

function listHref(scope: BookingScope, page: number): string {
  const query = new URLSearchParams()
  if (scope !== 'upcoming') query.set('scope', scope)
  if (page > 1) query.set('page', String(page))
  const search = query.toString()
  return search === '' ? '/account' : `/account?${search}`
}

/**
 * Upcoming and Past as two links, the current one marked: a segmented
 * control, not radios or ARIA tabs, because each is a URL (the e2e suite
 * also counts radios page-wide on the client).
 */
function ScopeTabs({ scope }: { scope: BookingScope }) {
  const { t } = useTranslation()
  return (
    <nav aria-label={t('account:dashboard.tabsLabel')}>
      <ul className="bg-background inline-flex rounded-xs border p-1">
        {BOOKING_SCOPES.map((option) => {
          const current = option === scope
          return (
            <li key={option} className="flex">
              <Link
                to={listHref(option, 1)}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'inline-flex h-9 items-center rounded-xs px-4 text-[0.9375rem] font-medium pointer-coarse:h-11 motion-safe:transition-colors motion-safe:duration-150',
                  current ? 'bg-primary text-primary-foreground' : 'text-subtle-foreground hover:text-foreground hover:bg-muted',
                )}
              >
                {t(`account:dashboard.${option}`)}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * One booking: who with (their profile), what (the link to the booking), when
 * in Kigali time, its reference and status, and its money. A live hold says
 * until when, and offers "Finish payment" on its checkout page.
 */
function BookingRow({ booking }: { booking: AccountBookingRow }) {
  const { t } = useTranslation()
  const checkout = safeCheckoutPath(booking.checkoutPath)
  const { amounts } = booking

  return (
    <li className={cn(panel, 'flex flex-col gap-4 p-5 sm:p-6')}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="flex min-w-0 items-center gap-2 text-sm">
            <Camera aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
            <Link to={photographerPath(booking.photographer.handle)} className={cn(textLink, 'min-w-0 wrap-anywhere')}>
              {booking.photographer.displayName}
            </Link>
          </p>
          <h2 className="text-lg leading-snug font-medium tracking-[-0.01em] wrap-anywhere">
            <Link
              to={accountBookingPath(booking.reference)}
              className="hover:text-console-link rounded-xs underline-offset-4 hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              {t('booking:serviceValue', { service: booking.serviceName, package: booking.packageName })}
            </Link>
          </h2>
        </div>
        <StatusBadge status={booking.stage}>{t(`booking:stage.${booking.stage}`)}</StatusBadge>
      </div>

      <div className="text-subtle-foreground flex flex-col gap-1.5 text-sm">
        <p className="flex items-start gap-2">
          <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {t('booking:whenValue', {
              date: formatDate(kigaliDateOf(booking.startsAt)),
              start: formatTime(booking.startsAt),
              end: formatTime(booking.endsAt),
            })}
          </span>
        </p>
        <p className="flex items-center gap-2">
          <Hash aria-hidden="true" className="size-4 shrink-0" />
          <span className="sr-only">{t('booking:labels.reference')}</span>
          <span className={cn(data, 'text-foreground tracking-wide')}>{booking.reference}</span>
        </p>
      </div>

      {booking.holdExpiresAt !== null && checkout !== null && (
        <Callout variant="console" tone="info" icon={Clock}>
          <p>{t('account:dashboard.heldUntil', { time: formatDateTime(booking.holdExpiresAt) })}</p>
        </Callout>
      )}

      <div className="flex flex-wrap items-end justify-between gap-4 border-t pt-4">
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <Amount label={t('booking:labels.total')} amount={amounts.totalRwf} />
          <Amount label={t('booking:labels.paid')} amount={amounts.paidRwf} />
          {amounts.dueRwf > 0 && <Amount label={t('booking:labels.outstanding')} amount={amounts.dueRwf} strong />}
          {amounts.refundDueRwf > 0 && <Amount label={t('booking:labels.refundDue')} amount={amounts.refundDueRwf} />}
        </dl>
        {checkout !== null && (
          <Button asChild className="max-sm:w-full">
            <Link to={checkout}>
              {t('account:dashboard.finishPayment')}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        )}
      </div>
    </li>
  )
}

function Amount({ label, amount, strong = false }: { label: string; amount: number; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className={eyebrow}>{label}</dt>
      <dd className={cn(data, 'text-[0.9375rem]', strong && 'font-semibold')}>{formatMoney(amount)}</dd>
    </div>
  )
}
