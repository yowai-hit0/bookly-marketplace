import { CircleAlert, MailCheck, TriangleAlert } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import { apiUrl } from '@/admin/api'
import { useAdminTheme } from '@/admin/theme'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AdminField } from './AdminField'
import { AdminAuthFrame } from './console/AuthFrame'
import { FIELD, QUIET_LINK } from './console/classes'

/**
 * `/admin/reset-password` (plan.md Task 7, spec §6.23, A-11). One route, two
 * jobs, told apart by whether the emailed link carried a token:
 *
 * - no token: ask for the email and have the API send the link;
 * - token: choose the new password and consume it.
 *
 * The token arrives in the URL **fragment** (`#token=…`), which browsers never
 * put in a request, so it reaches no server log, proxy or referrer header. It
 * is read here and sent once, in a POST body. Nothing stores it and no
 * navigation carries it.
 *
 * The request form always says the same thing, whether or not the address can
 * sign in here: the API answers 202 either way, so this page cannot and does
 * not reveal who has an account.
 *
 * Every shape sits in the console panel shared with `/admin/login`
 * (`AdminAuthFrame`), so arriving here from sign in lands somewhere that
 * visibly matches, not something phishing-shaped.
 */

/** Mirrors the API's own floor (`MIN_NEW_PASSWORD_LENGTH`). */
const MIN_PASSWORD_LENGTH = 12

/** The muted way back to sign in: a link, never a second button. */
const BACK_LINK = QUIET_LINK

type RequestStatus = 'idle' | 'submitting' | 'sent' | 'failed'
type ConfirmStatus = 'idle' | 'submitting' | 'done' | 'invalidToken' | 'failed'

export function AdminResetPassword() {
  // The admin theme (stored or system) applies here too; there is no toggle.
  useAdminTheme()
  const { hash } = useLocation()
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token')

  return token === null || token === '' ? <RequestLink /> : <ChoosePassword token={token} />
}

/** Step one: ask the API to email a link. */
function RequestLink() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<RequestStatus>('idle')

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get('email') ?? '')
    setStatus('submitting')

    try {
      const res = await fetch(apiUrl('/admin/auth/password-reset/request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      // 202 whether or not the address is the admin's; anything else is a fault
      // on our side, which is worth saying because no email is coming.
      setStatus(res.ok ? 'sent' : 'failed')
    } catch {
      setStatus('failed')
    }
  }

  // Sent replaces the intro and the form, so a second send cannot be used to
  // probe addresses. It is one rendering for every address (the same words,
  // icon and colour), because the page is never told which addresses exist.
  return (
    <AdminAuthFrame
      title={t('admin:resetPassword.requestTitle')}
      intro={status === 'sent' ? undefined : t('admin:resetPassword.requestBody')}
    >
      <div className="flex flex-col gap-4">
        {status === 'sent' ? (
          <p className="flex items-start gap-2 text-sm" role="status">
            <MailCheck aria-hidden="true" className="text-console-link mt-0.5 size-4 shrink-0" />
            <span>{t('admin:resetPassword.requestSent')}</span>
          </p>
        ) : (
          <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void onSubmit(event)}>
            <AdminField label={t('admin:resetPassword.email')}>
              {(props) => (
                <Input {...props} name="email" type="email" autoComplete="username" required className={FIELD} />
              )}
            </AdminField>
            {status === 'failed' && (
              <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{t('admin:resetPassword.requestFailed')}</span>
              </p>
            )}
            <Button type="submit" size="console" className="w-full" disabled={status === 'submitting'}>
              {status === 'submitting'
                ? t('admin:resetPassword.requestSubmitting')
                : t('admin:resetPassword.requestSubmit')}
            </Button>
          </form>
        )}
        <Link to="/admin/login" className={BACK_LINK}>
          {t('admin:resetPassword.backToSignIn')}
        </Link>
      </div>
    </AdminAuthFrame>
  )
}

/** Step two: the emailed link carried a token, so choose the new password. */
function ChoosePassword({ token }: { token: string }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<ConfirmStatus>('idle')
  const [invalid, setInvalid] = useState<'tooShort' | 'mismatch' | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const newPassword = String(data.get('newPassword') ?? '')
    const repeated = String(data.get('confirmPassword') ?? '')

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setInvalid('tooShort')
      return
    }
    if (newPassword !== repeated) {
      setInvalid('mismatch')
      return
    }
    setInvalid(null)
    setStatus('submitting')

    try {
      const res = await fetch(apiUrl('/admin/auth/password-reset/confirm'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      })
      if (res.status === 204) {
        setStatus('done')
        return
      }
      // A 400 here is the token: the length is checked above, so the only
      // malformed body this page can send is one with a spent or expired token.
      setStatus(res.status === 400 ? 'invalidToken' : 'failed')
    } catch {
      setStatus('failed')
    }
  }

  if (status === 'done') {
    return (
      <AdminAuthFrame title={t('admin:resetPassword.doneTitle')}>
        <div className="flex flex-col gap-4">
          <p className="text-sm" role="status">
            {t('admin:resetPassword.doneBody')}
          </p>
          {/* The one shape where the way out is a button: the job is finished
              and there is exactly one next thing to do. */}
          <Button asChild size="console" className="w-full">
            <Link to="/admin/login">{t('admin:resetPassword.backToSignIn')}</Link>
          </Button>
        </div>
      </AdminAuthFrame>
    )
  }

  return (
    <AdminAuthFrame title={t('admin:resetPassword.chooseTitle')} intro={t('admin:resetPassword.chooseBody')}>
      <div className="flex flex-col gap-4">
        <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void onSubmit(event)}>
          <AdminField
            label={t('admin:resetPassword.newPassword')}
            hint={t('admin:resetPassword.passwordHint')}
            error={invalid === 'tooShort' ? t('admin:resetPassword.tooShort') : null}
          >
            {(props) => (
              <Input {...props} name="newPassword" type="password" autoComplete="new-password" required className={FIELD} />
            )}
          </AdminField>
          <AdminField
            label={t('admin:resetPassword.confirmPassword')}
            error={invalid === 'mismatch' ? t('admin:resetPassword.mismatch') : null}
          >
            {(props) => (
              <Input
                {...props}
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                className={FIELD}
              />
            )}
          </AdminField>

          {(status === 'invalidToken' || status === 'failed') && (
            <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
              {/* The dead end keeps its warning triangle, so it does not read as
                  a retry-worthy failure: only a new link helps. */}
              {status === 'invalidToken' ? (
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              ) : (
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              )}
              <span>
                {t(status === 'invalidToken' ? 'admin:resetPassword.invalidToken' : 'admin:resetPassword.chooseFailed')}
              </span>
            </p>
          )}

          <Button type="submit" size="console" className="w-full" disabled={status === 'submitting'}>
            {status === 'submitting'
              ? t('admin:resetPassword.chooseSubmitting')
              : t('admin:resetPassword.chooseSubmit')}
          </Button>
        </form>
        <Link to="/admin/login" className={BACK_LINK}>
          {t('admin:resetPassword.backToSignIn')}
        </Link>
      </div>
    </AdminAuthFrame>
  )
}
