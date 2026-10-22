import type { Earnings, PayoutItem, PayoutMethod, StudioPayout, StudioPayoutDetail } from '@/admin/payouts'
import type { PayoutDue, PlatformPayout, PlatformPayoutDetail, PlatformPayoutMethod } from '@/platform/payouts'
import type { RefundDue } from '@/platform/refunds'

/**
 * Phase 4's API shapes (backend/openapi/components/payouts.yaml), built the way
 * the API answers them, for the payout and refund tests. Each builder takes
 * overrides, so a test names only what it is about.
 */

export const MOMO_METHOD: PayoutMethod = {
  id: 'pm000001-0000-4000-8000-000000000001',
  kind: 'momo',
  momoNetwork: 'mtn',
  momoNumber: '+250788123456',
  bankName: null,
  bankAccountNumber: null,
  accountName: 'Aline Uwase',
  createdAt: '2026-10-01T08:00:00.000Z',
}

export const BANK_METHOD: PayoutMethod = {
  id: 'pm000002-0000-4000-8000-000000000002',
  kind: 'bank',
  momoNetwork: null,
  momoNumber: null,
  bankName: 'Bank of Kigali',
  bankAccountNumber: '00040-0123456-78',
  accountName: 'Kigali Lens Ltd',
  createdAt: '2026-10-02T08:00:00.000Z',
}

export function platformMethod(overrides: Partial<PlatformPayoutMethod> = {}): PlatformPayoutMethod {
  return { ...MOMO_METHOD, retiredAt: null, ...overrides }
}

export function payoutItem(overrides: Partial<PayoutItem> = {}): PayoutItem {
  return {
    id: 'pi000001-0000-4000-8000-000000000001',
    kind: 'earning',
    amountRwf: 20_000,
    state: 'payable',
    payoutId: null,
    createdAt: '2026-10-05T07:05:00.000Z',
    voidedAt: null,
    payment: {
      id: 'pa000001-0000-4000-8000-000000000001',
      kind: 'booking_fee',
      provider: 'mtn_momo_direct',
      status: 'succeeded',
      amountRwf: 20_000,
      settledAt: '2026-10-05T07:05:00.000Z',
    },
    booking: {
      id: 'b0000001-0000-4000-8000-000000000001',
      reference: 'BKY-2610-00042',
      status: 'confirmed',
      // 09:00 to 10:30 Kigali on 20 October 2026.
      startsAt: '2026-10-20T07:00:00.000Z',
      endsAt: '2026-10-20T08:30:00.000Z',
    },
    ...overrides,
  }
}

export function studioPayout(overrides: Partial<StudioPayout> = {}): StudioPayout {
  return {
    id: 'po000001-0000-4000-8000-000000000001',
    status: 'paid',
    amountRwf: 45_000,
    itemCount: 2,
    transferReference: 'MP261010.1234.A56789',
    createdAt: '2026-10-10T08:00:00.000Z',
    paidAt: '2026-10-10T09:30:00.000Z',
    payoutMethod: MOMO_METHOD,
    ...overrides,
  }
}

export function studioPayoutDetail(overrides: Partial<StudioPayoutDetail> = {}): StudioPayoutDetail {
  return {
    ...studioPayout(),
    items: [
      payoutItem({ id: 'pi-a', state: 'paid', payoutId: 'po000001-0000-4000-8000-000000000001' }),
      payoutItem({
        id: 'pi-b',
        state: 'paid',
        amountRwf: 25_000,
        payoutId: 'po000001-0000-4000-8000-000000000001',
        payment: { ...payoutItem().payment, id: 'pa-b', kind: 'session_fee', amountRwf: 25_000 },
        booking: { ...payoutItem().booking, id: 'b-b', reference: 'BKY-2610-00043' },
      }),
    ],
    ...overrides,
  }
}

export function earnings(overrides: Partial<Earnings> = {}): Earnings {
  return {
    totals: { pendingRwf: 30_000, payableRwf: 20_000, inDraftRwf: 0, paidRwf: 45_000 },
    items: [payoutItem()],
    payouts: [studioPayout()],
    ...overrides,
  }
}

export const ADMIN = { id: 'u-admin', email: 'ops@bookly.example', fullName: 'Grace Ops' }

export const PHOTOGRAPHER = {
  id: 'ph000001-0000-4000-8000-000000000001',
  handle: 'kigali-lens',
  displayName: 'Kigali Lens',
  email: 'lens@kigali.example',
  status: 'approved' as const,
}

export function platformPayout(overrides: Partial<PlatformPayout> = {}): PlatformPayout {
  return {
    id: 'po000002-0000-4000-8000-000000000002',
    status: 'draft',
    amountRwf: 45_000,
    itemCount: 2,
    photographer: PHOTOGRAPHER,
    payoutMethod: platformMethod(),
    payoutMethodIsCurrent: true,
    methodChangedRecently: false,
    transferReference: null,
    note: null,
    createdAt: '2026-10-16T08:00:00.000Z',
    createdBy: ADMIN,
    paidAt: null,
    paidBy: null,
    cancelledAt: null,
    cancelledBy: null,
    ...overrides,
  }
}

export function platformPayoutDetail(overrides: Partial<PlatformPayoutDetail> = {}): PlatformPayoutDetail {
  return {
    ...platformPayout(),
    items: [payoutItem({ state: 'in_draft', payoutId: 'po000002-0000-4000-8000-000000000002' })],
    ...overrides,
  }
}

export function payoutDue(overrides: Partial<PayoutDue> = {}): PayoutDue {
  return {
    photographer: PHOTOGRAPHER,
    payableRwf: 45_000,
    itemCount: 2,
    payoutMethod: platformMethod(),
    methodChangedRecently: false,
    draftPayoutId: null,
    ...overrides,
  }
}

export function refundDue(overrides: Partial<RefundDue> = {}): RefundDue {
  return {
    paymentId: 'pa000009-0000-4000-8000-000000000009',
    kind: 'booking_fee',
    provider: 'mtn_momo_direct',
    method: 'momo_mtn',
    amountRwf: 20_000,
    refundKind: 'full',
    refundAmountRwf: 20_000,
    overpaidRwf: 0,
    ourRef: 'a1b2c3d4-0000-4000-8000-00000000a1b2',
    providerRef: '4100000123',
    settledAt: '2026-10-05T07:05:00.000Z',
    booking: {
      id: 'b0000009-0000-4000-8000-000000000009',
      reference: 'BKY-2610-00050',
      status: 'cancelled_by_photographer',
      startsAt: '2026-10-25T07:00:00.000Z',
      contactName: 'Eric Mugisha',
      contactEmail: 'eric@example.com',
      contactPhone: '+250788000111',
    },
    photographer: { id: PHOTOGRAPHER.id, handle: PHOTOGRAPHER.handle, displayName: PHOTOGRAPHER.displayName },
    ...overrides,
  }
}
