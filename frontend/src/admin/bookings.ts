import { ApiError, adminFetch } from './api'

/**
 * The bookings list and everything the photographer does to a booking
 * (plan.md Task 19; spec §3.6, §6.11, §6.12, §6.16, §6.21).
 *
 * Every action answers with the booking as it now stands -- including the
 * refusals, which come back 409 carrying it -- so a screen acting on a stale
 * view is corrected by the same round trip that refused it. The `actions`
 * flags say what is possible; the API decides.
 */

export const BOOKING_STATUSES = [
  'pending_payment',
  'confirmed',
  'completed',
  'no_show',
  'expired',
  'cancelled_by_client',
  'cancelled_by_admin',
] as const

export type BookingStatus = (typeof BOOKING_STATUSES)[number]

/**
 * The admin's display stages (2026-09-25, `backend/src/booking/stage.ts`):
 * what the list filters by and every badge shows. The stored status is still
 * on each row; the stage reads it together with the clock.
 */
export const BOOKING_STAGES = [
  'awaiting_payment',
  'confirmed',
  'in_progress',
  'needs_review',
  'completed',
  'closed',
  'no_show',
  'expired',
  'cancelled_by_client',
  'cancelled_by_admin',
] as const

export type BookingStage = (typeof BOOKING_STAGES)[number]

export type BookingListRow = {
  id: string
  reference: string
  status: string
  stage: BookingStage
  startsAt: string
  endsAt: string
  contactName: string
  contactEmail: string
  contactPhone: string
  serviceName: string
  packageName: string
  grandTotalRwf: number
  collectedRwf: number
  outstandingRwf: number
  refundDueRwf: number
  hasRefundDue: boolean
}

/** A numbered page of the list, with the total it is a page of (2026-09-27). */
export type BookingsPage = { bookings: BookingListRow[]; total: number; page: number; pageSize: number; pageCount: number }

export type BookingTotals = {
  quotedTotalRwf: number
  grandTotalRwf: number
  collectedRwf: number
  refundDueRwf: number
  outstandingRwf: number
}

export type AdminPayment = {
  id: string
  kind: string
  provider: string
  ourRef: string
  providerRef: string | null
  method: string | null
  amountRwf: number
  status: string
  failureReason: string | null
  initiatedAt: string
  settledAt: string | null
  refundedAt: string | null
  refundReference: string | null
  /** What the photographer typed with a cash payment (item 7, 2026-09-27). */
  note: string | null
  canRecordRefund: boolean
}

export type AdminBooking = {
  id: string
  reference: string
  status: string
  stage: BookingStage
  locale: string
  client: { id: string; fullName: string; email: string; phone: string | null; anonymized: boolean }
  contact: { name: string; email: string; phone: string }
  service: { id: string; name: string }
  package: { id: string; name: string; priceRwf: number; durationMinutes: number; photoCount: number }
  schedule: {
    startsAt: string
    endsAt: string
    bufferEndsAt: string
    holdExpiresAt: string | null
    originalStartsAt: string | null
    rescheduledAt: string | null
  }
  details: { locationText: string; partySize: number | null; specialRequests: string | null; consentAt: string }
  addons: { id: string; name: string; unitPriceRwf: number; quantity: number; amountRwf: number; stage: string; canRemove: boolean }[]
  money: { bookingFeeRate: number; bookingFeeRwf: number; totals: BookingTotals }
  payments: AdminPayment[]
  lifecycle: { confirmedAt: string | null; completedAt: string | null; cancelledAt: string | null; cancellationReason: string | null }
  access: { hasLink: boolean; expiresAt: string | null; lastUsedAt: string | null }
  delivery: { url: string | null; expiresOn: string | null; sentAt: string | null; note: string | null }
  /** The photographer's notes to the client, newest first (2026-09-25). */
  notes: { id: string; body: string; emailed: boolean; createdAt: string }[]
  messages: {
    id: string
    kind: string
    template: string | null
    recipient: string | null
    status: string
    attempts: number
    lastError: string | null
    createdAt: string
    completedAt: string | null
  }[]
  actions: {
    canReschedule: boolean
    canCancel: boolean
    canComplete: boolean
    canMarkNoShow: boolean
    canResendLink: boolean
    /** Post-shoot add-ons, once the shoot is done (spec §3.5 step 2). */
    canEditAddons: boolean
    /** There is money left to ask the client for (spec §3.5 step 3). */
    canRequestSessionFee: boolean
    /** The delivery link and its expiry, once the shoot has happened (spec §3.5 step 5). */
    canEditDelivery: boolean
    /** There is a link to send (spec §3.5 step 6, §6.20). */
    canSendDelivery: boolean
  }
}

export type BookingsFilter = {
  /** Links made before stages still carry these; the API reads both. */
  statuses?: readonly BookingStatus[]
  stages?: readonly BookingStage[]
  /** Kigali dates, inclusive. */
  from?: string
  to?: string
  search?: string
  /** 1-based. */
  page?: number
  pageSize?: number
}

export const bookingsApi = {
  list(filter: BookingsFilter = {}): Promise<BookingsPage> {
    const query = new URLSearchParams()
    for (const status of filter.statuses ?? []) query.append('status', status)
    for (const stage of filter.stages ?? []) query.append('stage', stage)
    for (const [key, value] of [
      ['from', filter.from],
      ['to', filter.to],
      ['search', filter.search],
      ['page', filter.page?.toString()],
      ['pageSize', filter.pageSize?.toString()],
    ] as const) {
      if (value !== undefined && value !== '') query.set(key, value)
    }
    const suffix = query.toString()
    return adminFetch<BookingsPage>(`/admin/bookings${suffix === '' ? '' : `?${suffix}`}`)
  },

  get(id: string): Promise<{ booking: AdminBooking }> {
    return adminFetch<{ booking: AdminBooking }>(`/admin/bookings/${id}`)
  },

  reschedule(id: string, startsAt: string): Promise<{ booking: AdminBooking }> {
    return post(`/admin/bookings/${id}/reschedule`, { startsAt })
  },

  cancel(id: string, reason: string | null): Promise<{ booking: AdminBooking }> {
    return post(`/admin/bookings/${id}/cancel`, { reason })
  },

  complete(id: string): Promise<{ booking: AdminBooking }> {
    return post(`/admin/bookings/${id}/complete`, {})
  },

  markNoShow(id: string): Promise<{ booking: AdminBooking }> {
    return post(`/admin/bookings/${id}/no-show`, {})
  },

  resendLink(id: string): Promise<{ booking: AdminBooking }> {
    return post(`/admin/bookings/${id}/resend-link`, {})
  },

  /** A post-shoot add-on, priced from the catalogue by the API (spec §6.15). */
  addAddon(bookingId: string, addonId: string, quantity = 1): Promise<{ booking: AdminBooking }> {
    return post(`/admin/bookings/${bookingId}/addons`, { addonId, quantity })
  },

  removeAddon(bookingId: string, addonId: string): Promise<{ booking: AdminBooking }> {
    return adminFetch<{ booking: AdminBooking }>(`/admin/bookings/${bookingId}/addons/${addonId}`, { method: 'DELETE' })
  },

  /** A note to the client: on their booking page, and emailed unless `email` is false (2026-09-25). */
  addNote(bookingId: string, note: { body: string; email: boolean }): Promise<{ booking: AdminBooking }> {
    return post(`/admin/bookings/${bookingId}/notes`, note)
  },

  /** Hides a note from the client's page. An email already sent stays sent. */
  deleteNote(bookingId: string, noteId: string): Promise<{ booking: AdminBooking }> {
    return adminFetch<{ booking: AdminBooking }>(`/admin/bookings/${bookingId}/notes/${noteId}`, { method: 'DELETE' })
  },

  /** Asks the client for what is outstanding, and emails them a link (spec §3.5 step 3). */
  requestSessionFee(bookingId: string): Promise<{ booking: AdminBooking }> {
    return post(`/admin/bookings/${bookingId}/session-fee`, {})
  },

  /** The link to the photos on their own host, and the day it stops working (spec A-7, A-8). */
  saveDelivery(bookingId: string, body: { url: string; expiresOn?: string; note?: string | null }): Promise<{ booking: AdminBooking }> {
    return adminFetch<{ booking: AdminBooking }>(`/admin/bookings/${bookingId}/delivery`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  /** Emails that link to the client, and records that it went (spec §3.5 step 6). */
  /**
   * Emails the photo link. `recipient` sends this one email elsewhere; the
   * booking keeps its own contact email (decided 2026-09-25).
   */
  sendDelivery(bookingId: string, recipient?: string): Promise<{ booking: AdminBooking }> {
    return post(`/admin/bookings/${bookingId}/delivery/send`, recipient === undefined ? {} : { recipient })
  },

  /** Records a refund the photographer has already sent (spec §6.16). */
  /** Cash the client handed over, up to what is owed; the client is not emailed (item 7). */
  recordCash(bookingId: string, amountRwf: number, note: string | null): Promise<{ booking: AdminBooking }> {
    return post(`/admin/bookings/${bookingId}/payments/cash`, { amountRwf, note })
  },

  recordRefund(paymentId: string, reference: string): Promise<{ booking: AdminBooking }> {
    return post(`/admin/payments/${paymentId}/refund`, { reference })
  },
}

/**
 * The booking a refusal carried, or null when it carried none.
 *
 * Every 409 renders the booking as it now stands, so the screen that asked is
 * corrected by the same round trip that refused it -- no second read, and
 * nothing stale left behind if that read were to fail.
 */
export function bookingFromRefusal(error: unknown): AdminBooking | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body
  if (typeof body !== 'object' || body === null || !('booking' in body)) return null
  const booking = (body as { booking: unknown }).booking
  return typeof booking === 'object' && booking !== null && 'id' in booking ? (booking as AdminBooking) : null
}

function post(path: string, body: unknown): Promise<{ booking: AdminBooking }> {
  return adminFetch<{ booking: AdminBooking }>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
