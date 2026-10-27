import type { PortfolioImage } from '@/admin/portfolio'
import type { StudioProfile } from '@/admin/profile'
import { SETUP_ITEMS, type SetupItem } from '@/admin/setup'

/**
 * Answers for the studio's onboarding pages (Phase 7: profile, portfolio,
 * setup), as `backend/openapi/components/onboarding.yaml` shapes them.
 */

export const PROFILE: StudioProfile = {
  handle: 'kigali-lens',
  handleEditable: true,
  displayName: 'Kigali Lens',
  bio: 'Portraits in natural light.',
  contactPhone: '+250781234567',
  whatsappPhone: null,
  contactEmail: null,
  coverImageUrl: 'https://images.example/cover.jpg',
  districts: [{ code: 'gasabo', name: 'Gasabo' }],
  categories: [{ slug: 'portrait', name: 'Portrait' }],
  status: 'pending',
  submittedAt: null,
}

export const CATEGORIES = [
  { slug: 'portrait', name: 'Portrait' },
  { slug: 'wedding', name: 'Wedding' },
  { slug: 'events', name: 'Events' },
]

export const PROVINCES = [
  {
    code: 'kigali',
    name: 'Kigali City',
    districts: [
      { code: 'gasabo', name: 'Gasabo' },
      { code: 'kicukiro', name: 'Kicukiro' },
      { code: 'nyarugenge', name: 'Nyarugenge' },
    ],
  },
  { code: 'western', name: 'Western Province', districts: [{ code: 'rubavu', name: 'Rubavu' }, { code: 'karongi', name: 'Karongi' }] },
]

export function portfolioImage(n: number, caption: string | null = null): PortfolioImage {
  return { id: `00000000-0000-4000-8000-00000000000${n}`, url: `https://images.example/${n}.jpg`, caption, sortOrder: n - 1, createdAt: '2026-10-01T00:00:00.000Z' }
}

/** `GET /api/studio/setup` with these items done; the rest follows from them as the API derives it. */
export function setupBody(done: Partial<Record<SetupItem, boolean>> = {}, rest: Record<string, unknown> = {}) {
  const items = SETUP_ITEMS.map((key) => ({ key, done: done[key] ?? false }))
  const status = rest.status ?? 'pending'
  const submittedAt = rest.submittedAt ?? null
  return {
    setup: {
      items,
      missing: items.filter((item) => !item.done).map((item) => item.key),
      status,
      submittedAt,
      canSubmit: status === 'pending' && submittedAt === null && items.every((item) => item.done),
      ...rest,
    },
  }
}

export const ALL_DONE = Object.fromEntries(SETUP_ITEMS.map((key) => [key, true])) as Record<SetupItem, boolean>
