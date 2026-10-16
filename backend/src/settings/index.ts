import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/client.js';
import {
  type PhotographerSettingRow,
  type PlatformSettingRow,
  readPhotographerSettingRow,
  readPlatformSettingRow,
  updatePhotographerSettingRow,
  updatePlatformSettingRow,
} from './repository.js';

/** A client, or the client inside an interactive transaction. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * One photographer's editable operating values (spec P-30, now per
 * photographer, marketplace-data-model.md §2.2), plus the client cancellation
 * policy each photographer sets for themselves (R1.8). Nothing here is ever a
 * `Decimal` -- `bookingFeeRate` is converted at this boundary so no caller
 * handles one (data-model_v2.md §2.1).
 */
export type PhotographerSettings = {
  bookingFeeRate: number;
  minLeadTimeMinutes: number;
  bufferMinutes: number;
  deliveryExpiryDays: number;
  /** A client may cancel until starts_at minus this many hours; 0 = any time before the shoot. */
  clientCancelCutoffHours: number;
  /** Whether a client's own cancellation refunds the booking fee. A photographer cancelling always does. */
  bookingFeeRefundableOnClientCancel: boolean;
};

/**
 * What belongs to the platform rather than to any photographer. The checkout
 * hold is payment infrastructure: it must stay inside the reconciler's window
 * and match how long a MoMo prompt lasts, so no photographer sets it.
 */
export type PlatformSettings = {
  holdMinutes: number;
  trialDays: number;
};

// Re-exported so callers have one settings entrypoint. They are defined in a
// module that imports nothing, so the availability engine can read the slot
// granularity without dragging a PrismaClient in behind it (plan.md Task 5).
export { ACCESS_TOKEN_LIFETIME_DAYS, SLOT_GRANULARITY_MINUTES } from './constants.js';

/**
 * The single accessor for a photographer's operating values (plan.md Task 4).
 * `photographerId` comes from the verified token or from the package being
 * booked, never from a request body (R1.4). Throws when the photographer has no
 * settings row, which the signup transaction rules out.
 */
export async function getPhotographerSettings(photographerId: string, prisma: Db = defaultPrisma): Promise<PhotographerSettings> {
  return toPhotographerSettings(await readPhotographerSettingRow(prisma, photographerId));
}

/**
 * Saves any subset of one photographer's values and returns all of them as
 * stored (plan.md Task 8). Range rules are the caller's to enforce first; the
 * database CHECKs behind this are a backstop, not the validation.
 *
 * Nothing already booked moves: a booking snapshotted its own buffer end and
 * fee rate at creation (data-model_v2.md §5.9), so a changed buffer or rate
 * applies to new bookings only.
 */
export async function updatePhotographerSettings(
  photographerId: string,
  update: Partial<PhotographerSettings>,
  prisma: Db = defaultPrisma,
): Promise<PhotographerSettings> {
  const { bookingFeeRate, ...rest } = update;
  return toPhotographerSettings(
    await updatePhotographerSettingRow(prisma, photographerId, {
      ...rest,
      // numeric(4,3): written as a three-place string so no float reaches the
      // column. Callers reject a fourth decimal place rather than have it round.
      ...(bookingFeeRate === undefined ? {} : { bookingFeeRate: bookingFeeRate.toFixed(3) }),
    }),
  );
}

/** The single accessor for the platform's values. Throws when the seed never ran. */
export async function getPlatformSettings(prisma: Db = defaultPrisma): Promise<PlatformSettings> {
  return toPlatformSettings(await readPlatformSettingRow(prisma));
}

/** Saves any subset of the platform's values and returns all of them as stored. */
export async function updatePlatformSettings(update: Partial<PlatformSettings>, prisma: Db = defaultPrisma): Promise<PlatformSettings> {
  return toPlatformSettings(await updatePlatformSettingRow(prisma, update));
}

function toPhotographerSettings(row: PhotographerSettingRow): PhotographerSettings {
  return {
    bookingFeeRate: row.bookingFeeRate.toNumber(),
    minLeadTimeMinutes: row.minLeadTimeMinutes,
    bufferMinutes: row.bufferMinutes,
    deliveryExpiryDays: row.deliveryExpiryDays,
    clientCancelCutoffHours: row.clientCancelCutoffHours,
    bookingFeeRefundableOnClientCancel: row.bookingFeeRefundableOnClientCancel,
  };
}

function toPlatformSettings(row: PlatformSettingRow): PlatformSettings {
  return { holdMinutes: row.holdMinutes, trialDays: row.trialDays };
}
