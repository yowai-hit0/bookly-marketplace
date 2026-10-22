import { Router } from 'express';
import { z } from 'zod';
import type { AuthDeps } from '../auth/account-auth.js';
import { platformAdminLocals } from '../auth/middleware.js';
import { RECONCILE_MAX_AGE_MINUTES } from '../payments/reconcile.js';
import { getPlatformSettings, updatePlatformSettings } from '../settings/index.js';
import { SUBSCRIPTION_STATUSES } from '../subscriptions/plan.js';
import { listPlatformSubscriptions } from '../subscriptions/views.js';
import { INT4_MAX, parseOrReject } from './validation.js';

/**
 * The platform's settings and subscriptions (marketplace-spec.md R5.1, R9.3),
 * behind `requirePlatformAdmin`.
 *
 *   GET   /settings        200 { settings: { holdMinutes, trialDays,
 *                                subscriptionMonthlyPriceRwf, subscriptionYearlyPriceRwf,
 *                                subscriptionGraceDays, subscriptionReminderDays } }
 *   PATCH /settings        any subset of the same: 200 { settings } | 400 | 422
 *   GET   /subscriptions?status=trialing|active|past_due|expired
 *                          200 { subscriptions: [{ id, photographer, status,
 *                                currentPeriodEndsAt, graceEndsAt, createdAt, periods }] }
 *
 * Validation follows the admin rule (routes/validation.ts): an unknown key or a
 * wrong type is 400, a value outside its rules 422 naming the field -- never the
 * `23514` of the CHECK behind it. The bounds:
 *
 *   holdMinutes        1 to 60: the hold must stay inside the reconciler's window
 *                      (marketplace-data-model.md §2.2; payments/reconcile.ts), or a
 *                      payment made late in a hold would never be looked up
 *   trialDays          1 to 366: a trial is a period, and a period has a length
 *                      (CHECK platform_setting_trial_days_positive)
 *   prices             1 to the int4 limit (CHECK platform_setting_prices_positive)
 *   graceDays          0 to 366 (CHECK platform_setting_grace_days_non_negative)
 *   reminderDays       at most ten, each 1 to 366, each once (CHECK
 *                      platform_setting_reminder_days_valid); empty sends none
 *
 * The 366-day ceilings are developer bounds, not spec values: nothing about a
 * plan of one month or one year is served by a trial, grace or reminder longer
 * than a year.
 *
 * What a change touches: the hold, the next booking's hold; the trial, later
 * approvals; the prices, the next payment (one already started keeps its
 * frozen amount); the grace and the reminder days, every subscription at once
 * (listing and expiry compare the clock with them, R5.4). Every change is a
 * structured log line naming who and when (R9.4).
 */

/** A developer bound: see above. */
const MAX_PLAN_DAYS = 366;

const settingsBody = z.strictObject({
  holdMinutes: z.int().min(1).max(RECONCILE_MAX_AGE_MINUTES).optional(),
  trialDays: z.int().min(1).max(MAX_PLAN_DAYS).optional(),
  subscriptionMonthlyPriceRwf: z.int().min(1).max(INT4_MAX).optional(),
  subscriptionYearlyPriceRwf: z.int().min(1).max(INT4_MAX).optional(),
  subscriptionGraceDays: z.int().min(0).max(MAX_PLAN_DAYS).optional(),
  subscriptionReminderDays: z
    .array(z.int().min(1).max(MAX_PLAN_DAYS))
    .max(10)
    .refine((days) => new Set(days).size === days.length, 'Each day at most once')
    .optional(),
});

const subscriptionsQuery = z.strictObject({ status: z.enum(SUBSCRIPTION_STATUSES).optional() });

export type PlatformSettingsDeps = AuthDeps & { log?: (entry: Record<string, unknown>) => void };

export function platformSettingsRouter(deps: PlatformSettingsDeps): Router {
  const router = Router();

  router.get('/settings', async (_req, res) => {
    res.json({ settings: await getPlatformSettings(deps.prisma) });
  });

  router.patch('/settings', async (req, res) => {
    const body = parseOrReject(settingsBody, req.body, res);
    if (body === undefined) return;

    const settings = await updatePlatformSettings(
      {
        ...body,
        // Stored largest first, the order they fall due in.
        ...(body.subscriptionReminderDays === undefined ? {} : { subscriptionReminderDays: [...body.subscriptionReminderDays].sort((a, b) => b - a) }),
      },
      deps.prisma,
    );
    (deps.log ?? logLine)({
      level: 'info',
      event: 'platform_settings_updated',
      byUserId: platformAdminLocals(res).user.id,
      at: deps.now().toISOString(),
      changed: Object.keys(body),
      settings,
    });
    res.json({ settings });
  });

  router.get('/subscriptions', async (req, res) => {
    const query = parseOrReject(subscriptionsQuery, req.query, res);
    if (query === undefined) return;
    res.json({ subscriptions: await listPlatformSubscriptions(deps.prisma, deps.now(), query.status) });
  });

  return router;
}

function logLine(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}
