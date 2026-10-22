import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { readSession, saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import { payoutDue, platformPayout, platformPayoutDetail } from '@/test/payout-fixtures'
import {
  PAYOUT_STATUSES,
  balanceFromRefusal,
  draftFromRefusal,
  isPayoutStatus,
  payoutFromRefusal,
  platformPayoutsApi,
  userName,
} from './payouts'

/**
 * The platform's payouts client (marketplace spec R4.4, T4.3): every call
 * carries the platform's token, and each refusal's body is read for what it
 * carries -- the payout as it stands, the draft that exists, the balance that
 * was not payable.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected the promise to reject')
}

beforeEach(() => {
  saveSession('platform', SESSION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('platformPayoutsApi', () => {
  it('reads the payouts due with the platform token', async () => {
    const due = [payoutDue()]
    const api = stubApi(() => json({ due }))

    await expect(platformPayoutsApi.due()).resolves.toEqual(due)
    expect(api.sent).toEqual([expect.objectContaining({ method: 'GET', url: '/api/platform/payouts/due' })])
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
  })

  it('lists every payout, or one status', async () => {
    const api = stubApi(() => json({ payouts: [platformPayout()] }))

    await platformPayoutsApi.list()
    await platformPayoutsApi.list('draft')
    await platformPayoutsApi.list('paid')
    await platformPayoutsApi.list('cancelled')
    expect(api.sent.map((call) => call.url)).toEqual([
      '/api/platform/payouts',
      '/api/platform/payouts?status=draft',
      '/api/platform/payouts?status=paid',
      '/api/platform/payouts?status=cancelled',
    ])
  })

  it('builds a draft for one photographer and unwraps it', async () => {
    const payout = platformPayoutDetail()
    const api = stubApi(() => json({ payout }, 201))

    await expect(platformPayoutsApi.build('ph1')).resolves.toEqual(payout)
    expect(api.sent[0]).toMatchObject({ method: 'POST', url: '/api/platform/payouts', body: { photographerId: 'ph1' } })
    expect(api.sent[0]?.headers.get('Content-Type')).toBe('application/json')
  })

  it('reads one payout by its id, escaped', async () => {
    const api = stubApi(() => json({ payout: platformPayoutDetail() }))

    await platformPayoutsApi.get('a/b')
    expect(api.sent[0]?.url).toBe('/api/platform/payouts/a%2Fb')
  })

  it('marks paid with the reference, and the note only when there is one', async () => {
    const api = stubApi(() => json({ payout: platformPayoutDetail({ status: 'paid' }) }))

    await platformPayoutsApi.markPaid('po1', 'MP-1', 'Sent from the main MoMo line.')
    await platformPayoutsApi.markPaid('po1', 'MP-2', null)
    expect(api.sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'POST', url: '/api/platform/payouts/po1/mark-paid', body: { transferReference: 'MP-1', note: 'Sent from the main MoMo line.' } },
      { method: 'POST', url: '/api/platform/payouts/po1/mark-paid', body: { transferReference: 'MP-2' } },
    ])
  })

  it('cancels a draft with no body', async () => {
    const api = stubApi(() => json({ payout: platformPayoutDetail({ status: 'cancelled', itemCount: 0, items: [] }) }))

    await expect(platformPayoutsApi.cancel('po1')).resolves.toMatchObject({ status: 'cancelled', items: [] })
    expect(api.sent[0]).toMatchObject({ method: 'POST', url: '/api/platform/payouts/po1/cancel', body: undefined })
  })

  it('drops the platform session on a 401, and only that one', async () => {
    saveSession('studio', SESSION)
    stubApi(() => json({ error: 'invalid_token' }, 401))

    expect(await rejectionOf(platformPayoutsApi.due())).toBeInstanceOf(UnauthenticatedError)
    expect(readSession('platform')).toBeNull()
    expect(readSession('studio')).not.toBeNull()
  })
})

describe('reading a refusal', () => {
  async function refusal(status: number, body: unknown): Promise<unknown> {
    stubApi(() => json(body, status))
    return rejectionOf(platformPayoutsApi.cancel('po1'))
  }

  it('takes the payout a 409 not_draft carried', async () => {
    const now = platformPayoutDetail({ status: 'paid' })
    expect(payoutFromRefusal(await refusal(409, { error: 'not_draft', payout: now }))).toEqual(now)
  })

  it.each<[string, number, unknown]>([
    ['a 409 without a payout', 409, { error: 'not_draft' }],
    ['a 409 whose payout is not one', 409, { error: 'not_draft', payout: 'paid' }],
    ['a 404', 404, { error: 'not_found', payout: platformPayoutDetail() }],
  ])('takes no payout from %s', async (_label, status, body) => {
    expect(payoutFromRefusal(await refusal(status, body))).toBeNull()
  })

  it('takes no payout from something that is not an API refusal', () => {
    expect(payoutFromRefusal(new Error('network'))).toBeNull()
    expect(payoutFromRefusal(new ApiError(409, 'not_draft'))).toBeNull()
  })

  it('takes the draft a 409 draft_exists names, and nothing from any other refusal', async () => {
    expect(draftFromRefusal(await refusal(409, { error: 'draft_exists', payoutId: 'po-draft' }))).toBe('po-draft')
    expect(draftFromRefusal(await refusal(409, { error: 'draft_exists' }))).toBeNull()
    expect(draftFromRefusal(await refusal(409, { error: 'draft_exists', payoutId: '' }))).toBeNull()
    expect(draftFromRefusal(await refusal(409, { error: 'nothing_payable', payoutId: 'po-draft' }))).toBeNull()
  })

  it.each([0, -5_000])('takes the balance %s a 409 nothing_payable reported', async (payableRwf) => {
    expect(balanceFromRefusal(await refusal(409, { error: 'nothing_payable', payableRwf }))).toBe(payableRwf)
  })

  it('takes no balance from a body without a whole number, or from another code', async () => {
    expect(balanceFromRefusal(await refusal(409, { error: 'nothing_payable' }))).toBeNull()
    expect(balanceFromRefusal(await refusal(409, { error: 'nothing_payable', payableRwf: '0' }))).toBeNull()
    expect(balanceFromRefusal(await refusal(409, { error: 'nothing_payable', payableRwf: 1.5 }))).toBeNull()
    expect(balanceFromRefusal(await refusal(409, { error: 'no_payout_method', payableRwf: 0 }))).toBeNull()
  })
})

describe('statuses and names', () => {
  it('knows the three payout statuses and nothing else', () => {
    expect(PAYOUT_STATUSES).toEqual(['draft', 'paid', 'cancelled'])
    expect(['draft', 'paid', 'cancelled'].every(isPayoutStatus)).toBe(true)
    expect(isPayoutStatus('due')).toBe(false)
    expect(isPayoutStatus(null)).toBe(false)
  })

  it('names a user by full name, then email, and nobody as null', () => {
    expect(userName({ id: 'u', email: 'ops@bookly.example', fullName: 'Grace Ops' })).toBe('Grace Ops')
    expect(userName({ id: 'u', email: 'ops@bookly.example', fullName: null })).toBe('ops@bookly.example')
    expect(userName({ id: 'u', email: 'ops@bookly.example', fullName: '  ' })).toBe('ops@bookly.example')
    expect(userName(null)).toBeNull()
  })
})
