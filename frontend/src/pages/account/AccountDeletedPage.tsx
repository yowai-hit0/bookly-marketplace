import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import { forgetAccountMe } from '@/auth/account'
import { clearSession } from '@/auth/session'
import { Button } from '@/components/ui/button'
import { AuthFrame } from '@/pages/auth/kit'

/** Set by the deletion as it lands here: the session it ended is forgotten now. */
export type DeletedLocationState = { deleted?: boolean } | null

/**
 * `/account/deleted`: where deleting the account lands (marketplace-spec R8.3,
 * decision 4). Nothing loaded: the words, and the two ways on (home, and the
 * lost-link page for the bookings that carry on).
 *
 * The deletion arrives with `state.deleted`, and the session is forgotten
 * here, once this page (outside the account guard) is on screen: forgetting it
 * on the profile would have that page's guard send the visitor to sign in
 * first. The token is dead on the API either way. Opening the address by hand
 * signs no one out.
 */
export function AccountDeletedPage() {
  const { t } = useTranslation()
  const location = useLocation()
  const deleted = (location.state as DeletedLocationState)?.deleted === true

  useEffect(() => {
    if (!deleted) return
    forgetAccountMe()
    clearSession('account')
  }, [deleted])

  return (
    <AuthFrame area="account" title={t('account:deleted.title')} intro={t('account:deleted.body')}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button asChild>
          <Link to="/">{t('shell:footer.home')}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/my-booking">{t('account:deleted.findBooking')}</Link>
        </Button>
      </div>
    </AuthFrame>
  )
}
