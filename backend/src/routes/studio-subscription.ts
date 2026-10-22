import { Router } from 'express';
import { z } from 'zod';
import type { AuthDeps } from '../auth/account-auth.js';
import { photographerLocals } from '../auth/middleware.js';
import { normalizePhone } from '../booking/phone.js';
import type { PaymentMethod } from '../payments/provider.js';
import { type PaymentRouting, routePayments } from '../payments/routing.js';
import { startSubscriptionPayment } from '../subscriptions/payments.js';
import { PLAN_INTERVALS } from '../subscriptions/plan.js';
import { studioSubscription, studioSubscriptionPayment } from '../subscriptions/views.js';
import { parseOrReject } from './validation.js';

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
 *   POST /subscription/payments   { planInterval, method, phone }
 *        201 { payment: { ourRef, status: 'pending', planInterval, amountRwf } }
 *        409 photographer_not_approved   pending or suspended
 *        409 no_subscription             approved with none (never, by the approval and the backfill)
 *        409 payment_in_progress { payment: { ourRef } }   another still waits on the payer
 *        400 invalid_request                a plan that is neither monthly nor yearly, a missing field
 *        422 validation_failed { fields }   a method not on offer, an unusable number
 *        502 payment_not_started { reason: rejected | unavailable,
 *                                  payment: { ourRef, status: 'failed' } }
 *
 *   GET  /subscription/payments/:ourRef
 *        200 { payment: { ourRef, status, planInterval, amountRwf, method, failure,
 *              initiatedAt, settledAt }, subscription: { status, currentPeriodEndsAt, takingBookings } }
 *        404 not_found   unknown, another photographer's, or not a subscription payment
 *
 * The amount is never the request's: the body is parsed with unknown keys
 * stripped unread, so an `amountRwf` sent along is ignored and the platform's
 * price for the plan is charged (T5.3). Any subscription status may pay,
 * `expired` included. MoMo only, through the methods on offer (R3.1): with no
 * payment provider configured, `methods` is empty and every method is a 422.
 * Rate-limited per address like the client's payment routes (app.ts).
 */

export type StudioSubscriptionDeps = AuthDeps & {
  /** Which methods are offered and who collects each (R3.1). Absent: nothing is on offer. */
  routing?: PaymentRouting;
  /** The provider call's deadline; injectable for tests. */
  providerTimeoutMs?: number;
};

const PHONE_MAX_LENGTH = 40;
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
  const paymentBody = z.object({
    planInterval: z.enum(PLAN_INTERVALS),
    // Only a method on offer: one not enabled, or whose provider is unconfigured, is a 422 (R3.1).
    method: z.string().refine((method) => routing.providerFor(method) !== undefined, 'Method not available'),
    phone: z
      .string()
      .max(PHONE_MAX_LENGTH)
      .refine((value) => normalizePhone(value) !== null, 'Invalid phone number')
      .transform((value) => normalizePhone(value) ?? value),
  });

  router.post('/subscription/payments', async (req, res) => {
    const body = parseOrReject(paymentBody, req.body, res);
    if (body === undefined) return;

    const provider = routing.providerFor(body.method);
    if (provider === undefined) throw new Error('A validated method has no provider');
    const result = await startSubscriptionPayment(
      { prisma: deps.prisma, provider, ...(deps.providerTimeoutMs === undefined ? {} : { timeoutMs: deps.providerTimeoutMs }) },
      { photographerId: photographerLocals(res).photographerId, planInterval: body.planInterval, method: body.method as PaymentMethod, payerPhone: body.phone },
    );

    switch (result.status) {
      case 'started':
        res.status(201).json({ payment: { ourRef: result.ourRef, status: 'pending', planInterval: result.planInterval, amountRwf: result.amountRwf } });
        return;
      case 'photographer_not_approved':
      case 'no_subscription':
        res.status(409).json({ error: result.status });
        return;
      case 'in_progress':
        res.status(409).json({ error: 'payment_in_progress', payment: { ourRef: result.ourRef } });
        return;
      case 'provider_failed':
        res.status(502).json({ error: 'payment_not_started', reason: result.outcome, payment: { ourRef: result.ourRef, status: 'failed' } });
        return;
    }
  });

  router.get('/subscription/payments/:ourRef', async (req, res) => {
    const { ourRef } = req.params;
    const found = UUID.test(ourRef)
      ? await studioSubscriptionPayment(deps.prisma, photographerLocals(res).photographerId, ourRef.toLowerCase(), deps.now())
      : null;
    if (found === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(found);
  });

  return router;
}
