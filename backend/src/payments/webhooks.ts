import { randomUUID } from 'node:crypto';
import { type Booking, Prisma, type PrismaClient } from '@prisma/client';
import { type AccessToken, accessTokenExpiry, generateAccessToken } from '../booking/access-token.js';
import { completeIfSettled } from '../booking/auto-complete.js';
import { expireOverlappingStaleHolds, lockPhotographerCalendar } from '../booking/claim.js';
import { bookingTotals, overpaymentHeldRwf } from '../booking/totals.js';
import { isSlotTaken, isTransactionConflict } from '../db/errors.js';
import { OCCUPYING_STATUSES } from '../db/statuses.js';
import { enqueue } from '../outbox/enqueue.js';
import { bookingPhotographerRecipient } from '../outbox/recipients.js';
import { recordEarning, recordRefundDue } from '../payouts/ledger.js';
import { type SettlingSubscriptionPayment, addPaidPeriod } from '../subscriptions/payments.js';
import { PLAN_INTERVALS, type PlanInterval } from '../subscriptions/plan.js';
import { SUPERSEDED_BY_CASH } from './cash.js';
import {
  type PaymentProvider,
  type PaymentProviderId,
  type PaymentStatus,
  type ProviderEvent,
  SETTLED_PAYMENT_STATUSES,
  type WebhookDelivery,
} from './provider.js';

/**
 * Applying what a payment provider tells us (plan.md Task 17; spec §3.1 steps
 * 10-12, §6.9; data-model_v2.md §7.3). Store first, verify, dedupe, apply
 * forward-only:
 *
 *   1. Verify. A delivery that fails is stored `signature_valid = false`,
 *      `ignored`, and applies nothing.
 *   2. Insert. `(provider, event_id)` is unique, so a second delivery of an
 *      event finds the first and is stored `ignored` beside it.
 *   3. Match a payment on `our_ref`, else `provider_ref`. No match: `ignored`,
 *      and the row stays for inspection.
 *   4. A payment already settled -- `succeeded`, `failed`, `refunded`, or
 *      `refund_due` beyond them -- ignores the event. A failed attempt never
 *      becomes a success; a retry is its own payment with its own `our_ref`.
 *   5. Otherwise apply the transition in one transaction with everything it
 *      implies, and mark the event `applied`.
 *
 * A succeeded booking fee confirms its booking: hold cleared, `confirmed_at`
 * set, a fresh access token hashed onto the booking, and the confirmation and
 * the photographer's new-booking email queued -- all or nothing. The plaintext
 * token exists only inside the confirmation email's outbox payload.
 *
 * A fee arriving after the hold expired (spec §6.9) re-confirms the booking only
 * if its slot is still free in its own photographer's calendar, checked under
 * that photographer's slot-claim lock (marketplace-spec.md R1.3, T1.3): another
 * photographer's booking at the same hour takes nothing from it. Otherwise the
 * booking stays `expired`, the payment is `refund_due`, and the photographer is
 * told at once. A second fee for a booking that already has one is the same
 * kind of money: owed back, and flagged.
 *
 * Every success writes the payment's earning to the payout ledger in the same
 * transaction (payouts/ledger.ts; marketplace-spec.md R4.2, T4.1), so the
 * reconciler, which applies through this same path, earns too; a replay never
 * reaches it (step 4), and the ledger's unique (payment, kind) would refuse a
 * second earning anyway.
 *
 * A session fee that brings in more than the booking is worth (Phase 4
 * overpayment decision) is measured under the booking's row lock, against what
 * was due before it -- earlier overpaid parts never count towards that, so two
 * overpayments do not double-count (booking/totals.ts). Some of it due: it
 * succeeds with `overpaid_rwf` set in the same update, earns only the part that
 * was due, and the platform returns the rest (`/api/platform/refunds`). None of
 * it due -- a prompt approved after the balance was cleared another way -- it
 * is `refund_due` whole, `duplicate_payment`, like a second booking fee. Set
 * once, as the payment settles, so a replay cannot add to it (step 4).
 *
 * A subscription payment (Phase 5, R5.3) has no booking: its success adds a
 * paid period on top of the subscription's current end and queues the receipt
 * (subscriptions/payments.ts `addPaidPeriod`). Every success does -- a late
 * one, a duplicate, a revived one -- and none is ever `refund_due`, overpaid or
 * earned (user decision, Phase 5).
 */

export type WebhookDeps = {
  prisma: PrismaClient;
  now?: () => Date;
  /** Injectable so a test can find the token it expects. */
  newAccessToken?: () => AccessToken;
  log?: (entry: Record<string, unknown>) => void;
};

export type WebhookOutcome = {
  status: 'applied' | 'ignored' | 'failed';
  /** The `webhook_event` row this delivery is recorded as. */
  eventRowId: string;
  /** Why an event was ignored, or what applying it did. */
  note: string;
};

/** An event the way a delivery or a status lookup presents it. */
export type IncomingEvent = {
  signatureValid: boolean;
  event: ProviderEvent | null;
  /** The body, as stored for dispute evidence. */
  payload: unknown;
  /**
   * What the provider charges in (`PaymentProvider.currency`). A success that
   * names another currency is ignored like a wrong amount (marketplace-spec.md
   * T3.3): 20,000 of anything else is not the 20,000 RWF we asked for. Every
   * caller in the app passes it (`receiveWebhook`, `reconcile.ts`).
   */
  expectedCurrency?: string;
};

/** Contention retries, as in the slot claim. */
const MAX_APPLY_ATTEMPTS = 3;
const APPLY_MAX_WAIT_MS = 10_000;
const APPLY_TIMEOUT_MS = 15_000;
const PROCESSING_ERROR_MAX_LENGTH = 1000;
const EVENT_ID_MAX_LENGTH = 300;
/** Far longer than processing can take: three attempts, each at most 10 s waiting and 15 s running. */
const RECLAIM_RECEIVED_AFTER_SECONDS = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One inbound HTTP delivery: verified and read by its provider, then recorded and applied. */
export async function receiveWebhook(deps: WebhookDeps, provider: PaymentProvider, delivery: WebhookDelivery): Promise<WebhookOutcome> {
  return recordEvent(deps, provider.id, {
    signatureValid: safely(() => provider.verifyWebhook(delivery), false),
    event: safely(() => provider.parseWebhook(delivery), null),
    payload: payloadOf(delivery.rawBody),
    expectedCurrency: provider.currency,
  });
}

export async function recordEvent(deps: WebhookDeps, providerId: PaymentProviderId, incoming: IncomingEvent): Promise<WebhookOutcome> {
  const log = deps.log ?? defaultLog;
  const { event } = incoming;
  const payload = storableJson(incoming.payload);

  // Step 1. Stored under an id of its own, so a forgery can never occupy the id
  // a genuine delivery of that event will need.
  if (!incoming.signatureValid) {
    const eventRowId = await insertSettled(deps.prisma, providerId, `unverified:${randomUUID()}`, event, false, payload, 'signature_invalid');
    log({ level: 'warn', event: 'webhook_signature_invalid', provider: providerId, eventRowId });
    return { status: 'ignored', eventRowId, note: 'signature_invalid' };
  }
  if (event === null) {
    const eventRowId = await insertSettled(deps.prisma, providerId, `unreadable:${randomUUID()}`, null, true, payload, 'unreadable_event');
    log({ level: 'warn', event: 'webhook_unreadable', provider: providerId, eventRowId });
    return { status: 'ignored', eventRowId, note: 'unreadable_event' };
  }

  // Step 2. The id as stored, so the lookup below finds what the insert collided with.
  const eventId = storableText(event.eventId, EVENT_ID_MAX_LENGTH);
  let eventRowId = await insertReceived(deps.prisma, providerId, eventId, event, payload);
  if (eventRowId === null) {
    const found = await deps.prisma.$queryRaw<{ id: string; status: string; stale: boolean }[]>`
      SELECT id::text AS id, status,
             received_at <= now() - make_interval(secs => ${RECLAIM_RECEIVED_AFTER_SECONDS}::double precision) AS stale
        FROM webhook_event
       WHERE provider = ${providerId} AND event_id = ${eventId}`;
    const first = found[0];
    if (first === undefined) throw new Error('A conflicting webhook_event row could not be read back');
    // A first delivery we failed to process is processed again when the
    // provider retries it -- that retry is what the 500 asked for -- and so is
    // one still `received` long after any processing of it could be running:
    // the process died mid-way. Processing locks the event row and does
    // nothing to one already settled, so reclaiming twice is harmless.
    const reclaimed =
      (first.status === 'received' && first.stale) ||
      (first.status === 'failed' &&
        (await deps.prisma.webhookEvent.updateMany({
          where: { id: first.id, status: 'failed' },
          data: { status: 'received', processingError: null, processedAt: null },
        })).count === 1);
    if (!reclaimed) {
      const duplicateId = await insertSettled(
        deps.prisma,
        providerId,
        `${eventId}#duplicate:${randomUUID()}`,
        event,
        true,
        payload,
        `duplicate_of:${first.id}`,
      );
      return { status: 'ignored', eventRowId: duplicateId, note: 'duplicate_delivery' };
    }
    eventRowId = first.id;
  }

  // Steps 3-5.
  try {
    const applied = await applyWithRetry(deps, providerId, eventRowId, event, incoming.expectedCurrency);
    for (const entry of applied.logs) log(entry);
    return { status: applied.status, eventRowId, note: applied.note };
  } catch (error) {
    const message = storableText(error instanceof Error ? `${error.name}: ${error.message}` : String(error), PROCESSING_ERROR_MAX_LENGTH);
    // Only a row still in hand: a concurrent processing that settled it stands.
    await deps.prisma.webhookEvent.updateMany({
      where: { id: eventRowId, status: 'received' },
      data: { status: 'failed', processingError: message, processedAt: new Date() },
    });
    log({ level: 'error', event: 'webhook_processing_failed', provider: providerId, eventRowId, message });
    return { status: 'failed', eventRowId, note: 'processing_failed' };
  }
}

type Applied = { status: 'applied' | 'ignored'; note: string; logs: Record<string, unknown>[] };

async function applyWithRetry(
  deps: WebhookDeps,
  providerId: PaymentProviderId,
  eventRowId: string,
  event: ProviderEvent,
  expectedCurrency: string | undefined,
): Promise<Applied> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.prisma.$transaction((tx) => applyEvent(tx, deps, providerId, eventRowId, event, expectedCurrency), {
        maxWait: APPLY_MAX_WAIT_MS,
        timeout: APPLY_TIMEOUT_MS,
      });
    } catch (error) {
      // A deadlock with the sweeper, or a writer that moved into the slot
      // without the claim lock: rolled back whole, so running again re-reads
      // everything -- and the slot check then sees what beat it.
      if ((isTransactionConflict(error) || isSlotTaken(error)) && attempt < MAX_APPLY_ATTEMPTS) continue;
      throw error;
    }
  }
}

type PaymentRecord = {
  id: string;
  /** The booking of a booking or session fee; null for a subscription payment (CHECK payment_subject_exactly_one). */
  booking_id: string | null;
  /** The subscription of a subscription payment; null for a fee. */
  subscription_id: string | null;
  /** The booking's photographer: whose calendar lock a fee's success takes. Null with no booking. */
  photographer_id: string | null;
  provider: string;
  kind: string;
  /** monthly | yearly for a subscription payment, frozen at initiation. */
  plan_interval: string | null;
  status: PaymentStatus;
  our_ref: string;
  provider_ref: string | null;
  method: string | null;
  amount_rwf: number;
  /** Why a `failed` payment failed: a provider's verdict, or a reason of ours (`revivable`). */
  failure_reason: string | null;
};

async function applyEvent(
  tx: Prisma.TransactionClient,
  deps: WebhookDeps,
  providerId: PaymentProviderId,
  eventRowId: string,
  event: ProviderEvent,
  expectedCurrency: string | undefined,
): Promise<Applied> {
  const logs: Record<string, unknown>[] = [];
  const finish = async (status: Applied['status'], note: string): Promise<Applied> => {
    await tx.webhookEvent.update({
      where: { id: eventRowId },
      data: { status, processingError: status === 'ignored' ? note : null, processedAt: new Date() },
    });
    return { status, note, logs };
  };

  // One processing of an event at a time; a second finds it settled and leaves it.
  const held = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM webhook_event WHERE id = ${eventRowId}::uuid FOR UPDATE`;
  if (held[0]?.status !== 'received') return { status: 'ignored', note: 'already_processed', logs };

  // Step 3. Matched without a lock: the match only names the booking and the
  // photographer (a payment's booking never changes), so the locks below can be
  // taken in the canonical order, and the payment is read again once held.
  const matched = await matchPayment(tx, providerId, event);
  if (matched === null) return finish('ignored', 'no_matching_payment');

  // THE LOCK ORDER (every writer of a booking's money, so no two can deadlock):
  //
  //   1. the photographer's calendar lock (booking/claim.ts), when slots matter
  //   2. the booking row (FOR UPDATE, or an UPDATE of it)
  //   3. its payment rows
  //   4. their payout items (payouts/ledger.ts)
  //
  // Each path takes a prefix of that, in that order, and nothing after it:
  // claims and reschedules take 1-2; cash (payments/cash.ts), session-fee asks
  // (payments/session-fee.ts), attempts (payments/initiate.ts), add-ons and
  // both cancellations (booking/cancel.ts, booking/admin-actions.ts) take 2-4;
  // a refund recording (payments/refund.ts) takes 3 alone, then a per-reference
  // lock that guards no row. A success here takes 1-4, since it may confirm a
  // booking into its slot and must measure what the booking has collected
  // (R1.3, Phase 4 overpayment decision). A pending or failed event takes 3
  // alone: it moves no money towards the booking.
  //
  // A SUBSCRIPTION's money (Phase 5) has the same shape, with the subscription
  // row in the booking row's place: it is the subject its payments hang off, as
  // the booking is for a fee.
  //
  //   2'. the subscription row (FOR UPDATE, or an UPDATE of it)
  //   3.  its payment rows
  //   4'. its periods (subscription_period inserts; never a payout item)
  //
  // An initiation (subscriptions/payments.ts) takes 2'-3; a success here takes
  // 2'-4'; the job (subscriptions/job.ts) takes 2' alone, then only inserts into
  // the outbox. Approval (photographers/moderation.ts) holds the photographer
  // row, then inserts the subscription: the photographer row comes before 2',
  // and nothing holding a subscription row ever waits for a photographer row.
  // The two chains never meet: nothing that holds the calendar lock or a
  // booking row waits for a subscription row (the claim READS the subscription,
  // unlocked: photographers/bookable.ts says why that is safe), and nothing that
  // holds a subscription row waits for a booking. No calendar lock: a period
  // takes no slot, and periods have an exclusion constraint of their own.
  if (event.reportedStatus === 'succeeded') {
    if (matched.subscription_id !== null) {
      await tx.$queryRaw`SELECT id FROM subscription WHERE id = ${matched.subscription_id}::uuid FOR UPDATE`;
    } else {
      const subject = feeSubject(matched);
      await lockPhotographerCalendar(tx, subject.photographerId);
      await tx.$queryRaw`SELECT id FROM booking WHERE id = ${subject.bookingId}::uuid FOR UPDATE`;
    }
  }
  const payment = await lockPayment(tx, matched.id);

  // Step 4. One exception to forward-only: a payment WE marked `failed` with no
  // provider verdict behind it (`revivable`), which the provider now reports
  // paid. The money is in the platform's account, so it is counted, and refunded
  // only if extra ("count it, refund only if extra", Phase 4): it takes the
  // success path below exactly as a pending payment would -- a booking fee
  // confirms its booking if the slot is free, else `refund_due`
  // (`late_payment_slot_taken`, `duplicate_payment`); a session fee pays what is
  // still owed, with the overpayment split, or is `refund_due` if wholly extra.
  // Amount and currency are still checked first, and a replay finds it settled
  // and is ignored. Its `failure_reason` is kept: the record of why it was
  // marked failed. The locks are the success path's, in the lock order above:
  // calendar, booking, then this payment.
  const revived = event.reportedStatus === 'succeeded' && (await revivable(tx, payment));
  if ((SETTLED_PAYMENT_STATUSES as readonly string[]).includes(payment.status) && !revived) {
    if (payment.status === 'failed' && event.reportedStatus === 'succeeded') {
      // Ignored by the rule, but money may have moved: the provider's own
      // verdict was a failure, and forward-only stands.
      logs.push({ level: 'error', event: 'webhook_success_for_failed_payment', provider: providerId, paymentId: payment.id, eventRowId });
    }
    return finish('ignored', `payment_${payment.status}`);
  }
  if (event.reportedStatus === null) return finish('ignored', 'unrecognised_status');

  const reported = {
    ...(event.providerRef === null || payment.provider_ref !== null ? {} : { providerRef: event.providerRef }),
    ...(event.method === null ? {} : { method: event.method }),
  };

  if (event.reportedStatus === 'pending') {
    if (payment.status !== 'initiated') return finish('ignored', 'no_transition');
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'pending', ...reported } });
    return finish('applied', 'payment_pending');
  }

  if (event.reportedStatus === 'failed') {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'failed', failureReason: storableText(event.failureReason ?? 'failed', 500), ...reported },
    });
    return finish('applied', 'payment_failed');
  }

  // Succeeded.
  if (event.amount !== null && event.amount !== payment.amount_rwf) {
    logs.push({ level: 'error', event: 'webhook_amount_mismatch', provider: providerId, paymentId: payment.id, eventRowId, expected: payment.amount_rwf, reported: event.amount });
    return finish('ignored', 'amount_mismatch');
  }
  // The same rule for the currency (T3.3). Unstated is accepted, as an
  // unstated amount is: the provider was asked in its own currency.
  const currency = event.currency ?? null;
  if (expectedCurrency !== undefined && currency !== null && currency !== expectedCurrency.toUpperCase()) {
    logs.push({ level: 'error', event: 'webhook_currency_mismatch', provider: providerId, paymentId: payment.id, eventRowId, expected: expectedCurrency, reported: currency });
    return finish('ignored', 'currency_mismatch');
  }

  const settledAt = (deps.now ?? (() => new Date()))();
  if (revived) {
    logs.push({ level: 'warn', event: 'webhook_success_for_locally_failed_payment', provider: providerId, paymentId: payment.id, failureReason: payment.failure_reason, eventRowId });
  }
  if (payment.kind === 'subscription') {
    // Its period, on top of what is left (R5.3), and the receipt. No earning and
    // no refund, whatever came before it (user decision, Phase 5). The
    // subscription row is already held (the lock order above).
    const added = await addPaidPeriod(tx, settlingSubscription(payment), reported, settledAt);
    logs.push({
      level: 'info',
      event: 'subscription_period_added',
      paymentId: payment.id,
      subscriptionId: payment.subscription_id,
      startsAt: added.startsAt.toISOString(),
      endsAt: added.endsAt.toISOString(),
      eventRowId,
    });
    return finish('applied', revived ? 'subscription_period_added_revived' : 'subscription_period_added');
  }
  const { bookingId } = feeSubject(payment);
  if (payment.kind !== 'booking_fee') {
    // A session fee (Task 20): recorded, receipted, and the photographer told.
    // The booking row is held (the lock order above), and cash, add-ons and new
    // asks all take it: what the booking is worth and what it has collected
    // cannot move while the overpayment is measured.
    const overpaidRwf = await overpaymentOf(tx, payment);
    if (overpaidRwf >= payment.amount_rwf) {
      // None of it was due: owed back whole, and it never earns (CHECK payment_overpaid_range).
      const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
      await refundDue(tx, logs, booking, payment, reported, settledAt, 'duplicate_payment');
      return finish('applied', 'refund_due_duplicate_payment');
    }
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'succeeded', settledAt, overpaidRwf, ...reported } });
    // Its earning, in this transaction (R4.2, T4.1): payable once the shoot has
    // ended, and only the part that was due.
    await recordEarning(tx, payment.id);
    if (overpaidRwf > 0) await flagOverpayment(tx, logs, payment, overpaidRwf);
    await receipt(tx, logs, payment, reported, settledAt);
    // Paid in full after the shoot has begun: the booking completes itself, in
    // this same transaction (item 6, 2026-09-27). A replay never gets here --
    // the payment is settled and step 4 ignores it.
    if (await completeIfSettled(tx, bookingId, settledAt)) return finish('applied', 'payment_succeeded_booking_completed');
    return finish('applied', 'payment_succeeded');
  }

  // The booking row is already held (the lock order above).
  const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });

  const otherFee = await tx.payment.count({
    where: { bookingId: booking.id, kind: 'booking_fee', status: 'succeeded', id: { not: payment.id } },
  });
  if (otherFee > 0) {
    await refundDue(tx, logs, booking, payment, reported, settledAt, 'duplicate_payment');
    return finish('applied', 'refund_due_duplicate_payment');
  }

  if (booking.status === 'pending_payment') {
    // Still in the exclusion predicate, lapsed hold or not: nobody can have
    // claimed the slot without first expiring this booking.
    await confirm(tx, deps, logs, booking, payment, reported, settledAt);
    return finish('applied', 'booking_confirmed');
  }

  if (booking.status === 'expired') {
    // Dead holds in the way do not count as taken (data-model_v2.md §9.2).
    await expireOverlappingStaleHolds(tx, booking.photographerId, booking.startsAt, booking.bufferEndsAt);
    if (await slotOccupied(tx, booking)) {
      await refundDue(tx, logs, booking, payment, reported, settledAt, 'late_payment_slot_taken');
      return finish('applied', 'refund_due_slot_taken');
    }
    await confirm(tx, deps, logs, booking, payment, reported, settledAt);
    return finish('applied', 'booking_reconfirmed');
  }

  // A fee for a booking that is neither waiting nor expired, with no fee of its
  // own: nothing in the system makes one today. The money is recorded; the
  // photographer decides.
  await tx.payment.update({ where: { id: payment.id }, data: { status: 'succeeded', settledAt, ...reported } });
  // Succeeded money earns like any other (R4.2); a refund the photographer
  // decides on later takes it back through the ledger.
  await recordEarning(tx, payment.id);
  logs.push({ level: 'error', event: 'webhook_fee_for_unexpected_booking', paymentId: payment.id, bookingStatus: booking.status, eventRowId });
  return finish('applied', 'payment_succeeded');
}

/**
 * The payment an event names, read WITHOUT a lock: its booking and
 * photographer are all the caller needs from it, to take the booking-side locks
 * first (the lock order in `applyEvent`). `lockPayment` then reads it again,
 * held, and nothing decided here is trusted beyond the ids.
 */
async function matchPayment(tx: Prisma.TransactionClient, providerId: PaymentProviderId, event: ProviderEvent): Promise<PaymentRecord | null> {
  if (event.ourRef !== null && UUID.test(event.ourRef)) {
    const byOurRef = await tx.$queryRaw<PaymentRecord[]>`
      SELECT ${PAYMENT_RECORD_COLUMNS}
        FROM payment p
        LEFT JOIN booking b ON b.id = p.booking_id
       WHERE p.our_ref = ${event.ourRef}::uuid AND p.provider = ${providerId}`;
    if (byOurRef[0] !== undefined) return byOurRef[0];
  }
  if (event.providerRef !== null) {
    const byProviderRef = await tx.$queryRaw<PaymentRecord[]>`
      SELECT ${PAYMENT_RECORD_COLUMNS}
        FROM payment p
        LEFT JOIN booking b ON b.id = p.booking_id
       WHERE p.provider_ref = ${event.providerRef} AND p.provider = ${providerId}`;
    if (byProviderRef[0] !== undefined) return byProviderRef[0];
  }
  return null;
}

/** Read with `LEFT JOIN booking b`: a subscription payment has no booking (Phase 5). */
const PAYMENT_RECORD_COLUMNS = Prisma.sql`
  p.id::text AS id, p.booking_id::text AS booking_id, p.subscription_id::text AS subscription_id,
  b.photographer_id::text AS photographer_id, p.provider, p.kind, p.plan_interval,
  p.status, p.our_ref::text AS our_ref, p.provider_ref, p.method, p.amount_rwf, p.failure_reason`;

/**
 * A fee's booking and photographer. Only a subscription payment has neither:
 * CHECK payment_subject_exactly_one gives every other kind a booking, and a
 * booking always has a photographer.
 */
function feeSubject(payment: PaymentRecord): { bookingId: string; photographerId: string } {
  if (payment.booking_id === null || payment.photographer_id === null) {
    throw new Error(`Payment ${payment.id} (${payment.kind}) has no booking`);
  }
  return { bookingId: payment.booking_id, photographerId: payment.photographer_id };
}

/** A subscription payment as `addPaidPeriod` takes it. CHECKs give it a subscription and a plan. */
function settlingSubscription(payment: PaymentRecord): SettlingSubscriptionPayment {
  const { subscription_id: subscriptionId, plan_interval: planInterval } = payment;
  if (subscriptionId === null || !(PLAN_INTERVALS as readonly (string | null)[]).includes(planInterval)) {
    throw new Error(`Subscription payment ${payment.id} has no subscription or plan`);
  }
  return {
    id: payment.id,
    subscriptionId,
    planInterval: planInterval as PlanInterval,
    amountRwf: payment.amount_rwf,
    ourRef: payment.our_ref,
    providerRef: payment.provider_ref,
  };
}

/**
 * Whether a `failed` payment is one a verified success may revive: failed by
 * US, with no provider verdict behind it, so that a success can only mean the
 * money moved. Every writer of `failure_reason` and what it means:
 *
 *   superseded_by_cash          payments/cash.ts. The photographer recorded cash
 *                               and we voided the open ask. Revived.
 *   provider_timeout            payments/initiate.ts. Our call to the provider
 *                               did not answer within the deadline; the prompt may
 *                               still have reached the payer. Revived.
 *   provider_unavailable: ...   payments/initiate.ts. The call errored without a
 *                               verdict: unreachable, an answer we could not read
 *                               (5xx, no id, no charge), a token or configuration
 *                               failure. Revived. Where the request never left us
 *                               no success can arrive, so including those is
 *                               harmless.
 *   anything else from          A REJECTION: the provider answered the initiation
 *   initiate.ts                 with a refusal (MTN 400/409 as its code or
 *                               `http_400`/`http_409`, Flutterwave's failure codes,
 *                               `redirect_required`), or our own pre-check refused
 *                               before calling (`method_unavailable`,
 *                               `phone_not_rwandan_mobile`). Not revived.
 *   a FAILED event's reason     payments/webhooks.ts. The provider's verdict. Never
 *                               revived: forward-only stands.
 *
 * The reason is matched exactly (or by the `provider_unavailable: ` prefix), and
 * as a second guard the payment must have no FAILED verdict applied from the
 * provider: a provider reason that happened to read `provider_timeout` could
 * otherwise pass for one of ours. One writer ever sets a payment `failed` (each
 * is guarded on a status not yet settled), so the guard costs nothing in the
 * cases it does not catch.
 */
const REVIVABLE_FAILURE_REASONS: ReadonlySet<string> = new Set([SUPERSEDED_BY_CASH, 'provider_timeout']);
const REVIVABLE_FAILURE_PREFIX = 'provider_unavailable: ';

export function locallyFailed(reason: string | null): boolean {
  return reason !== null && (REVIVABLE_FAILURE_REASONS.has(reason) || reason.startsWith(REVIVABLE_FAILURE_PREFIX));
}

async function revivable(tx: Prisma.TransactionClient, payment: PaymentRecord): Promise<boolean> {
  if (payment.status !== 'failed' || !locallyFailed(payment.failure_reason)) return false;
  const verdicts = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM webhook_event
     WHERE provider = ${payment.provider}
       AND status = 'applied'
       AND reported_status = 'failed'
       AND (our_ref = ${payment.our_ref}::uuid OR (${payment.provider_ref}::text IS NOT NULL AND provider_ref = ${payment.provider_ref}))`;
  return verdicts[0]?.n === 0;
}

/**
 * The matched payment, locked and read afresh: its status may have moved while
 * this waited for the booking-side locks (cash voiding an open ask, a
 * cancellation flagging it), and step 4 must judge what it is now. `FOR UPDATE
 * OF p`: the payment row only; the booking row, when needed, is already held.
 */
async function lockPayment(tx: Prisma.TransactionClient, paymentId: string): Promise<PaymentRecord> {
  const rows = await tx.$queryRaw<PaymentRecord[]>`
    SELECT ${PAYMENT_RECORD_COLUMNS}
      FROM payment p
      LEFT JOIN booking b ON b.id = p.booking_id
     WHERE p.id = ${paymentId}::uuid
       FOR UPDATE OF p`;
  const row = rows[0];
  // Payments are never deleted (RESTRICT everywhere), so a matched one is still there.
  if (row === undefined) throw new Error(`Payment ${paymentId} vanished between match and lock`);
  return row;
}

/**
 * Whether another booking of the same photographer holds time overlapping this
 * one's reserved range. Another photographer's booking never does: their
 * calendars are separate, as the exclusion constraint is (R1.3, T1.3).
 */
async function slotOccupied(tx: Prisma.TransactionClient, booking: Booking): Promise<boolean> {
  const rows = await tx.$queryRaw<{ taken: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM booking
       WHERE id <> ${booking.id}::uuid
         AND photographer_id = ${booking.photographerId}::uuid
         AND status = ANY(${[...OCCUPYING_STATUSES]}::text[])
         AND tstzrange(starts_at, buffer_ends_at, '[)')
             && tstzrange(${booking.startsAt}::timestamptz, ${booking.bufferEndsAt}::timestamptz, '[)')
    ) AS taken`;
  return rows[0]?.taken === true;
}

type Reported = { providerRef?: string; method?: string };

async function confirm(
  tx: Prisma.TransactionClient,
  deps: WebhookDeps,
  logs: Record<string, unknown>[],
  booking: Booking,
  payment: PaymentRecord,
  reported: Reported,
  confirmedAt: Date,
): Promise<void> {
  const { token, hash } = (deps.newAccessToken ?? generateAccessToken)();

  await tx.payment.update({ where: { id: payment.id }, data: { status: 'succeeded', settledAt: confirmedAt, ...reported } });
  // The booking fee is payable to the photographer from now on (R4.2, T4.1).
  await recordEarning(tx, payment.id);
  // Raises 23P01 if a writer outside the claim lock took the slot meanwhile;
  // the retry then finds it occupied.
  const confirmed = await tx.booking.update({
    where: { id: booking.id },
    data: {
      status: 'confirmed',
      holdExpiresAt: null,
      confirmedAt,
      accessTokenHash: hash,
      accessTokenExpiresAt: accessTokenExpiry(confirmedAt),
    },
    include: { addons: true, payments: true },
  });

  const totals = bookingTotals(confirmed, confirmed.addons, confirmed.payments);
  const atBooking = await tx.bookingAddon.findMany({
    where: { bookingId: booking.id, stage: 'at_booking' },
    include: { addon: { select: { sortOrder: true, serviceId: true } } },
  });
  // Own add-ons before shared ones, then catalogue order: as the booking was quoted.
  atBooking.sort(
    (a, b) =>
      Number(a.addon.serviceId === null) - Number(b.addon.serviceId === null) ||
      a.addon.sortOrder - b.addon.sortOrder ||
      a.nameSnapshot.localeCompare(b.nameSnapshot),
  );

  const basics = {
    locale: confirmed.locale,
    reference: confirmed.reference,
    clientName: confirmed.contactName,
    serviceName: confirmed.serviceNameSnapshot,
    packageName: confirmed.packageNameSnapshot,
    startsAt: confirmed.startsAt.toISOString(),
    endsAt: confirmed.endsAt.toISOString(),
    locationText: confirmed.locationText,
    paidRwf: totals.collectedRwf,
    outstandingRwf: totals.outstandingRwf,
  };

  await enqueue(tx, {
    kind: 'email',
    template: 'booking_confirmation',
    recipient: confirmed.contactEmail,
    bookingId: confirmed.id,
    dedupeKey: `email:booking_confirmation:${confirmed.id}`,
    // The only place the plaintext token is ever written.
    payload: { ...basics, accessToken: token },
  });

  // The booking's photographer (R1.7): the row takes its photographer_id from the booking.
  const { recipient } = await bookingPhotographerRecipient(tx, confirmed.id);
  await enqueue(tx, {
    kind: 'email',
    template: 'photographer_new_booking',
    recipient,
    bookingId: confirmed.id,
    dedupeKey: `email:photographer_new_booking:${confirmed.id}`,
    payload: {
      ...basics,
      clientEmail: confirmed.contactEmail,
      clientPhone: confirmed.contactPhone,
      partySize: confirmed.partySize,
      specialRequests: confirmed.specialRequests,
      addons: atBooking.map((addon) => ({ name: addon.nameSnapshot, priceRwf: addon.amountRwf })),
      totalRwf: totals.grandTotalRwf,
    },
  });
}

/**
 * How much of a session fee about to succeed is over what the booking is worth:
 * what was due before it (`collectedRwf`, which counts earlier payments only for
 * the part that was due) plus this amount, less the grand total. Read under the
 * booking's row lock, which the caller holds.
 */
async function overpaymentOf(tx: Prisma.TransactionClient, payment: PaymentRecord): Promise<number> {
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: feeSubject(payment).bookingId },
    include: { addons: true, payments: true },
  });
  // Not `succeeded` yet, so not counted; left out all the same, so it can never count twice.
  const others = booking.payments.filter((row) => row.id !== payment.id);
  const totals = bookingTotals(booking, booking.addons, others);
  return Math.max(totals.collectedRwf + payment.amount_rwf - totals.grandTotalRwf, 0);
}

/**
 * Part of a session fee over what the booking is worth (Phase 4 overpayment
 * decision). The payment stays `succeeded` with `overpaid_rwf` set: it is the
 * difference that is owed, not the whole of it. The money is in the platform's
 * account, so the platform sends it back and records it
 * (`/api/platform/refunds`); the photographer is told, with nothing to do.
 */
async function flagOverpayment(
  tx: Prisma.TransactionClient,
  logs: Record<string, unknown>[],
  payment: PaymentRecord,
  overpaidRwf: number,
): Promise<void> {
  const booking = await tx.booking.findUniqueOrThrow({ where: { id: feeSubject(payment).bookingId } });

  logs.push({ level: 'error', event: 'booking_overpaid', paymentId: payment.id, bookingId: booking.id, overpaidRwf });
  await enqueue(tx, {
    kind: 'email',
    template: 'photographer_alert',
    ...(await bookingPhotographerRecipient(tx, booking.id)),
    dedupeKey: `email:photographer_alert:overpayment:${payment.id}`,
    payload: {
      variant: 'refund_due',
      reference: booking.reference,
      clientName: booking.contactName,
      amountRwf: overpaidRwf,
      reason: 'overpayment',
      paymentReference: payment.provider_ref ?? payment.our_ref,
      provider: payment.provider,
      startsAt: booking.startsAt.toISOString(),
    },
  });
}

type RefundReason = 'late_payment_slot_taken' | 'duplicate_payment';

async function refundDue(
  tx: Prisma.TransactionClient,
  logs: Record<string, unknown>[],
  booking: Booking,
  payment: PaymentRecord,
  reported: Reported,
  settledAt: Date,
  reason: RefundReason,
): Promise<void> {
  // The money arrived, so it is settled; it is owed back, so it is `refund_due`.
  // The booking is left exactly as it was.
  const updated = await tx.payment.update({
    where: { id: payment.id },
    data: { status: 'refund_due', settledAt, ...reported },
    select: { providerRef: true, ourRef: true },
  });
  // Never succeeded, so it never earned: the ledger finds nothing to undo. Called
  // all the same, so every path into refund_due goes through it (R4.2).
  await recordRefundDue(tx, payment.id, settledAt);

  await enqueue(tx, {
    kind: 'email',
    template: 'photographer_alert',
    ...(await bookingPhotographerRecipient(tx, booking.id)),
    dedupeKey: `email:photographer_alert:refund_due:${payment.id}`,
    payload: {
      variant: 'refund_due',
      reference: booking.reference,
      clientName: booking.contactName,
      amountRwf: payment.amount_rwf,
      reason,
      paymentReference: updated.providerRef ?? updated.ourRef,
      // The provider that took the money, not the one configured now (spec §6.18).
      provider: payment.provider,
      startsAt: booking.startsAt.toISOString(),
      // A duplicate session fee is told apart from a second booking fee (absent, as before, for a booking fee).
      ...(payment.kind === 'session_fee' ? { paymentKind: 'session_fee' } : {}),
    },
  });
}

/**
 * The client's receipt for a session fee, and the photographer's alert that it
 * arrived (spec §3.5 step 4, plan.md Task 20).
 *
 * The amounts are `bookingTotals()` as this transaction leaves them -- the
 * payment is already `succeeded` above, so `paidRwf` includes it and
 * `outstandingRwf` is what is genuinely left, nought on a booking now paid in
 * full. No booking link: the plaintext of the client's token was never stored
 * (data-model_v2.md §5.9), and the receipt names the link they already have
 * rather than replacing a working one for a courtesy button.
 *
 * A booking fee is not receipted here: its confirmation email is its receipt.
 */
async function receipt(
  tx: Prisma.TransactionClient,
  logs: Record<string, unknown>[],
  payment: PaymentRecord,
  reported: Reported,
  paidAt: Date,
): Promise<void> {
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: feeSubject(payment).bookingId },
    include: { addons: true, payments: true },
  });
  const totals = bookingTotals(booking, booking.addons, booking.payments);
  // `collectedRwf` counts only what was due; an overpaid part still held is
  // money the client paid too, and the receipt says what they actually paid.
  const heldRwf = booking.payments.filter((row) => row.status === 'succeeded').reduce((total, row) => total + overpaymentHeldRwf(row), 0);
  const paymentReference = reported.providerRef ?? payment.provider_ref ?? payment.our_ref;

  await enqueue(tx, {
    kind: 'email',
    template: 'payment_receipt',
    recipient: booking.contactEmail,
    bookingId: booking.id,
    dedupeKey: `email:payment_receipt:${payment.id}`,
    payload: {
      locale: booking.locale,
      reference: booking.reference,
      clientName: booking.contactName,
      serviceName: booking.serviceNameSnapshot,
      packageName: booking.packageNameSnapshot,
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      kind: payment.kind,
      amountRwf: payment.amount_rwf,
      paidAt: paidAt.toISOString(),
      paymentReference,
      totalRwf: totals.grandTotalRwf,
      paidRwf: totals.collectedRwf + heldRwf,
      outstandingRwf: totals.outstandingRwf,
      // `outstandingRwf` is floored at nought, so money over the total would
      // otherwise read as "paid in full" with nothing said about the
      // difference the platform will refund (§6.16, Phase 4 overpayment decision).
      overpaidRwf: heldRwf,
      accessToken: null,
    },
  });

  await enqueue(tx, {
    kind: 'email',
    template: 'photographer_alert',
    ...(await bookingPhotographerRecipient(tx, booking.id)),
    dedupeKey: `email:photographer_alert:payment_received:${payment.id}`,
    payload: {
      variant: 'payment_received',
      reference: booking.reference,
      clientName: booking.contactName,
      kind: payment.kind,
      amountRwf: payment.amount_rwf,
      paidAt: paidAt.toISOString(),
      outstandingRwf: totals.outstandingRwf,
      startsAt: booking.startsAt.toISOString(),
    },
  });
}

// --- Storage ------------------------------------------------------------------------

async function insertReceived(
  prisma: PrismaClient,
  providerId: PaymentProviderId,
  eventId: string,
  event: ProviderEvent,
  payload: string | null,
): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO webhook_event (provider, event_id, event_type, our_ref, provider_ref, reported_status, signature_valid, payload)
    VALUES (${providerId}, ${eventId}, ${storableText(event.eventType, 100)}, ${uuidOrNull(event.ourRef)}::uuid,
            ${event.providerRef}, ${event.reportedStatus}, true, ${payload}::jsonb)
    ON CONFLICT (provider, event_id) DO NOTHING
    RETURNING id::text AS id`;
  return rows[0]?.id ?? null;
}

/** A row that is `ignored` from the moment it is written. */
async function insertSettled(
  prisma: PrismaClient,
  providerId: PaymentProviderId,
  eventId: string,
  event: ProviderEvent | null,
  signatureValid: boolean,
  payload: string | null,
  note: string,
): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO webhook_event (provider, event_id, event_type, our_ref, provider_ref, reported_status, signature_valid, payload,
                               status, processing_error, processed_at)
    VALUES (${providerId}, ${storableText(eventId, 400)}, ${storableText(event?.eventType ?? 'unknown', 100)},
            ${uuidOrNull(event?.ourRef ?? null)}::uuid, ${event?.providerRef == null ? null : storableText(event.providerRef, 100)},
            ${event?.reportedStatus ?? null}, ${signatureValid}, ${payload}::jsonb, 'ignored', ${note}, now())
    RETURNING id::text AS id`;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('The webhook_event insert returned no row');
  return id;
}

function uuidOrNull(value: string | null): string | null {
  return value !== null && UUID.test(value) ? value.toLowerCase() : null;
}

/**
 * The body as JSON when it is JSON, else as the text it was, so nothing sent is
 * lost. JSON nested deeper than `jsonb` or a recursive walk can take is kept as
 * text too: PostgreSQL refuses deep `jsonb` outright (54001), and a stored body
 * must never be the reason a delivery is not stored.
 */
function payloadOf(rawBody: Buffer): unknown {
  const text = rawBody.toString('utf8');
  if (text === '') return null;
  if (nestingExceeds(text, PAYLOAD_MAX_DEPTH)) return { unparsedBody: text };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { unparsedBody: text };
  }
}

/** Whether JSON text opens more than `max` arrays or objects at once. A scan, not a parse: it cannot overflow. */
function nestingExceeds(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === BACKSLASH) i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{') {
      depth += 1;
      if (depth > max) return true;
    } else if (char === ']' || char === '}') {
      depth -= 1;
    }
  }
  return false;
}

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);
const PAYLOAD_MAX_LENGTH = 64_000;
/** No provider body comes near this; PostgreSQL's own limit is far above it. */
const PAYLOAD_MAX_DEPTH = 64;
const BACKSLASH = String.fromCharCode(92);
const TOO_DEEP = '[nested too deeply to store]';

/**
 * JSON text `jsonb` accepts, or null. PostgreSQL refuses a NUL character and a
 * lone surrogate anywhere in `jsonb`, and either would turn storing an
 * unwelcome body into a 500 -- so both become U+FFFD first. Oversized bodies
 * are cut down to a marker rather than stored whole.
 */
function storableJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const json = JSON.stringify(scrub(value));
  if (json === undefined) return null;
  return json.length <= PAYLOAD_MAX_LENGTH ? json : JSON.stringify({ truncatedBody: storableText(json, PAYLOAD_MAX_LENGTH) });
}

/** Bounded in depth, so a payload handed over already parsed (a status lookup's) cannot overflow either. */
function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return storableText(value, Number.MAX_SAFE_INTEGER);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= PAYLOAD_MAX_DEPTH) return TOO_DEEP;
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [storableText(key, Number.MAX_SAFE_INTEGER), scrub(entry, depth + 1)]),
  );
}

/** Text PostgreSQL stores: no NUL, no lone surrogate, at most `max` UTF-16 units, never cut mid-pair. */
function storableText(value: string, max: number): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    const safe = char === NUL || (char.length === 1 && code >= 0xd800 && code <= 0xdfff) ? REPLACEMENT : char;
    if (out.length + safe.length > max) break;
    out += safe;
  }
  return out;
}

function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

function defaultLog(entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') console.error(line);
  else console.log(line);
}
