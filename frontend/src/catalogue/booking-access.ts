import { env } from '@/env'
import type { CancellationTerms } from '@/lib/cancellation'
import { type PayRequest, type PaymentMethod, type StartPaymentResult, PaymentApiError, knownMethodOf, payBody, startedPaymentOf } from './payments'

/**
 * A client's own booking: `GET /api/booking/:token`, its cancellation and its
 * session-fee payment (plan.md Task 18; spec §3.9, §6.10).
 *
 * The token addresses everything. Nothing here sends a booking id, a reference
 * or an email, because the API would ignore them and because a page that never
 * holds them cannot leak them.
 */

export type ClientBookingPayment = {
  kind: 'booking_fee' | 'session_fee'
  status: string
  amountRwf: number
  settledAt: string | null
}

/** What a client may be shown (`backend/src/booking/stage.ts`), in the order the legend lists them. */
export const CLIENT_STAGES = [
  'awaiting_payment',
  'confirmed',
  'in_progress',
  'completed',
  'closed',
  'no_show',
  'expired',
  'cancelled_by_client',
  'cancelled_by_photographer',
  'cancelled_by_platform',
] as const

export type ClientStage = (typeof CLIENT_STAGES)[number]

/**
 * One thing that happened to the booking, as its page lists them (2026-09-25):
 * built by the API from what it sent the client, with only the fields each
 * kind needs, and the photographer's notes. Newest first.
 */
export type ClientNotice = { id: string; at: string } & (
  | { kind: 'reschedule'; data: { startsAt: string; endsAt: string; previousStartsAt: string; previousEndsAt: string } }
  | { kind: 'session_fee_request'; data: { amountRwf: number } }
  | { kind: 'payment_receipt'; data: { amountRwf: number } }
  | { kind: 'photo_delivery'; data: Record<string, never> }
  | { kind: 'cancelled_by_photographer'; data: Record<string, never> }
  | { kind: 'balance_due'; data: { amountRwf: number } }
  | { kind: 'note'; data: { body: string } }
)

export type ClientBooking = {
  reference: string
  status: string
  /** The client's display stage (2026-09-25): never `needs_review`. */
  stage: ClientStage
  clientName: string
  /** Where the booking's emails go, masked by the API (`a•••••@example.com`): never the full address. */
  maskedEmail: string
  /** A change waiting on a click from the new address, masked; null when there is none. */
  pendingMaskedEmail: string | null
  startsAt: string
  endsAt: string
  serviceName: string
  packageName: string
  packagePriceRwf: number
  packagePhotoCount: number
  packageDurationMinutes: number
  locationText: string
  partySize: number | null
  specialRequests: string | null
  addons: { name: string; priceRwf: number; stage: string }[]
  totals: {
    quotedTotalRwf: number
    grandTotalRwf: number
    collectedRwf: number
    refundDueRwf: number
    outstandingRwf: number
  }
  bookingFeeRwf: number
  payments: ClientBookingPayment[]
  canCancel: boolean
  /** The cancellation terms this booking was made under; `deadline` is null once nothing is left to cancel. */
  cancellation: CancellationTerms
  cancellationReason: string | null
  cancelledAt: string | null
  /**
   * `waitingPayment.method` is how the attempt was started (backend
   * `booking/client-view.ts`): `card` is a card checkout still open, which the
   * page offers to reopen; a missing one reads as a phone prompt, as before cards.
   */
  sessionFee: { outstandingRwf: number; waitingPayment: { ourRef: string; method?: PaymentMethod | null } | null } | null
  delivery: { url: string | null; expiresOn: string | null; expired: boolean; note: string | null } | null
  notices: ClientNotice[]
}

/** Where a client's booking lives. The emails link here (`BOOKING_PAGE_PATH` on the API). */
export function bookingPath(token: string): string {
  return `/booking/${encodeURIComponent(token)}`
}

/** Where a session-fee payment is followed until it settles. */
export function bookingPaymentPath(token: string, ourRef: string): string {
  return `${bookingPath(token)}/payments/${encodeURIComponent(ourRef)}`
}

/** The booking, or null when the link is not valid -- unknown, expired or replaced. */
export async function fetchClientBooking(token: string, signal?: AbortSignal): Promise<ClientBooking | null> {
  const res = await get(`/booking/${encodeURIComponent(token)}`, signal)
  return bookingOf(res)
}

export type CancelBookingResult =
  | { status: 'cancelled'; booking: ClientBooking }
  /** Already cancelled, or past the shoot: the booking as it now stands. */
  | { status: 'not_cancellable'; booking: ClientBooking | null }
  | { status: 'not_found' }
  | { status: 'failed' }

export async function cancelBooking(token: string): Promise<CancelBookingResult> {
  let res: Response
  try {
    res = await fetch(`${env.VITE_API_BASE_URL}/booking/${encodeURIComponent(token)}/cancel`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
  } catch {
    return { status: 'failed' }
  }
  if (res.status === 404) return { status: 'not_found' }
  try {
    return cancelResultOf(res.status, await res.json())
  } catch {
    // Not the JSON this status promises.
    return { status: 'failed' }
  }
}

/**
 * A cancellation's answer, from its status and body: shared by the guest page
 * (the token) and the dashboard (the session, marketplace-spec R8.1), whose
 * answers carry the booking under the same key. Status 0 is no answer.
 */
export function cancelResultOf(status: number, body: unknown): CancelBookingResult {
  if (status === 404) return { status: 'not_found' }
  const booking = bookingOf(body)
  if (status >= 200 && status < 300 && booking !== null) return { status: 'cancelled', booking }
  if (status === 409) return { status: 'not_cancellable', booking }
  return { status: 'failed' }
}

/** Starts a session-fee payment. The outcomes are the checkout's, minus the ones only it can meet. */
export async function startSessionFeePayment(token: string, request: PayRequest): Promise<StartPaymentResult> {
  let res: Response
  try {
    res = await fetch(`${env.VITE_API_BASE_URL}/booking/${encodeURIComponent(token)}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payBody(request)),
    })
  } catch {
    return { status: 'failed' }
  }

  try {
    return sessionFeeResultOf(res.status, await res.json(), request.method)
  } catch {
    // Not the JSON this status promises.
    return { status: 'failed' }
  }
}

/**
 * A session-fee payment's answer, from its status and body: shared by the
 * guest page and the dashboard, which answer alike. Status 0 is no answer.
 * A card's 201 or 200 carries the Inline config (`startedPaymentOf`).
 */
export function sessionFeeResultOf(status: number, raw: unknown, method: PaymentMethod = 'momo_mtn'): StartPaymentResult {
  const body = raw as {
    error?: unknown
    reason?: unknown
    fields?: unknown
    payment?: { ourRef?: unknown; method?: unknown } | null
  } | null
  const ourRef = typeof body?.payment?.ourRef === 'string' ? body.payment.ourRef : null
  const started = startedPaymentOf(method, status, raw)
  if (started !== null) return started
  if (status === 404) return { status: 'not_found' }
  if (status === 409) {
    if (body?.error === 'payment_in_progress' && ourRef !== null) {
      return { status: 'in_progress', ourRef, method: knownMethodOf(body.payment?.method) }
    }
    // Paid, cancelled or rescheduled under the page: reloading shows which.
    return { status: 'closed' }
  }
  if (status === 422 && Array.isArray(body?.fields)) return { status: 'invalid', fields: body.fields.map(String) }
  if (status === 502 && (body?.reason === 'rejected' || body?.reason === 'unavailable')) {
    return { status: 'not_started', reason: body.reason }
  }
  return { status: 'failed' }
}

export type EmailChangeResult =
  /** A confirmation link is on its way to the new address; nothing changes until it is used. */
  | { status: 'requested'; booking: ClientBooking | null }
  /** It is the address the booking already has. */
  | { status: 'unchanged'; booking: ClientBooking | null }
  | { status: 'invalid' }
  /** The booking no longer stands. */
  | { status: 'not_allowed'; booking: ClientBooking | null }
  | { status: 'rate_limited' }
  | { status: 'not_found' }
  | { status: 'failed' }

/** Asks to change the booking's contact email (2026-09-25): `POST /api/booking/:token/email`. */
export async function requestEmailChange(token: string, email: string): Promise<EmailChangeResult> {
  let res: Response
  try {
    res = await fetch(`${env.VITE_API_BASE_URL}/booking/${encodeURIComponent(token)}/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email }),
    })
  } catch {
    return { status: 'failed' }
  }
  if (res.status === 404) return { status: 'not_found' }
  if (res.status === 422) return { status: 'invalid' }
  if (res.status === 429) return { status: 'rate_limited' }
  try {
    const booking = bookingOf(await res.json())
    if (res.status === 202) return { status: 'requested', booking }
    if (res.status === 200) return { status: 'unchanged', booking }
    if (res.status === 409) return { status: 'not_allowed', booking }
  } catch {
    // Not the JSON this status promises.
  }
  return { status: 'failed' }
}

/** Where a contact-email confirmation link lands. The emails link here (`EMAIL_CONFIRM_PAGE_PATH` on the API). */
export function emailConfirmPath(token: string): string {
  return `/email-confirm/${encodeURIComponent(token)}`
}

/** Confirms a contact-email change from its link: `POST /api/email-confirmations/:token`. */
export async function confirmEmailChange(token: string): Promise<'confirmed' | 'invalid' | 'failed'> {
  let res: Response
  try {
    res = await fetch(`${env.VITE_API_BASE_URL}/email-confirmations/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
  } catch {
    return 'failed'
  }
  if (res.status === 200) return 'confirmed'
  if (res.status === 404) return 'invalid'
  return 'failed'
}

async function get(path: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response
  try {
    // `no-store`: a booking's status and amounts change, and a cache must not answer for them.
    res = await fetch(`${env.VITE_API_BASE_URL}${path}`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new PaymentApiError(null)
  }
  if (res.status === 404) return null
  if (!res.ok) throw new PaymentApiError(res.status)
  try {
    return (await res.json()) as unknown
  } catch (error) {
    if (signal?.aborted) throw error
    throw new PaymentApiError(res.status)
  }
}

/** The booking in an answer, or null when the answer does not describe one. */
function bookingOf(body: unknown): ClientBooking | null {
  const booking = (body as { booking?: Partial<ClientBooking> | null } | null)?.booking
  if (typeof booking?.reference !== 'string' || typeof booking.status !== 'string' || typeof booking.totals !== 'object') {
    return null
  }
  return booking as ClientBooking
}
