import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { recordEvent } from '../payments/webhooks.js';
import { isBookable, listedPhotographerWhere } from '../photographers/bookable.js';
import { approvePhotographer } from '../photographers/moderation.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { createPhotographer, logSink, seedWorld } from '../test/payment-fixtures.js';
import { runSubscriptionJob } from './job.js';
import { DAY_MS, addPlanInterval } from './plan.js';

/**
 * The subscription job with an injected clock (marketplace-spec.md R5.4, T5.1):
 * reminders at days 23, 27 and 29 of a 30-day trial, `past_due` at day 30,
 * `expired` at day 37 -- each checked, each email sent once however often or
 * late the job runs -- and bookability that never waited for it.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let adminId: string;

const T0 = new Date('2026-10-01T06:00:00.000Z');
const day = (n: number) => new Date(T0.getTime() + n * DAY_MS);
const MINUTE = 60_000;

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
  // The world's own photographer runs to 2100: the job never touches it.
  await seedWorld(prisma);
  adminId = (await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } })).id;
});

async function approvedAtDayZero(handle = 'new-studio'): Promise<{ photographerId: string; subscriptionId: string }> {
  // Submitted for review: approval requires it (Phase 7).
  const { photographerId } = await createPhotographer(prisma, { email: `${handle}@bookly.example`, handle, displayName: 'New Studio', status: 'pending', submittedAt: T0 });
  await approvePhotographer({ prisma, now: () => T0, log: () => undefined }, { photographerId, adminUserId: adminId });
  const subscription = await prisma.subscription.findUniqueOrThrow({ where: { photographerId } });
  return { photographerId, subscriptionId: subscription.id };
}

const run = (at: Date, log = logSink().log) => runSubscriptionJob({ prisma, now: () => at, log });

async function state(subscriptionId: string, at: Date) {
  const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, include: { photographer: true } });
  const listed = await prisma.photographer.count({ where: { id: row.photographerId, ...listedPhotographerWhere(at, 7) } });
  return { status: row.status, bookable: isBookable(row.photographer, row, at), listed: listed === 1 };
}

function mail(template: 'subscription_reminder' | 'subscription_expired') {
  return prisma.outbox.findMany({ where: { template }, orderBy: { createdAt: 'asc' } });
}

describe('the trial, day by day (T5.1)', () => {
  it('trialing at day 0; reminders at days 23, 27 and 29; past_due at day 30; expired at day 37', async () => {
    const { photographerId, subscriptionId } = await approvedAtDayZero();
    const trialEnd = day(30);

    // Day 0: trialing, bookable, listed, nothing to send.
    await expect(run(day(0))).resolves.toEqual({ expired: 0, pastDue: 0, reminders: 0 });
    await expect(state(subscriptionId, day(0))).resolves.toEqual({ status: 'trialing', bookable: true, listed: true });

    // A minute before day 23: still nothing.
    await expect(run(new Date(day(23).getTime() - MINUTE))).resolves.toMatchObject({ reminders: 0 });

    const reminders: [number, number][] = [
      [23, 7],
      [27, 3],
      [29, 1],
    ];
    for (const [n, days] of reminders) {
      await expect(run(day(n)), `day ${n}`).resolves.toEqual({ expired: 0, pastDue: 0, reminders: 1 });
      // Every run until the next reminder is due sends nothing more.
      await expect(run(new Date(day(n).getTime() + 10 * MINUTE)), `day ${n} again`).resolves.toMatchObject({ reminders: 0 });
      await expect(state(subscriptionId, day(n))).resolves.toEqual({ status: 'trialing', bookable: true, listed: true });
      const sent = await mail('subscription_reminder');
      expect(sent.at(-1)).toMatchObject({
        recipient: 'new-studio@bookly.example',
        photographerId,
        bookingId: null,
        dedupeKey: `email:subscription_reminder:${subscriptionId}:${trialEnd.toISOString()}:${days}`,
        payload: { variant: 'ending', displayName: 'New Studio', periodKind: 'trial', periodEndsAt: trialEnd.toISOString(), daysLeft: days },
      });
    }
    await expect(mail('subscription_reminder')).resolves.toHaveLength(3);

    // Day 30: past_due -- listed, not bookable -- and the notice, once.
    await expect(run(day(30))).resolves.toEqual({ expired: 0, pastDue: 1, reminders: 0 });
    await expect(run(day(31))).resolves.toEqual({ expired: 0, pastDue: 0, reminders: 0 });
    await expect(state(subscriptionId, day(30))).resolves.toEqual({ status: 'past_due', bookable: false, listed: true });
    const notices = await mail('subscription_reminder');
    expect(notices).toHaveLength(4);
    expect(notices.at(-1)).toMatchObject({
      dedupeKey: `email:subscription_reminder:${subscriptionId}:${trialEnd.toISOString()}:past_due`,
      payload: { variant: 'past_due', periodEndedAt: trialEnd.toISOString(), graceEndsAt: day(37).toISOString() },
    });

    // A minute before day 37: still past_due.
    await expect(run(new Date(day(37).getTime() - MINUTE))).resolves.toMatchObject({ expired: 0 });
    await expect(state(subscriptionId, new Date(day(37).getTime() - MINUTE))).resolves.toEqual({ status: 'past_due', bookable: false, listed: true });

    // Day 37: expired -- hidden -- and the email, once.
    await expect(run(day(37))).resolves.toEqual({ expired: 1, pastDue: 0, reminders: 0 });
    await expect(run(day(40))).resolves.toEqual({ expired: 0, pastDue: 0, reminders: 0 });
    await expect(state(subscriptionId, day(37))).resolves.toEqual({ status: 'expired', bookable: false, listed: false });
    const expired = await mail('subscription_expired');
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      recipient: 'new-studio@bookly.example',
      photographerId,
      dedupeKey: `email:subscription_expired:${subscriptionId}:${trialEnd.toISOString()}`,
      payload: { displayName: 'New Studio', periodEndedAt: trialEnd.toISOString() },
    });
  });

  it('decides bookability and listing from the clock even when the job never ran (R5.4)', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    // No run at all: the stored status still says trialing.
    await expect(state(subscriptionId, new Date(day(30).getTime() - 1))).resolves.toEqual({ status: 'trialing', bookable: true, listed: true });
    await expect(state(subscriptionId, day(30))).resolves.toEqual({ status: 'trialing', bookable: false, listed: true });
    await expect(state(subscriptionId, day(37))).resolves.toEqual({ status: 'trialing', bookable: false, listed: false });
  });
});

describe('a late or repeated run', () => {
  it('sends only the most urgent reminder it has reached, never the ones it passed', async () => {
    const { subscriptionId } = await approvedAtDayZero();

    // First run on day 28: the 3-day reminder, with 2 days really left; the 7-day one is skipped.
    await expect(run(day(28))).resolves.toMatchObject({ reminders: 1 });
    await expect(run(day(28.5))).resolves.toMatchObject({ reminders: 0 });
    const sent = await mail('subscription_reminder');
    expect(sent.map((row) => row.dedupeKey)).toEqual([`email:subscription_reminder:${subscriptionId}:${day(30).toISOString()}:3`]);
    expect(sent[0]?.payload).toMatchObject({ daysLeft: 2 });
  });

  it('moves a lapsed subscription straight to expired, without a stale past-due notice', async () => {
    const { subscriptionId } = await approvedAtDayZero();

    await expect(run(day(45))).resolves.toEqual({ expired: 1, pastDue: 0, reminders: 0 });

    await expect(state(subscriptionId, day(45))).resolves.toMatchObject({ status: 'expired' });
    await expect(mail('subscription_reminder')).resolves.toEqual([]);
    await expect(mail('subscription_expired')).resolves.toHaveLength(1);
  });

  it('sends nothing twice when two runs overlap', async () => {
    await approvedAtDayZero();

    const results = await Promise.all([run(day(30)), run(day(30)), run(day(30))]);

    expect(results.reduce((total, result) => total + result.pastDue, 0)).toBe(1);
    await expect(mail('subscription_reminder')).resolves.toHaveLength(1);
  });

  it('expires at the end when there is no grace, with no past_due in between', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    await prisma.platformSetting.update({ where: { id: 1 }, data: { subscriptionGraceDays: 0 } });

    await expect(run(day(30))).resolves.toEqual({ expired: 1, pastDue: 0, reminders: 0 });
    await expect(state(subscriptionId, day(30))).resolves.toMatchObject({ status: 'expired' });
  });

  it('follows the reminder days the platform set, and sends none for an empty list', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    await prisma.platformSetting.update({ where: { id: 1 }, data: { subscriptionReminderDays: [10] } });
    await expect(run(day(20))).resolves.toMatchObject({ reminders: 1 });
    await expect(run(day(23))).resolves.toMatchObject({ reminders: 0 });
    expect((await mail('subscription_reminder'))[0]?.dedupeKey).toBe(`email:subscription_reminder:${subscriptionId}:${day(30).toISOString()}:10`);

    await prisma.platformSetting.update({ where: { id: 1 }, data: { subscriptionReminderDays: [] } });
    await expect(run(day(29))).resolves.toMatchObject({ reminders: 0 });
  });
});

describe('who is told', () => {
  it.each(['suspended', 'pending'] as const)('moves a %s photographer\'s subscription but emails them nothing: they cannot pay', async (status) => {
    const { photographerId, subscriptionId } = await approvedAtDayZero();
    await prisma.photographer.update({ where: { id: photographerId }, data: { status, ...(status === 'suspended' ? { suspendedAt: T0 } : {}) } });

    await run(day(29));
    await run(day(30));
    await run(day(37));

    await expect(prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).resolves.toMatchObject({ status: 'expired' });
    await expect(prisma.outbox.count({ where: { template: { in: ['subscription_reminder', 'subscription_expired'] } } })).resolves.toBe(0);
  });

  it('carries on with the others when one subscription fails', async () => {
    const a = await approvedAtDayZero('studio-one');
    const b = await approvedAtDayZero('studio-two');
    // A real failure for one of them: a trigger refusing its update, for this test only.
    await raw.query(`
      CREATE FUNCTION test_refuse_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused for the test'; END $$`);
    await raw.query(`CREATE TRIGGER test_refuse BEFORE UPDATE ON subscription FOR EACH ROW WHEN (OLD.id = '${a.subscriptionId}') EXECUTE FUNCTION test_refuse_subscription()`);
    const sink = logSink();
    try {
      const result = await run(day(30), sink.log);

      expect(result.pastDue).toBe(1);
      expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'subscription_job_failed', step: 'past_due', subscriptionId: a.subscriptionId }));
      await expect(prisma.subscription.findUniqueOrThrow({ where: { id: b.subscriptionId } })).resolves.toMatchObject({ status: 'past_due' });
    } finally {
      await raw.query('DROP TRIGGER test_refuse ON subscription');
      await raw.query('DROP FUNCTION test_refuse_subscription()');
    }
    // The failed one is moved on the next run.
    await expect(run(day(30))).resolves.toMatchObject({ pastDue: 1 });
    await expect(prisma.subscription.findUniqueOrThrow({ where: { id: a.subscriptionId } })).resolves.toMatchObject({ status: 'past_due' });
  });
});

describe('the job and a payment', () => {
  async function pendingPayment(subscriptionId: string): Promise<string> {
    const rows = await prisma.$queryRaw<{ our_ref: string }[]>`
      INSERT INTO payment (subscription_id, kind, provider, method, amount_rwf, plan_interval, status)
      VALUES (${subscriptionId}::uuid, 'subscription', 'mtn_momo_direct', 'momo_mtn', 10000, 'monthly', 'pending')
      RETURNING our_ref::text AS our_ref`;
    return rows[0]?.our_ref ?? '';
  }

  const settle = (ourRef: string, at: Date) =>
    recordEvent({ prisma, now: () => at, log: () => undefined }, 'mtn_momo_direct', {
      signatureValid: true,
      event: { eventId: randomUUID(), eventType: 'test', ourRef, providerRef: null, reportedStatus: 'succeeded', method: 'momo_mtn', failureReason: null, amount: null },
      payload: {},
      expectedCurrency: 'EUR',
    });

  it('starts afresh after a payment: new reminders for the new end, none for the old', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    await run(day(23));
    await settle(await pendingPayment(subscriptionId), day(25));
    const newEnd = addPlanInterval(day(30), 'monthly');

    await expect(run(day(27))).resolves.toEqual({ expired: 0, pastDue: 0, reminders: 0 });
    await expect(run(day(30))).resolves.toEqual({ expired: 0, pastDue: 0, reminders: 0 });
    await expect(state(subscriptionId, day(30))).resolves.toEqual({ status: 'active', bookable: true, listed: true });

    await expect(run(new Date(newEnd.getTime() - 7 * DAY_MS))).resolves.toMatchObject({ reminders: 1 });
    const keys = (await mail('subscription_reminder')).map((row) => row.dedupeKey);
    expect(keys).toEqual([
      `email:subscription_reminder:${subscriptionId}:${day(30).toISOString()}:7`,
      `email:subscription_reminder:${subscriptionId}:${newEnd.toISOString()}:7`,
    ]);
    expect((await mail('subscription_reminder'))[1]?.payload).toMatchObject({ periodKind: 'paid' });
  });

  it('brings a past_due subscription back: active, bookable, and the job leaves it be', async () => {
    const { subscriptionId } = await approvedAtDayZero();
    await run(day(30));
    await settle(await pendingPayment(subscriptionId), day(32));

    await expect(run(day(37))).resolves.toEqual({ expired: 0, pastDue: 0, reminders: 0 });
    await expect(state(subscriptionId, day(37))).resolves.toEqual({ status: 'active', bookable: true, listed: true });
  });

  it.each([
    ['the job first', true],
    ['the payment first', false],
  ])('settles a payment racing the job at the end of the period, %s: the payment wins', async (_label, jobFirst) => {
    const { subscriptionId } = await approvedAtDayZero();
    const ourRef = await pendingPayment(subscriptionId);
    const at = day(30);

    if (jobFirst) await Promise.all([run(at), settle(ourRef, at)]);
    else await Promise.all([settle(ourRef, at), run(at)]);

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(after).toMatchObject({ status: 'active', currentPeriodEndsAt: addPlanInterval(day(30), 'monthly') });
    // A later run never moves it back.
    await expect(run(day(31))).resolves.toEqual({ expired: 0, pastDue: 0, reminders: 0 });
  });
});
