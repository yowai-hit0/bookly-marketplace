import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { findAvailability } from '../availability/query.js';
import { BOOKABLE_PACKAGE } from '../catalogue/public.js';
import { kigaliDate, parseOrReject } from './validation.js';

/**
 * `GET /api/availability?packageId=<uuid>&month=YYYY-MM` -- the starts a visitor
 * may book for one package, every Kigali date of one month (plan.md Task 12;
 * spec §3.1 steps 4-5, P-02). Anonymous by design.
 *
 *   200 { days: [{ date: 'YYYY-MM-DD', starts: ['<ISO UTC instant>', ...] }] }
 *
 * Every rule lives in the engine (data-model_v2.md §8) and the projection in
 * `findAvailability()`, which never selects a block reason, a booking id or a
 * client name; this route returns it unchanged. A package the public cannot
 * book -- unknown, inactive, or on an inactive service -- is a 422 naming
 * `packageId`, the same answer the quote gives.
 *
 * No caching layer, and `Cache-Control: no-store` so no browser or proxy adds
 * one: the database is the single source of truth for availability, and a
 * stale copy is how a visitor picks a slot that was taken a minute ago.
 */

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const availabilityQuery = z.strictObject({
  packageId: z.guid(),
  month: z
    .string()
    .regex(MONTH_PATTERN)
    // The engine refuses years 0000-0099 (routes/validation.ts); a well-formed
    // month it cannot compute is a 422, as it is for the admin's dates.
    .refine((month) => kigaliDate.safeParse(`${month}-01`).success, 'Unsupported month'),
});

export function availabilityRouter(prisma: PrismaClient, now: () => Date): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');

    const query = parseOrReject(availabilityQuery, req.query, res);
    if (query === undefined) return;

    const pkg = await prisma.package.findFirst({
      where: { id: query.packageId, ...BOOKABLE_PACKAGE },
      select: { durationMinutes: true },
    });
    if (pkg === null) {
      res.status(422).json({ error: 'validation_failed', fields: ['packageId'] });
      return;
    }

    const days = await findAvailability(prisma, {
      from: `${query.month}-01`,
      to: `${query.month}-${lastDayOfMonth(query.month)}`,
      packageDurationMinutes: pkg.durationMinutes,
      now: now(),
    });
    res.json({ days });
  });

  return router;
}

/** `2026-02` → `28`. Day 0 of the next month is the last day of this one. */
function lastDayOfMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  return String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, '0');
}
