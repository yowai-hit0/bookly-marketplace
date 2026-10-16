import type { Prisma, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { updateSettings } from '../settings/index.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { effectiveBookingFeeRate, findPublicService, listPublicCatalogue } from './public.js';

/**
 * `listPublicCatalogue()` against real PostgreSQL (plan.md Task 10; spec §3.4,
 * §6.14). It is "the public list" Task 11's route serves: active services,
 * each with its active packages, then its own active add-ons followed by the
 * active add-ons offered on every service -- and nothing the public must not
 * see.
 *
 * `findPublicService()` is one entry of that list by slug, plus the booking-fee
 * rate that applies to it (plan.md Task 11; data-model_v2.md §9.5): the
 * service's override if set, else the global setting. The top-level afterAll
 * truncates, so a settings row edited here never reaches settings.test.ts,
 * which seeds without truncating and asserts the defaults.
 */

let prisma: PrismaClient;
let raw: pg.Client;

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

// --- Fixtures ---------------------------------------------------------------

function insertService(slug: string, data: Partial<Prisma.ServiceUncheckedCreateInput> = {}) {
  return prisma.service.create({ data: { slug, nameEn: slug, ...data } });
}

function insertPackage(serviceId: string, nameEn: string, data: Partial<Prisma.PackageUncheckedCreateInput> = {}) {
  return prisma.package.create({
    data: { serviceId, nameEn, priceRwf: 40_000, photoCount: 20, durationMinutes: 60, ...data },
  });
}

function insertAddon(serviceId: string | null, nameEn: string, data: Partial<Prisma.AddonUncheckedCreateInput> = {}) {
  return prisma.addon.create({ data: { serviceId, nameEn, priceRwf: 10_000, ...data } });
}

type Listed = Awaited<ReturnType<typeof listPublicCatalogue>>;

/** Each service's slug with its package and add-on names, for order-only assertions. */
function names(list: Listed) {
  return list.map((service) => ({
    slug: service.slug,
    packages: service.packages.map((pkg) => pkg.nameEn),
    addons: service.addons.map((addon) => addon.nameEn),
  }));
}

// --- Filtering -----------------------------------------------------------------

describe('listPublicCatalogue', () => {
  it('lists nothing for an empty catalogue', async () => {
    await expect(listPublicCatalogue(prisma)).resolves.toEqual([]);
  });

  it('lists only active services, each with only its active packages and active add-ons', async () => {
    const portraits = await insertService('portraits', {
      nameEn: 'Portraits',
      descriptionEn: 'Studio portraits.',
      coverImageUrl: 'https://images.example.com/portraits.jpg',
    });
    const standard = await insertPackage(portraits.id, 'Standard', { descriptionEn: 'One look.', priceRwf: 45_000, photoCount: 25, durationMinutes: 90 });
    await insertPackage(portraits.id, 'Retired', { isActive: false });
    const extraHour = await insertAddon(portraits.id, 'Extra hour', { priceRwf: 15_000 });
    await insertAddon(portraits.id, 'Old frame', { isActive: false });

    // An inactive service hides its active packages and add-ons with it.
    const events = await insertService('events', { isActive: false });
    await insertPackage(events.id, 'Half day');
    await insertAddon(events.id, 'Drone');

    const rush = await insertAddon(null, 'Rush edit', { priceRwf: 5_000 });
    await insertAddon(null, 'Discontinued prints', { isActive: false });

    await expect(listPublicCatalogue(prisma)).resolves.toEqual([
      {
        id: portraits.id,
        slug: 'portraits',
        nameEn: 'Portraits',
        descriptionEn: 'Studio portraits.',
        coverImageUrl: 'https://images.example.com/portraits.jpg',
        packages: [
          {
            id: standard.id,
            nameEn: 'Standard',
            descriptionEn: 'One look.',
            priceRwf: 45_000,
            photoCount: 25,
            durationMinutes: 90,
          },
        ],
        addons: [
          { id: extraHour.id, nameEn: 'Extra hour', priceRwf: 15_000 },
          { id: rush.id, nameEn: 'Rush edit', priceRwf: 5_000 },
        ],
      },
    ]);
  });

  it('offers the shared add-ons on every active service, after each service’s own and never another service’s', async () => {
    const weddings = await insertService('weddings');
    await insertService('products');
    await insertAddon(weddings.id, 'Second shooter', { sortOrder: 1 });
    await insertAddon(weddings.id, 'Album', { sortOrder: 0 });
    // Sort order 0 here, yet still after a service's own add-on of order 1.
    await insertAddon(null, 'Rush edit', { sortOrder: 5 });
    await insertAddon(null, 'Prints', { sortOrder: 0 });

    expect(names(await listPublicCatalogue(prisma))).toEqual([
      { slug: 'products', packages: [], addons: ['Prints', 'Rush edit'] },
      { slug: 'weddings', packages: [], addons: ['Album', 'Second shooter', 'Prints', 'Rush edit'] },
    ]);
  });

  it('orders services, packages and add-ons by display order, then name, then age', async () => {
    const older = new Date('2026-09-01T00:00:00Z');
    const newer = new Date('2026-09-02T00:00:00Z');
    // Inserted out of order, so insertion order cannot pass for sorting.
    const zulu = await insertService('zulu', { nameEn: 'Zulu', sortOrder: 1 });
    await insertService('mike-newer', { nameEn: 'Mike', sortOrder: 1, createdAt: newer });
    await insertService('alpha', { nameEn: 'Alpha', sortOrder: 2 });
    await insertService('mike-older', { nameEn: 'Mike', sortOrder: 1, createdAt: older });

    await insertPackage(zulu.id, 'Beta', { sortOrder: 1 });
    await insertPackage(zulu.id, 'Gamma', { sortOrder: 0, createdAt: newer, priceRwf: 2 });
    await insertPackage(zulu.id, 'Alpha', { sortOrder: 1 });
    await insertPackage(zulu.id, 'Gamma', { sortOrder: 0, createdAt: older, priceRwf: 1 });

    await insertAddon(zulu.id, 'Zoom', { sortOrder: 0 });
    await insertAddon(zulu.id, 'Album', { sortOrder: 3 });
    await insertAddon(null, 'Retouch', { sortOrder: 1 });
    await insertAddon(null, 'Drone', { sortOrder: 1 });

    const list = await listPublicCatalogue(prisma);

    expect(list.map((service) => service.slug)).toEqual(['mike-older', 'mike-newer', 'zulu', 'alpha']);
    const zuluListed = list.find((service) => service.id === zulu.id);
    expect(zuluListed?.packages.map((pkg) => [pkg.nameEn, pkg.priceRwf])).toEqual([
      ['Gamma', 1],
      ['Gamma', 2],
      ['Alpha', 40_000],
      ['Beta', 40_000],
    ]);
    expect(zuluListed?.addons.map((addon) => addon.nameEn)).toEqual(['Zoom', 'Album', 'Drone', 'Retouch']);
  });

  it('projects an allowlist: no status, sort key, French, fee override, service id or timestamps', async () => {
    const service = await insertService('portraits', {
      nameEn: 'Portraits',
      nameFr: 'Portraits FR',
      descriptionEn: 'Studio portraits.',
      descriptionFr: 'Portraits en studio.',
      coverImageUrl: 'https://images.example.com/portraits.jpg',
      bookingFeeRateOverride: '0.300',
      sortOrder: 4,
    });
    await insertPackage(service.id, 'Standard', { nameFr: 'Standard FR', descriptionFr: 'Un look.', sortOrder: 2 });
    await insertAddon(service.id, 'Extra hour', { nameFr: 'Heure en plus', sortOrder: 3 });
    await insertAddon(null, 'Rush edit', { nameFr: 'Retouche express' });

    const [listed] = await listPublicCatalogue(prisma);

    expect(Object.keys(listed ?? {}).sort()).toEqual(['addons', 'coverImageUrl', 'descriptionEn', 'id', 'nameEn', 'packages', 'slug']);
    expect(listed?.packages.map((pkg) => Object.keys(pkg).sort())).toEqual([
      ['descriptionEn', 'durationMinutes', 'id', 'nameEn', 'photoCount', 'priceRwf'],
    ]);
    expect(listed?.addons.map((addon) => Object.keys(addon).sort())).toEqual([
      ['id', 'nameEn', 'priceRwf'],
      ['id', 'nameEn', 'priceRwf'],
    ]);
    const json = JSON.stringify(listed);
    for (const hidden of ['FR', 'Un look.', 'Heure en plus', 'Retouche express', 'en studio', '0.3', 'isActive', 'sortOrder', 'serviceId', 'createdAt']) {
      expect(json).not.toContain(hidden);
    }
  });
});

// --- One service's detail (plan.md Task 11) ------------------------------------------

describe('findPublicService', () => {
  beforeEach(async () => {
    // getSettings() throws on a missing row (data-model_v2.md §5.2); seed the
    // schema defaults the way Task 4 seeds production.
    await prisma.setting.create({ data: { id: 1, bookingFeeRate: '0.400' } });
  });

  it('returns an active service with its active packages and add-ons, and the global rate when it has no override', async () => {
    const portraits = await insertService('portraits', {
      nameEn: 'Portraits',
      descriptionEn: 'Studio portraits.',
      coverImageUrl: 'https://images.example.com/portraits.jpg',
    });
    const standard = await insertPackage(portraits.id, 'Standard', { descriptionEn: 'One look.', priceRwf: 45_000, photoCount: 25, durationMinutes: 90 });
    await insertPackage(portraits.id, 'Retired', { isActive: false });
    const extraHour = await insertAddon(portraits.id, 'Extra hour', { priceRwf: 15_000 });
    await insertAddon(portraits.id, 'Old frame', { isActive: false });
    const rush = await insertAddon(null, 'Rush edit', { priceRwf: 5_000 });
    await insertAddon(null, 'Discontinued prints', { isActive: false });

    await expect(findPublicService(prisma, 'portraits')).resolves.toStrictEqual({
      id: portraits.id,
      slug: 'portraits',
      nameEn: 'Portraits',
      descriptionEn: 'Studio portraits.',
      coverImageUrl: 'https://images.example.com/portraits.jpg',
      packages: [
        {
          id: standard.id,
          nameEn: 'Standard',
          descriptionEn: 'One look.',
          priceRwf: 45_000,
          photoCount: 25,
          durationMinutes: 90,
        },
      ],
      addons: [
        { id: extraHour.id, nameEn: 'Extra hour', priceRwf: 15_000 },
        { id: rush.id, nameEn: 'Rush edit', priceRwf: 5_000 },
      ],
      bookingFeeRate: 0.4,
    });
  });

  it('is the public list’s entry for that service, plus the rate', async () => {
    const weddings = await insertService('weddings', { sortOrder: 1 });
    const products = await insertService('products', { bookingFeeRateOverride: '0.250' });
    await insertPackage(weddings.id, 'Full day', { priceRwf: 600_000 });
    await insertPackage(products.id, 'Ten items');
    await insertAddon(weddings.id, 'Second shooter');
    await insertAddon(products.id, 'White background');
    await insertAddon(null, 'Rush edit');

    const list = await listPublicCatalogue(prisma);
    for (const [slug, bookingFeeRate] of [['weddings', 0.4], ['products', 0.25]] as const) {
      expect(await findPublicService(prisma, slug)).toStrictEqual({
        ...list.find((service) => service.slug === slug),
        bookingFeeRate,
      });
    }
  });

  it('charges a service’s own override: 0.300 is a rate of 0.3, whatever the global rate', async () => {
    await insertService('portraits', { bookingFeeRateOverride: '0.300' });

    const detail = await findPublicService(prisma, 'portraits');

    expect(detail?.bookingFeeRate).toBe(0.3);
    expect(typeof detail?.bookingFeeRate).toBe('number');
  });

  it('charges an override of 0.000 as 0 rather than falling back to the global rate', async () => {
    await insertService('free-deposit', { bookingFeeRateOverride: '0.000' });
    await insertService('pay-in-full', { bookingFeeRateOverride: '1.000' });
    await insertService('odd-rate', { bookingFeeRateOverride: '0.375' });

    expect((await findPublicService(prisma, 'free-deposit'))?.bookingFeeRate).toBe(0);
    expect((await findPublicService(prisma, 'pay-in-full'))?.bookingFeeRate).toBe(1);
    expect((await findPublicService(prisma, 'odd-rate'))?.bookingFeeRate).toBe(0.375);
  });

  it('follows the global setting when it changes, and ignores it where an override is set', async () => {
    await insertService('portraits');
    await insertService('weddings', { bookingFeeRateOverride: '0.300' });
    expect((await findPublicService(prisma, 'portraits'))?.bookingFeeRate).toBe(0.4);

    await updateSettings({ bookingFeeRate: 0.35 }, prisma);

    expect((await findPublicService(prisma, 'portraits'))?.bookingFeeRate).toBe(0.35);
    expect((await findPublicService(prisma, 'weddings'))?.bookingFeeRate).toBe(0.3);
  });

  it('is null for an unknown slug, and for a deactivated service even with active packages (spec §6.14)', async () => {
    const events = await insertService('events', { isActive: false });
    await insertPackage(events.id, 'Half day');
    await insertAddon(events.id, 'Drone');

    await expect(findPublicService(prisma, 'events')).resolves.toBeNull();
    await expect(findPublicService(prisma, 'nothing-here')).resolves.toBeNull();
    await expect(findPublicService(prisma, '')).resolves.toBeNull();
  });

  it('matches the slug exactly, never as a pattern or a prefix', async () => {
    await insertService('portraits');

    for (const slug of ['portrait', 'portraits-2', 'Portraits', 'portrait%', 'portrait_']) {
      await expect(findPublicService(prisma, slug)).resolves.toBeNull();
    }
  });

  it('becomes null when the service is deactivated, and returns when it is reactivated', async () => {
    const service = await insertService('portraits');
    expect(await findPublicService(prisma, 'portraits')).not.toBeNull();

    await prisma.service.update({ where: { id: service.id }, data: { isActive: false } });
    await expect(findPublicService(prisma, 'portraits')).resolves.toBeNull();

    await prisma.service.update({ where: { id: service.id }, data: { isActive: true } });
    expect((await findPublicService(prisma, 'portraits'))?.id).toBe(service.id);
  });

  it('offers its own add-ons, then the shared ones, and never another service’s', async () => {
    const weddings = await insertService('weddings');
    const products = await insertService('products');
    await insertAddon(weddings.id, 'Second shooter', { sortOrder: 5 });
    await insertAddon(weddings.id, 'Album', { sortOrder: 2 });
    await insertAddon(products.id, 'White background', { sortOrder: 0 });
    // Sort order 0, yet still after the service's own add-on of order 5.
    await insertAddon(null, 'Rush edit', { sortOrder: 1 });
    await insertAddon(null, 'Prints', { sortOrder: 0 });

    const weddingsDetail = await findPublicService(prisma, 'weddings');
    const productsDetail = await findPublicService(prisma, 'products');

    expect(weddingsDetail?.addons.map((addon) => addon.nameEn)).toEqual(['Album', 'Second shooter', 'Prints', 'Rush edit']);
    expect(productsDetail?.addons.map((addon) => addon.nameEn)).toEqual(['White background', 'Prints', 'Rush edit']);
  });

  it('orders packages by display order, then name, then age', async () => {
    const service = await insertService('portraits');
    await insertPackage(service.id, 'Beta', { sortOrder: 1 });
    await insertPackage(service.id, 'Zulu', { sortOrder: 0 });
    await insertPackage(service.id, 'Alpha', { sortOrder: 1 });

    const detail = await findPublicService(prisma, 'portraits');

    expect(detail?.packages.map((pkg) => pkg.nameEn)).toEqual(['Zulu', 'Alpha', 'Beta']);
  });

  it('returns a service with no active packages or add-ons, with empty lists', async () => {
    const service = await insertService('portraits');
    await insertPackage(service.id, 'Retired', { isActive: false });

    const detail = await findPublicService(prisma, 'portraits');

    expect(detail?.packages).toEqual([]);
    expect(detail?.addons).toEqual([]);
  });

  it('projects an allowlist: no raw override, status, sort key, French, service id or timestamps', async () => {
    const service = await insertService('portraits', {
      nameEn: 'Portraits',
      nameFr: 'Portraits FR',
      descriptionEn: 'Studio portraits.',
      descriptionFr: 'Portraits en studio.',
      coverImageUrl: 'https://images.example.com/portraits.jpg',
      bookingFeeRateOverride: '0.375',
      sortOrder: 4,
    });
    await insertPackage(service.id, 'Standard', { nameFr: 'Standard FR', descriptionFr: 'Un look.', sortOrder: 2 });
    await insertAddon(service.id, 'Extra hour', { nameFr: 'Heure en plus', sortOrder: 3 });
    await insertAddon(null, 'Rush edit', { nameFr: 'Retouche express' });

    const detail = await findPublicService(prisma, 'portraits');

    expect(Object.keys(detail ?? {}).sort()).toEqual([
      'addons',
      'bookingFeeRate',
      'coverImageUrl',
      'descriptionEn',
      'id',
      'nameEn',
      'packages',
      'slug',
    ]);
    expect(detail?.packages.map((pkg) => Object.keys(pkg).sort())).toEqual([
      ['descriptionEn', 'durationMinutes', 'id', 'nameEn', 'photoCount', 'priceRwf'],
    ]);
    expect(detail?.addons.map((addon) => Object.keys(addon).sort())).toEqual([
      ['id', 'nameEn', 'priceRwf'],
      ['id', 'nameEn', 'priceRwf'],
    ]);
    const json = JSON.stringify(detail);
    for (const hidden of ['FR', 'Un look.', 'Heure en plus', 'Retouche express', 'en studio', 'Override', 'isActive', 'sortOrder', 'serviceId', 'createdAt', 'updatedAt']) {
      expect(json).not.toContain(hidden);
    }
  });
});

describe('effectiveBookingFeeRate', () => {
  it('is the override as a number when one is set, else the global rate', async () => {
    const withOverride = await insertService('portraits', { bookingFeeRateOverride: '0.300' });
    const withoutOverride = await insertService('weddings');
    const zeroOverride = await insertService('free', { bookingFeeRateOverride: '0.000' });

    expect(effectiveBookingFeeRate(withOverride, 0.4)).toBe(0.3);
    expect(effectiveBookingFeeRate(withoutOverride, 0.4)).toBe(0.4);
    expect(effectiveBookingFeeRate(withoutOverride, 0.125)).toBe(0.125);
    expect(effectiveBookingFeeRate(zeroOverride, 0.4)).toBe(0);
  });
});

// --- Spec §6.14 -------------------------------------------------------------------

describe('a deactivated service with bookings (spec §6.14)', () => {
  it('leaves the public list while its bookings stay readable with their snapshots', async () => {
    const service = await insertService('portraits', { nameEn: 'Portraits' });
    const pkg = await insertPackage(service.id, 'Standard');
    const addon = await insertAddon(service.id, 'Extra hour', { priceRwf: 15_000 });
    const client = await prisma.client.create({
      data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' },
    });
    const startsAt = new Date('2026-10-07T07:00:00Z');
    const booking = await prisma.booking.create({
      data: {
        reference: 'BKY-2610-00001',
        clientId: client.id,
        contactName: 'Aline Uwase',
        contactEmail: 'aline@example.com',
        contactPhone: '+250788000000',
        serviceId: service.id,
        packageId: pkg.id,
        serviceNameSnapshot: 'Portraits',
        packageNameSnapshot: 'Standard',
        packagePriceRwf: 40_000,
        packageDurationMinutes: 60,
        packagePhotoCount: 20,
        locationText: 'Kigali Heights',
        consentAt: new Date('2026-10-01T06:00:00Z'),
        bookingFeeRate: '0.400',
        bookingFeeRwf: 22_000,
        status: 'confirmed',
        startsAt,
        endsAt: new Date('2026-10-07T08:00:00Z'),
        bufferEndsAt: new Date('2026-10-07T08:30:00Z'),
        addons: {
          create: {
            addonId: addon.id,
            nameSnapshot: 'Extra hour',
            unitPriceRwf: 15_000,
            quantity: 1,
            amountRwf: 15_000,
            stage: 'at_booking',
          },
        },
      },
    });
    expect(names(await listPublicCatalogue(prisma))).toEqual([
      { slug: 'portraits', packages: ['Standard'], addons: ['Extra hour'] },
    ]);

    await prisma.service.update({ where: { id: service.id }, data: { isActive: false, nameEn: 'Portrait sessions' } });
    await prisma.package.update({ where: { id: pkg.id }, data: { isActive: false, priceRwf: 99_000 } });
    await prisma.addon.update({ where: { id: addon.id }, data: { isActive: false, priceRwf: 99_000 } });

    await expect(listPublicCatalogue(prisma)).resolves.toEqual([]);
    const readable = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: { service: true, package: true, addons: true },
    });
    expect(readable).toMatchObject({
      status: 'confirmed',
      serviceNameSnapshot: 'Portraits',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 40_000,
      packageDurationMinutes: 60,
      packagePhotoCount: 20,
      bookingFeeRwf: 22_000,
      startsAt,
      service: { id: service.id, isActive: false },
      package: { id: pkg.id, isActive: false },
      addons: [{ addonId: addon.id, nameSnapshot: 'Extra hour', unitPriceRwf: 15_000, amountRwf: 15_000 }],
    });
    expect(readable.bookingFeeRate.toFixed(3)).toBe('0.400');
  });
});
