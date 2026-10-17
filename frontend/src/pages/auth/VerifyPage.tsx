import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { ApiError } from '@/auth/api'
import { AREA_PATHS } from '@/auth/areas'
import { resendVerification, verifyEmail } from '@/auth/client'
import type { Area } from '@/auth/session'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AdminField } from '@/pages/admin/AdminField'
import { META, SECTION_TITLE } from '@/pages/admin/console/classes'
import { AuthFrame, AuthInput, AuthLink, FormAlert, SentNotice, SubmitButton } from './kit'
import { lookOf } from './look'

type Status = 'idle' | 'submitting' | 'invalid' | 'rateLimited' | 'failed'

/**
 * `/{studio,platform,account}/verify/:token`, where the verification email
 * lands (marketplace spec R2.1c). Opening the link changes nothing: the page
 * asks for the password the account was created with and posts both, because
 * the token proves the inbox and the password proves the person at it is the
 * one who signed up.
 *
 * Success signs the visitor in and lands in the area. Every refusal is one
 * answer from the API (`invalid_verification`: a bad, expired or used link,
 * or a wrong password), so the page says it once and offers both ways on:
 * "Forgot password" (a completed reset verifies the address too, which is the
 * real owner's way in to an address someone else signed up with) and "Send a
 * new link".
 */
export function VerifyPage({ area }: { area: Area }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { token = '' } = useParams()
  const look = lookOf(area)
  const [status, setStatus] = useState<Status>('idle')

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const password = String(new FormData(event.currentTarget).get('password') ?? '')
    setStatus('submitting')

    try {
      await verifyEmail(area, token, password)
      navigate(AREA_PATHS[area].home, { replace: true })
    } catch (error) {
      // `invalid_request` is a malformed body (an empty password, a mangled
      // link): to the visitor it is the same dead end as `invalid_verification`.
      if (error instanceof ApiError && error.status === 400) setStatus('invalid')
      else if (error instanceof ApiError && error.status === 429) setStatus('rateLimited')
      else setStatus('failed')
    }
  }

  const message =
    status === 'invalid'
      ? t('auth:verify.invalid')
      : status === 'rateLimited'
        ? t('auth:rateLimited')
        : status === 'failed'
          ? t('auth:verify.failed')
          : null

  return (
    <AuthFrame area={area} title={t('auth:verify.title')} intro={t('auth:verify.intro')}>
      <div className="flex flex-col gap-4">
        <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void onSubmit(event)}>
          <AdminField label={t('auth:verify.password')}>
            {(props) => <AuthInput look={look} {...props} name="password" type="password" autoComplete="current-password" required />}
          </AdminField>
          {message !== null && <FormAlert dead={status === 'invalid'}>{message}</FormAlert>}
          <SubmitButton look={look} busy={status === 'submitting'}>
            {status === 'submitting' ? t('auth:verify.submitting') : t('auth:verify.submit')}
          </SubmitButton>
        </form>

        {status === 'invalid' && <Recover area={area} />}

        <AuthLink look={look} to={AREA_PATHS[area].login}>
          {t('auth:backToSignIn')}
        </AuthLink>
      </div>
    </AuthFrame>
  )
}

type ResendStatus = 'closed' | 'open' | 'submitting' | 'sent' | 'rateLimited' | 'failed'

/** The two ways on from a refused link: reset the password, or have a new link sent. */
function Recover({ area }: { area: Area }) {
  const { t } = useTranslation()
  const look = lookOf(area)
  const [status, setStatus] = useState<ResendStatus>('closed')

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim()
    setStatus('submitting')
    try {
      await resendVerification(area, email)
      setStatus('sent')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 429 ? 'rateLimited' : 'failed')
    }
  }

  return (
    <section aria-labelledby={`${area}-recover`} className="flex flex-col gap-3 border-t pt-4">
      <h2 id={`${area}-recover`} className={cn(SECTION_TITLE, 'text-base')}>
        {t('auth:verify.recoverTitle')}
      </h2>
      <div className="flex flex-col gap-1">
        <AuthLink look={look} to={`/${area}/reset-password`}>
          {t('auth:verify.forgot')}
        </AuthLink>
        <p className={META}>{t('auth:verify.forgotHint')}</p>
      </div>

      {status === 'closed' && (
        <Button
          type="button"
          variant={look === 'console' ? 'console-outline' : 'outline'}
          size={look === 'console' ? 'console' : 'default'}
          className="self-start"
          onClick={() => setStatus('open')}
        >
          {t('auth:verify.sendNew')}
        </Button>
      )}

      {status === 'sent' && <SentNotice look={look}>{t('auth:verify.resent')}</SentNotice>}

      {status !== 'closed' && status !== 'sent' && (
        <form className="flex flex-col gap-3" noValidate onSubmit={(event) => void onSubmit(event)}>
          <AdminField label={t('auth:verify.email')} hint={t('auth:verify.resendIntro')}>
            {(props) => <AuthInput look={look} {...props} name="email" type="email" autoComplete="email" required />}
          </AdminField>
          {status === 'failed' && <FormAlert>{t('auth:verify.resendFailed')}</FormAlert>}
          {status === 'rateLimited' && <FormAlert>{t('auth:rateLimited')}</FormAlert>}
          <SubmitButton look={look} busy={status === 'submitting'}>
            {status === 'submitting' ? t('auth:verify.resending') : t('auth:verify.resendSubmit')}
          </SubmitButton>
        </form>
      )}
    </section>
  )
}
