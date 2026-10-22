import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { kigaliMinuteToUtc } from '../availability/engine.js';
import { STARTER_CATEGORIES } from '../db/seed.js';
import { createPhotographer, grantSubscription } from './payment-fixtures.js';

/**
 * Fixtures for the directory and the profile page (marketplace-spec.md Phase 6,
 * T6.1-T6.4). Imported by tests only.
 *
 * `listedPhotographer` builds one photographer exactly as a test describes them:
 * status, subscription, districts, categories, packages and working hours.
 * `seedDirectoryPhotographers` bulk-inserts N varied photographers for the
 * performance test (T6.3), a handful of statements per table rather than per
 * row, so 200 of them seed in about a second.
 */

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
const VERIFIED_AT = new Date('2026-09-01T06:00:00Z');

/** The 8 starter categories as the seed creates them (db/seed.ts); a truncate removes them. */
export async function seedStarterCategories(prisma: PrismaClient): Promise<Map<string, string>> {
  await prisma.category.createMany({ data: STARTER_CATEGORIES.map((category, sortOrder) => ({ ...category, sortOrder })), skipDuplicates: true });
  const rows = await prisma.category.findMany({ select: { id: true, slug: true } });
  return new Map(rows.map((row) => [row.slug, row.id]));
}

export type FixturePackage = {
  priceRwf: number;
  durationMinutes?: number;
  isActive?: boolean;
  /** The package's service is inactive: the package does not count. */
  serviceInactive?: boolean;
};

export type ListedPhotographerSeed = {
  handle: string;
  displayName?: string;
  status?: 'pending' | 'approved' | 'suspended';
  /** For an approved photographer: the subscription's stored status and period end. Defaults to trialing to 2100. */
  subscription?: { status: string; endsAt: Date } | null;
  districts?: string[];
  /** Category slugs; `seedStarterCategories` must have run. */
  categories?: string[];
  /** Each on its own service unless `sameService`. Defaults to one active 40,000 RWF, 60-minute package. */
  packages?: FixturePackage[];
  /** Weekly hours, Kigali minutes; defaults to Mon-Sat 09:00-17:00. `[]` for none. */
  hours?: { weekday: number; opensMinute: number; closesMinute: number }[];
  coverImageUrl?: string | null;
  bio?: string | null;
};

export type ListedPhotographer = { photographerId: string; handle: string; serviceIds: string[]; packageIds: string[] };

export const WEEKDAY_HOURS = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensMinute: 540, closesMinute: 1020 }));

/** One photographer for a directory test, with exactly the rows `seed` describes. */
export async function listedPhotographer(prisma: PrismaClient, seed: ListedPhotographerSeed): Promise<ListedPhotographer> {
  const status = seed.status ?? 'approved';
  const { photographerId } = await createPhotographer(prisma, {
    email: `${seed.handle}@photographers.example`,
    handle: seed.handle,
    displayName: seed.displayName ?? seed.handle,
    status: status === 'approved' && seed.subscription !== undefined ? 'pending' : status,
  });
  if (status === 'approved' && seed.subscription !== undefined) {
    // createPhotographer grants the default subscription to an approved photographer; this one names its own.
    await prisma.photographer.update({ where: { id: photographerId }, data: { status: 'approved', approvedAt: new Date('2026-09-02T06:00:00Z') } });
    if (seed.subscription !== null) {
      await grantSubscription(prisma, photographerId, {
        endsAt: seed.subscription.endsAt,
        status: seed.subscription.status,
        startsAt: new Date(Math.min(seed.subscription.endsAt.getTime() - DAY_MS, new Date('2026-09-02T06:00:00Z').getTime())),
      });
    }
  }
  await prisma.photographer.update({
    where: { id: photographerId },
    data: { coverImageUrl: seed.coverImageUrl ?? null, bio: seed.bio ?? null },
  });

  if ((seed.districts ?? []).length > 0) {
    await prisma.photographerDistrict.createMany({ data: (seed.districts ?? []).map((districtCode) => ({ photographerId, districtCode })) });
  }
  if ((seed.categories ?? []).length > 0) {
    const categories = await prisma.category.findMany({ where: { slug: { in: seed.categories ?? [] } }, select: { id: true } });
    await prisma.photographerCategory.createMany({ data: categories.map((category) => ({ photographerId, categoryId: category.id })) });
  }

  const serviceIds: string[] = [];
  const packageIds: string[] = [];
  for (const [index, pkg] of (seed.packages ?? [{ priceRwf: 40_000 }]).entries()) {
    const service = await prisma.service.create({
      data: { photographerId, slug: `service-${index + 1}`, nameEn: `Service ${index + 1}`, isActive: !pkg.serviceInactive, sortOrder: index },
    });
    const created = await prisma.package.create({
      data: {
        photographerId,
        serviceId: service.id,
        nameEn: `Package ${index + 1}`,
        priceRwf: pkg.priceRwf,
        photoCount: 20,
        durationMinutes: pkg.durationMinutes ?? 60,
        isActive: pkg.isActive ?? true,
      },
    });
    serviceIds.push(service.id);
    packageIds.push(created.id);
  }

  const hours = seed.hours ?? WEEKDAY_HOURS;
  if (hours.length > 0) {
    await prisma.workingHours.createMany({ data: hours.map((row) => ({ photographerId, ...row, isOpen: true })) });
  }
  return { photographerId, handle: seed.handle, serviceIds, packageIds };
}

// --- Bulk, for the performance test (T6.3) ------------------------------------------

export type BulkSeedOptions = {
  /** A Kigali date the calendars are busy on: some fully booked, some blocked, some half booked. */
  busyDate: string;
};

export type BulkSeedSummary = { listed: number; bookable: number; pastDue: number; hidden: number };

const DISTRICT_CODES = ['gasabo', 'kicukiro', 'nyarugenge', 'musanze', 'huye', 'rubavu', 'rwamagana', 'muhanga', 'karongi', 'nyagatare'];

/**
 * `count` photographers in one transaction, varied by their index so every
 * filter has something to keep and something to drop:
 *   - 1 in 20 pending, 1 in 25 suspended, 1 in 30 expired; 1 in 10 `past_due`
 *   - 1-3 districts of ten, 1-2 starter categories
 *   - 1-2 services of 1-3 packages, prices 20,000-200,000 RWF, 60-240 minutes,
 *     with an inactive package and an inactive service here and there
 *   - Mon-Sat 08:00-18:00 (some closed on Saturdays); on `busyDate` 1 in 6 is
 *     fully booked, 1 in 7 blocked all day and 1 in 3 half booked
 */
export async function seedDirectoryPhotographers(prisma: PrismaClient, count: number, options: BulkSeedOptions): Promise<BulkSeedSummary> {
  const categories = [...(await seedStarterCategories(prisma)).values()];
  const client = await prisma.client.create({ data: { fullName: 'Directory Client', email: `directory.client.${randomUUID()}@example.com`, phone: '+250788123456' } });
  const now = new Date('2026-09-02T06:00:00Z');
  const summary: BulkSeedSummary = { listed: 0, bookable: 0, pastDue: 0, hidden: 0 };

  const users: Prisma.AppUserCreateManyInput[] = [];
  const photographers: Prisma.PhotographerCreateManyInput[] = [];
  const settings: Prisma.PhotographerSettingCreateManyInput[] = [];
  const subscriptions: Prisma.SubscriptionCreateManyInput[] = [];
  const periods: Prisma.SubscriptionPeriodCreateManyInput[] = [];
  const districts: Prisma.PhotographerDistrictCreateManyInput[] = [];
  const categoryLinks: Prisma.PhotographerCategoryCreateManyInput[] = [];
  const services: Prisma.ServiceCreateManyInput[] = [];
  const packages: (Prisma.PackageCreateManyInput & { id: string })[] = [];
  const hours: Prisma.WorkingHoursCreateManyInput[] = [];
  const blocks: Prisma.AvailabilityBlockCreateManyInput[] = [];
  const bookings: Prisma.BookingCreateManyInput[] = [];

  for (let i = 0; i < count; i += 1) {
    const id = randomUUID();
    const userId = randomUUID();
    const handle = `dir-${String(i).padStart(4, '0')}`;
    const status = i % 20 === 7 ? 'pending' : i % 25 === 11 ? 'suspended' : 'approved';
    const subscriptionStatus = i % 30 === 13 ? 'expired' : i % 10 === 3 ? 'past_due' : 'trialing';
    const endsAt =
      subscriptionStatus === 'expired' ? new Date('2026-01-01T00:00:00Z') : subscriptionStatus === 'past_due' ? new Date(Date.now() - DAY_MS) : new Date('2100-01-01T00:00:00Z');
    // Listed only with an active package on an active service, as the directory requires.
    let sellsSomething = false;

    users.push({ id: userId, email: `${handle}@photographers.example`, role: 'photographer', passwordHash: 'not-a-real-hash', emailVerifiedAt: VERIFIED_AT });
    photographers.push({
      id,
      userId,
      handle,
      displayName: `Directory Photographer ${String(count - i).padStart(4, '0')}`,
      status,
      coverImageUrl: `https://images.example.com/${handle}.jpg`,
      ...(status === 'approved' ? { approvedAt: now } : {}),
      ...(status === 'suspended' ? { suspendedAt: now } : {}),
    });
    settings.push({ photographerId: id });
    if (status !== 'pending') {
      const subscriptionId = randomUUID();
      subscriptions.push({ id: subscriptionId, photographerId: id, status: subscriptionStatus, currentPeriodEndsAt: endsAt });
      periods.push({ subscriptionId, kind: 'trial', priceRwf: 0, startsAt: new Date(endsAt.getTime() - 30 * DAY_MS), endsAt });
    }
    for (let d = 0; d <= i % 3; d += 1) districts.push({ photographerId: id, districtCode: DISTRICT_CODES[(i + d * 3) % DISTRICT_CODES.length] ?? 'gasabo' });
    for (let c = 0; c <= i % 2; c += 1) categoryLinks.push({ photographerId: id, categoryId: categories[(i + c * 5) % categories.length] ?? '' });

    for (let s = 0; s <= i % 2; s += 1) {
      const serviceId = randomUUID();
      const serviceActive = !(i % 17 === 5 && s === 1);
      services.push({ id: serviceId, photographerId: id, slug: `service-${s + 1}`, nameEn: `Service ${s + 1}`, isActive: serviceActive, sortOrder: s });
      for (let p = 0; p <= (i + s) % 3; p += 1) {
        const packageActive = !(i % 13 === 4 && p === 0);
        if (serviceActive && packageActive) sellsSomething = true;
        packages.push({
          id: randomUUID(),
          photographerId: id,
          serviceId,
          nameEn: `Package ${p + 1}`,
          priceRwf: 20_000 + ((i * 7_919 + s * 3_000 + p * 25_000) % 180_000),
          photoCount: 20,
          durationMinutes: 60 + ((i + p) % 4) * 60,
          isActive: packageActive,
        });
      }
    }
    if (status !== 'approved' || subscriptionStatus === 'expired' || !sellsSomething) summary.hidden += 1;
    else if (subscriptionStatus === 'past_due') summary.pastDue += 1;
    else summary.bookable += 1;
    for (const weekday of i % 4 === 0 ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6]) hours.push({ photographerId: id, weekday, opensMinute: 480, closesMinute: 1080, isOpen: true });

    if (i % 7 === 2) {
      blocks.push({ photographerId: id, startsAt: kigaliMinuteToUtc(options.busyDate, 0), endsAt: kigaliMinuteToUtc(options.busyDate, 1440), isAllDay: true });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.appUser.createMany({ data: users });
    await tx.photographer.createMany({ data: photographers });
    await tx.photographerSetting.createMany({ data: settings });
    await tx.subscription.createMany({ data: subscriptions });
    await tx.subscriptionPeriod.createMany({ data: periods });
    await tx.photographerDistrict.createMany({ data: districts, skipDuplicates: true });
    await tx.photographerCategory.createMany({ data: categoryLinks, skipDuplicates: true });
    await tx.service.createMany({ data: services });
    await tx.package.createMany({ data: packages });
    await tx.workingHours.createMany({ data: hours });
    await tx.availabilityBlock.createMany({ data: blocks });
  }, { timeout: 60_000 });


  // Bookings on the busy date: the whole 08:00-18:00 day for 1 in 6, the morning for 1 in 3.
  const byPhotographer = new Map<string, (typeof packages)[number]>();
  for (const pkg of packages) if (!byPhotographer.has(pkg.photographerId)) byPhotographer.set(pkg.photographerId, pkg);
  let index = 0;
  for (const [photographerId, pkg] of byPhotographer) {
    const whole = index % 6 === 1;
    const half = !whole && index % 3 === 0;
    index += 1;
    if (!whole && !half) continue;
    const startsAt = kigaliMinuteToUtc(options.busyDate, whole ? 0 : 480);
    const endsAt = kigaliMinuteToUtc(options.busyDate, whole ? 1440 : 780);
    bookings.push({
      reference: `BKY-2612-${String(index).padStart(5, '0')}`,
      clientId: client.id,
      photographerId,
      contactName: 'Directory Client',
      contactEmail: 'directory.client@example.com',
      contactPhone: '+250788123456',
      serviceId: pkg.serviceId,
      packageId: pkg.id,
      serviceNameSnapshot: 'Service',
      packageNameSnapshot: pkg.nameEn,
      packagePriceRwf: pkg.priceRwf,
      packageDurationMinutes: Math.round((endsAt.getTime() - startsAt.getTime()) / MINUTE_MS),
      packagePhotoCount: 20,
      status: 'confirmed',
      startsAt,
      endsAt,
      bufferEndsAt: endsAt,
      locationText: 'Kigali',
      consentAt: now,
      bookingFeeRate: '0.400',
      bookingFeeRwf: 1_000,
      clientCancelCutoffHours: 0,
      bookingFeeRefundableOnClientCancel: false,
      confirmedAt: now,
    });
  }
  await prisma.booking.createMany({ data: bookings });

  summary.listed = summary.bookable + summary.pastDue;
  return summary;
}
