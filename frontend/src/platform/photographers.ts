import { BOOKING_STATUSES, type BookingStatus } from '@/admin/bookings'
import { SETUP_ITEMS, type SetupItem, isSetupItem } from '@/admin/setup'
import type { SubscriptionPeriod, SubscriptionStatus } from '@/admin/subscription'
import { apiFetch } from '@/auth/api'
import { type AuditEntry, normaliseEntries } from './audit'

/**
 * The platform console's photographers (marketplace spec R2.1b;
 * backend/openapi/paths/platform.yaml): the list, and the three moderation
 * changes. Every call carries the platform's own token (`apiFetch('platform')`);
 * a 401 drops the platform session and nothing else.
 */

export const PHOTOGRAPHER_STATUSES = ['pending', 'approved', 'suspended'] as const

export type PhotographerStatus = (typeof PHOTOGRAPHER_STATUSES)[number]

export type PlatformPhotographer = {
  id: string
  handle: string
  displayName: string
  email: string
  status: PhotographerStatus
  createdAt: string
  approvedAt: string | null
  approvedByUserId: string | null
  suspendedAt: string | null
  suspensionReason: string | null
  /** When the studio was submitted for review (Phase 7, R7.3); null until then. Approval needs it while pending. */
  submittedAt: string | null
  /**
   * The handle's latest change after submitting and before approval (Phase 7,
   * user decision 2026-10-27; every platform admin was emailed); null if none.
   */
  handleChangedAt: string | null
}

/** A row from an API before Phase 7's fields is a row not submitted, its handle unchanged. */
export function normalisePhotographer(row: PlatformPhotographer): PlatformPhotographer {
  return { ...row, submittedAt: row.submittedAt ?? null, handleChangedAt: row.handleChangedAt ?? null }
}

/**
 * Whether the row is flagged "handle changed since submission": pending,
 * submitted, and the handle changed since. Once approved the handle is locked
 * and the flag is history, so it is not shown.
 */
export function handleChangedSinceSubmission(photographer: PlatformPhotographer): photographer is PlatformPhotographer & { handleChangedAt: string } {
  return photographer.status === 'pending' && photographer.submittedAt !== null && photographer.handleChangedAt !== null
}

/**
 * The review queue's two halves (Phase 7 as built), a filter of their own
 * beside `status`: `awaiting` is pending and submitted (the only pending
 * photographers approval accepts), `setting_up` pending and not submitted.
 */
export const REVIEW_FILTERS = ['awaiting', 'setting_up'] as const

export type ReviewFilter = (typeof REVIEW_FILTERS)[number]

export function isReviewFilter(value: string | null): value is ReviewFilter {
  return value !== null && (REVIEW_FILTERS as readonly string[]).includes(value)
}

/** The list's filters; both may be left out, and the API combines them with AND. */
export type PhotographerFilter = { status?: PhotographerStatus; review?: ReviewFilter }

/** Whether a row belongs under `filter`, so a row the API just changed can leave a filtered list. */
export function matchesFilter(photographer: PlatformPhotographer, filter: PhotographerFilter): boolean {
  if (filter.status !== undefined && photographer.status !== filter.status) return false
  if (filter.review === 'awaiting') return photographer.status === 'pending' && photographer.submittedAt !== null
  if (filter.review === 'setting_up') return photographer.status === 'pending' && photographer.submittedAt === null
  return true
}

/** Approve is refused for a pending photographer who has not submitted (409 `not_submitted`). */
export function awaitsSubmission(photographer: PlatformPhotographer): boolean {
  return photographer.status === 'pending' && photographer.submittedAt === null
}

export type Moderation = 'approve' | 'suspend' | 'reactivate'

export function isPhotographerStatus(value: string | null): value is PhotographerStatus {
  return value !== null && (PHOTOGRAPHER_STATUSES as readonly string[]).includes(value)
}

async function moderate(id: string, action: Moderation, body?: unknown): Promise<PlatformPhotographer> {
  const answer = await apiFetch<{ photographer: PlatformPhotographer }>('platform', `/platform/photographers/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    // Approve and reactivate take no body.
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return normalisePhotographer(answer.photographer)
}

/**
 * One photographer in full (Phase 9; `GET /api/platform/photographers/:id`):
 * what the console's detail page weighs, in one read. The payout method is
 * MASKED (user decision 4): the network or bank, the account name and the
 * last four digits; the payouts screen, where money is sent, shows the full
 * number.
 */
export type PlatformPhotographerDetail = {
  photographer: PlatformPhotographer & { approvedBy: { id: string; email: string } | null }
  profile: {
    bio: string | null
    contactPhone: string | null
    whatsappPhone: string | null
    contactEmail: string | null
    coverImageUrl: string | null
    districts: { code: string; name: string }[]
    /** Every category they are tagged with; an inactive one is hidden from the public but still theirs. */
    categories: { slug: string; name: string; isActive: boolean }[]
  }
  setup: { items: { key: SetupItem; done: boolean }[]; missing: SetupItem[]; canSubmit: boolean }
  /** Null until approval creates it; the status is the status at the clock. */
  subscription: {
    id: string
    status: SubscriptionStatus
    currentPeriodEndsAt: string
    graceEndsAt: string
    createdAt: string
    takingBookings: boolean
    /** Newest first. */
    periods: SubscriptionPeriod[]
  } | null
  payoutMethod: MaskedPayoutMethod | null
  /** The current method was saved within the last 72 hours (R4.1). */
  methodChangedRecently: boolean
  counts: { bookings: Record<BookingStatus, number>; services: { total: number; active: number } }
  /** `payableRwf` may be negative, when reversals outweigh new earnings. */
  earnings: { payableRwf: number; inDraftRwf: number; paidOutRwf: number }
  /** The latest 20 audit entries about them, newest first. */
  activity: AuditEntry[]
}

export type MaskedPayoutMethod = {
  id: string
  kind: 'momo' | 'bank'
  /** The MoMo network (`mtn`, `airtel`) or the bank's name. */
  provider: string
  accountName: string
  last4: string
  createdAt: string
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function money(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : 0
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * The detail as the page can rely on it. The API's contract is strict; this
 * still fills what an older or partial answer leaves out (counts as 0, lists
 * as empty, the setup items in the checklist's order), so a missing field
 * never crashes the page.
 */
export function normaliseDetail(raw: PlatformPhotographerDetail): PlatformPhotographerDetail {
  const profile: Partial<PlatformPhotographerDetail['profile']> = raw.profile ?? {}
  const setup: Partial<PlatformPhotographerDetail['setup']> = raw.setup ?? {}
  const counts: Partial<PlatformPhotographerDetail['counts']> = raw.counts ?? {}
  const bookings: Partial<Record<string, unknown>> = counts.bookings ?? {}
  const services: Partial<Record<string, unknown>> = counts.services ?? {}
  const earnings: Partial<Record<string, unknown>> = raw.earnings ?? {}
  const items = (Array.isArray(setup.items) ? setup.items : []).filter((item) => isSetupItem(item?.key))
  const subscription = raw.subscription ?? null
  return {
    photographer: { ...normalisePhotographer(raw.photographer), approvedBy: raw.photographer.approvedBy ?? null },
    profile: {
      bio: textOrNull(profile.bio),
      contactPhone: textOrNull(profile.contactPhone),
      whatsappPhone: textOrNull(profile.whatsappPhone),
      contactEmail: textOrNull(profile.contactEmail),
      coverImageUrl: textOrNull(profile.coverImageUrl),
      districts: Array.isArray(profile.districts) ? profile.districts : [],
      categories: Array.isArray(profile.categories) ? profile.categories : [],
    },
    setup: {
      // Always in the checklist's order, each once.
      items: SETUP_ITEMS.flatMap((key) => items.filter((item) => item.key === key).slice(0, 1)).map((item) => ({ key: item.key, done: item.done === true })),
      missing: Array.isArray(setup.missing) ? SETUP_ITEMS.filter((key) => (setup.missing as unknown[]).includes(key)) : [],
      canSubmit: setup.canSubmit === true,
    },
    subscription: subscription === null ? null : { ...subscription, periods: Array.isArray(subscription.periods) ? subscription.periods : [] },
    payoutMethod: raw.payoutMethod ?? null,
    methodChangedRecently: raw.methodChangedRecently === true,
    counts: {
      bookings: Object.fromEntries(BOOKING_STATUSES.map((status) => [status, count(bookings[status])])) as Record<BookingStatus, number>,
      services: { total: count(services.total), active: count(services.active) },
    },
    earnings: { payableRwf: money(earnings.payableRwf), inDraftRwf: money(earnings.inDraftRwf), paidOutRwf: money(earnings.paidOutRwf) },
    activity: normaliseEntries(raw.activity),
  }
}

export const platformApi = {
  /** One photographer in full. A 404 names nobody; a 400 is an id that is not a uuid. */
  get: async (id: string): Promise<PlatformPhotographerDetail> =>
    normaliseDetail(
      await apiFetch<PlatformPhotographerDetail>('platform', `/platform/photographers/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    ),
  /** Newest first; every photographer when no filter is given. */
  list: async (filter: PhotographerFilter = {}): Promise<PlatformPhotographer[]> => {
    const query = new URLSearchParams()
    if (filter.status !== undefined) query.set('status', filter.status)
    if (filter.review !== undefined) query.set('review', filter.review)
    const search = query.toString()
    const answer = await apiFetch<{ photographers: PlatformPhotographer[] }>('platform', `/platform/photographers${search === '' ? '' : `?${search}`}`)
    return answer.photographers.map(normalisePhotographer)
  },
  approve: (id: string) => moderate(id, 'approve'),
  suspend: (id: string, reason: string) => moderate(id, 'suspend', { reason }),
  reactivate: (id: string) => moderate(id, 'reactivate'),
}

/** The moderation changes a photographer in `status` can take: none would be refused. */
export function movesFor(status: PhotographerStatus): Moderation[] {
  if (status === 'pending') return ['approve', 'suspend']
  if (status === 'approved') return ['suspend']
  return ['reactivate']
}
