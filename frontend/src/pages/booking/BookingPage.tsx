import {
  CalendarClock,
  CalendarDays,
  Camera,
  CircleAlert,
  ExternalLink,
  Hash,
  Images,
  Info,
  MailCheck,
  MapPin,
  MessageSquare,
  Smartphone,
  TriangleAlert,
  Undo2,
  Unlink,
  Users,
} from 'lucide-react'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'
import { kigaliDateOf } from '@/admin/calendar-dates'
import {
  type ClientBooking,
  bookingPaymentPath,
  cancelBooking,
  fetchClientBooking,
  requestEmailChange,
  startSessionFeePayment,
} from '@/catalogue/booking-access'
import { isPlausiblePhone } from '@/catalogue/bookings'
import { type PaymentMethod, fetchPaymentMethods, needsPhoneFor } from '@/catalogue/payments'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusBadge } from '@/components/ui/status-badge'
import { StatusBadgeVariantContext } from '@/components/ui/status-badge-context'
import { deadlineParts, deadlinePassed, termsSentence } from '@/lib/cancellation'
import { formatDate, formatMoney, formatTime } from '@/lib/format'
import { reportError } from '@/lib/report-error'
import { safeHttpsUrl } from '@/lib/safe-url'
import { forgetBookingToken, rememberBookingToken } from '@/lib/stored-booking'
import { cn } from '@/lib/utils'
import { container, data, eyebrow, pageTitle, pageY, panel, panelTitle, statusTitle, textLink } from '@/pages/client/classes'
import { FactGrid, FactTile, IconTile } from '@/pages/client/FactGrid'
import { StageLegend } from '@/pages/StageLegend'
import { Notices } from './Notices'
import { PaymentFields } from '@/pages/checkout/PaymentFields'

/**
 * A client's own booking (plan.md Task 18; spec §3.9, §6.10): where they check
 * what they booked and what it cost, pay what is still owed, open their photos,
 * and cancel.
 *
 * The access token in the path is the whole of their identity, so the page
 * sends nothing else -- no reference, no id -- and an invalid, expired or
 * replaced token gets the same "link is not valid" page as one that never
 * existed. Every amount is the API's; nothing here adds anything up.
 *
 * Restyled to the console language (design-system/bookly/client-front.md
 * §8.5, decision 15, 2026-09-27): a mono eyebrow and status badge beside the
 * fixed "Your booking" h1 (switched to the console badge mapping through
 * `StatusBadgeVariantContext`), facts as a `FactGrid`, flat hairline panels in
 * place of the old shadowed cards, and console callouts for every notice.
 */

type Loaded =
  | { status: 'ok'; booking: ClientBooking; methods: PaymentMethod[] }
  | { status: 'missing' }
  | { status: 'failed' }

export function BookingPage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<(Loaded & { key: string }) | null>(null)
  const key = `${token}:${attempt}`

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([fetchClientBooking(token, controller.signal), fetchPaymentMethods(controller.signal).catch(() => [])])
      .then(([booking, methods]) => {
        if (controller.signal.aborted) return
        // This device remembers the last booking it opened, for the header's
        // "My booking"; a link that no longer works is forgotten (2026-09-25).
        if (booking === null) forgetBookingToken(token)
        else rememberBookingToken(token)
        setLoaded(booking === null ? { key, status: 'missing' } : { key, status: 'ok', booking, methods })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        reportError(error, 'client_booking_load_failed')
        setLoaded({ key, status: 'failed' })
      })
    return () => controller.abort()
  }, [token, key])

  function reload() {
    setLoaded(null)
    setAttempt((n) => n + 1)
  }

  const current = loaded?.key === key ? loaded : null

  return (
    // The console badge mapping (admin-console.md §5), for the pill and the
    // stage legend's popover alike (2026-09-27). `text-pretty` is inherited,
    // so no notice on a phone ends on a single stranded word.
    <StatusBadgeVariantContext.Provider value="console">
      <main className={cn(container, pageY, 'mx-auto flex max-w-3xl flex-col gap-6 text-pretty')}>
        {current === null && (
          <p className="text-muted-foreground text-sm" role="status">
            {t('booking:loading')}
          </p>
        )}
        {current?.status === 'failed' && (
          <Callout
            variant="console"
            tone="destructive"
            icon={CircleAlert}
            role="alert"
            action={
              <Button variant="outline" size="sm" onClick={reload}>
                {t('booking:retry')}
              </Button>
            }
          >
            <p>{t('booking:loadFailed')}</p>
          </Callout>
        )}
        {current?.status === 'missing' && <InvalidLink />}
        {current?.status === 'ok' && (
          <BookingView
            key={attempt}
            token={token}
            booking={current.booking}
            methods={current.methods}
            onMissing={() => {
              forgetBookingToken(token)
              setLoaded({ key, status: 'missing' })
            }}
            onReload={reload}
          />
        )}
      </main>
    </StatusBadgeVariantContext.Provider>
  )
}

function InvalidLink() {
  const { t } = useTranslation()
  return (
    <section className="flex flex-col items-start gap-4 text-pretty">
      <IconTile icon={Unlink} tone="neutral" size="lg" />
      <h1 className={statusTitle}>{t('booking:invalidLink.title')}</h1>
      <p className="text-subtle-foreground text-base">{t('booking:invalidLink.body')}</p>
      {/* The way back in when the link is gone (2026-09-25): a link, not a button. */}
      <Link to="/my-booking" className={textLink}>
        {t('booking:invalidLink.getNewLink')}
      </Link>
    </section>
  )
}

type ViewProps = {
  token: string
  booking: ClientBooking
  methods: PaymentMethod[]
  onMissing: () => void
  onReload: () => void
}

function BookingView({ token, booking: loadedBooking, methods, onMissing, onReload }: ViewProps) {
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

      {CHANGEABLE_EMAIL_STATUSES.includes(booking.status) && (
        <ContactEmail token={token} booking={booking} onChanged={setBooking} onMissing={onMissing} />
      )}

      {booking.delivery !== null && <Delivery delivery={booking.delivery} />}

      {booking.sessionFee !== null && (
        <SessionFee
          token={token}
          booking={booking}
          methods={methods}
          onMissing={onMissing}
          onReload={onReload}
        />
      )}

      {cancellable && (
        <Cancel
          token={token}
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

/** A booking that still stands can still have its emails redirected; the API checks again. */
const CHANGEABLE_EMAIL_STATUSES = ['confirmed', 'completed']

/** The longest delay `setTimeout` honours (2^31 - 1 ms); a longer one fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * Where the booking's emails go, and changing it (2026-09-25). The API only
 * ever sends the address masked (`a•••••@example.com`), so a link that is
 * forwarded or leaked does not give the email away. A change is only asked
 * for here: it takes effect once the NEW address clicks the link we send it,
 * and until then the page says so.
 */
function ContactEmail({
  token,
  booking,
  onChanged,
  onMissing,
}: {
  token: string
  booking: ClientBooking
  onChanged: (booking: ClientBooking) => void
  onMissing: () => void
}) {
  const { t } = useTranslation()
  const fieldId = useId()
  const fieldRef = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [status, setStatus] = useState<'idle' | 'sending' | 'invalid' | 'failed' | 'rate_limited'>('idle')
  const [message, setMessage] = useState<{ kind: 'sent'; email: string } | { kind: 'unchanged' } | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (status === 'sending') return
    const form = event.currentTarget
    const email = String(new FormData(form).get('email') ?? '').trim()
    if (email === '' || !form.checkValidity()) {
      setStatus('invalid')
      fieldRef.current?.focus()
      return
    }
    setStatus('sending')
    const result = await requestEmailChange(token, email)
    switch (result.status) {
      case 'requested':
      case 'unchanged':
      case 'not_allowed':
        if (result.booking !== null) onChanged(result.booking)
        setEditing(false)
        setStatus('idle')
        // The address just typed is the client's own, so it may be shown back in full.
        setMessage(result.status === 'requested' ? { kind: 'sent', email } : result.status === 'unchanged' ? { kind: 'unchanged' } : null)
        return
      case 'not_found':
        onMissing()
        return
      case 'invalid':
        setStatus('invalid')
        fieldRef.current?.focus()
        return
      default:
        setStatus(result.status)
    }
  }

  return (
    <section className={cn(panel, 'flex flex-col gap-4 p-5 sm:p-6')}>
      <h2 className={panelTitle}>{t('booking:contact.title')}</h2>
      <p className="text-sm">{t('booking:contact.current', { email: booking.maskedEmail })}</p>

      {message?.kind === 'sent' ? (
        <Callout variant="console" tone="info" icon={MailCheck} role="status">
          <p>{t('booking:contact.sent', { email: message.email, current: booking.maskedEmail })}</p>
        </Callout>
      ) : (
        booking.pendingMaskedEmail !== null && (
          <Callout variant="console" tone="info" icon={MailCheck}>
            <p>{t('booking:contact.pending', { email: booking.pendingMaskedEmail, current: booking.maskedEmail })}</p>
          </Callout>
        )
      )}
      {message?.kind === 'unchanged' && (
        <p className="text-muted-foreground text-sm" role="status">
          {t('booking:contact.unchanged')}
        </p>
      )}

      {editing ? (
        <form onSubmit={submit} noValidate className="flex flex-col gap-2">
          <Label htmlFor={fieldId}>{t('booking:contact.newEmail')}</Label>
          <Input
            ref={fieldRef}
            id={fieldId}
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            aria-invalid={status === 'invalid' || undefined}
            aria-describedby={`${fieldId}-hint${status === 'invalid' ? ` ${fieldId}-error` : ''}`}
          />
          <p id={`${fieldId}-hint`} className="text-muted-foreground text-sm">
            {t('booking:contact.hint')}
          </p>
          {status === 'invalid' && (
            <p id={`${fieldId}-error`} className="text-destructive flex items-center gap-1.5 text-sm">
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              {t('booking:contact.invalid')}
            </p>
          )}
          {(status === 'failed' || status === 'rate_limited') && (
            <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
              <p>{t(status === 'failed' ? 'booking:contact.failed' : 'booking:contact.rateLimited')}</p>
            </Callout>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" aria-disabled={status === 'sending'}>
              {status === 'sending' ? t('booking:contact.saving') : t('booking:contact.save')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(false)
                setStatus('idle')
              }}
            >
              {t('booking:contact.keep')}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            setMessage(null)
            setEditing(true)
          }}
        >
          {t('booking:contact.change')}
        </Button>
      )}
    </section>
  )
}

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
  token: string
  booking: ClientBooking
  methods: PaymentMethod[]
  onMissing: () => void
  onReload: () => void
}

/** The payment control, shown only while something is outstanding (plan.md Task 18). */
function SessionFee({ token, booking, methods, onMissing, onReload }: SessionFeeProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const idPrefix = useId()
  const [method, setMethod] = useState<PaymentMethod | null>(methods[0] ?? null)
  const [phoneInvalid, setPhoneInvalid] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<'rejected' | 'unavailable' | 'failed' | null>(null)
  const phoneRef = useRef<HTMLInputElement>(null)
  const fee = booking.sessionFee === null ? 0 : booking.sessionFee.outstandingRwf
  const amount = formatMoney(fee)
  const phoneId = `${idPrefix}phone`
  const waiting = booking.sessionFee?.waitingPayment ?? null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || method === null) return
    setError(null)

    const phone = String(new FormData(event.currentTarget).get('phone') ?? '').trim()
    const needsPhone = needsPhoneFor(method)
    if (needsPhone && !isPlausiblePhone(phone)) {
      setPhoneInvalid(true)
      phoneRef.current?.focus()
      return
    }
    setPhoneInvalid(false)

    setSubmitting(true)
    const result = await startSessionFeePayment(token, { method, phone: needsPhone ? phone : '' })
    setSubmitting(false)

    switch (result.status) {
      case 'started':
      case 'in_progress':
        void navigate(bookingPaymentPath(token, result.ourRef))
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
    // `#pay`: where a "still to pay" notice leads (2026-09-25).
    <section id="pay" className={cn(panel, 'flex scroll-mt-4 flex-col gap-4 p-5 sm:p-6')}>
      <div className="flex flex-col gap-1">
        <h2 className={panelTitle}>{t('booking:sessionFee.title')}</h2>
        <p className="text-sm">{t('booking:sessionFee.intro', { amount })}</p>
      </div>

      {waiting !== null && (
        <Callout variant="console" tone="info" icon={Smartphone}>
          <p>
            {t('checkout:waiting.text')}{' '}
            <Link
              to={bookingPaymentPath(token, waiting.ourRef)}
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
            type="submit"
            size="lg"
            className="w-full sm:w-auto sm:self-start"
            // Not `disabled`: that would drop keyboard focus mid-submit.
            aria-disabled={submitting}
            aria-busy={submitting}
          >
            {submitting ? t('checkout:paying') : t('booking:sessionFee.pay', { amount })}
          </Button>
          {error !== null && (
            <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
              <p>{t(`checkout:errors.${error}`)}</p>
            </Callout>
          )}
        </form>
      )}
    </section>
  )
}

type CancelProps = {
  token: string
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
function Cancel({ token, booking, onCancelled, onRefused, onDeadlinePassed, onMissing }: CancelProps) {
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
    const result = await cancelBooking(token)
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
