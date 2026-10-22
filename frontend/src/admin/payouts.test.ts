import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { readSession, saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import { BANK_METHOD, MOMO_METHOD, earnings, studioPayoutDetail } from '@/test/payout-fixtures'
import {
  type PayoutMethodForm,
  formatMomoNumber,
  isPayoutMethodField,
  localMomoNumber,
  momoNetworkOf,
  normalizeMomoNumber,
  payoutMethodFormValues,
  payoutsApi,
  validatePayoutMethod,
} from './payouts'

/**
 * The studio's payouts client (marketplace spec R4.1, R4.5): four calls with
 * the studio's own token, and the payout-method form's own check -- the API's
 * rules over again, so a typo is caught before the password is spent on it.
 */

const SESSION = { token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected the promise to reject')
}

beforeEach(() => {
  saveSession('studio', SESSION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('payoutsApi', () => {
  it('reads the earnings with the studio token', async () => {
    const api = stubApi(() => json(earnings()))

    await expect(payoutsApi.earnings()).resolves.toEqual(earnings())
    expect(api.sent).toEqual([expect.objectContaining({ method: 'GET', url: '/api/studio/earnings' })])
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer studio.jwt')
  })

  it('reads one payout by its id, escaped, and unwraps it', async () => {
    const payout = studioPayoutDetail()
    const api = stubApi(() => json({ payout }))

    await expect(payoutsApi.payout('po/1?x')).resolves.toEqual(payout)
    expect(api.sent[0]?.url).toBe('/api/studio/payouts/po%2F1%3Fx')
  })

  it.each([
    [404, 'not_found'],
    [400, 'invalid_request'],
  ])('surfaces a %s on a payout as the API code', async (status, code) => {
    stubApi(() => json({ error: code }, status))

    const error = await rejectionOf(payoutsApi.payout('p1'))
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status, message: code })
  })

  it('reads the current method, and a null one as null', async () => {
    stubApi(() => json({ payoutMethod: MOMO_METHOD }))
    await expect(payoutsApi.payoutMethod()).resolves.toEqual(MOMO_METHOD)

    const api = stubApi(() => json({ payoutMethod: null }))
    await expect(payoutsApi.payoutMethod()).resolves.toBeNull()
    expect(api.sent[0]).toMatchObject({ method: 'GET', url: '/api/studio/payout-method' })
  })

  it('PUTs a new method as JSON and answers the saved one', async () => {
    const api = stubApi(() => json({ payoutMethod: BANK_METHOD }))
    const body = { kind: 'bank', bankName: 'Bank of Kigali', bankAccountNumber: '00040-0123456-78', accountName: 'Kigali Lens Ltd', currentPassword: 'pw' } as const

    await expect(payoutsApi.savePayoutMethod(body)).resolves.toEqual(BANK_METHOD)
    expect(api.sent[0]).toMatchObject({ method: 'PUT', url: '/api/studio/payout-method', body })
    expect(api.sent[0]?.headers.get('Content-Type')).toBe('application/json')
  })

  it.each([
    [403, { error: 'invalid_password' }, 'invalid_password', []],
    [403, { error: 'password_locked' }, 'password_locked', []],
    [422, { error: 'validation_failed', fields: ['momoNumber', 'accountName'] }, 'validation_failed', ['momoNumber', 'accountName']],
    [429, { error: 'rate_limited' }, 'rate_limited', []],
    [400, { error: 'invalid_request' }, 'invalid_request', []],
  ])('surfaces a %s refusal of a save with its code and fields', async (status, body, code, fields) => {
    stubApi(() => json(body, status))

    const error = await rejectionOf(
      payoutsApi.savePayoutMethod({ kind: 'momo', momoNetwork: 'mtn', momoNumber: '+250788123456', accountName: 'A', currentPassword: 'pw' }),
    )
    expect(error).toMatchObject({ status, message: code, fields })
  })

  it('drops the studio session on a 401 and leaves the other areas alone', async () => {
    saveSession('platform', SESSION)
    stubApi(() => json({ error: 'invalid_token' }, 401))

    expect(await rejectionOf(payoutsApi.earnings())).toBeInstanceOf(UnauthenticatedError)
    expect(readSession('studio')).toBeNull()
    expect(readSession('platform')).not.toBeNull()
  })

  it('asks nothing without a studio session', async () => {
    sessionStorage.clear()
    const api = stubApi(() => json(earnings()))

    expect(await rejectionOf(payoutsApi.earnings())).toBeInstanceOf(UnauthenticatedError)
    expect(api.sent).toHaveLength(0)
  })
})

describe('Rwandan mobile numbers', () => {
  it.each([
    ['0788 123 456', '+250788123456'],
    ['0788123456', '+250788123456'],
    ['+250 788 123 456', '+250788123456'],
    ['250788123456', '+250788123456'],
    ['(078) 812-3456', '+250788123456'],
    ['  0722.123.456  ', '+250722123456'],
    ['0731234567', '+250731234567'],
    ['0791234567', '+250791234567'],
  ])('reads %s as %s', (typed, e164) => {
    expect(normalizeMomoNumber(typed)).toBe(e164)
  })

  it.each([
    ['empty', ''],
    ['letters', '07881234ab'],
    ['too short', '078812345'],
    ['too long', '07881234567'],
    ['another country', '+254712345678'],
    ['a Rwandan landline', '+250252123456'],
    ['an unassigned prefix', '0741234567'],
    ['a trunk 0 after the country code', '+2500788123456'],
    ['nine digits without the 0', '788123456'],
  ])('refuses %s', (_label, typed) => {
    expect(normalizeMomoNumber(typed)).toBeNull()
  })

  it.each([
    ['+250788123456', 'mtn'],
    ['+250791234567', 'mtn'],
    ['+250722123456', 'airtel'],
    ['+250731234567', 'airtel'],
  ])('puts %s on %s', (e164, network) => {
    expect(momoNetworkOf(e164)).toBe(network)
  })

  it('puts no network on a number that is not a Rwandan mobile', () => {
    expect(momoNetworkOf('+254712345678')).toBeNull()
    expect(momoNetworkOf('0788123456')).toBeNull()
  })

  it('formats an E.164 number for reading and for typing, and leaves anything else alone', () => {
    expect(formatMomoNumber('+250788123456')).toBe('+250 788 123 456')
    expect(localMomoNumber('+250788123456')).toBe('0788 123 456')
    expect(formatMomoNumber('+254712345678')).toBe('+254712345678')
    expect(localMomoNumber('garbage')).toBe('garbage')
  })
})

describe('the payout-method form', () => {
  const MOMO: PayoutMethodForm = {
    kind: 'momo',
    momoNetwork: 'mtn',
    momoNumber: '0788 123 456',
    bankName: '',
    bankAccountNumber: '',
    accountName: '  Aline Uwase ',
    currentPassword: ' a pass phrase ',
  }
  const BANK: PayoutMethodForm = {
    ...MOMO,
    kind: 'bank',
    momoNumber: '',
    bankName: ' Bank of Kigali ',
    bankAccountNumber: ' 00040-0123456-78 ',
    accountName: 'Kigali Lens Ltd',
  }

  it('starts empty, on MTN MoMo, with no method saved', () => {
    expect(payoutMethodFormValues(null)).toEqual({
      kind: 'momo',
      momoNetwork: 'mtn',
      momoNumber: '',
      bankName: '',
      bankAccountNumber: '',
      accountName: '',
      currentPassword: '',
    })
  })

  it('starts from the current method, the number as he would type it, never the password', () => {
    expect(payoutMethodFormValues(MOMO_METHOD)).toEqual({
      kind: 'momo',
      momoNetwork: 'mtn',
      momoNumber: '0788 123 456',
      bankName: '',
      bankAccountNumber: '',
      accountName: 'Aline Uwase',
      currentPassword: '',
    })
    expect(payoutMethodFormValues(BANK_METHOD)).toMatchObject({
      kind: 'bank',
      bankName: 'Bank of Kigali',
      bankAccountNumber: '00040-0123456-78',
      accountName: 'Kigali Lens Ltd',
      momoNumber: '',
      currentPassword: '',
    })
  })

  it('sends a MoMo method as E.164, trimmed, with the password exactly as typed', () => {
    expect(validatePayoutMethod(MOMO)).toEqual({
      body: { kind: 'momo', momoNetwork: 'mtn', momoNumber: '+250788123456', accountName: 'Aline Uwase', currentPassword: ' a pass phrase ' },
    })
  })

  it('sends a bank method trimmed, and none of the MoMo fields', () => {
    expect(validatePayoutMethod({ ...BANK, momoNumber: 'left over' })).toEqual({
      body: { kind: 'bank', bankName: 'Bank of Kigali', bankAccountNumber: '00040-0123456-78', accountName: 'Kigali Lens Ltd', currentPassword: ' a pass phrase ' },
    })
  })

  it.each([
    ['an MTN number on Airtel', { momoNetwork: 'airtel' as const, momoNumber: '0788 123 456' }],
    ['an Airtel number on MTN', { momoNetwork: 'mtn' as const, momoNumber: '0722 123 456' }],
    ['a number from another country', { momoNumber: '+254 712 345 678' }],
    ['a number too short', { momoNumber: '0788 123' }],
    ['no number', { momoNumber: '  ' }],
  ])('refuses %s as the number', (_label, change) => {
    expect(validatePayoutMethod({ ...MOMO, ...change })).toEqual({ invalid: ['momoNumber'] })
  })

  it.each([
    ['empty', '   '],
    ['over 120 characters', 'a'.repeat(121)],
  ])('refuses an account name that is %s', (_label, accountName) => {
    expect(validatePayoutMethod({ ...MOMO, accountName })).toEqual({ invalid: ['accountName'] })
  })

  it('takes an account name of exactly 120 characters', () => {
    expect(validatePayoutMethod({ ...MOMO, accountName: 'a'.repeat(120) })).toHaveProperty('body')
  })

  it.each([
    ['no bank name', { bankName: ' ' }, ['bankName']],
    ['a bank name over 100 characters', { bankName: 'b'.repeat(101) }, ['bankName']],
    ['an account number under 5 characters', { bankAccountNumber: '1234' }, ['bankAccountNumber']],
    ['an account number over 40 characters', { bankAccountNumber: '1'.repeat(41) }, ['bankAccountNumber']],
    ['an account number with no digit', { bankAccountNumber: 'ABCDE-FG' }, ['bankAccountNumber']],
    ['an account number with other symbols', { bankAccountNumber: '0004/0123' }, ['bankAccountNumber']],
  ])('refuses a bank method with %s', (_label, change, invalid) => {
    expect(validatePayoutMethod({ ...BANK, ...change })).toEqual({ invalid })
  })

  it('takes letters, digits, spaces and dashes in an account number', () => {
    expect(validatePayoutMethod({ ...BANK, bankAccountNumber: 'RW 12-34 AB' })).toHaveProperty('body')
  })

  it('refuses a missing password, but not one of spaces: that is a password', () => {
    expect(validatePayoutMethod({ ...MOMO, currentPassword: '' })).toEqual({ invalid: ['currentPassword'] })
    expect(validatePayoutMethod({ ...MOMO, currentPassword: '   ' })).toHaveProperty('body')
  })

  it('names every wrong field at once, in the order the form shows them', () => {
    expect(validatePayoutMethod({ ...BANK, bankName: '', bankAccountNumber: '', accountName: '', currentPassword: '' })).toEqual({
      invalid: ['bankName', 'bankAccountNumber', 'accountName', 'currentPassword'],
    })
  })

  it('knows which refused fields are its own', () => {
    expect(['momoNumber', 'bankName', 'bankAccountNumber', 'accountName', 'currentPassword'].every(isPayoutMethodField)).toBe(true)
    expect(isPayoutMethodField('kind')).toBe(false)
    expect(isPayoutMethodField('momoNetwork')).toBe(false)
  })
})
