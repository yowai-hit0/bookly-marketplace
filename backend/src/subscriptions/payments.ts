import type { Prisma } from '@prisma/client';
import { enqueue } from '../outbox/enqueue.js';
import { photographerRecipient } from '../outbox/recipients.js';
import { CARD_SESSION_SECONDS } from '../payments/flutterwave-checkout.js';
import { PAYMENT_ATTEMPT_WINDOW_SECONDS, type StartPaymentDeps, attemptPayment, reopensCardSession } from '../payments/initiate.js';
import { type CardSession, type CheckoutPayer, type PaymentMethod, knownPaymentMethod } from '../payments/provider.js';
import { getPlatformSettings } from '../settings/index.js';
import { type PlanInterval, addPlanInterval, planPrice } from './plan.js';

/**
 * Paying for the subscription (marketplace-spec.md R5.2, R5.3, T5.3;
 * marketplace-data-model.md §2.11, §3.7).
 *
 * Starting a payment is the booking fee's machinery (payments/initiate.ts): the
 * `payment` row is written and committed first -- `kind = 'subscription'`, the
 * subscription for its subject, the plan frozen in `plan_interval` -- then the
 * provider the photographer's method routes to (payments/routing.ts, R3.1) is
 * called outside any transaction, and the webhook or the reconciler settles it
 * (payments/webhooks.ts). MoMo or card (Flutterwave v3 Inline, 2026-10-30).
 *
 *   - The AMOUNT is the platform's price for the chosen interval, read inside the
 *     transaction (`platform_setting`); nothing in the request names an amount
 *     (T5.3).
 *   - ONE PAYMENT IN PROGRESS per subscription: the subscription row is locked
 *     `FOR UPDATE`, so two initiations at once serialise and the second finds the
 *     first (T5.3). In progress means `initiated` or `pending` and younger than
 *     the attempt window, as for a booking fee: a prompt nobody ever answers must
 *     not lock the photographer out for good. An older one that settles anyway
 *     still adds its period (below).
 *   - ANY subscription status may pay, `expired` included: paying is the way back.
 *     A photographer who is not approved -- pending, or suspended -- may not.
 *   - A CARD attempt is the booking fee's (payments/initiate.ts): no provider
 *     call, a `CardSession` in the answer (the payer is the photographer's login
 *     address, display name and contact phone), and a second card tap for the
 *     SAME plan while its checkout session is open answers the same row
 *     (`card_in_progress`). Another plan, or another method, meets the window
 *     rule above.
 *
 * Settling (`addPaidPeriod`, called by the webhook path under its locks): a paid
 * period starting at `greatest(now, current_period_ends_at)` and lasting one
 * month or one year on the Kigali calendar, the subscription's end and status
 * moved with it, and a `subscription_receipt` -- one transaction (R5.3).
 *
 * The user's decision on double payments (Phase 5): EVERY successful subscription
 * payment adds its period on top, like an early payment, and none is ever
 * refunded -- a late success, a duplicate, and one revived under the Phase 4
 * rules (a locally failed attempt the provider later reports paid) alike. No
 * subscription payment ever creates a payout item: the money is the platform's
 * (payouts/ledger.ts `EARNING_PAYMENT_KINDS`), and none is ever overpaid or
 * `refund_due`.
 */

export type StartSubscriptionPaymentRequest = {
  /** From the verified studio token (R1.4), never from the request. */
  photographerId: string;
  planInterval: PlanInterval;
  method: PaymentMethod;
  /** Normalised by `normalizePhone`; empty for a card. */
  payerPhone: string;
};

export type StartSubscriptionPaymentResult =
  | { status: 'started'; ourRef: string; amountRwf: number; planInterval: PlanInterval; card?: CardSession }
  /** The same plan's card checkout, still open: the same row again (cards). */
  | { status: 'card_in_progress'; ourRef: string; amountRwf: number; planInterval: PlanInterval; card: CardSession }
  /** Pending (not yet approved) or suspended: a subscription is only for an approved studio. */
  | { status: 'photographer_not_approved' }
  /** Approved, but no subscription: an invariant the approval and the backfill keep; answered, not thrown. */
  | { status: 'no_subscription' }
  /** Another payment of this subscription is still waiting on the payer. */
  | { status: 'in_progress'; ourRef: string; method: PaymentMethod | null }
  | { status: 'provider_failed'; ourRef: string; outcome: 'rejected' | 'unavailable'; amountRwf: number; planInterval: PlanInterval };

type Opened =
  | { status: 'opened'; paymentId: string; ourRef: string; amountRwf: number; handle: string; card?: CardSession }
  | Extract<StartSubscriptionPaymentResult, { status: 'photographer_not_approved' | 'no_subscription' | 'in_progress' | 'card_in_progress' }>;

export async function startSubscriptionPayment(
  deps: StartPaymentDeps,
  request: StartSubscriptionPaymentRequest,
): Promise<StartSubscriptionPaymentResult> {
  const { prisma, provider } = deps;

  const opened = await prisma.$transaction(async (tx): Promise<Opened> => {
    // Read, not locked: as at the booking fee's initiation, the provider is
    // called after this transaction anyway, so no lock could keep a suspension
    // from landing before the prompt. An attempt started before one still settles.
    const photographers = await tx.$queryRaw<{ status: string; handle: string; display_name: string; contact_phone: string | null; email: string }[]>`
      SELECT ph.status, ph.handle, ph.display_name, ph.contact_phone, u.email
        FROM photographer ph
        JOIN app_user u ON u.id = ph.user_id
       WHERE ph.id = ${request.photographerId}::uuid`;
    const photographer = photographers[0];
    if (photographer === undefined || photographer.status !== 'approved') return { status: 'photographer_not_approved' };
    // Flutterwave's receipt goes to the login address: the photographer's own, not the public contact one.
    const payer: CheckoutPayer = { email: photographer.email, name: photographer.display_name, phone: photographer.contact_phone };

    // THE lock: two initiations for one subscription queue here, and the second
    // sees the first's committed row below (T5.3). The lock order of the
    // subscription's money is in payments/webhooks.ts.
    const subscriptions = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM subscription WHERE photographer_id = ${request.photographerId}::uuid FOR UPDATE`;
    const subscription = subscriptions[0];
    if (subscription === undefined) return { status: 'no_subscription' };

    // Measured on the database clock, like the booking fee's window.
    const waiting = await tx.$queryRaw<
      { our_ref: string; status: string; provider: string; method: string | null; amount_rwf: number; plan_interval: string; recent: boolean; session_seconds_left: number }[]
    >`
      SELECT our_ref::text AS our_ref, status, provider, method, amount_rwf, plan_interval,
             initiated_at > now() - make_interval(secs => ${PAYMENT_ATTEMPT_WINDOW_SECONDS}::double precision) AS recent,
             floor(${CARD_SESSION_SECONDS}::double precision - extract(epoch FROM now() - initiated_at))::int AS session_seconds_left
        FROM payment
       WHERE subscription_id = ${subscription.id}::uuid
         AND status IN ('initiated', 'pending')
         AND initiated_at > now() - make_interval(secs => ${Math.max(PAYMENT_ATTEMPT_WINDOW_SECONDS, CARD_SESSION_SECONDS)}::double precision)
       ORDER BY initiated_at DESC
       LIMIT 1`;
    const latest = waiting[0];
    if (latest !== undefined && latest.plan_interval === request.planInterval && reopensCardSession(latest, request.method, provider)) {
      return {
        status: 'card_in_progress',
        ourRef: latest.our_ref,
        amountRwf: latest.amount_rwf,
        planInterval: request.planInterval,
        card: { amountRwf: latest.amount_rwf, sessionSeconds: latest.session_seconds_left, payer },
      };
    }
    if (latest?.recent === true) return { status: 'in_progress', ourRef: latest.our_ref, method: knownPaymentMethod(latest.method) };

    // The server's price, read here: whatever the request carried is never read (T5.3).
    const amountRwf = planPrice(await getPlatformSettings(tx), request.planInterval);
    const inserted = await tx.$queryRaw<{ id: string; our_ref: string; amount_rwf: number }[]>`
      INSERT INTO payment (subscription_id, kind, provider, method, amount_rwf, plan_interval)
      VALUES (${subscription.id}::uuid, 'subscription', ${provider.id}, ${request.method}, ${amountRwf}, ${request.planInterval})
      RETURNING id::text AS id, our_ref::text AS our_ref, amount_rwf`;
    const payment = inserted[0];
    if (payment === undefined) throw new Error('The payment insert returned no row');
    const card: CardSession | undefined = request.method === 'card' ? { amountRwf: payment.amount_rwf, sessionSeconds: CARD_SESSION_SECONDS, payer } : undefined;
    return { status: 'opened', paymentId: payment.id, ourRef: payment.our_ref, amountRwf: payment.amount_rwf, handle: photographer.handle, ...(card === undefined ? {} : { card }) };
  });

  if (opened.status !== 'opened') return opened;
  const attempted = await attemptPayment(deps, opened, {
    method: request.method,
    payerPhone: request.payerPhone,
    reference: `SUB-${opened.handle}`,
    kind: 'subscription',
  });
  const plan = { amountRwf: opened.amountRwf, planInterval: request.planInterval };
  if (attempted.status === 'started') return { ...attempted, ...plan, ...(opened.card === undefined ? {} : { card: opened.card }) };
  return { ...attempted, ...plan };
}

/** A subscription payment the webhook path has matched, locked and is about to settle. */
export type SettlingSubscriptionPayment = {
  id: string;
  subscriptionId: string;
  planInterval: PlanInterval;
  amountRwf: number;
  ourRef: string;
  providerRef: string | null;
};

export type AddedPeriod = { periodId: string; startsAt: Date; endsAt: Date };

/**
 * A succeeded subscription payment's period (R5.3), in the webhook's
 * transaction, which already holds the subscription row and then the payment
 * row (the lock order in payments/webhooks.ts `applyEvent`) and has checked the
 * amount and currency.
 *
 * The payment becomes `succeeded`; a paid period of its plan starts at
 * `greatest(paidAt, current_period_ends_at)` -- so paying early, or twice, adds
 * time on top -- and ends one month or year later on the Kigali calendar; the
 * subscription's end moves to it and its status becomes `active` (a past_due or
 * expired subscription is live again at once); and the receipt is queued. No
 * payout item, ever. A replay never reaches this (the payment is settled), and
 * the period's unique `payment_id` would refuse a second one anyway.
 */
export async function addPaidPeriod(
  tx: Prisma.TransactionClient,
  payment: SettlingSubscriptionPayment,
  reported: { providerRef?: string; method?: string },
  paidAt: Date,
): Promise<AddedPeriod> {
  const subscription = await tx.subscription.findUniqueOrThrow({
    where: { id: payment.subscriptionId },
    select: { id: true, photographerId: true, currentPeriodEndsAt: true, photographer: { select: { displayName: true } } },
  });

  await tx.payment.update({ where: { id: payment.id }, data: { status: 'succeeded', settledAt: paidAt, ...reported } });

  const startsAt = new Date(Math.max(paidAt.getTime(), subscription.currentPeriodEndsAt.getTime()));
  const endsAt = addPlanInterval(startsAt, payment.planInterval);
  const period = await tx.subscriptionPeriod.create({
    data: {
      subscriptionId: subscription.id,
      kind: 'paid',
      planInterval: payment.planInterval,
      priceRwf: payment.amountRwf,
      startsAt,
      endsAt,
      paymentId: payment.id,
    },
    select: { id: true },
  });
  await tx.subscription.update({ where: { id: subscription.id }, data: { currentPeriodEndsAt: endsAt, status: 'active' } });

  const recipient = await photographerRecipient(tx, subscription.photographerId);
  if (recipient !== null) {
    await enqueue(tx, {
      kind: 'email',
      template: 'subscription_receipt',
      ...recipient,
      dedupeKey: `email:subscription_receipt:${payment.id}`,
      payload: {
        displayName: subscription.photographer.displayName,
        planInterval: payment.planInterval,
        amountRwf: payment.amountRwf,
        paidAt: paidAt.toISOString(),
        paymentReference: reported.providerRef ?? payment.providerRef ?? payment.ourRef,
        periodStartsAt: startsAt.toISOString(),
        periodEndsAt: endsAt.toISOString(),
      },
    });
  }
  return { periodId: period.id, startsAt, endsAt };
}
