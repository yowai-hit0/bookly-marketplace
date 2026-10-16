/**
 * The booking status vocabulary, in code, so the exclusion constraint's
 * predicate can be asserted against it (data-model_v2.md 7.1).
 *
 * This is not decoration. Adding a status to the database CHECK without adding
 * it to OCCUPYING_STATUSES -- or to the constraint predicate -- would silently
 * free occupied time and reintroduce the double booking this project exists to
 * prevent. The schema test fails when these three drift apart.
 */

export const BOOKING_STATUSES = [
  'pending_payment',
  'confirmed',
  'completed',
  'no_show',
  'expired',
  'cancelled_by_client',
  'cancelled_by_admin',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * Statuses that hold their slot. `completed` and `no_show` occupy because the
 * time was consumed (spec 6.12); `pending_payment` occupies until its hold
 * lapses, which the claim transaction resolves in-transaction rather than by
 * relying on the sweeper (data-model_v2.md 9.2).
 */
export const OCCUPYING_STATUSES = [
  'pending_payment',
  'confirmed',
  'completed',
  'no_show',
] as const satisfies readonly BookingStatus[];
