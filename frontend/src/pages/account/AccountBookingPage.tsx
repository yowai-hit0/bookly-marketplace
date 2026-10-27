import { ArrowRight, CircleAlert, Clock, SearchX } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'
import {
  type AccountBookingDetail,
  accountBookingPath,
  accountPaymentPath,
  cancelAccountBooking,
  fetchAccountBooking,
  safeCheckoutPath,
  startAccountSessionFeePayment,
} from '@/account/dashboard'
import { photographerPath } from '@/catalogue/api'
import type { ClientBooking } from '@/catalogue/booking-access'
import { type PaymentMethod, fetchPaymentMethods } from '@/catalogue/payments'
import { BackLink } from '@/components/ui/back-link'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { StatusBadgeVariantContext } from '@/components/ui/status-badge-context'
import { contactLinks } from '@/lib/contact'
import { formatDateTime } from '@/lib/format'
import { reportError } from '@/lib/report-error'
import { cn } from '@/lib/utils'
import { type BookingActions, BookingView } from '@/pages/booking/BookingView'
import { PaymentProgressPage } from '@/pages/checkout/PaymentProgressPage'
import { container, pageY, panel, panelTitle, textLink } from '@/pages/client/classes'
import { ContactList } from '@/pages/photographers/PhotographerContact'
import { MissingState } from './parts'

/**
 * `/account/bookings/:reference` (marketplace-spec R8.1; design-system/bookly/
 * pages/account-booking.md): one of the account's bookings, drawn by the guest
 * page's own parts (`BookingView`), authorised by the session instead of a
 * token. Pay the session fee, cancel under that photographer's policy, open
 * the delivery, and reach the photographer.
 *
 * A reference that is not the account's is the API's one 404, the same as one
 * that names nothing, so the page says "not found" for both and names no
 * booking. The contact-email change stays on the guest page: the booking's
 * emails are the booking's, not the account's.
 */

type Loaded = { key: string } & (
  | { status: 'ok'; detail: AccountBookingDetail; methods: PaymentMethod[] }
  | { status: 'missing' }
  | { status: 'failed' }
)

export function AccountBookingPage() {
  const { t } = useTranslation()
  const { reference = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${reference}:${attempt}`

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([fetchAccountBooking(reference, controller.signal), fetchPaymentMethods(controller.signal).catch(() => [])])
      .then(([detail, methods]) => {
        if (controller.signal.aborted) return
        setLoaded(detail === null ? { key, status: 'missing' } : { key, status: 'ok', detail, methods })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        reportError(error, 'account_booking_load_failed')
        setLoaded({ key, status: 'failed' })
      })
    return () => controller.abort()
  }, [reference, key])

  function reload() {
    setLoaded(null)
    setAttempt((n) => n + 1)
  }

  const current = loaded?.key === key ? loaded : null

  return (
    <StatusBadgeVariantContext.Provider value="console">
      <main className={cn(container, pageY, 'mx-auto flex max-w-3xl flex-col gap-6 text-pretty')}>
        <BackLink to="/account">{t('account:booking.back')}</BackLink>
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
        {current?.status === 'missing' && (
          <MissingState icon={SearchX} title={t('account:booking.notFoundTitle')} body={t('account:booking.notFoundBody')} />
        )}
        {current?.status === 'ok' && (
          <AccountBookingView
            key={attempt}
            reference={reference}
            detail={current.detail}
            methods={current.methods}
            onMissing={() => setLoaded({ key, status: 'missing' })}
            onReload={reload}
          />
        )}
      </main>
    </StatusBadgeVariantContext.Provider>
  )
}

function AccountBookingView({
  reference,
  detail,
  methods,
  onMissing,
  onReload,
}: {
  reference: string
  detail: AccountBookingDetail
  methods: PaymentMethod[]
  onMissing: () => void
  onReload: () => void
}) {
  const actions: BookingActions = {
    cancel: () => cancelAccountBooking(reference),
    pay: (request) => startAccountSessionFeePayment(reference, request),
    paymentPath: (ourRef) => accountPaymentPath(reference, ourRef),
  }
  return (
    <BookingView
      booking={detail.booking}
      methods={methods}
      actions={actions}
      onMissing={onMissing}
      onReload={onReload}
      afterSummary={(booking) => (
        <>
          <HeldNotice booking={booking} checkoutPath={detail.checkoutPath} holdExpiresAt={detail.holdExpiresAt} />
          <Photographer photographer={detail.photographer} />
        </>
      )}
    />
  )
}

/** A live hold, not yet a booking: until when, and its checkout page. */
function HeldNotice({
  booking,
  checkoutPath,
  holdExpiresAt,
}: {
  booking: ClientBooking
  checkoutPath: string | null
  holdExpiresAt: string | null
}) {
  const { t } = useTranslation()
  const checkout = safeCheckoutPath(checkoutPath)
  if (booking.status !== 'pending_payment' || checkout === null) return null
  return (
    <section className={cn(panel, 'flex flex-col gap-3 p-5 sm:p-6')}>
      <h2 className={panelTitle}>{t('account:booking.heldTitle')}</h2>
      <Callout variant="console" tone="info" icon={Clock}>
        <p>{t('account:booking.heldBody')}</p>
        {holdExpiresAt !== null && (
          <p>{t('account:booking.heldEnds', { time: formatDateTime(holdExpiresAt) })}</p>
        )}
      </Callout>
      <Button asChild className="self-start max-sm:w-full">
        <Link to={checkout}>
          {t('account:dashboard.finishPayment')}
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </section>
  )
}

/** Who the photographer is, how to reach them (only the channels they set), and their profile. */
function Photographer({ photographer }: { photographer: AccountBookingDetail['photographer'] }) {
  const { t } = useTranslation()
  const hasContact = contactLinks(photographer).length > 0
  return (
    <section className={cn(panel, 'flex flex-col gap-3 p-5 sm:p-6')}>
      <h2 className={panelTitle}>{t('account:booking.photographerTitle')}</h2>
      <p className="text-base font-medium wrap-anywhere">{photographer.displayName}</p>
      {hasContact ? (
        <ContactList contact={photographer} />
      ) : (
        <p className="text-subtle-foreground text-sm">{t('account:booking.noContact')}</p>
      )}
      <Link to={photographerPath(photographer.handle)} className={cn(textLink, 'self-start text-sm')}>
        {t('account:booking.profileLink')}
      </Link>
    </section>
  )
}

/** `/account/bookings/:reference/payments/:ourRef`: the guest progress page, with the way back to this booking. */
export function AccountPaymentProgressPage() {
  const { t } = useTranslation()
  const { reference = '' } = useParams()
  const back = accountBookingPath(reference)
  return <PaymentProgressPage payAgainAt={back} back={{ to: back, label: t('account:progress.back') }} />
}
