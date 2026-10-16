import { CircleCheck, Clock, Hourglass, Lock, Smartphone, TriangleAlert, Unlink, type LucideIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'
import { isPlausiblePhone } from '@/catalogue/bookings'
import {
  type Checkout,
  type PaymentMethod,
  fetchCheckout,
  fetchPaymentMethods,
  needsPhoneFor,
  paymentPath,
  startPayment,
} from '@/catalogue/payments'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { StatusIcon } from '@/components/ui/status-icon'
import { formatMoney, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { pageTitle, pageY, statusTitle } from '@/pages/client/classes'
import { BookingFacts } from './BookingFacts'
import { PaymentFields } from './PaymentFields'

/**
 * The pay page (plan.md Task 16, spec §3.1 step 9, §6.19): a held booking's
 * fee, the methods the active provider collects, and the number to prompt.
 *
 * Methods come from the API's capability endpoint. With MTN MoMo direct that is
 * MTN MoMo alone, and Airtel Money and card are not in the page at all -- not
 * disabled, absent. Starting a payment moves to its progress page, which waits
 * for the provider; nothing here ever says a payment succeeded.
 *
 * Addressed by the booking's reference and checkout token, so a reload lands
 * back here with nothing lost.
 *
 * Restyled per design-system/bookly/client-front.md §8.4: the facts as
 * metadata rows, the notices as console callouts before the form, and the
 * "paid / closed / expired / invalid" outcomes as status views (`statusTitle`).
 */

type Loaded = { key: string } & (
  | { status: 'ok'; checkout: Checkout; methods: PaymentMethod[] }
  | { status: 'missing' }
  | { status: 'failed' }
)

type SubmitError = 'rejected' | 'unavailable' | 'failed'

export function CheckoutPage() {
  const { t } = useTranslation()
  const { reference = '', token = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${reference}/${token}`

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([fetchCheckout(reference, token, controller.signal), fetchPaymentMethods(controller.signal)])
      .then(([checkout, methods]) => {
        if (controller.signal.aborted) return
        setLoaded(checkout === null ? { key, status: 'missing' } : { key, status: 'ok', checkout, methods })
      })
      .catch(() => !controller.signal.aborted && setLoaded({ key, status: 'failed' }))
    return () => controller.abort()
  }, [reference, token, key, attempt])

  function reload() {
    setLoaded(null)
    setAttempt((n) => n + 1)
  }

  // A load for another link is stale: show loading, not the previous booking.
  const current = loaded?.key === key ? loaded : null

  return (
    <main className={cn('mx-auto flex w-full max-w-2xl flex-col gap-6 px-4', pageY)}>
      {current === null && (
        <p className="text-muted-foreground text-sm" role="status">
          {t('checkout:loading')}
        </p>
      )}
      {current?.status === 'failed' && (
        <Callout variant="console" tone="destructive" icon={TriangleAlert} role="alert">
          <div className="flex flex-wrap items-center gap-3">
            <p>{t('checkout:loadFailed')}</p>
            <Button variant="outline" size="sm" onClick={reload}>
              {t('checkout:retry')}
            </Button>
          </div>
        </Callout>
      )}
      {current?.status === 'missing' && (
        <Notice icon={Unlink} tone="neutral" title={t('checkout:invalidLink.title')} body={t('checkout:invalidLink.body')} />
      )}
      {current?.status === 'ok' && (
        <CheckoutView
          key={attempt}
          reference={reference}
          token={token}
          checkout={current.checkout}
          methods={current.methods}
          onStale={reload}
          onMissing={() => setLoaded({ key, status: 'missing' })}
        />
      )}
    </main>
  )
}

type ViewProps = {
  reference: string
  token: string
  checkout: Checkout
  methods: PaymentMethod[]
  /** The booking changed under the page: paid, or its hold ended. */
  onStale: () => void
  onMissing: () => void
}

function CheckoutView({ reference, token, checkout, methods, onStale, onMissing }: ViewProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const idPrefix = useId()
  const [method, setMethod] = useState<PaymentMethod | null>(methods[0] ?? null)
  const [phoneInvalid, setPhoneInvalid] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<SubmitError | null>(null)
  const phoneRef = useRef<HTMLInputElement>(null)

  if (checkout.state === 'paid') {
    return <Notice icon={CircleCheck} tone="positive" title={t('checkout:paid.title')} body={t('checkout:paid.body')} />
  }
  if (checkout.state === 'closed') {
    return <Notice icon={Lock} tone="neutral" title={t('checkout:closed.title')} body={t('checkout:closed.body')} />
  }
  if (checkout.state === 'expired') {
    return (
      <Notice icon={Hourglass} tone="neutral" title={t('checkout:expired.title')} body={t('checkout:expired.body')}>
        <Button asChild variant="link" className="-ml-2.5 self-start">
          <Link to="/services">{t('checkout:expired.link')}</Link>
        </Button>
      </Notice>
    )
  }

  const fee = formatMoney(checkout.bookingFeeRwf)
  const phoneId = `${idPrefix}phone`
  const needsPhone = needsPhoneFor(method)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || method === null) return
    setError(null)

    const phone = String(new FormData(event.currentTarget).get('phone') ?? '').trim()
    if (needsPhone && !isPlausiblePhone(phone)) {
      setPhoneInvalid(true)
      phoneRef.current?.focus()
      return
    }
    setPhoneInvalid(false)

    setSubmitting(true)
    const result = await startPayment(reference, token, { method, phone: needsPhone ? phone : '' })
    setSubmitting(false)

    switch (result.status) {
      case 'started':
      case 'in_progress':
        void navigate(paymentPath(reference, token, result.ourRef))
        return
      case 'already_paid':
      case 'closed':
        onStale()
        return
      case 'not_found':
        onMissing()
        return
      case 'invalid':
        // Only a field on screen can be marked; anything else must still be said.
        if (needsPhone && result.fields.includes('phone')) {
          setPhoneInvalid(true)
          phoneRef.current?.focus()
        } else {
          setError('failed')
        }
        return
      case 'not_started':
        setError(result.reason)
        return
      case 'failed':
        setError('failed')
        return
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <h1 className={pageTitle}>{t('checkout:title')}</h1>

      <BookingFacts
        reference={checkout.reference}
        serviceName={checkout.serviceName}
        packageName={checkout.packageName}
        startsAt={checkout.startsAt}
        endsAt={checkout.endsAt}
      >
        {/* The fee is what the client is about to pay, so it is the emphasised number on the page. */}
        <div className="mt-1 flex items-baseline justify-between gap-4 border-t pt-3 text-base font-semibold">
          <dt>{t('checkout:summary.fee')}</dt>
          <dd className="font-mono tabular-nums">{fee}</dd>
        </div>
      </BookingFacts>

      {/* The notices are one group of related notes, so they sit closer to each other than to the form. */}
      <div className="flex flex-col gap-2">
        {checkout.holdExpiresAt !== null && (
          <Callout variant="console" tone="info" icon={Clock}>
            <p>{t('checkout:holdUntil', { time: formatTime(checkout.holdExpiresAt) })}</p>
          </Callout>
        )}
        <Callout variant="console" tone="warning" icon={TriangleAlert}>
          <p className="font-medium">{t('checkout:nonRefundable')}</p>
        </Callout>

        {checkout.waitingPayment !== null && (
          <Callout
            variant="console"
            tone="info"
            icon={Smartphone}
            action={
              <Link
                to={paymentPath(reference, token, checkout.waitingPayment.ourRef)}
                className="text-console-link hover:text-console-link-hover rounded-sm underline-offset-4 hover:underline"
              >
                {t('checkout:waiting.link')}
              </Link>
            }
          >
            <p>{t('checkout:waiting.text')}</p>
          </Callout>
        )}
      </div>

      {methods.length === 0 ? (
        <p className="text-destructive text-sm" role="alert">
          {t('checkout:errors.noMethods')}
        </p>
      ) : (
        <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
          <PaymentFields
            methods={methods}
            method={method}
            onMethod={setMethod}
            phoneId={phoneId}
            phoneRef={phoneRef}
            phoneInvalid={phoneInvalid}
          />

          <Button
            type="submit"
            className="h-12 w-full sm:w-auto sm:self-start"
            // Not `disabled`: that would drop keyboard focus mid-submit.
            aria-disabled={submitting}
            aria-busy={submitting}
          >
            {submitting ? t('checkout:paying') : t('checkout:pay', { amount: fee })}
          </Button>
          {error !== null && (
            <p className="text-destructive text-sm" role="alert">
              {t(`checkout:errors.${error}`)}
            </p>
          )}
        </form>
      )}
    </section>
  )
}

type NoticeProps = {
  icon: LucideIcon
  /** Positive only for a booking that is already paid; the rest are neutral. */
  tone: 'positive' | 'neutral'
  title: string
  body: string
  children?: ReactNode
}

function Notice({ icon, tone, title, body, children }: NoticeProps) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [title])
  return (
    <section className="flex max-w-xl flex-col gap-3 text-pretty">
      <StatusIcon icon={icon} tone={tone} />
      <h1 ref={headingRef} tabIndex={-1} className={cn(statusTitle, 'outline-none')}>
        {title}
      </h1>
      <p className="text-muted-foreground text-sm">{body}</p>
      {children}
    </section>
  )
}
