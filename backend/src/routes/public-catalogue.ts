import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { priceBasket } from '../catalogue/basket.js';
import { findPublicPhotographer, findPublicService, listPublicCatalogue, listPublicPhotographers } from '../catalogue/public.js';
import { addonIds, parseOrReject } from './validation.js';

/**
 * Public browsing and pricing (plan.md Task 11; spec §3.1 steps 1-3 and 7,
 * P-01; brief decision 4). Anonymous by design: every visitor may browse and
 * price.
 *
 *   GET  /photographers                          the listed photographers: handle,
 *                                                display name, cover, takingBookings
 *   GET  /photographers/:handle                  one photographer's public profile,
 *                                                with the cancellation policy a
 *                                                new booking would be made under
 *                                                and takingBookings
 *   GET  /photographers/:handle/services         their active services with their
 *                                                active packages and add-ons
 *   GET  /photographers/:handle/services/:slug   one active service, plus the
 *                                                booking-fee rate that applies to it
 *                                                and its photographer's takingBookings
 *   POST /quote                                  prices `{ packageId, addonIds }`
 *                                                from the catalogue
 *
 * An unknown handle, and the handle of a photographer who is not listed
 * (pending, suspended, or a subscription `expired`), are the same 404: the
 * public is never told which. A photographer whose subscription is `past_due`
 * is listed with `takingBookings: false` (marketplace-spec.md R5.5): profile and
 * services are shown, and their packages still answer the quote, the calendar
 * and the booking form as an inactive package does. So are an unknown or
 * inactive slug, and a slug that exists only under another photographer's
 * handle. The profile is an allowlist (catalogue/public.ts): no status, no
 * login email, no operating settings.
 *
 * The quote is the API's authority over money. The browser shows a live total
 * from its own copy of the quote function, but this is the one that counts: a
 * body carrying its own `totalRwf` or `bookingFeeRwf` has those keys stripped
 * unread, and the basket is priced from the rows. A package, service or add-on
 * the public cannot see -- an unbookable photographer's included, and another
 * photographer's add-on -- is a 422 naming the field, never a price.
 *
 * Validation follows the admin rule (routes/validation.ts): a malformed body is
 * a 400, a well-formed one breaking a rule is a 422.
 */

const quoteBody = z.object({
  packageId: z.guid(),
  addonIds,
});

export function publicCatalogueRouter(prisma: PrismaClient, now: () => Date = () => new Date()): Router {
  const router = Router();

  router.get('/photographers', async (_req, res) => {
    res.json({ photographers: await listPublicPhotographers(prisma, now()) });
  });

  router.get('/photographers/:handle', async (req, res) => {
    const photographer = await findPublicPhotographer(prisma, req.params.handle, now());
    if (photographer === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ photographer: photographer.profile });
  });

  router.get('/photographers/:handle/services', async (req, res) => {
    const photographer = await findPublicPhotographer(prisma, req.params.handle, now());
    if (photographer === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ services: await listPublicCatalogue(prisma, photographer.id) });
  });

  router.get('/photographers/:handle/services/:slug', async (req, res) => {
    const photographer = await findPublicPhotographer(prisma, req.params.handle, now());
    const service = photographer === null ? null : await findPublicService(prisma, photographer.id, req.params.slug);
    if (service === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Whether the slot picker may open: the profile's flag, for the page that skips the profile.
    res.json({ service: { ...service, takingBookings: photographer?.profile.takingBookings ?? false } });
  });

  router.post('/quote', async (req, res) => {
    const body = parseOrReject(quoteBody, req.body, res);
    if (body === undefined) return;

    const result = await priceBasket(prisma, body, now());
    if (!result.ok) {
      res.status(422).json({ error: 'validation_failed', fields: result.fields });
      return;
    }
    res.json({ quote: result.quote });
  });

  return router;
}
