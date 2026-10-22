import { Prisma, type PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { createPhotographer, grantSubscription } from '../test/payment-fixtures.js';
import { bookablePhotographerWhere, bookableSqlAt, isBookable, listedPhotographerWhere, listedSqlAt } from './bookable.js';

/**
 * The forms of BOOKABLE and LISTED never disagree (photographers/bookable.ts;
 * marketplace-spec.md R5.4, R5.5, R6.1, R6.6). Every combination of
 * photographer status, subscription status and period end (ahead, ended inside
 * the grace, ended past it, none at all) is asked of the Prisma filter, the
 * in-memory check and the Phase 6 SQL expressions on the same clock, and every
 * form must give the same answer. The directory and the sitemap use the SQL
 * forms; the profile and the catalogue use the Prisma one.
 */

let prisma: PrismaClient;
let raw: pg.Client;

const NOW = new Date('2026-10-01T06:00:00Z');
const GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

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
});

const ENDS = {
  ahead: new Date(NOW.getTime() + DAY_MS),
  exactlyNow: NOW,
  insideGrace: new Date(NOW.getTime() - 3 * DAY_MS),
  graceEdge: new Date(NOW.getTime() - GRACE_DAYS * DAY_MS),
  pastGrace: new Date(NOW.getTime() - 30 * DAY_MS),
} as const;

describe('BOOKABLE and LISTED in every form', () => {
  it('agree for every combination of status, subscription status and period end', async () => {
    const cases: { id: string; label: string; expectBookable: boolean; expectListed: boolean }[] = [];
    let n = 0;
    for (const status of ['pending', 'approved', 'suspended'] as const) {
      for (const subscriptionStatus of ['trialing', 'active', 'past_due', 'expired', null] as const) {
        for (const [endLabel, endsAt] of Object.entries(ENDS)) {
          if (subscriptionStatus === null && endLabel !== 'ahead') continue;
          n += 1;
          const { photographerId } = await createPhotographer(prisma, {
            email: `p${n}@bookly.example`,
            handle: `case-${String(n).padStart(3, '0')}`,
            displayName: `Case ${n}`,
            // Approved by hand below, so createPhotographer grants no default subscription.
            status: status === 'approved' ? 'pending' : status,
          });
          if (status === 'approved') await prisma.photographer.update({ where: { id: photographerId }, data: { status: 'approved', approvedAt: NOW } });
          if (subscriptionStatus !== null) {
            await grantSubscription(prisma, photographerId, { status: subscriptionStatus, endsAt, startsAt: new Date(endsAt.getTime() - 30 * DAY_MS) });
          }
          const running = endsAt.getTime() > NOW.getTime();
          const inGrace = endsAt.getTime() > NOW.getTime() - GRACE_DAYS * DAY_MS;
          cases.push({
            id: photographerId,
            label: `${status}/${subscriptionStatus ?? 'none'}/${endLabel}`,
            expectBookable: status === 'approved' && (subscriptionStatus === 'trialing' || subscriptionStatus === 'active') && running,
            expectListed: status === 'approved' && subscriptionStatus !== null && subscriptionStatus !== 'expired' && inGrace,
          });
        }
      }
    }

    const viaPrismaBookable = new Set(
      (await prisma.photographer.findMany({ where: bookablePhotographerWhere(NOW), select: { id: true } })).map((row) => row.id),
    );
    const viaPrismaListed = new Set(
      (await prisma.photographer.findMany({ where: listedPhotographerWhere(NOW, GRACE_DAYS), select: { id: true } })).map((row) => row.id),
    );
    const viaSql = await prisma.$queryRaw<{ id: string; bookable: boolean; listed: boolean }[]>(Prisma.sql`
      SELECT ph.id::text AS id, ${bookableSqlAt(NOW)} AS bookable, ${listedSqlAt(NOW, GRACE_DAYS)} AS listed
        FROM photographer ph LEFT JOIN subscription s ON s.photographer_id = ph.id`);
    const sqlById = new Map(viaSql.map((row) => [row.id, row]));
    const rows = await prisma.photographer.findMany({ select: { id: true, status: true, subscription: { select: { status: true, currentPeriodEndsAt: true } } } });
    const memoryById = new Map(rows.map((row) => [row.id, isBookable(row, row.subscription, NOW)]));

    expect(cases.length).toBeGreaterThan(50);
    for (const entry of cases) {
      expect([entry.label, viaPrismaBookable.has(entry.id)]).toEqual([entry.label, entry.expectBookable]);
      expect([entry.label, memoryById.get(entry.id)]).toEqual([entry.label, entry.expectBookable]);
      // Never null, even without a subscription row.
      expect([entry.label, sqlById.get(entry.id)?.bookable]).toEqual([entry.label, entry.expectBookable]);
      expect([entry.label, viaPrismaListed.has(entry.id)]).toEqual([entry.label, entry.expectListed]);
      expect([entry.label, sqlById.get(entry.id)?.listed]).toEqual([entry.label, entry.expectListed]);
    }
    // Every bookable photographer is listed.
    for (const entry of cases) if (entry.expectBookable) expect(entry.expectListed, entry.label).toBe(true);
  });
});
