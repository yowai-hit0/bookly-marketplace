import type { SubscriptionPeriod, SubscriptionStatus } from '@/admin/subscription'
import { apiFetch } from '@/auth/api'
import type { PhotographerStatus } from './photographers'

/**
 * Every photographer's subscription, for the platform (marketplace spec
 * Phase 5: R5.4, R9.3; backend/openapi/paths/platform-settings.yaml):
 * `GET /api/platform/subscriptions?status=`, the soonest to end first, the
 * status as of the API's clock. Carries the platform's own token.
 */

export type PlatformSubscription = {
  id: string
  photographer: { id: string; handle: string; displayName: string; status: PhotographerStatus }
  status: SubscriptionStatus
  currentPeriodEndsAt: string
  graceEndsAt: string
  createdAt: string
  /** Newest first. */
  periods: SubscriptionPeriod[]
}

export const platformSubscriptionsApi = {
  /** Every status when `status` is left out. */
  list: async (status?: SubscriptionStatus): Promise<PlatformSubscription[]> =>
    (
      await apiFetch<{ subscriptions: PlatformSubscription[] }>(
        'platform',
        `/platform/subscriptions${status === undefined ? '' : `?status=${status}`}`,
        { cache: 'no-store' },
      )
    ).subscriptions,
}

/** Soonest end first, as the API sorts them; kept here too so the table never depends on the order it arrived in. */
export function soonestEndFirst(subscriptions: readonly PlatformSubscription[]): PlatformSubscription[] {
  return [...subscriptions].sort((a, b) => new Date(a.currentPeriodEndsAt).getTime() - new Date(b.currentPeriodEndsAt).getTime())
}
