import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../auth/password.js';
import { findBookingByToken } from '../booking/access.js';
import { bookingTotals } from '../booking/totals.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { createPrismaClient } from './client.js';
import { PLACEHOLDER_SUBSCRIPTION_PRICES, STARTER_CATEGORIES, seedDatabase } from './seed.js';
import { DEMO_CLIENT_EMAIL, DEMO_PHOTOGRAPHERS, DEMO_PHOTOGRAPHER_PASSWORD, demoPhotographerEmail } from './seed-demo.js';

const CREDENTIALS = { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'correct horse battery staple' };
/** The platform part of the seed alone, without the demo. */
const BASE_ENV = { ...process.env, ...CREDENTIALS, SEED_DEMO_DATA: 'false' };

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
  it('creates 1 platform admin, the platform_setting row and the 8 starter categories (R1.9)', async () => {
    await expect(seedDatabase(prisma, BASE_ENV)).resolves.toEqual({
      platformAdminCreated: true,
      platformSettingCreated: true,
      categoriesCreated: 8,
      demo: null,
    });

    const users = await prisma.appUser.findMany();
    expect(users.map((user) => [user.email, user.role])).toEqual([[CREDENTIALS.ADMIN_EMAIL, 'platform_admin']]);
    await expect(prisma.photographer.count()).resolves.toBe(0);
    await expect(prisma.platformSetting.findUniqueOrThrow({ where: { id: 1 } })).resolves.toMatchObject({ holdMinutes: 30, trialDays: 30 });
    // The subscription plan (Phase 5): the PLACEHOLDER prices, to be set before launch, and the R5.4 defaults.
    await expect(prisma.platformSetting.findUniqueOrThrow({ where: { id: 1 } })).resolves.toMatchObject({
      ...PLACEHOLDER_SUBSCRIPTION_PRICES,
      subscriptionGraceDays: 7,
      subscriptionReminderDays: [7, 3, 1],
    });
    expect(PLACEHOLDER_SUBSCRIPTION_PRICES).toEqual({ subscriptionMonthlyPriceRwf: 10_000, subscriptionYearlyPriceRwf: 100_000 });

    const categories = await prisma.category.findMany({ orderBy: { sortOrder: 'asc' } });
    expect(categories.map((category) => category.slug)).toEqual(['wedding', 'portrait', 'event', 'product', 'graduation', 'family', 'fashion', 'real-estate']);
    expect(categories.every((category) => category.isActive)).toBe(true);
  });

  it('seeds no photographer, no working hours and no districts: the migration owns the districts', async () => {
    await seedDatabase(prisma, BASE_ENV);

    await expect(prisma.workingHours.count()).resolves.toBe(0);
    await expect(prisma.photographerSetting.count()).resolves.toBe(0);
    // The 30 the baseline migration inserted, untouched by the seed and by truncateAll.
    await expect(prisma.district.count()).resolves.toBe(30);
  });

  it('is idempotent: running it twice leaves the same row counts', async () => {
    await seedDatabase(prisma, BASE_ENV);
    await expect(seedDatabase(prisma, BASE_ENV)).resolves.toEqual({
      platformAdminCreated: false,
      platformSettingCreated: false,
      categoriesCreated: 0,
      demo: null,
    });

    await expect(prisma.appUser.count()).resolves.toBe(1);
    await expect(prisma.platformSetting.count()).resolves.toBe(1);
    // A reseed never overwrites prices a platform admin has set.
    await prisma.platformSetting.update({ where: { id: 1 }, data: { subscriptionMonthlyPriceRwf: 15_000 } });
    await seedDatabase(prisma, BASE_ENV);
    await expect(prisma.platformSetting.findUniqueOrThrow({ where: { id: 1 } })).resolves.toMatchObject({ subscriptionMonthlyPriceRwf: 15_000 });
    await expect(prisma.category.count()).resolves.toBe(STARTER_CATEGORIES.length);
  });

  it('keeps a category a platform admin edited, and re-adds one that was removed', async () => {
    await seedDatabase(prisma, BASE_ENV);
    await prisma.category.update({ where: { slug: 'wedding' }, data: { nameEn: 'Weddings & gusaba', isActive: false } });
    await prisma.category.delete({ where: { slug: 'product' } });

    await expect(seedDatabase(prisma, BASE_ENV)).resolves.toMatchObject({ categoriesCreated: 1 });
    await expect(prisma.category.findUniqueOrThrow({ where: { slug: 'wedding' } })).resolves.toMatchObject({ nameEn: 'Weddings & gusaba', isActive: false });
  });

  it('stores the platform admin password hashed, not plain', async () => {
    await seedDatabase(prisma, BASE_ENV);

    const admin = await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } });
    expect(admin.passwordHash).not.toBe(CREDENTIALS.ADMIN_PASSWORD);
    expect(admin.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(admin.passwordHash ?? '', CREDENTIALS.ADMIN_PASSWORD)).resolves.toBe(true);
  });

  it('creates the platform admin with a verified address, so they can sign in (Phase 2 decision 3)', async () => {
    await seedDatabase(prisma, BASE_ENV);

    const admin = await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } });
    expect(admin.emailVerifiedAt).not.toBeNull();
  });

  it('requires ADMIN_EMAIL and ADMIN_PASSWORD only when no platform admin exists yet', async () => {
    await expect(seedDatabase(prisma, { SEED_DEMO_DATA: 'false' })).rejects.toThrow();

    await seedDatabase(prisma, BASE_ENV);
    // A reseed of an already-seeded database needs no credentials at all.
    await expect(seedDatabase(prisma, { SEED_DEMO_DATA: 'false' })).resolves.toMatchObject({ platformAdminCreated: false });
  });

  it('is not satisfied by a photographer login: only a platform admin counts', async () => {
    await prisma.appUser.create({ data: { email: 'someone@example.com', role: 'photographer', passwordHash: 'x' } });

    await expect(seedDatabase(prisma, BASE_ENV)).resolves.toMatchObject({ platformAdminCreated: true });
    await expect(prisma.appUser.count({ where: { role: 'platform_admin' } })).resolves.toBe(1);
  });
});

describe('seedDatabase: demo data', () => {
  const env = { ...process.env, ...CREDENTIALS, NODE_ENV: 'development', SEED_DEMO_DATA: 'true' };

  it('creates three approved photographers, each with a photographer login, a settings row, hours, districts and categories', async () => {
    const summary = await seedDatabase(prisma, env);

    expect(summary.demo).toMatchObject({ photographersCreated: 3 });
    const photographers = await prisma.photographer.findMany({
      include: { user: true, setting: true, workingHours: true, districts: true, categories: true, subscription: { include: { periods: true } } },
      orderBy: { handle: 'asc' },
    });
    expect(photographers.map((photographer) => photographer.handle)).toEqual(['hills-and-light', 'kigali-lens', 'umucyo-studio']);
    for (const photographer of photographers) {
      expect(photographer.status).toBe('approved');
      expect(photographer.approvedAt).not.toBeNull();
      expect(photographer.user).toMatchObject({ role: 'photographer', email: demoPhotographerEmail(photographer.handle) });
      expect(photographer.user.emailVerifiedAt).not.toBeNull();
      await expect(verifyPassword(photographer.user.passwordHash ?? '', DEMO_PHOTOGRAPHER_PASSWORD)).resolves.toBe(true);
      expect(photographer.setting).not.toBeNull();
      expect(photographer.workingHours.length).toBeGreaterThanOrEqual(5);
      expect(photographer.districts.length).toBeGreaterThan(0);
      expect(photographer.categories.length).toBeGreaterThan(0);
      // Approved, so subscribed: trialing, one 30-day trial from the seed's run (R5.1, marketplace-data-model.md §7).
      expect(photographer.subscription).toMatchObject({ status: 'trialing' });
      expect(photographer.subscription?.periods).toHaveLength(1);
      const trial = photographer.subscription?.periods[0];
      expect(trial).toMatchObject({ kind: 'trial', priceRwf: 0, paymentId: null, endsAt: photographer.subscription?.currentPeriodEndsAt });
      expect((trial?.endsAt.getTime() ?? 0) - (trial?.startsAt.getTime() ?? 0)).toBe(30 * 24 * 60 * 60_000);
    }
  });

  it('gives them overlapping catalogues, hours and districts', async () => {
    const summary = await seedDatabase(prisma, env);

    expect(summary.demo).toMatchObject({ servicesCreated: 6, packagesCreated: 8, addonsCreated: 4 });
    // The same slug under two photographers: unique per photographer, not globally.
    const portraits = await prisma.service.findMany({ where: { slug: 'portraits' }, include: { photographer: true } });
    expect(portraits.map((service) => service.photographer.handle).sort()).toEqual(['kigali-lens', 'umucyo-studio']);
    // Every package belongs to its service's photographer (the composite foreign key).
    const packages = await prisma.package.findMany({ include: { service: true } });
    expect(packages.every((pkg) => pkg.photographerId === pkg.service.photographerId)).toBe(true);
    // Everyone works Wednesday 10:00-17:00, in Gasabo.
    const wednesday = await prisma.workingHours.findMany({ where: { weekday: 3, opensMinute: { lte: 600 }, closesMinute: { gte: 1020 } } });
    expect(new Set(wednesday.map((row) => row.photographerId)).size).toBe(3);
    await expect(prisma.photographerDistrict.count({ where: { districtCode: 'gasabo' } })).resolves.toBe(3);
  });

  it('gives each a directory profile (Phase 6): bio, cover, WhatsApp, 4-8 https portfolio images in order, and differing "from" prices', async () => {
    await seedDatabase(prisma, env);

    const photographers = await prisma.photographer.findMany({ include: { portfolioImages: { orderBy: { sortOrder: 'asc' } } }, orderBy: { handle: 'asc' } });
    for (const photographer of photographers) {
      expect(photographer.bio?.length ?? 0, photographer.handle).toBeGreaterThan(60);
      expect(photographer.coverImageUrl, photographer.handle).toMatch(/^https:\/\/images\.unsplash\.com\/photo-[0-9a-f]+-[0-9a-f]+\?/);
      expect(photographer.whatsappPhone, photographer.handle).toMatch(/^\+2507\d{8}$/);
      expect(photographer.portfolioImages.length, photographer.handle).toBeGreaterThanOrEqual(4);
      expect(photographer.portfolioImages.length, photographer.handle).toBeLessThanOrEqual(8);
      expect(photographer.portfolioImages.map((image) => image.sortOrder)).toEqual(photographer.portfolioImages.map((_, index) => index));
      for (const image of photographer.portfolioImages) expect(image.url).toMatch(/^https:\/\/images\.unsplash\.com\//);
    }
    // No image repeats, across all three.
    const urls = photographers.flatMap((photographer) => photographer.portfolioImages.map((image) => image.url));
    expect(new Set(urls).size).toBe(urls.length);

    // The "from" prices differ; the price ranges overlap.
    const prices = await prisma.package.groupBy({ by: ['photographerId'], where: { isActive: true }, _min: { priceRwf: true }, _max: { priceRwf: true } });
    expect(new Set(prices.map((row) => row._min.priceRwf)).size).toBe(3);
    const highestFrom = Math.max(...prices.map((row) => row._min.priceRwf ?? 0));
    expect(prices.every((row) => (row._max.priceRwf ?? 0) >= highestFrom)).toBe(true);
  });

  it('enriches a demo photographer seeded before Phase 6, filling only what is empty, once', async () => {
    await seedDatabase(prisma, env);
    const demo = DEMO_PHOTOGRAPHERS[1];
    const handle = demo?.handle ?? '';
    // As a Phase 1-5 seed left it: no cover, no portfolio; and a WhatsApp number the owner has since set.
    await prisma.photographer.update({ where: { handle }, data: { coverImageUrl: null, whatsappPhone: '+250788999999' } });
    await prisma.portfolioImage.deleteMany({ where: { photographer: { handle } } });

    const again = await seedDatabase(prisma, env);
    const enriched = await prisma.photographer.findUniqueOrThrow({ where: { handle }, include: { portfolioImages: true } });

    expect(again.demo).toMatchObject({ photographersCreated: 0, profilesEnriched: 1 });
    expect(enriched.coverImageUrl).toBe(demo?.coverImageUrl);
    expect(enriched.whatsappPhone).toBe('+250788999999');
    expect(enriched.portfolioImages).toHaveLength(demo?.portfolio.length ?? -1);
    // A third run finds nothing to fill.
    expect((await seedDatabase(prisma, env)).demo).toMatchObject({ profilesEnriched: 0 });
    await expect(prisma.portfolioImage.count({ where: { photographer: { handle } } })).resolves.toBe(demo?.portfolio.length);
  });

  it("never enriches a photographer of someone else's making at a demo handle", async () => {
    const handle = DEMO_PHOTOGRAPHERS[0]?.handle ?? '';
    const user = await prisma.appUser.create({ data: { email: 'real@example.com', role: 'photographer', passwordHash: 'x' } });
    await prisma.photographer.create({ data: { userId: user.id, handle, displayName: 'Someone real', setting: { create: {} } } });

    const summary = await seedDatabase(prisma, env);

    expect(summary.demo).toMatchObject({ profilesEnriched: 0 });
    await expect(prisma.photographer.findUniqueOrThrow({ where: { handle } })).resolves.toMatchObject({ coverImageUrl: null, whatsappPhone: null });
    await expect(prisma.portfolioImage.count({ where: { photographer: { handle } } })).resolves.toBe(0);
  });

  it('keeps the first photographer\'s catalogue as the single-photographer demo had it', async () => {
    await seedDatabase(prisma, env);

    const first = DEMO_PHOTOGRAPHERS[0]?.handle ?? '';
    const services = await prisma.service.findMany({
      where: { photographer: { handle: first } },
      include: { packages: true, addons: true },
      orderBy: { sortOrder: 'asc' },
    });
    expect(services.map((service) => [service.slug, service.packages.length, service.addons.length])).toEqual([
      ['portraits', 2, 1],
      ['events', 1, 0],
    ]);
    await expect(prisma.addon.count({ where: { serviceId: null, photographer: { handle: first } } })).resolves.toBe(1);
  });

  it('creates one confirmed booking with the first photographer, upcoming on a weekday at 10:00 Kigali, whose booking fee is paid', async () => {
    const summary = await seedDatabase(prisma, env);

    const booking = await prisma.booking.findFirstOrThrow({ where: { contactEmail: DEMO_CLIENT_EMAIL }, include: { addons: true, payments: true, photographer: true } });
    expect(summary.demo?.booking).toMatchObject({ reference: booking.reference, created: true });
    expect(booking.photographer.handle).toBe(DEMO_PHOTOGRAPHERS[0]?.handle);
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

    expect(second).toMatchObject({
      photographersCreated: 0,
      servicesCreated: 0,
      packagesCreated: 0,
      addonsCreated: 0,
      booking: { reference: first?.reference, created: false },
    });
    await expect(prisma.photographer.count()).resolves.toBe(3);
    await expect(prisma.subscription.count()).resolves.toBe(3);
    await expect(prisma.subscriptionPeriod.count()).resolves.toBe(3);
    await expect(prisma.appUser.count()).resolves.toBe(4);
    await expect(prisma.service.count()).resolves.toBe(6);
    await expect(prisma.booking.count()).resolves.toBe(1);
    await expect(prisma.payment.count()).resolves.toBe(1);
    await expect(prisma.client.count()).resolves.toBe(1);
    await expect(findBookingByToken(prisma, first?.accessToken ?? '')).resolves.toBeNull();
    await expect(findBookingByToken(prisma, second?.booking?.accessToken ?? '')).resolves.not.toBeNull();
  });

  it('leaves a photographer of someone else\'s making alone, and then books nothing', async () => {
    const handle = DEMO_PHOTOGRAPHERS[0]?.handle ?? '';
    const user = await prisma.appUser.create({ data: { email: 'real@example.com', role: 'photographer', passwordHash: 'x' } });
    const photographer = await prisma.photographer.create({ data: { userId: user.id, handle, displayName: 'Someone real', setting: { create: {} } } });
    await prisma.service.create({ data: { photographerId: photographer.id, slug: 'weddings', nameEn: 'Weddings' } });

    const summary = await seedDatabase(prisma, env);

    expect(summary.demo).toMatchObject({ photographersCreated: 2, booking: null });
    await expect(prisma.photographer.findUniqueOrThrow({ where: { handle } })).resolves.toMatchObject({ displayName: 'Someone real', status: 'pending' });
    await expect(prisma.service.count({ where: { photographerId: photographer.id } })).resolves.toBe(1);
    await expect(prisma.booking.count()).resolves.toBe(0);
  });

  it.each([
    ['in production', { NODE_ENV: 'production' }],
    ['with SEED_DEMO_DATA=false', { SEED_DEMO_DATA: 'false' }],
  ])('seeds no demo data %s', async (_label, extra) => {
    const summary = await seedDatabase(prisma, { ...env, ...extra });

    expect(summary.demo).toBeNull();
    await expect(prisma.photographer.count()).resolves.toBe(0);
    await expect(prisma.service.count()).resolves.toBe(0);
    await expect(prisma.booking.count()).resolves.toBe(0);
  });
});
