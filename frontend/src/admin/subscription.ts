import { ApiError } from '@/auth/api'
import { PHONE_METHODS, type PaymentMethod, type PaymentStatus } from '@/catalogue/payments'
import { adminFetch } from './api'

/**
 * The studio's subscription (marketplace spec Phase 5: R5.2, R5.3;
 * backend/openapi/paths/studio-subscription.yaml): the page's data, paying for
 * a month or a year by Mobile Money, and following that payment until it
 * settles. Every call carries the studio token (`adminFetch`), and every answer
 * is `no-store` on the server; the requests ask for it too, so a remembered
 * answer never shows a paid period as unpaid.
 *
 * The amount is the server's: the request names the plan, never a price
 * (T5.3). The methods are the API's answer and nothing else (R3.1), MoMo only
 * while cards are deferred; an empty list means no provider is configured.
 */

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'expired'] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export function isSubscriptionStatus(value: string | null): value is SubscriptionStatus {
  return value !== null && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
}

export const PLAN_INTERVALS = ['monthly', 'yearly'] as const
export type PlanInterval = (typeof PLAN_INTERVALS)[number]

/** A method the subscription can be paid by: a phone method. */
export type SubscriptionMethod = Extract<PaymentMethod, 'momo_mtn' | 'momo_airtel'>

/** One stretch of time the subscription covers: the free trial, or a paid month or year. */
export type SubscriptionPeriod = {
  id: string
  kind: 'trial' | 'paid'
  /** Null for the trial. */
  planInterval: PlanInterval | null
  /** What was paid; 0 for the trial. */
  priceRwf: number
  startsAt: string
  endsAt: string
  /** When its payment succeeded; null for the trial. */
  paidAt: string | null
}

export type SubscriptionPayment = {
  ourRef: string
  status: PaymentStatus
  planInterval: PlanInterval
  amountRwf: number
  method: SubscriptionMethod | null
  /** Why a failed payment failed, as the payer may be told it. */
  failure: 'declined' | 'unavailable' | null
  initiatedAt: string
  settledAt: string | null
}

export type StudioSubscription = {
  id: string
  /** At the clock, not the job's last record. */
  status: SubscriptionStatus
  currentPeriodEndsAt: string
  /** When a lapsed subscription becomes `expired` and the profile is hidden. */
  graceEndsAt: string
  takingBookings: boolean
  currentPeriod: SubscriptionPeriod | null
  /** Newest first. */
  periods: SubscriptionPeriod[]
  /** A payment still waiting on the payer; it blocks another. */
  paymentInProgress: SubscriptionPayment | null
}

export type SubscriptionPage = {
  /** Null only for a photographer never approved. */
  subscription: StudioSubscription | null
  prices: { monthly: number; yearly: number }
  /** Empty when no payment provider is configured. */
  methods: SubscriptionMethod[]
  graceDays: number
}

/** Where a payment stands, and the subscription as it now stands. */
export type SubscriptionPaymentProgress = {
  payment: SubscriptionPayment
  subscription: { status: SubscriptionStatus; currentPeriodEndsAt: string; takingBookings: boolean }
}

export type PayRequest = { planInterval: PlanInterval; method: SubscriptionMethod; phone: string }

export type PayResult =
  /** The phone has been prompted: follow `ourRef`. */
  | { status: 'started'; ourRef: string; planInterval: PlanInterval; amountRwf: number }
  /** Another payment still waits on the payer: follow that one instead. */
  | { status: 'in_progress'; ourRef: string }
  /** Pending or suspended: the subscription cannot be paid now. */
  | { status: 'not_approved' }
  | { status: 'no_subscription' }
  /** 422: the fields the API refused (`method`, `phone`). */
  | { status: 'invalid'; fields: string[] }
  /** 400: a request the API could not read. */
  | { status: 'bad_request' }
  | { status: 'rate_limited' }
  /** 502: the provider refused the request, or could not be reached. */
  | { status: 'not_started'; reason: 'rejected' | 'unavailable' }
  /** Unreachable, or an answer the page cannot act on. */
  | { status: 'failed' }

const NO_STORE: RequestInit = { cache: 'no-store' }

/** The phone methods, in the order the checkout offers them. */
export const SUBSCRIPTION_METHODS = ['momo_mtn', 'momo_airtel'] as const satisfies readonly SubscriptionMethod[]

/** Only the methods this app can label and pay from a phone; anything else (a card) is dropped, not drawn blank. */
function phoneMethods(methods: unknown): SubscriptionMethod[] {
  if (!Array.isArray(methods)) return []
  return SUBSCRIPTION_METHODS.filter((method) => PHONE_METHODS.has(method) && methods.includes(method))
}

export const subscriptionApi = {
  /** The page. A 401 throws `UnauthenticatedError` (the session is dropped); anything else unusable throws. */
  load: async (): Promise<SubscriptionPage> => {
    const body = await adminFetch<Partial<SubscriptionPage> | null>('/studio/subscription', NO_STORE)
    if (
      body === null ||
      typeof body !== 'object' ||
      !('subscription' in body) ||
      typeof body.prices?.monthly !== 'number' ||
      typeof body.prices.yearly !== 'number'
    ) {
      throw new ApiError(200, 'unexpected_body')
    }
    return {
      subscription: body.subscription ?? null,
      prices: body.prices,
      methods: phoneMethods(body.methods),
      graceDays: typeof body.graceDays === 'number' ? body.graceDays : 0,
    }
  },

  /** Starts a payment for the plan. Never throws for a refusal: each is a `PayResult`. A 401 still throws. */
  pay: async (request: PayRequest): Promise<PayResult> => {
    try {
      const body = await adminFetch<{ payment?: { ourRef?: unknown; planInterval?: unknown; amountRwf?: unknown } | null } | null>(
        '/studio/subscription/payments',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) },
      )
      const payment = body?.payment
      if (typeof payment?.ourRef === 'string' && payment.ourRef !== '') {
        return {
          status: 'started',
          ourRef: payment.ourRef,
          planInterval: payment.planInterval === 'yearly' ? 'yearly' : payment.planInterval === 'monthly' ? 'monthly' : request.planInterval,
          amountRwf: typeof payment.amountRwf === 'number' ? payment.amountRwf : 0,
        }
      }
      return { status: 'failed' }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 401) throw error
      return refusalOf(error)
    }
  },

  /** Where a payment stands, or null when there is no such payment of this studio's. */
  payment: async (ourRef: string): Promise<SubscriptionPaymentProgress | null> => {
    try {
      const body = await adminFetch<Partial<SubscriptionPaymentProgress> | null>(
        `/studio/subscription/payments/${encodeURIComponent(ourRef)}`,
        NO_STORE,
      )
      if (typeof body?.payment?.status !== 'string' || typeof body.subscription?.currentPeriodEndsAt !== 'string') {
        throw new ApiError(200, 'unexpected_body')
      }
      return body as SubscriptionPaymentProgress
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }
  },
}

function refusalOf(error: ApiError): PayResult {
  const body = (typeof error.body === 'object' && error.body !== null ? error.body : {}) as {
    reason?: unknown
    payment?: { ourRef?: unknown } | null
  }
  switch (error.status) {
    case 400:
      return { status: 'bad_request' }
    case 409: {
      if (error.message === 'photographer_not_approved') return { status: 'not_approved' }
      if (error.message === 'no_subscription') return { status: 'no_subscription' }
      const ourRef = body.payment?.ourRef
      if (error.message === 'payment_in_progress' && typeof ourRef === 'string' && ourRef !== '') return { status: 'in_progress', ourRef }
      return { status: 'failed' }
    }
    case 422:
      return error.fields.length > 0 ? { status: 'invalid', fields: [...error.fields] } : { status: 'failed' }
    case 429:
      return { status: 'rate_limited' }
    case 502:
      return body.reason === 'rejected' || body.reason === 'unavailable' ? { status: 'not_started', reason: body.reason } : { status: 'failed' }
    default:
      return { status: 'failed' }
  }
}

/** How a payment's status reads on the page: still waiting, settled either way, or neither. */
export type PaymentOutcome = 'waiting' | 'succeeded' | 'failed' | 'other'

export function paymentOutcome(status: string): PaymentOutcome {
  if (status === 'initiated' || status === 'pending') return 'waiting'
  if (status === 'succeeded') return 'succeeded'
  if (status === 'failed') return 'failed'
  // A subscription payment is never refunded (R5.3 as built); say nothing rather than guess.
  return 'other'
}

/** What a year saves against twelve months, in RWF; null when it saves nothing. */
export function yearlySaving(prices: { monthly: number; yearly: number }): number | null {
  const saving = prices.monthly * 12 - prices.yearly
  return saving > 0 ? saving : null
}

/** A banner shows when a trial or paid period ends within this many days (Phase 5 brief, unit 2). */
export const ENDING_SOON_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

export type SubscriptionBanner = 'past_due' | 'expired' | 'trial_ending' | 'period_ending'

/**
 * The banner above every studio page for this subscription at `now`, or null:
 * lapsed (`past_due`), hidden (`expired`), or a trial or paid period ending
 * within seven days. A period already over without the status having caught up
 * is not "ending": the status the API computed at its clock says what it is.
 */
export function subscriptionBanner(subscription: Pick<StudioSubscription, 'status' | 'currentPeriodEndsAt'> | null, now: Date): SubscriptionBanner | null {
  if (subscription === null) return null
  if (subscription.status === 'past_due') return 'past_due'
  if (subscription.status === 'expired') return 'expired'
  const left = new Date(subscription.currentPeriodEndsAt).getTime() - now.getTime()
  if (Number.isNaN(left) || left <= 0 || left > ENDING_SOON_DAYS * DAY_MS) return null
  return subscription.status === 'trialing' ? 'trial_ending' : 'period_ending'
}

/** The latest paid period, newest first as the API lists them; null when nothing was ever paid. */
export function lastPaidPeriod(periods: readonly SubscriptionPeriod[]): SubscriptionPeriod | null {
  return periods.find((period) => period.kind === 'paid') ?? null
}
