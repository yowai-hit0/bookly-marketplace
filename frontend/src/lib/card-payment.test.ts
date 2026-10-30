import { afterEach, describe, expect, it, vi } from 'vitest'
import { cardBookingToken, cardNavigationState, isRememberedCardPayment, rememberCardPayment } from './card-payment'

/**
 * What a card payment's pages keep in this tab (marketplace-spec.md "Cards as
 * built"): the card mark for every pay page, the guest's booking token only
 * when one is given, each under its own `ourRef`, in sessionStorage (never
 * localStorage), and storage that is missing or throws means nothing kept.
 */

const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'
const TOKEN = 'aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJeLmNoPqRs'

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
  localStorage.clear()
})

describe('rememberCardPayment', () => {
  it('keeps the card mark and the guest token under the payment, in this tab only', () => {
    rememberCardPayment(OUR_REF, TOKEN)

    expect(isRememberedCardPayment(OUR_REF)).toBe(true)
    expect(cardBookingToken(OUR_REF)).toBe(TOKEN)
    expect(localStorage.length).toBe(0)
  })

  it('keeps no token when none is given (the checkout, the account)', () => {
    rememberCardPayment(OUR_REF)

    expect(isRememberedCardPayment(OUR_REF)).toBe(true)
    expect(cardBookingToken(OUR_REF)).toBeNull()
  })

  it('knows nothing of another payment', () => {
    rememberCardPayment(OUR_REF, TOKEN)

    expect(isRememberedCardPayment('9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d')).toBe(false)
    expect(cardBookingToken('9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d')).toBeNull()
  })

  it('swallows storage that throws, and reads it as nothing kept', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => rememberCardPayment(OUR_REF, TOKEN)).not.toThrow()

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(isRememberedCardPayment(OUR_REF)).toBe(false)
    expect(cardBookingToken(OUR_REF)).toBeNull()
  })
})

describe('cardNavigationState', () => {
  it('is the card mark and the transaction id, nothing else', () => {
    expect(cardNavigationState('41')).toStrictEqual({ card: true, transactionId: '41' })
    expect(cardNavigationState(null)).toStrictEqual({ card: true, transactionId: null })
  })
})
