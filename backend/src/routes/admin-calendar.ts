import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { findCalendar } from '../calendar/query.js';
import { kigaliDate, parseOrReject } from './validation.js';

/**
 * `GET /api/admin/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` -- bookings, live
 * holds and blocks for the month, week and day views (plan.md Task 9). Mounted
 * behind `requireAdmin`.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Enough for a month grid padded to whole weeks (at most 42 days) with room to
 * spare, and small enough that one request cannot ask for years of bookings.
 * A developer default, not a spec value.
 */
export const MAX_CALENDAR_DAYS = 62;

const calendarQuery = z
  .strictObject({ from: kigaliDate, to: kigaliDate })
  .refine((q) => q.to >= q.from, { message: 'to is before from', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / MS_PER_DAY + 1 <= MAX_CALENDAR_DAYS, {
    message: `At most ${MAX_CALENDAR_DAYS} days`,
    path: ['to'],
  });

export function calendarRouter(prisma: PrismaClient, now: () => Date): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = parseOrReject(calendarQuery, req.query, res);
    if (query === undefined) return;

    res.json(await findCalendar(prisma, { ...query, now: now() }));
  });

  return router;
}
