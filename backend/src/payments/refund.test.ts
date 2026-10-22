import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelByAdmin } from '../booking/admin-actions.js';
import { findAdminBooking } from '../booking/admin-view.js';
import { bookingTotals } from '../booking/totals.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type PaymentWorld, insertBooking, insertPayment, seedSecondPhotographer, seedWorld, stubProvider } from '../test/payment-fixtures.js';
import { recordRefund } from './refund.js';

/**
 * Recording a refund already sent (plan.md Task 19; spec §6.16, §6.11;
 * marketplace-spec.md R4.6 and the Phase 4 refund decision), against real
 * PostgreSQL.
 *
 * The system moves no money, and this is the test that says so: `recordRefund`
 * takes no provider -- there is nowhere in its dependencies for one to hide --
 * and a `fetch` that fails the test stands in for the network it never
 * touches. What it does is write down a fact: `refunded`, with the reference,
 * the instant it happened and who recorded it.
 *
 * Who records it follows where the money is. Cash the photographer was handed
 * is his to give back and record, in the studio; money paid online sits in the
 * platform's account, so only a platform admin records it. Each side is refused
 * the other's (`refund_with_platform`, `cash_payment`) and writes nothing.
 *
 * Only a payment already flagged `refund_due` can be recorded. A `succeeded`
 * one is money correctly held; marking it refunded would quietly rewrite what
 * the booking is worth. So every other status answers `not_refundable`,
 * including a payment already refunded -- which makes a second click safe
 * rather than a second write.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let adminId: string;

/** The injected app clock: long before every fixture shoot (January 2027). */
const NOW = new Date('2026-10-01T06:00:00Z');

/** The photographer, in the studio: their own bookings' cash only. */
function deps(now: Date = NOW) {
  return { prisma, now: () => now, actor: { area: 'studio' as const, photographerId: world.photographerId, userId: world.photographerUserId } };
}

/** A platform admin: any booking's money paid online. */
function platform(now: Date = NOW) {
  return { prisma, now: () => now, actor: { area: 'platform' as const, userId: adminId } };
}

/** For the actions that take the photographer's scope (cancelByAdmin). */
function scope(now: Date = NOW) {
  return { prisma, now: () => now, photographerId: world.photographerId };
}

/** A provider whose every method fails the test. Nothing here may reach one. */
function forbiddenProvider() {
  const forbid = (method: string) => (): never => {
    throw new Error(`recordRefund called the provider: ${method}`);
  };
  return stubProvider({
    initiate: forbid('initiate'),
    lookupStatus: forbid('lookupStatus'),
    verifyWebhook: forbid('verifyWebhook'),
    parseWebhook: forbid('parseWebhook'),
  });
}

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
});

afterAll(async () => {
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  world = await seedWorld(prisma);
  adminId = (await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } })).id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- Helpers ----------------------------------------------------------------------------

type PaymentRow = {
  kind: string;
  status: string;
  amount_rwf: number;
  settled_at: Date | null;
  refunded_at: Date | null;
  refund_reference: string | null;
  refunded_by_user_id: string | null;
};

async function paymentRow(id: string): Promise<PaymentRow> {
  const result = await raw.query<PaymentRow>(
    'SELECT kind, status, amount_rwf, settled_at, refunded_at, refund_reference, refunded_by_user_id FROM payment WHERE id = $1',
    [id],
  );
  if (result.rows[0] === undefined) throw new Error('No such payment');
  return result.rows[0];
}

type Provider = 'cash' | 'mtn_momo_direct' | 'flutterwave';

/** A confirmed booking with one payment in the state a test needs: cash by default, which the studio records. */
async function bookingWithPayment(status: string, amountRwf = 20_000, provider: Provider = 'cash') {
  // Its own fixture day, so two of these in one test never overlap.
  const booking = await insertBooking(prisma, world, { status: 'confirmed' });
  const payment = await insertPayment(prisma, booking.id, { status, amountRwf, provider, kind: provider === 'cash' ? 'session_fee' : 'booking_fee' });
  return { booking, payment };
}

async function totalsOf(bookingId: string) {
  const booking = await findAdminBooking(prisma, world.photographerId, bookingId);
  if (booking === null) throw new Error('No such booking');
  return bookingTotals(booking, booking.addons, booking.payments);
}

// --- Recording a refund -------------------------------------------------------------------

describe('the photographer recording a refund of cash he was handed', () => {
  it('moves it to refunded, stamps the clock, keeps the reference verbatim and records who', async () => {
    const { payment } = await bookingWithPayment('refund_due');

    const result = await recordRefund(deps(), payment.id, { reference: 'MOMO-REF-7781' });

    expect(result.status).toBe('recorded');
    if (result.status !== 'recorded') throw new Error('unreachable');
    expect(result.payment).toMatchObject({ id: payment.id, status: 'refunded', refundReference: 'MOMO-REF-7781', refundedAt: NOW });
    expect(await paymentRow(payment.id)).toMatchObject({
      status: 'refunded',
      refunded_at: NOW,
      refund_reference: 'MOMO-REF-7781',
      // Who did what (Phase 4): the photographer who recorded it.
      refunded_by_user_id: world.photographerUserId,
    });
  });

  it('takes the date the photographer says he sent it, over the clock', async () => {
    const { payment } = await bookingWithPayment('refund_due');
    const sentOn = new Date('2026-09-28T14:30:00Z');

    await recordRefund(deps(), payment.id, { reference: 'BANK-0001', refundedAt: sentOn });

    expect((await paymentRow(payment.id)).refunded_at).toStrictEqual(sentOn);
  });

  it('leaves settled_at alone: when the money came in is a different fact from when it went back', async () => {
    const { payment } = await bookingWithPayment('refund_due');
    const before = await paymentRow(payment.id);

    await recordRefund(deps(), payment.id, { reference: 'MOMO-REF-7781' });

    expect((await paymentRow(payment.id)).settled_at).toStrictEqual(before.settled_at);
  });

  it('drops what the booking counts as collected across the whole arc (data-model_v2.md §6.1)', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: new Date('2027-01-06T07:00:00Z') });
    const payment = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000, kind: 'session_fee', provider: 'cash' });
    expect(await totalsOf(booking.id)).toMatchObject({ collectedRwf: 20_000, refundDueRwf: 0 });

    // Cancelling is what turns money held into money owed back (spec §6.11).
    await cancelByAdmin(scope(), booking.id, null);
    expect(await totalsOf(booking.id)).toMatchObject({ collectedRwf: 0, refundDueRwf: 20_000 });

    await recordRefund(deps(), payment.id, { reference: 'MOMO-REF-7781' });

    expect(await totalsOf(booking.id)).toMatchObject({ collectedRwf: 0, refundDueRwf: 0, outstandingRwf: 0 });
  });

  it('records one flagged payment without touching the other', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: new Date('2027-01-06T07:00:00Z') });
    const first = await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', provider: 'cash', amountRwf: 20_000, ageSeconds: 300 });
    const second = await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', provider: 'cash', amountRwf: 30_000, ageSeconds: 100 });

    await recordRefund(deps(), first.id, { reference: 'MOMO-REF-7781' });

    expect((await paymentRow(first.id)).status).toBe('refunded');
    expect(await paymentRow(second.id)).toMatchObject({ status: 'refund_due', refunded_at: null, refund_reference: null, refunded_by_user_id: null });
    expect(await totalsOf(booking.id)).toMatchObject({ refundDueRwf: 30_000 });
  });
});

// --- What it refuses ------------------------------------------------------------------------

describe('what the studio cannot record', () => {
  it('answers not_found for a payment that does not exist', async () => {
    expect(await recordRefund(deps(), '3f1b9c2a-0000-4000-8000-00000000abcd', { reference: 'MOMO-REF-7781' })).toStrictEqual({
      status: 'not_found',
    });
  });

  it('answers not_found for another photographer’s cash, exactly as for nothing at all', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    const booking = await insertBooking(prisma, second, { status: 'confirmed' });
    const payment = await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', provider: 'cash' });

    expect(await recordRefund(deps(), payment.id, { reference: 'R-1' })).toStrictEqual({ status: 'not_found' });
    expect((await paymentRow(payment.id)).status).toBe('refund_due');
  });

  it.each(['succeeded', 'failed', 'pending', 'initiated', 'refunded'] as const)('refuses a %s cash payment and writes nothing', async (status) => {
    const { payment } = await bookingWithPayment(status);
    const before = await paymentRow(payment.id);

    expect(await recordRefund(deps(), payment.id, { reference: 'MOMO-REF-7781' })).toStrictEqual({ status: 'not_refundable' });

    expect(await paymentRow(payment.id)).toStrictEqual(before);
  });

  it.each(['mtn_momo_direct', 'flutterwave'] as const)('refuses a %s refund as refund_with_platform: the money is in the platform’s account', async (provider) => {
    const { payment } = await bookingWithPayment('refund_due', 20_000, provider);
    const before = await paymentRow(payment.id);

    expect(await recordRefund(deps(), payment.id, { reference: 'MOMO-REF-7781' })).toStrictEqual({ status: 'refund_with_platform' });

    expect(await paymentRow(payment.id)).toStrictEqual(before);
  });

  it('refuses an online payment as refund_with_platform whatever its status', async () => {
    const { payment } = await bookingWithPayment('succeeded', 20_000, 'mtn_momo_direct');
    expect(await recordRefund(deps(), payment.id, { reference: 'X' })).toStrictEqual({ status: 'refund_with_platform' });
  });

  it('refuses a second recording and leaves the first one’s reference and date standing', async () => {
    const { payment } = await bookingWithPayment('refund_due');
    await recordRefund(deps(), payment.id, { reference: 'MOMO-REF-7781' });
    const afterFirst = await paymentRow(payment.id);

    const second = await recordRefund(deps(new Date('2026-12-25T00:00:00Z')), payment.id, { reference: 'A-LATER-REFERENCE' });

    expect(second).toStrictEqual({ status: 'not_refundable' });
    expect(await paymentRow(payment.id)).toStrictEqual(afterFirst);
  });

  it('records once when two recordings race for the same payment', async () => {
    const { payment } = await bookingWithPayment('refund_due');

    const results = await Promise.all([
      recordRefund(deps(), payment.id, { reference: 'FIRST' }),
      recordRefund(deps(), payment.id, { reference: 'SECOND' }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['not_refundable', 'recorded']);
    const row = await paymentRow(payment.id);
    expect(row.status).toBe('refunded');
    expect(['FIRST', 'SECOND']).toContain(row.refund_reference);
  });
});

// --- The platform: money paid online (R4.6) ---------------------------------------------------

describe('a platform admin recording a refund of money paid online', () => {
  it.each(['mtn_momo_direct', 'flutterwave'] as const)('records a %s refund, and who recorded it', async (provider) => {
    const { payment } = await bookingWithPayment('refund_due', 20_000, provider);

    const result = await recordRefund(platform(), payment.id, { reference: 'MTN-REFUND-01' });

    expect(result).toMatchObject({ status: 'recorded', payment: { status: 'refunded', refundReference: 'MTN-REFUND-01', refundedByUserId: adminId } });
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'refunded', refunded_at: NOW, refunded_by_user_id: adminId });
  });

  it('records any photographer’s booking: the platform holds every online payment', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    const booking = await insertBooking(prisma, second, { status: 'cancelled_by_photographer' });
    const payment = await insertPayment(prisma, booking.id, { status: 'refund_due' });

    expect((await recordRefund(platform(), payment.id, { reference: 'R-2' })).status).toBe('recorded');
  });

  it('is refused cash as cash_payment, and nothing is written', async () => {
    const { payment } = await bookingWithPayment('refund_due', 20_000, 'cash');
    const before = await paymentRow(payment.id);

    expect(await recordRefund(platform(), payment.id, { reference: 'R-1' })).toStrictEqual({ status: 'cash_payment' });

    expect(await paymentRow(payment.id)).toStrictEqual(before);
  });

  it.each(['succeeded', 'failed', 'pending', 'initiated', 'refunded'] as const)('is refused a %s online payment as not_refundable', async (status) => {
    const { payment } = await bookingWithPayment(status, 20_000, 'mtn_momo_direct');
    const before = await paymentRow(payment.id);

    expect(await recordRefund(platform(), payment.id, { reference: 'R-1' })).toStrictEqual({ status: 'not_refundable' });

    expect(await paymentRow(payment.id)).toStrictEqual(before);
  });

  it('answers not_found for a payment that does not exist', async () => {
    expect(await recordRefund(platform(), '3f1b9c2a-0000-4000-8000-00000000abcd', { reference: 'R-1' })).toStrictEqual({ status: 'not_found' });
  });

  it('records once when two admins click at the same moment', async () => {
    const { payment } = await bookingWithPayment('refund_due', 20_000, 'mtn_momo_direct');

    const results = await Promise.all([recordRefund(platform(), payment.id, { reference: 'A' }), recordRefund(platform(), payment.id, { reference: 'B' })]);

    expect(results.map((result) => result.status).sort()).toEqual(['not_refundable', 'recorded']);
  });

  it('touches no payout item: the earning was taken back when the payment became refund_due', async () => {
    const { payment } = await bookingWithPayment('refund_due', 20_000, 'mtn_momo_direct');

    await recordRefund(platform(), payment.id, { reference: 'R-1' });

    expect(await prisma.payoutItem.count()).toBe(0);
  });
});

// --- No money moves ---------------------------------------------------------------------------

describe('the system moves no money (spec §6.16, R-5)', () => {
  it('calls no provider and makes no outbound request, in either area', async () => {
    const provider = forbiddenProvider();
    vi.stubGlobal('fetch', () => {
      throw new Error('recordRefund made an outbound request');
    });
    const { payment } = await bookingWithPayment('refund_due');
    const online = await bookingWithPayment('refund_due', 20_000, 'mtn_momo_direct');

    // The dependencies are the database, a clock and who is acting. There is
    // no provider to pass: `RecordRefundDeps` has no field for one.
    expect(await recordRefund(deps(), payment.id, { reference: 'MOMO-REF-7781' })).toMatchObject({ status: 'recorded' });
    expect(await recordRefund(platform(), online.payment.id, { reference: 'MTN-1' })).toMatchObject({ status: 'recorded' });

    expect([provider.initiated, provider.lookedUp, provider.deliveries]).toEqual([[], [], []]);
  });

  it('changes no booking status: a refund is a payment fact, not a lifecycle event', async () => {
    const booking = await insertBooking(prisma, world, { status: 'cancelled_by_photographer', startsAt: new Date('2027-01-06T07:00:00Z') });
    const payment = await insertPayment(prisma, booking.id, { status: 'refund_due', amountRwf: 20_000, kind: 'session_fee', provider: 'cash' });

    await recordRefund(deps(), payment.id, { reference: 'MOMO-REF-7781' });

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after).toMatchObject({ status: 'cancelled_by_photographer', cancelledAt: booking.cancelledAt });
  });

  it('sends nothing: the client is told about a refund by whoever sent it, not by the system', async () => {
    const { payment } = await bookingWithPayment('refund_due');
    const online = await bookingWithPayment('refund_due', 20_000, 'flutterwave');

    await recordRefund(deps(), payment.id, { reference: 'MOMO-REF-7781' });
    await recordRefund(platform(), online.payment.id, { reference: 'FLW-1' });

    expect(await prisma.outbox.count()).toBe(0);
  });
});
