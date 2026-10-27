import type { Payment, Prisma, PrismaClient } from '@prisma/client';
import { refundAmountRwf } from '../booking/totals.js';
import { ACCOUNT_PAGE_SIZE, type AccountPhotographer } from './bookings.js';

/**
 * A signed-in client's payments and receipts (marketplace-spec.md R8.2; Phase 8
 * unit B3). Transport-free.
 *
 * **Whose.** Every payment on a booking whose client row is the account's
 * (`client.user_id`), across photographers -- the bookings list's scope. A
 * subscription payment has no booking and is a photographer's, so it is never
 * here. Another client's `our_ref` answers exactly like one that names nothing.
 *
 * **Which** (design decision, Phase 8). The list holds every payment that
 * moved money or tried to: `pending`, `succeeded`, `failed`, `refund_due`,
 * `refunded`. Not `initiated`: such a row is either a photographer's request
 * nobody has paid yet (the booking page asks for it as the session fee) or a
 * provider call in its first seconds, which becomes `pending` or `failed` by
 * itself. Newest first.
 *
 * **Receipts.** Only money that was taken has one: `succeeded`, `refund_due`
 * and `refunded` (a refunded payment's receipt says so). Any other payment of
 * the account's is `no_receipt` (a 409 the page can explain: the caller owns
 * it, so saying it exists discloses nothing); anything not the account's is
 * `null` (a 404).
 *
 * Nothing here is internal: no provider name, no provider reference, no
 * failure text (the public `failure` vocabulary instead), and never the
 * photographer's cash note.
 */

export const RECEIPT_STATUSES = ['succeeded', 'refund_due', 'refunded'] as const;
const LISTED_STATUSES = ['pending', 'succeeded', 'failed', 'refund_due', 'refunded'] as const;

type Db = PrismaClient | Prisma.TransactionClient;

/** How it was paid: the client's method, or `cash` for money the photographer recorded by hand. */
export type PaidWith = 'momo_mtn' | 'momo_airtel' | 'card' | 'cash' | null;

export type RefundState =
  | { state: 'none' }
  /** Owed back, not yet sent: how much. */
  | { state: 'due'; amountRwf: number }
  /** Sent back: how much, when, and the transfer's reference. */
  | { state: 'refunded'; amountRwf: number; refundedAt: string | null; reference: string | null };

/**
 * The overpaid part of a succeeded payment (Phase 4 overpayment decision),
 * which the platform sends back: how much, and whether it has been. Null when
 * the payer paid exactly what was asked.
 */
export type Overpayment = { amountRwf: number; refundedAt: string | null; reference: string | null } | null;

export type AccountPaymentRow = {
  ourRef: string;
  kind: string;
  method: PaidWith;
  amountRwf: number;
  status: string;
  /** Why a failed payment failed, in the public words: turned down, or the provider unreachable. */
  failure: 'declined' | 'unavailable' | null;
  createdAt: string;
  settledAt: string | null;
  refund: RefundState;
  overpayment: Overpayment;
  hasReceipt: boolean;
  booking: { reference: string; startsAt: string; serviceName: string; packageName: string; photographer: AccountPhotographer };
};

export type AccountPaymentsPage = { payments: AccountPaymentRow[]; total: number; page: number; pageSize: number; pageCount: number };

const PAYMENT_BOOKING = {
  select: {
    reference: true,
    startsAt: true,
    endsAt: true,
    serviceNameSnapshot: true,
    packageNameSnapshot: true,
    photographer: { select: { handle: true, displayName: true } },
  },
} as const;

/** The account's payments that are listed, newest first. */
function listedWhere(userId: string): Prisma.PaymentWhereInput {
  return { status: { in: [...LISTED_STATUSES] }, booking: { client: { userId } } };
}

export async function listAccountPayments(db: PrismaClient, userId: string, query: { page?: number }): Promise<AccountPaymentsPage> {
  const pageSize = ACCOUNT_PAGE_SIZE;
  const where = listedWhere(userId);
  return db.$transaction(async (tx) => {
    const total = await tx.payment.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(Math.trunc(query.page ?? 1), 1), pageCount);
    const rows = await tx.payment.findMany({
      where,
      include: { booking: PAYMENT_BOOKING },
      orderBy: [{ initiatedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { payments: rows.flatMap((row) => (row.booking === null ? [] : [paymentRow(row, row.booking)])), total, page, pageSize, pageCount };
  });
}

type PaymentBooking = Prisma.BookingGetPayload<typeof PAYMENT_BOOKING>;

export function paymentRow(payment: Payment, booking: PaymentBooking): AccountPaymentRow {
  return {
    ourRef: payment.ourRef,
    kind: payment.kind,
    method: paidWith(payment),
    amountRwf: payment.amountRwf,
    status: payment.status,
    failure: failureOf(payment),
    createdAt: payment.initiatedAt.toISOString(),
    settledAt: payment.settledAt?.toISOString() ?? null,
    refund: refundOf(payment),
    overpayment: overpaymentOf(payment),
    hasReceipt: (RECEIPT_STATUSES as readonly string[]).includes(payment.status),
    booking: {
      reference: booking.reference,
      startsAt: booking.startsAt.toISOString(),
      serviceName: booking.serviceNameSnapshot,
      packageName: booking.packageNameSnapshot,
      photographer: booking.photographer,
    },
  };
}

export function paidWith(payment: Pick<Payment, 'provider' | 'method'>): PaidWith {
  if (payment.provider === 'cash') return 'cash';
  return payment.method === 'momo_mtn' || payment.method === 'momo_airtel' || payment.method === 'card' ? payment.method : null;
}

/** The public checkout status page's rule (routes/public-checkout.ts): the recorded reason stays internal. */
export function failureOf(payment: Pick<Payment, 'status' | 'failureReason'>): 'declined' | 'unavailable' | null {
  if (payment.status !== 'failed') return null;
  return payment.failureReason !== null && /^provider_(unavailable|timeout)/.test(payment.failureReason) ? 'unavailable' : 'declined';
}

export function refundOf(payment: Payment): RefundState {
  if (payment.status === 'refund_due') return { state: 'due', amountRwf: refundAmountRwf(payment) };
  if (payment.status === 'refunded') {
    return { state: 'refunded', amountRwf: refundAmountRwf(payment), refundedAt: payment.refundedAt?.toISOString() ?? null, reference: payment.refundReference };
  }
  return { state: 'none' };
}

export function overpaymentOf(payment: Payment): Overpayment {
  if (payment.overpaidRwf <= 0) return null;
  return {
    amountRwf: payment.overpaidRwf,
    refundedAt: payment.overpaymentRefundedAt?.toISOString() ?? null,
    reference: payment.overpaymentRefundReference,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Receipt = {
  ourRef: string;
  kind: string;
  method: PaidWith;
  amountRwf: number;
  status: string;
  createdAt: string;
  settledAt: string | null;
  refund: RefundState;
  overpayment: Overpayment;
  /** The name on the booking, as it was booked: who the receipt is made out to. */
  billedTo: string;
  photographer: AccountPhotographer;
  booking: {
    reference: string;
    startsAt: string;
    endsAt: string;
    serviceName: string;
    packageName: string;
    packagePriceRwf: number;
    bookingFeeRwf: number;
    addons: { name: string; quantity: number; unitPriceRwf: number; amountRwf: number; stage: string }[];
  };
};

export type ReceiptResult = { status: 'ok'; receipt: Receipt } | { status: 'no_receipt'; paymentStatus: string } | { status: 'not_found' };

export async function accountReceipt(db: Db, userId: string, ourRef: string): Promise<ReceiptResult> {
  if (!UUID.test(ourRef)) return { status: 'not_found' };
  const payment = await db.payment.findFirst({
    where: { ourRef: ourRef.toLowerCase(), booking: { client: { userId } } },
    include: {
      booking: {
        select: {
          ...PAYMENT_BOOKING.select,
          contactName: true,
          packagePriceRwf: true,
          bookingFeeRwf: true,
          addons: { select: { nameSnapshot: true, quantity: true, unitPriceRwf: true, amountRwf: true, stage: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        },
      },
    },
  });
  if (payment === null || payment.booking === null) return { status: 'not_found' };
  if (!(RECEIPT_STATUSES as readonly string[]).includes(payment.status)) return { status: 'no_receipt', paymentStatus: payment.status };

  const { booking } = payment;
  return {
    status: 'ok',
    receipt: {
      ourRef: payment.ourRef,
      kind: payment.kind,
      method: paidWith(payment),
      amountRwf: payment.amountRwf,
      status: payment.status,
      createdAt: payment.initiatedAt.toISOString(),
      settledAt: payment.settledAt?.toISOString() ?? null,
      refund: refundOf(payment),
      overpayment: overpaymentOf(payment),
      billedTo: booking.contactName,
      photographer: booking.photographer,
      booking: {
        reference: booking.reference,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        serviceName: booking.serviceNameSnapshot,
        packageName: booking.packageNameSnapshot,
        packagePriceRwf: booking.packagePriceRwf,
        bookingFeeRwf: booking.bookingFeeRwf,
        addons: booking.addons.map((addon) => ({
          name: addon.nameSnapshot,
          quantity: addon.quantity,
          unitPriceRwf: addon.unitPriceRwf,
          amountRwf: addon.amountRwf,
          stage: addon.stage,
        })),
      },
    },
  };
}
