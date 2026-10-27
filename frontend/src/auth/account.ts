import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import { useSessionToken } from './session'

/**
 * `GET /api/account/me` (marketplace spec R2.1c, R8.3): the client's own view
 * of their account. Since Phase 8 it also says which credentials the account
 * holds (`hasPassword`, `hasGoogle`), the phone that prefills the booking form,
 * and an address change waiting on the new inbox (`pendingEmail`).
 */
export type AccountUser = {
  id: string
  email: string
  lastLoginAt: string | null
  fullName: string | null
  phone: string | null
  hasPassword: boolean
  hasGoogle: boolean
  pendingEmail: string | null
}

/**
 * One request per token: the client header and `/account` both want the
 * account, and asking twice for the same token would be waste. A failure is
 * not kept, so the next ask tries again; a 401 drops the account session in
 * `apiFetch`, which signs the header out.
 */
let cached: { token: string; answer: Promise<AccountUser>; value?: AccountUser } | null = null

/** Fired on this tab when the account changed under the same token (a profile save). */
const CHANGED = 'bookly:account-changed'

export function fetchAccountMe(token: string): Promise<AccountUser> {
  if (cached?.token === token) return cached.answer
  const answer = apiFetch<{ user: AccountUser }>('account', '/account/me').then((body) => body.user)
  const entry: NonNullable<typeof cached> = { token, answer }
  cached = entry
  answer.then(
    (user) => {
      entry.value = user
    },
    () => {
      if (cached?.answer === answer) cached = null
    },
  )
  return answer
}

/** Forgets the cached account (sign-out, tests). */
export function forgetAccountMe(): void {
  cached = null
}

/**
 * The account as an answer already in hand: a credential change answers a
 * login with the `/me` view of the user and a new token, so nothing is asked
 * again for it.
 */
export function primeAccountMe(token: string, user: AccountUser): void {
  cached = { token, answer: Promise.resolve(user), value: user }
  notify()
}

/**
 * Asks again for the account under the same token, after a change this tab
 * made (a new name or phone, an address change requested). Readers keep
 * showing the account they have until the new answer arrives.
 */
export function refreshAccountMe(): void {
  cached = null
  notify()
}

function notify(): void {
  window.dispatchEvent(new Event(CHANGED))
}

export type AccountState =
  | { state: 'signedOut' }
  | { state: 'loading' }
  | { state: 'ready'; user: AccountUser }
  | { state: 'failed' }

type Loaded = { token: string; attempt: number; revision: number; result: AccountState }

/** The signed-in client's account, following sign-in and sign-out in this tab. `attempt` asks again. */
export function useAccount(attempt = 0): AccountState {
  const token = useSessionToken('account')
  const [revision, setRevision] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    const onChange = () => setRevision((n) => n + 1)
    window.addEventListener(CHANGED, onChange)
    return () => window.removeEventListener(CHANGED, onChange)
  }, [])

  useEffect(() => {
    if (token === null) return
    let cancelled = false
    fetchAccountMe(token).then(
      (user) => !cancelled && setLoaded({ token, attempt, revision, result: { state: 'ready', user } }),
      () => !cancelled && setLoaded({ token, attempt, revision, result: { state: 'failed' } }),
    )
    return () => {
      cancelled = true
    }
  }, [token, attempt, revision])

  if (token === null) return { state: 'signedOut' }
  if (loaded === null || loaded.token !== token || loaded.attempt !== attempt) {
    // An answer already in hand for this token (a credential change primed it): no flash of "loading".
    if (cached?.token === token && cached.value !== undefined && (loaded === null || loaded.attempt === attempt)) {
      return { state: 'ready', user: cached.value }
    }
    return { state: 'loading' }
  }
  // A refresh under the same token keeps the account on screen until the new answer lands.
  if (loaded.revision !== revision && loaded.result.state !== 'ready') return { state: 'loading' }
  return loaded.result
}

/** What the header and the greeting call the client: their name, else their address. */
export function accountName(user: AccountUser): string {
  const name = user.fullName?.trim() ?? ''
  return name === '' ? user.email : name
}
