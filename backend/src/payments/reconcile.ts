import type { PrismaClient } from '@prisma/client';
import { type ScheduledTask, schedule } from 'node-cron';
import type { PaymentProvider, PaymentProviderId } from './provider.js';
import { type WebhookDeps, recordEvent } from './webhooks.js';

/**
 * Asking the provider about payments still waiting (spec §4.3, "look up
 * status"). A callback can be lost -- and MTN's sandbox never sends one -- so
 * once a minute, each payment `pending` for more than a minute (and less than
 * an hour) is looked up, and a settled answer goes through exactly the path a
 * webhook takes: stored, deduplicated, applied forward-only.
 *
 * The lookup is our own authenticated request to the provider, so its answer
 * is recorded as verified. It carries the event id a callback for the same
 * outcome would, so whichever arrives second is stored as a duplicate and
 * changes nothing. A payment still pending records nothing: a row a minute per
 * waiting payment would bury the ones that matter.
 */

export const RECONCILE_SCHEDULE = '* * * * *';
/** Give the callback its chance first. */
export const RECONCILE_MIN_AGE_SECONDS = 60;
/** Past the hold and then some; a request unanswered this long is not coming back. */
export const RECONCILE_MAX_AGE_MINUTES = 60;
/** MTN's sandbox settles at once but never calls back, so the lookup is its only signal: ask often and early. */
export const SANDBOX_RECONCILE_SCHEDULE = '*/5 * * * * *';
export const SANDBOX_RECONCILE_MIN_AGE_SECONDS = 3;
const RECONCILE_BATCH_SIZE = 20;
const LOOKUP_TIMEOUT_MS = 15_000;

export type ReconcileDeps = WebhookDeps & { provider: PaymentProvider; minAgeSeconds?: number };

/** Looks up every waiting payment due a check; returns how many settled. */
export async function reconcilePendingPayments(deps: ReconcileDeps): Promise<number> {
  const { prisma, provider } = deps;
  const log = deps.log ?? defaultLog;
  const waiting = await dueForLookup(prisma, provider.id, deps.minAgeSeconds ?? RECONCILE_MIN_AGE_SECONDS);

  let settled = 0;
  for (const { our_ref: ourRef } of waiting) {
    try {
      const found = await provider.lookupStatus(ourRef, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
      if (found === null || found.event.reportedStatus === null || found.event.reportedStatus === 'pending') continue;
      const outcome = await recordEvent(deps, provider.id, {
        signatureValid: true,
        event: found.event,
        payload: found.payload,
        expectedCurrency: provider.currency,
      });
      if (outcome.status === 'applied') settled += 1;
    } catch (error) {
      // One payment's lookup failing must not stop the others'.
      log({ level: 'warn', event: 'payment_lookup_failed', provider: provider.id, ourRef, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return settled;
}

function dueForLookup(prisma: PrismaClient, providerId: string, minAgeSeconds: number): Promise<{ our_ref: string }[]> {
  return prisma.$queryRaw<{ our_ref: string }[]>`
    SELECT our_ref::text AS our_ref
      FROM payment
     WHERE provider = ${providerId}
       AND status = 'pending'
       AND initiated_at <= now() - make_interval(secs => ${minAgeSeconds}::double precision)
       AND initiated_at > now() - make_interval(mins => ${RECONCILE_MAX_AGE_MINUTES}::integer)
     ORDER BY initiated_at
     LIMIT ${RECONCILE_BATCH_SIZE}`;
}

/** One reconciler to run: whose payments it looks up, how often and from what age. */
export type ReconcilerPlan = { provider: PaymentProvider; schedule: string; minAgeSeconds: number };

/**
 * The reconcilers a deployment runs (marketplace-spec.md R3.5): one per
 * configured provider in `all`, whether or not it collects a method today --
 * a provider routed away from still has payments waiting on it, and its lookup
 * is how a lost callback still settles them. An unconfigured provider has
 * nothing to ask with and gets none. MTN's sandbox never calls back, so there
 * the lookup is the only signal and runs every few seconds.
 */
export function reconcilerPlans(all: Partial<Record<PaymentProviderId, PaymentProvider>>, options: { mtnSandbox: boolean }): ReconcilerPlan[] {
  return Object.values(all)
    .filter((provider) => provider.configured)
    .map((provider) =>
      provider.id === 'mtn_momo_direct' && options.mtnSandbox
        ? { provider, schedule: SANDBOX_RECONCILE_SCHEDULE, minAgeSeconds: SANDBOX_RECONCILE_MIN_AGE_SECONDS }
        : { provider, schedule: RECONCILE_SCHEDULE, minAgeSeconds: RECONCILE_MIN_AGE_SECONDS },
    );
}

/** Starts the lookup on its schedule. A run still going when the next is due is not doubled up. */
export function startPaymentReconciler(deps: ReconcileDeps, cronExpression: string = RECONCILE_SCHEDULE): ScheduledTask {
  const log = deps.log ?? defaultLog;
  let running = false;
  return schedule(cronExpression, async () => {
    if (running) return;
    running = true;
    try {
      await reconcilePendingPayments(deps);
    } catch (error) {
      log({ level: 'error', event: 'payment_reconcile_failed', message: error instanceof Error ? error.message : String(error) });
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
