import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../auth/password.js';
import { findBookingByToken } from '../booking/access.js';
import { bookingTotals } from '../booking/totals.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { createPrismaClient } from './client.js';
import { seedDatabase } from './seed.js';
import { DEMO_CLIENT_EMAIL } from './seed-demo.js';

const CREDENTIALS = { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'correct horse battery staple' };

let prisma: PrismaClient;
let raw: Awaited<ReturnType<typeof connect>>;

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

describe('seedDatabase', () => {
  it('creates 1 admin_user, 1 setting, and 5 working_hours rows', async () => {
    await seedDatabase(prisma, { ...process.env, ...CREDENTIALS });

    await expect(prisma.adminUser.count()).resolves.toBe(1);
    await expect(prisma.setting.count()).resolves.toBe(1);

    const hours = await prisma.workingHours.findMany({ orderBy: { weekday: 'asc' } });
    expect(hours).toHaveLength(5);
    expect(hours.map((row) => row.weekday)).toEqual([1, 2, 3, 4, 5]);
    for (const row of hours) {
      expect(row.opensMinute).toBe(540);
      expect(row.closesMinute).toBe(1020);
      expect(row.isOpen).toBe(true);
      expect(row.effectiveDate).toBeNull();
    }
  });

  it('is idempotent: running it twice leaves the same row counts', async () => {
    await seedDatabase(prisma, { ...process.env, ...CREDENTIALS });
    await seedDatabase(prisma, { ...process.env, ...CREDENTIALS });

    await expect(prisma.adminUser.count()).resolves.toBe(1);
    await expect(prisma.setting.count()).resolves.toBe(1);
    await expect(prisma.workingHours.count()).resolves.toBe(5);
  });

  it('stores the admin password hashed, not plain', async () => {
    await seedDatabase(prisma, { ...process.env, ...CREDENTIALS });

    const admin = await prisma.adminUser.findFirstOrThrow();
    expect(admin.passwordHash).not.toBe(CREDENTIALS.ADMIN_PASSWORD);
    expect(admin.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(admin.passwordHash, CREDENTIALS.ADMIN_PASSWORD)).resolves.toBe(true);
  });

  it('requires ADMIN_EMAIL and ADMIN_PASSWORD only when no admin exists yet', async () => {
    await expect(seedDatabase(prisma, {})).rejects.toThrow();

    await seedDatabase(prisma, { ...process.env, ...CREDENTIALS });
    // A reseed of an already-seeded database needs no credentials at all.
    await expect(seedDatabase(prisma, {})).resolves.toMatchObject({ adminUserCreated: false });
  });
});

describe('seedDatabase: demo data', () => {
  const env = { ...process.env, ...CREDENTIALS, NODE_ENV: 'development' };

  it('creates a small catalogue: two services, three packages, one own and one shared add-on', async () => {
    const summary = await seedDatabase(prisma, env);

    expect(summary.demo).toMatchObject({ servicesCreated: 2, packagesCreated: 3, addonsCreated: 2 });
    const services = await prisma.service.findMany({ include: { packages: true, addons: true }, orderBy: { sortOrder: 'asc' } });
    expect(services.map((service) => [service.slug, service.packages.length, service.addons.length])).toEqual([
      ['portraits', 2, 1],
      ['events', 1, 0],
    ]);
    await expect(prisma.addon.count({ where: { serviceId: null } })).resolves.toBe(1);
  });

  it('creates one confirmed booking, upcoming on a weekday at 10:00 Kigali, whose booking fee is paid', async () => {
    const summary = await seedDatabase(prisma, env);

    const booking = await prisma.booking.findFirstOrThrow({ where: { contactEmail: DEMO_CLIENT_EMAIL }, include: { addons: true, payments: true } });
    expect(summary.demo?.booking).toMatchObject({ reference: booking.reference, created: true });
    expect(booking.reference).toMatch(/^BKY-\d{4}-[0-9A-Z]{5}$/);
    expect(booking.status).toBe('confirmed');
    expect(booking.startsAt.getTime()).toBeGreaterThan(Date.now());
    expect(booking.startsAt.getUTCHours()).toBe(8);
    expect([1, 2, 3, 4, 5]).toContain(booking.startsAt.getUTCDay());
    expect(booking.addons.map((addon) => [addon.nameSnapshot, addon.stage])).toEqual([['Rush edit (48 hours)', 'at_booking']]);

    // 40,000 + 15,000 at 40%.
    expect(booking.bookingFeeRwf).toBe(22_000);
    expect(booking.payments).toMatchObject([{ kind: 'booking_fee', status: 'succeeded', amountRwf: 22_000, method: 'momo_mtn' }]);
    const totals = bookingTotals(booking, booking.addons, booking.payments);
    expect(totals.collectedRwf).toBe(22_000);
    expect(totals.outstandingRwf).toBe(33_000);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('hands back a token that opens the booking, and only its hash is stored', async () => {
    const token = (await seedDatabase(prisma, env)).demo?.booking?.accessToken ?? '';

    const found = await findBookingByToken(prisma, token);
    expect(found?.contactEmail).toBe(DEMO_CLIENT_EMAIL);
    const stored = await raw.query<{ row: string }>('SELECT row_to_json(b)::text AS row FROM booking b');
    expect(stored.rows[0]?.row).not.toContain(token);
  });

  it('is idempotent in rows, and a reseed replaces the link: the old one stops working', async () => {
    const first = (await seedDatabase(prisma, env)).demo?.booking;
    const second = (await seedDatabase(prisma, env)).demo;

    expect(second).toMatchObject({ servicesCreated: 0, packagesCreated: 0, addonsCreated: 0, booking: { reference: first?.reference, created: false } });
    await expect(prisma.service.count()).resolves.toBe(2);
    await expect(prisma.booking.count()).resolves.toBe(1);
    await expect(prisma.payment.count()).resolves.toBe(1);
    await expect(prisma.client.count()).resolves.toBe(1);
    await expect(findBookingByToken(prisma, first?.accessToken ?? '')).resolves.toBeNull();
    await expect(findBookingByToken(prisma, second?.booking?.accessToken ?? '')).resolves.not.toBeNull();
  });

  it('leaves an existing catalogue alone, and then books nothing', async () => {
    await prisma.service.create({ data: { slug: 'weddings', nameEn: 'Weddings' } });

    const summary = await seedDatabase(prisma, env);

    expect(summary.demo).toEqual({ servicesCreated: 0, packagesCreated: 0, addonsCreated: 0, booking: null });
    await expect(prisma.service.count()).resolves.toBe(1);
    await expect(prisma.booking.count()).resolves.toBe(0);
  });

  it.each([
    ['in production', { NODE_ENV: 'production' }],
    ['with SEED_DEMO_DATA=false', { SEED_DEMO_DATA: 'false' }],
  ])('seeds no demo data %s', async (_label, extra) => {
    const summary = await seedDatabase(prisma, { ...env, ...extra });

    expect(summary.demo).toBeNull();
    await expect(prisma.service.count()).resolves.toBe(0);
    await expect(prisma.booking.count()).resolves.toBe(0);
  });
});
