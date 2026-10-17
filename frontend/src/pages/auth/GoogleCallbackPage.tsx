import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router'
import { ApiError } from '@/auth/api'
import { AREA_PATHS, safeReturnPath } from '@/auth/areas'
import { completeGoogleSignIn, googleStateMatches, takeGoogleFlow } from '@/auth/client'
import { Button } from '@/components/ui/button'
import { AuthFrame, FormAlert } from './kit'

type Failure = 'invalidState' | 'cancelled' | 'signInFailed' | 'emailUnverified' | 'conflict' | 'unavailable' | 'rateLimited' | 'failed'

const MESSAGES: Record<Failure, string> = {
  invalidState: 'auth:google.invalidState',
  cancelled: 'auth:google.cancelled',
  signInFailed: 'auth:google.signInFailed',
  emailUnverified: 'auth:google.emailUnverified',
  conflict: 'auth:google.conflict',
  unavailable: 'auth:google.unavailable',
  rateLimited: 'auth:rateLimited',
  failed: 'auth:google.failed',
}

/** The API's refusal, worded. `account_conflict` never says what kind of account holds the address. */
function failureOf(error: unknown): Failure {
  if (!(error instanceof ApiError)) return 'failed'
  if (error.status === 409) return 'conflict'
  if (error.status === 404) return 'unavailable'
  if (error.status === 429) return 'rateLimited'
  if (error.message === 'invalid_state') return 'invalidState'
  if (error.message === 'google_email_unverified') return 'emailUnverified'
  if (error.status === 400) return 'signInFailed'
  return 'failed'
}

/**
 * `/account/google/callback`, where Google sends the browser back
 * (marketplace spec R2.4). The `state` Google returns is compared with the one
 * this tab stored when it set out, **before** anything is posted: a mismatch,
 * or nothing stored, means this tab did not start this sign-in, and the code
 * is never sent. The stored state is removed as it is read, so it works once.
 *
 * Then `{ code, state }` goes to the API, which consumes the flow, exchanges
 * the code and checks the identity; success signs the client in and lands
 * where they set out for (a return path inside the account), else `/account`.
 */
export function GoogleCallbackPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { search } = useLocation()
  const [failure, setFailure] = useState<Failure | null>(null)
  // Once per visit: React's development double-run of effects must not post
  // the code twice (the second would find the flow spent and refuse it).
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    async function finish() {
      const params = new URLSearchParams(search)
      // Taken (and so removed) first, whatever happens next: it works once.
      const stored = takeGoogleFlow()
      const returned = params.get('state')
      const code = params.get('code')

      if (params.get('error') !== null) {
        setFailure(params.get('error') === 'access_denied' ? 'cancelled' : 'signInFailed')
        return
      }
      if (!googleStateMatches(stored, returned) || code === null || code === '') {
        setFailure('invalidState')
        return
      }
      try {
        await completeGoogleSignIn(code, stored.state)
        navigate(safeReturnPath(stored.next, 'account') ?? AREA_PATHS.account.home, { replace: true })
      } catch (error) {
        setFailure(failureOf(error))
      }
    }
    void finish()
  }, [search, navigate])

  if (failure === null) {
    return (
      <AuthFrame area="account" title={t('auth:google.title')}>
        <p className="text-subtle-foreground" role="status">
          {t('auth:google.working')}
        </p>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame area="account" title={t('auth:google.failedTitle')}>
      <div className="flex flex-col gap-4">
        <FormAlert dead={failure === 'invalidState'}>{t(MESSAGES[failure])}</FormAlert>
        <Button asChild className="client:h-12 w-full">
          <Link to={AREA_PATHS.account.login}>{t('auth:backToSignIn')}</Link>
        </Button>
      </div>
    </AuthFrame>
  )
}
