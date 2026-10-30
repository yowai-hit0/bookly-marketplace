import { env } from '@/env'
import type { CancellationTerms } from '@/lib/cancellation'
import type { InlineCardConfig } from '@/lib/flutterwave-inline'

/**
 * Paying the booking fee (plan.md Task 16, spec §3.1 steps 9-10): the methods
 * on offer, a booking's checkout, starting a payment and following it.
 *
 * The methods come from the API, never from this file (spec §6.19): the pay
 * page renders what `GET /api/payment-methods` lists and nothing else. This
 * file only knows how to label a method; one it has no label for is dropped
 * rather than rendered blank.
 *
 * Since Phase 3 (marketplace-spec.md R3.1) each method is routed to its own
 * provider on the server -- MTN MoMo to MTN direct or Flutterwave, Airtel Money
 * to Flutterwave -- and the answer names no provider: the page needs only the
 * method, and which provider collects it is the server's business. `card` is
 * listed (last) when the server has Flutterwave's v3 keys (2026-10-30, "Cards
 * as built"): it needs no phone, and its answer is the Inline config the page
 * opens Flutterwave's modal with (`lib/flutterwave-inline.ts`).
 */

export const KNOWN_METHODS = ['momo_mtn', 'momo_airtel', 'card'] as const
export type PaymentMethod = (typeof KNOWN_METHODS)[number]

/** A method the API named, if it is one this page knows; anything else (an unknown method, no method) is null. */
export function knownMethodOf(value: unknown): PaymentMethod | null {
  return KNOWN_METHODS.find((method) => method === value) ?? null
}

/** Methods the payer pays from a phone, and so needs a number for. */
export const PHONE_METHODS: ReadonlySet<PaymentMethod> = new Set(['momo_mtn', 'momo_airtel'])

/** Whether the chosen method is paid from a phone, and so needs a number. */
export function needsPhoneFor(method: PaymentMethod | null): boolean {
  return method !== null && PHONE_METHODS.has(method)
}

export type CheckoutState = 'payable' | 'paid' | 'expired' | 'closed'

export type Checkout = {
  reference: string
  serviceName: string
  packageName: string
  startsAt: string
  endsAt: string
  holdExpiresAt: string | null
  bookingFeeRwf: number
  state: CheckoutState
  /**
   * An earlier attempt not yet settled. `method: 'card'` is a card checkout
   * still open: the page offers to reopen it (POST card again) rather than
   * follow a phone prompt. A missing method reads as a phone prompt, as before.
   */
  waitingPayment: { ourRef: string; method?: PaymentMethod | null } | null
  /** The cancellation terms the booking was made under, stated before the client pays. */
  cancellation: CancellationTerms
}

export type PaymentStatus = 'initiated' | 'pending' | 'succeeded' | 'failed' | 'refund_due' | 'refunded'

export type PaymentProgress = {
  payment: { status: PaymentStatus; amountRwf: number; failure: 'declined' | 'unavailable' | null }
  booking: {
    reference: string
    status: string
    serviceName: string
    packageName: string
    startsAt: string
    endsAt: string
  }
}

/** The API could not be reached or answered something unusable. `status` is null for a network failure. */
export class PaymentApiError extends Error {
  override readonly name = 'PaymentApiError'
  readonly status: number | null

  constructor(status: number | null) {
    super(status === null ? 'network_error' : `http_${status}`)
    this.status = status
  }
}

/** The link for a booking's checkout, as the booking API hands out its token. */
export function checkoutPath(reference: string, token: string): string {
  return `/checkout/${encodeURIComponent(reference)}/${encodeURIComponent(token)}`
}

/** Where a started payment is followed until it settles. */
export function paymentPath(reference: string, token: string, ourRef: string): string {
  return `${checkoutPath(reference, token)}/payments/${encodeURIComponent(ourRef)}`
}

export async function fetchPaymentMethods(signal?: AbortSignal): Promise<PaymentMethod[]> {
  const body = await getJson('/payment-methods', signal)
  const methods = (body as { methods?: unknown } | null)?.methods
  if (!Array.isArray(methods)) throw new PaymentApiError(200)
  return KNOWN_METHODS.filter((method) => methods.includes(method))
}

/** The checkout, or null when the link is not valid. */
export async function fetchCheckout(reference: string, token: string, signal?: AbortSignal): Promise<Checkout | null> {
  const body = await getJson(`/checkout/${encodeURIComponent(reference)}/${encodeURIComponent(token)}`, signal, true)
  if (body === null) return null
  const checkout = (body as { checkout?: Partial<Checkout> | null }).checkout
  if (typeof checkout?.reference !== 'string' || typeof checkout.state !== 'string') throw new PaymentApiError(200)
  return checkout as Checkout
}

/**
 * Where a payment stands, or null when there is no such payment. With a card
 * payment's `transactionId` (digits from the modal or Flutterwave's redirect),
 * the API verifies that try with Flutterwave first; its answer is still the
 * only word on the payment (R3.3).
 */
export async function fetchPaymentProgress(
  ourRef: string,
  signal?: AbortSignal,
  transactionId?: string | null,
): Promise<PaymentProgress | null> {
  const body = await getJson(`/payments/${encodeURIComponent(ourRef)}${transactionQuery(transactionId)}`, signal, true)
  if (body === null) return null
  const progress = body as Partial<PaymentProgress>
  if (typeof progress.payment?.status !== 'string' || typeof progress.booking?.reference !== 'string') {
    throw new PaymentApiError(200)
  }
  return progress as PaymentProgress
}

/** `?transactionId=` for a well-formed id (`^\d{1,20}$`), and nothing otherwise. */
export function transactionQuery(transactionId: string | null | undefined): string {
  return typeof transactionId === 'string' && /^\d{1,20}$/.test(transactionId) ? `?transactionId=${transactionId}` : ''
}

export type PayRequest = { method: PaymentMethod; phone: string }

/** The body a pay route is sent: `{ method: 'card' }` for a card, which needs no phone; `{ method, phone }` otherwise. */
export function payBody(request: PayRequest): { method: PaymentMethod; phone?: string } {
  return request.method === 'card' ? { method: 'card' } : { method: request.method, phone: request.phone }
}

export type StartPaymentResult =
  /** The phone has been prompted. */
  | { status: 'started'; ourRef: string }
  /**
   * A card payment: open Flutterwave's modal with `card`, unchanged. A new one
   * (201) and one whose checkout is still open (200, the same `ourRef` and
   * `tx_ref`) alike.
   */
  | { status: 'card'; ourRef: string; card: InlineCardConfig }
  /**
   * An earlier attempt is still waiting; follow that one. `method` is how it
   * was started: `card` is marked as a card for the progress page, so it
   * speaks of a card and not a phone; null (none, or unknown) reads as a phone.
   */
  | { status: 'in_progress'; ourRef: string; method: PaymentMethod | null }
  | { status: 'already_paid' }
  /** The hold ran out, or there is nothing left to pay. */
  | { status: 'closed' }
  /** The photographer can no longer be booked, so the booking fee is not taken (R3.4). Never a session fee. */
  | { status: 'photographer_unavailable' }
  | { status: 'not_found' }
  | { status: 'invalid'; fields: string[] }
  /** The provider refused the request, or could not be reached. */
  | { status: 'not_started'; reason: 'rejected' | 'unavailable' }
  /** Unreachable, or an answer this page cannot act on. */
  | { status: 'failed' }

export async function startPayment(reference: string, token: string, request: PayRequest): Promise<StartPaymentResult> {
  let res: Response
  try {
    res = await fetch(
      `${env.VITE_API_BASE_URL}/checkout/${encodeURIComponent(reference)}/${encodeURIComponent(token)}/payments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payBody(request)),
      },
    )
  } catch {
    return { status: 'failed' }
  }

  try {
    const body = (await res.json()) as {
      error?: unknown
      reason?: unknown
      fields?: unknown
      payment?: { ourRef?: unknown; method?: unknown } | null
    } | null
    const ourRef = typeof body?.payment?.ourRef === 'string' ? body.payment.ourRef : null
    const started = startedPaymentOf(request.method, res.status, body)
    if (started !== null) return started
    if (res.status === 404) return { status: 'not_found' }
    if (res.status === 409) {
      if (body?.error === 'payment_in_progress' && ourRef !== null) {
        return { status: 'in_progress', ourRef, method: knownMethodOf(body.payment?.method) }
      }
      if (body?.error === 'already_paid') return { status: 'already_paid' }
      if (body?.error === 'hold_expired' || body?.error === 'nothing_to_pay') return { status: 'closed' }
      if (body?.error === 'photographer_unavailable') return { status: 'photographer_unavailable' }
    }
    if (res.status === 422 && Array.isArray(body?.fields)) return { status: 'invalid', fields: body.fields.map(String) }
    if (res.status === 502 && (body?.reason === 'rejected' || body?.reason === 'unavailable')) {
      return { status: 'not_started', reason: body.reason }
    }
  } catch {
    // Not the JSON this status promises.
  }
  return { status: 'failed' }
}

/**
 * A pay route's "started" answer, shared by every pay page: a 201 for a phone
 * prompt, and a 201 or 200 carrying a well-formed Inline config for a card.
 * A card answer without one is `failed`; null means "not a started payment",
 * for the caller's own refusals.
 */
export function startedPaymentOf(method: PaymentMethod, status: number, raw: unknown): StartPaymentResult | null {
  const body = raw as { payment?: { ourRef?: unknown } | null; card?: unknown } | null
  const ourRef = typeof body?.payment?.ourRef === 'string' && body.payment.ourRef !== '' ? body.payment.ourRef : null
  if (ourRef === null || (status !== 201 && status !== 200)) return null
  if (method === 'card' || (typeof body === 'object' && body !== null && 'card' in body)) {
    const card = cardConfigOf(body?.card, ourRef)
    return card === null ? { status: 'failed' } : { status: 'card', ourRef, card }
  }
  return status === 201 ? { status: 'started', ourRef } : null
}

/**
 * The API's Inline config, checked for shape and never changed: the page must
 * not open a modal for another payment, another currency or no amount. Null
 * when anything is off, which the page reports as a payment that did not start.
 */
export function cardConfigOf(raw: unknown, ourRef: string): InlineCardConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const card = raw as Partial<Record<keyof InlineCardConfig, unknown>>
  const customer = card.customer as { email?: unknown; name?: unknown } | null | undefined
  const customizations = card.customizations as { title?: unknown } | null | undefined
  const configurations = card.configurations as { session_duration?: unknown } | null | undefined
  const ok =
    typeof card.public_key === 'string' &&
    card.public_key !== '' &&
    card.tx_ref === ourRef &&
    typeof card.amount === 'number' &&
    Number.isFinite(card.amount) &&
    card.amount > 0 &&
    card.currency === 'RWF' &&
    card.payment_options === 'card' &&
    isWebUrl(card.redirect_url) &&
    typeof customer?.email === 'string' &&
    typeof customer.name === 'string' &&
    typeof customizations?.title === 'string' &&
    typeof configurations?.session_duration === 'number'
  return ok ? (raw as InlineCardConfig) : null
}

function isWebUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** GETs a JSON body. With `allowNotFound`, a 404 is null rather than an error. */
async function getJson(path: string, signal: AbortSignal | undefined, allowNotFound = false): Promise<unknown> {
  let res: Response
  try {
    // `no-store`: a remembered answer is how a paid booking goes on looking unpaid.
    res = await fetch(`${env.VITE_API_BASE_URL}${path}`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new PaymentApiError(null)
  }
  if (allowNotFound && res.status === 404) return null
  if (!res.ok) throw new PaymentApiError(res.status)
  try {
    return (await res.json()) as unknown
  } catch (error) {
    if (signal?.aborted) throw error
    throw new PaymentApiError(res.status)
  }
}
