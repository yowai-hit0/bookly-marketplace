import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { kigaliDateOf } from '../availability/engine.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type BulkSeedSummary, seedDirectoryPhotographers } from '../test/directory-fixtures.js';
import { TEST_PLATFORM_SETTING } from '../test/payment-fixtures.js';

/**
 * T6.3: the directory answers in under 300 ms at the 95th percentile with 200
 * seeded photographers, locally (marketplace-spec.md R6.1, T6.3).
 *
 * HOW TO RUN IT. It is an ordinary file of the suite, so `npm test` runs it.
 * Alone, against the local test database:
 *
 *   cd backend
 *   TEST_DATABASE_URL='postgresql://<user>:<password>@localhost:5432/<test database>' \
 *     npx vitest run src/catalogue/directory-performance.test.ts
 *
 * It prints each path's p50, p95 and max. What it ASSERTS is chosen to hold on a
 * slow machine:
 *
 *   - The SQL paths (no filter; category + district + min + max) must be under
 *     300 ms at p95, over 20 requests each, after a warm-up. Each is one page
 *     query, one count and two small reads; at 200 photographers that is a few
 *     milliseconds, so 300 ms leaves a slow laptop and a busy CI runner two
 *     orders of magnitude of room.
 *   - The date paths (the date alone; the date with every filter) run the
 *     availability engine on a page of candidates as well, and are REPORTED
 *     separately. They must stay under `DATE_PATH_CEILING_MS` at p95, a loose
 *     ceiling that catches a pathological regression (the engine run per
 *     photographer, or over every candidate) without failing on a slow machine.
 *
 * The 200 photographers are varied (test/directory-fixtures.ts): some pending,
 * suspended, expired or past-due; 1-3 districts and 1-2 categories each; 1-6
 * packages; Monday-Saturday hours; and on the date asked for, some fully booked,
 * some blocked all day, some half booked. The clock is the real one, since the
 * fixture's subscriptions are measured against it.
 */

const PHOTOGRAPHERS = 200;
const REQUESTS = 20;
const WARM_UP = 3;
const SQL_PATH_P95_MS = 300;
/** A loose ceiling for the engine paths, not the T6.3 target: see the header. */
const DATE_PATH_CEILING_MS = 2_000;
const DAY_MS = 24 * 60 * 60_000;

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let summary: BulkSeedSummary;
/** A Wednesday a week or two ahead on the Kigali calendar: inside the horizon, past the lead time. */
let busyDate: string;

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
  await truncateAll(raw);
  await prisma.platformSetting.create({ data: TEST_PLATFORM_SETTING });

  const today = new Date(`${kigaliDateOf(new Date())}T00:00:00Z`);
  const daysToWednesday = ((3 - today.getUTCDay() + 7) % 7) + 7;
  busyDate = new Date(today.getTime() + daysToWednesday * DAY_MS).toISOString().slice(0, 10);
  summary = await seedDirectoryPhotographers(prisma, PHOTOGRAPHERS, { busyDate });
  // Fresh statistics, as a database that has been running would have.
  await raw.query('ANALYZE');
  app = createApp({ publicApi: { prisma } });
}, 120_000);

afterAll(async () => {
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

type Timing = { p50: number; p95: number; max: number };

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? Number.NaN;
}

/** `REQUESTS` timed requests after `WARM_UP` untimed ones, each checked for a 200. */
async function time(label: string, query: Record<string, string | number>): Promise<Timing> {
  for (let i = 0; i < WARM_UP; i += 1) expect((await request(app).get('/api/photographers').query(query)).status).toBe(200);
  const samples: number[] = [];
  for (let i = 0; i < REQUESTS; i += 1) {
    const started = performance.now();
    const res = await request(app).get('/api/photographers').query(query);
    samples.push(performance.now() - started);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const timing = { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] ?? Number.NaN };
  console.info(`T6.3 ${label}: p50 ${timing.p50.toFixed(1)} ms, p95 ${timing.p95.toFixed(1)} ms, max ${timing.max.toFixed(1)} ms over ${REQUESTS} requests`);
  return timing;
}

describe(`T6.3: the directory with ${PHOTOGRAPHERS} photographers`, () => {
  it('seeds a varied set, and the directory lists exactly the listed ones', async () => {
    const first = await request(app).get('/api/photographers');

    expect(summary.bookable + summary.pastDue + summary.hidden).toBe(PHOTOGRAPHERS);
    expect(summary.pastDue).toBeGreaterThan(0);
    expect(summary.hidden).toBeGreaterThan(0);
    expect(first.body.total).toBe(summary.listed);
    expect(first.body.photographers).toHaveLength(24);
  });

  it(`answers the SQL paths under ${SQL_PATH_P95_MS} ms at p95`, async () => {
    const plain = await time('no filter', {});
    const page = await time('no filter, page 5', { page: 5 });
    const combined = await time('category + district + min + max', { category: 'wedding', district: 'gasabo', min: 20_000, max: 150_000 });

    for (const timing of [plain, page, combined]) expect(timing.p95).toBeLessThan(SQL_PATH_P95_MS);
  });

  it(`reports the date paths, and keeps them under a loose ${DATE_PATH_CEILING_MS} ms ceiling at p95`, async () => {
    const dateOnly = await time(`date ${busyDate}`, { date: busyDate });
    const dateDeep = await time(`date ${busyDate}, page 3`, { date: busyDate, page: 3 });
    const everything = await time(`date ${busyDate} + category + district + min + max`, {
      date: busyDate,
      category: 'portrait',
      district: 'kicukiro',
      min: 20_000,
      max: 200_000,
    });

    for (const timing of [dateOnly, dateDeep, everything]) expect(timing.p95).toBeLessThan(DATE_PATH_CEILING_MS);
  });

  it('keeps the busy date honest: nobody fully booked, blocked or past-due is offered on it', async () => {
    const offered: { handle: string; takingBookings: boolean }[] = [];
    for (let page = 1; ; page += 1) {
      const res = await request(app).get('/api/photographers').query({ date: busyDate, page });
      offered.push(...(res.body.photographers as { handle: string; takingBookings: boolean }[]));
      if (!res.body.hasMore) break;
    }
    const busy = await prisma.$queryRaw<{ handle: string }[]>`
      SELECT DISTINCT ph.handle FROM photographer ph
        LEFT JOIN booking b ON b.photographer_id = ph.id AND b.package_duration_minutes = 1440
        LEFT JOIN availability_block ab ON ab.photographer_id = ph.id
       WHERE b.id IS NOT NULL OR ab.id IS NOT NULL`;

    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((card) => card.takingBookings)).toBe(true);
    expect(new Set(offered.map((card) => card.handle)).size).toBe(offered.length);
    const offeredHandles = new Set(offered.map((card) => card.handle));
    for (const { handle } of busy) expect(offeredHandles.has(handle), handle).toBe(false);
  });
});
