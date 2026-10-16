import { randomInt } from 'node:crypto';
import { kigaliDateOf } from '../availability/engine.js';

/**
 * Booking references: `BKY-YYMM-XXXXX` (data-model_v2.md §5.9). Quotable over
 * the phone, so the five random characters are Crockford base32, which leaves
 * out I, L, O and U -- nothing can be misheard as another character.
 *
 * `YYMM` is the Kigali month the booking was MADE, not the month of the shoot:
 * a reference survives every reschedule (spec §6.11), and a shoot month baked
 * into it would then be wrong.
 *
 * 32^5 is about 33 million references a month, so a collision is rare but not
 * impossible; the unique index catches one and the caller retries with a fresh
 * reference (plan.md Task 13).
 */

export const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const REFERENCE_PATTERN = /^BKY-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$/;

const RANDOM_CHARACTERS = 5;

/** A fresh reference for a booking made at `createdAt`. `randomIndex` is injectable for tests. */
export function generateReference(createdAt: Date, randomIndex: (size: number) => number = randomInt): string {
  const date = kigaliDateOf(createdAt);
  const yymm = `${date.slice(2, 4)}${date.slice(5, 7)}`;
  let suffix = '';
  for (let i = 0; i < RANDOM_CHARACTERS; i += 1) {
    suffix += CROCKFORD_BASE32.charAt(randomIndex(CROCKFORD_BASE32.length));
  }
  return `BKY-${yymm}-${suffix}`;
}
