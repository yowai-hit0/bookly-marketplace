import type { Prisma, PrismaClient } from '@prisma/client';
import { type ScheduledTask, schedule } from 'node-cron';
import { enqueue } from '../outbox/enqueue.js';
import { photographerRecipient } from '../outbox/recipients.js';
import { getPlatformSettings } from '../settings/index.js';
import { DAY_MS, graceEndsAt } from './plan.js';

/**
 * The subscription job (marketplace-spec.md R5.4; marketplace-data-model.md
 * §3.7), on node-cron like the hold sweeper and the reconciler. Each run, at the
 * injected clock's `now`:
 *
 *   1. EXPIRED. A subscription whose period ended more than
 *      `subscription_grace_days` ago becomes `expired`, and the photographer is
 *      told (`subscription_expired`). Checked first, so a run that comes very
 *      late moves a lapsed subscription straight there, past `past_due`, and
 *      sends no stale past-due notice.
 *   2. PAST DUE. A `trialing` or `active` subscription whose period has ended
 *      becomes `past_due`: still listed, not bookable (R5.5). The photographer
 *      is told (`subscription_reminder`, variant `past_due`).
 *   3. REMINDERS. A `trialing` or `active` subscription whose period ends within
 *      one of the `subscription_reminder_days` (7, 3 and 1 by default) gets the
 *      reminder for the SMALLEST such day count it has reached
 *      (`subscription_reminder`, variant `ending`). The larger ones it has
 *      passed are skipped, not sent late: a run that comes on day 28 of a 30-day
 *      trial sends the 3-day reminder and never the 7-day one.
 *
 * NOTHING IS SENT TWICE. Every message's dedupe key names the subscription, the
 * period's end and the moment (`<days>`, `past_due`; the expiry has one per end),
 * as §3.7 has it: a run that repeats, overlaps another or comes late finds the
 * key taken (outbox/enqueue.ts). A payment that moves the end starts afresh,
 * with keys of its own.
 *
 * The job only RECORDS what the clock already decided. Bookability compares the
 * period's end with the clock directly (photographers/bookable.ts), and the
 * listing compares the grace end, so a late job never keeps anyone bookable or
 * listed. Every status move is one guarded `UPDATE ... WHERE status IN (...)
 * AND current_period_ends_at <= ...` in a transaction with its email: a payment
 * that extended the period first leaves the guard matching nothing, and one
 * that comes after sets `active` itself (subscriptions/payments.ts). The lock
 * order (payments/webhooks.ts): the subscription row alone, then the outbox.
 *
 * Status moves happen whatever the photographer's own status; the emails go only
 * to an `approved` photographer. A pending or suspended one cannot pay for their
 * subscription (subscriptions/payments.ts), so a reminder would ask them for
 * something they cannot do.
 */

/** Every ten minutes. Bookability does not depend on this cadence (R5.4); the emails' timeliness does, a little. */
export const SUBSCRIPTION_JOB_SCHEDULE = '*/10 * * * *';

export type SubscriptionJobDeps = {
  prisma: PrismaClient;
  /** The injected clock (T5.1). */
  now: () => Date;
  log?: (entry: Record<string, unknown>) => void;
};

export type SubscriptionJobResult = { expired: number; pastDue: number; reminders: number };

const LIVE_STATUSES = ['trialing', 'active'] as const;
const UNEXPIRED_STATUSES = ['trialing', 'active', 'past_due'] as const;

export async function runSubscriptionJob(deps: SubscriptionJobDeps): Promise<SubscriptionJobResult> {
  const { prisma } = deps;
  const log = deps.log ?? defaultLog;
  const now = deps.now();
  const settings = await getPlatformSettings(prisma);
  const result: SubscriptionJobResult = { expired: 0, pastDue: 0, reminders: 0 };

  // 1. Past the grace days.
  const expiredBefore = new Date(now.getTime() - settings.subscriptionGraceDays * DAY_MS);
  for (const { id } of await prisma.subscription.findMany({
    where: { status: { in: [...UNEXPIRED_STATUSES] }, currentPeriodEndsAt: { lte: expiredBefore } },
    select: { id: true },
    orderBy: { currentPeriodEndsAt: 'asc' },
  })) {
    if (await safely(log, id, 'expire', () => expire(prisma, id, expiredBefore, now))) result.expired += 1;
  }

  // 2. Ended, inside the grace days.
  for (const { id } of await prisma.subscription.findMany({
    where: { status: { in: [...LIVE_STATUSES] }, currentPeriodEndsAt: { lte: now } },
    select: { id: true },
    orderBy: { currentPeriodEndsAt: 'asc' },
  })) {
    if (await safely(log, id, 'past_due', () => markPastDue(prisma, id, now, settings.subscriptionGraceDays))) result.pastDue += 1;
  }

  // 3. Ending within the largest reminder window.
  const reminderDays = [...new Set(settings.subscriptionReminderDays)].sort((a, b) => a - b);
  const widest = reminderDays.at(-1);
  if (widest !== undefined) {
    for (const { id } of await prisma.subscription.findMany({
      where: { status: { in: [...LIVE_STATUSES] }, currentPeriodEndsAt: { gt: now, lte: new Date(now.getTime() + widest * DAY_MS) } },
      select: { id: true },
      orderBy: { currentPeriodEndsAt: 'asc' },
    })) {
      if (await safely(log, id, 'reminder', () => remind(prisma, id, now, reminderDays))) result.reminders += 1;
    }
  }

  if (result.expired + result.pastDue + result.reminders > 0) log({ level: 'info', event: 'subscription_job', at: now.toISOString(), ...result });
  return result;
}

/** `expired`, and the email, if the subscription is still unexpired and past its grace. */
async function expire(prisma: PrismaClient, subscriptionId: string, expiredBefore: Date, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.subscription.updateMany({
      where: { id: subscriptionId, status: { in: [...UNEXPIRED_STATUSES] }, currentPeriodEndsAt: { lte: expiredBefore } },
      data: { status: 'expired', updatedAt: now },
    });
    if (count === 0) return false;
    const subscription = await subscriptionFor(tx, subscriptionId);
    const to = await recipientIfApproved(tx, subscription);
    if (to !== null) {
      await enqueue(tx, {
        kind: 'email',
        template: 'subscription_expired',
        ...to,
        dedupeKey: `email:subscription_expired:${subscription.id}:${subscription.currentPeriodEndsAt.toISOString()}`,
        payload: { displayName: subscription.photographer.displayName, periodEndedAt: subscription.currentPeriodEndsAt.toISOString() },
      });
    }
    return true;
  });
}

/** `past_due`, and the notice, if the subscription is still trialing or active with its period over. */
async function markPastDue(prisma: PrismaClient, subscriptionId: string, now: Date, graceDays: number): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.subscription.updateMany({
      where: { id: subscriptionId, status: { in: [...LIVE_STATUSES] }, currentPeriodEndsAt: { lte: now } },
      data: { status: 'past_due', updatedAt: now },
    });
    if (count === 0) return false;
    const subscription = await subscriptionFor(tx, subscriptionId);
    const to = await recipientIfApproved(tx, subscription);
    if (to !== null) {
      const endedAt = subscription.currentPeriodEndsAt;
      await enqueue(tx, {
        kind: 'email',
        template: 'subscription_reminder',
        ...to,
        dedupeKey: `email:subscription_reminder:${subscription.id}:${endedAt.toISOString()}:past_due`,
        payload: {
          variant: 'past_due',
          displayName: subscription.photographer.displayName,
          periodEndedAt: endedAt.toISOString(),
          graceEndsAt: graceEndsAt(endedAt, graceDays).toISOString(),
        },
      });
    }
    return true;
  });
}

/**
 * The reminder due now, if any: the smallest configured day count whose moment
 * (`end - days`) has come. Read under the subscription's row lock, so a payment
 * that moves the end meanwhile is either seen (and the reminder is for the new
 * end, or not due) or waits.
 */
async function remind(prisma: PrismaClient, subscriptionId: string, now: Date, reminderDays: readonly number[]): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM subscription WHERE id = ${subscriptionId}::uuid FOR UPDATE`;
    const subscription = await subscriptionFor(tx, subscriptionId);
    const endsAt = subscription.currentPeriodEndsAt;
    if (!(LIVE_STATUSES as readonly string[]).includes(subscription.status) || endsAt.getTime() <= now.getTime()) return false;

    const days = reminderDays.find((d) => endsAt.getTime() - d * DAY_MS <= now.getTime());
    if (days === undefined) return false;
    const to = await recipientIfApproved(tx, subscription);
    if (to === null) return false;

    // The period ending: the latest one, which current_period_ends_at always ends.
    const period = await tx.subscriptionPeriod.findFirst({
      where: { subscriptionId, voidedAt: null },
      orderBy: { endsAt: 'desc' },
      select: { kind: true },
    });
    const outcome = await enqueue(tx, {
      kind: 'email',
      template: 'subscription_reminder',
      ...to,
      dedupeKey: `email:subscription_reminder:${subscription.id}:${endsAt.toISOString()}:${days}`,
      payload: {
        variant: 'ending',
        displayName: subscription.photographer.displayName,
        periodKind: period?.kind === 'trial' ? 'trial' : 'paid',
        periodEndsAt: endsAt.toISOString(),
        // What is really left, which a late run makes fewer than the configured count.
        daysLeft: Math.max(1, Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS)),
      },
    });
    return outcome === 'enqueued';
  });
}

const SUBSCRIPTION_SELECT = {
  id: true,
  status: true,
  photographerId: true,
  currentPeriodEndsAt: true,
  photographer: { select: { status: true, displayName: true } },
} satisfies Prisma.SubscriptionSelect;

function subscriptionFor(tx: Prisma.TransactionClient, id: string) {
  return tx.subscription.findUniqueOrThrow({ where: { id }, select: SUBSCRIPTION_SELECT });
}

async function recipientIfApproved(
  tx: Prisma.TransactionClient,
  subscription: Prisma.SubscriptionGetPayload<{ select: typeof SUBSCRIPTION_SELECT }>,
): Promise<{ recipient: string; photographerId: string } | null> {
  if (subscription.photographer.status !== 'approved') return null;
  return photographerRecipient(tx, subscription.photographerId);
}

/** One subscription's failure must not stop the others'. */
async function safely(log: (entry: Record<string, unknown>) => void, subscriptionId: string, step: string, run: () => Promise<boolean>): Promise<boolean> {
  try {
    return await run();
  } catch (error) {
    log({ level: 'error', event: 'subscription_job_failed', step, subscriptionId, message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** Starts the job on its schedule. A run still going when the next is due is not doubled up. */
export function startSubscriptionJob(deps: SubscriptionJobDeps, cronExpression: string = SUBSCRIPTION_JOB_SCHEDULE): ScheduledTask {
  const log = deps.log ?? defaultLog;
  let running = false;
  return schedule(cronExpression, async () => {
    if (running) return;
    running = true;
    try {
      await runSubscriptionJob(deps);
    } catch (error) {
      // One instance, one loop: logged and retried on the next tick.
      log({ level: 'error', event: 'subscription_job_failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  });
}

function defaultLog(entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') console.error(line);
  else console.log(line);
}
