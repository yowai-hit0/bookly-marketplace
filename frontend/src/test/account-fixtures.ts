import type {
  AccountBookingDetail,
  AccountBookingRow,
  AccountBookingsPage,
  AccountPaymentRow,
  AccountPaymentsPage,
  Receipt,
} from '@/account/dashboard'
import type { AccountUser } from '@/auth/account'
import type { ClientBooking } from '@/catalogue/booking-access'

/**
 * The client dashboard's API answers (backend/openapi/components/account.yaml),
 * shaped as the backend builds them, for the account pages' tests. Two
 * photographers, so "across photographers" is never one by accident.
 */

export const SESSION = { token: 'account.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

export const USER: AccountUser = {
  id: 'c1',
  email: 'aline@example.com',
  lastLoginAt: null,
  fullName: 'Aline Uwase',
  phone: '+250788123456',
  hasPassword: true,
  hasGoogle: false,
  pendingEmail: null,
}

export const GOOGLE_USER: AccountUser = { ...USER, hasPassword: false, hasGoogle: true }

export const REFERENCE = 'BKY-2610-7K3QX'
export const OTHER_REFERENCE = 'BKY-2611-9QW2E'
export const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'
export const CHECKOUT_PATH = '/checkout/BKY-2611-9QW2E/Zx9Q2mT7vL4pR8sK1nB6yH3cF5dG0wJe'

export const LENS = { handle: 'kigali-lens', displayName: 'Kigali Lens' }
export const LIGHT = { handle: 'light-house', displayName: 'Light House Studio' }

export const ROW: AccountBookingRow = {
  reference: REFERENCE,
  photographer: LENS,
  serviceName: 'Portraits',
  packageName: 'Standard',
  startsAt: '2026-10-07T07:30:00.000Z',
  endsAt: '2026-10-07T09:00:00.000Z',
  status: 'confirmed',
  stage: 'confirmed',
  amounts: { totalRwf: 50_000, paidRwf: 20_000, dueRwf: 30_000, refundDueRwf: 0 },
  holdExpiresAt: null,
  checkoutPath: null,
}

/** A live hold with another photographer: "Finish payment". */
export const HELD_ROW: AccountBookingRow = {
  reference: OTHER_REFERENCE,
  photographer: LIGHT,
  serviceName: 'Weddings',
  packageName: 'Full day',
  startsAt: '2026-11-14T08:00:00.000Z',
  endsAt: '2026-11-14T16:00:00.000Z',
  status: 'pending_payment',
  stage: 'awaiting_payment',
  amounts: { totalRwf: 400_000, paidRwf: 0, dueRwf: 400_000, refundDueRwf: 0 },
  holdExpiresAt: '2026-10-27T10:30:00.000Z',
  checkoutPath: CHECKOUT_PATH,
}

export function bookingsPage(bookings: AccountBookingRow[], extra: Partial<AccountBookingsPage> = {}): AccountBookingsPage {
  return { scope: 'upcoming', bookings, total: bookings.length, page: 1, pageSize: 20, pageCount: 1, ...extra }
}

/** A week from the real clock, so the cancel window is open whenever the suite runs. */
const OPEN_DEADLINE = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString()

export const CLIENT_BOOKING: ClientBooking = {
  reference: REFERENCE,
  status: 'confirmed',
  stage: 'confirmed',
  clientName: 'Aline Uwase',
  maskedEmail: 'a•••••@example.com',
  pendingMaskedEmail: null,
  startsAt: ROW.startsAt,
  endsAt: ROW.endsAt,
  serviceName: 'Portraits',
  packageName: 'Standard',
  packagePriceRwf: 40_000,
  packagePhotoCount: 25,
  packageDurationMinutes: 90,
  locationText: 'Kigali Heights, KG 7 Ave',
  partySize: 3,
  specialRequests: null,
  addons: [{ name: 'Extra hour', priceRwf: 10_000, stage: 'at_booking' }],
  totals: { quotedTotalRwf: 50_000, grandTotalRwf: 50_000, collectedRwf: 20_000, refundDueRwf: 0, outstandingRwf: 30_000 },
  bookingFeeRwf: 20_000,
  payments: [{ kind: 'booking_fee', status: 'succeeded', amountRwf: 20_000, settledAt: '2026-10-01T06:05:00.000Z' }],
  canCancel: true,
  cancellation: { deadline: OPEN_DEADLINE, bookingFeeRefundable: false },
  cancellationReason: null,
  cancelledAt: null,
  sessionFee: { outstandingRwf: 30_000, waitingPayment: null },
  delivery: null,
  notices: [],
}

export const CONTACT = {
  ...LENS,
  contactPhone: '+250788000111',
  whatsappPhone: '+250788000222',
  email: 'hello@kigalilens.rw',
}

export function detail(booking: Partial<ClientBooking> = {}, extra: Partial<AccountBookingDetail> = {}): AccountBookingDetail {
  return { booking: { ...CLIENT_BOOKING, ...booking }, photographer: CONTACT, checkoutPath: null, holdExpiresAt: null, ...extra }
}

export const PAYMENT: AccountPaymentRow = {
  ourRef: OUR_REF,
  kind: 'booking_fee',
  method: 'momo_mtn',
  amountRwf: 20_000,
  status: 'succeeded',
  failure: null,
  createdAt: '2026-10-01T06:04:00.000Z',
  settledAt: '2026-10-01T06:05:00.000Z',
  refund: { state: 'none' },
  overpayment: null,
  hasReceipt: true,
  booking: { reference: REFERENCE, startsAt: ROW.startsAt, serviceName: 'Portraits', packageName: 'Standard', photographer: LENS },
}

export function paymentsPage(payments: AccountPaymentRow[], extra: Partial<AccountPaymentsPage> = {}): AccountPaymentsPage {
  return { payments, total: payments.length, page: 1, pageSize: 20, pageCount: 1, ...extra }
}

export const RECEIPT: Receipt = {
  ourRef: OUR_REF,
  kind: 'booking_fee',
  method: 'momo_mtn',
  amountRwf: 20_000,
  status: 'succeeded',
  createdAt: '2026-10-01T06:04:00.000Z',
  settledAt: '2026-10-01T06:05:00.000Z',
  refund: { state: 'none' },
  overpayment: null,
  billedTo: 'Aline Uwase',
  photographer: LENS,
  booking: {
    reference: REFERENCE,
    startsAt: ROW.startsAt,
    endsAt: ROW.endsAt,
    serviceName: 'Portraits',
    packageName: 'Standard',
    packagePriceRwf: 40_000,
    bookingFeeRwf: 20_000,
    addons: [
      { name: 'Extra hour', quantity: 1, unitPriceRwf: 10_000, amountRwf: 10_000, stage: 'at_booking' },
      { name: 'Prints', quantity: 3, unitPriceRwf: 2_000, amountRwf: 6_000, stage: 'post_shoot' },
    ],
  },
}

/** The login shape a credential change answers. */
export function signedIn(token: string, user: Partial<AccountUser> = {}) {
  return { user: { ...USER, ...user }, token, tokenType: 'Bearer', expiresAt: '2099-02-01T00:00:00.000Z' }
}
