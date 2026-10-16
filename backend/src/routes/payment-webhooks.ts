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
 * the active one or not (spec §6.18). The answer is 200 whenever the delivery is
 * on record -- applied, ignored, or refused as unsigned -- so the provider stops
 * retrying; only a failure to process it is a 500, which asks for the retry
 * that processes it again. The body never says which.
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
    res.status(200).json({ received: true });
  };
}
