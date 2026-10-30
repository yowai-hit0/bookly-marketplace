import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from '@/auth/session'
import { i18n } from '@/i18n'
import { json, stubApi } from '@/test/fetch'
import {
  AUDIT_ACTIONS,
  AUDIT_GROUPS,
  type AuditEntry,
  areaOf,
  describeEntry,
  isAuditAction,
  normaliseEntry,
  paramsFromQuery,
  parsePage,
  platformAuditApi,
  queryFromParams,
} from './audit'

/**
 * The platform's audit trail client (Phase 9, R9.4): the query the URL may
 * ask for, the API call, and the one plain-language sentence each entry reads
 * as -- for every action in the vocabulary, and for answers that are missing
 * fields, mistyped or from a newer API.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }
const ID = '0b7d6f4e-1c2a-4e3b-9a8f-5d6c7b8a9e0f'
const t = i18n.t.bind(i18n)

function entry(action: string, details: Record<string, unknown> = {}, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'a1',
    action,
    actor: { id: 'u1', email: 'admin@bookly.example' },
    target: { type: 'photographer', id: 'p1' },
    photographer: { id: 'p1', handle: 'kigali-lens', displayName: 'Kigali Lens' },
    details,
    createdAt: '2026-10-27T08:00:00.000Z',
    ...overrides,
  }
}

function words(action: string, details: Record<string, unknown> = {}, overrides: Partial<AuditEntry> = {}) {
  return describeEntry(t, entry(action, details, overrides))
}

beforeEach(() => saveSession('platform', SESSION))
afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('the vocabulary', () => {
  it('groups every action exactly once, by area', () => {
    const grouped = Object.values(AUDIT_GROUPS).flat()
    expect([...grouped].sort()).toEqual([...AUDIT_ACTIONS].sort())
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(areaOf('payout_paid')).toBe('money')
    expect(areaOf('category_deleted')).toBe('categories')
    expect(areaOf('booking_cancelled')).toBeNull()
  })

  it('knows its own actions only', () => {
    expect(isAuditAction('settings_updated')).toBe(true)
    expect(isAuditAction('SETTINGS_UPDATED')).toBe(false)
    expect(isAuditAction('')).toBe(false)
    expect(isAuditAction(null)).toBe(false)
  })

  it('names every action for the filter', () => {
    for (const action of AUDIT_ACTIONS) expect(t(`platform:activity.actions.${action}`)).not.toBe(action)
  })
})

describe('the query from the URL', () => {
  it.each([
    ['1', null],
    ['2', 2],
    ['1000000', 1_000_000],
    ['1000001', null],
    ['0', null],
    ['-1', null],
    ['01', null],
    ['2.5', null],
    ['1e3', null],
    [' 2', null],
    ['two', null],
    ['', null],
  ])('page %j reads as %j (page 1 is the default)', (raw, page) => {
    const parsed = parsePage(raw)
    expect(parsed === 1 ? null : parsed).toBe(page)
  })

  it('keeps what the API accepts and drops what it would refuse', () => {
    expect(queryFromParams(new URLSearchParams(`action=payout_paid&photographerId=${ID}&page=3`))).toEqual({ action: 'payout_paid', photographerId: ID, page: 3 })
    expect(queryFromParams(new URLSearchParams('action=nope&photographerId=p1&page=0'))).toEqual({})
    expect(queryFromParams(new URLSearchParams('page=1'))).toEqual({})
    expect(queryFromParams(new URLSearchParams(''))).toEqual({})
  })

  it('writes the query back in one order, leaving page 1 out', () => {
    expect(paramsFromQuery({ page: 2, photographerId: ID, action: 'payout_paid' }).toString()).toBe(`action=payout_paid&photographerId=${ID}&page=2`)
    expect(paramsFromQuery({ page: 1 }).toString()).toBe('')
  })
})

describe('platformAuditApi.list', () => {
  it('asks with the platform token, the filters and no cache', async () => {
    const api = stubApi(() => json({ entries: [], total: 0, page: 2, pageSize: 50, pageCount: 0 }))
    await platformAuditApi.list({ action: 'category_created', photographerId: ID, page: 2 })
    expect(api.sent[0]?.url).toBe(`/api/platform/audit?action=category_created&photographerId=${ID}&page=2`)
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
  })

  it('asks for the first page with no query string', async () => {
    const api = stubApi(() => json({ entries: [], total: 0, page: 1, pageSize: 50, pageCount: 0 }))
    await expect(platformAuditApi.list()).resolves.toEqual({ entries: [], total: 0, page: 1, pageSize: 50, pageCount: 0 })
    expect(api.sent[0]?.url).toBe('/api/platform/audit')
  })

  it('drops an entry it cannot use and fills a missing count', async () => {
    stubApi(() => json({ entries: [entry('payout_paid'), { id: 'x' }, null, entry('nope', {}, { createdAt: 'not a date' })] }))
    const page = await platformAuditApi.list()
    expect(page.entries.map((each) => each.id)).toEqual(['a1'])
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 50, pageCount: 1 })
  })

  it('refuses through ApiError, so the page can tell a bad filter from a failure', async () => {
    stubApi(() => json({ error: 'invalid_request' }, 400))
    await expect(platformAuditApi.list()).rejects.toMatchObject({ status: 400 })
  })
})

describe('normaliseEntry', () => {
  it('fills what a partial entry leaves out', () => {
    expect(normaliseEntry({ id: 'a', action: 'x', createdAt: '2026-10-27T08:00:00.000Z' })).toEqual({
      id: 'a',
      action: 'x',
      actor: { id: '', email: '' },
      target: { type: null, id: null },
      photographer: null,
      details: {},
      createdAt: '2026-10-27T08:00:00.000Z',
    })
  })

  it('treats details that are not an object as empty', () => {
    expect(normaliseEntry({ ...entry('payout_paid'), details: ['x'] })?.details).toEqual({})
    expect(normaliseEntry({ ...entry('payout_paid'), details: 'x' })?.details).toEqual({})
    expect(normaliseEntry({ ...entry('payout_paid'), photographer: { id: 'p1' } })?.photographer).toBeNull()
  })
})

describe('describeEntry: one sentence per action', () => {
  it('approval with a trial, and without one', () => {
    expect(words('photographer_approved', { status: 'approved', trialStarted: true, trialEndsAt: '2026-11-26T08:00:00.000Z' }).sentence).toBe(
      'Approved Kigali Lens; the free trial ends 26 Nov 2026, 10:00',
    )
    expect(words('photographer_approved', { status: 'approved', trialStarted: false, trialEndsAt: null }).sentence).toBe('Approved Kigali Lens')
    // A flag without a usable date says only what it can.
    expect(words('photographer_approved', { trialStarted: true, trialEndsAt: 'soon' }).sentence).toBe('Approved Kigali Lens')
  })

  it('a suspension, with its reason as a line of plain text', () => {
    expect(words('photographer_suspended', { status: 'suspended', reason: '<b>Fake</b> portfolio.' })).toEqual({
      sentence: 'Suspended Kigali Lens',
      lines: ['Reason: <b>Fake</b> portfolio.'],
    })
    expect(words('photographer_suspended', { status: 'suspended', reason: '   ' }).lines).toEqual([])
  })

  it.each([
    [{ status: 'approved' }, 'Reactivated Kigali Lens; they’re approved again'.replace('’', "'")],
    [{ status: 'pending' }, 'Reactivated Kigali Lens; back to pending, as they were never approved'],
    [{}, 'Reactivated Kigali Lens'],
  ])('a reactivation to %j', (details, sentence) => {
    expect(words('photographer_reactivated', details).sentence).toBe(sentence)
  })

  it('the payouts', () => {
    expect(words('payout_created', { amountRwf: 45_000, itemCount: 3, payoutMethodId: 'm1' }).sentence).toBe('Built a 45,000 RWF payout for Kigali Lens (3 lines)')
    expect(words('payout_created', { amountRwf: 45_000, itemCount: 1 }).sentence).toBe('Built a 45,000 RWF payout for Kigali Lens (1 line)')
    expect(words('payout_created', { amountRwf: 45_000 }).sentence).toBe('Built a 45,000 RWF payout for Kigali Lens')
    expect(words('payout_created', { amountRwf: '45000' }).sentence).toBe('Built a payout for Kigali Lens')
    expect(words('payout_paid', { amountRwf: 45_000, itemCount: 3, transferReference: 'TX-123' }).sentence).toBe('Marked a 45,000 RWF payout to Kigali Lens paid (ref TX-123)')
    expect(words('payout_paid', { amountRwf: 45_000 }).sentence).toBe('Marked a 45,000 RWF payout to Kigali Lens paid')
    expect(words('payout_paid', {}).sentence).toBe('Marked a payout to Kigali Lens paid')
    expect(words('payout_cancelled', { amountRwf: 45_000 }).sentence).toBe('Cancelled a 45,000 RWF draft payout for Kigali Lens')
    expect(words('payout_cancelled', { amountRwf: 1.5 }).sentence).toBe('Cancelled a draft payout for Kigali Lens')
  })

  it('the refunds, full and overpaid, of each kind', () => {
    const full = { paymentKind: 'booking_fee', refundKind: 'full', amountRwf: 20_000, reference: 'RF-1', bookingId: 'b1' }
    expect(words('refund_recorded', full).sentence).toBe('Recorded a 20,000 RWF refund of a booking fee for a booking with Kigali Lens (ref RF-1)')
    expect(words('refund_recorded', { ...full, refundKind: 'overpayment', paymentKind: 'session_fee', amountRwf: 5_000 }).sentence).toBe(
      'Recorded a 5,000 RWF overpayment refund on a session fee for a booking with Kigali Lens (ref RF-1)',
    )
    expect(words('refund_recorded', { ...full, reference: null }).sentence).toBe('Recorded a 20,000 RWF refund of a booking fee for a booking with Kigali Lens')
    expect(words('refund_recorded', { paymentKind: 'mystery' }).sentence).toBe('Recorded a refund of a payment for a booking with Kigali Lens')
  })

  it('a settings change: one sentence for one field, a count and a line each for several', () => {
    expect(words('settings_updated', { changed: { subscriptionMonthlyPriceRwf: { before: 10_000, after: 12_000 } } })).toEqual({
      sentence: 'Changed the monthly price from 10,000 to 12,000 RWF',
      lines: [],
    })
    expect(
      words('settings_updated', {
        changed: { holdMinutes: { before: 15, after: 20 }, subscriptionReminderDays: { before: [], after: [7, 3, 1] }, trialDays: { before: 30, after: 14 } },
      }),
    ).toEqual({
      sentence: 'Changed 3 settings',
      lines: [
        'Changed the checkout hold from 15 to 20 minutes',
        'Changed the reminder days from none to 7, 3, 1',
        'Changed the free trial from 30 to 14 days',
      ],
    })
  })

  it('a settings change it cannot fully read still says something', () => {
    expect(words('settings_updated', { changed: { subscriptionGraceDays: { before: 'x', after: 3 } } }).sentence).toBe('Changed the grace period')
    expect(words('settings_updated', { changed: { newKnob: { before: 1, after: 2 } } }).sentence).toBe('Changed newKnob')
    expect(words('settings_updated', { changed: 'everything' }).sentence).toBe('Changed the settings')
    expect(words('settings_updated', {}).sentence).toBe('Changed the settings')
  })

  it('the categories', () => {
    const none = { photographer: null }
    expect(words('category_created', { slug: 'real-estate', nameEn: 'Real estate', sortOrder: 6 }, none).sentence).toBe('Created the category Real estate (real-estate)')
    expect(words('category_created', {}, none).sentence).toBe('Created a category')
    expect(words('category_updated', { slug: 'wedding', nameEn: { before: 'Wedding', after: 'Weddings' } }, none).sentence).toBe('Renamed the category Wedding to Weddings')
    expect(words('category_updated', { slug: 'wedding', nameEn: { before: 'Wedding', after: null } }, none).sentence).toBe('Changed the category wedding')
    expect(words('category_updated', {}, none).sentence).toBe('Changed a category')
    expect(words('category_deactivated', { slug: 'wedding', photographerCount: 3 }, none).sentence).toBe(
      'Deactivated the category wedding; the 3 photographers who have it keep the tag',
    )
    expect(words('category_deactivated', { slug: 'wedding', photographerCount: 1 }, none).sentence).toBe(
      'Deactivated the category wedding; the 1 photographer who has it keeps the tag',
    )
    expect(words('category_deactivated', { slug: 'wedding', photographerCount: 0 }, none).sentence).toBe('Deactivated the category wedding')
    expect(words('category_reactivated', { slug: 'wedding', photographerCount: 2 }, none).sentence).toBe(
      'Reactivated the category wedding for the 2 photographers who have it',
    )
    expect(words('category_reactivated', {}, none).sentence).toBe('Reactivated the category a category')
    // Newer rows carry the name; it wins over the slug.
    expect(words('category_deactivated', { slug: 'wedding', nameEn: 'Weddings', photographerCount: 0 }, none).sentence).toBe(
      'Deactivated the category Weddings',
    )
    expect(words('category_reactivated', { slug: 'wedding', nameEn: '', photographerCount: 0 }, none).sentence).toBe('Reactivated the category wedding')
    expect(words('category_reordered', { before: ['a', 'b'], after: ['b', 'a'] }, none).sentence).toBe('Reordered the categories')
    expect(words('category_deleted', { slug: 'drone', nameEn: 'Drone' }, none).sentence).toBe('Deleted the category Drone (drone)')
    expect(words('category_deleted', { nameEn: 'Drone' }, none).sentence).toBe('Deleted the category Drone')
    expect(words('category_deleted', {}, none).sentence).toBe('Deleted a category')
  })

  it('an action about a photographer it does not name says "a photographer"', () => {
    expect(words('photographer_approved', {}, { photographer: null }).sentence).toBe('Approved a photographer')
    expect(words('payout_cancelled', { amountRwf: 100 }, { photographer: null }).sentence).toBe('Cancelled a 100 RWF draft payout for a photographer')
  })

  it('an action from a newer API reads as words, and nothing throws on any shape', () => {
    expect(words('booking_cancelled', { anything: true }).sentence).toBe('Recorded “booking_cancelled”')
    for (const action of [...AUDIT_ACTIONS, 'unknown']) {
      for (const details of [{}, { amountRwf: null, changed: null, nameEn: 5, slug: [], reason: {}, photographerCount: 'x', trialEndsAt: 7 }]) {
        const result = words(action, details)
        expect(result.sentence).not.toBe('')
        expect(result.sentence).not.toContain('{{')
        expect(result.sentence).not.toContain('[object')
      }
    }
  })
})
