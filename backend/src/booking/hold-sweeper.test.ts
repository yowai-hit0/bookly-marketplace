import type { Booking, PrismaClient } from '@prisma/client';
import { validate } from 'node-cron';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { HOLD_SWEEP_SCHEDULE, startHoldSweeper, sweepExpiredHolds } from './hold-sweeper.js';

/**
 * The hold sweeper (plan.md Task 6, spec §3.2).
 *
 * The sweep itself is tested by calling it, not by waiting for cron: the
 * schedule is tidiness, and a test that slept for a minute would assert the
 * clock rather than the query. What the cron layer owes us is only that the
 * expression is valid and that the task can be stopped.
 */

let prisma: PrismaClient;
let raw: pg.Client;

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
});

// --- Fixtures ---------------------------------------------------------------

type Slot = { startsAt: Date; endsAt: Date; bufferEndsAt: Date };
type Catalogue = { serviceId: string; packageId: string; clientId: string };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Non-overlapping hours on Wednesday 7 October 2026; `n` shifts by an hour. */
function slotAt(n: number): Slot {
  const start = Date.parse('2026-10-07T07:00:00Z') + n * 2 * HOUR_MS;
  return {
    startsAt: new Date(start),
    endsAt: new Date(start + HOUR_MS),
    bufferEndsAt: new Date(start + HOUR_MS + 30 * MINUTE_MS),
  };
}

async function insertCatalogue(): Promise<Catalogue> {
  const service = await prisma.service.create({ data: { slug: 'portrait', nameEn: 'Portrait' } });
  const pkg = await prisma.package.create({
    data: {
      serviceId: service.id,
      nameEn: 'Standard',
      priceRwf: 40_000,
      photoCount: 20,
      durationMinutes: 60,
    },
  });
  const client = await prisma.client.create({
    data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' },
  });
  return { serviceId: service.id, packageId: pkg.id, clientId: client.id };
}

async function insertBooking(
  ids: Catalogue,
  n: number,
  status: string,
  holdExpiresAt: Date | null,
): Promise<Booking> {
  return prisma.booking.create({
    data: {
      reference: `BKY-2610-${String(n).padStart(5, '0')}`,
      clientId: ids.clientId,
      contactName: 'Aline Uwase',
      contactEmail: 'aline@example.com',
      contactPhone: '+250788000000',
      serviceId: ids.serviceId,
      packageId: ids.packageId,
      serviceNameSnapshot: 'Portrait',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 40_000,
      packageDurationMinutes: 60,
      packagePhotoCount: 20,
      locationText: 'Kigali Heights',
      consentAt: new Date(),
      bookingFeeRate: '0.400',
      bookingFeeRwf: 16_000,
      status,
      holdExpiresAt,
      ...slotAt(n),
    },
  });
}

async function statusOf(n: number): Promise<string> {
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { reference: `BKY-2610-${String(n).padStart(5, '0')}` },
  });
  return booking.status;
}

const lapsed = () => new Date(Date.now() - MINUTE_MS);
const live = () => new Date(Date.now() + 10 * MINUTE_MS);

// --- The sweep ---------------------------------------------------------------

describe('sweepExpiredHolds', () => {
  it('expires every lapsed hold and returns how many it expired', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, 1, 'pending_payment', lapsed());
    await insertBooking(ids, 2, 'pending_payment', lapsed());

    await expect(sweepExpiredHolds(prisma)).resolves.toBe(2);

    await expect(statusOf(1)).resolves.toBe('expired');
    await expect(statusOf(2)).resolves.toBe('expired');
  });

  it('leaves a live hold alone', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, 1, 'pending_payment', live());
    await insertBooking(ids, 2, 'pending_payment', lapsed());

    await expect(sweepExpiredHolds(prisma)).resolves.toBe(1);

    await expect(statusOf(1)).resolves.toBe('pending_payment');
    await expect(statusOf(2)).resolves.toBe('expired');
  });

  it.each(['confirmed', 'completed', 'no_show', 'cancelled_by_client'])(
    'never touches a %s booking, whatever hold_expires_at still says',
    async (status) => {
      const ids = await insertCatalogue();
      await insertBooking(ids, 1, status, lapsed());

      await expect(sweepExpiredHolds(prisma)).resolves.toBe(0);
      await expect(statusOf(1)).resolves.toBe(status);
    },
  );

  it('ignores a pending_payment booking carrying no hold at all', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, 1, 'pending_payment', null);

    await expect(sweepExpiredHolds(prisma)).resolves.toBe(0);
    await expect(statusOf(1)).resolves.toBe('pending_payment');
  });

  it('returns 0 on an empty table and is safe to run again', async () => {
    await expect(sweepExpiredHolds(prisma)).resolves.toBe(0);

    const ids = await insertCatalogue();
    await insertBooking(ids, 1, 'pending_payment', lapsed());

    await expect(sweepExpiredHolds(prisma)).resolves.toBe(1);
    // The second pass finds nothing: expiring is idempotent, not repeatable.
    await expect(sweepExpiredHolds(prisma)).resolves.toBe(0);
  });

  it('sends nothing — an abandoned checkout gets no email (spec §3.2)', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, 1, 'pending_payment', lapsed());

    await sweepExpiredHolds(prisma);

    await expect(statusOf(1)).resolves.toBe('expired');
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });
});

// --- The schedule ------------------------------------------------------------

describe('the sweeper schedule', () => {
  it('is a cron expression node-cron accepts, every minute', () => {
    expect(validate(HOLD_SWEEP_SCHEDULE)).toBe(true);
    expect(HOLD_SWEEP_SCHEDULE).toBe('* * * * *');
  });

  it('starts a task that can be stopped, so nothing outlives the process', async () => {
    const task = startHoldSweeper(prisma);
    try {
      expect(task.getPattern()).toBe(HOLD_SWEEP_SCHEDULE);
      expect(task.getNextRun()).toBeInstanceOf(Date);
    } finally {
      await task.stop();
      await task.destroy();
    }
  });

  it('accepts a caller-supplied expression', async () => {
    const task = startHoldSweeper(prisma, '*/5 * * * *');
    try {
      expect(task.getPattern()).toBe('*/5 * * * *');
    } finally {
      await task.stop();
      await task.destroy();
    }
  });

  it('sweeps when the scheduled task is run directly', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, 1, 'pending_payment', lapsed());

    const task = startHoldSweeper(prisma);
    try {
      await task.execute();
    } finally {
      await task.stop();
      await task.destroy();
    }

    await expect(statusOf(1)).resolves.toBe('expired');
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });
});
