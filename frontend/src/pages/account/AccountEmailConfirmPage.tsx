import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { confirmAccountEmailChange } from '@/account/dashboard'
import { ApiError } from '@/auth/api'
import { AuthFrame, AuthInput, FormAlert, SubmitButton } from '@/pages/auth/kit'
import { ClientField } from '@/pages/client/Field'
import type { ProfileLocationState } from './AccountProfile'

type Status = 'idle' | 'empty' | 'submitting' | 'invalid' | 'taken' | 'rateLimited' | 'failed'

/**
 * `/account/email-confirm/:token`, where the link in an address-change email
 * lands (marketplace-spec R8.3, decisions 2 and 3; design-system/bookly/pages/
 * account-profile.md, "Confirming a new email").
 *
 * Opening the link changes nothing: an email scanner may open it. The change
 * is a POST with the token and the account's password -- the token proves the
 * new inbox, the password the person -- and needs no session, since the link
 * opens in whatever tab the inbox opens. Success signs this tab in to the
 * account and lands on the profile, which says the address changed. Every
 * refusal of the link or the password is one answer (`invalid_confirmation`).
 */
export function AccountEmailConfirmPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { token = '' } = useParams()
  const [status, setStatus] = useState<Status>('idle')

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (status === 'submitting') return
    const password = String(new FormData(event.currentTarget).get('password') ?? '')
    if (password === '') {
      setStatus('empty')
      return
    }
    setStatus('submitting')
    try {
      const user = await confirmAccountEmailChange(token, password)
      void navigate('/account/profile', { replace: true, state: { emailChanged: user.email } satisfies ProfileLocationState })
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) setStatus('invalid')
      else if (error instanceof ApiError && error.status === 409) setStatus('taken')
      else if (error instanceof ApiError && error.status === 429) setStatus('rateLimited')
      else setStatus('failed')
    }
  }

  const message =
    status === 'invalid'
      ? t('account:emailConfirm.invalid')
      : status === 'taken'
        ? t('account:emailConfirm.taken')
        : status === 'rateLimited'
          ? t('auth:rateLimited')
          : status === 'failed'
            ? t('account:emailConfirm.failed')
            : null

  return (
    <AuthFrame area="account" title={t('account:emailConfirm.title')} intro={t('account:emailConfirm.intro')}>
      <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void onSubmit(event)}>
        <ClientField label={t('account:emailConfirm.password')} error={status === 'empty' ? t('account:email.errors.enterPassword') : null}>
          {(props) => <AuthInput look="client" {...props} name="password" type="password" autoComplete="current-password" required />}
        </ClientField>
        {message !== null && <FormAlert dead={status === 'invalid' || status === 'taken'}>{message}</FormAlert>}
        <SubmitButton look="client" busy={status === 'submitting'}>
          {status === 'submitting' ? t('account:emailConfirm.submitting') : t('account:emailConfirm.submit')}
        </SubmitButton>
      </form>
    </AuthFrame>
  )
}
