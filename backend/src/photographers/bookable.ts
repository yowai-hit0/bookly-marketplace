import type { Photographer, Prisma } from '@prisma/client';

/**
 * Whether a photographer can be booked: the one rule, in one place (brief
 * decision 2; marketplace-spec.md R1.3).
 *
 * In Phase 1 that is `status = 'approved'`. Phase 5 adds the subscription --
 * a `past_due` photographer stays visible but cannot be booked -- and changes
 * this file only. Every public read and every write into a calendar goes
 * through one of the three forms below, so the Prisma filter, the in-memory
 * check and the locked re-check inside the claim can never disagree.
 *
 * An unbookable photographer is never named as such to the public: their handle
 * is a 404 and their packages answer exactly like an inactive package, so the
 * catalogue does not reveal whether someone is pending, suspended or unknown.
 */

/** The Prisma filter for a bookable photographer, for the public reads. */
export const BOOKABLE_PHOTOGRAPHER = { status: 'approved' } satisfies Prisma.PhotographerWhereInput;

/** The same rule over a row already in hand. */
export function isBookable(photographer: Pick<Photographer, 'status'>): boolean {
  return photographer.status === BOOKABLE_PHOTOGRAPHER.status;
}

/**
 * The same rule again, read inside a transaction that is about to write into the
 * photographer's calendar (the slot claim, R1.3). `FOR SHARE` holds the row, so
 * a suspension cannot commit between this check and the insert that relies on
 * it: it waits for the claim, and the claim sees the photographer as they were
 * when it decided. A photographer id that names nobody is not bookable.
 */
export async function lockBookablePhotographer(tx: Prisma.TransactionClient, photographerId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Pick<Photographer, 'status'>[]>`
    SELECT status FROM photographer WHERE id = ${photographerId}::uuid FOR SHARE`;
  const row = rows[0];
  return row !== undefined && isBookable(row);
}
