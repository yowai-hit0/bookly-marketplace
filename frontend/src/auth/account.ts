import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import { useSessionToken } from './session'

/** `GET /api/account/me` (marketplace spec R2.1c): the client's own view of their account. */
export type AccountUser = { id: string; email: string; lastLoginAt: string | null; fullName: string | null }

/**
 * One request per token: the client header and `/account` both want the
 * account, and asking twice for the same token would be waste. A failure is
 * not kept, so the next ask tries again; a 401 drops the account session in
 * `apiFetch`, which signs the header out.
 */
let cached: { token: string; answer: Promise<AccountUser> } | null = null

export function fetchAccountMe(token: string): Promise<AccountUser> {
  if (cached?.token === token) return cached.answer
  const answer = apiFetch<{ user: AccountUser }>('account', '/account/me').then((body) => body.user)
  cached = { token, answer }
  answer.catch(() => {
    if (cached?.answer === answer) cached = null
  })
  return answer
}

/** Forgets the cached account (sign-out, tests). */
export function forgetAccountMe(): void {
  cached = null
}

export type AccountState =
  | { state: 'signedOut' }
  | { state: 'loading' }
  | { state: 'ready'; user: AccountUser }
  | { state: 'failed' }

/** The signed-in client's account, following sign-in and sign-out in this tab. `attempt` asks again. */
export function useAccount(attempt = 0): AccountState {
  const token = useSessionToken('account')
  const [loaded, setLoaded] = useState<{ token: string; attempt: number; result: AccountState } | null>(null)

  useEffect(() => {
    if (token === null) return
    let cancelled = false
    fetchAccountMe(token).then(
      (user) => !cancelled && setLoaded({ token, attempt, result: { state: 'ready', user } }),
      () => !cancelled && setLoaded({ token, attempt, result: { state: 'failed' } }),
    )
    return () => {
      cancelled = true
    }
  }, [token, attempt])

  if (token === null) return { state: 'signedOut' }
  if (loaded === null || loaded.token !== token || loaded.attempt !== attempt) return { state: 'loading' }
  return loaded.result
}

/** What the header and the greeting call the client: their name, else their address. */
export function accountName(user: AccountUser): string {
  const name = user.fullName?.trim() ?? ''
  return name === '' ? user.email : name
}
