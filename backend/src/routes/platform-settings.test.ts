import type { AppUser, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { issueToken } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { getPlatformSettings } from '../settings/index.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { expectMatchesSpec } from '../test/openapi.js';
import { type PaymentWorld, TEST_SECRET, grantSubscription, seedSecondPhotographer, seedWorld } from '../test/payment-fixtures.js';

/**
 * `/api/platform/settings` and `/api/platform/subscriptions` (marketplace-spec.md
 * R5.1, R5.4, R9.3, R9.4): reading and changing the hold, the trial and the
 * plan, each value held to its bounds before the CHECK behind it, every change
 * logged with who made it; and every subscription with its history, filtered by
 * the status at the clock.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let world: PaymentWorld;
let admin: AppUser;
let token: string;
/** The structured log lines (R9.4), captured from stdout. */
let logged: Record<string, unknown>[];

const WEB_ORIGIN = 'https://bookly.example';
const NOW = new Date('2026-10-26T06:00:00.000Z');
const DAY_MS = 24 * 60 * 60_000;
const DEFAULTS = {
  holdMinutes: 30,
  trialDays: 30,
  subscriptionMonthlyPriceRwf: 10_000,
  subscriptionYearlyPriceRwf: 100_000,
  subscriptionGraceDays: 7,
  subscriptionReminderDays: [7, 3, 1],
};

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
});

afterAll(async () => {
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  world = await seedWorld(prisma);
  admin = await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } });
  token = (await issueToken(TEST_SECRET, 'platform', admin, NOW)).token;
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line === 'string' && line.startsWith('{')) logged.push(JSON.parse(line) as Record<string, unknown>);
  });
  app = createApp({ corsOrigin: WEB_ORIGIN, auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: WEB_ORIGIN, now: () => NOW } });
});

const get = (path: string, bearer = token) => request(app).get(path).set('Authorization', `Bearer ${bearer}`);
const patch = (body: unknown, bearer = token) => request(app).patch('/api/platform/settings').set('Authorization', `Bearer ${bearer}`).send(body as object);

describe('GET /api/platform/settings', () => {
  it('answers every value, the placeholder prices included', async () => {
    const res = await get('/api/platform/settings');
    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'getPlatformSettings', 200);
    expect(res.body).toEqual({ settings: DEFAULTS });
  });

  it("refuses a photographer's token and no token (T9.1)", async () => {
    const photographer = await prisma.appUser.findUniqueOrThrow({ where: { id: world.photographerUserId } });
    const studio = (await issueToken(TEST_SECRET, 'studio', photographer, NOW)).token;
    for (const path of ['/api/platform/settings', '/api/platform/subscriptions']) {
      expect((await get(path, studio)).status, path).toBe(401);
      expect((await request(app).get(path)).status, path).toBe(401);
    }
    expect((await patch({ trialDays: 5 }, studio)).status).toBe(401);
    await expect(getPlatformSettings(prisma)).resolves.toEqual(DEFAULTS);
  });
});

describe('PATCH /api/platform/settings', () => {
  it('saves any subset, answers every value as stored, and logs who changed what (R9.4)', async () => {
    const res = await patch({ subscriptionMonthlyPriceRwf: 12_000, subscriptionReminderDays: [1, 14, 3] });

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'updatePlatformSettings', 200);
    // Stored largest first: the order they fall due in.
    const expected = { ...DEFAULTS, subscriptionMonthlyPriceRwf: 12_000, subscriptionReminderDays: [14, 3, 1] };
    expect(res.body).toEqual({ settings: expected });
    await expect(getPlatformSettings(prisma)).resolves.toEqual(expected);
    expect(logged).toContainEqual(
      expect.objectContaining({ event: 'platform_settings_updated', byUserId: admin.id, at: NOW.toISOString(), changed: ['subscriptionMonthlyPriceRwf', 'subscriptionReminderDays'] }),
    );
  });

  it('saves every field at once, at the edges of their bounds', async () => {
    const all = {
      holdMinutes: 60,
      trialDays: 366,
      subscriptionMonthlyPriceRwf: 1,
      subscriptionYearlyPriceRwf: 2_147_483_647,
      subscriptionGraceDays: 0,
      subscriptionReminderDays: [366, 10, 9, 8, 7, 6, 5, 4, 3, 1],
    };
    expect((await patch(all)).body).toEqual({ settings: all });
    expect((await patch({ holdMinutes: 1, trialDays: 1, subscriptionReminderDays: [] })).body.settings).toMatchObject({ holdMinutes: 1, trialDays: 1, subscriptionReminderDays: [] });
  });

  it('answers an empty body with the settings unchanged', async () => {
    expect((await patch({})).body).toEqual({ settings: DEFAULTS });
  });

  it.each([
    [{ holdMinutes: 0 }, 'holdMinutes'],
    [{ holdMinutes: 61 }, 'holdMinutes'],
    [{ trialDays: 0 }, 'trialDays'],
    [{ trialDays: 367 }, 'trialDays'],
    [{ subscriptionMonthlyPriceRwf: 0 }, 'subscriptionMonthlyPriceRwf'],
    [{ subscriptionYearlyPriceRwf: -5 }, 'subscriptionYearlyPriceRwf'],
    [{ subscriptionYearlyPriceRwf: 2_147_483_648 }, 'subscriptionYearlyPriceRwf'],
    [{ subscriptionGraceDays: -1 }, 'subscriptionGraceDays'],
    [{ subscriptionGraceDays: 367 }, 'subscriptionGraceDays'],
    [{ subscriptionReminderDays: [7, 0] }, 'subscriptionReminderDays.1'],
    [{ subscriptionReminderDays: [400] }, 'subscriptionReminderDays.0'],
    [{ subscriptionReminderDays: [7, 7] }, 'subscriptionReminderDays'],
    [{ subscriptionReminderDays: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }, 'subscriptionReminderDays'],
  ])('refuses %o with 422 naming the field, and changes nothing', async (body, field) => {
    const res = await patch(body);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'validation_failed', fields: [field] });
    await expect(getPlatformSettings(prisma)).resolves.toEqual(DEFAULTS);
  });

  it.each([[{ trialDays: 1.5 }], [{ trialDays: '30' }], [{ subscriptionReminderDays: 7 }], [{ subscriptionReminderDays: [null] }], [{ commission: 0.1 }], [{ id: 2 }], [[]]])(
    'refuses %o with 400, and changes nothing',
    async (body) => {
      expect((await patch(body)).body).toEqual({ error: 'invalid_request' });
      await expect(getPlatformSettings(prisma)).resolves.toEqual(DEFAULTS);
    },
  );

  it('changes the trial of the next approval only, and the grace of every subscription at once (R5.4)', async () => {
    const id = (await prisma.subscription.findUniqueOrThrow({ where: { photographerId: world.photographerId } })).id;
    await prisma.subscription.update({ where: { id }, data: { currentPeriodEndsAt: new Date(NOW.getTime() - 3 * DAY_MS) } });
    expect((await get('/api/platform/subscriptions')).body.subscriptions[0]).toMatchObject({ status: 'past_due' });

    await patch({ subscriptionGraceDays: 2, trialDays: 10 });

    const listed = (await get('/api/platform/subscriptions')).body.subscriptions[0];
    expect(listed).toMatchObject({ status: 'expired', graceEndsAt: new Date(NOW.getTime() - DAY_MS).toISOString() });
    await expect(prisma.subscription.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({ currentPeriodEndsAt: new Date(NOW.getTime() - 3 * DAY_MS) });
  });
});

describe('GET /api/platform/subscriptions', () => {
  async function seedStatuses() {
    const second = await seedSecondPhotographer(prisma, world);
    await prisma.subscription.update({ where: { photographerId: second.photographerId }, data: { currentPeriodEndsAt: new Date(NOW.getTime() - DAY_MS), status: 'active' } });
    const third = await seedSecondPhotographer(prisma, world, { email: 'third@bookly.example', handle: 'third-studio', displayName: 'Third' });
    await prisma.subscription.update({ where: { photographerId: third.photographerId }, data: { currentPeriodEndsAt: new Date(NOW.getTime() - 30 * DAY_MS), status: 'past_due' } });
    return { second, third };
  }

  it('lists every subscription with its photographer and history, the soonest to end first, its status at the clock', async () => {
    const { second, third } = await seedStatuses();

    const res = await get('/api/platform/subscriptions');
    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'listPlatformSubscriptions', 200);
    const rows = res.body.subscriptions as { photographer: { id: string; handle: string; status: string }; status: string; periods: unknown[] }[];
    expect(rows.map((row) => [row.photographer.id, row.status])).toEqual([
      [third.photographerId, 'expired'],
      [second.photographerId, 'past_due'],
      [world.photographerId, 'trialing'],
    ]);
    expect(rows[2]).toMatchObject({ photographer: { handle: 'kigali-lens', displayName: 'Kigali Lens', status: 'approved' }, periods: [{ kind: 'trial', priceRwf: 0 }] });
  });

  it.each([
    ['trialing', 1],
    ['active', 0],
    ['past_due', 1],
    ['expired', 1],
  ] as const)('filters by status=%s', async (status, count) => {
    await seedStatuses();
    const res = await get(`/api/platform/subscriptions?status=${status}`);
    expect(res.body.subscriptions).toHaveLength(count);
    for (const row of res.body.subscriptions as { status: string }[]) expect(row.status).toBe(status);
  });

  it('refuses an unknown status and an unknown key with 400', async () => {
    expect((await get('/api/platform/subscriptions?status=cancelled')).body).toEqual({ error: 'invalid_request' });
    expect((await get('/api/platform/subscriptions?photographer=x')).body).toEqual({ error: 'invalid_request' });
  });

  it('shows a photographer with no subscription nowhere: subscriptions begin at approval', async () => {
    const pending = await seedSecondPhotographer(prisma, world, { email: 'p@bookly.example', handle: 'pending-studio' });
    await prisma.subscriptionPeriod.deleteMany({ where: { subscription: { photographerId: pending.photographerId } } });
    await prisma.subscription.delete({ where: { photographerId: pending.photographerId } });
    expect((await get('/api/platform/subscriptions')).body.subscriptions).toHaveLength(1);
    await grantSubscription(prisma, pending.photographerId);
    expect((await get('/api/platform/subscriptions')).body.subscriptions).toHaveLength(2);
  });
});
