import { CalendarDays, CircleAlert, Clock, Hash, Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { ApiError, UnauthenticatedError } from '@/admin/api'
import { useBreadcrumbTail } from '@/admin/breadcrumb-tail'
import { type StudioPayoutDetail, payoutsApi } from '@/admin/payouts'
import { BackLink } from '@/components/ui/back-link'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime, formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { META, PAGE, SECTION_TITLE } from './console/classes'
import { MetaItem, PageHeader } from './console/PageHeader'
import { PayoutStatusBadge } from './console/PayoutBadges'
import { PayoutDestination } from './console/PayoutDestination'
import { PayoutItems } from './console/PayoutItems'
import { Line, LoadingRegion } from './console/Skeletons'

type State = { id: string; attempt: number } & ({ kind: 'ready'; payout: StudioPayoutDetail } | { kind: 'missing' } | { kind: 'failed' })

/**
 * `/studio/payouts/:id` (marketplace spec R4.5): one payout -- a draft the
 * platform is preparing, or one it has paid -- with where it went, its
 * transfer reference and every line in it, each linked to its booking.
 *
 * Another photographer's payout, a cancelled draft and an unknown id are all
 * the same 404, and a malformed id is a 400: each reads as "does not exist",
 * so nothing tells one case from another. The platform's internal note is
 * never sent to the studio.
 */
export function AdminPayoutDetail() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<State | null>(null)

  useEffect(() => {
    let cancelled = false
    payoutsApi.payout(id).then(
      (payout) => !cancelled && setState({ id, attempt, kind: 'ready', payout }),
      (error: unknown) => {
        if (cancelled || error instanceof UnauthenticatedError) return
        const missing = error instanceof ApiError && (error.status === 404 || error.status === 400)
        setState({ id, attempt, kind: missing ? 'missing' : 'failed' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [id, attempt])

  const current = state !== null && state.id === id && state.attempt === attempt ? state : null
  const payout = current?.kind === 'ready' ? current.payout : null
  useBreadcrumbTail(current === null, payout === null ? null : t('admin:payout.crumb', { date: formatDateTime(payout.createdAt) }))

  const back = <BackLink to="/studio/earnings">{t('admin:payout.back')}</BackLink>

  if (current === null) {
    return (
      <main className={cn(PAGE, 'max-w-5xl')}>
        {back}
        <LoadingRegion label={t('admin:payout.loading')} className="flex flex-col gap-8 lg:gap-12">
          <div className="flex flex-col gap-3.5">
            <Line w="w-24" className="h-3" />
            <div className="flex flex-wrap items-center gap-3.5">
              <Skeleton className="h-9 w-64 max-w-full rounded-xs" />
              <Skeleton className="h-6 w-24 rounded-xs" />
            </div>
            <Line w="w-72 max-w-full" />
          </div>
          {[0, 1].map((section) => (
            <div key={section} className="flex flex-col gap-4 border-t pt-8">
              <Line w="w-28" className="h-6" />
              {[0, 1].map((row) => (
                <div key={row} className="flex justify-between gap-6">
                  <Line w="w-40" />
                  <Line w="w-24" />
                </div>
              ))}
            </div>
          ))}
        </LoadingRegion>
      </main>
    )
  }

  if (current.kind === 'failed') {
    return (
      <main className={cn(PAGE, 'max-w-5xl')}>
        {back}
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('admin:payout.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('admin:payout.retry')}
          </Button>
        </div>
      </main>
    )
  }

  if (current.kind === 'missing' || payout === null) {
    return (
      <main className={cn(PAGE, 'max-w-5xl')}>
        {back}
        <PageHeader eyebrow={t('admin:nav.earnings')} eyebrowIcon={Wallet} title={t('admin:payout.missing')} />
      </main>
    )
  }

  return (
    <main className={cn(PAGE, 'max-w-5xl')}>
      {back}
      <PageHeader
        eyebrow={t('admin:nav.earnings')}
        eyebrowIcon={Wallet}
        title={t('admin:payout.title', { amount: formatMoney(payout.amountRwf) })}
        badges={
          <PayoutStatusBadge status={payout.status} size="md">
            {t(`admin:earnings.payouts.status.${payout.status}`)}
          </PayoutStatusBadge>
        }
        meta={
          <>
            <MetaItem icon={CalendarDays}>{t('admin:payout.created', { date: formatDateTime(payout.createdAt) })}</MetaItem>
            {payout.paidAt !== null && <MetaItem icon={Clock}>{t('admin:payout.paid', { date: formatDateTime(payout.paidAt) })}</MetaItem>}
            {payout.transferReference !== null && (
              <MetaItem icon={Hash}>{t('admin:payout.reference', { reference: payout.transferReference })}</MetaItem>
            )}
            <span>{t('admin:earnings.payouts.lines', { count: payout.itemCount })}</span>
          </>
        }
      />

      {payout.status === 'draft' && (
        <Callout variant="console" tone="info" icon={Clock}>
          <p>{t('admin:payout.draftNote')}</p>
        </Callout>
      )}

      <section className="flex flex-col gap-4 border-t pt-8 lg:pt-12">
        <h2 className={SECTION_TITLE}>{t('admin:payout.destination')}</h2>
        <PayoutDestination method={payout.payoutMethod} />
      </section>

      <section className="flex flex-col gap-4 border-t pt-8 lg:pt-12">
        <h2 className={SECTION_TITLE}>{t('admin:payout.items')}</h2>
        {payout.items.length === 0 ? (
          <p className={META}>{t('admin:earnings.items.empty')}</p>
        ) : (
          <PayoutItems items={payout.items} caption={t('admin:payout.items')} linkBookings />
        )}
      </section>
    </main>
  )
}
