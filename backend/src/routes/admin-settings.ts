import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { photographerLocals } from '../auth/middleware.js';
import { getPhotographerSettings, updatePhotographerSettings } from '../settings/index.js';
import { INT4_MAX, feeRate, parseOrReject } from './validation.js';

/**
 * `/api/admin/settings` -- the settings screen's API (plan.md Task 8, spec
 * P-15, P-24, P-30). Mounted behind `requirePhotographer`, and every read and
 * write addresses the signed-in photographer's own row (marketplace-spec.md
 * R1.4): the id comes from the token, never from the request.
 *
 * The checkout hold is not here: it is the platform's (brief decision 5), set
 * on `platform_setting`. The client cancellation policy is (R1.8): how close to
 * the shoot a client may still cancel, and whether doing so refunds the booking
 * fee. A change applies to bookings made after it; each booking keeps the
 * policy it was made under (`booking.client_cancel_cutoff_hours`).
 *
 * Every value is range-checked here, so a rate above 1 is a 422 and never a
 * `23514` from the database. Lower bounds are the `photographer_setting`
 * CHECKs. The only upper bounds are the ones storage imposes: the rate's
 * `<= 1`, and `int4` for the rest, past which PostgreSQL would raise 22003. No
 * operating ceiling is invented here.
 */

/** Any subset of the six values. Unknown keys are refused, so a misspelt field
 *  (or the retired `holdMinutes`) is a 400 rather than a save that silently
 *  changed nothing. */
const settingsBody = z.strictObject({
  bookingFeeRate: feeRate.optional(),
  minLeadTimeMinutes: z.int().min(0).max(INT4_MAX).optional(),
  bufferMinutes: z.int().min(0).max(INT4_MAX).optional(),
  deliveryExpiryDays: z.int().min(1).max(INT4_MAX).optional(),
  clientCancelCutoffHours: z.int().min(0).max(INT4_MAX).optional(),
  bookingFeeRefundableOnClientCancel: z.boolean().optional(),
});

export function settingsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const { photographerId } = photographerLocals(res);
    res.json({ settings: await getPhotographerSettings(photographerId, prisma) });
  });

  router.patch('/', async (req, res) => {
    const body = parseOrReject(settingsBody, req.body, res);
    if (body === undefined) return;

    const { photographerId } = photographerLocals(res);
    res.json({ settings: await updatePhotographerSettings(photographerId, body, prisma) });
  });

  return router;
}
