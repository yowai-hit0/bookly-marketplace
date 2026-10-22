import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { readSession, saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import { refundDue } from '@/test/payout-fixtures'
import { REFUND_KINDS, isRefundKind, kigaliInstant, pendingFromRefusal, platformRefundsApi } from './refunds'

/**
 * The platform's refunds client (marketplace spec R4.6): the list of online
 * payments owed back, and recording one with its reference and, optionally,
 * when it was sent -- Kigali wall time, with the offset the API insists on.
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

describe('platformRefundsApi', () => {
  it('lists the refunds owed with the platform token, each with its kind and the amount to send', async () => {
    const refunds = [refundDue(), refundDue({ paymentId: 'pa-over', refundKind: 'overpayment', amountRwf: 35_000, refundAmountRwf: 5_000, overpaidRwf: 5_000 })]
    const api = stubApi(() => json({ refunds }))

    await expect(platformRefundsApi.list()).resolves.toEqual(refunds)
    expect(api.sent[0]).toMatchObject({ method: 'GET', url: '/api/platform/refunds' })
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
  })

  it('records a refund with its reference and its kind, always, and its time only when given', async () => {
    const refund = {
      paymentId: 'pa1',
      kind: 'booking_fee',
      provider: 'mtn_momo_direct',
      amountRwf: 20_000,
      status: 'refunded',
      refundKind: 'full',
      refundAmountRwf: 20_000,
      overpaidRwf: 0,
      refundedAt: '2026-10-17T08:00:00.000Z',
      refundReference: 'R-1',
      refundedByUserId: 'u',
    }
    const api = stubApi(() => json({ refund }))

    await expect(platformRefundsApi.record('pa1', 'full', 'R-1', null)).resolves.toEqual(refund)
    await platformRefundsApi.record('pa/1', 'overpayment', 'R-2', '2026-10-16T09:30:00+02:00')
    expect(api.sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'POST', url: '/api/platform/refunds/pa1', body: { reference: 'R-1', refundKind: 'full' } },
      { method: 'POST', url: '/api/platform/refunds/pa%2F1', body: { reference: 'R-2', refundKind: 'overpayment', refundedAt: '2026-10-16T09:30:00+02:00' } },
    ])
  })

  it('answers an overpayment refund with the payment still succeeded', async () => {
    const refund = { paymentId: 'pa1', kind: 'session_fee', provider: 'flutterwave', amountRwf: 35_000, status: 'succeeded', refundKind: 'overpayment', refundAmountRwf: 5_000, overpaidRwf: 5_000, refundedAt: '2026-10-17T08:00:00.000Z', refundReference: 'R-9', refundedByUserId: 'u' }
    stubApi(() => json({ refund }))

    await expect(platformRefundsApi.record('pa1', 'overpayment', 'R-9', null)).resolves.toMatchObject({ status: 'succeeded', refundAmountRwf: 5_000 })
  })

  it.each([
    [409, 'cash_payment'],
    [409, 'not_refundable'],
    [409, 'duplicate_refund_reference'],
    [409, 'refund_kind_mismatch'],
    [404, 'not_found'],
  ])('surfaces a %s %s as the API code', async (status, code) => {
    stubApi(() => json({ error: code }, status))

    expect(await rejectionOf(platformRefundsApi.record('pa1', 'full', 'R', null))).toMatchObject({ status, message: code })
  })

  it('drops the platform session on a 401', async () => {
    stubApi(() => json({ error: 'invalid_token' }, 401))

    expect(await rejectionOf(platformRefundsApi.list())).toBeInstanceOf(UnauthenticatedError)
    expect(readSession('platform')).toBeNull()
  })
})

describe('refund kinds', () => {
  it('knows full and overpayment, and nothing else', () => {
    expect(REFUND_KINDS).toEqual(['full', 'overpayment'])
    expect(isRefundKind('full')).toBe(true)
    expect(isRefundKind('overpayment')).toBe(true)
    expect(isRefundKind('partial')).toBe(false)
    expect(isRefundKind(null)).toBe(false)
  })

  it.each(['full', 'overpayment'] as const)('reads %s as what a 409 refund_kind_mismatch says is pending', async (pending) => {
    stubApi(() => json({ error: 'refund_kind_mismatch', pending }, 409))

    expect(pendingFromRefusal(await rejectionOf(platformRefundsApi.record('pa1', 'full', 'R', null)))).toBe(pending)
  })

  it.each<[string, number, unknown]>([
    ['a mismatch naming no kind', 409, { error: 'refund_kind_mismatch' }],
    ['a mismatch naming a kind it does not know', 409, { error: 'refund_kind_mismatch', pending: 'partial' }],
    ['another 409', 409, { error: 'not_refundable', pending: 'full' }],
    ['a 422', 422, { error: 'refund_kind_mismatch', pending: 'full' }],
  ])('reads nothing pending from %s', async (_label, status, body) => {
    stubApi(() => json(body, status))

    expect(pendingFromRefusal(await rejectionOf(platformRefundsApi.record('pa1', 'full', 'R', null)))).toBeNull()
  })

  it('reads nothing pending from something that is not an API refusal', () => {
    expect(pendingFromRefusal(new Error('network'))).toBeNull()
    expect(pendingFromRefusal(new ApiError(409, 'refund_kind_mismatch'))).toBeNull()
  })
})

describe('kigaliInstant', () => {
  it('reads a datetime-local value as Kigali time, with its offset', () => {
    expect(kigaliInstant('2026-10-16T09:30')).toBe('2026-10-16T09:30:00+02:00')
    expect(kigaliInstant('2026-10-16T09:30:15')).toBe('2026-10-16T09:30:15+02:00')
    expect(new Date(kigaliInstant('2026-10-16T01:00') ?? '').toISOString()).toBe('2026-10-15T23:00:00.000Z')
  })

  it.each([
    ['empty', ''],
    ['a date alone', '2026-10-16'],
    ['a day the calendar does not have', '2026-02-30T09:00'],
    ['hour 24', '2026-10-16T24:00'],
    ['minute 60', '2026-10-16T09:60'],
    ['an offset already on it', '2026-10-16T09:30Z'],
    ['text', 'yesterday'],
  ])('refuses %s', (_label, value) => {
    expect(kigaliInstant(value)).toBeNull()
  })
})
