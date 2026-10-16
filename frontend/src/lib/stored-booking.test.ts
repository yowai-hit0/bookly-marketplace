import { afterEach, describe, expect, it, vi } from 'vitest'
import { STORED_BOOKING_KEY, forgetBookingToken, readStoredBookingToken, rememberBookingToken } from './stored-booking'

/**
 * The booking link this device remembers (docs/prompts/client-access-and-admin-polish.md, item 5).
 *
 * What is proven: remembering keeps one token, the latest; forgetting removes
 * only the token named, never a newer one; each change is announced on this
 * tab; and storage that throws on read or write means "nothing remembered",
 * never an error.
 */

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('the remembered booking link', () => {
  it('keeps the latest token only', () => {
    rememberBookingToken('first-token-0123456789')
    rememberBookingToken('second-token-0123456789')

    expect(readStoredBookingToken()).toBe('second-token-0123456789')
    expect(localStorage.length).toBe(1)
  })

  it('forgets the token named, and leaves a newer one alone', () => {
    rememberBookingToken('newer-token-0123456789')

    forgetBookingToken('older-token-0123456789')
    expect(readStoredBookingToken()).toBe('newer-token-0123456789')

    forgetBookingToken('newer-token-0123456789')
    expect(readStoredBookingToken()).toBeNull()
  })

  it('announces each change on this tab, and not a repeat of the same token', () => {
    const heard = vi.fn()
    window.addEventListener('bookly:booking-token-changed', heard)

    rememberBookingToken('a-token-0123456789')
    rememberBookingToken('a-token-0123456789')
    forgetBookingToken('a-token-0123456789')

    window.removeEventListener('bookly:booking-token-changed', heard)
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('reads an empty value as nothing remembered', () => {
    localStorage.setItem(STORED_BOOKING_KEY, '')
    expect(readStoredBookingToken()).toBeNull()
  })

  it('treats storage that throws as nothing remembered, and never throws itself', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    expect(readStoredBookingToken()).toBeNull()
    expect(() => rememberBookingToken('a-token-0123456789')).not.toThrow()
    expect(() => forgetBookingToken('a-token-0123456789')).not.toThrow()
  })
})
