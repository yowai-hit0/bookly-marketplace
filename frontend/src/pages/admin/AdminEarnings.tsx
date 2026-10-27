import { Banknote, CircleAlert, Clock, Hourglass, TriangleAlert, Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { UnauthenticatedError } from '@/admin/api'
import { type Earnings, type StudioPayout, payoutsApi } from '@/admin/payouts'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime, formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DATA, LINK, META, PAGE, SECTION_TITLE, TD, TH, TR } from './console/classes'
import { PageHeader } from './console/PageHeader'
import { PayoutStatusBadge } from './console/PayoutBadges'
import { PayoutDestination } from './console/PayoutDestination'
import { PayoutItems } from './console/PayoutItems'
import { Line, LoadingRegion } from './console/Skeletons'
import { StatGrid, StatTile } from './console/StatGrid'

/**
 * `/studio/earnings` (marketplace spec R4.5): what the photographer has
 * earned from payments made online, and the payouts the platform sent him by
 * hand. Four totals (pending, payable now, being paid out, paid), every line
 * linked to its booking with its state in words, and the payout history, each
 * payout opening on its own page.
 *
 * Payable can be nought or negative: a refund after a payout adds a negative
 * line that the next payout subtracts, and the page says so rather than
 * showing a minus sign alone.
 */
export function AdminEarnings() {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{ attempt: number; earnings: Earnings | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    payoutsApi.earnings().then(
      (earnings) => !cancelled && setLoaded({ attempt, earnings }),
      (error: unknown) => {
        // A 401 has dropped the studio session; the layout's guard takes him to sign in.
        if (cancelled || error instanceof UnauthenticatedError) return
        setLoaded({ attempt, earnings: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  // A retry is a new load: the old failure does not stay on screen while it runs.
  const current = loaded !== null && loaded.attempt === attempt ? loaded : null
  const earnings = current?.earnings ?? null

  return (
    <main className={cn(PAGE, 'max-w-6xl')}>
      <PageHeader
        eyebrow={t('studio:nav.label')}
        eyebrowIcon={Wallet}
        title={t('admin:earnings.title')}
        actions={
          <Button asChild variant="console-outline" size="console">
            <Link to="/studio/payout-method">{t('admin:earnings.payoutMethod')}</Link>
          </Button>
        }
      >
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('admin:earnings.intro')}</p>
      </PageHeader>

      {current === null && <EarningsSkeleton />}

      {current !== null && earnings === null && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('admin:earnings.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('admin:earnings.retry')}
          </Button>
        </div>
      )}

      {earnings !== null && (
        <>
          <div className="flex flex-col gap-6">
            <StatGrid className="xl:grid-cols-4">
              <StatTile icon={Clock} label={t('admin:earnings.totals.pending')} mono>
                {formatMoney(earnings.totals.pendingRwf)}
              </StatTile>
              <StatTile
                icon={Wallet}
                label={t('admin:earnings.totals.payable')}
                mono
                tone={earnings.totals.payableRwf < 0 ? 'warning' : 'neutral'}
              >
                {formatMoney(earnings.totals.payableRwf)}
              </StatTile>
              <StatTile icon={Hourglass} label={t('admin:earnings.totals.inDraft')} mono>
                {formatMoney(earnings.totals.inDraftRwf)}
              </StatTile>
              <StatTile icon={Banknote} label={t('admin:earnings.totals.paid')} mono>
                {formatMoney(earnings.totals.paidRwf)}
              </StatTile>
            </StatGrid>
            {earnings.totals.payableRwf < 0 && (
              <Callout variant="console" tone="warning" icon={TriangleAlert} data-notice="payable-negative">
                <p>{t('admin:earnings.payableNegative', { amount: formatMoney(-earnings.totals.payableRwf) })}</p>
              </Callout>
            )}
          </div>

          <section className="flex flex-col gap-4 border-t pt-8 lg:pt-12">
            <h2 className={SECTION_TITLE}>{t('admin:earnings.items.title')}</h2>
            {earnings.items.length === 0 ? (
              <p className={META}>{t('admin:earnings.items.empty')}</p>
            ) : (
              <PayoutItems items={earnings.items} caption={t('admin:earnings.items.title')} linkBookings />
            )}
          </section>

          <section className="flex flex-col gap-4 border-t pt-8 lg:pt-12">
            <h2 className={SECTION_TITLE}>{t('admin:earnings.payouts.title')}</h2>
            {earnings.payouts.length === 0 ? (
              <p className={META}>{t('admin:earnings.payouts.empty')}</p>
            ) : (
              <PayoutHistory payouts={earnings.payouts} />
            )}
          </section>
        </>
      )}
    </main>
  )
}

const HISTORY_COLUMNS = ['created', 'amount', 'status', 'destination', 'reference'] as const

/** The draft being prepared, if any, and every paid payout, newest first; each opens on its own page. */
function PayoutHistory({ payouts }: { payouts: StudioPayout[] }) {
  const { t } = useTranslation()
  return (
    <div className="@container">
      <table role="table" className="w-full border-collapse text-[0.9375rem]">
        <caption className="sr-only">{t('admin:earnings.payouts.title')}</caption>
        <thead role="rowgroup" className="@max-[44rem]:sr-only">
          <tr role="row" className="border-b">
            {HISTORY_COLUMNS.map((column) => (
              <th key={column} role="columnheader" scope="col" className={cn(TH, column === 'amount' && 'text-right')}>
                {t(`admin:earnings.payouts.columns.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup" className="@max-[44rem]:block">
          {payouts.map((payout) => (
            <tr
              key={payout.id}
              role="row"
              data-payout={payout.id}
              className={cn(TR, '@max-[44rem]:flex @max-[44rem]:flex-col @max-[44rem]:gap-2 @max-[44rem]:py-4')}
            >
              <td role="cell" className={cn(TD, '@max-[44rem]:p-0')}>
                <Link to={`/studio/payouts/${payout.id}`} className={cn(LINK, 'tabular-nums')}>
                  {formatDateTime(payout.createdAt)}
                </Link>
              </td>
              <td role="cell" className={cn(TD, 'text-right @max-[44rem]:p-0 @max-[44rem]:text-left')}>
                <div className="flex flex-col gap-1 @min-[44rem]:items-end">
                  <span className={cn(DATA, 'whitespace-nowrap')}>{formatMoney(payout.amountRwf)}</span>
                  <span className={META}>{t('admin:earnings.payouts.lines', { count: payout.itemCount })}</span>
                </div>
              </td>
              <td role="cell" className={cn(TD, '@max-[44rem]:p-0')}>
                <PayoutStatusBadge status={payout.status}>{t(`admin:earnings.payouts.status.${payout.status}`)}</PayoutStatusBadge>
              </td>
              <td role="cell" className={cn(TD, '@max-[44rem]:p-0')}>
                <PayoutDestination method={payout.payoutMethod} />
              </td>
              <td role="cell" className={cn(TD, '@max-[44rem]:p-0')}>
                {payout.transferReference === null ? (
                  <span className={META}>{t('admin:earnings.payouts.noReference')}</span>
                ) : (
                  <span className={cn(DATA, 'wrap-anywhere')}>{payout.transferReference}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The tiles and two sections, drawn where the data will be (admin-console.md 6.12). */
function EarningsSkeleton() {
  const { t } = useTranslation()
  return (
    <LoadingRegion label={t('admin:earnings.loading')} className="flex flex-col gap-8 lg:gap-12">
      <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => (
          <div key={tile} className="flex items-center gap-4 sm:gap-5">
            <Skeleton className="size-12 shrink-0 rounded-xs sm:size-16" />
            <div className="flex flex-1 flex-col gap-2">
              <Line w="w-20" className="h-3" />
              <Line w="w-28" />
            </div>
          </div>
        ))}
      </div>
      {[0, 1].map((section) => (
        <div key={section} className="flex flex-col gap-4 border-t pt-8 lg:pt-12">
          <Line w="w-24" className="h-6" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-6 border-b py-4 last:border-b-0">
              <div className="flex flex-1 flex-col gap-2">
                <Line w="w-36 max-w-full" />
                <Line w="w-24" className="h-3" />
              </div>
              <Line w="w-20 max-sm:hidden" />
              <Line w="w-24" />
            </div>
          ))}
        </div>
      ))}
    </LoadingRegion>
  )
}
