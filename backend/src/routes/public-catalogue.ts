import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { priceBasket } from '../catalogue/basket.js';
import { findPublicService, listPublicCatalogue } from '../catalogue/public.js';
import { addonIds, parseOrReject } from './validation.js';

/**
 * Public service browsing and pricing (plan.md Task 11; spec §3.1 steps 1-3
 * and 7, P-01). Anonymous by design: every visitor may browse and price.
 *
 *   GET  /services         the public list: active services with their active
 *                          packages and add-ons
 *   GET  /services/:slug   one active service, plus the booking-fee rate that
 *                          applies to it; 404 for an unknown or inactive slug
 *   POST /quote            prices `{ packageId, addonIds }` from the catalogue
 *
 * The quote is the API's authority over money. The browser shows a live total
 * from its own copy of the quote function, but this is the one that counts: a
 * body carrying its own `totalRwf` or `bookingFeeRwf` has those keys stripped
 * unread, and the basket is priced from the rows. A package, service or add-on
 * the public cannot see is a 422 naming the field, never a price.
 *
 * Validation follows the admin rule (routes/validation.ts): a malformed body is
 * a 400, a well-formed one breaking a rule is a 422.
 */

const quoteBody = z.object({
  packageId: z.guid(),
  addonIds,
});

export function publicCatalogueRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/services', async (_req, res) => {
    res.json({ services: await listPublicCatalogue(prisma) });
  });

  router.get('/services/:slug', async (req, res) => {
    const service = await findPublicService(prisma, req.params.slug);
    if (service === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ service });
  });

  router.post('/quote', async (req, res) => {
    const body = parseOrReject(quoteBody, req.body, res);
    if (body === undefined) return;

    const result = await priceBasket(prisma, body);
    if (!result.ok) {
      res.status(422).json({ error: 'validation_failed', fields: result.fields });
      return;
    }
    res.json({ quote: result.quote });
  });

  return router;
}
