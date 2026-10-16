import { Clock, Hourglass, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { kigaliDateOf } from '@/admin/calendar-dates'
import type { HeldBooking } from '@/catalogue/bookings'
import { checkoutPath } from '@/catalogue/payments'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { formatDate, formatMoney, formatTime } from '@/lib/format'
import { feePercent } from '@/lib/quote'
import { cn } from '@/lib/utils'
import { panel } from '@/pages/client/classes'

/**
 * What a visitor sees once their booking holds its slot (plan.md Task 13, spec
 * §3.1 step 8): the reference, what and when, the amounts as the API froze
 * them, and how long the hold lasts. Every amount here is the API's answer --
 * nothing is recomputed in the browser.
 *
 * Restyled per design-system/bookly/client-front.md §8.4 (decision 16): a
 * success band carries the title, the reference and the "held until" stat (the
 * same clock time the `holdUntil` sentence already interpolates -- no
 * countdown, no new logic); the `dl` below keeps its exact 8 rows, restyled as
 * metadata/money rows with CSS only.
 *
 * Paying the booking fee is the next step (spec §3.1 step 9): the checkout
 * link, addressed by the booking's checkout token (plan.md Task 16).
 */

export function BookingHeld({ booking }: { booking: HeldBooking }) {
  const { t } = useTranslation()
  const headingRef = useRef<HTMLHeadingElement>(null)

  // The form the visitor submitted is gone; tell them where they are now.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const fee = formatMoney(booking.bookingFeeRwf)

  return (
    <section className="flex max-w-2xl flex-col gap-5">
      {/* The held band, in the accent tint as on the board ("Your date is
          held"): a hold is not a confirmed booking, so it never takes the
          success colour (finish review, 2026-09-27). A 44px icon tile, the
          title, the reference in mono underlined, and the hold's end time. */}
      <div className="bg-console-accent flex flex-wrap items-center justify-between gap-x-8 gap-y-5 rounded-xs px-5 py-5 sm:px-6">
        <div className="flex items-center gap-4">
          <div aria-hidden="true" className="bg-background text-console-accent-foreground flex size-11 shrink-0 items-center justify-center rounded-xs">
            <Hourglass className="size-5" />
          </div>
          <div className="flex flex-col gap-1">
            <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-[-0.01em] outline-none">
              {t('services:booking.held.title')}
            </h1>
            <p className="text-subtle-foreground text-sm">
              {t('services:booking.held.reference')}{' '}
              <span className="text-foreground font-mono font-medium tracking-wide underline underline-offset-4">
                {booking.reference}
              </span>
            </p>
          </div>
        </div>
        {/* No expiry, no stat: a ticking countdown would be new logic (decision 16). */}
        {booking.holdExpiresAt !== null && (
          <div className="flex flex-col items-end gap-1">
            <span className="text-console-accent-foreground font-mono text-xs font-medium tracking-[0.1em] uppercase">
              {t('services:booking.held.heldUntil')}
            </span>
            <span className="font-mono text-[1.75rem] leading-none font-semibold tabular-nums">
              {formatTime(booking.holdExpiresAt)}
            </span>
          </div>
        )}
      </div>

      <dl className={cn(panel, 'flex flex-col gap-3.5 p-5 text-sm')}>
        <Row label={t('services:booking.held.reference')} mono>
          {booking.reference}
        </Row>
        <Row label={t('services:booking.held.service')}>
          {t('services:booking.held.serviceValue', { service: booking.serviceName, package: booking.packageName })}
        </Row>
        <Row label={t('services:booking.held.when')}>
          {t('services:booking.held.whenValue', {
            date: formatDate(kigaliDateOf(booking.startsAt)),
            start: formatTime(booking.startsAt),
            end: formatTime(booking.endsAt),
          })}
        </Row>
        <div className="mt-1 flex justify-between gap-4 border-t pt-3">
          <dt className="min-w-0 wrap-anywhere">{booking.packageName}</dt>
          <dd className="font-mono shrink-0 tabular-nums">{formatMoney(booking.packagePriceRwf)}</dd>
        </div>
        {booking.addons.map((addon, index) => (
          // Two add-ons may share a name; their order is the booking's own.
          <div key={index} className="flex justify-between gap-4">
            <dt className="min-w-0 wrap-anywhere">{addon.name}</dt>
            <dd className="font-mono shrink-0 tabular-nums">{formatMoney(addon.priceRwf)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-4 border-t pt-3 text-base font-semibold">
          <dt>{t('services:summary.total')}</dt>
          <dd className="font-mono shrink-0 tabular-nums">{formatMoney(booking.totalRwf)}</dd>
        </div>
        {/* Due now, so the whole row is a step heavier than the session fee. */}
        <div className="flex justify-between gap-4 font-medium">
          <dt>{t('services:summary.bookingFee', { percent: feePercent(booking.bookingFeeRate) })}</dt>
          <dd className="font-mono shrink-0 tabular-nums">{fee}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>{t('services:summary.sessionFee')}</dt>
          <dd className="font-mono shrink-0 tabular-nums">{formatMoney(booking.sessionFeeRwf)}</dd>
        </div>
      </dl>

      {/* The hold is time-critical, so it is a callout of its own, above the non-refundable notice. */}
      <div className="flex flex-col gap-2">
        <Callout variant="console" tone="info" icon={Clock}>
          <p>
            {booking.holdExpiresAt === null
              ? t('services:booking.held.holdUntilUnknown', { fee })
              : t('services:booking.held.holdUntil', { time: formatTime(booking.holdExpiresAt), fee })}
          </p>
        </Callout>
        <Callout variant="console" tone="warning" icon={TriangleAlert}>
          <p className="font-medium">{t('services:summary.nonRefundable')}</p>
        </Callout>
      </div>

      {booking.checkoutToken !== undefined && (
        <Button asChild size="lg" className="self-start">
          <Link to={checkoutPath(booking.reference, booking.checkoutToken)}>{t('services:booking.held.pay')}</Link>
        </Button>
      )}
    </section>
  )
}

/** One `dl` row: a mono uppercase label beside its value (client-front.md §8.4). */
function Row({ label, mono = false, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
      <dt className="text-muted-foreground font-mono text-xs font-medium tracking-[0.1em] uppercase">{label}</dt>
      <dd className={cn('min-w-0 text-right wrap-anywhere', mono && 'font-mono font-medium tracking-wide')}>{children}</dd>
    </div>
  )
}
