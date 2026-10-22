import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/client.js';
import {
  type PhotographerSettingRow,
  type PlatformSettingRow,
  readPhotographerSettingRow,
  readPhotographerSettingRows,
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
 * and match how long a MoMo prompt lasts, so no photographer sets it. The rest
 * is the one subscription plan (marketplace-spec.md R5.1, R5.4;
 * marketplace-data-model.md §3.2), edited by a platform admin
 * (`PATCH /api/platform/settings`).
 */
export type PlatformSettings = {
  holdMinutes: number;
  /** The free trial a photographer gets at approval. Changing it affects later approvals only. */
  trialDays: number;
  /** Whole RWF. The seed's values are placeholders to set before launch (db/seed.ts). */
  subscriptionMonthlyPriceRwf: number;
  subscriptionYearlyPriceRwf: number;
  /** Days of `past_due` after a period ends, before `expired`. */
  subscriptionGraceDays: number;
  /** Days before a period ends that a reminder goes out, largest first. */
  subscriptionReminderDays: number[];
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
 * Several photographers' operating values in one read, keyed by photographer id
 * (the directory's date filter, marketplace-spec.md R6.1). The same missing-row
 * rule as `getPhotographerSettings()`: an id without a row throws.
 */
export async function getPhotographerSettingsFor(
  photographerIds: readonly string[],
  prisma: Db = defaultPrisma,
): Promise<Map<string, PhotographerSettings>> {
  if (photographerIds.length === 0) return new Map();
  const rows = await readPhotographerSettingRows(prisma, photographerIds);
  const settings = new Map(rows.map((row) => [row.photographerId, toPhotographerSettings(row)]));
  const missing = photographerIds.find((id) => !settings.has(id));
  if (missing !== undefined) throw new Error(`photographer ${missing} has no settings row`);
  return settings;
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
  return {
    holdMinutes: row.holdMinutes,
    trialDays: row.trialDays,
    subscriptionMonthlyPriceRwf: row.subscriptionMonthlyPriceRwf,
    subscriptionYearlyPriceRwf: row.subscriptionYearlyPriceRwf,
    subscriptionGraceDays: row.subscriptionGraceDays,
    // Stored as the admin saved them; read largest first, the order they fall due in.
    subscriptionReminderDays: [...row.subscriptionReminderDays].sort((a, b) => b - a),
  };
}
