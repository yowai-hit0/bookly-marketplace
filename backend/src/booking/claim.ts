import type { Booking, Prisma, PrismaClient } from '@prisma/client';
import { isSlotTaken, isTransactionConflict } from '../db/errors.js';

/**
 * The slot claim transaction (plan.md Task 6, data-model_v2.md §9.2).
 *
 * This is the concurrency-correct core of the double-booking fix. Correctness
 * does not live here -- it lives in `booking_no_overlap`, which makes two
 * overlapping reservations impossible whatever this code does. What lives here
 * is the one thing the constraint cannot do for itself: a predicate cannot call
 * `now()`, so a `pending_payment` row whose hold has lapsed still occupies its
 * range until something flips it to `expired`. A client claiming that slot in
 * the gap would be refused on behalf of a dead hold, so the claim expires stale
 * holds itself, inside the same transaction, before it inserts.
 *
 * The sweeper (`hold-sweeper.ts`) still runs for tidiness. Correctness does not
 * depend on its cadence.
 */

/** Everything the caller has already resolved: snapshots, references, amounts.
 *  Task 13 owns those rules; this module owns the race. */
export type ClaimSlotInput = Omit<
  Prisma.BookingUncheckedCreateInput,
  'id' | 'status' | 'holdExpiresAt' | 'createdAt' | 'updatedAt' | 'confirmedAt'
> & {
  startsAt: Date;
  endsAt: Date;
  bufferEndsAt: Date;
};

/** A deadlock with the sweeper is retried; three in a row is not contention any more. */
export const MAX_CLAIM_ATTEMPTS = 3;

/**
 * Generous against a queue of claims, each a few milliseconds long, yet bounded:
 * a stuck claim must not hold a pooled connection and the queue indefinitely.
 * Developer defaults, not spec values.
 */
const CLAIM_MAX_WAIT_MS = 10_000;
const CLAIM_TIMEOUT_MS = 15_000;

/**
 * The input built inside the claim's own transaction, for a caller whose other
 * writes must stand or fall with the claim -- recording the client a booking
 * belongs to, which a lost race must not leave behind (plan.md Task 13).
 */
export type ClaimSlotInputBuilder = (tx: Prisma.TransactionClient) => Promise<ClaimSlotInput>;

export type ClaimResult =
  | { status: 'claimed'; booking: Booking }
  /** Live occupancy already covers the range. The client sees "this slot was
   *  just taken" with a refreshed calendar (spec §6.1). */
  | { status: 'slot_taken' };

/**
 * Claims `[startsAt, bufferEndsAt)` for a new `pending_payment` booking.
 *
 * Returns a typed result rather than throwing: losing a race is an expected
 * outcome of a public booking form, not an exceptional one. Any other database
 * error still throws.
 */
export async function claimSlot(
  prisma: PrismaClient,
  input: ClaimSlotInput | ClaimSlotInputBuilder,
  holdMinutes: number,
): Promise<ClaimResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const booking = await prisma.$transaction(
        async (tx) => {
          // Claims queue here, one at a time. Two concurrent inserts under an
          // exclusion constraint can each wait on the other's uncommitted row:
          // PostgreSQL then kills one as a deadlock after `deadlock_timeout`,
          // and a burst of such waits outlasts the transaction's time limit and
          // rolls back the winner too -- a burst of visitors on one slot, and
          // nobody gets it. Serialised, every loser meets the winner's committed
          // row and gets a clean 23P01. The constraint is still the guarantee;
          // this only orders the claimants. A claim takes milliseconds, and one
          // photographer's calendar sees a handful a day.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bookly.claim_slot'))`;

          const data = typeof input === 'function' ? await input(tx) : input;

          // Both the hold's expiry and the staleness check below are measured
          // against the database clock, so no app/database skew can make a hold
          // outlive or predecease what the sweeper and the claim believe.
          const holdExpiresAt = await databaseNowPlusMinutes(tx, holdMinutes);

          await expireOverlappingStaleHolds(tx, data.startsAt, data.bufferEndsAt);

          // The constraint now sees only live occupancy.
          return tx.booking.create({
            data: { ...data, status: 'pending_payment', holdExpiresAt },
          });
        },
        { maxWait: CLAIM_MAX_WAIT_MS, timeout: CLAIM_TIMEOUT_MS },
      );

      return { status: 'claimed', booking };
    } catch (error) {
      // A failed statement aborts the whole transaction in PostgreSQL, so this is
      // caught outside the callback: the rollback has already happened by the time
      // we get here. Catching inside would leave us trying to COMMIT a dead
      // transaction.
      if (isSlotTaken(error)) return { status: 'slot_taken' };
      // Serialised claims cannot deadlock with each other, but the sweeper's
      // unordered UPDATE still can with a claim's. The rollback is complete, so
      // the whole claim -- builder included -- simply runs again.
      if (isTransactionConflict(error) && attempt < MAX_CLAIM_ATTEMPTS) continue;
      throw error;
    }
  }
}

/**
 * Step 2 of §9.2. Scoped to holds that overlap the requested range: this clears
 * what is in the way, not the whole table. The sweeper handles the rest.
 */
export async function expireOverlappingStaleHolds(
  tx: Prisma.TransactionClient,
  startsAt: Date,
  bufferEndsAt: Date,
): Promise<number> {
  return tx.$executeRaw`
    UPDATE booking
       SET status = 'expired'
     WHERE status = 'pending_payment'
       AND hold_expires_at <= now()
       AND tstzrange(starts_at, buffer_ends_at, '[)')
           && tstzrange(${startsAt}::timestamptz, ${bufferEndsAt}::timestamptz, '[)')`;
}

/**
 * The database clock, as epoch milliseconds.
 *
 * Deliberately NOT `SELECT now()`. A `timestamptz` crossing the driver boundary
 * is only unambiguous while the session timezone is UTC, which `db/client.ts`
 * pins for exactly that reason. Epoch milliseconds have no timezone to get
 * wrong at all, so this stays correct even if that pin is ever lost -- and a
 * hold born already lapsed is the failure it prevents.
 *
 * Do not "simplify" this back to selecting a timestamp; a test pins the window.
 */
async function databaseNowPlusMinutes(
  tx: Prisma.TransactionClient,
  minutes: number,
): Promise<Date> {
  const rows = await tx.$queryRaw<{ ms: bigint }[]>`
    SELECT (extract(epoch from now()) * 1000)::bigint AS ms`;
  const row = rows[0];
  if (row === undefined) throw new Error('The database returned no clock reading.');
  return new Date(Number(row.ms) + minutes * 60_000);
}
