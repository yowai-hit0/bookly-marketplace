import { safeHttpsUrl } from '@/lib/safe-url'
import { ApiError, apiUrl, publicPost } from './api'
import { type Area, saveSession } from './session'

/**
 * The public auth endpoints of each area, `/api/{studio,platform,account}/auth/*`
 * (marketplace spec R2.1a, R2.1c; backend/openapi/paths/*-auth.yaml,
 * platform.yaml, account.yaml). Every refusal surfaces as an `ApiError`
 * carrying the API's own code; a network failure propagates as it is. The
 * pages word them.
 *
 * A login, a verification and a Google sign-in all answer the login body; only
 * its token and expiry are stored (`saveSession`), never the user.
 */

type LoginBody = { token: string; expiresAt: string }

export type PhotographerSignup = { email: string; password: string; displayName: string; handle: string }
export type ClientSignup = { email: string; password: string; fullName: string }

/** Passwords are 12 to 1024 characters (the API's `MIN_NEW_PASSWORD_LENGTH` and cap). */
export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 1024

function signedIn(area: Area, body: LoginBody): void {
  saveSession(area, { token: body.token, expiresAt: body.expiresAt })
}

export async function signIn(area: Area, email: string, password: string): Promise<void> {
  signedIn(area, await publicPost<LoginBody>(`/${area}/auth/login`, { email, password }))
}

/** Always 202 when the API is reachable: it never says whether the address has an account. */
export async function requestPasswordReset(area: Area, email: string): Promise<void> {
  await publicPost(`/${area}/auth/password-reset/request`, { email })
}

export async function confirmPasswordReset(area: Area, token: string, newPassword: string): Promise<void> {
  await publicPost(`/${area}/auth/password-reset/confirm`, { token, newPassword })
}

/** The emailed token and the account's password; success signs the caller in. */
export async function verifyEmail(area: Area, token: string, password: string): Promise<void> {
  signedIn(area, await publicPost<LoginBody>(`/${area}/auth/verify`, { token, password }))
}

/** Always 202 when the API is reachable, whether or not a link was sent. */
export async function resendVerification(area: Area, email: string): Promise<void> {
  await publicPost(`/${area}/auth/verify/resend`, { email })
}

/** 202 whether or not the address was taken; a taken handle is a 409 `handle_taken`. */
export async function signUpPhotographer(body: PhotographerSignup): Promise<void> {
  await publicPost('/studio/auth/signup', body)
}

/** 202 whether or not the address was taken. */
export async function signUpClient(body: ClientSignup): Promise<void> {
  await publicPost('/account/auth/signup', body)
}

/** Whether the account login offers Google. Any failure reads as "no": the password form still works. */
export async function fetchAuthProviders(signal?: AbortSignal): Promise<{ google: boolean }> {
  try {
    const res = await fetch(apiUrl('/account/auth/providers'), { headers: { Accept: 'application/json' }, signal })
    if (!res.ok) return { google: false }
    const body = (await res.json()) as { google?: unknown }
    return { google: body.google === true }
  } catch {
    return { google: false }
  }
}

// --- Google sign-in (R2.4) ---------------------------------------------------

/**
 * Where the `state` of a Google sign-in waits for the browser to come back,
 * with the return path it set out from. `sessionStorage`, so it belongs to
 * this tab alone, and it is read once: the callback page removes it before it
 * compares.
 */
export const GOOGLE_FLOW_KEY = 'bookly.account.googleFlow'

type GoogleFlow = { state: string; next: string | null }

/** Leaving the app for another site. An object, so a test can replace `assign`. */
export const externalNavigation = {
  assign(url: string): void {
    window.location.assign(url)
  },
}

/**
 * Starts the flow: the API answers Google's authorization URL and a `state`,
 * which is kept here with the return path, then the browser goes to Google.
 * An authorization URL that is not `https:` is refused rather than followed.
 */
export async function startGoogleSignIn(next: string | null): Promise<void> {
  const { authorizationUrl, state } = await publicPost<{ authorizationUrl: string; state: string }>('/account/auth/google/start')
  const url = safeHttpsUrl(authorizationUrl)
  if (url === null || typeof state !== 'string' || state === '') throw new ApiError(502, 'google_start_invalid')
  sessionStorage.setItem(GOOGLE_FLOW_KEY, JSON.stringify({ state, next } satisfies GoogleFlow))
  externalNavigation.assign(url)
}

/** The stored flow, removed as it is read; null when there is none or it is unreadable. */
export function takeGoogleFlow(): GoogleFlow | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(GOOGLE_FLOW_KEY)
    sessionStorage.removeItem(GOOGLE_FLOW_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<GoogleFlow> | null
    if (parsed === null || typeof parsed.state !== 'string' || parsed.state === '') return null
    return { state: parsed.state, next: typeof parsed.next === 'string' ? parsed.next : null }
  } catch {
    return null
  }
}

/**
 * The state Google returned against the one this tab stored. A mismatch, or
 * nothing stored, means this tab did not start the flow (or started another
 * since): the code is never posted, and the visitor starts again.
 */
export function googleStateMatches(stored: GoogleFlow | null, returned: string | null): stored is GoogleFlow {
  return stored !== null && returned !== null && returned !== '' && stored.state === returned
}

export async function completeGoogleSignIn(code: string, state: string): Promise<void> {
  signedIn('account', await publicPost<LoginBody>('/account/auth/google/callback', { code, state }))
}
