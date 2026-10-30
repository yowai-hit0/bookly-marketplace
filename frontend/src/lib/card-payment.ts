import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { transactionIdOf } from './flutterwave-inline'

/**
 * What a card payment's pages remember between the pay page and its progress
 * page (marketplace-spec.md "Cards as built"), in this tab only.
 *
 * Flutterwave may move the whole tab to the payment's return URL (3-D Secure,
 * and on today's v3.js every completed try), so the progress page can be
 * reached by a full page load. `sessionStorage` survives that, and stays in
 * this tab:
 *  - that a payment is a card payment, so its progress page speaks of a card
 *    rather than a phone prompt (the progress answer names no method);
 *  - for the guest session fee only, the booking's access token, under the
 *    payment's `ourRef`, so the token-free return page (`/payments/:ourRef`)
 *    can link back to the booking. The token is kept nowhere else: Flutterwave
 *    stores the return URL, and the token reads and cancels the booking.
 *
 * Storage can be missing or throw (private windows, blocked site data), so
 * every access is guarded, and a failure only means "nothing remembered".
 */

const CARD_KEY = 'bookly.cardPayment.'
const BOOKING_TOKEN_KEY = 'bookly.cardBookingToken.'

/** Marks `ourRef` as a card payment, before its modal opens; with the guest page's access token when there is one. */
export function rememberCardPayment(ourRef: string, bookingToken?: string): void {
  try {
    window.sessionStorage.setItem(`${CARD_KEY}${ourRef}`, '1')
    if (bookingToken !== undefined && bookingToken !== '') window.sessionStorage.setItem(`${BOOKING_TOKEN_KEY}${ourRef}`, bookingToken)
  } catch {
    // Nothing remembered: the return page says how to get back instead.
  }
}

export function isRememberedCardPayment(ourRef: string): boolean {
  try {
    return window.sessionStorage.getItem(`${CARD_KEY}${ourRef}`) === '1'
  } catch {
    return false
  }
}

/** The guest booking's access token this tab kept for `ourRef`, or null. */
export function cardBookingToken(ourRef: string): string | null {
  try {
    const token = window.sessionStorage.getItem(`${BOOKING_TOKEN_KEY}${ourRef}`)
    return token === null || token === '' ? null : token
  } catch {
    return null
  }
}

/** What a progress page knows about the card payment it follows. */
export type CardReturn = {
  /** A card payment, as far as this tab can tell. */
  card: boolean
  /** The try to verify, from the modal's callback or Flutterwave's redirect: digits only, or null. */
  transactionId: string | null
}

/** The query Flutterwave appends to the return URL. Read once, then removed. */
const RETURN_QUERY = ['transaction_id', 'tx_ref', 'status'] as const

/** Navigation state a pay page hands its progress page after the modal's callback. */
export type CardNavigationState = { card: true; transactionId: string | null }

export function cardNavigationState(transactionId: string | null): CardNavigationState {
  return { card: true, transactionId }
}

type Read = CardReturn & { ourRef: string; fromQuery: boolean }

/**
 * For a progress page: reads `transaction_id` from Flutterwave's redirect (or
 * the pay page's navigation state) once, then takes Flutterwave's query off
 * the URL with a `replace`, keeping what it learned in the history entry's
 * state so a reload knows it too. `status` is never read: only the poll's
 * answer decides what the page says (R3.3, T3.2).
 */
export function useCardReturn(ourRef: string): CardReturn {
  const location = useLocation()
  const navigate = useNavigate()
  const [read, setRead] = useState<Read>(() => readReturn(ourRef, location.search, location.state))
  let current = read
  if (read.ourRef !== ourRef) {
    current = readReturn(ourRef, location.search, location.state)
    setRead(current)
  }

  const stripped = useRef<string | null>(null)
  const { pathname, search, hash } = location
  useEffect(() => {
    if (!current.fromQuery || stripped.current === current.ourRef) return
    stripped.current = current.ourRef
    const params = new URLSearchParams(search)
    for (const key of RETURN_QUERY) params.delete(key)
    const rest = params.toString()
    void navigate(
      { pathname, search: rest === '' ? '' : `?${rest}`, hash },
      { replace: true, state: cardNavigationState(current.transactionId) },
    )
  }, [current.fromQuery, current.ourRef, current.transactionId, navigate, pathname, search, hash])

  return { card: current.card, transactionId: current.transactionId }
}

function readReturn(ourRef: string, search: string, state: unknown): Read {
  const params = new URLSearchParams(search)
  const fromQuery = RETURN_QUERY.some((key) => params.has(key))
  const navigation = (typeof state === 'object' && state !== null ? state : {}) as { card?: unknown; transactionId?: unknown }
  const transactionId = transactionIdOf(params.get('transaction_id')) ?? transactionIdOf(navigation.transactionId)
  const card = fromQuery || navigation.card === true || isRememberedCardPayment(ourRef)
  return { ourRef, fromQuery, card, transactionId }
}
