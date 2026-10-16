import { randomUUID } from 'node:crypto';
import type { Booking, Prisma, PrismaClient } from '@prisma/client';
import { type AccessToken, accessTokenExpiry, generateAccessToken } from '../booking/access-token.js';
import { completeIfSettled } from '../booking/auto-complete.js';
import { expireOverlappingStaleHolds } from '../booking/claim.js';
import { bookingTotals } from '../booking/totals.js';
import { isSlotTaken, isTransactionConflict } from '../db/errors.js';
import { OCCUPYING_STATUSES } from '../db/statuses.js';
import { enqueue } from '../outbox/enqueue.js';
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
 * if its slot is still free, checked under the slot-claim lock; otherwise the
 * booking stays `expired`, the payment is `refund_due`, and the photographer is
 * told at once. A second fee for a booking that already has one is the same
 * kind of money: owed back, and flagged.
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
    const applied = await applyWithRetry(deps, providerId, eventRowId, event);
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

async function applyWithRetry(deps: WebhookDeps, providerId: PaymentProviderId, eventRowId: string, event: ProviderEvent): Promise<Applied> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.prisma.$transaction((tx) => applyEvent(tx, deps, providerId, eventRowId, event), {
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
  booking_id: string;
  provider: string;
  kind: string;
  status: PaymentStatus;
  our_ref: string;
  provider_ref: string | null;
  method: string | null;
  amount_rwf: number;
};

async function applyEvent(
  tx: Prisma.TransactionClient,
  deps: WebhookDeps,
  providerId: PaymentProviderId,
  eventRowId: string,
  event: ProviderEvent,
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

  // A success may confirm a booking into its slot, so it queues behind slot
  // claims -- the same lock, taken first, so the two can never wait on each other.
  if (event.reportedStatus === 'succeeded') {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bookly.claim_slot'))`;
  }

  // Step 3.
  const payment = await matchPayment(tx, providerId, event);
  if (payment === null) return finish('ignored', 'no_matching_payment');

  // Step 4.
  if ((SETTLED_PAYMENT_STATUSES as readonly string[]).includes(payment.status)) {
    if (payment.status === 'failed' && event.reportedStatus === 'succeeded') {
      // Ignored by the rule, but money may have moved: a request we recorded as
      // timed out can still be approved on the payer's phone.
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

  const settledAt = (deps.now ?? (() => new Date()))();
  if (payment.kind !== 'booking_fee') {
    // A session fee (Task 20): recorded, receipted, and the photographer told.
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'succeeded', settledAt, ...reported } });
    await flagOverpayment(tx, logs, payment);
    await receipt(tx, logs, payment, reported, settledAt);
    // Paid in full after the shoot has begun: the booking completes itself, in
    // this same transaction (item 6, 2026-09-27). A replay never gets here --
    // the payment is settled and step 4 ignores it.
    if (await completeIfSettled(tx, payment.booking_id, settledAt)) return finish('applied', 'payment_succeeded_booking_completed');
    return finish('applied', 'payment_succeeded');
  }

  await tx.$queryRaw`SELECT id FROM booking WHERE id = ${payment.booking_id}::uuid FOR UPDATE`;
  const booking = await tx.booking.findUniqueOrThrow({ where: { id: payment.booking_id } });

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
    await expireOverlappingStaleHolds(tx, booking.startsAt, booking.bufferEndsAt);
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
  logs.push({ level: 'error', event: 'webhook_fee_for_unexpected_booking', paymentId: payment.id, bookingStatus: booking.status, eventRowId });
  return finish('applied', 'payment_succeeded');
}

async function matchPayment(tx: Prisma.TransactionClient, providerId: PaymentProviderId, event: ProviderEvent): Promise<PaymentRecord | null> {
  if (event.ourRef !== null && UUID.test(event.ourRef)) {
    const byOurRef = await tx.$queryRaw<PaymentRecord[]>`
      SELECT id::text AS id, booking_id::text AS booking_id, provider, kind, status, our_ref::text AS our_ref, provider_ref, method, amount_rwf
        FROM payment
       WHERE our_ref = ${event.ourRef}::uuid AND provider = ${providerId}
         FOR UPDATE`;
    if (byOurRef[0] !== undefined) return byOurRef[0];
  }
  if (event.providerRef !== null) {
    const byProviderRef = await tx.$queryRaw<PaymentRecord[]>`
      SELECT id::text AS id, booking_id::text AS booking_id, provider, kind, status, our_ref::text AS our_ref, provider_ref, method, amount_rwf
        FROM payment
       WHERE provider_ref = ${event.providerRef} AND provider = ${providerId}
         FOR UPDATE`;
    if (byProviderRef[0] !== undefined) return byProviderRef[0];
  }
  return null;
}

/** Whether any other booking holds time overlapping this one's reserved range. */
async function slotOccupied(tx: Prisma.TransactionClient, booking: Booking): Promise<boolean> {
  const rows = await tx.$queryRaw<{ taken: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM booking
       WHERE id <> ${booking.id}::uuid
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

  const admin = await adminRecipient(tx);
  if (admin === null) {
    logs.push({ level: 'error', event: 'admin_new_booking_skipped', reason: 'no_admin_user', bookingId: confirmed.id });
    return;
  }
  await enqueue(tx, {
    kind: 'email',
    template: 'admin_new_booking',
    recipient: admin,
    bookingId: confirmed.id,
    dedupeKey: `email:admin_new_booking:${confirmed.id}`,
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
 * Money over what the booking is worth -- a second payment for a fee already
 * settled, or one that arrived after the amount was collected another way --
 * is owed back. The payment itself stays `succeeded`: it is the difference
 * that is owed, not the whole of it, and only the photographer can send it
 * (spec §6.16).
 */
async function flagOverpayment(
  tx: Prisma.TransactionClient,
  logs: Record<string, unknown>[],
  payment: PaymentRecord,
): Promise<void> {
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: payment.booking_id },
    include: { addons: true, payments: true },
  });
  const totals = bookingTotals(booking, booking.addons, booking.payments);
  const overpaidRwf = totals.collectedRwf - totals.grandTotalRwf;
  if (overpaidRwf <= 0) return;

  logs.push({ level: 'error', event: 'booking_overpaid', paymentId: payment.id, bookingId: booking.id, overpaidRwf });
  const admin = await adminRecipient(tx);
  if (admin === null) {
    logs.push({ level: 'error', event: 'overpaid_alert_skipped', reason: 'no_admin_user', paymentId: payment.id });
    return;
  }
  await enqueue(tx, {
    kind: 'email',
    template: 'admin_alert',
    recipient: admin,
    dedupeKey: `email:admin_alert:overpayment:${payment.id}`,
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

  const admin = await adminRecipient(tx);
  if (admin === null) {
    logs.push({ level: 'error', event: 'refund_due_alert_skipped', reason: 'no_admin_user', paymentId: payment.id });
    return;
  }
  await enqueue(tx, {
    kind: 'email',
    template: 'admin_alert',
    recipient: admin,
    dedupeKey: `email:admin_alert:refund_due:${payment.id}`,
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
    where: { id: payment.booking_id },
    include: { addons: true, payments: true },
  });
  const totals = bookingTotals(booking, booking.addons, booking.payments);
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
      paidRwf: totals.collectedRwf,
      outstandingRwf: totals.outstandingRwf,
      // `outstandingRwf` is floored at nought, so money over the total would
      // otherwise read as "paid in full" with nothing said about the
      // difference the photographer has just been told to refund (§6.16).
      overpaidRwf: Math.max(totals.collectedRwf - totals.grandTotalRwf, 0),
      accessToken: null,
    },
  });

  const admin = await adminRecipient(tx);
  if (admin === null) {
    logs.push({ level: 'error', event: 'payment_received_alert_skipped', reason: 'no_admin_user', paymentId: payment.id });
    return;
  }
  await enqueue(tx, {
    kind: 'email',
    template: 'admin_alert',
    recipient: admin,
    dedupeKey: `email:admin_alert:payment_received:${payment.id}`,
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

/** The photographer: the one admin account (spec §2.1), oldest first should there ever be two. */
async function adminRecipient(tx: Prisma.TransactionClient): Promise<string | null> {
  const admin = await tx.adminUser.findFirst({ orderBy: { createdAt: 'asc' }, select: { email: true } });
  return admin?.email ?? null;
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
