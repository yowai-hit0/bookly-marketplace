import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type PaymentWorld, seedSecondPhotographer, seedWorld } from '../test/payment-fixtures.js';
import {
  ACCESS_TOKEN_LIFETIME_DAYS,
  SLOT_GRANULARITY_MINUTES,
  getPhotographerSettings,
  getPlatformSettings,
  updatePhotographerSettings,
  updatePlatformSettings,
} from './index.js';

let prisma: PrismaClient;
let raw: ReturnType<typeof connect>;
let world: PaymentWorld;

/** The schema defaults a photographer's row is born with (marketplace-data-model.md §3.2, R1.8). */
const PHOTOGRAPHER_DEFAULTS = {
  bookingFeeRate: 0.4,
  minLeadTimeMinutes: 120,
  bufferMinutes: 30,
  deliveryExpiryDays: 90,
  clientCancelCutoffHours: 0,
  bookingFeeRefundableOnClientCancel: false,
};

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  // The platform row and one approved photographer with their settings row, as
  // the seed and approval leave them.
  world = await seedWorld(prisma);
});

describe('getPhotographerSettings', () => {
  it("returns the photographer's six values at their defaults (plan.md Task 4, R1.8)", async () => {
    await expect(getPhotographerSettings(world.photographerId, prisma)).resolves.toEqual(PHOTOGRAPHER_DEFAULTS);
  });

  it('converts bookingFeeRate to a plain number, never a Decimal', async () => {
    const settings = await getPhotographerSettings(world.photographerId, prisma);
    expect(typeof settings.bookingFeeRate).toBe('number');
  });

  it('carries no platform value: the checkout hold is not a photographer setting', async () => {
    const settings = await getPhotographerSettings(world.photographerId, prisma);
    expect(settings).not.toHaveProperty('holdMinutes');
  });

  it('throws for an id with no settings row rather than inventing defaults', async () => {
    await expect(getPhotographerSettings('00000000-0000-4000-8000-000000000000', prisma)).rejects.toThrow();
  });
});

describe('updatePhotographerSettings', () => {
  it('saves a subset and returns every value as stored', async () => {
    await expect(
      updatePhotographerSettings(world.photographerId, { bookingFeeRate: 0.125, clientCancelCutoffHours: 48, bookingFeeRefundableOnClientCancel: true }, prisma),
    ).resolves.toEqual({ ...PHOTOGRAPHER_DEFAULTS, bookingFeeRate: 0.125, clientCancelCutoffHours: 48, bookingFeeRefundableOnClientCancel: true });
    await expect(getPhotographerSettings(world.photographerId, prisma)).resolves.toMatchObject({ bookingFeeRate: 0.125, clientCancelCutoffHours: 48 });
  });

  it("changes one photographer's values and leaves another's alone (R1.4)", async () => {
    const second = await seedSecondPhotographer(prisma, world);

    await updatePhotographerSettings(world.photographerId, { bufferMinutes: 90, minLeadTimeMinutes: 0 }, prisma);

    await expect(getPhotographerSettings(world.photographerId, prisma)).resolves.toMatchObject({ bufferMinutes: 90, minLeadTimeMinutes: 0 });
    await expect(getPhotographerSettings(second.photographerId, prisma)).resolves.toEqual(PHOTOGRAPHER_DEFAULTS);
  });

  it('leaves range validation to the caller, with the database CHECK as the backstop', async () => {
    await expect(updatePhotographerSettings(world.photographerId, { clientCancelCutoffHours: -1 }, prisma)).rejects.toThrow();
    await expect(getPhotographerSettings(world.photographerId, prisma)).resolves.toEqual(PHOTOGRAPHER_DEFAULTS);
  });
});

describe('platform settings', () => {
  it('returns the hold and the trial length (brief decision 5)', async () => {
    await expect(getPlatformSettings(prisma)).resolves.toEqual({ holdMinutes: 30, trialDays: 30 });
  });

  it('saves a subset and returns every value as stored', async () => {
    await expect(updatePlatformSettings({ holdMinutes: 15 }, prisma)).resolves.toEqual({ holdMinutes: 15, trialDays: 30 });
    await expect(getPlatformSettings(prisma)).resolves.toEqual({ holdMinutes: 15, trialDays: 30 });
  });

  it('throws when the seed never created the row', async () => {
    await raw.query('TRUNCATE platform_setting');
    await expect(getPlatformSettings(prisma)).rejects.toThrow();
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
