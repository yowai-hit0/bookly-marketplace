import type { PrismaClient } from '@prisma/client';
import { type Response, Router } from 'express';
import { z } from 'zod';
import { normalizePhone } from '../booking/phone.js';
import { verifyCheckoutToken } from '../payments/checkout-link.js';
import { startBookingFeePayment } from '../payments/initiate.js';
import type { PaymentMethod, PaymentProvider } from '../payments/provider.js';
import { parseOrReject } from './validation.js';

/**
 * Paying the booking fee (plan.md Task 16; spec §3.1 steps 9-10, §6.19). All
 * anonymous (P-05), all `Cache-Control: no-store`.
 *
 *   GET  /api/payment-methods
 *        200 { provider, methods }   what the active provider collects, and
 *                                    so all the pay page may render
 *
 *   GET  /api/checkout/:reference/:token
 *        200 { checkout: { reference, serviceName, packageName, startsAt,
 *              endsAt, holdExpiresAt, bookingFeeRwf, state, waitingPayment } }
 *            state: payable | paid | expired | closed
 *        404 not_found               unknown reference or wrong token, alike
 *
 *   POST /api/checkout/:reference/:token/payments   { method, phone }
 *        201 { payment: { ourRef, status: 'pending' } }   the phone is prompted
 *        404 not_found
 *        409 already_paid | hold_expired | nothing_to_pay
 *        409 payment_in_progress { payment: { ourRef } }  an attempt still waits
 *        422 validation_failed { fields }   a method not on offer, a bad number
 *        502 payment_not_started { reason: rejected | unavailable,
 *                                  payment: { ourRef, status: 'failed' } }
 *
 *   GET  /api/payments/:ourRef
 *        200 { payment: { status, amountRwf, failure }, booking: { reference, status,
 *              serviceName, packageName, startsAt, endsAt } }
 *            failure: declined | unavailable | null
 *        404 not_found
 *
 * The checkout's scope comes from its token alone (spec §2.2). The status
 * endpoint is addressed by `our_ref`, a random uuid the pay page was handed; it
 * shows where the payment stands and never anyone's contact details.
 */

export type CheckoutDeps = {
  prisma: PrismaClient;
  provider: PaymentProvider;
  /** `SESSION_SECRET`: checkout tokens are derived from it. */
  secret: string;
  /** The provider call's deadline; injectable for tests. */
  providerTimeoutMs?: number;
};

const REFERENCE = /^BKY-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_MAX_LENGTH = 40;

export function checkoutRouter(deps: CheckoutDeps): Router {
  const { prisma, provider, secret } = deps;
  const router = Router();

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/payment-methods', (_req, res) => {
    res.json({ provider: provider.id, methods: provider.methods });
  });

  /** The reference, when the token is its token; otherwise null and a 404 already sent. */
  const authorised = (params: Record<string, string | undefined>, res: Response): string | null => {
    const { reference = '', token = '' } = params;
    if (REFERENCE.test(reference) && TOKEN.test(token) && verifyCheckoutToken(secret, reference, token)) return reference;
    res.status(404).json({ error: 'not_found' });
    return null;
  };

  router.get('/checkout/:reference/:token', async (req, res) => {
    const reference = authorised(req.params, res);
    if (reference === null) return;

    const rows = await prisma.$queryRaw<CheckoutRow[]>`
      SELECT b.id::text AS id, b.status, b.service_name_snapshot, b.package_name_snapshot, b.starts_at, b.ends_at,
             b.hold_expires_at, b.booking_fee_rwf,
             (b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now()) AS hold_live,
             EXISTS (SELECT 1 FROM payment p
                      WHERE p.booking_id = b.id AND p.kind = 'booking_fee' AND p.status = 'succeeded') AS paid,
             (SELECT p.our_ref::text FROM payment p
               WHERE p.booking_id = b.id AND p.kind = 'booking_fee' AND p.status IN ('initiated', 'pending')
               ORDER BY p.initiated_at DESC LIMIT 1) AS waiting_our_ref
        FROM booking b
       WHERE b.reference = ${reference}`;
    const booking = rows[0];
    if (booking === undefined) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.json({
      checkout: {
        reference,
        serviceName: booking.service_name_snapshot,
        packageName: booking.package_name_snapshot,
        startsAt: booking.starts_at.toISOString(),
        endsAt: booking.ends_at.toISOString(),
        holdExpiresAt: booking.hold_expires_at?.toISOString() ?? null,
        bookingFeeRwf: booking.booking_fee_rwf,
        state: checkoutState(booking),
        waitingPayment: booking.waiting_our_ref === null ? null : { ourRef: booking.waiting_our_ref },
      },
    });
  });

  const paymentBody = z.object({
    method: z.string().refine((method) => (provider.methods as readonly string[]).includes(method), 'Method not available'),
    phone: z
      .string()
      .max(PHONE_MAX_LENGTH)
      .refine((value) => normalizePhone(value) !== null, 'Invalid phone number')
      .transform((value) => normalizePhone(value) ?? value),
  });

  router.post('/checkout/:reference/:token/payments', async (req, res) => {
    const reference = authorised(req.params, res);
    if (reference === null) return;
    const body = parseOrReject(paymentBody, req.body, res);
    if (body === undefined) return;

    const result = await startBookingFeePayment(
      { prisma, provider, ...(deps.providerTimeoutMs === undefined ? {} : { timeoutMs: deps.providerTimeoutMs }) },
      { reference, method: body.method as PaymentMethod, payerPhone: body.phone },
    );

    switch (result.status) {
      case 'started':
        res.status(201).json({ payment: { ourRef: result.ourRef, status: 'pending' } });
        return;
      case 'not_found':
        res.status(404).json({ error: 'not_found' });
        return;
      case 'already_paid':
      case 'hold_expired':
      case 'nothing_to_pay':
        res.status(409).json({ error: result.status });
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
    }
  });

  router.get('/payments/:ourRef', async (req, res) => {
    const { ourRef } = req.params;
    const payment = UUID.test(ourRef)
      ? await prisma.payment.findUnique({
          where: { ourRef: ourRef.toLowerCase() },
          select: {
            status: true,
            amountRwf: true,
            failureReason: true,
            booking: {
              select: {
                reference: true,
                status: true,
                serviceNameSnapshot: true,
                packageNameSnapshot: true,
                startsAt: true,
                endsAt: true,
              },
            },
          },
        })
      : null;
    if (payment === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const { booking } = payment;
    res.json({
      payment: { status: payment.status, amountRwf: payment.amountRwf, failure: failureOf(payment.status, payment.failureReason) },
      booking: {
        reference: booking.reference,
        status: booking.status,
        serviceName: booking.serviceNameSnapshot,
        packageName: booking.packageNameSnapshot,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
      },
    });
  });

  return router;
}

type CheckoutRow = {
  id: string;
  status: string;
  service_name_snapshot: string;
  package_name_snapshot: string;
  starts_at: Date;
  ends_at: Date;
  hold_expires_at: Date | null;
  booking_fee_rwf: number;
  hold_live: boolean;
  paid: boolean;
  waiting_our_ref: string | null;
};

function checkoutState(booking: CheckoutRow): 'payable' | 'paid' | 'expired' | 'closed' {
  if (booking.paid) return 'paid';
  if (booking.status === 'pending_payment' && booking.hold_live) return booking.booking_fee_rwf > 0 ? 'payable' : 'closed';
  if (booking.status === 'pending_payment' || booking.status === 'expired') return 'expired';
  return 'closed';
}

/**
 * Why a payment failed, as the payer may be told it: turned down (declined,
 * timed out on the phone, an unknown number) or never started because the
 * provider could not be reached. The recorded reason itself stays internal.
 */
function failureOf(status: string, reason: string | null): 'declined' | 'unavailable' | null {
  if (status !== 'failed') return null;
  return reason !== null && /^provider_(unavailable|timeout)/.test(reason) ? 'unavailable' : 'declined';
}
