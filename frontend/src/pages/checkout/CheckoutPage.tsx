import { CircleCheck, Clock, CreditCard, Hourglass, Lock, Smartphone, TriangleAlert, Undo2, Unlink, type LucideIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'
import { isPlausiblePhone } from '@/catalogue/bookings'
import {
  type Checkout,
  type PayRequest,
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
import { cardNavigationState, rememberCardPayment } from '@/lib/card-payment'
import { termsSentence } from '@/lib/cancellation'
import { formatMoney, formatTime } from '@/lib/format'
import { useCardCheckout } from '@/lib/use-card-checkout'
import { cn } from '@/lib/utils'
import { pageTitle, pageY, statusTitle } from '@/pages/client/classes'
import { BookingFacts } from './BookingFacts'
import { CardNotice } from './CardNotice'
import { PaymentFields } from './PaymentFields'

/**
 * The pay page (plan.md Task 16, spec §3.1 step 9, §6.19): a held booking's
 * fee, the methods on offer, and the number to prompt.
 *
 * Methods come from the API's capability endpoint, which lists only what is
 * routed to a configured provider (marketplace-spec.md R3.1): MTN MoMo alone,
 * Airtel Money alone, or both. A method not listed is not in the page at all --
 * not disabled, absent. A photographer who can no longer be booked is said so
 * at the button, and nothing is charged (R3.4). Starting a payment moves to its progress page, which waits
 * for the provider; nothing here ever says a payment succeeded.
 *
 * A card (Flutterwave v3 Inline, "Cards as built") asks for no number: the API
 * answers the Inline config, and Flutterwave's modal opens on this page
 * (`useCardCheckout`). Its callback moves to the progress page with the try's
 * transaction id; closing it stays here and says nothing was charged. A card
 * checkout still open (`waitingPayment.method: 'card'`) is offered again: the
 * API answers the same payment and config.
 *
 * Addressed by the booking's reference and checkout token, so a reload lands
 * back here with nothing lost.
 *
 * The cancellation notice states the booking's own terms, as it kept them when
 * it was made (R1.8): whether cancelling refunds the booking fee, and until
 * when the client can cancel.
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

type SubmitError = 'rejected' | 'unavailable' | 'failed' | 'photographerUnavailable'

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
  const payRef = useRef<HTMLButtonElement>(null)
  const card = useCardCheckout()
  // Closing the modal, or failing to load it, hands the page back: focus returns to Pay, with the words below it.
  useEffect(() => {
    if (card.phase === 'closed' || card.phase === 'loadFailed') payRef.current?.focus()
  }, [card.phase])

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
          <Link to="/photographers">{t('checkout:expired.link')}</Link>
        </Button>
      </Notice>
    )
  }

  const fee = formatMoney(checkout.bookingFeeRwf)
  const phoneId = `${idPrefix}phone`
  const needsPhone = needsPhoneFor(method)
  const busy = submitting || card.busy
  const waiting = checkout.waitingPayment
  const waitingCard = waiting !== null && waiting.method === 'card' && methods.includes('card')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || method === null) return

    const phone = String(new FormData(event.currentTarget).get('phone') ?? '').trim()
    if (needsPhone && !isPlausiblePhone(phone)) {
      setError(null)
      card.reset()
      setPhoneInvalid(true)
      phoneRef.current?.focus()
      return
    }
    setPhoneInvalid(false)
    await pay({ method, phone: needsPhone ? phone : '' })
  }

  async function pay(request: PayRequest) {
    if (busy) return
    setError(null)
    card.reset()
    setSubmitting(true)
    const result = await startPayment(reference, token, request)
    setSubmitting(false)

    switch (result.status) {
      case 'card':
        // Before the modal: a 3-D Secure redirect reloads the progress page, which then still knows it is a card.
        rememberCardPayment(result.ourRef)
        void card.open(result.card, (transactionId) => {
          void navigate(paymentPath(reference, token, result.ourRef), { state: cardNavigationState(transactionId) })
        })
        return
      case 'started':
        void navigate(paymentPath(reference, token, result.ourRef))
        return
      case 'in_progress':
        // A card checkout still open is followed as a card: its progress page speaks of a card, not a phone.
        if (result.method === 'card') rememberCardPayment(result.ourRef)
        void navigate(paymentPath(reference, token, result.ourRef))
        return
      case 'already_paid':
      case 'closed':
        onStale()
        return
      case 'not_found':
        onMissing()
        return
      case 'photographer_unavailable':
        setError('photographerUnavailable')
        return
      case 'invalid':
        // Only a field on screen can be marked; anything else must still be said.
        if (needsPhoneFor(request.method) && result.fields.includes('phone')) {
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
        {/* A fee kept on cancelling is a warning; a refundable one is information. */}
        {checkout.cancellation.bookingFeeRefundable ? (
          <Callout variant="console" tone="info" icon={Undo2}>
            <p>{termsSentence(t, checkout.cancellation)}</p>
          </Callout>
        ) : (
          <Callout variant="console" tone="warning" icon={TriangleAlert}>
            <p className="font-medium">{termsSentence(t, checkout.cancellation)}</p>
          </Callout>
        )}

        {waiting !== null && waitingCard && (
          // A card checkout still open: reopening asks the API again, which answers the same payment and config.
          <Callout
            variant="console"
            tone="info"
            icon={CreditCard}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void pay({ method: 'card', phone: '' })}
                aria-disabled={busy}
                data-card-reopen=""
              >
                {busy ? t('checkout:card.reopening') : t('checkout:card.reopen')}
              </Button>
            }
          >
            <p>{t('checkout:card.waitingText')}</p>
          </Callout>
        )}
        {waiting !== null && !waitingCard && (
          <Callout
            variant="console"
            tone="info"
            icon={Smartphone}
            action={
              <Link
                to={paymentPath(reference, token, waiting.ourRef)}
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
            ref={payRef}
            type="submit"
            className="h-12 w-full sm:w-auto sm:self-start"
            // Not `disabled`: that would drop keyboard focus mid-submit.
            aria-disabled={busy}
            aria-busy={busy}
          >
            {submitting ? t('checkout:paying') : card.busy ? t('checkout:card.opening') : t('checkout:pay', { amount: fee })}
          </Button>
          {error !== null && (
            <p className="text-destructive text-sm" role="alert">
              {t(`checkout:errors.${error}`)}
            </p>
          )}
          <CardNotice phase={card.phase} />
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
