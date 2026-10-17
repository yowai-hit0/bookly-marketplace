import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import { ApiError } from '@/auth/api'
import { AREA_PATHS } from '@/auth/areas'
import { MIN_PASSWORD_LENGTH, confirmPasswordReset, requestPasswordReset } from '@/auth/client'
import type { Area } from '@/auth/session'
import { Button } from '@/components/ui/button'
import { AdminField } from '@/pages/admin/AdminField'
import { AuthFrame, AuthInput, AuthLink, FormAlert, SentNotice, SubmitButton } from './kit'
import { lookOf } from './look'

/**
 * `/{studio,platform,account}/reset-password` (plan.md Task 7, spec §6.23,
 * A-11; one per area since Phase 2, R2.1a). One route, two jobs, told apart by
 * whether the emailed link carried a token:
 *
 * - no token: ask for the email and have the API send the link;
 * - token: choose the new password and consume it.
 *
 * The token arrives in the URL **fragment** (`#token=…`), which browsers never
 * put in a request, so it reaches no server log, proxy or referrer header. It
 * is read here and sent once, in a POST body. Nothing stores it and no
 * navigation carries it. A token works only in the area that issued it.
 *
 * The request form always says the same thing, whether or not the address can
 * sign in here: the API answers 202 either way, so this page cannot and does
 * not reveal who has an account.
 *
 * Every shape sits in the same panel as the area's login (`AuthFrame`), so
 * arriving here from sign in lands somewhere that visibly matches, not
 * something phishing-shaped.
 */

type RequestStatus = 'idle' | 'submitting' | 'sent' | 'rateLimited' | 'failed'
type ConfirmStatus = 'idle' | 'submitting' | 'done' | 'invalidToken' | 'rateLimited' | 'failed'

export function ResetPasswordPage({ area }: { area: Area }) {
  const { hash } = useLocation()
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token')

  return token === null || token === '' ? <RequestLink area={area} /> : <ChoosePassword area={area} token={token} />
}

/** Step one: ask the API to email a link. */
function RequestLink({ area }: { area: Area }) {
  const { t } = useTranslation()
  const look = lookOf(area)
  const [status, setStatus] = useState<RequestStatus>('idle')

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get('email') ?? '')
    setStatus('submitting')

    try {
      // 202 whether or not the address can sign in here; anything else is a
      // fault on our side, which is worth saying because no email is coming.
      await requestPasswordReset(area, email)
      setStatus('sent')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 429 ? 'rateLimited' : 'failed')
    }
  }

  // Sent replaces the intro and the form, so a second send cannot be used to
  // probe addresses. It is one rendering for every address (the same words,
  // icon and colour), because the page is never told which addresses exist.
  return (
    <AuthFrame
      area={area}
      title={t('admin:resetPassword.requestTitle')}
      intro={status === 'sent' ? undefined : t('admin:resetPassword.requestBody')}
    >
      <div className="flex flex-col gap-4">
        {status === 'sent' ? (
          <SentNotice look={look}>{t('admin:resetPassword.requestSent')}</SentNotice>
        ) : (
          <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void onSubmit(event)}>
            <AdminField label={t('admin:resetPassword.email')}>
              {(props) => <AuthInput look={look} {...props} name="email" type="email" autoComplete="username" required />}
            </AdminField>
            {status === 'failed' && <FormAlert>{t('admin:resetPassword.requestFailed')}</FormAlert>}
            {status === 'rateLimited' && <FormAlert>{t('auth:rateLimited')}</FormAlert>}
            <SubmitButton look={look} busy={status === 'submitting'}>
              {status === 'submitting' ? t('admin:resetPassword.requestSubmitting') : t('admin:resetPassword.requestSubmit')}
            </SubmitButton>
          </form>
        )}
        <AuthLink look={look} to={AREA_PATHS[area].login}>
          {t('admin:resetPassword.backToSignIn')}
        </AuthLink>
      </div>
    </AuthFrame>
  )
}

/** Step two: the emailed link carried a token, so choose the new password. */
function ChoosePassword({ area, token }: { area: Area; token: string }) {
  const { t } = useTranslation()
  const look = lookOf(area)
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
      await confirmPasswordReset(area, token, newPassword)
      setStatus('done')
    } catch (error) {
      // A 400 here is the token: the length is checked above, so the only
      // malformed body this page can send is one with a spent or expired token.
      if (error instanceof ApiError && error.status === 400) setStatus('invalidToken')
      else if (error instanceof ApiError && error.status === 429) setStatus('rateLimited')
      else setStatus('failed')
    }
  }

  if (status === 'done') {
    return (
      <AuthFrame area={area} title={t('admin:resetPassword.doneTitle')}>
        <div className="flex flex-col gap-4">
          <p className="text-sm" role="status">
            {t('admin:resetPassword.doneBody')}
          </p>
          {/* The one shape where the way out is a button: the job is finished
              and there is exactly one next thing to do. */}
          <Button asChild size={look === 'console' ? 'console' : 'default'} className="client:h-12 w-full">
            <Link to={AREA_PATHS[area].login}>{t('admin:resetPassword.backToSignIn')}</Link>
          </Button>
        </div>
      </AuthFrame>
    )
  }

  const failure =
    status === 'invalidToken'
      ? t('admin:resetPassword.invalidToken')
      : status === 'rateLimited'
        ? t('auth:rateLimited')
        : status === 'failed'
          ? t('admin:resetPassword.chooseFailed')
          : null

  return (
    <AuthFrame area={area} title={t('admin:resetPassword.chooseTitle')} intro={t('admin:resetPassword.chooseBody')}>
      <div className="flex flex-col gap-4">
        <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void onSubmit(event)}>
          <AdminField
            label={t('admin:resetPassword.newPassword')}
            hint={t('admin:resetPassword.passwordHint')}
            error={invalid === 'tooShort' ? t('admin:resetPassword.tooShort') : null}
          >
            {(props) => <AuthInput look={look} {...props} name="newPassword" type="password" autoComplete="new-password" required />}
          </AdminField>
          <AdminField
            label={t('admin:resetPassword.confirmPassword')}
            error={invalid === 'mismatch' ? t('admin:resetPassword.mismatch') : null}
          >
            {(props) => (
              <AuthInput look={look} {...props} name="confirmPassword" type="password" autoComplete="new-password" required />
            )}
          </AdminField>

          {/* The dead end keeps its warning triangle, so it does not read as a
              retry-worthy failure: only a new link helps. */}
          {failure !== null && <FormAlert dead={status === 'invalidToken'}>{failure}</FormAlert>}

          <SubmitButton look={look} busy={status === 'submitting'}>
            {status === 'submitting' ? t('admin:resetPassword.chooseSubmitting') : t('admin:resetPassword.chooseSubmit')}
          </SubmitButton>
        </form>
        <AuthLink look={look} to={AREA_PATHS[area].login}>
          {t('admin:resetPassword.backToSignIn')}
        </AuthLink>
      </div>
    </AuthFrame>
  )
}
