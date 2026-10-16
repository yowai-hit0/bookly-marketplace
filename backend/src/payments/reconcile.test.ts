import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  type PaymentWorld,
  insertBooking,
  insertPayment,
  logSink,
  mtnDelivery,
  mtnProvider,
  mtnStatusBody,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';
import { readEvent } from './mtn-momo.js';
import { RECONCILE_MAX_AGE_MINUTES, RECONCILE_MIN_AGE_SECONDS, SANDBOX_RECONCILE_MIN_AGE_SECONDS, reconcilePendingPayments } from './reconcile.js';
import { receiveWebhook } from './webhooks.js';

/**
 * Settling waiting payments by asking the provider (spec §4.3 "look up
 * status"; plan.md Tasks 16-17), against real PostgreSQL with the provider
 * stubbed or pointed at a fake MTN.
 *
 * What is proven: only this provider's `pending` payments initiated between a
 * minute and an hour ago are looked up, oldest first, twenty at a time; a
 * settled answer goes through the webhook path -- stored as a verified event,
 * applied forward-only, confirming the booking -- while a pending answer, an
 * unknown payment or a status we cannot read records nothing; one lookup
 * failing is logged and does not stop the others; and a callback for the same
 * outcome arriving after the lookup (or before it) is a duplicate that changes
 * nothing.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let sink: ReturnType<typeof logSink>;

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
  sink = logSink();
});

/** A booking holding its slot with one booking-fee payment of the given age and status. */
async function waiting(ageSeconds: number, status = 'pending', provider: 'mtn_momo_direct' | 'flutterwave' = 'mtn_momo_direct') {
  const booking = await insertBooking(prisma, world);
  const payment = await insertPayment(prisma, booking.id, { status, ageSeconds, provider });
  return { booking, payment };
}

/** A provider whose lookup answers MTN's body with `status` for every reference. */
function answering(status: string | ((ourRef: string) => string | null)) {
  return stubProvider({
    lookupStatus: async (ourRef) => {
      const answer = typeof status === 'string' ? status : status(ourRef);
      if (answer === null) return null;
      const payload = mtnStatusBody(ourRef, answer, { reason: answer === 'FAILED' ? 'APPROVAL_REJECTED' : undefined });
      const event = readEvent(ourRef, payload, 'requesttopay_status');
      if (event === null) throw new Error('fixture body unreadable');
      return { event, payload };
    },
  });
}

async function statusOf(table: 'booking' | 'payment', id: string): Promise<string> {
  const result = await raw.query<{ status: string }>(`SELECT status FROM ${table} WHERE id = $1`, [id]);
  return result.rows[0]?.status ?? 'missing';
}

async function eventRows() {
  const result = await raw.query<{ event_id: string; event_type: string; signature_valid: boolean; status: string; payload: unknown; processing_error: string | null }>(
    `SELECT event_id, event_type, signature_valid, status, payload, processing_error FROM webhook_event ORDER BY received_at, event_id`,
  );
  return result.rows;
}

describe('which payments are looked up', () => {
  it('only pending ones initiated between a minute and an hour ago, oldest first', async () => {
    const tooNew = await waiting(RECONCILE_MIN_AGE_SECONDS - 20);
    const justOldEnough = await waiting(RECONCILE_MIN_AGE_SECONDS + 5);
    const halfHour = await waiting(30 * 60);
    const nearlyAnHour = await waiting(RECONCILE_MAX_AGE_MINUTES * 60 - 30);
    const tooOld = await waiting(RECONCILE_MAX_AGE_MINUTES * 60 + 30);
    const provider = answering('PENDING');

    await reconcilePendingPayments({ prisma, provider, log: sink.log });

    expect(provider.lookedUp).toEqual([nearlyAnHour.payment.ourRef, halfHour.payment.ourRef, justOldEnough.payment.ourRef]);
    expect(provider.lookedUp).not.toContain(tooNew.payment.ourRef);
    expect(provider.lookedUp).not.toContain(tooOld.payment.ourRef);
  });

  it('with the sandbox minimum age, a payment a few seconds old', async () => {
    const tooNew = await waiting(1);
    const oldEnough = await waiting(10);
    const provider = answering('SUCCESSFUL');

    const settled = await reconcilePendingPayments({ prisma, provider, log: sink.log, minAgeSeconds: SANDBOX_RECONCILE_MIN_AGE_SECONDS });

    expect(settled).toBe(1);
    expect(provider.lookedUp).toEqual([oldEnough.payment.ourRef]);
    expect(await statusOf('booking', tooNew.booking.id)).not.toBe('confirmed');
    expect(await statusOf('booking', oldEnough.booking.id)).toBe('confirmed');
  });

  it.each(['initiated', 'succeeded', 'failed', 'refund_due', 'refunded'])('never a %s payment', async (status) => {
    await waiting(10 * 60, status);
    const provider = answering('SUCCESSFUL');

    await expect(reconcilePendingPayments({ prisma, provider, log: sink.log })).resolves.toBe(0);
    expect(provider.lookedUp).toEqual([]);
  });

  it('never another provider’s payment', async () => {
    await waiting(10 * 60, 'pending', 'flutterwave');
    const provider = answering('SUCCESSFUL');

    await reconcilePendingPayments({ prisma, provider, log: sink.log });

    expect(provider.lookedUp).toEqual([]);
  });

  it('at most twenty per run', async () => {
    for (let i = 0; i < 23; i += 1) await waiting(5 * 60 + i);
    const provider = answering('PENDING');

    await reconcilePendingPayments({ prisma, provider, log: sink.log });

    expect(provider.lookedUp).toHaveLength(20);
  });
});

describe('what the answer does', () => {
  it('confirms the booking on a settled success, stored as a verified event of the lookup, and counts it', async () => {
    const { booking, payment } = await waiting(5 * 60);

    const settled = await reconcilePendingPayments({ prisma, provider: answering('SUCCESSFUL'), log: sink.log });

    expect(settled).toBe(1);
    expect(await statusOf('booking', booking.id)).toBe('confirmed');
    expect(await statusOf('payment', payment.id)).toBe('succeeded');
    expect(await eventRows()).toMatchObject([
      {
        event_id: `${payment.ourRef}:SUCCESSFUL`,
        event_type: 'requesttopay_status.SUCCESSFUL',
        signature_valid: true,
        status: 'applied',
        payload: { externalId: payment.ourRef, status: 'SUCCESSFUL' },
      },
    ]);
    const outbox = await raw.query<{ template: string }>('SELECT template FROM outbox ORDER BY template');
    expect(outbox.rows.map((row) => row.template)).toEqual(['admin_new_booking', 'booking_confirmation']);
  });

  it('fails the payment on a settled failure, leaving the booking waiting', async () => {
    const { booking, payment } = await waiting(5 * 60);

    await expect(reconcilePendingPayments({ prisma, provider: answering('FAILED'), log: sink.log })).resolves.toBe(1);

    expect(await statusOf('payment', payment.id)).toBe('failed');
    expect(await statusOf('booking', booking.id)).toBe('pending_payment');
  });

  it.each([
    ['still pending', () => 'PENDING'],
    ['unknown to MTN', () => null],
    ['in a status we cannot read', () => 'AUTHORIZED'],
  ])('records nothing when the payment is %s', async (_case, answer) => {
    const { booking, payment } = await waiting(5 * 60);

    await expect(reconcilePendingPayments({ prisma, provider: answering(answer), log: sink.log })).resolves.toBe(0);

    expect(await eventRows()).toEqual([]);
    expect(await statusOf('payment', payment.id)).toBe('pending');
    expect(await statusOf('booking', booking.id)).toBe('pending_payment');
  });

  it('logs a failed lookup and carries on with the others', async () => {
    const first = await waiting(10 * 60);
    const second = await waiting(9 * 60);
    const third = await waiting(8 * 60);
    const provider = stubProvider({
      lookupStatus: async (ourRef) => {
        if (ourRef === second.payment.ourRef) throw new Error('MTN MoMo answered 503');
        const payload = mtnStatusBody(ourRef, 'SUCCESSFUL');
        return { event: readEvent(ourRef, payload, 'requesttopay_status') ?? (null as never), payload };
      },
    });

    await expect(reconcilePendingPayments({ prisma, provider, log: sink.log })).resolves.toBe(2);

    expect(provider.lookedUp).toEqual([first.payment.ourRef, second.payment.ourRef, third.payment.ourRef]);
    expect(await statusOf('booking', first.booking.id)).toBe('confirmed');
    expect(await statusOf('booking', second.booking.id)).toBe('pending_payment');
    expect(await statusOf('booking', third.booking.id)).toBe('confirmed');
    expect(sink.entries).toContainEqual({
      level: 'warn',
      event: 'payment_lookup_failed',
      provider: 'mtn_momo_direct',
      ourRef: second.payment.ourRef,
      message: 'MTN MoMo answered 503',
    });
  });

  it('does not count a settled answer the rules ignore', async () => {
    const { payment } = await waiting(5 * 60);
    const stub = stubProvider({
      lookupStatus: async (ourRef) => {
        const payload = mtnStatusBody(ourRef, 'SUCCESSFUL', { amount: '1' });
        return { event: readEvent(ourRef, payload, 'requesttopay_status') ?? (null as never), payload };
      },
    });

    await expect(reconcilePendingPayments({ prisma, provider: stub, log: sink.log })).resolves.toBe(0);
    expect(await statusOf('payment', payment.id)).toBe('pending');
    expect((await eventRows())[0]).toMatchObject({ status: 'ignored', processing_error: 'amount_mismatch' });
  });
});

describe('a lookup and a callback for the same outcome', () => {
  it('apply once: the callback after the lookup is a duplicate', async () => {
    const { booking, payment } = await waiting(5 * 60);
    const mtn = mtnProvider({
      fetch: (async (input: string) =>
        String(input).endsWith('/collection/token/')
          ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))
          : new Response(JSON.stringify(mtnStatusBody(payment.ourRef, 'SUCCESSFUL')), { status: 200 })) as typeof fetch,
    });

    await expect(reconcilePendingPayments({ prisma, provider: mtn, log: sink.log })).resolves.toBe(1);
    const callback = await receiveWebhook({ prisma, log: sink.log }, mtn, mtnDelivery(mtn, payment.ourRef, mtnStatusBody(payment.ourRef, 'SUCCESSFUL')));

    expect(callback).toMatchObject({ status: 'ignored', note: 'duplicate_delivery' });
    expect(await statusOf('booking', booking.id)).toBe('confirmed');
    const outbox = await raw.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox WHERE template = 'booking_confirmation'`);
    expect(outbox.rows[0]?.n).toBe('1');
  });

  it('apply once: a payment the callback already settled is no longer looked up', async () => {
    const { payment } = await waiting(5 * 60);
    const mtn = mtnProvider();
    await receiveWebhook({ prisma, log: sink.log }, mtn, mtnDelivery(mtn, payment.ourRef, mtnStatusBody(payment.ourRef, 'SUCCESSFUL')));
    const provider = answering('SUCCESSFUL');

    await expect(reconcilePendingPayments({ prisma, provider, log: sink.log })).resolves.toBe(0);
    expect(provider.lookedUp).toEqual([]);
  });
});
