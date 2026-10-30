import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import {
  type PlatformPhotographer,
  awaitsSubmission,
  handleChangedSinceSubmission,
  isReviewFilter,
  matchesFilter,
  platformApi,
} from './photographers'

/** The platform's photographers client: the list's two filters (Phase 7) and which rows each covers. */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

function row(overrides: Partial<PlatformPhotographer> = {}): PlatformPhotographer {
  return {
    id: 'p1',
    handle: 'h',
    displayName: 'H',
    email: 'h@example.com',
    status: 'pending',
    createdAt: '2026-10-01T00:00:00.000Z',
    approvedAt: null,
    approvedByUserId: null,
    suspendedAt: null,
    suspensionReason: null,
    submittedAt: null,
    handleChangedAt: null,
    ...overrides,
  }
}

beforeEach(() => saveSession('platform', SESSION))
afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('platformApi.list', () => {
  it.each([
    [{}, '/api/platform/photographers'],
    [{ status: 'approved' as const }, '/api/platform/photographers?status=approved'],
    [{ review: 'awaiting' as const }, '/api/platform/photographers?review=awaiting'],
    [{ status: 'pending' as const, review: 'setting_up' as const }, '/api/platform/photographers?status=pending&review=setting_up'],
  ])('asks for %j at %s', async (filter, url) => {
    const api = stubApi(() => json({ photographers: [] }))
    await platformApi.list(filter)
    expect(api.sent[0]?.url).toBe(url)
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
  })

  it('reads a row with no submittedAt as not submitted', async () => {
    const { submittedAt: _, ...legacy } = row()
    stubApi(() => json({ photographers: [legacy] }))
    expect((await platformApi.list())[0]?.submittedAt).toBeNull()
  })

  it('reads a row with no handleChangedAt as a handle unchanged, and keeps one it has', async () => {
    const { handleChangedAt: _, ...legacy } = row()
    const changed = row({ id: 'p2', submittedAt: '2026-10-02T00:00:00.000Z', handleChangedAt: '2026-10-03T00:00:00.000Z' })
    stubApi(() => json({ photographers: [legacy, changed] }))
    expect((await platformApi.list()).map((each) => each.handleChangedAt)).toEqual([null, '2026-10-03T00:00:00.000Z'])
  })

  it('reads a moderated row the same way', async () => {
    const { handleChangedAt: _, ...legacy } = row({ submittedAt: '2026-10-02T00:00:00.000Z' })
    stubApi(() => json({ photographer: { ...legacy, status: 'approved' } }))
    await expect(platformApi.approve('p1')).resolves.toMatchObject({ status: 'approved', handleChangedAt: null })
  })
})

describe('handleChangedSinceSubmission (Phase 7, 2026-10-27)', () => {
  const SUBMITTED = { submittedAt: '2026-10-02T00:00:00.000Z', handleChangedAt: '2026-10-03T00:00:00.000Z' }

  it('flags a pending, submitted studio whose handle changed since', () => {
    expect(handleChangedSinceSubmission(row(SUBMITTED))).toBe(true)
  })

  it.each([
    ['unchanged', row({ submittedAt: '2026-10-02T00:00:00.000Z' })],
    ['approved since (the handle is locked; the flag is history)', row({ ...SUBMITTED, status: 'approved' })],
    ['suspended', row({ ...SUBMITTED, status: 'suspended' })],
    ['never submitted', row({ handleChangedAt: '2026-10-03T00:00:00.000Z' })],
  ])('does not flag one %s', (_label, photographer) => {
    expect(handleChangedSinceSubmission(photographer)).toBe(false)
  })
})

describe('the review filters', () => {
  it('knows its two values only', () => {
    expect(isReviewFilter('awaiting')).toBe(true)
    expect(isReviewFilter('setting_up')).toBe(true)
    expect(isReviewFilter('pending')).toBe(false)
    expect(isReviewFilter('')).toBe(false)
    expect(isReviewFilter(null)).toBe(false)
  })

  it.each([
    [row({ submittedAt: '2026-10-02T00:00:00.000Z' }), { review: 'awaiting' as const }, true],
    [row(), { review: 'awaiting' as const }, false],
    [row(), { review: 'setting_up' as const }, true],
    [row({ submittedAt: '2026-10-02T00:00:00.000Z' }), { review: 'setting_up' as const }, false],
    [row({ status: 'approved', submittedAt: '2026-10-02T00:00:00.000Z' }), { review: 'awaiting' as const }, false],
    [row({ status: 'approved' }), { status: 'approved' as const }, true],
    [row({ status: 'approved' }), { status: 'pending' as const }, false],
    [row(), {}, true],
  ])('%#: matchesFilter', (photographer, filter, expected) => {
    expect(matchesFilter(photographer, filter)).toBe(expected)
  })

  it('holds approval back only for a pending studio that has not submitted', () => {
    expect(awaitsSubmission(row())).toBe(true)
    expect(awaitsSubmission(row({ submittedAt: '2026-10-02T00:00:00.000Z' }))).toBe(false)
    expect(awaitsSubmission(row({ status: 'approved' }))).toBe(false)
    expect(awaitsSubmission(row({ status: 'suspended' }))).toBe(false)
  })
})

describe('platformApi.get (Phase 9, the detail page)', () => {
  const DETAIL = {
    photographer: { ...row({ status: 'approved' }), approvedBy: { id: 'u1', email: 'admin@bookly.example' } },
    profile: { bio: 'Portraits.', contactPhone: null, whatsappPhone: null, contactEmail: null, coverImageUrl: null, districts: [], categories: [] },
    setup: { items: [{ key: 'workingHours', done: true }, { key: 'profile', done: true }], missing: [], canSubmit: false },
    subscription: null,
    payoutMethod: { id: 'm1', kind: 'momo', provider: 'mtn', accountName: 'Kigali Lens', last4: '3456', createdAt: '2026-10-01T00:00:00.000Z' },
    methodChangedRecently: true,
    counts: { bookings: { confirmed: 2 }, services: { total: 3, active: 2 } },
    earnings: { payableRwf: -5_000, inDraftRwf: 0, paidOutRwf: 45_000 },
    activity: [],
  }

  it('reads one photographer with the platform token, no cache', async () => {
    const api = stubApi(() => json(DETAIL))
    const detail = await platformApi.get('p 1')
    expect(api.sent[0]?.url).toBe('/api/platform/photographers/p%201')
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
    expect(detail.photographer.approvedBy).toEqual({ id: 'u1', email: 'admin@bookly.example' })
    expect(detail.earnings.payableRwf).toBe(-5_000)
    expect(detail.methodChangedRecently).toBe(true)
  })

  it('fills what a partial answer leaves out: every booking status, the checklist in its order', async () => {
    stubApi(() => json(DETAIL))
    const detail = await platformApi.get('p1')
    expect(detail.counts.bookings).toEqual({
      pending_payment: 0,
      confirmed: 2,
      completed: 0,
      no_show: 0,
      expired: 0,
      cancelled_by_client: 0,
      cancelled_by_photographer: 0,
      cancelled_by_platform: 0,
    })
    expect(detail.setup.items.map((item) => item.key)).toEqual(['profile', 'workingHours'])
  })

  it('survives an answer missing whole sections', async () => {
    const { photographer } = DETAIL
    stubApi(() => json({ photographer }))
    const detail = await platformApi.get('p1')
    expect(detail.profile.districts).toEqual([])
    expect(detail.subscription).toBeNull()
    expect(detail.payoutMethod).toBeNull()
    expect(detail.methodChangedRecently).toBe(false)
    expect(detail.earnings).toEqual({ payableRwf: 0, inDraftRwf: 0, paidOutRwf: 0 })
    expect(detail.activity).toEqual([])
  })

  it('refuses a 404 and a 400 as ApiErrors the page tells apart from a failure', async () => {
    stubApi(() => json({ error: 'not_found' }, 404))
    await expect(platformApi.get('p1')).rejects.toMatchObject({ status: 404 })
    stubApi(() => json({ error: 'invalid_request' }, 400))
    await expect(platformApi.get('nope')).rejects.toMatchObject({ status: 400 })
  })
})
