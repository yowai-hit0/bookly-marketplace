import type { PrismaClient } from '@prisma/client';
import { type Response, Router } from 'express';
import { cancellationDeadline } from '../booking/client-view.js';
import type { PaymentCheck } from '../payments/card-check.js';
import { cardConfig, cardReturnPaths, cardTitles } from '../payments/card-checkout.js';
import { verifyCheckoutToken } from '../payments/checkout-link.js';
import { startBookingFeePayment } from '../payments/initiate.js';
import type { CardSession } from '../payments/provider.js';
import type { PaymentRouting } from '../payments/routing.js';
import { paymentBodyParser } from './payment-body.js';

/**
 * Paying the booking fee (plan.md Task 16; spec §3.1 steps 9-10, §6.19). All
 * anonymous (P-05), all `Cache-Control: no-store`.
 *
 *   GET  /api/payment-methods
 *        200 { methods }             the methods on offer (R3.1): each routed
 *                                    to a configured provider, and so all the
 *                                    pay page may render. No provider is named:
 *                                    there is no single one any more, and which
 *                                    collects a method is not the payer's concern
 *
 *   GET  /api/checkout/:reference/:token
 *        200 { checkout: { reference, serviceName, packageName, startsAt,
 *              endsAt, holdExpiresAt, bookingFeeRwf, state, waitingPayment,
 *              cancellation: { deadline, bookingFeeRefundable } } }
 *            state: payable | paid | expired | closed
 *            waitingPayment: { ourRef, method } | null -- the newest attempt not
 *            yet settled; `method: 'card'` tells the page to reopen the card
 *            checkout (POST again with `method: 'card'`)
 *            cancellation: the policy the booking was made under (R1.8), so
 *            the pay page states the terms before the client pays
 *        404 not_found               unknown reference or wrong token, alike
 *
 *   POST /api/checkout/:reference/:token/payments   { method, phone }  (no phone for card)
 *        201 { payment: { ourRef, status: 'pending' } }   the phone is prompted
 *        201 { payment: { ourRef, status: 'pending' }, card }   method card: `card` is
 *            the Flutterwave Inline config (payments/card-checkout.ts)
 *        200 { payment: { ourRef, status: 'pending' }, card }   a card checkout of
 *            this fee is still open: the same payment and the same `tx_ref`
 *        404 not_found
 *        409 already_paid | hold_expired | nothing_to_pay
 *        409 photographer_unavailable   the photographer can no longer be
 *                                       booked (R3.4, T3.4); nothing is charged
 *        409 payment_in_progress { payment: { ourRef, method } }  an attempt still waits
 *        422 validation_failed { fields }   a method not on offer, a bad number
 *        502 payment_not_started { reason: rejected | unavailable,
 *                                  payment: { ourRef, status: 'failed' } }
 *
 *   GET  /api/payments/:ourRef[?transactionId=]
 *        200 { payment: { status, amountRwf, failure }, booking: { reference, status,
 *              serviceName, packageName, startsAt, endsAt } }
 *            failure: declined | unavailable | null
 *            A pending card payment is first verified with Flutterwave, at most
 *            once per payment every few seconds (payments/card-check.ts);
 *            `transactionId` (the modal's or the redirect's) says which try.
 *        404 not_found
 *
 * The checkout's scope comes from its token alone (spec §2.2). The status
 * endpoint is addressed by `our_ref`, a random uuid the pay page was handed; it
 * shows where the payment stands and never anyone's contact details.
 */

export type CheckoutDeps = {
  prisma: PrismaClient;
  /** Which methods are offered and who collects each (R3.1). */
  routing: PaymentRouting;
  /** `SESSION_SECRET`: checkout tokens are derived from it. */
  secret: string;
  /** The provider call's deadline; injectable for tests. */
  providerTimeoutMs?: number;
  /** Asks Flutterwave about a pending card payment as its page polls (C5). Absent: the poll only reads. */
  checkPayment?: PaymentCheck;
};

const REFERENCE = /^BKY-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkoutRouter(deps: CheckoutDeps): Router {
  const { prisma, routing, secret } = deps;
  const router = Router();

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/payment-methods', (_req, res) => {
    res.json({ methods: routing.methods });
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
             b.hold_expires_at, b.booking_fee_rwf, b.client_cancel_cutoff_hours, b.booking_fee_refundable_on_client_cancel,
             (b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now()) AS hold_live,
             EXISTS (SELECT 1 FROM payment p
                      WHERE p.booking_id = b.id AND p.kind = 'booking_fee' AND p.status = 'succeeded') AS paid,
             w.our_ref AS waiting_our_ref, w.method AS waiting_method
        FROM booking b
        LEFT JOIN LATERAL (
          SELECT p.our_ref::text AS our_ref, p.method
            FROM payment p
           WHERE p.booking_id = b.id AND p.kind = 'booking_fee' AND p.status IN ('initiated', 'pending')
           ORDER BY p.initiated_at DESC LIMIT 1) w ON true
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
        waitingPayment: booking.waiting_our_ref === null ? null : { ourRef: booking.waiting_our_ref, method: booking.waiting_method },
        // The same shape as the client's booking page (booking/client-view.ts).
        cancellation: {
          deadline: cancellationDeadline({ startsAt: booking.starts_at, clientCancelCutoffHours: booking.client_cancel_cutoff_hours }).toISOString(),
          bookingFeeRefundable: booking.booking_fee_refundable_on_client_cancel,
        },
      },
    });
  });

  // Only a method on offer (R3.1); a phone for MoMo, none for a card (routes/payment-body.ts).
  const parseBody = paymentBodyParser(routing, {});

  router.post('/checkout/:reference/:token/payments', async (req, res) => {
    const reference = authorised(req.params, res);
    if (reference === null) return;
    const body = parseBody(req.body, res);
    if (body === undefined) return;

    // The client's method picks the provider (R3.1); the refinement above has made sure there is one.
    const provider = routing.providerFor(body.method);
    if (provider === undefined) throw new Error('A validated method has no provider');
    const result = await startBookingFeePayment(
      { prisma, provider, ...(deps.providerTimeoutMs === undefined ? {} : { timeoutMs: deps.providerTimeoutMs }) },
      { reference, method: body.method, payerPhone: body.phone },
    );
    const card = (ourRef: string, session: CardSession) =>
      cardConfig(provider, ourRef, session, cardTitles.bookingFee(reference), cardReturnPaths.bookingFee(reference, req.params.token ?? '', ourRef));

    switch (result.status) {
      case 'started':
        res.status(201).json({
          payment: { ourRef: result.ourRef, status: 'pending' },
          ...(result.card === undefined ? {} : { card: card(result.ourRef, result.card) }),
        });
        return;
      case 'card_in_progress':
        res.status(200).json({ payment: { ourRef: result.ourRef, status: 'pending' }, card: card(result.ourRef, result.card) });
        return;
      case 'not_found':
        res.status(404).json({ error: 'not_found' });
        return;
      case 'already_paid':
      case 'hold_expired':
      case 'nothing_to_pay':
      case 'photographer_unavailable':
        res.status(409).json({ error: result.status });
        return;
      case 'in_progress':
        res.status(409).json({ error: 'payment_in_progress', payment: { ourRef: result.ourRef, method: result.method } });
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
    // Verify a pending card payment first, so this answer can already be its result (C5).
    if (deps.checkPayment !== undefined && UUID.test(ourRef)) {
      const transactionId = typeof req.query.transactionId === 'string' ? req.query.transactionId : undefined;
      await deps.checkPayment(ourRef, { transactionId, subject: 'booking' });
    }
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
    // A subscription payment has no booking: it is the photographer's, polled in
    // the studio (`/api/studio/subscription/payments/:ourRef`), and to this public
    // route it is as unknown as any other reference (Phase 5).
    if (payment === null || payment.booking === null) {
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
  client_cancel_cutoff_hours: number;
  booking_fee_refundable_on_client_cancel: boolean;
  hold_live: boolean;
  paid: boolean;
  waiting_our_ref: string | null;
  waiting_method: string | null;
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
