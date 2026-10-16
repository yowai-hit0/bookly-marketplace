import { env } from '@/env'

/**
 * Paying the booking fee (plan.md Task 16, spec §3.1 steps 9-10): the methods
 * on offer, a booking's checkout, starting a payment and following it.
 *
 * The methods come from the API, never from this file (spec §6.19): the pay
 * page renders what `GET /api/payment-methods` lists and nothing else. This
 * file only knows how to label a method; one it has no label for is dropped
 * rather than rendered blank.
 */

export const KNOWN_METHODS = ['momo_mtn', 'momo_airtel', 'card'] as const
export type PaymentMethod = (typeof KNOWN_METHODS)[number]

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
  /** An earlier attempt still waiting on the payer's phone. */
  waitingPayment: { ourRef: string } | null
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

/** Where a payment stands, or null when there is no such payment. */
export async function fetchPaymentProgress(ourRef: string, signal?: AbortSignal): Promise<PaymentProgress | null> {
  const body = await getJson(`/payments/${encodeURIComponent(ourRef)}`, signal, true)
  if (body === null) return null
  const progress = body as Partial<PaymentProgress>
  if (typeof progress.payment?.status !== 'string' || typeof progress.booking?.reference !== 'string') {
    throw new PaymentApiError(200)
  }
  return progress as PaymentProgress
}

export type StartPaymentResult =
  /** The phone has been prompted. */
  | { status: 'started'; ourRef: string }
  /** An earlier prompt is still waiting; follow that one. */
  | { status: 'in_progress'; ourRef: string }
  | { status: 'already_paid' }
  /** The hold ran out, or there is nothing left to pay. */
  | { status: 'closed' }
  | { status: 'not_found' }
  | { status: 'invalid'; fields: string[] }
  /** The provider refused the request, or could not be reached. */
  | { status: 'not_started'; reason: 'rejected' | 'unavailable' }
  /** Unreachable, or an answer this page cannot act on. */
  | { status: 'failed' }

export async function startPayment(
  reference: string,
  token: string,
  request: { method: PaymentMethod; phone: string },
): Promise<StartPaymentResult> {
  let res: Response
  try {
    res = await fetch(
      `${env.VITE_API_BASE_URL}/checkout/${encodeURIComponent(reference)}/${encodeURIComponent(token)}/payments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(request),
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
      payment?: { ourRef?: unknown } | null
    } | null
    const ourRef = typeof body?.payment?.ourRef === 'string' ? body.payment.ourRef : null
    if (res.status === 201 && ourRef !== null) return { status: 'started', ourRef }
    if (res.status === 404) return { status: 'not_found' }
    if (res.status === 409) {
      if (body?.error === 'payment_in_progress' && ourRef !== null) return { status: 'in_progress', ourRef }
      if (body?.error === 'already_paid') return { status: 'already_paid' }
      if (body?.error === 'hold_expired' || body?.error === 'nothing_to_pay') return { status: 'closed' }
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
