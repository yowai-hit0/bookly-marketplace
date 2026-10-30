import { Prisma } from '@prisma/client';
import type { PaymentProvider, PaymentProviderId } from './provider.js';
import { RECONCILE_MAX_AGE_MINUTES, settles } from './reconcile.js';
import { type WebhookDeps, recordEvent } from './webhooks.js';

/**
 * "Verify now", for a card payment the browser has just finished (C5,
 * 2026-10-30). After the Inline modal's callback or its 3-D Secure redirect the
 * page knows the payer is done, but its word is worth nothing (R3.3, T3.2), and
 * waiting only for the webhook can take a while. So the progress page's own
 * poll -- `GET /api/payments/:ourRef` and `GET /api/studio/subscription/payments/:ourRef`
 * -- asks Flutterwave itself, at most once per payment every
 * `CHECK_MIN_INTERVAL_MS`, and only for a card payment still `pending`.
 *
 * Why the poll and not a `POST …/verify` route: the page already polls, and the
 * 3-D Secure redirect lands on that same page, so nothing new has to be called
 * at the right moment; the throttle is per PAYMENT, which bounds the calls to
 * Flutterwave however many tabs or addresses poll (a per-IP limit on a POST
 * would not); and no route is added to any area, so the isolation and role
 * sweeps stand as they are.
 *
 * Only the server's own call counts. The page may pass the `transaction_id` the
 * modal or the redirect gave it, as a hint of WHICH transaction to verify by id
 * (a `tx_ref` may carry several tries): the answer must name this payment's
 * `tx_ref`, and a success must match the amount and the currency exactly, like
 * any other (payments/webhooks.ts). A wrong or foreign id verifies nothing. The
 * answer goes down the reconciler's path: stored as a verified event,
 * deduplicated against the webhook of the same outcome, applied forward-only. A
 * declined try or a pending answer records nothing; a failed call is logged and
 * the poll answers what is on record.
 */

export type PaymentCheck = (
  ourRef: string,
  hint: {
    transactionId?: string | undefined;
    /** Whose poll asks: the public one only about a fee, the studio's only about a subscription. */
    subject: 'booking' | 'subscription';
  },
) => Promise<void>;

/** One look per payment per this long, whoever asks. A developer default. */
export const CHECK_MIN_INTERVAL_MS = 5_000;
/** The poll waits at most this long for the answer before it reads what is on record. */
export const CHECK_TIMEOUT_MS = 8_000;
/** Throttle entries kept before the stale ones are dropped: memory stays bounded whatever is polled. */
const MAX_TRACKED = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSACTION_ID = /^\d{1,20}$/;

export type PaymentCheckDeps = WebhookDeps & {
  /** Every provider whose payments may still be settling (providers.ts `all`). */
  providers: Partial<Record<PaymentProviderId, PaymentProvider>>;
  /** The throttle's clock (ms); injectable for tests. */
  clock?: () => number;
  minIntervalMs?: number;
  timeoutMs?: number;
};

export function createPaymentCheck(deps: PaymentCheckDeps): PaymentCheck {
  const log = deps.log ?? defaultLog;
  const clock = deps.clock ?? Date.now;
  const minIntervalMs = deps.minIntervalMs ?? CHECK_MIN_INTERVAL_MS;
  const lastChecked = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();

  const prune = (now: number) => {
    if (lastChecked.size < MAX_TRACKED) return;
    for (const [key, at] of lastChecked) if (now - at >= minIntervalMs) lastChecked.delete(key);
  };

  return async (ourRef, hint) => {
    if (!UUID.test(ourRef)) return;
    const key = ourRef.toLowerCase();
    const running = inFlight.get(key);
    if (running !== undefined) return running;

    // Waiting, and recent enough that the reconciler would still ask (from the
    // attempt: an old session-fee ask is attempted when the client pays). Read
    // before the throttle, so a poll that is no business of this check (another
    // area's payment, a MoMo one) never holds up one that is.
    const rows = await deps.prisma.$queryRaw<{ provider: string }[]>`
      SELECT provider
        FROM payment
       WHERE our_ref = ${key}::uuid
         AND status = 'pending'
         AND ${hint.subject === 'booking' ? Prisma.sql`booking_id IS NOT NULL` : Prisma.sql`subscription_id IS NOT NULL`}
         AND GREATEST(initiated_at, updated_at) > now() - make_interval(mins => ${RECONCILE_MAX_AGE_MINUTES}::integer)`;
    const providerId = rows[0]?.provider as PaymentProviderId | undefined;
    const provider = providerId === undefined ? undefined : deps.providers[providerId];
    // A browser checkout only: a MoMo prompt has no "the payer is done" moment to act on.
    if (provider === undefined || provider.browserCheckout === undefined) return;

    const now = clock();
    const previous = lastChecked.get(key);
    if (previous !== undefined && now - previous < minIntervalMs) return;
    prune(now);
    lastChecked.set(key, now);

    const run = (async () => {
      try {
        const signal = AbortSignal.timeout(deps.timeoutMs ?? CHECK_TIMEOUT_MS);
        const transactionId = hint.transactionId !== undefined && TRANSACTION_ID.test(hint.transactionId) ? hint.transactionId : undefined;
        const found =
          transactionId !== undefined && provider.lookupTransaction !== undefined
            ? await provider.lookupTransaction(transactionId, signal)
            : await provider.lookupStatus(key, signal);
        if (found === null) return;
        if (found.event.ourRef !== key) {
          log({ level: 'warn', event: 'payment_check_other_reference', provider: provider.id, ourRef: key });
          return;
        }
        if (!settles(found.event)) return;
        await recordEvent(deps, provider.id, {
          signatureValid: true,
          event: found.event,
          payload: found.payload,
          expectedCurrency: provider.currency,
        });
      } catch (error) {
        log({ level: 'warn', event: 'payment_check_failed', ourRef: key, message: error instanceof Error ? error.message : String(error) });
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, run);
    return run;
  };
}

function defaultLog(entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') console.error(line);
  else console.log(line);
}
