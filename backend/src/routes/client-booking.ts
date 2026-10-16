import type { PrismaClient } from '@prisma/client';
import { type Response, Router } from 'express';
import { z } from 'zod';
import { findBookingByToken } from '../booking/access.js';
import { cancelByClient } from '../booking/cancel.js';
import { requestEmailChange } from '../booking/email-change.js';
import { type ClientBookingView, clientBookingView } from '../booking/client-view.js';
import { normalizePhone } from '../booking/phone.js';
import { startSessionFeePayment } from '../payments/initiate.js';
import type { PaymentMethod, PaymentProvider } from '../payments/provider.js';
import { parseOrReject } from './validation.js';

/**
 * The client's own booking (plan.md Task 18; spec §2.2 P-07 to P-12, §3.9,
 * §6.10). Mounted at `/api/booking`, addressed by the access token in the path
 * and by nothing else.
 *
 *   GET  /api/booking/:token
 *        200 { booking }            status, when, where, amounts, delivery
 *        404 not_found              unknown, expired or superseded, alike
 *
 *   POST /api/booking/:token/cancel
 *        200 { booking }            now cancelled_by_client
 *        404 not_found
 *        409 not_cancellable        already cancelled, or the shoot has passed
 *
 *   POST /api/booking/:token/email   { email }            (2026-09-25)
 *        202 { booking }                 a confirmation link is on its way to the new address
 *        200 { booking }                 it is the address the booking already has
 *        404 not_found
 *        409 not_allowed { booking }     a booking that no longer stands
 *        422 validation_failed { fields }
 *        429 too_many_requests           three requests a day per booking
 *
 *   POST /api/booking/:token/payments   { method, phone }
 *        201 { payment: { ourRef, status: 'pending' } }
 *        404 not_found
 *        409 nothing_to_pay | payment_in_progress { payment: { ourRef } }
 *        422 validation_failed { fields }
 *        502 payment_not_started { reason, payment }
 *
 * Every route resolves the booking from the token first and works on what it
 * found. No handler reads an id, a reference or an email from the request, so
 * adding one to any parameter changes nothing (plan.md Task 18).
 *
 * `Cache-Control: no-store` throughout: these pages hold personal data and a
 * live link, and a shared cache must keep neither.
 */

export type ClientBookingDeps = {
  prisma: PrismaClient;
  now: () => Date;
  /** Without a provider the page still works; only the payment control is absent. */
  payments?: { provider: PaymentProvider; providerTimeoutMs?: number };
};

const PHONE_MAX_LENGTH = 40;
const EMAIL_MAX_LENGTH = 254;
const emailFormat = z.email();
const emailBody = z.strictObject({
  // A refinement, not z.email(): a mistyped address is a 422 the form can mark.
  email: z
    .string()
    .trim()
    .max(EMAIL_MAX_LENGTH)
    .refine((value) => emailFormat.safeParse(value).success, 'Invalid email'),
});

export function clientBookingRouter(deps: ClientBookingDeps): Router {
  const { prisma, now } = deps;
  const router = Router();

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/:token', async (req, res) => {
    const booking = await findBookingByToken(prisma, req.params.token);
    if (booking === null) {
      notFound(res);
      return;
    }
    res.json({ booking: clientBookingView(booking, now()) });
  });

  router.post('/:token/cancel', async (req, res) => {
    // Unknown token and uncancellable booking are told apart, but only to
    // someone holding the token: the 404 still says nothing to anyone else.
    const booking = await findBookingByToken(prisma, req.params.token);
    if (booking === null) {
      notFound(res);
      return;
    }

    const result = await cancelByClient({ prisma, now }, req.params.token);
    if (result.status === 'not_cancellable') {
      res.status(409).json({ error: 'not_cancellable', booking: clientBookingView(booking, now()) });
      return;
    }
    res.json({ booking: clientBookingView(result.booking, now()) });
  });

  router.post('/:token/email', async (req, res) => {
    const booking = await findBookingByToken(prisma, req.params.token);
    if (booking === null) {
      notFound(res);
      return;
    }
    const body = parseOrReject(emailBody, req.body, res);
    if (body === undefined) return;

    const result = await requestEmailChange({ prisma, now }, booking, body.email);
    const fresh = await findBookingByToken(prisma, req.params.token);
    const view = fresh === null ? null : clientBookingView(fresh, now());
    switch (result.status) {
      case 'requested':
        // No address in the answer: the page knows what it sent, and the view masks it.
        res.status(202).json({ booking: view });
        return;
      case 'unchanged':
        res.json({ booking: view });
        return;
      case 'not_allowed':
        res.status(409).json({ error: 'not_allowed', booking: view });
        return;
      case 'rate_limited':
        res.status(429).json({ error: 'too_many_requests' });
        return;
    }
  });

  const payments = deps.payments;
  if (payments !== undefined) {
    const paymentBody = z.object({
      method: z
        .string()
        .refine((method) => (payments.provider.methods as readonly string[]).includes(method), 'Method not available'),
      phone: z
        .string()
        .max(PHONE_MAX_LENGTH)
        .refine((value) => normalizePhone(value) !== null, 'Invalid phone number')
        .transform((value) => normalizePhone(value) ?? value),
    });

    router.post('/:token/payments', async (req, res) => {
      const booking = await findBookingByToken(prisma, req.params.token);
      if (booking === null) {
        notFound(res);
        return;
      }
      const body = parseOrReject(paymentBody, req.body, res);
      if (body === undefined) return;

      const result = await startSessionFeePayment(
        {
          prisma,
          provider: payments.provider,
          ...(payments.providerTimeoutMs === undefined ? {} : { timeoutMs: payments.providerTimeoutMs }),
        },
        {
          bookingId: booking.id,
          reference: booking.reference,
          method: body.method as PaymentMethod,
          payerPhone: body.phone,
        },
      );

      switch (result.status) {
        case 'started':
          res.status(201).json({ payment: { ourRef: result.ourRef, status: 'pending' } });
          return;
        case 'in_progress':
          res.status(409).json({ error: 'payment_in_progress', payment: { ourRef: result.ourRef } });
          return;
        case 'provider_failed':
          res.status(502).json({
            error: 'payment_not_started',
            reason: result.outcome,
            payment: { ourRef: result.ourRef, status: 'failed' },
          });
          return;
        // A booking that has just been cancelled, paid or rescheduled owes
        // nothing; `not_found` cannot happen behind a token that just resolved.
        default:
          res.status(409).json({ error: 'nothing_to_pay', booking: clientBookingView(booking, now()) });
          return;
      }
    });
  }

  return router;
}

/** The one answer for every token that does not resolve: never 403 (plan.md Task 18). */
function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

export type { ClientBookingView };
