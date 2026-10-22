import type {
  StudioSubscription,
  SubscriptionPage,
  SubscriptionPayment,
  SubscriptionPaymentProgress,
  SubscriptionPeriod,
} from '@/admin/subscription'
import type { PlatformSubscription } from '@/platform/subscriptions'

/**
 * The studio subscription's shapes as the API answers them
 * (backend/openapi/components/subscriptions.yaml), for the page and client
 * tests. Every date is fixed, so a test that fakes the clock knows exactly
 * which side of each one it stands on.
 */

export const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'

export function trialPeriod(overrides: Partial<SubscriptionPeriod> = {}): SubscriptionPeriod {
  return {
    id: 'per-trial',
    kind: 'trial',
    planInterval: null,
    priceRwf: 0,
    startsAt: '2026-10-01T08:00:00.000Z',
    endsAt: '2026-10-31T08:00:00.000Z',
    paidAt: null,
    ...overrides,
  }
}

export function paidPeriod(overrides: Partial<SubscriptionPeriod> = {}): SubscriptionPeriod {
  return {
    id: 'per-paid',
    kind: 'paid',
    planInterval: 'monthly',
    priceRwf: 10_000,
    startsAt: '2026-10-31T08:00:00.000Z',
    endsAt: '2026-11-30T08:00:00.000Z',
    paidAt: '2026-10-25T09:15:00.000Z',
    ...overrides,
  }
}

export function subscriptionPayment(overrides: Partial<SubscriptionPayment> = {}): SubscriptionPayment {
  return {
    ourRef: OUR_REF,
    status: 'pending',
    planInterval: 'monthly',
    amountRwf: 10_000,
    method: 'momo_mtn',
    failure: null,
    initiatedAt: '2026-10-25T09:14:00.000Z',
    settledAt: null,
    ...overrides,
  }
}

export function studioSubscription(overrides: Partial<StudioSubscription> = {}): StudioSubscription {
  const trial = trialPeriod()
  return {
    id: 'sub1',
    status: 'trialing',
    currentPeriodEndsAt: trial.endsAt,
    graceEndsAt: '2026-11-07T08:00:00.000Z',
    takingBookings: true,
    currentPeriod: trial,
    periods: [trial],
    paymentInProgress: null,
    ...overrides,
  }
}

export function subscriptionPage(overrides: Partial<SubscriptionPage> = {}): SubscriptionPage {
  return {
    subscription: studioSubscription(),
    prices: { monthly: 10_000, yearly: 100_000 },
    methods: ['momo_mtn', 'momo_airtel'],
    graceDays: 7,
    ...overrides,
  }
}

export function paymentProgress(
  payment: Partial<SubscriptionPayment> = {},
  subscription: Partial<SubscriptionPaymentProgress['subscription']> = {},
): SubscriptionPaymentProgress {
  return {
    payment: subscriptionPayment(payment),
    subscription: { status: 'trialing', currentPeriodEndsAt: '2026-10-31T08:00:00.000Z', takingBookings: true, ...subscription },
  }
}

export function platformSubscription(overrides: Partial<PlatformSubscription> = {}): PlatformSubscription {
  return {
    id: 'sub1',
    photographer: { id: 'ph1', handle: 'kigali-lens', displayName: 'Kigali Lens', status: 'approved' },
    status: 'trialing',
    currentPeriodEndsAt: '2026-10-31T08:00:00.000Z',
    graceEndsAt: '2026-11-07T08:00:00.000Z',
    createdAt: '2026-10-01T08:00:00.000Z',
    periods: [trialPeriod()],
    ...overrides,
  }
}
