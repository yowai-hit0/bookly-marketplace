import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { getSettings, updateSettings } from '../settings/index.js';
import { INT4_MAX, feeRate, parseOrReject } from './validation.js';

/**
 * `/api/admin/settings` -- the settings screen's API (plan.md Task 8, spec
 * P-15, P-24, P-30). Mounted behind `requireAdmin`.
 *
 * Every value is range-checked here, so a rate above 1 is a 422 and never a
 * `23514` from the database. Lower bounds are the `setting` CHECKs
 * (data-model_v2.md §5.2). The only upper bounds are the ones storage imposes:
 * the rate's `<= 1`, and `int4` for the rest, past which PostgreSQL would
 * raise 22003. No operating ceiling is invented here.
 */

/** Any subset of the five values. Unknown keys are refused, so a misspelt
 *  field is a 400 rather than a save that silently changed nothing. */
const settingsBody = z.strictObject({
  bookingFeeRate: feeRate.optional(),
  minLeadTimeMinutes: z.int().min(0).max(INT4_MAX).optional(),
  holdMinutes: z.int().min(1).max(INT4_MAX).optional(),
  bufferMinutes: z.int().min(0).max(INT4_MAX).optional(),
  deliveryExpiryDays: z.int().min(1).max(INT4_MAX).optional(),
});

export function settingsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ settings: await getSettings(prisma) });
  });

  router.patch('/', async (req, res) => {
    const body = parseOrReject(settingsBody, req.body, res);
    if (body === undefined) return;

    res.json({ settings: await updateSettings(body, prisma) });
  });

  return router;
}
