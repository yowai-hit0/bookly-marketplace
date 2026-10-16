import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { kigaliDateOf } from '@/admin/calendar-dates'
import { formatDate, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { panel } from '@/pages/client/classes'

/**
 * What the booking is, in the words the client will recognise: its reference,
 * the service and package, and when. Shared by the pay page and the payment
 * progress page so the two show the same card; `children` are extra rows, such
 * as the pay page's fee, and render inside the same list.
 *
 * Restyled per design-system/bookly/client-front.md §8.4: metadata rows, mono
 * uppercase `dt` labels beside their values. CSS only -- the `dl`/`dt`/`dd`
 * structure and the row set are unchanged.
 */

type Props = {
  reference: string
  serviceName: string
  packageName: string
  startsAt: string
  endsAt: string
  children?: ReactNode
}

export function BookingFacts({ reference, serviceName, packageName, startsAt, endsAt, children }: Props) {
  const { t } = useTranslation()

  return (
    <dl className={cn(panel, 'flex flex-col gap-3.5 p-5 text-sm')}>
      <Row label={t('checkout:summary.reference')} mono>
        {reference}
      </Row>
      <Row label={t('checkout:summary.service')}>
        {t('checkout:summary.serviceValue', { service: serviceName, package: packageName })}
      </Row>
      <Row label={t('checkout:summary.when')}>
        {t('checkout:summary.whenValue', {
          date: formatDate(kigaliDateOf(startsAt)),
          start: formatTime(startsAt),
          end: formatTime(endsAt),
        })}
      </Row>
      {children}
    </dl>
  )
}

/** One `dl` row: a mono uppercase label beside its value. */
function Row({ label, mono = false, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <dt className="text-muted-foreground font-mono text-xs font-medium tracking-[0.1em] uppercase">{label}</dt>
      <dd className={cn('min-w-0 text-right wrap-anywhere', mono && 'font-mono font-medium tracking-wide')}>{children}</dd>
    </div>
  )
}
