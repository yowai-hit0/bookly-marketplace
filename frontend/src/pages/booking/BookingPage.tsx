import { CircleAlert, MailCheck, Unlink } from 'lucide-react'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'
import {
  type ClientBooking,
  bookingPaymentPath,
  cancelBooking,
  fetchClientBooking,
  requestEmailChange,
  startSessionFeePayment,
} from '@/catalogue/booking-access'
import { type PaymentMethod, fetchPaymentMethods } from '@/catalogue/payments'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusBadgeVariantContext } from '@/components/ui/status-badge-context'
import { reportError } from '@/lib/report-error'
import { forgetBookingToken, rememberBookingToken } from '@/lib/stored-booking'
import { cn } from '@/lib/utils'
import { container, pageY, panel, panelTitle, statusTitle, textLink } from '@/pages/client/classes'
import { IconTile } from '@/pages/client/FactGrid'
import { type BookingActions, BookingView } from './BookingView'

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
          <GuestBookingView
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


/** The shared view, addressed by the access token; the contact email is this page's alone. */
function GuestBookingView({
  token,
  booking,
  methods,
  onMissing,
  onReload,
}: {
  token: string
  booking: ClientBooking
  methods: PaymentMethod[]
  onMissing: () => void
  onReload: () => void
}) {
  const actions: BookingActions = {
    cancel: () => cancelBooking(token),
    pay: (request) => startSessionFeePayment(token, request),
    paymentPath: (ourRef) => bookingPaymentPath(token, ourRef),
    // For the token-free card return page (`/payments/:ourRef`), in this tab only.
    cardReturnToken: token,
  }
  return (
    <BookingView
      booking={booking}
      methods={methods}
      actions={actions}
      onMissing={onMissing}
      onReload={onReload}
      afterSummary={(current, setBooking) =>
        CHANGEABLE_EMAIL_STATUSES.includes(current.status) && (
          <ContactEmail token={token} booking={current} onChanged={setBooking} onMissing={onMissing} />
        )
      }
    />
  )
}

/** A booking that still stands can still have its emails redirected; the API checks again. */
const CHANGEABLE_EMAIL_STATUSES = ['confirmed', 'completed']

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
