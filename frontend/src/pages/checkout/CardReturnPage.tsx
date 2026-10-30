import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'
import { bookingPath } from '@/catalogue/booking-access'
import { cardBookingToken } from '@/lib/card-payment'
import { cn } from '@/lib/utils'
import { textLink } from '@/pages/client/classes'
import { PaymentProgressPage } from './PaymentProgressPage'

/**
 * `/payments/:ourRef`: where Flutterwave returns a guest who paid a session
 * fee by card (marketplace-spec.md "Cards as built"). Token-free on purpose:
 * Flutterwave stores the return URL, and the booking's access token reads and
 * cancels the booking, so it is never put in one.
 *
 * The page is the usual progress page, polling by `ourRef` alone. The way back
 * to the booking is the token this tab kept under the payment's `ourRef`
 * before the modal opened (`rememberCardPayment`); it is used only in the
 * links below. Without it -- another tab, another device, cleared storage --
 * the page says to reopen the booking from its email, and offers the "email me
 * my links" page.
 */
export function CardReturnPage() {
  const { t } = useTranslation()
  const { ourRef = '' } = useParams()
  const token = cardBookingToken(ourRef)

  if (token !== null) {
    const booking = bookingPath(token)
    return <PaymentProgressPage payAgainAt={booking} back={{ to: booking, label: t('checkout:cardReturn.back') }} />
  }

  return (
    <PaymentProgressPage
      payAgainAt={null}
      footer={
        <div className="flex max-w-xl flex-col items-start gap-2 text-pretty" data-card-return="no-token">
          <p className="text-sm">{t('checkout:cardReturn.reopenFromEmail')}</p>
          <Link to="/my-booking" className={cn(textLink, 'text-sm')}>
            {t('booking:invalidLink.getNewLink')}
          </Link>
        </div>
      }
    />
  )
}
