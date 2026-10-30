import {
  CalendarClock,
  CalendarDays,
  Camera,
  CircleAlert,
  CreditCard,
  ExternalLink,
  Hash,
  Images,
  Info,
  MapPin,
  MessageSquare,
  Smartphone,
  TriangleAlert,
  Undo2,
  Users,
} from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { kigaliDateOf } from '@/admin/calendar-dates'
import type { CancelBookingResult, ClientBooking } from '@/catalogue/booking-access'
import { isPlausiblePhone } from '@/catalogue/bookings'
import { type PayRequest, type PaymentMethod, type StartPaymentResult, needsPhoneFor } from '@/catalogue/payments'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { StatusBadge } from '@/components/ui/status-badge'
import { cardNavigationState, rememberCardPayment } from '@/lib/card-payment'
import { deadlineParts, deadlinePassed, termsSentence } from '@/lib/cancellation'
import { formatDate, formatMoney, formatTime } from '@/lib/format'
import { safeHttpsUrl } from '@/lib/safe-url'
import { useCardCheckout } from '@/lib/use-card-checkout'
import { cn } from '@/lib/utils'
import { data, eyebrow, pageTitle, panel, panelTitle } from '@/pages/client/classes'
import { FactGrid, FactTile } from '@/pages/client/FactGrid'
import { CardNotice } from '@/pages/checkout/CardNotice'
import { PaymentFields } from '@/pages/checkout/PaymentFields'
import { StageLegend } from '@/pages/StageLegend'
import { Notices } from './Notices'

/**
 * The parts of a client's booking page (plan.md Task 18; spec §3.9, §6.10),
 * shared since Phase 8 by the guest page and the client dashboard
 * (marketplace-spec R8.1: the detail page reuses the BookingPage components).
 * Every amount is the API's; nothing here adds anything up.
 *
 * Restyled to the console language (design-system/bookly/client-front.md
 * §8.5, decision 15, 2026-09-27): a mono eyebrow and status badge beside the
 * fixed "Your booking" h1, facts as a `FactGrid`, flat hairline panels and
 * console callouts for every notice. The page that renders it provides the
 * console badge mapping (`StatusBadgeVariantContext`).
 */

/**
 * What the page can do to the booking, and where a payment is followed: the
 * guest page addresses them by its access token, the dashboard by the
 * reference under the account's session (marketplace-spec R8.1). The outcomes
 * are the same either way, so every section below is written once.
 */
export type BookingActions = {
  cancel: () => Promise<CancelBookingResult>
  pay: (request: PayRequest) => Promise<StartPaymentResult>
  paymentPath: (ourRef: string) => string
  /**
   * The guest page's access token, kept in this tab under a card payment's
   * `ourRef` before its modal opens, so the token-free card return page
   * (`/payments/:ourRef`) can link back to the booking. The dashboard has none:
   * its return page is behind the session.
   */
  cardReturnToken?: string
}

type ViewProps = {
  booking: ClientBooking
  methods: PaymentMethod[]
  actions: BookingActions
  onMissing: () => void
  onReload: () => void
  /**
   * The sections after the facts and amounts that belong to one page alone:
   * the guest page's contact email, the dashboard's photographer and checkout
   * link. Handed the booking as it now stands, and how to replace it.
   */
  afterSummary?: (booking: ClientBooking, setBooking: (booking: ClientBooking) => void) => ReactNode
}

/**
 * One booking as its client sees it: the header, the notices, the facts and
 * amounts, the delivery, the session fee and the two-step cancel. Shared by
 * the guest page (`/booking/:token`) and the dashboard
 * (`/account/bookings/:reference`), each inside its own `main`.
 */
export function BookingView({ booking: loadedBooking, methods, actions, onMissing, onReload, afterSummary }: ViewProps) {
  const { t } = useTranslation()
  const [booking, setBooking] = useState(loadedBooking)
  // Lives here, not in the cancel section: a refusal usually arrives with a
  // booking that can no longer be cancelled, which takes that section away.
  const [refused, setRefused] = useState(false)
  // Cancelling unmounts the button that was pressed, so focus would otherwise
  // fall to the body with nothing said. It moves to the heading of the section
  // that replaced it instead, which is also what announces the outcome.
  const [announceCancelled, setAnnounceCancelled] = useState(false)
  const cancelledHeadingRef = useRef<HTMLHeadingElement>(null)
  // The deadline can pass while the page is open. The API refuses a late
  // cancellation whatever this page shows; this only stops offering one.
  const deadline = booking.cancellation.deadline
  const [deadlineReached, setDeadlineReached] = useState(() => deadlinePassed(deadline))
  const cancellable = booking.canCancel && !deadlineReached

  useEffect(() => {
    if (announceCancelled) cancelledHeadingRef.current?.focus()
  }, [announceCancelled])

  useEffect(() => {
    if (deadline === null || !booking.canCancel) return
    const wait = Date.parse(deadline) - Date.now()
    // A timer cannot wait past ~24.8 days; a deadline that far off is checked again on every press instead.
    if (wait > MAX_TIMEOUT_MS) return
    const timer = setTimeout(() => setDeadlineReached(true), Math.max(wait, 0))
    return () => clearTimeout(timer)
  }, [deadline, booking.canCancel])

  function settle(next: ClientBooking) {
    setBooking(next)
    if (next.cancelledAt !== null) setAnnounceCancelled(true)
  }

  return (
    <>
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <p className={eyebrow}>
            <CalendarDays aria-hidden="true" />
            {t('shell:nav.myBooking')}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h1 className={pageTitle}>{t('booking:title')}</h1>
            {/* The display stage (2026-09-25), and what each one means. */}
            <span className="inline-flex items-center gap-1">
              <StatusBadge status={booking.stage} size="md">
                {t(`booking:stage.${booking.stage}`)}
              </StatusBadge>
              <StageLegend audience="client" />
            </span>
          </div>
        </div>

        {/* What has happened since, newest first (2026-09-25). */}
        <Notices reference={booking.reference} notices={booking.notices} />

        <FactGrid className={cn(panel, 'p-5 sm:p-6')}>
          <FactTile icon={Hash} label={t('booking:labels.reference')} mono>
            {booking.reference}
          </FactTile>
          <FactTile icon={Camera} label={t('booking:labels.service')}>
            {t('booking:serviceValue', { service: booking.serviceName, package: booking.packageName })}
          </FactTile>
          <FactTile icon={CalendarClock} label={t('booking:labels.when')}>
            {t('booking:whenValue', {
              date: formatDate(kigaliDateOf(booking.startsAt)),
              start: formatTime(booking.startsAt),
              end: formatTime(booking.endsAt),
            })}
          </FactTile>
          <FactTile icon={MapPin} label={t('booking:labels.location')}>
            {booking.locationText}
          </FactTile>
          {booking.partySize !== null && (
            <FactTile icon={Users} label={t('booking:labels.people')}>
              {booking.partySize}
            </FactTile>
          )}
          <FactTile icon={Images} label={t('booking:labels.photos')}>
            {t('booking:photos', { count: booking.packagePhotoCount })}
          </FactTile>
          {booking.specialRequests !== null && (
            <FactTile icon={MessageSquare} label={t('booking:labels.requests')} className="sm:col-span-2">
              <span className="whitespace-pre-line">{booking.specialRequests}</span>
            </FactTile>
          )}
        </FactGrid>

        <Amounts booking={booking} />
      </section>

      {afterSummary?.(booking, setBooking)}

      {booking.delivery !== null && <Delivery delivery={booking.delivery} />}

      {booking.sessionFee !== null && (
        <SessionFee
          actions={actions}
          booking={booking}
          methods={methods}
          onMissing={onMissing}
          onReload={onReload}
        />
      )}

      {cancellable && (
        <Cancel
          actions={actions}
          booking={booking}
          onCancelled={settle}
          onRefused={() => setRefused(true)}
          onDeadlinePassed={() => setDeadlineReached(true)}
          onMissing={onMissing}
        />
      )}

      {/* A booking still standing whose cancellation window has closed says so, and when it closed. */}
      {!cancellable && !refused && booking.status === 'confirmed' && deadlinePassed(deadline) && (
        <CancelClosed deadline={deadline} />
      )}

      {refused && (
        <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
          <p>{t('booking:cancel.notCancellable')}</p>
        </Callout>
      )}

      {booking.cancelledAt !== null && (
        <section className={cn(panel, 'flex flex-col gap-3 p-5 sm:p-6')}>
          {/* `tabIndex={-1}` only so focus can be moved here; it stays out of the tab order. */}
          <h2 ref={cancelledHeadingRef} tabIndex={-1} className={cn(panelTitle, 'outline-none')}>
            {t('booking:cancelled.title')}
          </h2>
          {booking.cancellationReason !== null && (
            <p className="text-subtle-foreground text-sm wrap-anywhere">{booking.cancellationReason}</p>
          )}
          {booking.totals.refundDueRwf > 0 && (
            <Callout variant="console" tone="info" icon={Undo2}>
              {/* Owed, not yet refunded: information, never the success colour (checkout.md invariant). */}
              <p>{t('booking:cancelled.refund', { amount: formatMoney(booking.totals.refundDueRwf) })}</p>
            </Callout>
          )}
        </section>
      )}
    </>
  )
}

/** The longest delay `setTimeout` honours (2^31 - 1 ms); a longer one fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647

/** Every amount as the API computed it (data-model_v2.md §6.1): nothing is added up here. */
function Amounts({ booking }: { booking: ClientBooking }) {
  const { t } = useTranslation()
  return (
    <dl className={cn(panel, 'flex flex-col gap-2 p-5 text-sm sm:p-6')}>
      <div className="flex justify-between gap-4">
        <dt className="min-w-0 wrap-anywhere">{booking.packageName}</dt>
        <dd className={cn(data, 'shrink-0')}>{formatMoney(booking.packagePriceRwf)}</dd>
      </div>
      {booking.addons.map((addon, index) => (
        // Two add-ons may share a name; their order is the booking's own.
        <div key={index} className="flex justify-between gap-4">
          <dt className="min-w-0 wrap-anywhere">{addon.name}</dt>
          <dd className={cn(data, 'shrink-0')}>{formatMoney(addon.priceRwf)}</dd>
        </div>
      ))}
      <div className="mt-1 flex justify-between gap-4 border-t pt-2 font-semibold">
        <dt>{t('booking:labels.total')}</dt>
        <dd className={cn(data, 'shrink-0 text-base')}>{formatMoney(booking.totals.grandTotalRwf)}</dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt>{t('booking:labels.paid')}</dt>
        <dd className={cn(data, 'shrink-0')}>{formatMoney(booking.totals.collectedRwf)}</dd>
      </div>
      {/* What is still to pay is the number the client can act on, so it is a step heavier while it is above zero. */}
      <div className={cn('flex justify-between gap-4', booking.totals.outstandingRwf > 0 && 'font-semibold')}>
        <dt>{t('booking:labels.outstanding')}</dt>
        <dd className={cn(data, 'shrink-0')}>{formatMoney(booking.totals.outstandingRwf)}</dd>
      </div>
      {booking.totals.refundDueRwf > 0 && (
        <div className="text-destructive flex justify-between gap-4 font-medium">
          <dt>{t('booking:labels.refundDue')}</dt>
          <dd className={cn(data, 'shrink-0')}>{formatMoney(booking.totals.refundDueRwf)}</dd>
        </div>
      )}
    </dl>
  )
}

function Delivery({ delivery }: { delivery: NonNullable<ClientBooking['delivery']> }) {
  const { t } = useTranslation()
  const href = safeHttpsUrl(delivery.url)
  const ready = !delivery.expired && href !== null

  return (
    <section
      className={cn(
        panel,
        'flex flex-col gap-3 p-5 sm:p-6',
        // The photos are ready: the whole panel takes the success tint (client-front.md 8.5).
        ready && 'border-console-success/30 bg-console-success-tint',
      )}
    >
      <h2 className={panelTitle}>{t('booking:delivery.title')}</h2>
      {delivery.note !== null && <p className="text-sm wrap-anywhere">{delivery.note}</p>}
      {ready ? (
        <>
          <Button asChild className="self-start">
            <a href={href ?? undefined} rel="noreferrer noopener" target="_blank">
              {t('booking:delivery.open')}
              {/* It opens a new tab, so the arrow says so; the words already name the destination. */}
              <ExternalLink aria-hidden="true" data-icon="inline-end" />
            </a>
          </Button>
          {delivery.expiresOn !== null && (
            <p className="text-console-success text-sm">{t('booking:delivery.expires', { date: formatDate(delivery.expiresOn) })}</p>
          )}
        </>
      ) : (
        <Callout variant="console" tone="warning" icon={Info}>
          <p>{t('booking:delivery.expired')}</p>
        </Callout>
      )}
    </section>
  )
}

type SessionFeeProps = {
  actions: BookingActions
  booking: ClientBooking
  methods: PaymentMethod[]
  onMissing: () => void
  onReload: () => void
}

/** The payment control, shown only while something is outstanding (plan.md Task 18). */
function SessionFee({ actions, booking, methods, onMissing, onReload }: SessionFeeProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const idPrefix = useId()
  const [method, setMethod] = useState<PaymentMethod | null>(methods[0] ?? null)
  const [phoneInvalid, setPhoneInvalid] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<'rejected' | 'unavailable' | 'failed' | null>(null)
  const phoneRef = useRef<HTMLInputElement>(null)
  const payRef = useRef<HTMLButtonElement>(null)
  const card = useCardCheckout()
  const fee = booking.sessionFee === null ? 0 : booking.sessionFee.outstandingRwf
  const amount = formatMoney(fee)
  const phoneId = `${idPrefix}phone`
  const waiting = booking.sessionFee?.waitingPayment ?? null
  // Only an explicit `card` is a card checkout to reopen; no method reads as a phone prompt.
  const waitingCard = waiting !== null && waiting.method === 'card' && methods.includes('card')
  const busy = submitting || card.busy

  // Closing the modal, or failing to load it, hands the page back: focus returns to Pay, with the words below it.
  useEffect(() => {
    if (card.phase === 'closed' || card.phase === 'loadFailed') payRef.current?.focus()
  }, [card.phase])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || method === null) return

    const phone = String(new FormData(event.currentTarget).get('phone') ?? '').trim()
    const needsPhone = needsPhoneFor(method)
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
    const result = await actions.pay(request)
    setSubmitting(false)

    switch (result.status) {
      case 'card':
        // Before the modal, so a 3-D Secure redirect's full page load still knows the way back.
        rememberCardPayment(result.ourRef, actions.cardReturnToken)
        void card.open(result.card, (transactionId) => {
          void navigate(actions.paymentPath(result.ourRef), { state: cardNavigationState(transactionId) })
        })
        return
      case 'started':
        void navigate(actions.paymentPath(result.ourRef))
        return
      case 'in_progress':
        // A card checkout still open is followed as a card: its progress page speaks of a card, not a phone.
        if (result.method === 'card') rememberCardPayment(result.ourRef, actions.cardReturnToken)
        void navigate(actions.paymentPath(result.ourRef))
        return
      case 'not_found':
        onMissing()
        return
      case 'already_paid':
      case 'closed':
        onReload()
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
    // `#pay`: where a "still to pay" notice leads (2026-09-25).
    <section id="pay" className={cn(panel, 'flex scroll-mt-4 flex-col gap-4 p-5 sm:p-6')}>
      <div className="flex flex-col gap-1">
        <h2 className={panelTitle}>{t('booking:sessionFee.title')}</h2>
        <p className="text-sm">{t('booking:sessionFee.intro', { amount })}</p>
      </div>

      {waiting !== null && waitingCard && (
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
        <Callout variant="console" tone="info" icon={Smartphone}>
          <p>
            {t('checkout:waiting.text')}{' '}
            <Link
              to={actions.paymentPath(waiting.ourRef)}
              className="text-console-link hover:text-console-link-hover rounded-xs underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {t('checkout:waiting.link')}
            </Link>
          </p>
        </Callout>
      )}

      {methods.length === 0 ? (
        <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
          <p>{t('checkout:errors.noMethods')}</p>
        </Callout>
      ) : (
        // The method legend is the 12px mono label here and on the pay page (client-front.md 8.4), so it no longer needs sizing down under the card's h2.
        <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
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
            size="lg"
            className="w-full sm:w-auto sm:self-start"
            // Not `disabled`: that would drop keyboard focus mid-submit.
            aria-disabled={busy}
            aria-busy={busy}
          >
            {submitting ? t('checkout:paying') : card.busy ? t('checkout:card.opening') : t('booking:sessionFee.pay', { amount })}
          </Button>
          {error !== null && (
            <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
              <p>{t(`checkout:errors.${error}`)}</p>
            </Callout>
          )}
          <CardNotice phase={card.phase} />
        </form>
      )}
    </section>
  )
}

type CancelProps = {
  actions: BookingActions
  booking: ClientBooking
  onCancelled: (booking: ClientBooking) => void
  /** The API refused: said above this section, which the refusal may remove. */
  onRefused: () => void
  /** The deadline passed before a press: the section goes, and the closed notice says when. */
  onDeadlinePassed: () => void
  onMissing: () => void
}

/**
 * Cancelling, in two steps: the warning that says what happens to the booking
 * fee (spec §6.10; refunded or kept, as the booking's own terms say, R1.8)
 * stands between the button and the request, and says the amount. Above the
 * button, the terms and the deadline, so neither is a surprise.
 *
 * Each press checks the deadline first: once it has passed, nothing is sent
 * and the section closes. The API enforces the same deadline regardless.
 */
function Cancel({ actions, booking, onCancelled, onRefused, onDeadlinePassed, onMissing }: CancelProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<'failed' | null>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirming) confirmRef.current?.focus()
  }, [confirming])

  function tooLate(): boolean {
    if (!deadlinePassed(booking.cancellation.deadline)) return false
    onDeadlinePassed()
    return true
  }

  function start() {
    if (tooLate()) return
    setConfirming(true)
  }

  async function cancel() {
    if (cancelling || tooLate()) return
    setError(null)
    setCancelling(true)
    const result = await actions.cancel()
    setCancelling(false)

    if (result.status === 'cancelled') {
      onCancelled(result.booking)
      return
    }
    if (result.status === 'not_found') {
      onMissing()
      return
    }
    if (result.status === 'not_cancellable') {
      onRefused()
      if (result.booking !== null) onCancelled(result.booking)
      return
    }
    setError('failed')
  }

  return (
    <section className={cn(panel, 'flex flex-col gap-3 p-5 sm:p-6')}>
      <h2 className={panelTitle}>{t('booking:cancel.title')}</h2>
      <p className="text-subtle-foreground text-sm">{termsSentence(t, booking.cancellation)}</p>
      {confirming ? (
        <>
          <Callout variant="console" tone="destructive" icon={TriangleAlert}>
            <p className="font-medium">
              {t(booking.cancellation.bookingFeeRefundable ? 'booking:cancel.warningRefundable' : 'booking:cancel.warning', {
                fee: formatMoney(booking.bookingFeeRwf),
              })}
            </p>
          </Callout>
          {/* Stacked and full width on a phone, like the pay button: equal targets whose edges line up with the notice above. */}
          <div className="flex flex-col gap-2 sm:flex-row">
            {/* Irreversible, so it is the solid red variant rather than the tinted one that merely opens the question (MASTER section 6). */}
            <Button
              ref={confirmRef}
              variant="destructive-solid"
              onClick={() => void cancel()}
              aria-disabled={cancelling}
              aria-busy={cancelling}
            >
              {cancelling ? t('booking:cancel.cancelling') : t('booking:cancel.confirm')}
            </Button>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t('booking:cancel.keep')}
            </Button>
          </div>
        </>
      ) : (
        <Button variant="outline" className="self-start" onClick={start}>
          {t('booking:cancel.start')}
        </Button>
      )}
      {error !== null && (
        <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
          <p>{t(`booking:cancel.${error}`)}</p>
        </Callout>
      )}
    </section>
  )
}

/** Where the cancel section was: the window has closed, and when, in Kigali time. */
function CancelClosed({ deadline }: { deadline: string | null }) {
  const { t } = useTranslation()
  const closedAt = deadlineParts(deadline)
  if (closedAt === null) return null
  return (
    <section className={cn(panel, 'flex flex-col gap-3 p-5 sm:p-6')}>
      <h2 className={panelTitle}>{t('booking:cancel.title')}</h2>
      <p className="text-subtle-foreground text-sm">{t('booking:cancel.closed', closedAt)}</p>
    </section>
  )
}
