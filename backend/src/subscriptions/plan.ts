/**
 * The subscription vocabulary and calendar (marketplace-spec.md Phase 5;
 * marketplace-data-model.md §3.7, §4). Pure: no database, no clock of its own,
 * so the job, the payment path, the views and the tests share one definition
 * of what a month is and what status a moment falls in.
 */

/** `payment_plan_interval_allowed`, `subscription_period_plan_interval_allowed`. */
export const PLAN_INTERVALS = ['monthly', 'yearly'] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];

/** `subscription_status_allowed`. */
export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'expired'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** `subscription_period_kind_allowed`. */
export const PERIOD_KINDS = ['trial', 'paid'] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export const DAY_MS = 24 * 60 * 60_000;
/** Kigali is UTC+2 all year, with no daylight saving (format.ts says the same). */
const KIGALI_OFFSET_MS = 2 * 60 * 60_000;

/**
 * `start` plus one month or one year ON THE KIGALI CALENDAR (§3.7): the same
 * wall-clock time on the same day of the next month or year, clamped to that
 * month's last day -- 31 January + 1 month is 28 (or 29) February, and 29
 * February + 1 year is 28 February. Kigali keeps no daylight saving, so the
 * wall clock maps back to one instant.
 */
export function addPlanInterval(start: Date, interval: PlanInterval): Date {
  const wall = new Date(start.getTime() + KIGALI_OFFSET_MS);
  const months = interval === 'monthly' ? 1 : 12;
  const targetMonthIndex = wall.getUTCMonth() + months;
  const year = wall.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const month = targetMonthIndex % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(wall.getUTCDate(), lastDay);
  const shifted = Date.UTC(year, month, day, wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds(), wall.getUTCMilliseconds());
  return new Date(shifted - KIGALI_OFFSET_MS);
}

/** `start` plus whole days. A Kigali day is 24 hours: no daylight saving. */
export function addDays(start: Date, days: number): Date {
  return new Date(start.getTime() + days * DAY_MS);
}

/** When a period ending at `endsAt` stops being `past_due` and becomes `expired`. */
export function graceEndsAt(endsAt: Date, graceDays: number): Date {
  return addDays(endsAt, graceDays);
}

/**
 * The status a subscription is in at `now` by the rules of §3.7, whatever the
 * job has written yet: `trialing` or `active` (as stored) while the period
 * runs, `past_due` until the end plus the grace days, `expired` after. The job
 * writes exactly this (subscriptions/job.ts); readers that must be right even
 * when it is late -- the studio's page, the platform's list -- read this.
 *
 * A stored `trialing`/`active` is kept while the period runs. A stored
 * `past_due`/`expired` with a period still running cannot happen (a payment
 * sets `active` in the transaction that extends the period), and reads as
 * `active` if it ever did.
 */
export function statusAt(stored: string, currentPeriodEndsAt: Date, now: Date, graceDays: number): SubscriptionStatus {
  if (now.getTime() < currentPeriodEndsAt.getTime()) return stored === 'trialing' ? 'trialing' : 'active';
  if (now.getTime() < graceEndsAt(currentPeriodEndsAt, graceDays).getTime()) return 'past_due';
  return 'expired';
}

/** The plan's price for an interval, from the platform's settings (R5.2: never from the request). */
export function planPrice(settings: { subscriptionMonthlyPriceRwf: number; subscriptionYearlyPriceRwf: number }, interval: PlanInterval): number {
  return interval === 'monthly' ? settings.subscriptionMonthlyPriceRwf : settings.subscriptionYearlyPriceRwf;
}
