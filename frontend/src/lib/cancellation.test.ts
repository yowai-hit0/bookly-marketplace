import { describe, expect, it } from 'vitest'
import { i18n } from '@/i18n'
import { deadlineParts, deadlinePassed, policySentence, termsSentence } from './cancellation'

/**
 * The cancellation sentences (R1.8): each follows the data, so a photographer
 * who refunds the booking fee is never described as keeping it, and the no
 * cut-off, non-refundable case keeps the sentence the pages always showed.
 */

const t = i18n.t.bind(i18n)

describe('policySentence', () => {
  it.each([
    [{ cutoffHours: 0, bookingFeeRefundable: false }, 'The booking fee is non-refundable if you cancel.'],
    [
      { cutoffHours: 48, bookingFeeRefundable: false },
      'The booking fee is non-refundable if you cancel. You can cancel up to 48 hours before the shoot.',
    ],
    [
      { cutoffHours: 1, bookingFeeRefundable: false },
      'The booking fee is non-refundable if you cancel. You can cancel up to 1 hour before the shoot.',
    ],
    [{ cutoffHours: 0, bookingFeeRefundable: true }, 'The booking fee is refunded if you cancel before the shoot.'],
    [{ cutoffHours: 24, bookingFeeRefundable: true }, 'The booking fee is refunded if you cancel at least 24 hours before the shoot.'],
  ])('states %o', (policy, sentence) => {
    expect(policySentence(t, policy)).toBe(sentence)
  })
})

describe('termsSentence', () => {
  // 08:00 UTC is 10:00 in Kigali; 23:30 UTC is already the next day there.
  it.each([
    [
      { deadline: '2026-11-20T08:00:00.000Z', bookingFeeRefundable: false },
      'The booking fee is non-refundable if you cancel. You can cancel until Friday, 20 November 2026, 10:00, Kigali time.',
    ],
    [
      { deadline: '2026-11-20T23:30:00.000Z', bookingFeeRefundable: true },
      'The booking fee is refunded if you cancel before Saturday, 21 November 2026, 01:30, Kigali time.',
    ],
    [{ deadline: null, bookingFeeRefundable: false }, 'The booking fee is non-refundable if you cancel.'],
    [{ deadline: null, bookingFeeRefundable: true }, 'The booking fee is refunded if you cancel.'],
  ])('states %o', (terms, sentence) => {
    expect(termsSentence(t, terms)).toBe(sentence)
  })
})

describe('deadlineParts', () => {
  it('is the Kigali date and time of the deadline, or null without one', () => {
    expect(deadlineParts('2026-11-20T08:00:00.000Z')).toEqual({ date: 'Friday, 20 November 2026', time: '10:00' })
    expect(deadlineParts(null)).toBeNull()
  })
})

describe('deadlinePassed', () => {
  const deadline = '2026-11-20T08:00:00.000Z'
  const at = Date.parse(deadline)

  it('is false before the deadline, and true from the instant it is reached', () => {
    expect(deadlinePassed(deadline, at - 1)).toBe(false)
    expect(deadlinePassed(deadline, at)).toBe(true)
    expect(deadlinePassed(deadline, at + 1)).toBe(true)
  })

  it('is never true without a deadline', () => {
    expect(deadlinePassed(null, at)).toBe(false)
  })
})
