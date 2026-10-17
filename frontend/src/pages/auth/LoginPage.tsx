import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'
import { ApiError } from '@/auth/api'
import { NEXT_PARAM, landingPath, safeReturnPath } from '@/auth/areas'
import { fetchAuthProviders, signIn, startGoogleSignIn } from '@/auth/client'
import type { Area } from '@/auth/session'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { AuthFrame, AuthInput, AuthLink, FormAlert, SubmitButton } from './kit'
import { lookOf } from './look'

type Status = 'idle' | 'submitting' | 'invalid' | 'rateLimited' | 'failed'
type GoogleStatus = 'idle' | 'starting' | 'unavailable' | 'rateLimited' | 'failed'

/**
 * `/{studio,platform,account}/login` (spec A-11, marketplace spec R2.6): email
 * and password against that area's `POST /api/{area}/auth/login`. The API
 * answers an unknown email, a wrong password, a locked account, an unverified
 * address and an account of another kind identically, so this page cannot and
 * does not tell them apart.
 *
 * Signing in lands where the visitor was going when the area's guard sent them
 * here (`?next=`, accepted only as a path inside this area; `auth/areas.ts`),
 * else the area's home. The account login also offers Google when the API says
 * it is configured.
 *
 * The studio and platform logins wear no client top bar (user decision,
 * 2026-09-26): sign in and reset password are one place, the console panel,
 * and the Bookly mark in it is the way back to the client site.
 */
export function LoginPage({ area }: { area: Area }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { search } = useLocation()
  const look = lookOf(area)
  const [status, setStatus] = useState<Status>('idle')

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setStatus('submitting')

    try {
      await signIn(area, String(form.get('email') ?? ''), String(form.get('password') ?? ''))
      navigate(landingPath(area, search), { replace: true })
    } catch (error) {
      if (error instanceof ApiError && (error.status === 400 || error.status === 401)) setStatus('invalid')
      else if (error instanceof ApiError && error.status === 429) setStatus('rateLimited')
      else setStatus('failed')
    }
  }

  const message =
    status === 'invalid'
      ? t('admin:signIn.invalid')
      : status === 'rateLimited'
        ? t('auth:rateLimited')
        : status === 'failed'
          ? t('admin:signIn.failed')
          : null

  const title =
    area === 'studio' ? t('admin:signIn.title') : area === 'platform' ? t('auth:signIn.platformTitle') : t('auth:signIn.accountTitle')

  return (
    <AuthFrame area={area} title={title} intro={area === 'account' ? t('auth:signIn.accountIntro') : undefined}>
      <div className="flex flex-col gap-4">
        {area === 'account' && <GoogleSignIn next={safeReturnPath(new URLSearchParams(search).get(NEXT_PARAM), 'account')} />}
        <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${area}-email`}>{t('admin:signIn.email')}</Label>
            <AuthInput look={look} id={`${area}-email`} name="email" type="email" autoComplete="username" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${area}-password`}>{t('admin:signIn.password')}</Label>
            <AuthInput
              look={look}
              id={`${area}-password`}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          {message !== null && <FormAlert>{message}</FormAlert>}
          <SubmitButton look={look} busy={status === 'submitting'}>
            {status === 'submitting' ? t('admin:signIn.submitting') : t('admin:signIn.submit')}
          </SubmitButton>
        </form>
        {/* The reset page asks for the address itself; this link carries nothing. */}
        <AuthLink look={look} to={`/${area}/reset-password`}>
          {t('admin:signIn.forgot')}
        </AuthLink>
        {area === 'studio' && (
          <AuthLink look={look} to="/studio/signup">
            {t('auth:signIn.createStudio')}
          </AuthLink>
        )}
        {area === 'account' && (
          <AuthLink look={look} to="/account/signup">
            {t('auth:signIn.createAccount')}
          </AuthLink>
        )}
      </div>
    </AuthFrame>
  )
}

/**
 * "Continue with Google", shown only once `GET /api/account/auth/providers`
 * says it is configured; until then, and on any failure, the password form is
 * the page. A click asks the API to start the flow (R2.4), which keeps the
 * `state` for the callback page and leaves for Google.
 */
function GoogleSignIn({ next }: { next: string | null }) {
  const { t } = useTranslation()
  const [offered, setOffered] = useState(false)
  const [status, setStatus] = useState<GoogleStatus>('idle')

  useEffect(() => {
    const controller = new AbortController()
    void fetchAuthProviders(controller.signal).then(({ google }) => {
      if (!controller.signal.aborted) setOffered(google)
    })
    return () => controller.abort()
  }, [])

  async function start() {
    setStatus('starting')
    try {
      await startGoogleSignIn(next)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setStatus('unavailable')
      else if (error instanceof ApiError && error.status === 429) setStatus('rateLimited')
      else setStatus('failed')
    }
  }

  if (!offered && status !== 'unavailable') return null

  const message =
    status === 'unavailable'
      ? t('auth:signIn.googleUnavailable')
      : status === 'rateLimited'
        ? t('auth:rateLimited')
        : status === 'failed'
          ? t('auth:signIn.googleFailed')
          : null

  return (
    <div className="flex flex-col gap-4">
      {status !== 'unavailable' && (
        <Button type="button" variant="outline" className="client:h-12 w-full" disabled={status === 'starting'} onClick={() => void start()}>
          {status === 'starting' ? t('auth:signIn.googleStarting') : t('auth:signIn.google')}
        </Button>
      )}
      {message !== null && <FormAlert>{message}</FormAlert>}
      {status !== 'unavailable' && (
        <p className="text-muted-foreground flex items-center gap-3 text-sm" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          {t('auth:signIn.or')}
          <span className="h-px flex-1 bg-border" />
        </p>
      )}
    </div>
  )
}
