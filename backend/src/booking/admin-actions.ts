import type { Prisma, PrismaClient } from '@prisma/client';
import { isSlotTaken, isTransactionConflict } from '../db/errors.js';
import { enqueue } from '../outbox/enqueue.js';
import { getSettings } from '../settings/index.js';
import { issueAccessToken } from './access-link.js';
import { hashAccessToken } from './access-token.js';
import { type AdminBooking, findAdminBooking } from './admin-view.js';
import { expireOverlappingStaleHolds } from './claim.js';
import { bookingTotals } from './totals.js';

/**
 * What the photographer does to a booking after it exists (plan.md Task 19;
 * spec §3.6, §6.11, §6.12, §6.16, §6.21): move it, cancel it, close it, or
 * send the client their link again.
 *
 * Each action is one transaction that carries its consequences with it -- the
 * status, the money it flags, and the email that announces it -- so a booking
 * is never cancelled without the client being told, and never told without
 * being cancelled.
 *
 * The photographer moves no money here either (spec §6.16). Cancelling marks
 * what is owed back `refund_due` and alerts him; `refunded` is his own record
 * of having sent it, taken by `payments/refund.ts`.
 */

export type AdminActionDeps = { prisma: PrismaClient; now: () => Date };

export type AdminActionResult =
  | { status: 'ok'; booking: AdminBooking }
  | { status: 'not_found' }
  /** The booking is not in a state this action applies to. */
  | { status: 'not_allowed' }
  /** Completing it with money still owed: "completed" means paid (2026-09-27). */
  | { status: 'balance_due' };

export type RescheduleResult = AdminActionResult | { status: 'slot_taken' } | { status: 'unchanged' };

/** A deadlock with the sweeper or a claim is retried, as in `claimSlot`. */
const MAX_ATTEMPTS = 3;
const TRANSACTION_MAX_WAIT_MS = 10_000;
const TRANSACTION_TIMEOUT_MS = 15_000;
const MS_PER_MINUTE = 60_000;

/**
 * Moves a confirmed booking to a new start (spec §3.6 step 2, §6.11).
 *
 * The booking keeps its id, reference, access token and every payment: it is
 * the same booking at a different time. `ends_at` follows the package's own
 * duration snapshot and `buffer_ends_at` is recomputed from it with the buffer
 * in force now -- a stale buffer would either hold time the booking no longer
 * occupies or break its own CHECK (data-model_v2.md §5.9). `original_starts_at`
 * records the first move only, so the time originally agreed survives repeated
 * moves.
 *
 * The old slot is released by the same UPDATE that takes the new one, and the
 * exclusion constraint is what decides whether the new one was free: a 23P01
 * surfaces here as `slot_taken`, never as a 500.
 */
export async function rescheduleBooking(deps: AdminActionDeps, bookingId: string, startsAt: Date): Promise<RescheduleResult> {
  const booking = await findAdminBooking(deps.prisma, bookingId);
  if (booking === null) return { status: 'not_found' };
  if (booking.status !== 'confirmed') return { status: 'not_allowed' };
  if (booking.startsAt.getTime() === startsAt.getTime()) return { status: 'unchanged' };

  const now = deps.now();
  const { bufferMinutes } = await getSettings(deps.prisma);
  const endsAt = new Date(startsAt.getTime() + booking.packageDurationMinutes * MS_PER_MINUTE);
  const bufferEndsAt = new Date(endsAt.getTime() + bufferMinutes * MS_PER_MINUTE);

  for (let attempt = 1; ; attempt += 1) {
    try {
      const moved = await deps.prisma.$transaction(
        async (tx) => {
          // The lock every writer into a slot takes, so a move and a claim
          // queue rather than deadlock on each other's uncommitted rows.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bookly.claim_slot'))`;
          await expireOverlappingStaleHolds(tx, startsAt, bufferEndsAt);

          const { count } = await tx.booking.updateMany({
            // Guarded on what was read: a cancellation or another move in the
            // same moment wins, and this one changes nothing.
            where: { id: booking.id, status: 'confirmed', startsAt: booking.startsAt },
            data: {
              startsAt,
              endsAt,
              bufferEndsAt,
              originalStartsAt: booking.originalStartsAt ?? booking.startsAt,
              rescheduledAt: now,
            },
          });
          if (count === 0) return false;

          await enqueue(tx, {
            kind: 'email',
            template: 'reschedule',
            recipient: booking.contactEmail,
            bookingId: booking.id,
            // Every move is its own message: a booking may be moved twice.
            // The target time is in the key too, so two moves that share a
            // millisecond are still two messages rather than one silently lost.
            dedupeKey: `email:reschedule:${booking.id}:${now.toISOString()}:${startsAt.toISOString()}`,
            payload: {
              locale: booking.locale,
              reference: booking.reference,
              clientName: booking.contactName,
              serviceName: booking.serviceNameSnapshot,
              packageName: booking.packageNameSnapshot,
              startsAt: startsAt.toISOString(),
              endsAt: endsAt.toISOString(),
              previousStartsAt: booking.startsAt.toISOString(),
              previousEndsAt: booking.endsAt.toISOString(),
              locationText: booking.locationText,
              // The booking keeps its token, and the plaintext is long gone:
              // the email points at the link the client already has.
              accessToken: null,
            },
          });
          return true;
        },
        { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: TRANSACTION_TIMEOUT_MS },
      );

      if (!moved) return { status: 'not_allowed' };
      return await reload(deps, booking.id);
    } catch (error) {
      if (isSlotTaken(error)) return { status: 'slot_taken' };
      if (isTransactionConflict(error) && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}

/**
 * The photographer cancels (spec §3.6, §6.11, A-5): the slot is released, the
 * client is told, and **every** payment collected is flagged for a full refund
 * -- the booking fee he is refunding by policy, and a session fee that is now
 * for a shoot that will not happen.
 */
export async function cancelByAdmin(deps: AdminActionDeps, bookingId: string, reason: string | null): Promise<AdminActionResult> {
  const booking = await findAdminBooking(deps.prisma, bookingId);
  if (booking === null) return { status: 'not_found' };
  if (booking.status !== 'confirmed') return { status: 'not_allowed' };
  const now = deps.now();

  const cancelled = await deps.prisma.$transaction(async (tx) => {
    const { count } = await tx.booking.updateMany({
      where: { id: booking.id, status: 'confirmed' },
      data: { status: 'cancelled_by_admin', cancelledAt: now, cancellationReason: reason },
    });
    if (count === 0) return false;

    const refunded = await flagRefunds(tx, booking);
    await enqueue(tx, {
      kind: 'email',
      template: 'cancellation',
      recipient: booking.contactEmail,
      bookingId: booking.id,
      dedupeKey: `email:cancellation:${booking.id}`,
      payload: {
        locale: booking.locale,
        reference: booking.reference,
        clientName: booking.contactName,
        serviceName: booking.serviceNameSnapshot,
        packageName: booking.packageNameSnapshot,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        cancelledBy: 'admin',
        reason,
        bookingFeeRwf: booking.bookingFeeRwf,
        refundRwf: refunded.reduce((total, payment) => total + payment.amountRwf, 0),
      },
    });

    const admin = await adminRecipient(tx);
    if (admin === null) return true;
    for (const payment of refunded) {
      await enqueue(tx, {
        kind: 'email',
        template: 'admin_alert',
        recipient: admin,
        dedupeKey: `email:admin_alert:refund_due:${payment.id}`,
        payload: {
          variant: 'refund_due',
          reference: booking.reference,
          clientName: booking.contactName,
          amountRwf: payment.amountRwf,
          reason: 'admin_cancelled',
          paymentReference: payment.providerRef ?? payment.ourRef,
          provider: payment.provider,
          startsAt: booking.startsAt.toISOString(),
        },
      });
    }
    return true;
  });

  if (!cancelled) return { status: 'not_allowed' };
  return reload(deps, booking.id);
}

/**
 * The shoot happened (spec §3.5 step 1). Task 20 builds on `completed_at`.
 * Refused as `balance_due` while anything is owed (2026-09-27): a booking
 * that is paid in full after its shoot completes by itself
 * (`auto-complete.ts`), and one that is not waits for the money.
 */
export async function markCompleted(deps: AdminActionDeps, bookingId: string): Promise<AdminActionResult> {
  return close(deps, bookingId, 'completed', { completedAt: deps.now() });
}

/**
 * The client did not come (spec §6.12). The slot is **not** released -- the time
 * was consumed, and `no_show` stays in the exclusion predicate -- the booking
 * fee stays `succeeded` and forfeited, no session fee is owed (which
 * `bookingTotals()` decides), and nothing is emailed to the client.
 */
export async function markNoShow(deps: AdminActionDeps, bookingId: string): Promise<AdminActionResult> {
  return close(deps, bookingId, 'no_show', {});
}

async function close(
  deps: AdminActionDeps,
  bookingId: string,
  status: 'completed' | 'no_show',
  extra: Prisma.BookingUpdateManyMutationInput,
): Promise<AdminActionResult> {
  const booking = await findAdminBooking(deps.prisma, bookingId);
  if (booking === null) return { status: 'not_found' };
  // Only a confirmed booking whose shoot has begun can be closed either way.
  if (booking.status !== 'confirmed' || booking.startsAt > deps.now()) return { status: 'not_allowed' };

  const closed = await deps.prisma.$transaction(async (tx): Promise<'ok' | 'not_allowed' | 'balance_due'> => {
    // The lock every money edit takes (add-ons, payments, auto-complete): an
    // add-on landing while this runs waits, so the balance read here is the
    // one the booking completes with.
    await tx.$queryRaw`SELECT 1 FROM booking WHERE id = ${booking.id}::uuid FOR UPDATE`;
    if (status === 'completed') {
      const [addons, payments] = await Promise.all([
        tx.bookingAddon.findMany({ where: { bookingId: booking.id }, select: { stage: true, amountRwf: true } }),
        tx.payment.findMany({ where: { bookingId: booking.id }, select: { status: true, amountRwf: true } }),
      ]);
      const totals = bookingTotals({ status: booking.status, packagePriceRwf: booking.packagePriceRwf }, addons, payments);
      if (totals.outstandingRwf > 0) return 'balance_due';
    }
    const { count } = await tx.booking.updateMany({
      where: { id: booking.id, status: 'confirmed' },
      data: { status, ...extra },
    });
    return count === 0 ? 'not_allowed' : 'ok';
  });
  if (closed !== 'ok') return { status: closed };
  return reload(deps, booking.id);
}

/**
 * A new link for a client who lost theirs (spec §6.21, P-29). The new token
 * replaces the old hash, so the previous link stops working the moment this
 * commits -- one live link per booking, structurally.
 */
export async function resendAccessLink(deps: AdminActionDeps, bookingId: string): Promise<AdminActionResult> {
  const booking = await findAdminBooking(deps.prisma, bookingId);
  if (booking === null) return { status: 'not_found' };
  // Nothing to resend for a booking that was never confirmed: it has no link.
  if (booking.confirmedAt === null) return { status: 'not_allowed' };

  const now = deps.now();

  await deps.prisma.$transaction(async (tx) => {
    const token = await issueAccessToken(tx, booking.id, now);
    await enqueue(tx, {
      kind: 'email',
      template: 'access_link_resend',
      recipient: booking.contactEmail,
      bookingId: booking.id,
      // Each resend is its own message; the previous one stays in the history.
      // Keyed by the token it carries, because a resend whose email were
      // dropped as a duplicate would leave the client holding a dead link.
      dedupeKey: `email:access_link_resend:${booking.id}:${hashAccessToken(token).slice(0, 16)}`,
      payload: {
        locale: booking.locale,
        reference: booking.reference,
        clientName: booking.contactName,
        serviceName: booking.serviceNameSnapshot,
        packageName: booking.packageNameSnapshot,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        // The only place this plaintext exists (data-model_v2.md §5.9).
        accessToken: token,
      },
    });
  });

  return reload(deps, booking.id);
}

/** Money collected that is now owed back. Returns what it flagged. */
async function flagRefunds(tx: Prisma.TransactionClient, booking: AdminBooking): Promise<AdminBooking['payments']> {
  const flagged: AdminBooking['payments'] = [];
  for (const payment of booking.payments.filter((row) => row.status === 'succeeded')) {
    const { count } = await tx.payment.updateMany({ where: { id: payment.id, status: 'succeeded' }, data: { status: 'refund_due' } });
    if (count === 1) flagged.push(payment);
  }
  return flagged;
}

async function adminRecipient(tx: Prisma.TransactionClient): Promise<string | null> {
  const admin = await tx.adminUser.findFirst({ orderBy: { createdAt: 'asc' }, select: { email: true } });
  return admin?.email ?? null;
}

/** The booking as it now stands, which is what every action answers with. */
async function reload(deps: AdminActionDeps, bookingId: string): Promise<AdminActionResult> {
  const booking = await findAdminBooking(deps.prisma, bookingId);
  return booking === null ? { status: 'not_found' } : { status: 'ok', booking };
}
