import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The only code in the project that touches `photographer_setting` and
 * `platform_setting` for a read or an edit.
 * `settings/index.ts` is the only permitted importer of this module -- proven
 * by a test that scans `src/` for any other import of it -- so a fee rate, a
 * lead time, a buffer, an expiry, a cancellation policy or the checkout hold
 * can be read from exactly one place (data-model_v2.md §5.2,
 * marketplace-data-model.md §2.2).
 *
 * The single-photographer `setting` row is split by owner. A photographer's
 * operating values are addressed by their photographer id, which callers take
 * from the verified token or from the package being booked, never from a
 * request body (R1.4). The platform row is a singleton.
 *
 * Seeding and fixtures write these tables directly rather than through here:
 * bootstrapping a row is a different concern from reading operational values.
 * A photographer's row is created in the same transaction as the photographer.
 */

/** A client, or the client inside an interactive transaction. */
type Db = PrismaClient | Prisma.TransactionClient;

export type PhotographerSettingRow = Prisma.PhotographerSettingGetPayload<object>;
export type PlatformSettingRow = Prisma.PlatformSettingGetPayload<object>;

export function readPhotographerSettingRow(prisma: Db, photographerId: string): Promise<PhotographerSettingRow> {
  // The row is born with its photographer, so a missing one means a photographer
  // created outside that transaction (or an id that names nobody) -- not a state
  // this function should paper over with defaults.
  return prisma.photographerSetting.findUniqueOrThrow({ where: { photographerId } });
}

/**
 * Several photographers' rows in one read, for the directory's date filter
 * (marketplace-spec.md R6.1), which runs the engine over a page of
 * photographers at once. Answers only the rows that exist; the caller applies
 * the missing-row rule.
 */
export function readPhotographerSettingRows(prisma: Db, photographerIds: readonly string[]): Promise<PhotographerSettingRow[]> {
  return prisma.photographerSetting.findMany({ where: { photographerId: { in: [...photographerIds] } } });
}

/** The studio settings screen's save (spec P-30). Same missing-row rule as the read. */
export function updatePhotographerSettingRow(
  prisma: Db,
  photographerId: string,
  data: Prisma.PhotographerSettingUpdateInput,
): Promise<PhotographerSettingRow> {
  return prisma.photographerSetting.update({ where: { photographerId }, data });
}

export function readPlatformSettingRow(prisma: Db): Promise<PlatformSettingRow> {
  // id = 1 is enforced by CHECK platform_setting_single_row; the seed creates
  // it, so a missing row means the seed never ran.
  return prisma.platformSetting.findUniqueOrThrow({ where: { id: 1 } });
}

/**
 * Locks the platform row for the rest of the transaction, so a save reads the
 * values it replaces without another save slipping in between (Phase 9: the
 * audit row records before and after).
 */
export async function lockPlatformSettingRow(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT id FROM platform_setting WHERE id = 1 FOR UPDATE`;
}

/** The platform settings screen's save (Phase 9). Same missing-row rule as the read. */
export function updatePlatformSettingRow(prisma: Db, data: Prisma.PlatformSettingUpdateInput): Promise<PlatformSettingRow> {
  return prisma.platformSetting.update({ where: { id: 1 }, data });
}
