import { ArrowRight, CircleAlert, ReceiptText, Undo2, WalletCards } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { kigaliDateOf } from '@/admin/calendar-dates'
import {
  type AccountPaymentRow,
  type AccountPaymentsPage,
  accountBookingPath,
  accountReceiptPath,
  fetchAccountPayments,
  methodLabel,
  pageOf,
} from '@/account/dashboard'
import { photographerPath } from '@/catalogue/api'
import { Button } from '@/components/ui/button'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { reportError } from '@/lib/report-error'
import { cn } from '@/lib/utils'
import { container, data, eyebrow, pageY, panel, textLink } from '@/pages/client/classes'
import { EmptyState, LoadFailed, LoadingRows, PageHead, Pagination, PaymentStatusBadge } from './parts'

/**
 * `/account/payments` (marketplace-spec R8.2; design-system/bookly/pages/
 * account-payments.md): every payment on the account's bookings, newest
 * first, from `GET /api/account/payments`: what it was for, how much, how it
 * was paid, where it stands, and any money owed or sent back. A payment that
 * took money links to its printable receipt.
 */

type Loaded = { key: string } & ({ status: 'ok'; page: AccountPaymentsPage } | { status: 'failed' })

export function AccountPayments() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const page = pageOf(params.get('page'))
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${page}:${attempt}`

  useEffect(() => {
    const controller = new AbortController()
    fetchAccountPayments(page, controller.signal).then(
      (answer) => !controller.signal.aborted && setLoaded({ key, status: 'ok', page: answer }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        reportError(error, 'account_payments_load_failed')
        setLoaded({ key, status: 'failed' })
      },
    )
    return () => controller.abort()
  }, [page, key])

  const current = loaded?.key === key ? loaded : null

  return (
    <main className={cn(container, pageY, 'flex flex-col gap-8')}>
      <PageHead icon={WalletCards} eyebrowText={t('auth:eyebrow.account')} title={t('account:payments.title')} lead={t('account:payments.lead')} />

      {current === null && <LoadingRows label={t('account:payments.loading')} />}
      {current?.status === 'failed' && <LoadFailed message={t('account:payments.loadFailed')} onRetry={() => setAttempt((n) => n + 1)} />}
      {current?.status === 'ok' &&
        (current.page.payments.length === 0 ? (
          <EmptyState icon={ReceiptText} title={t('account:payments.emptyTitle')} body={t('account:payments.emptyBody')} />
        ) : (
          <>
            <ul aria-label={t('account:payments.title')} className="flex flex-col gap-4">
              {current.page.payments.map((payment) => (
                <PaymentRow key={payment.ourRef} payment={payment} />
              ))}
            </ul>
            <Pagination
              page={current.page.page}
              pageCount={current.page.pageCount}
              hrefFor={(n) => (n > 1 ? `/account/payments?page=${n}` : '/account/payments')}
            />
          </>
        ))}
    </main>
  )
}

function PaymentRow({ payment }: { payment: AccountPaymentRow }) {
  const { t } = useTranslation()
  const method = methodLabel(t, payment.method)
  const { booking } = payment

  return (
    <li className={cn(panel, 'flex flex-col gap-4 p-5 sm:p-6')}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-lg leading-snug font-medium tracking-[-0.01em]">{t(`account:payments.kind.${payment.kind}`)}</h2>
          <p className={cn(data, 'text-2xl font-semibold tracking-[-0.01em]')}>{formatMoney(payment.amountRwf)}</p>
        </div>
        <PaymentStatusBadge status={payment.status} />
      </div>

      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <Fact label={t('account:payments.labels.booking')} className="sm:col-span-2">
          <span className="flex flex-col gap-0.5">
            <Link to={accountBookingPath(booking.reference)} className={cn(textLink, 'self-start wrap-anywhere')}>
              {t('booking:serviceValue', { service: booking.serviceName, package: booking.packageName })}
            </Link>
            <span className="text-subtle-foreground wrap-anywhere">
              <Link to={photographerPath(booking.photographer.handle)} className={cn(textLink, 'text-subtle-foreground')}>
                {booking.photographer.displayName}
              </Link>
              {' · '}
              <span className={data}>{booking.reference}</span>
              {' · '}
              {formatDate(kigaliDateOf(booking.startsAt))}
            </span>
          </span>
        </Fact>
        <Fact label={t('account:payments.labels.date')}>
          <span className={data}>{formatDateTime(payment.settledAt ?? payment.createdAt)}</span>
        </Fact>
        {method !== null && <Fact label={t('account:payments.labels.method')}>{method}</Fact>}
        <Fact label={t('account:payments.labels.reference')} className="sm:col-span-2">
          <span className={cn(data, 'text-[0.8125rem] wrap-anywhere')}>{payment.ourRef}</span>
        </Fact>
      </dl>

      {payment.status === 'failed' && payment.failure !== null && (
        <p className="text-destructive flex items-start gap-2 text-sm">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{t(`account:payments.failure.${payment.failure}`)}</span>
        </p>
      )}

      <MoneyBack payment={payment} />

      {payment.hasReceipt && (
        <div className="border-t pt-4">
          <Button asChild variant="outline" size="sm">
            <Link to={accountReceiptPath(payment.ourRef)}>
              <ReceiptText aria-hidden="true" />
              {t('account:payments.receipt')}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      )}
    </li>
  )
}

function Fact({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <dt className={eyebrow}>{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

/**
 * Money owed back or sent back, in words: a refund due (information, never
 * success), a refund made with its transfer reference, and the part of a
 * payment above what was asked. Nothing renders when there is none.
 */
export function MoneyBack({ payment }: { payment: Pick<AccountPaymentRow, 'refund' | 'overpayment'> }) {
  const { t } = useTranslation()
  const lines: { key: string; text: string; reference: string | null }[] = []
  const { refund, overpayment } = payment
  if (refund.state === 'due') lines.push({ key: 'refund', text: t('account:payments.refundDue', { amount: formatMoney(refund.amountRwf) }), reference: null })
  if (refund.state === 'refunded') {
    const amount = formatMoney(refund.amountRwf)
    lines.push({
      key: 'refund',
      text:
        refund.refundedAt === null
          ? t('account:payments.refundedNoDate', { amount })
          : t('account:payments.refunded', { amount, date: formatDate(kigaliDateOf(refund.refundedAt)) }),
      reference: refund.reference,
    })
  }
  if (overpayment !== null) {
    const amount = formatMoney(overpayment.amountRwf)
    lines.push({
      key: 'overpayment',
      text:
        overpayment.refundedAt === null
          ? t('account:payments.overpaid', { amount })
          : t('account:payments.overpaidRefunded', { amount, date: formatDate(kigaliDateOf(overpayment.refundedAt)) }),
      reference: overpayment.refundedAt === null ? null : overpayment.reference,
    })
  }
  if (lines.length === 0) return null

  return (
    <div className="bg-console-accent text-console-info-foreground flex flex-col gap-2 rounded-xs px-4 py-3.5 text-[0.9375rem] leading-snug">
      {lines.map((line) => (
        <div key={line.key} className="flex items-start gap-3">
          <Undo2 aria-hidden="true" className="text-console-info-icon mt-px size-4.5 shrink-0" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p>{line.text}</p>
            {line.reference !== null && (
              <p className="text-sm wrap-anywhere">
                {t('account:payments.transfer', { reference: line.reference })}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
