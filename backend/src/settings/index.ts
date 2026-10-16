import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/client.js';
import { readSettingRow, updateSettingRow } from './repository.js';

/**
 * The five editable operating values (spec P-30), plus the two constants that
 * have no settings screen behind them. Nothing here is ever a `Decimal` --
 * `bookingFeeRate` is converted at this boundary so no caller handles one
 * (data-model_v2.md §2.1).
 */
export type Settings = {
  bookingFeeRate: number;
  minLeadTimeMinutes: number;
  holdMinutes: number;
  bufferMinutes: number;
  deliveryExpiryDays: number;
};

// Re-exported so callers have one settings entrypoint. They are defined in a
// module that imports nothing, so the availability engine can read the slot
// granularity without dragging a PrismaClient in behind it (plan.md Task 5).
export { ACCESS_TOKEN_LIFETIME_DAYS, SLOT_GRANULARITY_MINUTES } from './constants.js';

/** The single accessor for the five operating values (plan.md Task 4). */
export async function getSettings(prisma: PrismaClient = defaultPrisma): Promise<Settings> {
  return toSettings(await readSettingRow(prisma));
}

/**
 * Saves any subset of the five values and returns all five as stored (plan.md
 * Task 8). Range rules are the caller's to enforce first; the database CHECKs
 * behind this are a backstop, not the validation.
 *
 * Nothing already booked moves: a booking snapshotted its own buffer end and
 * fee rate at creation (data-model_v2.md §5.9), so a changed buffer or rate
 * applies to new bookings only.
 */
export async function updateSettings(
  update: Partial<Settings>,
  prisma: PrismaClient = defaultPrisma,
): Promise<Settings> {
  const { bookingFeeRate, ...rest } = update;
  return toSettings(
    await updateSettingRow(prisma, {
      ...rest,
      // numeric(4,3): written as a three-place string so no float reaches the
      // column. Callers reject a fourth decimal place rather than have it round.
      ...(bookingFeeRate === undefined ? {} : { bookingFeeRate: bookingFeeRate.toFixed(3) }),
    }),
  );
}

function toSettings(row: Prisma.SettingGetPayload<object>): Settings {
  return {
    bookingFeeRate: row.bookingFeeRate.toNumber(),
    minLeadTimeMinutes: row.minLeadTimeMinutes,
    holdMinutes: row.holdMinutes,
    bufferMinutes: row.bufferMinutes,
    deliveryExpiryDays: row.deliveryExpiryDays,
  };
}
