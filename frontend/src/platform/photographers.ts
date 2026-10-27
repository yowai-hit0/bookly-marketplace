import { apiFetch } from '@/auth/api'

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

export const platformApi = {
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
