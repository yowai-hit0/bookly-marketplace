import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { seedDatabase } from '../db/seed.js';
import { testDatabaseUrl } from '../test/database.js';
import { ACCESS_TOKEN_LIFETIME_DAYS, SLOT_GRANULARITY_MINUTES, getSettings } from './index.js';

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  // getSettings() throws on a missing row (data-model_v2.md §5.2) -- seed it
  // the same way Task 4 requires production to be seeded.
  await seedDatabase(prisma, { ...process.env, ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'correct horse battery staple' });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('getSettings', () => {
  it('returns the five seeded defaults (plan.md Task 4)', async () => {
    await expect(getSettings(prisma)).resolves.toEqual({
      bookingFeeRate: 0.4,
      minLeadTimeMinutes: 120,
      holdMinutes: 30,
      bufferMinutes: 30,
      deliveryExpiryDays: 90,
    });
  });

  it('converts bookingFeeRate to a plain number, never a Decimal', async () => {
    const settings = await getSettings(prisma);
    expect(typeof settings.bookingFeeRate).toBe('number');
  });
});

describe('constants with no settings screen behind them', () => {
  it('are exported, not read from the database', () => {
    expect(SLOT_GRANULARITY_MINUTES).toBe(30);
    expect(ACCESS_TOKEN_LIFETIME_DAYS).toBe(365);
  });
});

describe('the settings repository', () => {
  it('is imported by settings/index.ts and by nothing else in src/', () => {
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const target = join(srcRoot, 'settings', 'repository.ts');
    const importers = findImportersOf(srcRoot, target);

    expect(importers.sort()).toEqual([join('settings', 'index.ts')]);
  });
});

/**
 * Every .ts file under `root` with a relative import resolving to `target`, as
 * paths relative to `root`. Resolves each specifier rather than matching it as
 * a string, because the legitimate importer sits next to its target and uses
 * `./repository.js` -- a substring match on "settings/repository" would miss it.
 */
function findImportersOf(root: string, target: string): string[] {
  const importPattern = /from\s+['"](\.[^'"]+)['"]/g;
  const importers: string[] = [];

  for (const relativePath of walk(root)) {
    const filePath = join(root, relativePath);
    const contents = readFileSync(filePath, 'utf8');

    for (const match of contents.matchAll(importPattern)) {
      const specifier = match[1]!.replace(/\.js$/, '.ts');
      if (resolve(dirname(filePath), specifier) === target) {
        importers.push(relativePath);
        break;
      }
    }
  }

  return importers;
}

function walk(dir: string, base = dir): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full, base));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full.slice(base.length + 1));
    }
  }

  return files;
}
