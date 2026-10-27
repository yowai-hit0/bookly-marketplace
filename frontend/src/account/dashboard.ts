import type { TFunction } from 'i18next'
import { kigaliDateOf } from '@/admin/calendar-dates'
import { ApiError, apiError, apiFetch, apiResponse, apiUrl } from '@/auth/api'
import { saveSession } from '@/auth/session'
import {
  type CancelBookingResult,
  type ClientBooking,
  type ClientStage,
  cancelResultOf,
  sessionFeeResultOf,
} from '@/catalogue/booking-access'
import type { PaymentMethod, StartPaymentResult } from '@/catalogue/payments'
import { type AccountUser, primeAccountMe } from '@/auth/account'

/**
 * The client dashboard's API, `/api/account/*` (marketplace-spec.md Phase 8,
 * R8.1-R8.4; backend/openapi/paths/account.yaml): the bookings across
 * photographers, one booking, its cancellation and its session fee, the
 * payments and their receipts, the profile, the credentials, the export and
 * the deletion.
 *
 * Every call carries the account's bearer token through `apiFetch`, so a 401
 * drops the session (and the guard sends the visitor to sign in). The account
 * comes from the token alone: nothing here sends a user id, and a reference or
 * `ourRef` that is not the account's is the same 404 as one that names nothing.
 */

export const BOOKING_SCOPES = ['upcoming', 'past'] as const
export type BookingScope = (typeof BOOKING_SCOPES)[number]

/** The API's page bounds (`page` 1 to 1,000,000). */
export const MAX_PAGE = 1_000_000

export type AccountPhotographer = { handle: string; displayName: string }

export type AccountBookingRow = {
  reference: string
  photographer: AccountPhotographer
  serviceName: string
  packageName: string
  startsAt: string
  endsAt: string
  status: string
  stage: ClientStage
  amounts: { totalRwf: number; paidRwf: number; dueRwf: number; refundDueRwf: number }
  holdExpiresAt: string | null
  /** A live hold's checkout page (`/checkout/<reference>/<token>`); null otherwise. */
  checkoutPath: string | null
}

export type AccountBookingsPage = {
  scope: BookingScope
  bookings: AccountBookingRow[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

export type AccountPhotographerContact = AccountPhotographer & {
  contactPhone: string | null
  whatsappPhone: string | null
  email: string | null
}

export type AccountBookingDetail = {
  /** Exactly the guest page's view, so the same components render it. */
  booking: ClientBooking
  photographer: AccountPhotographerContact
  checkoutPath: string | null
  /** The live hold's end, beside its `checkoutPath`; null whenever that is. */
  holdExpiresAt: string | null
}

export type PaidWith = 'momo_mtn' | 'momo_airtel' | 'card' | 'cash' | null

export type RefundState =
  | { state: 'none' }
  | { state: 'due'; amountRwf: number }
  | { state: 'refunded'; amountRwf: number; refundedAt: string | null; reference: string | null }

export type Overpayment = { amountRwf: number; refundedAt: string | null; reference: string | null } | null

export type AccountPaymentStatus = 'initiated' | 'pending' | 'succeeded' | 'failed' | 'refund_due' | 'refunded'

export type AccountPaymentRow = {
  ourRef: string
  kind: 'booking_fee' | 'session_fee'
  method: PaidWith
  amountRwf: number
  status: AccountPaymentStatus
  failure: 'declined' | 'unavailable' | null
  createdAt: string
  settledAt: string | null
  refund: RefundState
  overpayment: Overpayment
  hasReceipt: boolean
  booking: { reference: string; startsAt: string; serviceName: string; packageName: string; photographer: AccountPhotographer }
}

export type AccountPaymentsPage = {
  payments: AccountPaymentRow[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

export type Receipt = {
  ourRef: string
  kind: 'booking_fee' | 'session_fee'
  method: PaidWith
  amountRwf: number
  status: 'succeeded' | 'refund_due' | 'refunded'
  createdAt: string
  settledAt: string | null
  refund: RefundState
  overpayment: Overpayment
  billedTo: string
  photographer: AccountPhotographer
  booking: {
    reference: string
    startsAt: string
    endsAt: string
    serviceName: string
    packageName: string
    packagePriceRwf: number
    bookingFeeRwf: number
    addons: { name: string; quantity: number; unitPriceRwf: number; amountRwf: number; stage: 'at_booking' | 'post_shoot' }[]
  }
}

export type AccountProfile = { fullName: string | null; phone: string | null }

/** Where one of the account's bookings lives in the dashboard. */
export function accountBookingPath(reference: string): string {
  return `/account/bookings/${encodeURIComponent(reference)}`
}

/** Where a session fee paid from the dashboard is followed until it settles. */
export function accountPaymentPath(reference: string, ourRef: string): string {
  return `${accountBookingPath(reference)}/payments/${encodeURIComponent(ourRef)}`
}

/** A payment's printable receipt. */
export function accountReceiptPath(ourRef: string): string {
  return `/account/payments/${encodeURIComponent(ourRef)}/receipt`
}

/**
 * The checkout path the API answered, when it is one: the web app's own
 * `/checkout/<reference>/<token>` and nothing else. Anything else (an absolute
 * URL, another page) is dropped rather than linked to.
 */
export function safeCheckoutPath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null
  return /^\/checkout\/[A-Za-z0-9-]+\/[A-Za-z0-9_-]+$/.test(path) ? path : null
}

/** The scope a URL asks for; anything else is the default, upcoming. */
export function scopeOf(raw: string | null): BookingScope {
  return raw === 'past' ? 'past' : 'upcoming'
}

/** The page a URL asks for: a whole number from 1 to the API's bound, else 1. */
export function pageOf(raw: string | null): number {
  if (raw === null || !/^\d{1,7}$/.test(raw)) return 1
  const page = Number(raw)
  return page >= 1 && page <= MAX_PAGE ? page : 1
}

// --- Bookings (R8.1) -----------------------------------------------------------

export async function fetchAccountBookings(scope: BookingScope, page: number, signal?: AbortSignal): Promise<AccountBookingsPage> {
  const query = new URLSearchParams({ scope })
  if (page > 1) query.set('page', String(page))
  return apiFetch<AccountBookingsPage>('account', `/account/bookings?${query.toString()}`, { signal, cache: 'no-store' })
}

/** One of the account's bookings, or null when it is not theirs (or names nothing): the API's one 404. */
export async function fetchAccountBooking(reference: string, signal?: AbortSignal): Promise<AccountBookingDetail | null> {
  try {
    const body = await apiFetch<unknown>('account', `/account/bookings/${encodeURIComponent(reference)}`, { signal, cache: 'no-store' })
    const detail = detailOf(body)
    if (detail === null) throw new ApiError(200, 'unexpected_body')
    return detail
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export type AccountCancelResult = CancelBookingResult

/** The guest cancellation under that photographer's policy, authorised by the session. */
export async function cancelAccountBooking(reference: string): Promise<AccountCancelResult> {
  const { status, body } = await send(`/account/bookings/${encodeURIComponent(reference)}/cancel`, { method: 'POST' })
  return cancelResultOf(status, body)
}

/** The session fee, as the guest page pays it; the outcomes are the same. */
export async function startAccountSessionFeePayment(
  reference: string,
  request: { method: PaymentMethod; phone: string },
): Promise<StartPaymentResult> {
  const { status, body } = await send(`/account/bookings/${encodeURIComponent(reference)}/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  return sessionFeeResultOf(status, body)
}

// --- Payments and receipts (R8.2) ----------------------------------------------------

export async function fetchAccountPayments(page: number, signal?: AbortSignal): Promise<AccountPaymentsPage> {
  const query = page > 1 ? `?${new URLSearchParams({ page: String(page) }).toString()}` : ''
  return apiFetch<AccountPaymentsPage>('account', `/account/payments${query}`, { signal, cache: 'no-store' })
}

export type ReceiptResult =
  | { status: 'ok'; receipt: Receipt }
  /** The account's own payment, which took no money (yet). */
  | { status: 'no_receipt'; paymentStatus: 'initiated' | 'pending' | 'failed' | null }
  | { status: 'missing' }

export async function fetchAccountReceipt(ourRef: string, signal?: AbortSignal): Promise<ReceiptResult> {
  try {
    const body = await apiFetch<{ receipt?: Receipt }>('account', `/account/payments/${encodeURIComponent(ourRef)}`, {
      signal,
      cache: 'no-store',
    })
    if (typeof body?.receipt?.ourRef !== 'string') throw new ApiError(200, 'unexpected_body')
    return { status: 'ok', receipt: body.receipt }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { status: 'missing' }
    if (error instanceof ApiError && error.status === 409 && error.message === 'no_receipt') {
      const paymentStatus = (error.body as { payment?: { status?: unknown } } | null)?.payment?.status
      return {
        status: 'no_receipt',
        paymentStatus: paymentStatus === 'initiated' || paymentStatus === 'pending' || paymentStatus === 'failed' ? paymentStatus : null,
      }
    }
    throw error
  }
}

// --- Profile (R8.3, decision 1) --------------------------------------------------------

export async function fetchAccountProfile(signal?: AbortSignal): Promise<AccountProfile> {
  const body = await apiFetch<{ profile: AccountProfile }>('account', '/account/profile', { signal, cache: 'no-store' })
  return body.profile
}

/** Any subset; `phone: null` clears it. A refusal is an `ApiError` (422 names its fields). */
export async function updateAccountProfile(update: { fullName?: string; phone?: string | null }): Promise<AccountProfile> {
  const body = await apiFetch<{ profile: AccountProfile }>('account', '/account/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  })
  return body.profile
}

// --- Credentials (R8.3, decision 2) ------------------------------------------------------

type SignedIn = { user: AccountUser; token: string; expiresAt: string }

/**
 * A credential change answers a fresh login: every other token stops on its
 * next request, so this tab carries on with the new one. The answer's user is
 * the `/me` view, so the header and the profile need not ask again.
 */
function keepSignedIn(body: SignedIn): AccountUser {
  // Primed first, so the header that follows the new token finds its answer waiting.
  primeAccountMe(body.token, body.user)
  saveSession('account', { token: body.token, expiresAt: body.expiresAt })
  return body.user
}

export async function changeAccountPassword(currentPassword: string, newPassword: string): Promise<AccountUser> {
  return keepSignedIn(await post<SignedIn>('/account/password', { currentPassword, newPassword }))
}

/** A Google-only account's first password. */
export async function setAccountPassword(newPassword: string): Promise<AccountUser> {
  return keepSignedIn(await post<SignedIn>('/account/password/set', { newPassword }))
}

/** 202 whether or not the address can be used: the page never learns which. */
export async function requestAccountEmailChange(newEmail: string, password: string): Promise<void> {
  await post('/account/email', { newEmail, password })
}

/**
 * Confirms the change from its link, with no session (the link opens in any
 * tab): the token proves the new inbox, the password the person. Success
 * signs this tab in to the account.
 */
export async function confirmAccountEmailChange(token: string, password: string): Promise<AccountUser> {
  const res = await fetch(apiUrl('/account/email/confirm'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ token, password }),
  })
  if (!res.ok) throw await apiError(res)
  return keepSignedIn((await res.json()) as SignedIn)
}

// --- Export and deletion (R8.3) ----------------------------------------------------------

/** What the browser names the download when the API's own name cannot be read (CORS hides the header). */
export function exportFileName(contentDisposition: string | null, now: Date = new Date()): string {
  const named = /filename="?(bookly-account-\d{4}-\d{2}-\d{2}\.json)"?/.exec(contentDisposition ?? '')?.[1]
  return named ?? `bookly-account-${kigaliDateOf(now)}.json`
}

/** Leaving the page for a file. An object, so a test can see what was saved. */
export const fileSaver = {
  save(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.rel = 'noopener'
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
    // Once the browser has taken the file; revoking at once can cancel it in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  },
}

/**
 * Downloads everything the account holds as JSON (T8.4). Through a fetch with
 * the bearer header, then a blob: the token never goes in a URL, which a plain
 * link to the export would need.
 */
export async function downloadAccountExport(now: Date = new Date()): Promise<void> {
  const res = await apiResponse('account', '/account/export', { cache: 'no-store' })
  if (!res.ok) throw await apiError(res)
  const blob = await res.blob()
  fileSaver.save(blob, exportFileName(res.headers.get('Content-Disposition'), now))
}

/** `{ password }` for an account with one, `{ confirmEmail }` for a Google-only account. 204 on success. */
export async function deleteAccount(confirmation: { password: string } | { confirmEmail: string }): Promise<void> {
  await post('/account/delete', confirmation)
}

/** The method in words (`account:payments.method.*`), or null when none was recorded. */
export function methodLabel(t: TFunction, method: PaidWith): string | null {
  return method === null ? null : t(`account:payments.method.${method}`)
}

/** The print dialog, for the receipt. An object, so a test can see it was asked for. */
export const printer = {
  print(): void {
    window.print()
  },
}

// --- Helpers -------------------------------------------------------------------------------

async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>('account', path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

/**
 * A request whose refusals carry a body the page acts on (a 409 with the
 * booking as it now stands): the status and the parsed body either way. A
 * network failure, a 401 or an unreadable answer is status 0.
 */
async function send(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  let res: Response
  try {
    res = await apiResponse('account', path, init)
  } catch {
    return { status: 0, body: null }
  }
  try {
    return { status: res.status, body: (await res.json()) as unknown }
  } catch {
    return { status: res.status === 404 ? 404 : 0, body: null }
  }
}

/** The detail in an answer, or null when the answer does not describe one. */
function detailOf(body: unknown): AccountBookingDetail | null {
  const value = body as Partial<AccountBookingDetail> | null
  const booking = value?.booking
  if (typeof booking?.reference !== 'string' || typeof booking.status !== 'string' || typeof booking.totals !== 'object') return null
  if (typeof value?.photographer?.handle !== 'string') return null
  // An answer without the hold's end reads as no time, never a crash.
  const holdExpiresAt = typeof value.holdExpiresAt === 'string' ? value.holdExpiresAt : null
  return { ...(value as AccountBookingDetail), holdExpiresAt }
}
