import type { Booking, Prisma, PrismaClient } from '@prisma/client';
import { isSlotTaken, isTransactionConflict } from '../db/errors.js';
import { lockBookablePhotographer } from '../photographers/bookable.js';

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
 *
 * Everything here is per photographer (marketplace-spec.md R1.3): the lock
 * claims queue on, the stale holds a claim may expire, and the bookability it
 * re-checks. Two photographers' calendars share nothing, so a claim for one
 * never waits on, or expires a hold of, another.
 */

/** Everything the caller has already resolved: snapshots, references, amounts.
 *  Task 13 owns those rules; this module owns the race. The photographer is
 *  not part of it: the claim writes the one whose calendar it locked, so the
 *  lock and the row can never name two different photographers. */
export type ClaimSlotInput = Omit<
  Prisma.BookingUncheckedCreateInput,
  'id' | 'status' | 'holdExpiresAt' | 'createdAt' | 'updatedAt' | 'confirmedAt' | 'photographerId'
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
  | { status: 'slot_taken' }
  /** The photographer stopped being bookable after the caller checked: the
   *  caller answers as for a package that cannot be booked (brief decision 4). */
  | { status: 'not_bookable' };

/** Thrown inside the claim to roll it back; never escapes `claimSlot`. */
class NotBookable extends Error {}

/**
 * Claims `[startsAt, bufferEndsAt)` in `photographerId`'s calendar for a new
 * `pending_payment` booking of theirs.
 *
 * Returns a typed result rather than throwing: losing a race is an expected
 * outcome of a public booking form, not an exceptional one. Any other database
 * error still throws.
 */
export async function claimSlot(
  prisma: PrismaClient,
  photographerId: string,
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
          // photographer's calendar sees a handful a day -- the queue is that
          // photographer's alone, as the constraint is (R1.3).
          await lockPhotographerCalendar(tx, photographerId);

          // Decided again behind the lock: a photographer suspended since the
          // caller read the package takes no new booking (R1.3). The row is
          // held until commit, so a suspension waits for this claim.
          if (!(await lockBookablePhotographer(tx, photographerId))) throw new NotBookable();

          const data = typeof input === 'function' ? await input(tx) : input;

          // Both the hold's expiry and the staleness check below are measured
          // against the database clock, so no app/database skew can make a hold
          // outlive or predecease what the sweeper and the claim believe.
          const holdExpiresAt = await databaseNowPlusMinutes(tx, holdMinutes);

          await expireOverlappingStaleHolds(tx, photographerId, data.startsAt, data.bufferEndsAt);

          // The constraint now sees only live occupancy.
          return tx.booking.create({
            data: { ...data, photographerId, status: 'pending_payment', holdExpiresAt },
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
      if (error instanceof NotBookable) return { status: 'not_bookable' };
      // Serialised claims cannot deadlock with each other, but the sweeper's
      // unordered UPDATE still can with a claim's. The rollback is complete, so
      // the whole claim -- builder included -- simply runs again.
      if (isTransactionConflict(error) && attempt < MAX_CLAIM_ATTEMPTS) continue;
      throw error;
    }
  }
}

/**
 * The lock every writer into a photographer's calendar takes first: a claim, a
 * late payment re-confirming its booking, a reschedule. Transaction-scoped, so
 * it is released by the commit or rollback and can never leak.
 *
 * Keyed by photographer (R1.3). The key is text hashed to the 32-bit lock space,
 * so two photographers can, rarely, share a lock: they then queue behind each
 * other for a few milliseconds, which costs time and never correctness.
 */
export async function lockPhotographerCalendar(tx: Prisma.TransactionClient, photographerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bookly.claim_slot:' || ${photographerId}::text))`;
}

/**
 * Step 2 of §9.2. Scoped to the photographer's holds that overlap the requested
 * range: this clears what is in the way, not the whole table -- and never another
 * photographer's hold, which is in nobody's way here (R1.3). The sweeper handles
 * the rest.
 */
export async function expireOverlappingStaleHolds(
  tx: Prisma.TransactionClient,
  photographerId: string,
  startsAt: Date,
  bufferEndsAt: Date,
): Promise<number> {
  return tx.$executeRaw`
    UPDATE booking
       SET status = 'expired'
     WHERE photographer_id = ${photographerId}::uuid
       AND status = 'pending_payment'
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
