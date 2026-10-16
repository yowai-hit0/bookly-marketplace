import type { Prisma, PrismaClient } from '@prisma/client';
import { accessTokenExpiry, generateAccessToken } from '../booking/access-token.js';
import { type AdminBooking, findAdminBooking } from '../booking/admin-view.js';
import { bookingTotals } from '../booking/totals.js';
import { enqueue } from '../outbox/enqueue.js';
import { CALL_IN_FLIGHT_SECONDS, PAYMENT_ATTEMPT_WINDOW_SECONDS } from './initiate.js';
import type { PaymentProviderId } from './provider.js';

/**
 * "Request session fee" (plan.md Task 20; spec §3.5 step 3, §6.15): the
 * photographer asks for what is left, and the client is emailed the amount and
 * a link to pay it on their own booking page.
 *
 * The request *is* the payment row. It is written `initiated` with the amount
 * outstanding at that moment, and that figure is then frozen: it is what the
 * client was asked for, so add-ons added afterwards do not quietly change the
 * bill in their inbox (data-model_v2.md §6.2). When the client pays,
 * `startSessionFeePayment` finds this row and uses its amount rather than
 * opening another. Nothing is charged here and no provider is called -- this
 * asks, it does not collect.
 *
 * An add-on added after a session fee has *succeeded* is a second request
 * (spec §6.15): a settled payment is never edited, so this writes another row
 * for the new difference. Only `booking_fee` is limited to one success by the
 * partial unique index, so a booking can carry as many session fees as it took.
 *
 * The email carries a **new** access token. The plaintext of the old one was
 * never stored (data-model_v2.md §5.9), and a request for money whose payment
 * link the client has to go hunting for is a request that does not get paid --
 * so this issues a link the way a resend does (spec §6.21), and the newest
 * email is the one that works.
 */

export type SessionFeeDeps = {
  prisma: PrismaClient;
  /** Whose row this is if the client pays it (spec §6.18). */
  providerId: PaymentProviderId;
  now: () => Date;
};

export type SessionFeeResult =
  | { status: 'ok'; booking: AdminBooking }
  | { status: 'not_found' }
  /** A booking that owes nothing because it no longer stands (§6.1). */
  | { status: 'not_allowed' }
  /** Nothing outstanding: paid in full, or never anything to pay. */
  | { status: 'nothing_to_pay' }
  /** A prompt is on the payer's phone; a second request is how one gets paid twice. */
  | { status: 'in_progress' };

type Outcome = Exclude<SessionFeeResult, { status: 'ok' }>['status'] | 'ok';

/** Statuses that can still owe money (`bookingTotals`, data-model_v2.md §6.1). */
export const PAYABLE_STATUSES = ['confirmed', 'completed'];

type BookingRow = {
  id: string;
  status: string;
  package_price_rwf: number;
  reference: string;
  locale: string;
  contact_name: string;
  contact_email: string;
  service_name_snapshot: string;
  package_name_snapshot: string;
  starts_at: Date;
  ends_at: Date;
};

export type AttemptRow = {
  id: string;
  status: string;
  amount_rwf: number;
  provider: string;
  recent: boolean;
  in_flight: boolean;
  /** An ask of ours, already emailed -- not an attempt somebody started. */
  requested: boolean;
};

export async function requestSessionFee(deps: SessionFeeDeps, bookingId: string): Promise<SessionFeeResult> {
  const { prisma, providerId } = deps;
  const now = deps.now();
  const { token, hash } = generateAccessToken();

  const outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
    // Locked for the same reason the client's own attempt locks it: two
    // requests at once must not become two rows for the same money.
    const bookings = await tx.$queryRaw<BookingRow[]>`
      SELECT id::text AS id, status, package_price_rwf, reference, locale, contact_name, contact_email,
             service_name_snapshot, package_name_snapshot, starts_at, ends_at
        FROM booking
       WHERE id = ${bookingId}::uuid
         FOR UPDATE`;
    const booking = bookings[0];
    if (booking === undefined) return 'not_found';
    if (!PAYABLE_STATUSES.includes(booking.status)) return 'not_allowed';

    const [addons, payments] = await Promise.all([
      tx.bookingAddon.findMany({ where: { bookingId: booking.id }, select: { stage: true, amountRwf: true } }),
      tx.payment.findMany({ where: { bookingId: booking.id }, select: { status: true, amountRwf: true } }),
    ]);
    const { outstandingRwf } = bookingTotals(
      { status: booking.status, packagePriceRwf: booking.package_price_rwf },
      addons,
      payments,
    );
    if (outstandingRwf <= 0) return 'nothing_to_pay';

    const latest = await latestSessionFee(tx, booking.id);
    if (moneyMoving(latest)) return 'in_progress';

    // Asking again for the same amount is a reminder, not a second bill: the
    // row the client was already sent is the one the email points at. A row for
    // another amount, or another provider, is not that request any more.
    const repeat =
      latest !== undefined && latest.status === 'initiated' && latest.provider === providerId && latest.amount_rwf === outstandingRwf
        ? latest
        : null;
    const payment = repeat ?? (await openRequest(tx, booking.id, providerId, outstandingRwf));

    // The link in the email has to work, and only a new token can (§6.21).
    await tx.booking.update({
      where: { id: booking.id },
      data: { accessTokenHash: hash, accessTokenExpiresAt: accessTokenExpiry(now), accessTokenLastUsedAt: null },
    });

    await enqueue(tx, {
      kind: 'email',
      template: 'session_fee_request',
      recipient: booking.contact_email,
      bookingId: booking.id,
      // Keyed by the token it carries: every ask is its own message, and a
      // reminder never silently vanishes as a duplicate of the first one.
      dedupeKey: `email:session_fee_request:${payment.id}:${hash.slice(0, 16)}`,
      payload: {
        locale: booking.locale,
        reference: booking.reference,
        clientName: booking.contact_name,
        serviceName: booking.service_name_snapshot,
        packageName: booking.package_name_snapshot,
        startsAt: booking.starts_at.toISOString(),
        endsAt: booking.ends_at.toISOString(),
        // The amount asked for, not the amount outstanding when it is read.
        amountRwf: payment.amount_rwf,
        // Which row this ask is for: how both readers tell an ask waiting to be
        // paid from an attempt whose provider call is still running. Not
        // rendered -- the template keeps only the fields it draws.
        paymentId: payment.id,
        // The only place this plaintext exists (data-model_v2.md §5.9).
        accessToken: token,
      },
    });
    return 'ok';
  });

  if (outcome !== 'ok') return { status: outcome };
  const booking = await findAdminBooking(prisma, bookingId);
  return booking === null ? { status: 'not_found' } : { status: 'ok', booking };
}

/** The row the client will pay: everything the database can supply, it does. */
async function openRequest(
  tx: Prisma.TransactionClient,
  bookingId: string,
  providerId: PaymentProviderId,
  amountRwf: number,
): Promise<{ id: string; amount_rwf: number }> {
  const inserted = await tx.$queryRaw<{ id: string; amount_rwf: number }[]>`
    INSERT INTO payment (booking_id, kind, provider, amount_rwf)
    VALUES (${bookingId}::uuid, 'session_fee', ${providerId}, ${amountRwf})
    RETURNING id::text AS id, amount_rwf`;
  const payment = inserted[0];
  if (payment === undefined) throw new Error('The payment insert returned no row');
  return payment;
}

/**
 * The booking's newest session-fee row, locked. The window is the database's,
 * as everywhere money is claimed: an app clock that drifts must not decide
 * whether a prompt is still live.
 */
export async function latestSessionFee(tx: Prisma.TransactionClient, bookingId: string): Promise<AttemptRow | undefined> {
  const attempts = await tx.$queryRaw<AttemptRow[]>`
    SELECT p.id::text AS id, p.status, p.amount_rwf, p.provider,
           p.initiated_at > now() - make_interval(secs => ${PAYMENT_ATTEMPT_WINDOW_SECONDS}::double precision) AS recent,
           p.initiated_at > now() - make_interval(secs => ${CALL_IN_FLIGHT_SECONDS}::double precision) AS in_flight,
           EXISTS (
             SELECT 1
               FROM outbox o
              WHERE o.booking_id = p.booking_id
                AND o.template = 'session_fee_request'
                AND o.payload->>'paymentId' = p.id::text
           ) AS requested
      FROM payment p
     WHERE p.booking_id = ${bookingId}::uuid
       AND p.kind = 'session_fee'
     ORDER BY p.initiated_at DESC
     LIMIT 1
       FOR UPDATE OF p`;
  return attempts[0];
}

/**
 * Money may be moving: a prompt on the payer's phone, or an attempt whose
 * provider call has not answered yet (payments/initiate.ts). Asking now would
 * rotate the token out from under the page they are paying on, and recording
 * cash now could take the same balance twice (item 7), so both wait for that
 * attempt to end. An ask of our own blocks nothing: asking twice is a
 * reminder, and the client has not started anything.
 */
export function moneyMoving(latest: AttemptRow | undefined): boolean {
  return (
    latest !== undefined &&
    ((latest.recent && latest.status === 'pending') || (latest.in_flight && latest.status === 'initiated' && !latest.requested))
  );
}
