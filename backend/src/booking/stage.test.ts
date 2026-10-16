import { describe, expect, it } from 'vitest';
import { BOOKING_STAGES, type StagedBooking, bookingStage, stageWhere } from './stage.js';

/**
 * Display stages (docs/prompts/client-access-and-admin-polish.md, item 7). No
 * database; `admin-list.test.ts` proves `stageWhere()` agrees with these rows
 * against real PostgreSQL.
 *
 * What is proven: every stored status maps to its stage, a confirmed booking
 * moves from confirmed to in progress at exactly its start and to needs review
 * (admin) or completed (client) at exactly its end, a completed booking is
 * closed exactly once its photos have been sent, and the client never sees
 * `needs_review`.
 */

const STARTS = new Date('2027-01-06T07:00:00Z');
const ENDS = new Date('2027-01-06T08:30:00Z');

function booking(status: string, extra: Partial<StagedBooking> = {}): StagedBooking {
  return { status, startsAt: STARTS, endsAt: ENDS, deliverySentAt: null, ...extra };
}

const before = new Date(STARTS.getTime() - 1);
const during = new Date(STARTS.getTime() + 30 * 60_000);
const after = new Date(ENDS.getTime() + 1);

describe('bookingStage', () => {
  it.each([
    ['pending_payment', before, 'awaiting_payment', 'awaiting_payment'],
    ['confirmed', before, 'confirmed', 'confirmed'],
    ['confirmed', STARTS, 'in_progress', 'in_progress'],
    ['confirmed', during, 'in_progress', 'in_progress'],
    ['confirmed', ENDS, 'needs_review', 'completed'],
    ['confirmed', after, 'needs_review', 'completed'],
    ['completed', after, 'completed', 'completed'],
    ['no_show', after, 'no_show', 'no_show'],
    ['expired', before, 'expired', 'expired'],
    ['cancelled_by_client', before, 'cancelled_by_client', 'cancelled_by_client'],
    ['cancelled_by_admin', before, 'cancelled_by_admin', 'cancelled_by_admin'],
  ] as const)('%s at %s is %s for the admin and %s for the client', (status, now, admin, client) => {
    expect(bookingStage(booking(status), now, 'admin')).toBe(admin);
    expect(bookingStage(booking(status), now, 'client')).toBe(client);
  });

  it('is closed once the photos email has gone, and only then', () => {
    expect(bookingStage(booking('completed', { deliverySentAt: after }), after, 'admin')).toBe('closed');
    expect(bookingStage(booking('completed', { deliverySentAt: after }), after, 'client')).toBe('closed');
    // A sent date on a booking that is not completed does not close it.
    expect(bookingStage(booking('confirmed', { deliverySentAt: before }), before, 'admin')).toBe('confirmed');
  });

  it('never shows the client needs_review, whatever the booking', () => {
    for (const status of ['pending_payment', 'confirmed', 'completed', 'no_show', 'expired', 'cancelled_by_client', 'cancelled_by_admin']) {
      for (const now of [before, STARTS, during, ENDS, after]) {
        expect(bookingStage(booking(status), now, 'client')).not.toBe('needs_review');
      }
    }
  });
});

describe('stageWhere', () => {
  it('has a filter for every stage', () => {
    for (const stage of BOOKING_STAGES) expect(Object.keys(stageWhere(stage, during)).length).toBeGreaterThan(0);
  });
});
