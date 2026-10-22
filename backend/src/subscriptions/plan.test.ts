import { describe, expect, it } from 'vitest';
import { DAY_MS, addDays, addPlanInterval, graceEndsAt, planPrice, statusAt } from './plan.js';

/**
 * The subscription calendar and status rules (marketplace-data-model.md §3.7;
 * marketplace-spec.md R5.3, R5.4). Pure: no database.
 */

const at = (iso: string) => new Date(iso);

describe('addPlanInterval: one month or one year on the Kigali calendar (§3.7)', () => {
  it.each([
    // [start, interval, end] -- instants in UTC; Kigali is UTC+2.
    ['2026-10-01T07:00:00.000Z', 'monthly', '2026-11-01T07:00:00.000Z'],
    ['2026-10-01T07:00:00.000Z', 'yearly', '2027-10-01T07:00:00.000Z'],
    ['2026-12-15T10:30:00.000Z', 'monthly', '2027-01-15T10:30:00.000Z'],
    // 31 January + 1 month is the last day of February, at the same wall time.
    ['2027-01-31T07:00:00.000Z', 'monthly', '2027-02-28T07:00:00.000Z'],
    ['2028-01-31T07:00:00.000Z', 'monthly', '2028-02-29T07:00:00.000Z'],
    ['2026-03-31T07:00:00.000Z', 'monthly', '2026-04-30T07:00:00.000Z'],
    // 29 February + 1 year is 28 February.
    ['2028-02-29T07:00:00.000Z', 'yearly', '2029-02-28T07:00:00.000Z'],
    // 31 Jan 23:30 UTC is 1 February 01:30 in Kigali: + 1 month is 1 March 01:30 Kigali.
    ['2027-01-31T23:30:00.000Z', 'monthly', '2027-02-28T23:30:00.000Z'],
    // 31 Jan 21:30 UTC is still 31 January (23:30) in Kigali: clamped to 28 February 23:30 Kigali.
    ['2027-01-31T21:30:00.000Z', 'monthly', '2027-02-28T21:30:00.000Z'],
    // The milliseconds are kept.
    ['2026-10-01T07:00:00.123Z', 'monthly', '2026-11-01T07:00:00.123Z'],
  ] as const)('%s + %s = %s', (start, interval, end) => {
    expect(addPlanInterval(at(start), interval).toISOString()).toBe(end);
  });

  it('is the Kigali calendar, not the UTC one: 30 April 23:00 Kigali stays a 30th', () => {
    // 2026-04-30T21:00Z is 30 April 23:00 in Kigali; in UTC terms it is the 30th too, but
    // 2026-05-31T22:30Z is already 1 June 00:30 in Kigali, so a month on is 1 July 00:30 Kigali.
    expect(addPlanInterval(at('2026-05-31T22:30:00.000Z'), 'monthly').toISOString()).toBe('2026-06-30T22:30:00.000Z');
  });
});

describe('statusAt (§3.7)', () => {
  const end = at('2026-11-01T07:00:00.000Z');
  const ms = (offset: number) => new Date(end.getTime() + offset);

  it.each([
    ['trialing', -1, 7, 'trialing'],
    ['active', -1, 7, 'active'],
    // The instant the period ends it is past_due: "while now < current_period_ends_at".
    ['trialing', 0, 7, 'past_due'],
    ['active', 0, 7, 'past_due'],
    ['active', 7 * DAY_MS - 1, 7, 'past_due'],
    ['active', 7 * DAY_MS, 7, 'expired'],
    ['past_due', 3 * DAY_MS, 7, 'past_due'],
    ['past_due', 8 * DAY_MS, 7, 'expired'],
    ['expired', 30 * DAY_MS, 7, 'expired'],
    // A late job: the stored status still says trialing, the clock says otherwise.
    ['trialing', 10 * DAY_MS, 7, 'expired'],
    // No grace: expired at the end.
    ['active', 0, 0, 'expired'],
    // A stored past_due with the period running again cannot happen; it reads as active.
    ['past_due', -1, 7, 'active'],
    ['expired', -DAY_MS, 7, 'active'],
  ] as const)('stored %s, %d ms after the end, %d grace days: %s', (stored, offset, grace, expected) => {
    expect(statusAt(stored, end, ms(offset), grace)).toBe(expected);
  });
});

describe('graceEndsAt, addDays and planPrice', () => {
  it('counts grace and trial days as 24 hours: Kigali keeps no daylight saving', () => {
    expect(graceEndsAt(at('2026-11-01T07:00:00.000Z'), 7).toISOString()).toBe('2026-11-08T07:00:00.000Z');
    expect(addDays(at('2026-10-01T07:00:00.000Z'), 30).toISOString()).toBe('2026-10-31T07:00:00.000Z');
  });

  it("charges the platform's price for the interval chosen", () => {
    const settings = { subscriptionMonthlyPriceRwf: 10_000, subscriptionYearlyPriceRwf: 100_000 };
    expect(planPrice(settings, 'monthly')).toBe(10_000);
    expect(planPrice(settings, 'yearly')).toBe(100_000);
  });
});
