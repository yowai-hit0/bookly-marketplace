import type { PayoutItem, PayoutMethod } from '@/admin/payouts'
import { ApiError, apiFetch } from '@/auth/api'
import type { PhotographerStatus } from './photographers'

/**
 * The platform's payouts (marketplace spec R4.1, R4.4, T4.3;
 * backend/openapi/paths/platform-payouts.yaml). Payouts are made by hand:
 * build a draft (which locks the payable lines and totals them), make the
 * transfer outside the app, then mark the draft paid with the transfer's
 * reference. Every call carries the platform's own token.
 */

export const PAYOUT_STATUSES = ['draft', 'paid', 'cancelled'] as const

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number]

export function isPayoutStatus(value: string | null): value is PayoutStatus {
  return value !== null && (PAYOUT_STATUSES as readonly string[]).includes(value)
}

/** A payout method as the platform sees it, with when it was replaced (null while current). */
export type PlatformPayoutMethod = PayoutMethod & { retiredAt: string | null }

export type PhotographerSummary = { id: string; handle: string; displayName: string; email: string; status: PhotographerStatus }

export type UserSummary = { id: string; email: string; fullName: string | null }

export type PlatformPayout = {
  id: string
  status: PayoutStatus
  amountRwf: number
  /** Nought once a draft is cancelled, which releases its lines. */
  itemCount: number
  photographer: PhotographerSummary
  /** The destination the draft was built for. */
  payoutMethod: PlatformPayoutMethod
  /** False once the photographer has saved another destination since: check before transferring. */
  payoutMethodIsCurrent: boolean
  /** The photographer's current destination was saved within the last 72 hours (R4.1). */
  methodChangedRecently: boolean
  transferReference: string | null
  /** Platform-internal, typed at mark-paid. */
  note: string | null
  createdAt: string
  createdBy: UserSummary
  paidAt: string | null
  paidBy: UserSummary | null
  cancelledAt: string | null
  cancelledBy: UserSummary | null
}

export type PlatformPayoutDetail = PlatformPayout & { items: PayoutItem[] }

export type PayoutDue = {
  photographer: PhotographerSummary
  payableRwf: number
  itemCount: number
  /** Null when none is saved: no draft can be built. */
  payoutMethod: PlatformPayoutMethod | null
  methodChangedRecently: boolean
  /** A draft already being prepared, which must be paid or cancelled before another is built. */
  draftPayoutId: string | null
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>('platform', path, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

export const platformPayoutsApi = {
  /** Photographers whose payable balance is above nought, largest first. */
  due: async (): Promise<PayoutDue[]> => (await apiFetch<{ due: PayoutDue[] }>('platform', '/platform/payouts/due')).due,

  /** Newest first; every status when `status` is left out. */
  list: async (status?: PayoutStatus): Promise<PlatformPayout[]> =>
    (await apiFetch<{ payouts: PlatformPayout[] }>('platform', `/platform/payouts${status === undefined ? '' : `?status=${status}`}`)).payouts,

  /**
   * Builds a draft of everything payable now. 409 `no_payout_method`,
   * `draft_exists` (with `payoutId`) or `nothing_payable` (with `payableRwf`);
   * 404 for an unknown photographer.
   */
  build: async (photographerId: string): Promise<PlatformPayoutDetail> =>
    (await post<{ payout: PlatformPayoutDetail }>('/platform/payouts', { photographerId })).payout,

  get: async (id: string): Promise<PlatformPayoutDetail> =>
    (await apiFetch<{ payout: PlatformPayoutDetail }>('platform', `/platform/payouts/${encodeURIComponent(id)}`)).payout,

  /**
   * Records the transfer. The note is left out when there is none. 409
   * `not_draft` (with the payout as it stands) or `duplicate_transfer_reference`;
   * 422 `fields: ['transferReference']`.
   */
  markPaid: async (id: string, transferReference: string, note: string | null): Promise<PlatformPayoutDetail> =>
    (
      await post<{ payout: PlatformPayoutDetail }>(`/platform/payouts/${encodeURIComponent(id)}/mark-paid`, {
        transferReference,
        ...(note === null ? {} : { note }),
      })
    ).payout,

  /** Releases a draft's lines back to the balance. Takes no body; 409 `not_draft`. */
  cancel: async (id: string): Promise<PlatformPayoutDetail> =>
    (await post<{ payout: PlatformPayoutDetail }>(`/platform/payouts/${encodeURIComponent(id)}/cancel`)).payout,
}

/** The payout a `409 not_draft` carried, as it now stands; null for any other error. */
export function payoutFromRefusal(error: unknown): PlatformPayoutDetail | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const body = error.body
  if (typeof body !== 'object' || body === null || !('payout' in body)) return null
  const payout = (body as { payout: unknown }).payout
  return typeof payout === 'object' && payout !== null && 'id' in payout && 'status' in payout ? (payout as PlatformPayoutDetail) : null
}

/** The draft a `409 draft_exists` names; null for any other error. */
export function draftFromRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.message !== 'draft_exists') return null
  const body = error.body
  if (typeof body !== 'object' || body === null || !('payoutId' in body)) return null
  const id = (body as { payoutId: unknown }).payoutId
  return typeof id === 'string' && id !== '' ? id : null
}

/** The balance a `409 nothing_payable` reported (nought or less); null for any other error. */
export function balanceFromRefusal(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.message !== 'nothing_payable') return null
  const body = error.body
  if (typeof body !== 'object' || body === null || !('payableRwf' in body)) return null
  const amount = (body as { payableRwf: unknown }).payableRwf
  return typeof amount === 'number' && Number.isInteger(amount) ? amount : null
}

/** Who did something, by name when the account has one. */
export function userName(user: UserSummary | null): string | null {
  if (user === null) return null
  return user.fullName !== null && user.fullName.trim() !== '' ? user.fullName : user.email
}
