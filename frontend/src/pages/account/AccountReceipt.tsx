import { Printer, ReceiptText, SearchX } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { kigaliDateOf } from '@/admin/calendar-dates'
import { type ReceiptResult, type Receipt, fetchAccountReceipt, methodLabel, printer } from '@/account/dashboard'
import { BackLink } from '@/components/ui/back-link'
import { Button } from '@/components/ui/button'
import { formatDate, formatDateTime, formatMoney, formatTime } from '@/lib/format'
import { reportError } from '@/lib/report-error'
import { cn } from '@/lib/utils'
import { container, data, eyebrow, pageY, panel } from '@/pages/client/classes'
import { MoneyBack } from './AccountPayments'
import { LoadFailed, MissingState, PageHead } from './parts'

/**
 * `/account/payments/:ourRef/receipt` (marketplace-spec R8.2; design-system/
 * bookly/pages/account-payments.md, "Receipt"): one payment that took money,
 * as a page the browser prints. No PDF library: "Print" calls
 * `window.print()`, and the print stylesheet (`index.css`, `@media print`)
 * hides the shell, the account nav and every control, sets black on white in
 * either theme, and keeps the receipt to one page.
 *
 * A refunded payment's receipt says so. The account's own payment that took
 * no money (pending, failed) is the API's `409 no_receipt`, explained; one
 * that is not the account's is the same 404 as one that names nothing.
 */

type Loaded = { key: string } & (ReceiptResult | { status: 'failed' })

export function AccountReceipt() {
  const { t } = useTranslation()
  const { ourRef = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${ourRef}:${attempt}`

  useEffect(() => {
    const controller = new AbortController()
    fetchAccountReceipt(ourRef, controller.signal).then(
      (result) => !controller.signal.aborted && setLoaded({ key, ...result }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        reportError(error, 'account_receipt_load_failed')
        setLoaded({ key, status: 'failed' })
      },
    )
    return () => controller.abort()
  }, [ourRef, key])

  const current = loaded?.key === key ? loaded : null

  return (
    <main className={cn(container, pageY, 'mx-auto flex max-w-3xl flex-col gap-6 text-pretty print:max-w-none print:gap-4 print:p-0')}>
      <BackLink to="/account/payments" className="print:hidden">
        {t('account:receipt.back')}
      </BackLink>
      {current === null && (
        <p className="text-muted-foreground text-sm" role="status">
          {t('account:receipt.loading')}
        </p>
      )}
      {current?.status === 'failed' && <LoadFailed message={t('account:receipt.loadFailed')} onRetry={() => setAttempt((n) => n + 1)} />}
      {current?.status === 'missing' && (
        <MissingState icon={SearchX} title={t('account:receipt.notFoundTitle')} body={t('account:receipt.notFoundBody')} />
      )}
      {current?.status === 'no_receipt' && (
        <MissingState
          icon={ReceiptText}
          title={t('account:receipt.noReceiptTitle')}
          body={t(current.paymentStatus === 'failed' ? 'account:receipt.noReceiptFailed' : 'account:receipt.noReceiptPending')}
        />
      )}
      {current?.status === 'ok' && <ReceiptView receipt={current.receipt} />}
    </main>
  )
}

function ReceiptView({ receipt }: { receipt: Receipt }) {
  const { t } = useTranslation()
  const method = methodLabel(t, receipt.method)
  const { booking } = receipt

  return (
    <>
      <PageHead icon={ReceiptText} eyebrowText={t('account:receipt.eyebrow')} title={t('account:receipt.title')}>
        <Button variant="outline" onClick={() => printer.print()} className="print:hidden">
          <Printer aria-hidden="true" />
          {t('account:receipt.print')}
        </Button>
      </PageHead>

      <article
        data-receipt=""
        aria-labelledby="receipt-number"
        className={cn(panel, 'flex flex-col gap-6 p-5 sm:p-8 print:gap-5 print:border-0 print:p-0')}
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
          <p className="text-xl font-semibold tracking-[-0.02em]">{t('common:appName')}</p>
          <div className="flex min-w-0 flex-col gap-1 sm:items-end">
            <p id="receipt-number" className={eyebrow}>
              {t('account:receipt.labels.receiptNo')}
            </p>
            <p className={cn(data, 'text-sm wrap-anywhere sm:text-right')}>{receipt.ourRef}</p>
          </div>
        </div>

        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 print:grid-cols-2">
          <Row label={t('account:receipt.labels.billedTo')}>{receipt.billedTo}</Row>
          <Row label={t('account:receipt.labels.photographer')}>{receipt.photographer.displayName}</Row>
          <Row label={t('account:receipt.labels.booking')} mono>
            {booking.reference}
          </Row>
          <Row label={t('account:receipt.labels.service')}>
            {t('booking:serviceValue', { service: booking.serviceName, package: booking.packageName })}
          </Row>
          <Row label={t('account:receipt.labels.session')} className="sm:col-span-2 print:col-span-2">
            {t('booking:whenValue', {
              date: formatDate(kigaliDateOf(booking.startsAt)),
              start: formatTime(booking.startsAt),
              end: formatTime(booking.endsAt),
            })}
          </Row>
          <Row label={t('account:receipt.labels.paidFor')}>{t(`account:payments.kind.${receipt.kind}`)}</Row>
          {method !== null && <Row label={t('account:receipt.labels.method')}>{method}</Row>}
          <Row label={t('account:receipt.labels.paidOn')} mono>
            {formatDateTime(receipt.settledAt ?? receipt.createdAt)}
          </Row>
          <Row label={t('account:receipt.labels.status')}>{t(`account:payments.status.${receipt.status}`)}</Row>
        </dl>

        <section aria-labelledby="receipt-items" className="flex flex-col gap-3">
          <h2 id="receipt-items" className={eyebrow}>
            {t('account:receipt.itemsTitle')}
          </h2>
          {/* Every amount is the API's: the lines are listed, never added up here. */}
          <table className="w-full border-collapse text-sm">
            <tbody>
              <Line name={booking.packageName} amount={booking.packagePriceRwf} />
              {booking.addons.map((addon, index) => (
                // Two add-ons may share a name; their order is the booking's own.
                <Line
                  key={index}
                  name={addon.quantity > 1 ? t('account:receipt.addonLine', { name: addon.name, quantity: addon.quantity }) : addon.name}
                  note={addon.stage === 'post_shoot' ? t('account:receipt.addedAfter') : undefined}
                  amount={addon.amountRwf}
                />
              ))}
              <Line name={t('account:receipt.bookingFee')} amount={booking.bookingFeeRwf} muted />
            </tbody>
          </table>
        </section>

        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t pt-5">
          <p className="text-base font-medium">{t('account:receipt.amountPaid')}</p>
          <p className={cn(data, 'text-2xl font-semibold')}>{formatMoney(receipt.amountRwf)}</p>
        </div>

        {(receipt.refund.state !== 'none' || receipt.overpayment !== null) && (
          <section aria-labelledby="receipt-refund" className="flex flex-col gap-2">
            <h2 id="receipt-refund" className={eyebrow}>
              {t('account:receipt.refundTitle')}
            </h2>
            <MoneyBack payment={receipt} />
          </section>
        )}

        <p className="text-muted-foreground text-[0.8125rem]">{t('account:receipt.kigaliTime')}</p>
      </article>
    </>
  )
}

function Row({ label, mono = false, className, children }: { label: string; mono?: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <dt className={eyebrow}>{label}</dt>
      <dd className={cn('min-w-0 text-[0.9375rem] wrap-anywhere', mono && cn(data, 'tracking-wide'))}>{children}</dd>
    </div>
  )
}

function Line({ name, note, amount, muted = false }: { name: string; note?: string; amount: number; muted?: boolean }) {
  return (
    <tr className={cn('border-b last:border-b-0', muted && 'text-subtle-foreground')}>
      <th scope="row" className="py-2.5 pr-4 text-left align-top font-normal wrap-anywhere">
        {name}
        {note !== undefined && <span className="text-muted-foreground block text-[0.8125rem]">{note}</span>}
      </th>
      <td className={cn(data, 'py-2.5 text-right align-top whitespace-nowrap')}>{formatMoney(amount)}</td>
    </tr>
  )
}
