import { type ReactNode, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { formatMoney } from '@/lib/format'
import { feePercent, quoteBasket } from '@/lib/quote'
import { cn } from '@/lib/utils'
import { data, eyebrow } from '@/pages/client/classes'
import { ContactLine } from '@/pages/client/ContactLine'

/**
 * The running total a visitor watches while choosing (spec §3.1 steps 3 and
 * 7; restyled per design-system/bookly/client-front.md §8.3, the board's
 * "your booking" card): each chosen line, the total, the booking fee at this
 * service's rate and the session fee left for after the shoot. There is no
 * processing-fee line -- the advertised price is what the client pays (A-4b).
 *
 * The amounts are this browser's quote and carry no authority; the API prices
 * the basket again from the catalogue before any money is taken (plan.md
 * Task 11).
 *
 * The non-refundable notice is always shown, whatever is selected. `children`
 * is where a later step toward payment plugs in, and it renders after the
 * notice, so no control leading to payment can be reached before it. The
 * `dl > div > dt + dd` markup below is exactly what `services.spec.ts` reads
 * by `dt` text: only classes change here, never a row.
 */

type Line = { id: string; nameEn: string; priceRwf: number }

type Props = {
  /** The chosen package; null until one is chosen. */
  pkg: Line | null
  /** The chosen add-ons, in the order they should be listed. */
  addons: readonly Line[]
  /** This service's booking-fee rate, 0 to 1. */
  bookingFeeRate: number
  children?: ReactNode
}

export function PriceSummary({ pkg, addons, bookingFeeRate, children }: Props) {
  const { t } = useTranslation()
  const headingId = useId()

  const quote =
    pkg === null
      ? null
      : quoteBasket({
          packagePriceRwf: pkg.priceRwf,
          addonPricesRwf: addons.map((addon) => addon.priceRwf),
          bookingFeeRate,
        })

  return (
    <section aria-labelledby={headingId} className="bg-accent flex flex-col gap-4 rounded-xs border p-5">
      <h2 id={headingId} className={eyebrow}>
        {t('services:summary.title')}
      </h2>

      <div aria-live="polite">
        {pkg === null || quote === null ? (
          <p className="text-subtle-foreground text-sm">{t('services:summary.pickPackage')}</p>
        ) : (
          <dl className="flex flex-col gap-2.5 text-sm">
            {[pkg, ...addons].map((line) => (
              <div key={line.id} className="flex justify-between gap-4">
                <dt className="min-w-0 wrap-anywhere">{line.nameEn}</dt>
                <dd className={cn(data, 'shrink-0')}>{formatMoney(line.priceRwf)}</dd>
              </div>
            ))}
            <div className="mt-1 flex justify-between gap-4 border-t pt-3 text-base font-medium">
              <dt>{t('services:summary.total')}</dt>
              <dd className={cn(data, 'shrink-0 text-xl')}>{formatMoney(quote.totalRwf)}</dd>
            </div>
            {/* The booking fee is what is due now, so its whole row is a step heavier than the session fee. */}
            <div className="flex justify-between gap-4 font-medium">
              <dt>{t('services:summary.bookingFee', { percent: feePercent(bookingFeeRate) })}</dt>
              <dd className={cn(data, 'shrink-0')}>{formatMoney(quote.bookingFeeRwf)}</dd>
            </div>
            <div className="text-subtle-foreground flex justify-between gap-4">
              <dt>{t('services:summary.sessionFee')}</dt>
              <dd className={cn(data, 'shrink-0')}>{formatMoney(quote.sessionFeeRwf)}</dd>
            </div>
          </dl>
        )}
      </div>

      <p className="text-subtle-foreground text-[0.8125rem] leading-relaxed">{t('services:summary.nonRefundable')}</p>
      {children}
      <ContactLine />
    </section>
  )
}
