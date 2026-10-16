import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { type DemoSummary, seedDemoData } from './seed-demo.js';

/** Only read when no platform admin exists yet -- a reseed of an already-seeded
 *  database needs neither variable present. */
const adminCredentialsSchema = z.object({
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(12),
});

/**
 * The starter categories (brief decision 8, R1.9). Platform-curated: a platform
 * admin adds, renames or deactivates them later (Phase 9). Slugs are matched on
 * reseed, so renaming one here adds a category rather than renaming it.
 */
export const STARTER_CATEGORIES = [
  { slug: 'wedding', nameEn: 'Wedding' },
  { slug: 'portrait', nameEn: 'Portrait' },
  { slug: 'event', nameEn: 'Event' },
  { slug: 'product', nameEn: 'Product' },
  { slug: 'graduation', nameEn: 'Graduation' },
  { slug: 'family', nameEn: 'Family' },
  { slug: 'fashion', nameEn: 'Fashion' },
  { slug: 'real-estate', nameEn: 'Real estate' },
] as const;

export type SeedSummary = {
  platformAdminCreated: boolean;
  platformSettingCreated: boolean;
  categoriesCreated: number;
  /** Null in production, or with SEED_DEMO_DATA=false. */
  demo: DemoSummary | null;
};

/**
 * Idempotent (plan.md Task 4): running this twice leaves the same row counts.
 * Seeds the first platform admin, the platform settings row and the starter
 * categories (R1.9) -- and, outside production, demo data (`seed-demo.ts`):
 * three approved photographers and one confirmed, fee-paid booking.
 * SEED_DEMO_DATA=false skips the demo.
 *
 * No photographer and no working hours here: a real photographer signs up and
 * gets default hours then. The 30 districts are not here either; the baseline
 * migration inserts them (marketplace-data-model.md §3.4).
 */
export async function seedDatabase(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedSummary> {
  return {
    platformAdminCreated: await seedPlatformAdmin(prisma, env),
    platformSettingCreated: await seedPlatformSetting(prisma),
    categoriesCreated: await seedCategories(prisma),
    demo: env.NODE_ENV === 'production' || env.SEED_DEMO_DATA === 'false' ? null : await seedDemoData(prisma),
  };
}

/** The first platform admin, from env (marketplace-spec.md decisions). Later ones are added by hand. */
async function seedPlatformAdmin(prisma: PrismaClient, env: NodeJS.ProcessEnv): Promise<boolean> {
  const existing = await prisma.appUser.count({ where: { role: 'platform_admin' } });
  if (existing > 0) return false;

  const credentials = adminCredentialsSchema.parse(env);
  const passwordHash = await hashPassword(credentials.ADMIN_PASSWORD);
  await prisma.appUser.create({
    data: { email: credentials.ADMIN_EMAIL, role: 'platform_admin', passwordHash },
  });
  return true;
}

async function seedPlatformSetting(prisma: PrismaClient): Promise<boolean> {
  const existing = await prisma.platformSetting.findUnique({ where: { id: 1 } });
  if (existing) return false;

  // Spelled out rather than relying on schema.prisma's @default values, so the
  // seed reads correctly in isolation (data-model_v2.md §5.2). The subscription
  // prices arrive with their columns in Phase 5.
  await prisma.platformSetting.create({
    data: { id: 1, holdMinutes: 30, trialDays: 30 },
  });
  return true;
}

async function seedCategories(prisma: PrismaClient): Promise<number> {
  // slug is unique, so the database skips what is already there; a category a
  // platform admin renamed or deactivated keeps its edits.
  const { count } = await prisma.category.createMany({
    data: STARTER_CATEGORIES.map((category, index) => ({ ...category, sortOrder: index })),
    skipDuplicates: true,
  });
  return count;
}
