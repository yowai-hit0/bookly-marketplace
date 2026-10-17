import express, { type Request, type Response, Router } from 'express';
import type { PaymentProvider, PaymentProviderId } from '../payments/provider.js';
import { type WebhookDeps, receiveWebhook } from '../payments/webhooks.js';

/**
 * Provider callbacks (plan.md Task 17; data-model_v2.md §7.3), mounted at
 * `/api/webhooks` AHEAD of `express.json()`. A JSON parser that ran first would
 * consume the stream, and verification needs the bytes exactly as sent -- so
 * each route reads its own raw body, whatever the content type claims.
 *
 *   POST|PUT /api/webhooks/mtn-momo/:ourRef/:signature
 *   POST     /api/webhooks/flutterwave         signed in `flutterwave-signature`
 *
 * Every provider whose payments may still be settling keeps its route mounted,
 * whether a method routes to it today or not (spec §6.18, R3.1). A delivery
 * whose signature fails is stored unverified, applies nothing, and is a 401
 * (marketplace-spec.md T3.3, 2026-10-17): it is no delivery of the provider's,
 * so nothing is asked of it, and a genuine one refused under a misconfigured
 * key is retried by the provider into a fixed one. Anything else on record --
 * applied or ignored -- is 200, so the provider stops retrying; only a failure
 * to process it is a 500, which asks for the retry that processes it again. The
 * 200 body never says which.
 */

export type PaymentWebhooksDeps = WebhookDeps & {
  providers: Partial<Record<PaymentProviderId, PaymentProvider>>;
};

/** Far above any status callback; a body past it is refused unread. */
const WEBHOOK_BODY_LIMIT = '64kb';

export function paymentWebhooksRouter(deps: PaymentWebhooksDeps): Router {
  const router = Router();
  const raw = express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT });

  const mtn = deps.providers.mtn_momo_direct;
  if (mtn !== undefined) {
    const handle = deliver(deps, mtn);
    router.post('/mtn-momo/:ourRef/:signature', raw, handle);
    router.put('/mtn-momo/:ourRef/:signature', raw, handle);
  }

  const flutterwave = deps.providers.flutterwave;
  if (flutterwave !== undefined) {
    router.post('/flutterwave', raw, deliver(deps, flutterwave));
  }

  return router;
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function deliver(deps: WebhookDeps, provider: PaymentProvider) {
  return async (req: Request, res: Response) => {
    const outcome = await receiveWebhook(deps, provider, {
      // No body at all leaves `req.body` unset.
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      headers: req.headers,
      params: { ourRef: stringParam(req.params.ourRef), signature: stringParam(req.params.signature) },
    });
    if (outcome.status === 'failed') {
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    if (outcome.note === 'signature_invalid') {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }
    res.status(200).json({ received: true });
  };
}
