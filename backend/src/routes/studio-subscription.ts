import { Router } from 'express';
import { z } from 'zod';
import type { AuthDeps } from '../auth/account-auth.js';
import { photographerLocals } from '../auth/middleware.js';
import type { PaymentCheck } from '../payments/card-check.js';
import { cardConfig, cardReturnPaths, cardTitles } from '../payments/card-checkout.js';
import { type PaymentRouting, routePayments } from '../payments/routing.js';
import { startSubscriptionPayment } from '../subscriptions/payments.js';
import { PLAN_INTERVALS } from '../subscriptions/plan.js';
import { studioSubscription, studioSubscriptionPayment } from '../subscriptions/views.js';
import { paymentBodyParser } from './payment-body.js';

/**
 * The studio's subscription page (marketplace-spec.md R5.2, R5.3, R7.2, T5.3),
 * behind `requirePhotographer`; everything is the signed-in photographer's own
 * (R1.4). All `Cache-Control: no-store`.
 *
 *   GET  /subscription
 *        200 { subscription: { id, status, currentPeriodEndsAt, graceEndsAt,
 *              takingBookings, currentPeriod, periods, paymentInProgress } | null,
 *              prices: { monthly, yearly }, methods, graceDays }
 *
 *   POST /subscription/payments   { planInterval, method, phone }  (no phone for card)
 *        201 { payment: { ourRef, status: 'pending', planInterval, amountRwf } }
 *        201 { payment, card }   method card: the Flutterwave Inline config, back to
 *            `/studio/subscription/payments/:ourRef` (payments/card-checkout.ts)
 *        200 { payment, card }   a card checkout for the SAME plan is still open: the same one
 *        409 photographer_not_approved   pending or suspended
 *        409 no_subscription             approved with none (never, by the approval and the backfill)
 *        409 payment_in_progress { payment: { ourRef, method } }   another still waits on the payer
 *        400 invalid_request                a plan that is neither monthly nor yearly, a missing field
 *        422 validation_failed { fields }   a method not on offer, an unusable number
 *        502 payment_not_started { reason: rejected | unavailable,
 *                                  payment: { ourRef, status: 'failed' } }
 *
 *   GET  /subscription/payments/:ourRef[?transactionId=]
 *        200 { payment: { ourRef, status, planInterval, amountRwf, method, failure,
 *              initiatedAt, settledAt }, subscription: { status, currentPeriodEndsAt, takingBookings } }
 *            A pending card payment of this photographer's is first verified with
 *            Flutterwave, throttled per payment (payments/card-check.ts).
 *        404 not_found   unknown, another photographer's, or not a subscription payment
 *
 * The amount is never the request's: the body is parsed with unknown keys
 * stripped unread, so an `amountRwf` sent along is ignored and the platform's
 * price for the plan is charged (T5.3). Any subscription status may pay,
 * `expired` included. MoMo or card, through the methods on offer (R3.1): with no
 * payment provider configured, `methods` is empty and every method is a 422.
 * Rate-limited per address like the client's payment routes (app.ts).
 */

export type StudioSubscriptionDeps = AuthDeps & {
  /** Which methods are offered and who collects each (R3.1). Absent: nothing is on offer. */
  routing?: PaymentRouting;
  /** The provider call's deadline; injectable for tests. */
  providerTimeoutMs?: number;
  /** Asks Flutterwave about a pending card payment as its page polls (C5). */
  checkPayment?: PaymentCheck;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function studioSubscriptionRouter(deps: StudioSubscriptionDeps): Router {
  const routing = deps.routing ?? routePayments({});
  const router = Router();

  router.use('/subscription', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/subscription', async (_req, res) => {
    res.json(await studioSubscription(deps.prisma, photographerLocals(res).photographerId, deps.now(), routing.methods));
  });

  // `z.object`, not strict: a forged `amountRwf` (or `status`, `provider`) is stripped unread (T5.3).
  // Only a method on offer (R3.1); a phone for MoMo, none for a card (routes/payment-body.ts).
  const parseBody = paymentBodyParser(routing, { planInterval: z.enum(PLAN_INTERVALS) });

  router.post('/subscription/payments', async (req, res) => {
    const body = parseBody(req.body, res);
    if (body === undefined) return;

    const provider = routing.providerFor(body.method);
    if (provider === undefined) throw new Error('A validated method has no provider');
    const result = await startSubscriptionPayment(
      { prisma: deps.prisma, provider, ...(deps.providerTimeoutMs === undefined ? {} : { timeoutMs: deps.providerTimeoutMs }) },
      { photographerId: photographerLocals(res).photographerId, planInterval: body.planInterval, method: body.method, payerPhone: body.phone },
    );

    switch (result.status) {
      case 'started':
        res.status(201).json({
          payment: { ourRef: result.ourRef, status: 'pending', planInterval: result.planInterval, amountRwf: result.amountRwf },
          ...(result.card === undefined
            ? {}
            : { card: cardConfig(provider, result.ourRef, result.card, cardTitles.subscription(result.planInterval), cardReturnPaths.subscription(result.ourRef)) }),
        });
        return;
      case 'card_in_progress':
        res.status(200).json({
          payment: { ourRef: result.ourRef, status: 'pending', planInterval: result.planInterval, amountRwf: result.amountRwf },
          card: cardConfig(provider, result.ourRef, result.card, cardTitles.subscription(result.planInterval), cardReturnPaths.subscription(result.ourRef)),
        });
        return;
      case 'photographer_not_approved':
      case 'no_subscription':
        res.status(409).json({ error: result.status });
        return;
      case 'in_progress':
        res.status(409).json({ error: 'payment_in_progress', payment: { ourRef: result.ourRef, method: result.method } });
        return;
      case 'provider_failed':
        res.status(502).json({ error: 'payment_not_started', reason: result.outcome, payment: { ourRef: result.ourRef, status: 'failed' } });
        return;
    }
  });

  router.get('/subscription/payments/:ourRef', async (req, res) => {
    const { ourRef } = req.params;
    const photographerId = photographerLocals(res).photographerId;
    // Only this photographer's own subscription payment is ever asked about (R1.4).
    if (deps.checkPayment !== undefined && UUID.test(ourRef)) {
      const own = await deps.prisma.payment.count({ where: { ourRef: ourRef.toLowerCase(), kind: 'subscription', subscription: { photographerId } } });
      const transactionId = typeof req.query.transactionId === 'string' ? req.query.transactionId : undefined;
      if (own === 1) await deps.checkPayment(ourRef, { transactionId, subject: 'subscription' });
    }
    const found = UUID.test(ourRef)
      ? await studioSubscriptionPayment(deps.prisma, photographerId, ourRef.toLowerCase(), deps.now())
      : null;
    if (found === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(found);
  });

  return router;
}
