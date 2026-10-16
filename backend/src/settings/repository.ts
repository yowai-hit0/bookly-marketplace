import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The only code in the project that touches the `setting` table for a read or
 * an edit.
 * `settings/index.ts` is the only permitted importer of this module -- proven
 * by a test that scans `src/` for any other import of it -- so a fee rate, a
 * notice period, a hold duration, a buffer or an expiry can be read from
 * exactly one place (data-model_v2.md §5.2).
 *
 * Seeding (`db/seed.ts`) writes this table directly rather than through here:
 * bootstrapping the one row is a different concern from reading operational
 * values, and the seed script runs once, long before any business logic asks
 * "what is the fee rate right now".
 */
export function readSettingRow(prisma: PrismaClient): Promise<Prisma.SettingGetPayload<object>> {
  // id = 1 is enforced by CHECK (data-model_v2.md §5.2); Task 4 seeds it, so a
  // missing row means the seed never ran rather than a state this function
  // should paper over.
  return prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
}

/** The settings screen's save (spec P-30). Same missing-row rule as the read. */
export function updateSettingRow(
  prisma: PrismaClient,
  data: Prisma.SettingUpdateInput,
): Promise<Prisma.SettingGetPayload<object>> {
  return prisma.setting.update({ where: { id: 1 }, data });
}
