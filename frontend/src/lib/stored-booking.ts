import { useSyncExternalStore } from 'react'

/**
 * The booking link this device last opened (docs/prompts/client-access-and-admin-polish.md,
 * item 5), so the header's "My booking" leads back to it.
 *
 * Only the token is kept, under one key: the most recently opened booking.
 * Anyone at this device can then open that booking, as they already could from
 * the browser's history; `client-shell.md` says so. Storage can be missing or
 * throw (private windows, blocked site data), so every access is guarded and a
 * failure simply means "nothing remembered".
 */

export const STORED_BOOKING_KEY = 'bookly.bookingToken'
/** Fired on this tab after a write; the `storage` event covers the others. */
const CHANGED = 'bookly:booking-token-changed'

export function readStoredBookingToken(): string | null {
  try {
    const value = window.localStorage.getItem(STORED_BOOKING_KEY)
    return value === null || value === '' ? null : value
  } catch {
    return null
  }
}

export function rememberBookingToken(token: string): void {
  try {
    if (window.localStorage.getItem(STORED_BOOKING_KEY) === token) return
    window.localStorage.setItem(STORED_BOOKING_KEY, token)
  } catch {
    return
  }
  window.dispatchEvent(new Event(CHANGED))
}

/** Forgets `token`, and only it: a dead link must not wipe a newer one opened since. */
export function forgetBookingToken(token: string): void {
  try {
    if (window.localStorage.getItem(STORED_BOOKING_KEY) !== token) return
    window.localStorage.removeItem(STORED_BOOKING_KEY)
  } catch {
    return
  }
  window.dispatchEvent(new Event(CHANGED))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange)
  window.addEventListener(CHANGED, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CHANGED, onChange)
  }
}

/** The remembered token, kept current as pages here and in other tabs change it. */
export function useStoredBookingToken(): string | null {
  return useSyncExternalStore(subscribe, readStoredBookingToken, () => null)
}
