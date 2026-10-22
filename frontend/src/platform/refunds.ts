import { ApiError, apiFetch } from '@/auth/api'

/**
 * Refunds of money paid online (marketplace spec R4.6, Phase 4 refund
 * decision; backend/openapi/paths/platform-payouts.yaml). That money sits in
 * the platform's account, so only a platform admin refunds it (by hand) and
 * records it here. Cash is the photographer's to refund: the API refuses it as
 * `409 cash_payment`, and never lists it.
 *
 * Two kinds of refund are listed (Phase 4 overpayment decision): `full`, a
 * payment owed back whole (less any overpaid part already returned), and
 * `overpayment`, a session fee paid for more than was due, where only the
 * extra goes back and the payment itself stands. A payment is listed once.
 */

export const REFUND_KINDS = ['full', 'overpayment'] as const

export type RefundKind = (typeof REFUND_KINDS)[number]

export function isRefundKind(value: unknown): value is RefundKind {
  return typeof value === 'string' && (REFUND_KINDS as readonly string[]).includes(value)
}

export type RefundDue = {
  paymentId: string
  kind: string
  provider: 'mtn_momo_direct' | 'flutterwave'
  method: string | null
  /** The whole payment, as it was paid. */
  amountRwf: number
  refundKind: RefundKind
  /** What to send: the whole amount less an overpaid part already returned, or only the overpaid part. */
  refundAmountRwf: number
  /** The payment's overpaid part, returned or not; 0 when it was not overpaid. */
  overpaidRwf: number
  ourRef: string
  /** The provider's transaction id, to refund against. */
  providerRef: string | null
  settledAt: string | null
  booking: {
    id: string
    reference: string
    status: string
    startsAt: string
    contactName: string
    contactEmail: string
    contactPhone: string
  }
  photographer: { id: string; handle: string; displayName: string }
}

export type RecordedRefund = {
  paymentId: string
  kind: string
  provider: string
  amountRwf: number
  /** A full refund leaves the payment `refunded`; an overpayment refund leaves it `succeeded`. */
  status: 'refunded' | 'succeeded'
  refundKind: RefundKind
  /** What was sent back. */
  refundAmountRwf: number
  overpaidRwf: number
  refundedAt: string
  refundReference: string
  refundedByUserId: string
}

/** Kigali is UTC+2 with no DST (spec §6.5), so a fixed offset is exact. */
const KIGALI_OFFSET = '+02:00'

/**
 * A `datetime-local` value read as Kigali wall time, with the offset the API
 * needs (it refuses a bare local time); null when the value is not one.
 */
export function kigaliInstant(local: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim())
  if (match === null) return null
  const [, date, hours, minutes, seconds = '00'] = match
  const instant = `${date}T${hours}:${minutes}:${seconds}${KIGALI_OFFSET}`
  const parsed = new Date(instant)
  if (Number.isNaN(parsed.getTime())) return null
  // A day the calendar does not have (2026-02-30) rolls over in `Date`; refuse it instead.
  const back = new Date(parsed.getTime() + 2 * 60 * 60 * 1000).toISOString()
  return back.slice(0, 10) === date && back.slice(11, 16) === `${hours}:${minutes}` ? instant : null
}

export const platformRefundsApi = {
  /** Every online payment owed back, oldest first. */
  list: async (): Promise<RefundDue[]> => (await apiFetch<{ refunds: RefundDue[] }>('platform', '/platform/refunds')).refunds,

  /**
   * Records a refund already sent. `refundKind` is always the row's, so the
   * API refuses it (`409 refund_kind_mismatch`, with what is `pending`) if
   * what is owed back changed since the list was read. `refundedAt` (an
   * instant with its offset) is left out for "just now". 409 `cash_payment`,
   * `not_refundable` or `duplicate_refund_reference`; 404; 422 with `fields`.
   */
  record: async (paymentId: string, refundKind: RefundKind, reference: string, refundedAt: string | null): Promise<RecordedRefund> =>
    (
      await apiFetch<{ refund: RecordedRefund }>('platform', `/platform/refunds/${encodeURIComponent(paymentId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference, refundKind, ...(refundedAt === null ? {} : { refundedAt }) }),
      })
    ).refund,
}

/** What a `409 refund_kind_mismatch` says is pending now; null for any other error, or a kind it does not know. */
export function pendingFromRefusal(error: unknown): RefundKind | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.message !== 'refund_kind_mismatch') return null
  const body = error.body
  if (typeof body !== 'object' || body === null || !('pending' in body)) return null
  const pending = (body as { pending: unknown }).pending
  return isRefundKind(pending) ? pending : null
}
