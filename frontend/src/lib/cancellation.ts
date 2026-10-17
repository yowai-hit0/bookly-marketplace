import type { TFunction } from 'i18next'
import { kigaliDateOf } from '@/admin/calendar-dates'
import type { CancellationPolicy } from '@/catalogue/api'
import { formatDate, formatTime } from '@/lib/format'

/**
 * What a client is told about cancelling (R1.8; marketplace brief decision 5).
 * Each photographer sets their own terms: a cut-off before the shoot, and
 * whether a client's own cancellation refunds the booking fee. The sentence
 * always follows the data, never a fixed "non-refundable".
 *
 * Two sources, never mixed: before a booking exists the page states the
 * photographer's current policy (their public profile); once it exists, the
 * checkout and the booking page state the booking's own terms, which it kept
 * when it was made, so a later edit of the policy never changes them.
 */

/** A booking's own terms, as the checkout and the booking page receive them. */
export type CancellationTerms = {
  /** The instant a client cancellation stops being accepted; null once nothing is left to cancel. */
  deadline: string | null
  bookingFeeRefundable: boolean
}

/** Before booking: the photographer's policy as one sentence. */
export function policySentence(t: TFunction, policy: CancellationPolicy): string {
  const { cutoffHours: count, bookingFeeRefundable } = policy
  if (bookingFeeRefundable) {
    return count === 0 ? t('cancellation:policy.refundable') : t('cancellation:policy.refundableCutoff', { count })
  }
  // The no-cut-off case keeps the sentence the pages always used.
  return count === 0 ? t('services:summary.nonRefundable') : t('cancellation:policy.nonRefundableCutoff', { count })
}

/** After booking: the booking's own terms as one sentence, with the deadline in Kigali time when there is one. */
export function termsSentence(t: TFunction, terms: CancellationTerms): string {
  const until = deadlineParts(terms.deadline)
  if (terms.bookingFeeRefundable) {
    return until === null ? t('cancellation:terms.refundable') : t('cancellation:terms.refundableUntil', until)
  }
  return until === null ? t('checkout:nonRefundable') : t('cancellation:terms.nonRefundableUntil', until)
}

/** The deadline as the `{{date}}, {{time}}` the sentences interpolate, or null when there is none. */
export function deadlineParts(deadline: string | null): { date: string; time: string } | null {
  if (deadline === null) return null
  return { date: formatDate(kigaliDateOf(deadline)), time: formatTime(deadline) }
}

/** Whether a deadline has passed: the moment it is reached, the API refuses a cancellation. */
export function deadlinePassed(deadline: string | null, now: number = Date.now()): boolean {
  return deadline !== null && now >= Date.parse(deadline)
}
