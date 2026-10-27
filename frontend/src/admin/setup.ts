import { ApiError, adminFetch } from './api'
import type { StudioStatus } from './studio-me'

/**
 * The studio's setup checklist (marketplace spec R7.3, T7.1;
 * backend/openapi/components/onboarding.yaml): six items, each judged by the
 * API from the studio as it is now, and the one submission for review.
 * `canSubmit` is the API's: pending, not submitted yet, every item done.
 */

export const SETUP_ITEMS = ['profile', 'categories', 'districts', 'payoutMethod', 'services', 'workingHours'] as const
export type SetupItem = (typeof SETUP_ITEMS)[number]

export function isSetupItem(value: unknown): value is SetupItem {
  return typeof value === 'string' && (SETUP_ITEMS as readonly string[]).includes(value)
}

export type Setup = {
  items: { key: SetupItem; done: boolean }[]
  missing: SetupItem[]
  status: StudioStatus
  submittedAt: string | null
  canSubmit: boolean
}

/** Where each item is fixed. Categories and districts are on the profile, at their own fieldsets. */
export const SETUP_LINKS: Record<SetupItem, string> = {
  profile: '/studio/profile',
  categories: '/studio/profile#categories',
  districts: '/studio/profile#districts',
  payoutMethod: '/studio/payout-method',
  services: '/studio/catalogue',
  workingHours: '/studio/availability',
}

function parseSetup(value: unknown): Setup | null {
  const setup = value as Partial<Record<keyof Setup, unknown>> | null
  if (setup === null || typeof setup !== 'object' || !Array.isArray(setup.items)) return null
  const status = setup.status
  if (status !== 'pending' && status !== 'approved' && status !== 'suspended') return null
  const items = setup.items.flatMap((item: { key?: unknown; done?: unknown } | null) =>
    item !== null && typeof item === 'object' && isSetupItem(item.key) ? [{ key: item.key, done: item.done === true }] : [],
  )
  return {
    // Always in the checklist's order, whatever order they came in.
    items: SETUP_ITEMS.flatMap((key) => items.filter((item) => item.key === key).slice(0, 1)),
    missing: Array.isArray(setup.missing) ? SETUP_ITEMS.filter((key) => (setup.missing as unknown[]).includes(key)) : [],
    status,
    submittedAt: typeof setup.submittedAt === 'string' ? setup.submittedAt : null,
    canSubmit: setup.canSubmit === true,
  }
}

export type SubmitResult =
  | { status: 'submitted'; setup: Setup }
  /** 422 `setup_incomplete`: the items still missing, in checklist order. */
  | { status: 'incomplete'; missing: SetupItem[] }
  /** 409 `not_pending`: approved or suspended meanwhile. */
  | { status: 'not_pending' }
  | { status: 'failed' }

export const setupApi = {
  /** The checklist. A 401 throws `UnauthenticatedError`; anything unusable throws. */
  load: async (): Promise<Setup> => {
    const body = await adminFetch<{ setup?: unknown } | null>('/studio/setup', { cache: 'no-store' })
    const setup = parseSetup(body?.setup)
    if (setup === null) throw new ApiError(200, 'unexpected_body')
    return setup
  },

  /** Submits for review (idempotent once submitted). Never throws for a refusal; a 401 still throws. */
  submit: async (): Promise<SubmitResult> => {
    try {
      const body = await adminFetch<{ setup?: unknown } | null>('/studio/setup/submit', { method: 'POST' })
      const setup = parseSetup(body?.setup)
      return setup === null ? { status: 'failed' } : { status: 'submitted', setup }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 401) throw error
      if (error.status === 409 && error.message === 'not_pending') return { status: 'not_pending' }
      if (error.status === 422 && error.message === 'setup_incomplete') {
        const missing = (error.body as { missing?: unknown } | null)?.missing
        return { status: 'incomplete', missing: Array.isArray(missing) ? SETUP_ITEMS.filter((key) => missing.includes(key)) : [] }
      }
      return { status: 'failed' }
    }
  },
}
