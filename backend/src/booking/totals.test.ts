import { describe, expect, it } from 'vitest';
import { BOOKING_STATUSES } from '../db/statuses.js';
import { type TotalsAddon, type TotalsPayment, bookingTotals, dueRwf, overpaymentHeldRwf, refundAmountRwf } from './totals.js';

/**
 * A booking's money, derived (data-model_v2.md §6.1; spec §6.10-§6.12). No
 * database.
 *
 * What is proven, row by row of §6.1: the quoted total is the package plus the
 * at-booking add-ons; the grand total adds the post-shoot ones; only succeeded
 * payments are collected, and refund_due is reported beside them, never netted
 * off; and what is outstanding depends on the status -- the grand total less
 * what was collected for pending_payment, confirmed and completed, and nothing
 * at all for no_show, cancelled_by_client, cancelled_by_photographer and expired.
 * Outstanding never goes below zero, and moving a payment to refund_due does
 * not make the client owe more on a booking that no longer stands.
 */

const PACKAGE = 40_000;

const ADDONS: TotalsAddon[] = [
  { stage: 'at_booking', amountRwf: 10_000 },
  { stage: 'at_booking', amountRwf: 5_000 },
  { stage: 'post_shoot', amountRwf: 7_000 },
];

/** Every payment status, so each rule must pick its own. */
const PAYMENTS: TotalsPayment[] = [
  { status: 'succeeded', amountRwf: 22_000 },
  { status: 'succeeded', amountRwf: 3_000 },
  { status: 'refund_due', amountRwf: 22_000 },
  { status: 'refunded', amountRwf: 1_000 },
  { status: 'failed', amountRwf: 22_000 },
  { status: 'pending', amountRwf: 22_000 },
  { status: 'initiated', amountRwf: 22_000 },
];

function totalsFor(status: string, addons: TotalsAddon[] = ADDONS, payments: TotalsPayment[] = PAYMENTS) {
  return bookingTotals({ status, packagePriceRwf: PACKAGE }, addons, payments);
}

describe('bookingTotals: the amounts that do not depend on status', () => {
  it('quotes the package plus at-booking add-ons: 55,000', () => {
    expect(totalsFor('confirmed').quotedTotalRwf).toBe(55_000);
  });

  it('adds post-shoot add-ons to the grand total: 62,000', () => {
    expect(totalsFor('confirmed').grandTotalRwf).toBe(62_000);
  });

  it('collects succeeded payments only: 25,000', () => {
    expect(totalsFor('confirmed').collectedRwf).toBe(25_000);
  });

  it('reports refund_due separately: 22,000, not netted off what was collected', () => {
    const totals = totalsFor('confirmed');
    expect(totals.refundDueRwf).toBe(22_000);
    expect(totals.collectedRwf).toBe(25_000);
  });

  it.each(BOOKING_STATUSES)('computes the same quoted, grand, collected and refund-due amounts for %s', (status) => {
    expect(totalsFor(status)).toMatchObject({ quotedTotalRwf: 55_000, grandTotalRwf: 62_000, collectedRwf: 25_000, refundDueRwf: 22_000 });
  });

  it('is the package alone with no add-ons and no payments', () => {
    expect(totalsFor('pending_payment', [], [])).toStrictEqual({
      quotedTotalRwf: PACKAGE,
      grandTotalRwf: PACKAGE,
      collectedRwf: 0,
      refundDueRwf: 0,
      outstandingRwf: PACKAGE,
    });
  });

  it('ignores add-ons of a stage it does not know', () => {
    expect(totalsFor('confirmed', [{ stage: 'someday', amountRwf: 99_000 }], []).grandTotalRwf).toBe(PACKAGE);
  });
});

describe('bookingTotals: outstanding, by booking status (data-model_v2.md §6.1)', () => {
  it.each([
    ['pending_payment', 37_000],
    ['confirmed', 37_000],
    ['completed', 37_000],
    ['no_show', 0],
    ['cancelled_by_client', 0],
    ['cancelled_by_photographer', 0],
    ['expired', 0],
  ])('%s owes %s', (status, outstanding) => {
    expect(totalsFor(status).outstandingRwf).toBe(outstanding);
  });

  it('covers every booking status in the schema', () => {
    const owing = BOOKING_STATUSES.filter((status) => totalsFor(status).outstandingRwf > 0);
    expect(owing).toEqual(['pending_payment', 'confirmed', 'completed']);
  });

  it('owes nothing on a status it does not know', () => {
    expect(totalsFor('archived').outstandingRwf).toBe(0);
  });

  it('owes the whole grand total before anything is collected', () => {
    expect(totalsFor('pending_payment', ADDONS, [{ status: 'pending', amountRwf: 22_000 }]).outstandingRwf).toBe(62_000);
  });

  it('owes nothing, never a negative amount, once more than the grand total was collected', () => {
    const overpaid = [
      { status: 'succeeded', amountRwf: 62_000 },
      { status: 'succeeded', amountRwf: 22_000 },
    ];
    expect(totalsFor('confirmed', ADDONS, overpaid)).toMatchObject({ collectedRwf: 84_000, outstandingRwf: 0 });
    expect(totalsFor('completed', ADDONS, [{ status: 'succeeded', amountRwf: 62_000 }]).outstandingRwf).toBe(0);
  });

  it('does not jump for a cancelled booking when its fee moves from succeeded to refund_due', () => {
    const before = totalsFor('cancelled_by_photographer', ADDONS, [{ status: 'succeeded', amountRwf: 22_000 }]);
    const after = totalsFor('cancelled_by_photographer', ADDONS, [{ status: 'refund_due', amountRwf: 22_000 }]);
    expect([before.outstandingRwf, after.outstandingRwf]).toEqual([0, 0]);
    expect(after.refundDueRwf).toBe(22_000);
  });

  it('matches what a confirmation email says: 50,000 quoted, 20,000 paid, 30,000 outstanding', () => {
    expect(
      bookingTotals(
        { status: 'confirmed', packagePriceRwf: 40_000 },
        [{ stage: 'at_booking', amountRwf: 10_000 }],
        [{ status: 'succeeded', amountRwf: 20_000 }],
      ),
    ).toStrictEqual({ quotedTotalRwf: 50_000, grandTotalRwf: 50_000, collectedRwf: 20_000, refundDueRwf: 0, outstandingRwf: 30_000 });
  });

  it('does not modify its inputs', () => {
    const addons = structuredClone(ADDONS);
    const payments = structuredClone(PAYMENTS);
    totalsFor('confirmed', addons, payments);
    expect(addons).toEqual(ADDONS);
    expect(payments).toEqual(PAYMENTS);
  });
});

describe('bookingTotals: an overpaid payment (Phase 4 overpayment decision)', () => {
  /** 50,000 owed: the package and one at-booking add-on. */
  const owed: TotalsAddon[] = [{ stage: 'at_booking', amountRwf: 10_000 }];
  const bookingFee: TotalsPayment = { status: 'succeeded', amountRwf: 20_000 };
  const overpaid: TotalsPayment = { status: 'succeeded', amountRwf: 40_000, overpaidRwf: 10_000, overpaymentRefundedAt: null };
  const returned: TotalsPayment = { ...overpaid, overpaymentRefundedAt: new Date('2027-01-10T08:00:00Z') };

  it('collects only the part that was due, and reports the overpaid part as owed back', () => {
    expect(totalsFor('confirmed', owed, [bookingFee, overpaid])).toMatchObject({ collectedRwf: 50_000, refundDueRwf: 10_000, outstandingRwf: 0 });
  });

  it('owes nothing back once the platform has returned the overpaid part, and still collects what was due', () => {
    expect(totalsFor('confirmed', owed, [bookingFee, returned])).toMatchObject({ collectedRwf: 50_000, refundDueRwf: 0, outstandingRwf: 0 });
  });

  it('asks for an add-on afterwards in full: the overpaid part never pays for it', () => {
    const later: TotalsAddon[] = [...owed, { stage: 'post_shoot', amountRwf: 15_000 }];
    expect(totalsFor('confirmed', later, [bookingFee, overpaid])).toMatchObject({ grandTotalRwf: 65_000, outstandingRwf: 15_000 });
  });

  it('owes back a payment flagged whole for its whole amount, less an overpaid part already returned', () => {
    const due = (payment: TotalsPayment): TotalsPayment => ({ ...payment, status: 'refund_due' });
    expect(totalsFor('cancelled_by_photographer', owed, [due(bookingFee), due(overpaid)]).refundDueRwf).toBe(60_000);
    expect(totalsFor('cancelled_by_photographer', owed, [due(bookingFee), due(returned)]).refundDueRwf).toBe(50_000);
  });

  it('reads a payment without the overpayment fields as never overpaid', () => {
    expect(dueRwf({ status: 'succeeded', amountRwf: 20_000 })).toBe(20_000);
    expect(refundAmountRwf({ status: 'refund_due', amountRwf: 20_000 })).toBe(20_000);
    expect(overpaymentHeldRwf({ status: 'succeeded', amountRwf: 20_000 })).toBe(0);
  });
});
