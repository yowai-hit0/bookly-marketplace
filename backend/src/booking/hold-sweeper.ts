import type { PrismaClient } from '@prisma/client';
import { type ScheduledTask, schedule } from 'node-cron';

/**
 * The hold sweeper (plan.md Task 6, spec §3.2).
 *
 * A `pending_payment` booking holds its slot for the hold window. When the
 * window passes, the booking becomes `expired` and the slot and its buffer
 * return to public availability.
 *
 * This job is tidiness, not correctness: the claim transaction expires stale
 * holds that stand in its way on its own (data-model_v2.md §9.2), so a slot is
 * never unclaimable merely because the sweeper has not run yet. That is why the
 * cadence below is not load-bearing and why nothing retries it.
 */

/** Every minute. Correctness does not depend on this (data-model_v2.md §9.2). */
export const HOLD_SWEEP_SCHEDULE = '* * * * *';

/**
 * Expires every lapsed hold and returns how many it expired.
 *
 * Sends nothing. An abandoned checkout gets no client email and raises no admin
 * alert (spec §3.2) -- the record is simply retained for reporting. Anything
 * enqueued here would email a visitor who chose to walk away.
 */
export async function sweepExpiredHolds(prisma: PrismaClient): Promise<number> {
  return prisma.$executeRaw`
    UPDATE booking
       SET status = 'expired'
     WHERE status = 'pending_payment'
       AND hold_expires_at <= now()`;
}

/**
 * Starts the sweeper on the cron schedule. Returns the task so the caller can
 * stop it on shutdown; `sweepExpiredHolds` stays directly callable, which is how
 * the tests drive it.
 */
export function startHoldSweeper(
  prisma: PrismaClient,
  cronExpression: string = HOLD_SWEEP_SCHEDULE,
): ScheduledTask {
  return schedule(cronExpression, async () => {
    try {
      await sweepExpiredHolds(prisma);
    } catch (error) {
      // One instance, one loop: a failed sweep is logged and retried on the next
      // tick rather than crashing the API process that also serves the site.
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'hold_sweep_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
}
