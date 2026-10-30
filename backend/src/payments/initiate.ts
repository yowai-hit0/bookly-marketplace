import { Prisma, type PrismaClient } from '@prisma/client';
import { bookingTotals, TOTALS_PAYMENT_SELECT } from '../booking/totals.js';
import { BOOKABLE_SQL } from '../photographers/bookable.js';
import { CARD_REUSE_MIN_SECONDS, CARD_SESSION_SECONDS } from './flutterwave-checkout.js';
import { type CardSession, type CheckoutPayer, type PaymentKind, type PaymentMethod, type PaymentProvider, PaymentProviderError, knownPaymentMethod } from './provider.js';

/**
 * Starting a booking-fee payment (plan.md Task 16; spec §3.1 step 9,
 * data-model_v2.md §5.11, §7.2).
 *
 * The payment row is written and committed -- `initiated`, with its `our_ref`
 * -- before the provider hears a word, so an attempt that never reaches the
 * provider, or dies halfway, is still on record. Its `amount_rwf` is the
 * booking's frozen `booking_fee_rwf` and is never written again.
 *
 * Then the provider is called, outside any transaction: a slow provider must not
 * hold a row lock or a pooled connection. Accepted, the row is `pending` and
 * waits for the webhook (Task 17). Refused, unreachable or too slow, it is
 * `failed` with the reason, and the booking is untouched: still
 * `pending_payment`, its hold still running, free to try again.
 *
 * The provider is the one the client's method routes to (marketplace-spec.md
 * R3.1, payments/routing.ts): the route picks it, never a deployment-wide
 * default. The method itself is written on the row with the attempt, so the
 * record says how the client chose to pay before any provider answers.
 *
 * A new booking fee needs a photographer who can still be booked (R3.4, T3.4):
 * one suspended, or out of subscription (R5.4: the period's end compared with
 * the database clock directly), since the hold was taken is
 * `photographer_unavailable`, and no money is asked for. A session
 * fee is not refused: it is owed on a booking that already stands, and
 * existing bookings carry on whatever the photographer's status (R5.5, T9.2).
 *
 * CARDS (Flutterwave v3 Inline, 2026-10-30). The provider makes no call: the
 * row goes straight to `pending` and the answer carries a `CardSession` -- the
 * row's amount, the payer from the booking's snapshot, and how long the
 * browser's checkout may stay open -- from which the route builds the Inline
 * config. "One payment in progress" holds:
 *
 *   - A card attempt still inside its checkout session (`CARD_SESSION_SECONDS`
 *     from its initiation, at least `CARD_REUSE_MIN_SECONDS` left) answers a
 *     second card tap with the SAME row: same `our_ref`, so the same `tx_ref`,
 *     and a session cut to what is left of the first, so a reopened modal
 *     never outlives it (`card_in_progress`). No second payment is started.
 *   - Mixing methods follows the rules above unchanged: inside the attempt
 *     window, any waiting attempt answers any other method `in_progress`.
 *   - ABANDONMENT: a modal closed unpaid never blocks for good. Past the attempt
 *     window another method may start; past the session, a new card attempt
 *     gets a new row (and a new `tx_ref`), and the reconciler closes the old
 *     one `card_session_expired` once the session is over (payments/reconcile.ts).
 *     A late success on it still counts: revived like any failure of ours, and
 *     owed back if extra (`duplicate_payment`), as a stale MoMo prompt is.
 *   - A booking fee's session also ends with the hold, so a card checkout opened
 *     near the end of a hold cannot run on past it (beyond Inline's one-minute
 *     floor); a payment after the hold takes the late-payment rules as any does.
 */

/**
 * How long a waiting attempt blocks a new one. A second prompt while the first
 * is still on the payer's phone is how a deposit gets paid twice. Past this,
 * the payer has plainly moved on (a mistyped number, a dismissed prompt), and a
 * payment that settles late anyway is caught as a duplicate and flagged for
 * refund by the webhook. A developer default, not a spec value.
 */
export const PAYMENT_ATTEMPT_WINDOW_SECONDS = 180;
/** Past this the provider call is abandoned and the attempt recorded as failed. */
export const PROVIDER_CALL_TIMEOUT_MS = 30_000;
/**
 * How long an `initiated` session fee may still be an attempt in progress.
 *
 * The provider is called outside the transaction, so a second tap can find a
 * row whose call has not answered yet. Only an attempt, though: a row the
 * photographer asked for (payments/session-fee.ts) is never a call in flight,
 * however new it is -- it sits there precisely so the client can pay the amount
 * it froze, often within seconds of the email arriving.
 */
export const CALL_IN_FLIGHT_SECONDS = PROVIDER_CALL_TIMEOUT_MS / 1000;

/**
 * Whether a session-fee row is an ask the client was emailed, rather than an
 * attempt somebody started: the request email names the payment it asks for.
 *
 * Written as SQL both readers share (payments/session-fee.ts writes the row and
 * the message in one transaction, so the two are never seen apart).
 */
const REQUESTED = Prisma.sql`
  EXISTS (
    SELECT 1
      FROM outbox o
     WHERE o.booking_id = p.booking_id
       AND o.template = 'session_fee_request'
       AND o.payload->>'paymentId' = p.id::text
  )`;
/**
 * Whether an ask the client has started paying may still have its provider
 * call running: the attempt wrote the method and stamped `updated_at`, on the
 * database clock, as it opened (R3.1). An ask nobody attempted has no method.
 */
export const ATTEMPT_IN_FLIGHT = Prisma.sql`
  (p.method IS NOT NULL AND p.updated_at > now() - make_interval(secs => ${CALL_IN_FLIGHT_SECONDS}::double precision))`;
const FAILURE_REASON_MAX_LENGTH = 500;

export type StartPaymentDeps = {
  prisma: PrismaClient;
  provider: PaymentProvider;
  timeoutMs?: number;
};

export type StartSessionFeeDeps = StartPaymentDeps;

export type StartSessionFeeRequest = {
  /** The booking the client's token addressed; never taken from a caller's parameter. */
  bookingId: string;
  /** For the payer's statement line only. */
  reference: string;
  method: PaymentMethod;
  payerPhone: string;
};

export type StartPaymentRequest = {
  reference: string;
  method: PaymentMethod;
  /** Normalised by `normalizePhone`; empty for a card. */
  payerPhone: string;
};

export type StartPaymentResult =
  /** `card` for a card attempt: what the browser's checkout needs (payments/card-checkout.ts). */
  | { status: 'started'; ourRef: string; card?: CardSession }
  /** A card attempt still in its session, answered again instead of starting a second (cards). */
  | { status: 'card_in_progress'; ourRef: string; card: CardSession }
  | { status: 'not_found' }
  /** A booking fee already succeeded: the 409 of plan.md Task 16. */
  | { status: 'already_paid' }
  /** The hold lapsed, or the booking is no longer waiting for payment. */
  | { status: 'hold_expired' }
  /** A zero booking fee has nothing to collect, and a payment row cannot be zero. */
  | { status: 'nothing_to_pay' }
  /** An earlier attempt is still waiting on the payer. */
  | { status: 'in_progress'; ourRef: string; method: PaymentMethod | null }
  /** The booking fee of a photographer who can no longer be booked (R3.4); never a session fee. */
  | { status: 'photographer_unavailable' }
  | { status: 'provider_failed'; ourRef: string; outcome: 'rejected' | 'unavailable' };

type OpenedAttempt =
  | { status: 'opened'; paymentId: string; ourRef: string; amountRwf: number; card?: CardSession }
  | Exclude<StartPaymentResult, { status: 'started' } | { status: 'provider_failed' }>;

/** A waiting attempt, with what deciding about it takes (the card rules above). */
type WaitingRow = {
  our_ref: string;
  status: string;
  provider: string;
  method: string | null;
  amount_rwf: number;
  /** Inside the attempt window: blocks any other attempt. */
  recent: boolean;
  /** What is left of a card checkout session opened with this row, on the database clock. */
  session_seconds_left: number;
};

/** The columns of `WaitingRow`, for `payment p`. */
const WAITING_COLUMNS = Prisma.sql`
  p.our_ref::text AS our_ref, p.status, p.provider, p.method, p.amount_rwf,
  p.initiated_at > now() - make_interval(secs => ${PAYMENT_ATTEMPT_WINDOW_SECONDS}::double precision) AS recent,
  floor(${CARD_SESSION_SECONDS}::double precision - extract(epoch FROM now() - p.initiated_at))::int AS session_seconds_left`;
/** How far back a waiting attempt can still matter: the longer of the attempt window and a card session. */
const WAITING_HORIZON_SECONDS = Math.max(PAYMENT_ATTEMPT_WINDOW_SECONDS, CARD_SESSION_SECONDS);

/**
 * Whether a waiting row is a card checkout the same card tap may reopen: the
 * same provider, a card attempt not yet settled, with a session worth reopening.
 */
export function reopensCardSession(row: Pick<WaitingRow, 'status' | 'provider' | 'method' | 'session_seconds_left'>, method: PaymentMethod, provider: PaymentProvider): boolean {
  return (
    method === 'card' &&
    row.method === 'card' &&
    row.provider === provider.id &&
    (row.status === 'pending' || row.status === 'initiated') &&
    row.session_seconds_left >= CARD_REUSE_MIN_SECONDS
  );
}

/** A card session for `method`, else nothing: the seconds are capped by the session's own length. */
function cardSessionFor(method: PaymentMethod, amountRwf: number, secondsLeft: number, payer: CheckoutPayer): CardSession | undefined {
  if (method !== 'card') return undefined;
  return { amountRwf, sessionSeconds: Math.max(Math.min(secondsLeft, CARD_SESSION_SECONDS), 0), payer };
}

/** The booking's contact snapshot, as Inline's `customer` takes it. */
type ContactColumns = { contact_name: string; contact_email: string; contact_phone: string | null };
function bookingPayer(row: ContactColumns): CheckoutPayer {
  return { email: row.contact_email, name: row.contact_name, phone: row.contact_phone };
}

export async function startBookingFeePayment(deps: StartPaymentDeps, request: StartPaymentRequest): Promise<StartPaymentResult> {
  const { prisma, provider } = deps;

  const opened = await prisma.$transaction(async (tx): Promise<OpenedAttempt> => {
    // Locked, so two taps on "Pay" serialise here and the second sees the first.
    // The photographer and subscription rows are read, not locked: the provider
    // is called after this transaction anyway, so no lock could keep a
    // suspension from landing between the check and the prompt -- the check is
    // that nobody is asked to pay for a photographer already unavailable (R3.4).
    const bookings = await tx.$queryRaw<
      ({ id: string; status: string; booking_fee_rwf: number; hold_live: boolean; hold_seconds_left: number | null; bookable: boolean } & ContactColumns)[]
    >`
      SELECT b.id::text AS id, b.status, b.booking_fee_rwf,
             (b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now()) AS hold_live,
             floor(extract(epoch FROM b.hold_expires_at - now()))::int AS hold_seconds_left,
             b.contact_name, b.contact_email, b.contact_phone,
             ${BOOKABLE_SQL} AS bookable
        FROM booking b
        JOIN photographer ph ON ph.id = b.photographer_id
        LEFT JOIN subscription s ON s.photographer_id = ph.id
       WHERE b.reference = ${request.reference}
         FOR UPDATE OF b`;
    const booking = bookings[0];
    if (booking === undefined) return { status: 'not_found' };

    const paid = await tx.payment.count({ where: { bookingId: booking.id, kind: 'booking_fee', status: 'succeeded' } });
    if (paid > 0) return { status: 'already_paid' };
    // Measured on the database clock, like the hold itself (booking/claim.ts).
    if (booking.status !== 'pending_payment' || !booking.hold_live) return { status: 'hold_expired' };
    // The one rule (photographers/bookable.ts), on the database clock (R3.4, T3.4, R5.4).
    if (!booking.bookable) return { status: 'photographer_unavailable' };
    if (booking.booking_fee_rwf <= 0) return { status: 'nothing_to_pay' };

    const waiting = await tx.$queryRaw<WaitingRow[]>`
      SELECT ${WAITING_COLUMNS}
        FROM payment p
       WHERE p.booking_id = ${booking.id}::uuid
         AND p.kind = 'booking_fee'
         AND p.status IN ('initiated', 'pending')
         AND p.initiated_at > now() - make_interval(secs => ${WAITING_HORIZON_SECONDS}::double precision)
       ORDER BY p.initiated_at DESC
       LIMIT 1`;
    const latest = waiting[0];
    // The hold ends the card session too (above).
    const holdLeft = booking.hold_seconds_left ?? 0;
    if (latest !== undefined && reopensCardSession(latest, request.method, provider)) {
      return { status: 'card_in_progress', ourRef: latest.our_ref, card: { amountRwf: latest.amount_rwf, sessionSeconds: Math.min(latest.session_seconds_left, holdLeft), payer: bookingPayer(booking) } };
    }
    if (latest?.recent === true) return { status: 'in_progress', ourRef: latest.our_ref, method: knownPaymentMethod(latest.method) };

    // Every value the database can supply, it does: `our_ref`, `status`, `initiated_at`.
    const inserted = await tx.$queryRaw<{ id: string; our_ref: string; amount_rwf: number }[]>`
      INSERT INTO payment (booking_id, kind, provider, method, amount_rwf)
      VALUES (${booking.id}::uuid, 'booking_fee', ${provider.id}, ${request.method}, ${booking.booking_fee_rwf})
      RETURNING id::text AS id, our_ref::text AS our_ref, amount_rwf`;
    const payment = inserted[0];
    if (payment === undefined) throw new Error('The payment insert returned no row');
    const card = cardSessionFor(request.method, payment.amount_rwf, Math.min(CARD_SESSION_SECONDS, holdLeft), bookingPayer(booking));
    return { status: 'opened', paymentId: payment.id, ourRef: payment.our_ref, amountRwf: payment.amount_rwf, ...(card === undefined ? {} : { card }) };
  });

  if (opened.status !== 'opened') return opened;
  return withCard(await attemptPayment(deps, opened, { ...request, kind: 'booking_fee' }), opened.card);
}

/** A started card attempt carries its session; anything else is as `attemptPayment` said. */
export function withCard(result: AttemptResult, card: CardSession | undefined): StartPaymentResult {
  return result.status === 'started' && card !== undefined ? { ...result, card } : result;
}

/**
 * Paying the session fee from the client's own booking page (plan.md Task 18;
 * spec §3.5 step 4, §3.9, §6.15).
 *
 * The amount is what `bookingTotals()` makes outstanding as the attempt opens,
 * except where the photographer has already asked for an amount and nobody has
 * attempted it: that is the figure the client was sent, and the one they pay
 * (data-model_v2.md §6.2). The rest is the booking fee's path -- a row first,
 * the provider second, the webhook last.
 */
export async function startSessionFeePayment(
  deps: StartSessionFeeDeps,
  request: StartSessionFeeRequest,
): Promise<StartPaymentResult> {
  const { prisma, provider } = deps;

  const opened = await prisma.$transaction(async (tx): Promise<OpenedAttempt> => {
    // The package's own price, from the booking that froze it: never a number
    // the caller passed in, and never a live catalogue row (spec §6.13).
    const bookings = await tx.$queryRaw<({ id: string; status: string; package_price_rwf: number } & ContactColumns)[]>`
      SELECT id::text AS id, status, package_price_rwf, contact_name, contact_email, contact_phone
        FROM booking
       WHERE id = ${request.bookingId}::uuid
         FOR UPDATE`;
    const booking = bookings[0];
    if (booking === undefined) return { status: 'not_found' };
    // A booking that no longer stands owes nothing (data-model_v2.md §6.1).
    if (booking.status !== 'confirmed' && booking.status !== 'completed') return { status: 'nothing_to_pay' };

    const [addons, payments] = await Promise.all([
      tx.bookingAddon.findMany({ where: { bookingId: booking.id }, select: { stage: true, amountRwf: true } }),
      tx.payment.findMany({
        where: { bookingId: booking.id },
        select: { kind: true, ...TOTALS_PAYMENT_SELECT },
      }),
    ]);
    const { outstandingRwf } = bookingTotals({ ...booking, packagePriceRwf: booking.package_price_rwf }, addons, payments);
    if (outstandingRwf <= 0) return { status: 'nothing_to_pay' };

    // The window is the database's, as the booking fee's is: an app clock that
    // drifts from it must not decide whether an attempt is still in flight.
    const attempts = await tx.$queryRaw<
      {
        id: string;
        our_ref: string;
        status: string;
        amount_rwf: number;
        provider: string;
        method: string | null;
        recent: boolean;
        in_flight: boolean;
        attempt_in_flight: boolean;
        requested: boolean;
        session_seconds_left: number;
      }[]
    >`
      SELECT p.id::text AS id, p.our_ref::text AS our_ref, p.status, p.amount_rwf, p.provider, p.method,
             floor(${CARD_SESSION_SECONDS}::double precision - extract(epoch FROM now() - p.updated_at))::int AS session_seconds_left,
             p.initiated_at > now() - make_interval(secs => ${PAYMENT_ATTEMPT_WINDOW_SECONDS}::double precision) AS recent,
             p.initiated_at > now() - make_interval(secs => ${CALL_IN_FLIGHT_SECONDS}::double precision) AS in_flight,
             ${ATTEMPT_IN_FLIGHT} AS attempt_in_flight,
             ${REQUESTED} AS requested
        FROM payment p
       WHERE p.booking_id = ${booking.id}::uuid
         AND p.kind = 'session_fee'
       ORDER BY p.initiated_at DESC
       LIMIT 1
         FOR UPDATE OF p`;
    const latest = attempts[0];
    const payer = bookingPayer(booking);
    // A card checkout still open is answered again, never doubled (cards, above).
    // Its session is timed from the attempt (`updated_at`, stamped by it), since
    // an ask the photographer made days ago may have been attempted only now.
    // Never past what is owed: a row asking for more than is now outstanding is
    // left to the rules below, which open one for the right amount.
    if (latest !== undefined && latest.amount_rwf <= outstandingRwf && reopensCardSession(latest, request.method, provider)) {
      return { status: 'card_in_progress', ourRef: latest.our_ref, card: { amountRwf: latest.amount_rwf, sessionSeconds: latest.session_seconds_left, payer } };
    }
    // A prompt still on the payer's phone blocks a second one -- but only while
    // it can still be answered. A `pending` row nothing ever settles would
    // otherwise lock the client out of their own payment for good.
    if (latest !== undefined && latest.recent && latest.status === 'pending') {
      return { status: 'in_progress', ourRef: latest.our_ref, method: knownPaymentMethod(latest.method) };
    }
    // An `initiated` row young enough that its provider call may still be
    // running is that call, not a second one: prompting again here is how a
    // fee gets paid twice. An ask is never that call, however new: it is the
    // row this payment is meant to settle -- until the client attempts it.
    // Then the call on it is timed from the attempt (R3.1: a second tap under
    // another method must not prompt a second provider while the first may
    // still be asking the payer).
    if (latest !== undefined && latest.status === 'initiated' && (latest.requested ? latest.attempt_in_flight : latest.in_flight)) {
      return { status: 'in_progress', ourRef: latest.our_ref, method: knownPaymentMethod(latest.method) };
    }
    // The photographer's request, made and never attempted: its amount is the
    // one the client was asked for, whatever has been added since (spec §6.15).
    //
    // Not what has been *taken off*, though: a request left asking for more
    // than the booking is now worth is stale, and billing it would overpay the
    // client by construction. That opens a fresh attempt for what is really
    // owed, which is also the figure their own page is showing them.
    //
    // The request was recorded against the provider of the first method on
    // offer (payments/routing.ts `requestProvider`): the photographer cannot
    // know how the client will pay. The client's method decides (R3.1), so an
    // ask nobody has ever attempted -- no method on it yet -- moves to the
    // provider that method routes to, keeping its frozen amount. A row that
    // has been attempted is never moved: some provider may have it, and only
    // that provider's answer may settle it (spec §6.18).
    if (latest?.status === 'initiated' && latest.amount_rwf <= outstandingRwf) {
      const reroutable = latest.requested && latest.method === null;
      if (latest.provider === provider.id || reroutable) {
        // `updated_at` on the database clock: it times the attempt now starting (ATTEMPT_IN_FLIGHT).
        await tx.$executeRaw`
          UPDATE payment SET provider = ${provider.id}, method = ${request.method}, updated_at = now() WHERE id = ${latest.id}::uuid`;
        const card = cardSessionFor(request.method, latest.amount_rwf, CARD_SESSION_SECONDS, payer);
        return { status: 'opened', paymentId: latest.id, ourRef: latest.our_ref, amountRwf: latest.amount_rwf, ...(card === undefined ? {} : { card }) };
      }
    }

    const inserted = await tx.$queryRaw<{ id: string; our_ref: string; amount_rwf: number }[]>`
      INSERT INTO payment (booking_id, kind, provider, method, amount_rwf)
      VALUES (${booking.id}::uuid, 'session_fee', ${provider.id}, ${request.method}, ${outstandingRwf})
      RETURNING id::text AS id, our_ref::text AS our_ref, amount_rwf`;
    const payment = inserted[0];
    if (payment === undefined) throw new Error('The payment insert returned no row');
    const card = cardSessionFor(request.method, payment.amount_rwf, CARD_SESSION_SECONDS, payer);
    return { status: 'opened', paymentId: payment.id, ourRef: payment.our_ref, amountRwf: payment.amount_rwf, ...(card === undefined ? {} : { card }) };
  });

  if (opened.status !== 'opened') return opened;
  return withCard(await attemptPayment(deps, opened, { ...request, kind: 'session_fee' }), opened.card);
}

/** What calling the provider for an attempt on record came to. */
export type AttemptResult = { status: 'started'; ourRef: string } | { status: 'provider_failed'; ourRef: string; outcome: 'rejected' | 'unavailable' };

/**
 * Calls the provider for an attempt already on record, and writes down what it
 * said. Outside every transaction: a slow provider must not hold a row lock.
 * Shared by the booking fee, the session fee and the subscription payment
 * (subscriptions/payments.ts, R5.2): one deadline, one record of a refusal, and
 * one vocabulary of failure reasons -- the one the webhook's revival rule reads
 * (payments/webhooks.ts `locallyFailed`).
 *
 * `reference` is for the payer's statement line only: the booking reference, or
 * for a subscription `SUB-<handle>`.
 */
export async function attemptPayment(
  deps: StartPaymentDeps,
  opened: { paymentId: string; ourRef: string; amountRwf: number },
  request: { method: PaymentMethod; payerPhone: string; reference: string; kind: PaymentKind },
): Promise<AttemptResult> {
  const { prisma, provider } = deps;

  let failure: { outcome: 'rejected' | 'unavailable'; reason: string } | null = null;
  try {
    const result = await withDeadline(
      (signal) =>
        provider.initiate(
          {
            ourRef: opened.ourRef,
            amountRwf: opened.amountRwf,
            method: request.method,
            payerPhone: request.payerPhone,
            kind: request.kind,
            bookingReference: request.reference,
          },
          signal,
        ),
      deps.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS,
    );
    if (result.outcome === 'accepted') {
      // Guarded: a webhook quick enough to have settled the row already wins.
      await prisma.payment.updateMany({
        where: { id: opened.paymentId, status: 'initiated' },
        data: { status: 'pending', ...(result.providerRef === null ? {} : { providerRef: result.providerRef }) },
      });
      return { status: 'started', ourRef: opened.ourRef };
    }
    failure = { outcome: 'rejected', reason: result.reason };
  } catch (error) {
    failure = { outcome: 'unavailable', reason: unavailableReason(error) };
  }

  await prisma.payment.updateMany({
    where: { id: opened.paymentId, status: 'initiated' },
    data: { status: 'failed', failureReason: storable(failure.reason) },
  });
  return { status: 'provider_failed', ourRef: opened.ourRef, outcome: failure.outcome };
}

/** Our own provider errors say what happened; anything else is named, never quoted. */
function unavailableReason(error: unknown): string {
  if (error instanceof PaymentProviderError) return `provider_unavailable: ${error.message}`;
  if (error instanceof ProviderTimeoutError) return 'provider_timeout';
  return `provider_unavailable: ${error instanceof Error ? error.name : 'error'}`;
}

class ProviderTimeoutError extends Error {
  override readonly name = 'ProviderTimeoutError';
}

/** Runs `call` with an abort signal, and gives up at the deadline even if it ignores the signal. */
async function withDeadline<T>(call: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderTimeoutError(`No answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([call(controller.signal), deadline]);
  } catch (error) {
    // The provider noticed the abort first: still a timeout.
    if (controller.signal.aborted) throw new ProviderTimeoutError(`No answer within ${timeoutMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

function storable(reason: string): string {
  return reason.split(NUL).join(REPLACEMENT).slice(0, FAILURE_REASON_MAX_LENGTH);
}
