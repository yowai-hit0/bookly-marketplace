import { CircleAlert, Repeat } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { SUBSCRIPTION_STATUSES, isSubscriptionStatus, lastPaidPeriod } from '@/admin/subscription'
import { UnauthenticatedError } from '@/auth/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { formatDateTime, formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type PlatformSubscription, platformSubscriptionsApi, soonestEndFirst } from '@/platform/subscriptions'
import { EYEBROW, META, PAGE, SELECT, TD, TH, TR } from '@/pages/admin/console/classes'
import { PageHeader } from '@/pages/admin/console/PageHeader'
import { Line, LoadingRegion } from '@/pages/admin/console/Skeletons'
import { SubscriptionStatusBadge } from '@/pages/admin/console/SubscriptionStatusBadge'
import { Toolbar, ToolbarCell } from '@/pages/admin/console/Toolbar'

/**
 * `/platform/subscriptions` (marketplace spec Phase 5: R5.4, R9.3): every
 * photographer's subscription, the soonest to end first, filtered by status
 * through `?status=` so a reload or a shared link keeps the filter. Each row
 * says whose it is, its status as of the API's clock, when its period ends,
 * when a lapsed one is hidden, and the last period paid for. Read-only: the
 * photographer pays from the studio; the platform sets the prices in Settings.
 */

const COLUMNS = ['photographer', 'status', 'periodEnd', 'graceEnd', 'lastPaid'] as const

export function PlatformSubscriptions() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const raw = params.get('status')
  const status = isSubscriptionStatus(raw) ? raw : undefined
  const filterId = useId()
  const key = status ?? 'all'

  const [attempt, setAttempt] = useState(0)
  const [rows, setRows] = useState<{ key: string; attempt: number; list: PlatformSubscription[] | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    platformSubscriptionsApi.list(status).then(
      (list) => !cancelled && setRows({ key, attempt, list: soonestEndFirst(list) }),
      (error: unknown) => {
        // A 401 has dropped the platform session; the route's guard sends him to sign in.
        if (cancelled || error instanceof UnauthenticatedError) return
        setRows({ key, attempt, list: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [key, status, attempt])

  // A load for another filter, or before a retry, is stale.
  const current = rows !== null && rows.key === key && rows.attempt === attempt ? rows : null

  function chooseStatus(next: string) {
    setParams(next === 'all' ? new URLSearchParams() : new URLSearchParams({ status: next }), { replace: true })
  }

  return (
    <main className={cn(PAGE, 'max-w-6xl')}>
      <PageHeader eyebrow={t('platform:nav.label')} eyebrowIcon={Repeat} title={t('platform:subscriptions.title')}>
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('platform:subscriptions.intro')}</p>
      </PageHeader>

      <Toolbar className="lg:self-start">
        <ToolbarCell className="max-lg:py-2">
          <Label htmlFor={filterId} className={cn(EYEBROW, 'shrink-0')}>
            {t('platform:subscriptions.filter.label')}
          </Label>
          <select id={filterId} value={key} onChange={(event) => chooseStatus(event.target.value)} className={cn(SELECT, 'lg:w-48')}>
            <option value="all">{t('platform:subscriptions.filter.all')}</option>
            {SUBSCRIPTION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`admin:subscription.status.${value}`)}
              </option>
            ))}
          </select>
        </ToolbarCell>
      </Toolbar>

      {current === null && (
        <LoadingRegion label={t('platform:subscriptions.loading')} className="flex flex-col">
          {Array.from({ length: 5 }, (_, row) => (
            <div key={row} className="flex items-center gap-6 border-b py-4 last:border-b-0">
              <div className="flex flex-1 flex-col gap-2">
                <Line w="w-44 max-w-full" />
                <Line w="w-24" className="h-3" />
              </div>
              <Line w="w-24" />
              <Line w="w-36 max-sm:hidden" />
              <Line w="w-36 max-sm:hidden" />
            </div>
          ))}
        </LoadingRegion>
      )}

      {current !== null && current.list === null && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:subscriptions.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('platform:subscriptions.retry')}
          </Button>
        </div>
      )}

      {current?.list?.length === 0 && (
        <p className={META}>{status === undefined ? t('platform:subscriptions.empty') : t('platform:subscriptions.emptyFiltered')}</p>
      )}

      {current !== null && current.list !== null && current.list.length > 0 && (
        <div className="@container">
          <table role="table" className="w-full border-collapse text-[0.9375rem]">
            <caption className="sr-only">{t('platform:subscriptions.title')}</caption>
            <thead role="rowgroup" className="@max-[52rem]:sr-only">
              <tr role="row" className="border-b">
                {COLUMNS.map((column) => (
                  <th key={column} role="columnheader" scope="col" className={TH}>
                    {t(`platform:subscriptions.columns.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody role="rowgroup" className="@max-[52rem]:block">
              {current.list.map((subscription) => (
                <SubscriptionRow key={subscription.id} subscription={subscription} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}

const STACKED_ROW = '@max-[52rem]:flex @max-[52rem]:flex-col @max-[52rem]:gap-2 @max-[52rem]:py-4'
const STACKED_CELL = '@max-[52rem]:p-0'

function SubscriptionRow({ subscription }: { subscription: PlatformSubscription }) {
  const { t } = useTranslation()
  const { photographer } = subscription
  const paid = lastPaidPeriod(subscription.periods)
  // The grace end only matters once a period has ended; before that it is the date a lapse would hide the profile.
  const lapsed = subscription.status === 'past_due' || subscription.status === 'expired'

  return (
    <tr role="row" data-subscription={subscription.id} className={cn(TR, STACKED_ROW)}>
      <td role="cell" className={cn(TD, STACKED_CELL)}>
        <div className="flex flex-col gap-1">
          <span className="wrap-anywhere">{photographer.displayName}</span>
          <span className={cn(META, 'font-mono')}>/p/{photographer.handle}</span>
          {/* A photographer not approved now cannot be booked whatever the subscription says. */}
          {photographer.status !== 'approved' && (
            <Badge variant="console" className="mt-1">
              {t(`platform:photographers.status.${photographer.status}`)}
            </Badge>
          )}
        </div>
      </td>
      <td role="cell" className={cn(TD, STACKED_CELL)}>
        <SubscriptionStatusBadge status={subscription.status} />
      </td>
      <td role="cell" className={cn(TD, 'tabular-nums', STACKED_CELL)}>
        {/* Stacked on a narrow screen, the header row is hidden: the cell names itself. */}
        <span className="@min-[52rem]:hidden">{t('platform:subscriptions.columns.periodEnd')}: </span>
        {formatDateTime(subscription.currentPeriodEndsAt)}
      </td>
      <td role="cell" className={cn(TD, 'tabular-nums', !lapsed && 'text-muted-foreground', STACKED_CELL)}>
        {/* Stacked on a narrow screen, the header row is hidden: the cell names itself. */}
        <span className="@min-[52rem]:hidden">{t('platform:subscriptions.columns.graceEnd')}: </span>
        {formatDateTime(subscription.graceEndsAt)}
      </td>
      <td role="cell" className={cn(TD, STACKED_CELL)}>
        {paid === null ? (
          <span className={META}>{t('platform:subscriptions.neverPaid')}</span>
        ) : (
          <div className="flex flex-col gap-1" data-last-paid={paid.id}>
            <span>
              {t('platform:subscriptions.lastPaid', {
                plan: t(`platform:subscriptions.plans.${paid.planInterval ?? 'monthly'}`),
                price: formatMoney(paid.priceRwf),
              })}
            </span>
            <span className={cn(META, 'tabular-nums')}>
              {t('admin:subscription.history.dates', { start: formatDateTime(paid.startsAt), end: formatDateTime(paid.endsAt) })}
            </span>
            {paid.paidAt !== null && (
              <span className={cn(META, 'tabular-nums')}>{t('platform:subscriptions.paidOn', { date: formatDateTime(paid.paidAt) })}</span>
            )}
          </div>
        )}
      </td>
    </tr>
  )
}
