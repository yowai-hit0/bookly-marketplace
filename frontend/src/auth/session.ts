import { useSyncExternalStore } from 'react'
import { z } from 'zod'

/**
 * Where each signed-in area keeps its bearer token (marketplace spec R2.1 and
 * R2.6, Phase 2 brief decision 10; first written for the admin in plan.md
 * Task 7).
 *
 * One `sessionStorage` entry per area -- `bookly.studio.session`,
 * `bookly.platform.session`, `bookly.account.session` -- because a token is
 * issued for one audience and refused by the others: a photographer who is
 * also a client signs in to each separately, and signing out of one leaves the
 * other alone.
 *
 * `sessionStorage`, so a reload does not sign anyone out while closing the tab
 * does. Never `localStorage`: a token that outlives the browser session is a
 * token that outlives the person who signed in. There is no server-side logout
 * -- signing out is this module forgetting the token. Storage can be missing
 * or throw (private windows, blocked site data), so every access is guarded
 * and a failure reads as signed out.
 */

export const AREAS = ['studio', 'platform', 'account'] as const

export type Area = (typeof AREAS)[number]

export function sessionKey(area: Area): string {
  return `bookly.${area}.session`
}

const sessionSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
})

export type Session = z.infer<typeof sessionSchema>

/** Fired on this tab after a write, so a header or layout can follow sign-in and sign-out. */
const CHANGED = 'bookly:session-changed'

/** The area's stored session, or null if there is none, it is unreadable, or it has expired. */
export function readSession(area: Area, now: Date = new Date()): Session | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(sessionKey(area))
  } catch {
    return null
  }
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    forget(area)
    return null
  }

  const result = sessionSchema.safeParse(parsed)
  if (!result.success || Date.parse(result.data.expiresAt) <= now.getTime()) {
    forget(area)
    return null
  }
  return result.data
}

/** Keeps only the token and its expiry: nothing else of the login answer is stored. */
export function saveSession(area: Area, session: Session): void {
  sessionStorage.setItem(sessionKey(area), JSON.stringify({ token: session.token, expiresAt: session.expiresAt }))
  notify(area)
}

/** Signs the area out: forgets its token and tells this tab's listeners. */
export function clearSession(area: Area): void {
  if (forget(area)) notify(area)
}

/**
 * Removes the entry; true when one was there. Reading an expired or unreadable
 * entry forgets it silently: a read happens during render, and the reader
 * already sees "signed out", so there is nothing to announce.
 */
function forget(area: Area): boolean {
  try {
    if (sessionStorage.getItem(sessionKey(area)) === null) return false
    sessionStorage.removeItem(sessionKey(area))
    return true
  } catch {
    // Storage unavailable: there is nothing stored to forget.
    return false
  }
}

function notify(area: Area): void {
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: area }))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange)
  return () => window.removeEventListener(CHANGED, onChange)
}

/**
 * The area's token, kept current as this tab signs in and out. The token
 * string, not the session object, so React sees a stable snapshot.
 */
export function useSessionToken(area: Area): string | null {
  return useSyncExternalStore(
    subscribe,
    () => readSession(area)?.token ?? null,
    () => null,
  )
}
