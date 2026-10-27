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
