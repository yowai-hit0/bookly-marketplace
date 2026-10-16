import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findBookingByToken } from '../booking/access.js';
import { cancelByAdmin } from '../booking/admin-actions.js';
import { adminBookingView, findAdminBooking } from '../booking/admin-view.js';
import { clientBookingView } from '../booking/client-view.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type PaymentWorld, insertBooking, insertBookingWithToken, insertPayment, seedWorld } from '../test/payment-fixtures.js';
import { recordCashPayment, SUPERSEDED_BY_CASH } from './cash.js';
import { requestSessionFee } from './session-fee.js';

/**
 * "Record cash payment" (admin console fixes, item 7; user decision
 * 2026-09-27), against real PostgreSQL.
 *
 * What is proven. Cash is a `succeeded` session fee with the `cash` provider,
 * settled at once and carrying the photographer's note; no email goes to the
 * client. It is refused over what is owed (`over_outstanding`), where nothing
 * is owed, on a booking that no longer stands, and while the client may be
 * paying the same balance online (`in_progress`, the rule a session-fee
 * request uses). Otherwise an open online request is voided, so its emailed
 * link cannot collect the same money twice, and the client's page shows
 * nothing to pay. Paid in full after the shoot has begun, the booking
 * completes in the same transaction. A cancellation flags the cash for a
 * refund like any other payment.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;

/** The injected app clock: long before every fixture shoot (January 2027). */
const NOW = new Date('2026-10-01T06:00:00Z');
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ff';

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
});

function deps(now: Date = NOW) {
  return { prisma, now: () => now };
}

function cash(bookingId: string, amountRwf: number, note: string | null = null, now: Date = NOW) {
  return recordCashPayment(deps(now), bookingId, { amountRwf, note });
}

/** 50,000 owed (40,000 package + a 10,000 add-on), the 20,000 booking fee paid: 30,000 outstanding. */
async function owingBooking(seed: Parameters<typeof insertBooking>[2] = {}) {
  const booking = await insertBooking(prisma, world, { status: 'confirmed', ...seed });
  await insertPayment(prisma, booking.id, { status: 'succeeded', ageSeconds: 3600 });
  return booking;
}

async function sessionFees(bookingId: string) {
  return prisma.payment.findMany({ where: { bookingId, kind: 'session_fee' }, orderBy: { initiatedAt: 'asc' } });
}

async function view(bookingId: string, now: Date = NOW) {
  const booking = await findAdminBooking(prisma, bookingId);
  if (booking === null) throw new Error('gone');
  return adminBookingView(booking, now);
}

async function outboxCount(): Promise<number> {
  return prisma.outbox.count();
}

describe('recording cash', () => {
  it('writes a succeeded cash session fee, settled now, with the note, and emails nobody', async () => {
    const booking = await owingBooking();

    const result = await cash(booking.id, 30_000, 'Paid at the studio.');

    expect(result.status).toBe('ok');
    const [row] = await sessionFees(booking.id);
    expect(row).toMatchObject({
      kind: 'session_fee',
      provider: 'cash',
      amountRwf: 30_000,
      status: 'succeeded',
      settledAt: NOW,
      note: 'Paid at the studio.',
      providerRef: null,
      method: null,
    });
    expect(await outboxCount()).toBe(0);
    const after = await view(booking.id);
    expect(after.money.totals).toMatchObject({ collectedRwf: 50_000, outstandingRwf: 0 });
    expect(after.payments.at(-1)).toMatchObject({ provider: 'cash', note: 'Paid at the studio.' });
  });

  it('takes part of the balance and leaves the rest owed', async () => {
    const booking = await owingBooking();

    expect((await cash(booking.id, 10_000)).status).toBe('ok');

    expect((await view(booking.id)).money.totals.outstandingRwf).toBe(20_000);
  });

  it('refuses more than is outstanding, and writes nothing', async () => {
    const booking = await owingBooking();

    expect(await cash(booking.id, 30_001)).toStrictEqual({ status: 'over_outstanding' });
    expect(await sessionFees(booking.id)).toEqual([]);
  });

  it('refuses where nothing is owed', async () => {
    const booking = await owingBooking();
    await cash(booking.id, 30_000);

    expect(await cash(booking.id, 1)).toStrictEqual({ status: 'nothing_to_pay' });
    expect(await sessionFees(booking.id)).toHaveLength(1);
  });

  it.each(['pending_payment', 'expired', 'no_show', 'cancelled_by_client', 'cancelled_by_admin'])(
    'refuses a %s booking',
    async (status) => {
      const booking = await insertBooking(prisma, world, { status });

      expect(await cash(booking.id, 1_000)).toStrictEqual({ status: 'not_allowed' });
      expect(await sessionFees(booking.id)).toEqual([]);
    },
  );

  it('answers not_found for a booking that does not exist', async () => {
    expect(await cash(UNKNOWN_ID, 1_000)).toStrictEqual({ status: 'not_found' });
  });

  it('takes it on a booking completed before 2026-09-27 that still owes money', async () => {
    const booking = await owingBooking({ status: 'completed' });

    expect((await cash(booking.id, 30_000)).status).toBe('ok');
    expect(await view(booking.id)).toMatchObject({ status: 'completed', money: { totals: { outstandingRwf: 0 } } });
  });
});

describe('an online payment that may be moving (in_progress)', () => {
  it('refuses while a prompt is on the payer’s phone', async () => {
    const booking = await owingBooking();
    await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000 });

    expect(await cash(booking.id, 30_000)).toStrictEqual({ status: 'in_progress' });
    expect((await sessionFees(booking.id)).map((row) => row.provider)).toEqual(['mtn_momo_direct']);
  });

  it('refuses while the client’s own attempt is waiting on the provider’s answer', async () => {
    const booking = await owingBooking();
    await insertPayment(prisma, booking.id, { status: 'initiated', kind: 'session_fee', amountRwf: 30_000 });

    expect(await cash(booking.id, 30_000)).toStrictEqual({ status: 'in_progress' });
    expect(await sessionFees(booking.id)).toHaveLength(1);
  });
});

describe('an open online request', () => {
  it('is voided by the cash, so its link cannot collect the same money, and the client sees nothing to pay', async () => {
    const { booking } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded', ageSeconds: 3600 });
    expect((await requestSessionFee({ prisma, providerId: 'mtn_momo_direct', now: () => NOW }, booking.id)).status).toBe('ok');
    const [request] = await sessionFees(booking.id);
    const token = (await prisma.outbox.findFirstOrThrow({ where: { template: 'session_fee_request' } })).payload as { accessToken: string };

    expect((await cash(booking.id, 30_000)).status).toBe('ok');

    const rows = await sessionFees(booking.id);
    expect(rows.find((row) => row.id === request?.id)).toMatchObject({ status: 'failed', failureReason: SUPERSEDED_BY_CASH });
    expect(rows.filter((row) => row.status === 'succeeded').map((row) => row.provider)).toEqual(['cash']);
    const accessed = await findBookingByToken(prisma, token.accessToken);
    if (accessed === null) throw new Error('The link stopped working');
    expect(clientBookingView(accessed, NOW).sessionFee).toBeNull();
  });

  it('is voided by part-payment in cash too; the next ask is for what is left', async () => {
    const booking = await owingBooking();
    await requestSessionFee({ prisma, providerId: 'mtn_momo_direct', now: () => NOW }, booking.id);

    expect((await cash(booking.id, 10_000)).status).toBe('ok');
    expect((await requestSessionFee({ prisma, providerId: 'mtn_momo_direct', now: () => NOW }, booking.id)).status).toBe('ok');

    const open = (await sessionFees(booking.id)).filter((row) => row.status === 'initiated');
    expect(open.map((row) => row.amountRwf)).toEqual([20_000]);
  });
});

describe('completing the booking it pays off (item 6)', () => {
  const STARTED = new Date(NOW.getTime() - 2 * 60 * 60_000);

  it('completes a booking whose shoot has begun, in the same transaction', async () => {
    const booking = await owingBooking({ startsAt: STARTED });

    expect((await cash(booking.id, 30_000)).status).toBe('ok');

    expect(await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({ status: 'completed', completedAt: NOW });
  });

  it('leaves it confirmed while money is still owed', async () => {
    const booking = await owingBooking({ startsAt: STARTED });

    await cash(booking.id, 29_999);

    expect(await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({ status: 'confirmed', completedAt: null });
  });

  it('leaves it confirmed when paid in full before the shoot begins', async () => {
    const booking = await owingBooking();

    await cash(booking.id, 30_000);

    expect(await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({ status: 'confirmed', completedAt: null });
  });
});

describe('refunds', () => {
  it('flags the cash refund_due when the photographer cancels, like any other payment', async () => {
    const booking = await owingBooking();
    await cash(booking.id, 10_000);

    expect((await cancelByAdmin(deps(), booking.id, 'Studio flooded.')).status).toBe('ok');

    const [row] = await sessionFees(booking.id);
    expect(row).toMatchObject({ provider: 'cash', status: 'refund_due' });
    const alert = await prisma.outbox.findFirstOrThrow({ where: { dedupeKey: `email:admin_alert:refund_due:${row?.id}` } });
    expect(alert.payload).toMatchObject({ provider: 'cash', amountRwf: 10_000 });
  });
});
