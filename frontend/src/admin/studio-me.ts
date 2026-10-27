import { adminFetch } from './api'
import { type SubscriptionStatus, isSubscriptionStatus } from './subscription'

/**
 * `GET /api/studio/me` (marketplace spec R7.4, Phase 7 as built): who is
 * signed in, the studio's moderation state and, once approved, where its
 * subscription stands at the API's clock. Everything the studio's banners and
 * its nav need, in one read the layout makes on every visit.
 */

export const STUDIO_STATUSES = ['pending', 'approved', 'suspended'] as const
export type StudioStatus = (typeof STUDIO_STATUSES)[number]

export type StudioMeSubscription = {
  status: SubscriptionStatus
  currentPeriodEndsAt: string
  graceEndsAt: string
  takingBookings: boolean
  /** Trialing or active, and the period ends within the platform's reminder days (the API decides). */
  endingSoon: boolean
}

export type StudioMe = {
  photographer: {
    id: string
    handle: string
    displayName: string
    status: StudioStatus
    /** When the studio was submitted for review; null until then (and for studios approved before Phase 7). */
    submittedAt: string | null
    suspensionReason: string | null
  }
  /** Null until approval creates it. */
  subscription: StudioMeSubscription | null
}

const text = (value: unknown): value is string => typeof value === 'string'
const textOrNull = (value: unknown): string | null => (text(value) ? value : null)

function isStudioStatus(value: unknown): value is StudioStatus {
  return text(value) && (STUDIO_STATUSES as readonly string[]).includes(value)
}

/**
 * The answer as the layout can trust it, or null. A body without a known
 * status is null (no banner is better than a wrong one); a subscription it
 * cannot read is dropped on its own, so the moderation banners still show.
 */
export function parseStudioMe(body: unknown): StudioMe | null {
  if (body === null || typeof body !== 'object') return null
  const { photographer, subscription } = body as { photographer?: Record<string, unknown> | null; subscription?: Record<string, unknown> | null }
  if (photographer === null || typeof photographer !== 'object' || !isStudioStatus(photographer.status)) return null
  return {
    photographer: {
      id: text(photographer.id) ? photographer.id : '',
      handle: text(photographer.handle) ? photographer.handle : '',
      displayName: text(photographer.displayName) ? photographer.displayName : '',
      status: photographer.status,
      submittedAt: textOrNull(photographer.submittedAt),
      suspensionReason: textOrNull(photographer.suspensionReason),
    },
    subscription: parseSubscription(subscription),
  }
}

function parseSubscription(value: Record<string, unknown> | null | undefined): StudioMeSubscription | null {
  if (value === null || typeof value !== 'object') return null
  const status = text(value.status) ? value.status : null
  if (!isSubscriptionStatus(status) || !text(value.currentPeriodEndsAt) || !text(value.graceEndsAt)) return null
  return {
    status,
    currentPeriodEndsAt: value.currentPeriodEndsAt,
    graceEndsAt: value.graceEndsAt,
    takingBookings: value.takingBookings === true,
    endingSoon: value.endingSoon === true,
  }
}

export const studioMeApi = {
  /** A 401 throws `UnauthenticatedError` (the session is dropped); an unreadable body is null. */
  load: async (): Promise<StudioMe | null> => parseStudioMe(await adminFetch<unknown>('/studio/me', { cache: 'no-store' })),
}

/**
 * The one banner above every studio page, by priority (Phase 7 brief, F2):
 * suspended, then pending (setup not yet submitted, or awaiting review), then
 * the subscription: past due, expired, a trial ending, a paid period ending.
 */
export type StudioBanner =
  | { kind: 'suspended'; reason: string | null }
  | { kind: 'setup' }
  | { kind: 'awaiting_review' }
  | { kind: 'past_due' | 'expired' | 'trial_ending' | 'period_ending'; subscription: StudioMeSubscription }

export function studioBanner(me: StudioMe | null): StudioBanner | null {
  if (me === null) return null
  const { photographer, subscription } = me
  if (photographer.status === 'suspended') return { kind: 'suspended', reason: blankToNull(photographer.suspensionReason) }
  if (photographer.status === 'pending') return photographer.submittedAt === null ? { kind: 'setup' } : { kind: 'awaiting_review' }
  if (subscription === null) return null
  if (subscription.status === 'past_due') return { kind: 'past_due', subscription }
  if (subscription.status === 'expired') return { kind: 'expired', subscription }
  if (!subscription.endingSoon) return null
  return { kind: subscription.status === 'trialing' ? 'trial_ending' : 'period_ending', subscription }
}

function blankToNull(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value
}

/** The subscription banners, which the subscription page itself makes redundant. */
export function isSubscriptionBanner(banner: StudioBanner): boolean {
  return banner.kind === 'past_due' || banner.kind === 'expired' || banner.kind === 'trial_ending' || banner.kind === 'period_ending'
}
