import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { type DemoSummary, seedDemoData } from './seed-demo.js';

/** Mon-Fri, 09:00-17:00 (data-model_v2.md §13). R-4 is still open: these hours
 *  were chosen by the developer, not stated by the photographer. Confirm
 *  before launch content goes live. */
const WEEKDAYS = [1, 2, 3, 4, 5] as const;
const OPENS_MINUTE = 540;
const CLOSES_MINUTE = 1020;

/** Only read when no admin exists yet -- a reseed of an already-seeded
 *  database needs neither variable present. */
const adminCredentialsSchema = z.object({
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(12),
});

export type SeedSummary = {
  adminUserCreated: boolean;
  settingCreated: boolean;
  workingHoursCreated: number;
  /** Null in production, or with SEED_DEMO_DATA=false. */
  demo: DemoSummary | null;
};

/**
 * Idempotent (plan.md Task 4): running this twice leaves the same row counts.
 * Seeds the one admin, the one settings row, and Mon-Fri working hours --
 * and, outside production, demo data (`seed-demo.ts`): a small catalogue and
 * one confirmed, fee-paid booking. SEED_DEMO_DATA=false skips the demo.
 */
export async function seedDatabase(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedSummary> {
  return {
    adminUserCreated: await seedAdminUser(prisma, env),
    settingCreated: await seedSetting(prisma),
    workingHoursCreated: await seedWorkingHours(prisma),
    demo: env.NODE_ENV === 'production' || env.SEED_DEMO_DATA === 'false' ? null : await seedDemoData(prisma),
  };
}

async function seedAdminUser(prisma: PrismaClient, env: NodeJS.ProcessEnv): Promise<boolean> {
  const existing = await prisma.adminUser.count();
  if (existing > 0) return false;

  const credentials = adminCredentialsSchema.parse(env);
  const passwordHash = await hashPassword(credentials.ADMIN_PASSWORD);
  await prisma.adminUser.create({
    data: { email: credentials.ADMIN_EMAIL, passwordHash },
  });
  return true;
}

async function seedSetting(prisma: PrismaClient): Promise<boolean> {
  const existing = await prisma.setting.findUnique({ where: { id: 1 } });
  if (existing) return false;

  // Spelled out rather than relying on schema.prisma's @default values, so the
  // seed reads correctly in isolation (data-model_v2.md §5.2).
  await prisma.setting.create({
    data: {
      id: 1,
      bookingFeeRate: '0.400',
      minLeadTimeMinutes: 120,
      holdMinutes: 30,
      bufferMinutes: 30,
      deliveryExpiryDays: 90,
    },
  });
  return true;
}

async function seedWorkingHours(prisma: PrismaClient): Promise<number> {
  // The partial unique index on weekday (data-model_v2.md §9.3) is raw SQL,
  // invisible to Prisma, so upsert-by-weekday isn't available -- idempotency is
  // our own check rather than a database ON CONFLICT.
  const existing = await prisma.workingHours.findMany({
    where: { weekday: { in: [...WEEKDAYS] } },
    select: { weekday: true },
  });
  const present = new Set(existing.map((row) => row.weekday));
  const missing = WEEKDAYS.filter((weekday) => !present.has(weekday));
  if (missing.length === 0) return 0;

  await prisma.workingHours.createMany({
    data: missing.map((weekday) => ({
      weekday,
      opensMinute: OPENS_MINUTE,
      closesMinute: CLOSES_MINUTE,
      isOpen: true,
    })),
  });
  return missing.length;
}
