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
  return answer.photographer
}

export const platformApi = {
  /** Newest first; every status when `status` is left out. */
  list: async (status?: PhotographerStatus): Promise<PlatformPhotographer[]> =>
    (
      await apiFetch<{ photographers: PlatformPhotographer[] }>(
        'platform',
        `/platform/photographers${status === undefined ? '' : `?status=${status}`}`,
      )
    ).photographers,
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
