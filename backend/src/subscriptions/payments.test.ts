import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { PAYMENT_ATTEMPT_WINDOW_SECONDS } from '../payments/initiate.js';
import type { ProviderEvent } from '../payments/provider.js';
import { reconcilePendingPayments } from '../payments/reconcile.js';
import { recordRefund } from '../payments/refund.js';
import { recordEvent } from '../payments/webhooks.js';
import { isBookable } from '../photographers/bookable.js';
import { approvePhotographer } from '../photographers/moderation.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type PaymentWorld, createPhotographer, delay, logSink, seedWorld, stubProvider } from '../test/payment-fixtures.js';
import { startSubscriptionPayment } from './payments.js';
import { DAY_MS, addPlanInterval } from './plan.js';

/**
 * Paying for the subscription (marketplace-spec.md R5.2, R5.3, T5.2, T5.3) and
 * the user's Phase 5 decision on double payments: every succeeded subscription
 * payment adds its period on top -- late, duplicate and revived ones included --
 * none is ever refunded, and none creates a payout item. Against real
 * PostgreSQL: the one-in-progress rule is a row lock, and the periods' overlap
 * rule an exclusion constraint.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let adminId: string;

/** Day 0: the approval that starts the trial (T5.1, T5.2). */
const T0 = new Date('2026-10-01T06:00:00.000Z');
const day = (n: number) => new Date(T0.getTime() + n * DAY_MS);
const TRIAL_END = day(30);

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
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await truncateAll(raw);
  world = await seedWorld(prisma);
  adminId = (await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } })).id;
});

// --- Fixtures -----------------------------------------------------------------------

/** A photographer approved through moderation at day 0: a 30-day trial ending at day 30 (R5.1). */
async function approvedAtDayZero(handle = 'new-studio'): Promise<{ photographerId: string; subscriptionId: string }> {
  const { photographerId } = await createPhotographer(prisma, { email: `${handle}@bookly.example`, handle, displayName: 'New Studio', status: 'pending' });
  await approvePhotographer({ prisma, now: () => T0, log: () => undefined }, { photographerId, adminUserId: adminId });
  const subscription = await prisma.subscription.findUniqueOrThrow({ where: { photographerId } });
  return { photographerId, subscriptionId: subscription.id };
}

function start(photographerId: string, options: { planInterval?: 'monthly' | 'yearly'; provider?: ReturnType<typeof stubProvider>; timeoutMs?: number } = {}) {
  return startSubscriptionPayment(
    { prisma, provider: options.provider ?? stubProvider(), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) },
    { photographerId, planInterval: options.planInterval ?? 'monthly', method: 'momo_mtn', payerPhone: '+250788123456' },
  );
}

/** A subscription payment written directly, in whatever state a test needs. */
async function insertSubscriptionPayment(
  subscriptionId: string,
  { plan = 'monthly', amount = 10_000, status = 'pending', failureReason = null as string | null, ageSeconds = 0 } = {},
): Promise<{ id: string; ourRef: string }> {
  const rows = await prisma.$queryRaw<{ id: string; our_ref: string }[]>`
    INSERT INTO payment (subscription_id, kind, provider, method, amount_rwf, plan_interval, status, failure_reason, initiated_at)
    VALUES (${subscriptionId}::uuid, 'subscription', 'mtn_momo_direct', 'momo_mtn', ${amount}, ${plan}, ${status}, ${failureReason},
            now() - make_interval(secs => ${ageSeconds}::double precision))
    RETURNING id::text AS id, our_ref::text AS our_ref`;
  const row = rows[0];
  if (row === undefined) throw new Error('no payment row');
  return { id: row.id, ourRef: row.our_ref };
}

function event(ourRef: string, overrides: Partial<ProviderEvent> = {}): ProviderEvent {
  return {
    eventId: randomUUID(),
    eventType: 'test',
    ourRef,
    providerRef: null,
    reportedStatus: 'succeeded',
    method: 'momo_mtn',
    failureReason: null,
    amount: null,
    currency: null,
    ...overrides,
  };
}

function deliver(e: ProviderEvent, at: Date, log = logSink().log) {
  return recordEvent({ prisma, now: () => at, log }, 'mtn_momo_direct', { signatureValid: true, event: e, payload: { test: true }, expectedCurrency: 'EUR' });
}

const settle = (ourRef: string, at: Date, overrides: Partial<ProviderEvent> = {}) => deliver(event(ourRef, overrides), at);

function subscription(id: string) {
  return prisma.subscription.findUniqueOrThrow({ where: { id }, include: { periods: { orderBy: { startsAt: 'asc' } }, photographer: true } });
}

// --- Starting a payment (R5.2, T5.3) ------------------------------------------------

describe('startSubscriptionPayment', () => {
  it.each([
    ['monthly', 10_000],
    ['yearly', 100_000],
  ] as const)("charges the platform's %s price, frozen on a subscription payment, and prompts the payer", async (planInterval, price) => {
    const { photographerId, subscriptionId } = await approvedAtDayZero();
    const provider = stubProvider();

    const result = await start(photographerId, { planInterval, provider });

    expect(result).toMatchObject({ status: 'started', amountRwf: price, planInterval });
    const ourRef = result.status === 'started' ? result.ourRef : '';
    await expect(prisma.payment.findUniqueOrThrow({ where: { ourRef } })).resolves.toMatchObject({
      kind: 'subscription',
      subscriptionId,
      bookingId: null,
      planInterval,
      amountRwf: price,
      provider: 'mtn_momo_direct',
      method: 'momo_mtn',
      status: 'pending',
    });
    expect(provider.initiated).toEqual([
      { ourRef, amountRwf: price, method: 'momo_mtn', payerPhone: '+250788123456', kind: 'subscription', bookingReference: 'SUB-new-studio' },
    ]);
  });

  it('reads the price when the payment opens: a later price change leaves a started payment as it was', async () => {
    const { photographerId } = await approvedAtDayZero();
    const first = await start(photographerId);
    await prisma.platformSetting.update({ where: { id: 1 }, data: { subscriptionMonthlyPriceRwf: 12_500 } });
    await prisma.payment.updateMany({ data: { status: 'failed', failureReason: 'declined' } });

    const second = await start(photographerId);

    expect(first).toMatchObject({ amountRwf: 10_000 });
    expect(second).toMatchObject({ amountRwf: 12_500 });
    await expect(prisma.payment.findMany({ orderBy: { initiatedAt: 'asc' }, select: { amountRwf: true } })).resolves.toEqual([{ amountRwf: 10_000 }, { amountRwf: 12_500 }]);
  });

  it.each(['pending', 'suspended'] as const)('refuses a %s photographer: no row, no prompt', async (status) => {
    const { photographerId } = await approvedAtDayZero();
    await prisma.photographer.update({ where: { id: photographerId }, data: { status, ...(status === 'suspended' ? { suspendedAt: T0 } : {}) } });
    const provider = stubProvider();

    await expect(start(photographerId, { provider })).resolves.toEqual({ status: 'photographer_not_approved' });
    await expect(prisma.payment.count()).resolves.toBe(0);
    expect(provider.initiated).toEqual([]);
  });

  it('answers no_subscription for an approved photographer without one, and an unknown id as not approved', async () => {
    const { photographerId } = await createPhotographer(prisma, { email: 'bare@bookly.example', handle: 'bare-one', displayName: 'Bare', status: 'pending' });
    await prisma.photographer.update({ where: { id: photographerId }, data: { status: 'approved', approvedAt: T0 } });

    await expect(start(photographerId)).resolves.toEqual({ status: 'no_subscription' });
    await expect(start('00000000-0000-4000-8000-000000000000')).resolves.toEqual({ status: 'photographer_not_approved' });
    await expect(prisma.payment.count()).resolves.toBe(0);
  });

  it.each(['past_due', 'expired'] as const)('lets a %s subscription pay: paying is the way back', async (status) => {
    const { photographerId, subscriptionId } = await approvedAtDayZero();
    await prisma.subscription.update({ where: { id: subscriptionId }, data: { status } });

    await expect(start(photographerId)).resolves.toMatchObject({ status: 'started' });
  });

  it('answers in_progress with the waiting payment while one is pending or still being called, and prompts nobody twice', async () => {
    const { photographerId, subscriptionId } = await approvedAtDayZero();
    const pending = await insertSubscriptionPayment(subscriptionId, { status: 'pending' });
    const provider = stubProvider();

    await expect(start(photographerId, { provider, planInterval: 'yearly' })).resolves.toEqual({ status: 'in_progress', ourRef: pending.ourRef });
    await prisma.payment.update({ where: { id: pending.id }, data: { status: 'initiated' } });
    await expect(start(photographerId, { provider })).resolves.toEqual({ status: 'in_progress', ourRef: pending.ourRef });
    expect(provider.initiated).toEqual([]);
    await expect(prisma.payment.count()).resolves.toBe(1);
  });

  it('lets a new payment open once the waiting one is past the attempt window, or settled', async () => {
    const { photographerId, subscriptionId } = await approvedAtDayZero();
    await insertSubscriptionPayment(subscriptionId, { status: 'pending', ageSeconds: PAYMENT_ATTEMPT_WINDOW_SECONDS + 5 });
    await insertSubscriptionPayment(subscriptionId, { status: 'failed', failureReason: 'declined' });
    await insertSubscriptionPayment(subscriptionId, { status: 'succeeded' });

    await expect(start(photographerId)).resolves.toMatchObject({ status: 'started' });
    await expect(prisma.payment.count()).resolves.toBe(4);
  });

  it("is not blocked by another photographer's payment in progress", async () => {
    const mine = await approvedAtDayZero('mine-one');
    const theirs = await approvedAtDayZero('theirs-one');
    await insertSubscriptionPayment(theirs.subscriptionId, { status: 'pending' });

    await expect(start(mine.photographerId)).resolves.toMatchObject({ status: 'started' });
  });

  it('makes exactly one payment of several started at once, and prompts once (T5.3)', async () => {
    const { photographerId } = await approvedAtDayZero();
    // A slow provider: the first call is still out when the others arrive.
    const provider = stubProvider({ initiate: async () => (await delay(150), { outcome: 'accepted', providerRef: null }) });

    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => start(photographerId, { provider, planInterval: i % 2 === 0 ? 'monthly' : 'yearly' })));

    const started = results.filter((result) => result.status === 'started');
    expect(started).toHaveLength(1);
    const ourRef = started[0]?.status === 'started' ? started[0].ourRef : '';
    expect(results.filter((result) => result.status === 'in_progress')).toEqual(Array.from({ length: 5 }, () => ({ status: 'in_progress', ourRef })));
    await expect(prisma.payment.count()).resolves.toBe(1);
    expect(provider.initiated).toHaveLength(1);
  });

  it('records a refusal as failed, with the reason, and frees the subscription to try again', async () => {
    const { photographerId } = await approvedAtDayZero();
    const refusing = stubProvider({ initiate: async () => ({ outcome: 'rejected', reason: 'PAYER_NOT_FOUND' }) });

    const result = await start(photographerId, { provider: refusing });

    expect(result).toMatchObject({ status: 'provider_failed', outcome: 'rejected', amountRwf: 10_000, planInterval: 'monthly' });
    await expect(prisma.payment.findFirstOrThrow()).resolves.toMatchObject({ status: 'failed', failureReason: 'PAYER_NOT_FOUND' });
    await expect(start(photographerId)).resolves.toMatchObject({ status: 'started' });
  });

  it('records an unreachable or silent provider as ours to revive later: provider_unavailable, provider_timeout', async () => {
    const { photographerId } = await approvedAtDayZero();
    const broken = stubProvider({ initiate: async () => Promise.reject(new Error('socket hang up')) });
    await expect(start(photographerId, { provider: broken })).resolves.toMatchObject({ status: 'provider_failed', outcome: 'unavailable' });

    const silent = stubProvider({ initiate: () => new Promise(() => undefined) });
    await expect(start(photographerId, { provider: silent, timeoutMs: 50 })).resolves.toMatchObject({ status: 'provider_failed', outcome: 'unavailable' });

    const reasons = (await prisma.payment.findMany({ orderBy: { initiatedAt: 'asc' } })).map((row) => row.failureReason);
    expect(reasons).toEqual(['provider_unavailable: Error', 'provider_timeout']);
  });
});

// --- Settling a payment (R5.3, T5.2) ------------------------------------------------

describe('a succeeded subscription payment', () => {
  it('paid on day 25 of the trial adds its month on top: it ends at day 30 plus one month (T5.2)', async () => {
    const { photographerId, subscriptionId } = await approvedAtDayZero();
    const started = await start(photographerId);
    const ourRef = started.status === 'started' ? started.ourRef : '';
    const sink = logSink();

    const outcome = await deliver(event(ourRef, { providerRef: 'MTN-777' }), day(25), sink.log);

    expect(outcome).toMatchObject({ status: 'applied', note: 'subscription_period_added' });
    const expectedEnd = addPlanInterval(TRIAL_END, 'monthly');
    expect(expectedEnd.toISOString()).toBe('2026-11-30T06:00:00.000Z');
    const after = await subscription(subscriptionId);
    expect(after).toMatchObject({ status: 'active', currentPeriodEndsAt: expectedEnd });
    expect(after.periods.map((period) => [period.kind, period.planInterval, period.priceRwf, period.startsAt, period.endsAt])).toEqual([
      ['trial', null, 0, T0, TRIAL_END],
      ['paid', 'monthly', 10_000, TRIAL_END, expectedEnd],
    ]);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { ourRef } });
    expect(payment).toMatchObject({ status: 'succeeded', settledAt: day(25), providerRef: 'MTN-777' });
    expect(after.periods[1]?.paymentId).toBe(payment.id);
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'subscription_period_added', paymentId: payment.id, endsAt: expectedEnd.toISOString() }));
  });

  it('queues the receipt to the photographer once, filed under their studio, and creates no payout item', async () => {
    const { photographerId, subscriptionId } = await approvedAtDayZero();
    const { id, ourRef } = await insertSubscriptionPayment(subscriptionId, { plan: 'yearly', amount: 100_000 });

    await settle(ourRef, day(25));

    const receipts = await prisma.outbox.findMany({ where: { template: 'subscription_receipt' } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      recipient: 'new-studio@bookly.example',
      photographerId,
      bookingId: null,
      dedupeKey: `email:subscription_receipt:${id}`,
      payload: {
        displayName: 'New Studio',
        planInterval: 'yearly',
        amountRwf: 100_000,
        paidAt: day(25).toISOString(),
        paymentReference: ourRef,
        periodStartsAt: TRIAL_END.toISOString(),
        periodEndsAt: addPlanInterval(TRIAL_END, 'yearly').toISOString(),
      },
    });
    await expect(prisma.payoutItem.count()).resolves.toBe(0);
  });

  it.each([
    ['past_due', 32],
    ['expired', 40],
  ] as const)('paid while %s (day %d) starts now, not at the old end, and is bookable at once', async (status, paidOn) => {
    const { subscriptionId } = await approvedAtDayZero();
    await prisma.subscription.update({ where: { id: subscriptionId }, data: { status } });
    const { ourRef } = await insertSubscriptionPayment(subscriptionId);

    await settle(ourRef, day(paidOn));

    const after = await subscription(subscriptionId);
    const end = addPlanInterval(day(paidOn), 'monthly');
    expect(after).toMatchObject({ status: 'active', currentPeriodEndsAt: end });
    expect(after.periods.at(-1)).toMatchObject({ startsAt: day(paidOn), endsAt: end });
    expect(isBookable(after.photographer, after, day(paidOn))).toBe(true);
  });

  it('stacks a second success on top of the first, and refunds neither (the double-payment decision)', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    const first = await insertSubscriptionPayment(subscriptionId);
    const second = await insertSubscriptionPayment(subscriptionId, { plan: 'yearly', amount: 100_000 });

    await settle(first.ourRef, day(25));
    await settle(second.ourRef, day(26));

    const monthEnd = addPlanInterval(TRIAL_END, 'monthly');
    const yearEnd = addPlanInterval(monthEnd, 'yearly');
    const after = await subscription(subscriptionId);
    expect(after.currentPeriodEndsAt).toEqual(yearEnd);
    expect(after.periods.map((period) => [period.startsAt, period.endsAt])).toEqual([
      [T0, TRIAL_END],
      [TRIAL_END, monthEnd],
      [monthEnd, yearEnd],
    ]);
    await expect(prisma.payment.findMany({ select: { status: true } })).resolves.toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
    await expect(prisma.outbox.count({ where: { template: 'subscription_receipt' } })).resolves.toBe(2);
    await expect(prisma.outbox.count({ where: { template: 'photographer_alert' } })).resolves.toBe(0);
    await expect(prisma.payoutItem.count()).resolves.toBe(0);
  });

  it('adds the period of a success arriving long after its attempt window, a payment nobody waits on any more', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    const stale = await insertSubscriptionPayment(subscriptionId, { ageSeconds: 50 * 60 });

    await expect(settle(stale.ourRef, day(10))).resolves.toMatchObject({ status: 'applied', note: 'subscription_period_added' });
    await expect(subscription(subscriptionId)).resolves.toMatchObject({ currentPeriodEndsAt: addPlanInterval(TRIAL_END, 'monthly') });
  });

  it('is idempotent: the same delivery twice, or another success for the same payment, adds one period', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    const { ourRef } = await insertSubscriptionPayment(subscriptionId);
    const success = event(ourRef);

    await deliver(success, day(25));
    await expect(deliver(success, day(26))).resolves.toMatchObject({ status: 'ignored', note: 'duplicate_delivery' });
    await expect(settle(ourRef, day(27))).resolves.toMatchObject({ status: 'ignored', note: 'payment_succeeded' });

    const after = await subscription(subscriptionId);
    expect(after.periods).toHaveLength(2);
    expect(after.currentPeriodEndsAt).toEqual(addPlanInterval(TRIAL_END, 'monthly'));
    await expect(prisma.outbox.count({ where: { template: 'subscription_receipt' } })).resolves.toBe(1);
  });

  it('matches by the provider reference when the event names no reference of ours', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    const { id } = await insertSubscriptionPayment(subscriptionId);
    await prisma.payment.update({ where: { id }, data: { providerRef: 'MTN-REF-1' } });

    await expect(deliver(event('not-a-uuid', { ourRef: null, providerRef: 'MTN-REF-1' }), day(25))).resolves.toMatchObject({ status: 'applied' });
    await expect(prisma.subscriptionPeriod.count({ where: { paymentId: id } })).resolves.toBe(1);
  });

  it.each([
    [{ amount: 9_999 }, 'amount_mismatch'],
    [{ currency: 'RWF' }, 'currency_mismatch'],
  ])('ignores a success with %o, adding nothing (T3.3)', async (overrides, note) => {
    const { subscriptionId } = await approvedAtDayZero();
    const { ourRef } = await insertSubscriptionPayment(subscriptionId);

    await expect(settle(ourRef, day(25), overrides)).resolves.toMatchObject({ status: 'ignored', note });

    await expect(prisma.payment.findUniqueOrThrow({ where: { ourRef } })).resolves.toMatchObject({ status: 'pending' });
    await expect(subscription(subscriptionId)).resolves.toMatchObject({ status: 'trialing', currentPeriodEndsAt: TRIAL_END });
    await expect(prisma.outbox.count({ where: { template: 'subscription_receipt' } })).resolves.toBe(0);
  });

  it('accepts a success stating the amount charged and no currency', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    const { ourRef } = await insertSubscriptionPayment(subscriptionId);
    await expect(settle(ourRef, day(25), { amount: 10_000, currency: 'EUR' })).resolves.toMatchObject({ status: 'applied' });
  });

  it('records a failure as failed, adding nothing; a later success after that verdict is not revived', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    const { ourRef } = await insertSubscriptionPayment(subscriptionId);
    const sink = logSink();

    await expect(settle(ourRef, day(25), { reportedStatus: 'failed', failureReason: 'LOW_BALANCE' })).resolves.toMatchObject({ status: 'applied', note: 'payment_failed' });
    await expect(deliver(event(ourRef), day(26), sink.log)).resolves.toMatchObject({ status: 'ignored', note: 'payment_failed' });

    await expect(prisma.subscriptionPeriod.count({ where: { kind: 'paid' } })).resolves.toBe(0);
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'webhook_success_for_failed_payment' }));
  });

  it.each(['provider_timeout', 'provider_unavailable: Error'])('revives an attempt we failed ourselves (%s) when the provider reports it paid, and adds its period (Phase 4 revive rule)', async (reason) => {
    const { subscriptionId } = await approvedAtDayZero();
    const { ourRef } = await insertSubscriptionPayment(subscriptionId, { status: 'failed', failureReason: reason });
    const sink = logSink();

    await expect(deliver(event(ourRef), day(25), sink.log)).resolves.toMatchObject({ status: 'applied', note: 'subscription_period_added_revived' });

    await expect(prisma.payment.findUniqueOrThrow({ where: { ourRef } })).resolves.toMatchObject({ status: 'succeeded', failureReason: reason });
    await expect(subscription(subscriptionId)).resolves.toMatchObject({ status: 'active', currentPeriodEndsAt: addPlanInterval(TRIAL_END, 'monthly') });
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'webhook_success_for_locally_failed_payment', failureReason: reason }));
    await expect(prisma.payoutItem.count()).resolves.toBe(0);
  });

  it('never revives a refusal the provider answered at initiation', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    const { ourRef } = await insertSubscriptionPayment(subscriptionId, { status: 'failed', failureReason: 'PAYER_NOT_FOUND' });

    await expect(settle(ourRef, day(25))).resolves.toMatchObject({ status: 'ignored', note: 'payment_failed' });
    await expect(prisma.subscriptionPeriod.count({ where: { kind: 'paid' } })).resolves.toBe(0);
  });

  it('settles through the reconciler when the callback never came, exactly as a webhook would (R3.5)', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    const { ourRef } = await insertSubscriptionPayment(subscriptionId, { ageSeconds: 120 });
    const provider = stubProvider({ lookupStatus: async (ref) => ({ event: event(ref, { eventId: `lookup:${ref}` }), payload: { status: 'SUCCESSFUL' } }) });

    await expect(reconcilePendingPayments({ prisma, provider, now: () => day(25), log: () => undefined })).resolves.toBe(1);

    expect(provider.lookedUp).toEqual([ourRef]);
    await expect(subscription(subscriptionId)).resolves.toMatchObject({ status: 'active', currentPeriodEndsAt: addPlanInterval(TRIAL_END, 'monthly') });
  });

  it('settles two subscriptions paid at once without either waiting on the other', async () => {
    const a = await approvedAtDayZero('studio-one');
    const b = await approvedAtDayZero('studio-two');
    const pa = await insertSubscriptionPayment(a.subscriptionId);
    const pb = await insertSubscriptionPayment(b.subscriptionId);

    const outcomes = await Promise.all([settle(pa.ourRef, day(25)), settle(pb.ourRef, day(25))]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'applied']);
  });

  it('serialises two successes of one subscription on its row: both periods stack, none overlaps', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    const payments = await Promise.all([insertSubscriptionPayment(subscriptionId), insertSubscriptionPayment(subscriptionId), insertSubscriptionPayment(subscriptionId)]);

    const outcomes = await Promise.all(payments.map((payment) => settle(payment.ourRef, day(25))));

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'applied', 'applied']);
    const after = await subscription(subscriptionId);
    const ends = [addPlanInterval(TRIAL_END, 'monthly')];
    ends.push(addPlanInterval(ends[0]!, 'monthly'), addPlanInterval(addPlanInterval(ends[0]!, 'monthly'), 'monthly'));
    expect(after.periods.slice(1).map((period) => period.endsAt)).toEqual(ends);
    expect(after.currentPeriodEndsAt).toEqual(ends[2]);
  });

  it('is never refundable by the platform: nothing is pending on it', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    const { id, ourRef } = await insertSubscriptionPayment(subscriptionId);
    await settle(ourRef, day(25));

    await expect(recordRefund({ prisma, now: () => day(26), actor: { area: 'platform', userId: adminId } }, id, { reference: 'REF-1' })).resolves.toEqual({
      status: 'not_refundable',
    });
    await expect(
      recordRefund({ prisma, now: () => day(26), actor: { area: 'studio', photographerId: world.photographerId, userId: world.photographerUserId } }, id, { reference: 'REF-2' }),
    ).resolves.toEqual({ status: 'not_found' });
  });
});
