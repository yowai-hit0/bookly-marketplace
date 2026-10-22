import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cancelByAdmin } from '../booking/admin-actions.js';
import { cancelByClient } from '../booking/cancel.js';
import { createPrismaClient } from '../db/client.js';
import { recordCashPayment } from '../payments/cash.js';
import type { ProviderEvent } from '../payments/provider.js';
import { reconcilePendingPayments } from '../payments/reconcile.js';
import { recordEvent } from '../payments/webhooks.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  MINUTE_MS,
  type PaymentWorld,
  grantAccessToken,
  insertBooking,
  insertPayment,
  logSink,
  seedSecondPhotographer,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';
import { payableBalance, payableItems, recordEarning, recordRefundDue, releaseDraftItems } from './ledger.js';
import { buildPayout, cancelPayout, markPayoutPaid } from './payouts.js';

/**
 * The payout ledger (marketplace-spec.md R4.2, R4.3, T4.1, T4.2;
 * marketplace-data-model.md §3.9), against real PostgreSQL, through every path
 * that moves a payment into `succeeded` or `refund_due`:
 *
 * - a webhook success: booking fee confirming a booking, a session fee, a late
 *   fee re-confirming an expired booking, a fee for a booking in no state to
 *   take one; the reconciler's status lookup, which applies through the same path;
 * - a webhook that makes the money `refund_due` at once (slot taken, duplicate
 *   fee): never succeeded, so nothing is earned;
 * - a client's cancellation (session fee, and the booking fee under each
 *   policy) and a photographer's;
 * - cash, which never creates an item.
 *
 * Idempotency: a duplicate delivery, a concurrent one, a second refund. Timing:
 * a booking fee is payable at once, a session fee once its shoot has ended and
 * not if the booking was cancelled. Netting: a refund after a payout is a
 * reversal the next payout subtracts, and a total of nought or less builds
 * nothing and carries forward.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let adminId: string;

/** Before every fixture shoot (January 2027 onwards). */
const NOW = new Date('2026-10-02T09:15:00.000Z');
/** Long after every fixture shoot has ended. */
const LATER = new Date('2027-12-01T00:00:00.000Z');

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

// --- Helpers ----------------------------------------------------------------------------

let eventCounter = 0;

function successEvent(ourRef: string, amount: number | null = null, eventId?: string): ProviderEvent {
  eventCounter += 1;
  return {
    eventId: eventId ?? `evt-${eventCounter}`,
    eventType: 'payment',
    ourRef,
    providerRef: null,
    reportedStatus: 'succeeded',
    method: 'momo_mtn',
    failureReason: null,
    amount,
    currency: null,
  };
}

function deliver(event: ProviderEvent) {
  return recordEvent({ prisma, now: () => NOW, log: logSink().log }, 'mtn_momo_direct', { signatureValid: true, event, payload: {}, expectedCurrency: 'EUR' });
}

type ItemRow = { kind: string; amount_rwf: number; photographer_id: string; payout_id: string | null; voided: boolean };

async function itemsOf(paymentId: string): Promise<ItemRow[]> {
  const result = await raw.query<ItemRow>(
    `SELECT kind, amount_rwf, photographer_id::text AS photographer_id, payout_id::text AS payout_id, voided_at IS NOT NULL AS voided
       FROM payout_item WHERE payment_id = $1 ORDER BY kind`,
    [paymentId],
  );
  return result.rows;
}

async function itemCount(): Promise<number> {
  return Number((await raw.query<{ n: string }>('SELECT count(*) AS n FROM payout_item')).rows[0]?.n);
}

async function paymentStatus(id: string): Promise<string> {
  return (await prisma.payment.findUniqueOrThrow({ where: { id } })).status;
}

async function giveMethod(photographerId: string): Promise<void> {
  await prisma.payoutMethod.create({ data: { photographerId, kind: 'momo', momoNetwork: 'mtn', momoNumber: '+250788123456', accountName: 'Kigali Lens Ltd' } });
}

/** A succeeded booking fee with its earning, written the way the webhook writes both. */
async function earnedFee(bookingId: string, amountRwf = 20_000, kind: 'booking_fee' | 'session_fee' = 'booking_fee') {
  const payment = await insertPayment(prisma, bookingId, { status: 'succeeded', amountRwf, kind });
  await prisma.$transaction((tx) => recordEarning(tx, payment.id));
  return payment;
}

const payoutDeps = (now: Date = LATER) => ({ prisma, now: () => now });

// --- Succeeded money earns (R4.2, T4.1) ----------------------------------------------------

describe('a succeeded non-cash fee earns its full amount, in the transaction that succeeded it', () => {
  it('a booking fee confirming its booking: an earning of the payment amount, for the booking’s photographer, payable at once', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'pending', amountRwf: 20_000 });

    expect((await deliver(successEvent(payment.ourRef, 20_000))).note).toBe('booking_confirmed');

    expect(await itemsOf(payment.id)).toEqual([{ kind: 'earning', amount_rwf: 20_000, photographer_id: world.photographerId, payout_id: null, voided: false }]);
    // No commission (decisions table): the whole payment, payable now, before the shoot.
    expect(await payableBalance(prisma, world.photographerId, NOW)).toBe(20_000);
  });

  it('a session fee: earned at once, pending until the shoot has ended, payable after', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const payment = await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000 });

    await deliver(successEvent(payment.ourRef, 30_000));

    expect(await itemsOf(payment.id)).toMatchObject([{ kind: 'earning', amount_rwf: 30_000, voided: false }]);
    expect(await payableBalance(prisma, world.photographerId, NOW)).toBe(0);
    // One millisecond before the end, still pending; at the end, payable (§3.9: ends_at <= now).
    expect(await payableBalance(prisma, world.photographerId, new Date(booking.endsAt.getTime() - 1))).toBe(0);
    expect(await payableBalance(prisma, world.photographerId, booking.endsAt)).toBe(30_000);
  });

  it('a late fee re-confirming an expired booking whose slot is still free', async () => {
    const booking = await insertBooking(prisma, world, { status: 'expired' });
    const payment = await insertPayment(prisma, booking.id, { status: 'pending', amountRwf: 20_000 });

    expect((await deliver(successEvent(payment.ourRef))).note).toBe('booking_reconfirmed');

    expect(await itemsOf(payment.id)).toMatchObject([{ kind: 'earning', amount_rwf: 20_000 }]);
  });

  it('a fee for a booking in no state to take one: recorded as succeeded, so earned', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    const payment = await insertPayment(prisma, booking.id, { status: 'pending', amountRwf: 20_000 });

    await deliver(successEvent(payment.ourRef));

    expect(await paymentStatus(payment.id)).toBe('succeeded');
    expect(await itemsOf(payment.id)).toMatchObject([{ kind: 'earning' }]);
  });

  it('the reconciler’s status lookup earns through the same path (R3.5)', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'pending', amountRwf: 20_000, ageSeconds: 120 });
    const provider = stubProvider({ lookupStatus: async (ourRef) => ({ event: successEvent(ourRef, 20_000), payload: {} }) });

    expect(await reconcilePendingPayments({ prisma, now: () => NOW, provider, log: logSink().log })).toBe(1);

    expect(await itemsOf(payment.id)).toMatchObject([{ kind: 'earning', amount_rwf: 20_000 }]);
  });

  it('files the earning under the booking’s photographer, never another', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    const booking = await insertBooking(prisma, second);
    const payment = await insertPayment(prisma, booking.id, { status: 'pending' });

    await deliver(successEvent(payment.ourRef));

    expect((await itemsOf(payment.id))[0]?.photographer_id).toBe(second.photographerId);
    expect(await payableBalance(prisma, world.photographerId, NOW)).toBe(0);
    expect(await payableBalance(prisma, second.photographerId, NOW)).toBe(20_000);
  });
});

describe('idempotency: one earning per payment, whatever arrives twice (@@unique([paymentId, kind]))', () => {
  it('a duplicate delivery of the same event adds nothing', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'pending' });
    const event = successEvent(payment.ourRef);

    await deliver(event);
    expect((await deliver(event)).note).toBe('duplicate_delivery');

    expect(await itemsOf(payment.id)).toHaveLength(1);
  });

  it('a second, different success event for the settled payment adds nothing', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'pending' });

    await deliver(successEvent(payment.ourRef));
    expect((await deliver(successEvent(payment.ourRef))).note).toBe('payment_succeeded');

    expect(await itemsOf(payment.id)).toHaveLength(1);
  });

  it('the same event delivered concurrently earns once', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'pending' });
    const event = successEvent(payment.ourRef);

    await Promise.all([deliver(event), deliver(event), deliver({ ...event, eventId: 'another-id' })]);

    expect(await itemsOf(payment.id)).toHaveLength(1);
  });

  it('recordEarning twice answers exists and writes nothing more', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const payment = await earnedFee(booking.id);

    expect(await prisma.$transaction((tx) => recordEarning(tx, payment.id))).toBe('exists');
    expect(await itemsOf(payment.id)).toHaveLength(1);
  });

  it('refuses to earn for money that has not succeeded', async () => {
    const booking = await insertBooking(prisma, world);
    for (const status of ['initiated', 'pending', 'failed', 'refund_due', 'refunded']) {
      const payment = await insertPayment(prisma, booking.id, { status, kind: 'session_fee' });
      expect(await prisma.$transaction((tx) => recordEarning(tx, payment.id))).toBe('not_eligible');
    }
    expect(await itemCount()).toBe(0);
  });
});

describe('money that never succeeded earns nothing', () => {
  it('a late fee whose slot was taken goes straight to refund_due, with no item', async () => {
    const startsAt = new Date('2027-03-01T07:00:00Z');
    const late = await insertBooking(prisma, world, { status: 'expired', startsAt });
    await insertBooking(prisma, world, { status: 'confirmed', startsAt });
    const payment = await insertPayment(prisma, late.id, { status: 'pending' });

    expect((await deliver(successEvent(payment.ourRef))).note).toBe('refund_due_slot_taken');

    expect(await paymentStatus(payment.id)).toBe('refund_due');
    expect(await itemCount()).toBe(0);
  });

  it('a second booking fee is refund_due and earns nothing; the first keeps its earning', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const first = await earnedFee(booking.id);
    const second = await insertPayment(prisma, booking.id, { status: 'pending' });

    expect((await deliver(successEvent(second.ourRef))).note).toBe('refund_due_duplicate_payment');

    expect(await itemsOf(second.id)).toEqual([]);
    expect(await itemsOf(first.id)).toMatchObject([{ kind: 'earning', voided: false }]);
  });
});

describe('cash never creates an item (T4.1)', () => {
  it('recording cash writes a succeeded payment and no payout item', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await earnedFee(booking.id);

    const result = await recordCashPayment({ prisma, now: () => NOW, photographerId: world.photographerId }, booking.id, { amountRwf: 30_000, note: null });

    expect(result.status).toBe('ok');
    const cash = await prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id, provider: 'cash' } });
    expect(cash.status).toBe('succeeded');
    expect(await itemsOf(cash.id)).toEqual([]);
    expect(await prisma.$transaction((tx) => recordEarning(tx, cash.id))).toBe('not_eligible');
  });

  it('a refund of cash finds no earning to undo', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const cash = await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', provider: 'cash' });

    expect(await prisma.$transaction((tx) => recordRefundDue(tx, cash.id, NOW))).toBe('no_earning');
    expect(await itemCount()).toBe(0);
  });
});

// --- Refund before payout voids (T4.2) ------------------------------------------------------

describe('a refund before any payout voids the earning', () => {
  it('a client cancelling after paying the session fee: its earning voided, the forfeited booking fee still payable', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const token = await grantAccessToken(prisma, booking.id);
    const fee = await earnedFee(booking.id, 20_000);
    const session = await earnedFee(booking.id, 30_000, 'session_fee');

    expect((await cancelByClient({ prisma, now: () => NOW }, token)).status).toBe('cancelled');

    expect(await paymentStatus(session.id)).toBe('refund_due');
    expect(await itemsOf(session.id)).toMatchObject([{ kind: 'earning', voided: true, payout_id: null }]);
    // The policy keeps the booking fee: it stays the photographer's (R1.8).
    expect(await itemsOf(fee.id)).toMatchObject([{ kind: 'earning', voided: false }]);
    expect(await payableBalance(prisma, world.photographerId, LATER)).toBe(20_000);
  });

  it('a client cancelling under a policy that refunds the booking fee: that earning is voided too', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', bookingFeeRefundableOnClientCancel: true });
    const token = await grantAccessToken(prisma, booking.id);
    const fee = await earnedFee(booking.id);

    await cancelByClient({ prisma, now: () => NOW }, token);

    expect(await itemsOf(fee.id)).toMatchObject([{ kind: 'earning', voided: true }]);
    expect(await payableBalance(prisma, world.photographerId, LATER)).toBe(0);
  });

  it('a photographer cancelling: every earning voided, nothing reversed', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const fee = await earnedFee(booking.id, 20_000);
    const session = await earnedFee(booking.id, 30_000, 'session_fee');

    expect((await cancelByAdmin({ prisma, now: () => NOW, photographerId: world.photographerId }, booking.id, null)).status).toBe('ok');

    expect(await itemsOf(fee.id)).toMatchObject([{ kind: 'earning', voided: true }]);
    expect(await itemsOf(session.id)).toMatchObject([{ kind: 'earning', voided: true }]);
    expect(await payableBalance(prisma, world.photographerId, LATER)).toBe(0);
  });

  it('a second refund_due for the same payment is a no-op', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const fee = await earnedFee(booking.id);
    await prisma.payment.update({ where: { id: fee.id }, data: { status: 'refund_due' } });

    expect(await prisma.$transaction((tx) => recordRefundDue(tx, fee.id, NOW))).toBe('voided');
    expect(await prisma.$transaction((tx) => recordRefundDue(tx, fee.id, NOW))).toBe('already_undone');
    expect(await itemsOf(fee.id)).toHaveLength(1);
  });

  it('refuses to undo the earning of a payment that is not refund_due: the ledger would disagree with it', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const fee = await earnedFee(booking.id);

    await expect(prisma.$transaction((tx) => recordRefundDue(tx, fee.id, NOW))).rejects.toThrow(/not refund_due/);
    expect(await itemsOf(fee.id)).toMatchObject([{ voided: false }]);
  });
});

// --- Refund after payout reverses, and nets off (T4.2) ---------------------------------------

describe('a refund after a payout adds a reversal, which the next payout nets off', () => {
  async function paidPayoutWith(bookingId: string, amountRwf: number) {
    const fee = await earnedFee(bookingId, amountRwf);
    await giveMethod(world.photographerId);
    const built = await buildPayout(payoutDeps(), { photographerId: world.photographerId, adminUserId: adminId });
    if (built.status !== 'created') throw new Error(`expected a draft, got ${built.status}`);
    await markPayoutPaid(payoutDeps(), { payoutId: built.payout.id, adminUserId: adminId, transferReference: 'MTN-TX-1', note: null });
    return { fee, payoutId: built.payout.id };
  }

  it('a photographer cancelling after the fee was paid out: a reversal of the same amount, negative, payable', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const { fee, payoutId } = await paidPayoutWith(booking.id, 20_000);

    await cancelByAdmin({ prisma, now: () => NOW, photographerId: world.photographerId }, booking.id, null);

    expect(await itemsOf(fee.id)).toEqual([
      { kind: 'earning', amount_rwf: 20_000, photographer_id: world.photographerId, payout_id: payoutId, voided: false },
      { kind: 'reversal', amount_rwf: -20_000, photographer_id: world.photographerId, payout_id: null, voided: false },
    ]);
    expect(await payableBalance(prisma, world.photographerId, LATER)).toBe(-20_000);
  });

  it('the next payout subtracts it from new earnings', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await paidPayoutWith(booking.id, 20_000);
    await cancelByAdmin({ prisma, now: () => NOW, photographerId: world.photographerId }, booking.id, null);
    const another = await insertBooking(prisma, world, { status: 'confirmed' });
    const newFee = await earnedFee(another.id, 50_000);

    const next = await buildPayout(payoutDeps(), { photographerId: world.photographerId, adminUserId: adminId });

    expect(next.status).toBe('created');
    if (next.status !== 'created') throw new Error('unreachable');
    expect(next.payout.amountRwf).toBe(30_000);
    expect(next.payout.items.map((item) => [item.kind, item.amountRwf]).sort()).toEqual([
      ['earning', 50_000],
      ['reversal', -20_000],
    ]);
    expect(await itemsOf(newFee.id)).toMatchObject([{ payout_id: next.payout.id }]);
  });

  it('a total of nought or less builds nothing, and the reversal carries forward until earnings cover it', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await paidPayoutWith(booking.id, 20_000);
    await cancelByAdmin({ prisma, now: () => NOW, photographerId: world.photographerId }, booking.id, null);
    const another = await insertBooking(prisma, world, { status: 'confirmed' });
    await earnedFee(another.id, 20_000);

    expect(await buildPayout(payoutDeps(), { photographerId: world.photographerId, adminUserId: adminId })).toEqual({ status: 'nothing_payable', payableRwf: 0 });
    expect(await prisma.payout.count({ where: { status: 'draft' } })).toBe(0);
    expect(await payableItems(prisma, world.photographerId, LATER)).toHaveLength(2);

    const third = await insertBooking(prisma, world, { status: 'confirmed' });
    await earnedFee(third.id, 5_000);
    const built = await buildPayout(payoutDeps(), { photographerId: world.photographerId, adminUserId: adminId });
    expect(built.status === 'created' && built.payout.amountRwf).toBe(5_000);
  });

  it('an earning in a draft when its payment is refunded is reversed, not voided: the draft amount stands', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const fee = await earnedFee(booking.id, 20_000);
    const other = await insertBooking(prisma, world, { status: 'confirmed' });
    await earnedFee(other.id, 10_000);
    await giveMethod(world.photographerId);
    const draft = await buildPayout(payoutDeps(), { photographerId: world.photographerId, adminUserId: adminId });
    if (draft.status !== 'created') throw new Error('expected a draft');

    await cancelByAdmin({ prisma, now: () => NOW, photographerId: world.photographerId }, booking.id, null);

    expect(await itemsOf(fee.id)).toMatchObject([
      { kind: 'earning', payout_id: draft.payout.id, voided: false },
      { kind: 'reversal', amount_rwf: -20_000, payout_id: null, voided: false },
    ]);
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: draft.payout.id } })).amountRwf).toBe(30_000);
  });

  it('cancelling that draft voids the refunded earning and its reversal together: neither was ever paid', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const fee = await earnedFee(booking.id, 20_000);
    const other = await insertBooking(prisma, world, { status: 'confirmed' });
    const kept = await earnedFee(other.id, 10_000);
    await giveMethod(world.photographerId);
    const draft = await buildPayout(payoutDeps(), { photographerId: world.photographerId, adminUserId: adminId });
    if (draft.status !== 'created') throw new Error('expected a draft');
    await cancelByAdmin({ prisma, now: () => NOW, photographerId: world.photographerId }, booking.id, null);

    expect((await cancelPayout(payoutDeps(), { payoutId: draft.payout.id, adminUserId: adminId })).status).toBe('ok');

    expect(await itemsOf(fee.id)).toMatchObject([
      { kind: 'earning', payout_id: null, voided: true },
      { kind: 'reversal', payout_id: null, voided: true },
    ]);
    // The untouched earning is released and payable again; the refund takes nothing off it.
    expect(await itemsOf(kept.id)).toMatchObject([{ kind: 'earning', payout_id: null, voided: false }]);
    expect(await payableBalance(prisma, world.photographerId, LATER)).toBe(10_000);
  });

  it('releasing a draft with nothing refunded only clears payout_id', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const fee = await earnedFee(booking.id, 20_000);
    await giveMethod(world.photographerId);
    const draft = await buildPayout(payoutDeps(), { photographerId: world.photographerId, adminUserId: adminId });
    if (draft.status !== 'created') throw new Error('expected a draft');

    await prisma.$transaction((tx) => releaseDraftItems(tx, draft.payout.id, NOW));

    expect(await itemsOf(fee.id)).toMatchObject([{ kind: 'earning', payout_id: null, voided: false }]);
  });
});

// --- Payable now (R4.3, §3.9) ------------------------------------------------------------------

describe('payable now is derived from the §3.9 rules', () => {
  it.each(['cancelled_by_client', 'cancelled_by_photographer', 'cancelled_by_platform', 'expired'])(
    'a succeeded session fee on a %s booking is never payable, even after its shoot',
    async (status) => {
      const booking = await insertBooking(prisma, world, { status: 'confirmed' });
      await earnedFee(booking.id, 30_000, 'session_fee');
      await prisma.booking.update({ where: { id: booking.id }, data: { status, cancelledAt: NOW } });

      expect(await payableBalance(prisma, world.photographerId, LATER)).toBe(0);
    },
  );

  it.each(['completed', 'no_show', 'confirmed'])('a session fee on a %s booking is payable once its shoot ended', async (status) => {
    const booking = await insertBooking(prisma, world, { status });
    await earnedFee(booking.id, 30_000, 'session_fee');

    expect(await payableBalance(prisma, world.photographerId, new Date(booking.endsAt.getTime() + MINUTE_MS))).toBe(30_000);
  });

  it('a booking fee is payable whatever the booking became, short of a refund', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await earnedFee(booking.id);
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'cancelled_by_client', cancelledAt: NOW } });

    expect(await payableBalance(prisma, world.photographerId, NOW)).toBe(20_000);
  });

  it('leaves out voided items and items already in a payout', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const fee = await earnedFee(booking.id);
    const other = await insertBooking(prisma, world, { status: 'confirmed' });
    await earnedFee(other.id, 7_000);
    await prisma.payment.update({ where: { id: fee.id }, data: { status: 'refund_due' } });
    await prisma.$transaction((tx) => recordRefundDue(tx, fee.id, NOW));

    expect((await payableItems(prisma, world.photographerId, NOW)).map((item) => item.amount_rwf)).toEqual([7_000]);
  });
});
