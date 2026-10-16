/**
 * The seam between Prisma's error shape and ours.
 *
 * Prisma does not model PostgreSQL's SQLSTATE codes. It wraps the driver's error
 * and buries the real code, and the Prisma code on the outside depends on which
 * path raised it: `P2039` from a model method, `P2010` from `$queryRaw`. So
 * neither the Prisma code nor the message text is safe to branch on -- the
 * SQLSTATE underneath is. This module is the only place that knows where it
 * hides, so an upgrade that moves it breaks one file rather than several.
 */

/** The SQLSTATEs this project actually reacts to. */
export const SQLSTATE = {
  /** `booking_no_overlap` refused an overlapping reservation (data-model_v2.md §9.1). */
  EXCLUSION_VIOLATION: '23P01',
  /** A unique or partial-unique index refused a duplicate (§9.3). */
  UNIQUE_VIOLATION: '23505',
  /** A `RESTRICT` foreign key refused a delete (§9.4). */
  FOREIGN_KEY_VIOLATION: '23503',
  /** A CHECK constraint refused the value. */
  CHECK_VIOLATION: '23514',
  /** PostgreSQL broke a lock cycle by aborting this transaction. Safe to retry. */
  DEADLOCK_DETECTED: '40P01',
  /** A serializable transaction could not be ordered. Safe to retry. */
  SERIALIZATION_FAILURE: '40001',
} as const;

export type Sqlstate = (typeof SQLSTATE)[keyof typeof SQLSTATE];

/**
 * The SQLSTATE a database error carries, or `undefined` if it carries none.
 *
 * Handles both shapes this project produces: a Prisma error, which nests the
 * driver's error under `meta.driverAdapterError.cause`, and a raw `pg` error,
 * which carries the code at the top level.
 */
export function sqlstateOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;

  const cause = driverCause(error);
  if (cause !== undefined) {
    // `originalCode` is the driver's own; `code` beside it is the same value.
    const code = cause.originalCode ?? cause.code;
    if (typeof code === 'string') return code;
  }

  // A Prisma error's own `code` is a Prisma code, never a SQLSTATE -- and no
  // shape test can separate them, because `P2039` is indistinguishable from a
  // real SQLSTATE like `P0001` (raise_exception). `clientVersion` is the honest
  // discriminator: only Prisma's errors carry it.
  if (typeof error.clientVersion === 'string') return undefined;

  return typeof error.code === 'string' ? error.code : undefined;
}

/** True when the error is `booking_no_overlap` refusing an overlap. */
export function isSlotTaken(error: unknown): boolean {
  return sqlstateOf(error) === SQLSTATE.EXCLUSION_VIOLATION;
}

/**
 * True when the database aborted the transaction to resolve contention -- a
 * deadlock or a serialization failure -- so running it again is correct.
 *
 * The one place a Prisma code is branched on, because Prisma sometimes reports
 * this with no SQLSTATE underneath: `P2034` is specifically "transaction failed
 * due to a write conflict or a deadlock", unlike the path-dependent codes the
 * module note warns about.
 */
export function isTransactionConflict(error: unknown): boolean {
  const sqlstate = sqlstateOf(error);
  if (sqlstate === SQLSTATE.DEADLOCK_DETECTED || sqlstate === SQLSTATE.SERIALIZATION_FAILURE) return true;
  return isRecord(error) && typeof error.clientVersion === 'string' && error.code === 'P2034';
}

function driverCause(error: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = error.meta;
  if (!isRecord(meta)) return undefined;

  const driverAdapterError = meta.driverAdapterError;
  if (!isRecord(driverAdapterError)) return undefined;

  return isRecord(driverAdapterError.cause) ? driverAdapterError.cause : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
