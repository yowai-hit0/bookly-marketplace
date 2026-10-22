import type { Prisma, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { updatePhotographerSettings } from '../settings/index.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { PHOTOGRAPHER_EMAIL, PHOTOGRAPHER_HANDLE, TEST_PLATFORM_SETTING, createPhotographer } from '../test/payment-fixtures.js';
import {
  effectiveBookingFeeRate,
  findPublicPhotographer,
  findPublicService,
  listPublicCatalogue,
} from './public.js';

/**
 * `listPublicCatalogue()` against real PostgreSQL (plan.md Task 10; spec §3.4,
 * §6.14). It is "the public list" Task 11's route serves: active services,
 * each with its active packages, then its own active add-ons followed by the
 * active add-ons offered on every service -- and nothing the public must not
 * see.
 *
 * `findPublicService()` is one entry of that list by slug, plus the booking-fee
 * rate that applies to it (plan.md Task 11; data-model_v2.md §9.5): the
 * service's override if set, else the photographer's setting. The top-level
 * afterAll truncates, so a settings row edited here never reaches
 * settings.test.ts, which seeds without truncating and asserts the defaults.
 *
 * Every catalogue is one photographer's (brief decision 4): another
 * photographer's services, packages and add-ons -- the ones they offer on every
 * service included -- never appear in it. The profile shows listed
 * photographers only, through an allowlist that leaves out their status, their
 * login and their settings. The directory's own list is catalogue/directory.ts,
 * proven in routes/public-directory.test.ts.
 */

let prisma: PrismaClient;
let raw: pg.Client;
/** The approved photographer every fixture below belongs to unless it names another. */
let photographerId: string;

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
  // The platform row: the listing reads its grace days (R5.5).
  await prisma.platformSetting.create({ data: TEST_PLATFORM_SETTING });
  // Born with its settings row at the defaults: a 40% booking fee.
  ({ photographerId } = await createPhotographer(prisma, { email: PHOTOGRAPHER_EMAIL, handle: PHOTOGRAPHER_HANDLE, displayName: 'Kigali Lens' }));
});

// --- Fixtures ---------------------------------------------------------------

function insertService(slug: string, data: Partial<Prisma.ServiceUncheckedCreateInput> = {}) {
  return prisma.service.create({ data: { photographerId, slug, nameEn: slug, ...data } });
}

function insertPackage(serviceId: string, nameEn: string, data: Partial<Prisma.PackageUncheckedCreateInput> = {}) {
  return prisma.package.create({
    data: { photographerId, serviceId, nameEn, priceRwf: 40_000, photoCount: 20, durationMinutes: 60, ...data },
  });
}

function insertAddon(serviceId: string | null, nameEn: string, data: Partial<Prisma.AddonUncheckedCreateInput> = {}) {
  return prisma.addon.create({ data: { photographerId, serviceId, nameEn, priceRwf: 10_000, ...data } });
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
    await expect(listPublicCatalogue(prisma, photographerId)).resolves.toEqual([]);
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

    await expect(listPublicCatalogue(prisma, photographerId)).resolves.toEqual([
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

    expect(names(await listPublicCatalogue(prisma, photographerId))).toEqual([
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

    const list = await listPublicCatalogue(prisma, photographerId);

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

    const [listed] = await listPublicCatalogue(prisma, photographerId);

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
  it('returns an active service with its active packages and add-ons, and the photographer’s rate when it has no override', async () => {
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

    await expect(findPublicService(prisma, photographerId, 'portraits')).resolves.toStrictEqual({
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

    const list = await listPublicCatalogue(prisma, photographerId);
    for (const [slug, bookingFeeRate] of [['weddings', 0.4], ['products', 0.25]] as const) {
      expect(await findPublicService(prisma, photographerId, slug)).toStrictEqual({
        ...list.find((service) => service.slug === slug),
        bookingFeeRate,
      });
    }
  });

  it('charges a service’s own override: 0.300 is a rate of 0.3, whatever the photographer’s rate', async () => {
    await insertService('portraits', { bookingFeeRateOverride: '0.300' });

    const detail = await findPublicService(prisma, photographerId, 'portraits');

    expect(detail?.bookingFeeRate).toBe(0.3);
    expect(typeof detail?.bookingFeeRate).toBe('number');
  });

  it('charges an override of 0.000 as 0 rather than falling back to the photographer’s rate', async () => {
    await insertService('free-deposit', { bookingFeeRateOverride: '0.000' });
    await insertService('pay-in-full', { bookingFeeRateOverride: '1.000' });
    await insertService('odd-rate', { bookingFeeRateOverride: '0.375' });

    expect((await findPublicService(prisma, photographerId, 'free-deposit'))?.bookingFeeRate).toBe(0);
    expect((await findPublicService(prisma, photographerId, 'pay-in-full'))?.bookingFeeRate).toBe(1);
    expect((await findPublicService(prisma, photographerId, 'odd-rate'))?.bookingFeeRate).toBe(0.375);
  });

  it('follows the photographer’s setting when it changes, and ignores it where an override is set', async () => {
    await insertService('portraits');
    await insertService('weddings', { bookingFeeRateOverride: '0.300' });
    expect((await findPublicService(prisma, photographerId, 'portraits'))?.bookingFeeRate).toBe(0.4);

    await updatePhotographerSettings(photographerId, { bookingFeeRate: 0.35 }, prisma);

    expect((await findPublicService(prisma, photographerId, 'portraits'))?.bookingFeeRate).toBe(0.35);
    expect((await findPublicService(prisma, photographerId, 'weddings'))?.bookingFeeRate).toBe(0.3);
  });

  it('is null for an unknown slug, and for a deactivated service even with active packages (spec §6.14)', async () => {
    const events = await insertService('events', { isActive: false });
    await insertPackage(events.id, 'Half day');
    await insertAddon(events.id, 'Drone');

    await expect(findPublicService(prisma, photographerId, 'events')).resolves.toBeNull();
    await expect(findPublicService(prisma, photographerId, 'nothing-here')).resolves.toBeNull();
    await expect(findPublicService(prisma, photographerId, '')).resolves.toBeNull();
  });

  it('matches the slug exactly, never as a pattern or a prefix', async () => {
    await insertService('portraits');

    for (const slug of ['portrait', 'portraits-2', 'Portraits', 'portrait%', 'portrait_']) {
      await expect(findPublicService(prisma, photographerId, slug)).resolves.toBeNull();
    }
  });

  it('becomes null when the service is deactivated, and returns when it is reactivated', async () => {
    const service = await insertService('portraits');
    expect(await findPublicService(prisma, photographerId, 'portraits')).not.toBeNull();

    await prisma.service.update({ where: { id: service.id }, data: { isActive: false } });
    await expect(findPublicService(prisma, photographerId, 'portraits')).resolves.toBeNull();

    await prisma.service.update({ where: { id: service.id }, data: { isActive: true } });
    expect((await findPublicService(prisma, photographerId, 'portraits'))?.id).toBe(service.id);
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

    const weddingsDetail = await findPublicService(prisma, photographerId, 'weddings');
    const productsDetail = await findPublicService(prisma, photographerId, 'products');

    expect(weddingsDetail?.addons.map((addon) => addon.nameEn)).toEqual(['Album', 'Second shooter', 'Prints', 'Rush edit']);
    expect(productsDetail?.addons.map((addon) => addon.nameEn)).toEqual(['White background', 'Prints', 'Rush edit']);
  });

  it('orders packages by display order, then name, then age', async () => {
    const service = await insertService('portraits');
    await insertPackage(service.id, 'Beta', { sortOrder: 1 });
    await insertPackage(service.id, 'Zulu', { sortOrder: 0 });
    await insertPackage(service.id, 'Alpha', { sortOrder: 1 });

    const detail = await findPublicService(prisma, photographerId, 'portraits');

    expect(detail?.packages.map((pkg) => pkg.nameEn)).toEqual(['Zulu', 'Alpha', 'Beta']);
  });

  it('returns a service with no active packages or add-ons, with empty lists', async () => {
    const service = await insertService('portraits');
    await insertPackage(service.id, 'Retired', { isActive: false });

    const detail = await findPublicService(prisma, photographerId, 'portraits');

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

    const detail = await findPublicService(prisma, photographerId, 'portraits');

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
  it('is the override as a number when one is set, else the photographer’s rate', async () => {
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
        photographerId,
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
        clientCancelCutoffHours: 0,
        bookingFeeRefundableOnClientCancel: false,
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
    expect(names(await listPublicCatalogue(prisma, photographerId))).toEqual([
      { slug: 'portraits', packages: ['Standard'], addons: ['Extra hour'] },
    ]);

    await prisma.service.update({ where: { id: service.id }, data: { isActive: false, nameEn: 'Portrait sessions' } });
    await prisma.package.update({ where: { id: pkg.id }, data: { isActive: false, priceRwf: 99_000 } });
    await prisma.addon.update({ where: { id: addon.id }, data: { isActive: false, priceRwf: 99_000 } });

    await expect(listPublicCatalogue(prisma, photographerId)).resolves.toEqual([]);
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

// --- Per photographer (brief decisions 2 and 4) -----------------------------------------

/** Another photographer, approved unless told otherwise, with a catalogue of the same slugs. */
async function otherPhotographer(
  { handle = 'hills-and-light', displayName = 'Hills & Light', status = 'approved' }: {
    handle?: string;
    displayName?: string;
    status?: 'pending' | 'approved' | 'suspended';
  } = {},
): Promise<string> {
  const other = await createPhotographer(prisma, { email: `${handle}@bookly.example`, handle, displayName, status });
  const service = await insertService('portraits', { photographerId: other.photographerId, nameEn: 'Their portraits' });
  await insertPackage(service.id, 'Their standard', { photographerId: other.photographerId });
  await insertAddon(service.id, 'Their extra hour', { photographerId: other.photographerId });
  await insertAddon(null, 'Their rush edit', { photographerId: other.photographerId });
  return other.photographerId;
}

describe('one photographer’s catalogue', () => {
  it('lists only that photographer’s services, packages and add-ons, shared ones included', async () => {
    const service = await insertService('portraits', { nameEn: 'Portraits' });
    await insertPackage(service.id, 'Standard');
    await insertAddon(service.id, 'Extra hour');
    await insertAddon(null, 'Rush edit');
    const otherId = await otherPhotographer();

    expect(names(await listPublicCatalogue(prisma, photographerId))).toEqual([
      { slug: 'portraits', packages: ['Standard'], addons: ['Extra hour', 'Rush edit'] },
    ]);
    expect(names(await listPublicCatalogue(prisma, otherId))).toEqual([
      { slug: 'portraits', packages: ['Their standard'], addons: ['Their extra hour', 'Their rush edit'] },
    ]);
  });

  it('finds a slug under its own photographer only, with that photographer’s rate', async () => {
    const mine = await insertService('portraits');
    const otherId = await otherPhotographer();
    await updatePhotographerSettings(otherId, { bookingFeeRate: 0.2 }, prisma);

    const detail = await findPublicService(prisma, photographerId, 'portraits');
    const theirs = await findPublicService(prisma, otherId, 'portraits');

    expect(detail?.id).toBe(mine.id);
    expect(detail?.bookingFeeRate).toBe(0.4);
    expect(theirs?.id).not.toBe(mine.id);
    expect(theirs?.addons.map((addon) => addon.nameEn)).toEqual(['Their extra hour', 'Their rush edit']);
    expect(theirs?.bookingFeeRate).toBe(0.2);
  });

  it('does not find a slug that only another photographer has', async () => {
    await otherPhotographer();
    await prisma.service.updateMany({ where: { slug: 'portraits', photographerId: { not: photographerId } }, data: { slug: 'theirs-only' } });

    await expect(findPublicService(prisma, photographerId, 'theirs-only')).resolves.toBeNull();
  });
});

describe('findPublicPhotographer', () => {
  it('returns the public profile and the id, with the contact email and never the login', async () => {
    await prisma.photographer.update({
      where: { id: photographerId },
      data: {
        bio: 'Portraits in natural light.',
        contactPhone: '+250788000001',
        whatsappPhone: '+250788000002',
        contactEmail: 'hello@kigalilens.example',
        coverImageUrl: 'https://images.example.com/kigali.jpg',
        suspensionReason: null,
      },
    });

    const found = await findPublicPhotographer(prisma, PHOTOGRAPHER_HANDLE);

    expect(found).toStrictEqual({
      id: photographerId,
      profile: {
        handle: PHOTOGRAPHER_HANDLE,
        displayName: 'Kigali Lens',
        bio: 'Portraits in natural light.',
        contactPhone: '+250788000001',
        whatsappPhone: '+250788000002',
        email: 'hello@kigalilens.example',
        coverImageUrl: 'https://images.example.com/kigali.jpg',
        takingBookings: true,
        cancellationPolicy: { cutoffHours: 0, bookingFeeRefundable: false },
      },
    });
    const json = JSON.stringify(found?.profile);
    for (const hidden of [PHOTOGRAPHER_EMAIL, 'approved', 'status', 'userId', 'bookingFeeRate', 'createdAt']) {
      expect(json).not.toContain(hidden);
    }
  });

  it('carries the photographer’s current cancellation policy, and none of their other settings', async () => {
    await updatePhotographerSettings(photographerId, { clientCancelCutoffHours: 48, bookingFeeRefundableOnClientCancel: true, bufferMinutes: 45 }, prisma);

    const found = await findPublicPhotographer(prisma, PHOTOGRAPHER_HANDLE);

    expect(found?.profile.cancellationPolicy).toStrictEqual({ cutoffHours: 48, bookingFeeRefundable: true });
    const json = JSON.stringify(found?.profile);
    for (const hidden of ['bufferMinutes', 'minLeadTimeMinutes', 'deliveryExpiryDays', 'clientCancelCutoffHours']) {
      expect(json).not.toContain(hidden);
    }
  });

  it('shows no email at all when the photographer has no contact email, rather than their login', async () => {
    const found = await findPublicPhotographer(prisma, PHOTOGRAPHER_HANDLE);

    expect(found?.profile.email).toBeNull();
    expect(JSON.stringify(found)).not.toContain(PHOTOGRAPHER_EMAIL);
  });

  it('is null for an unknown handle, a pending or suspended photographer, and a malformed handle', async () => {
    await otherPhotographer({ handle: 'pending-one', status: 'pending' });
    await otherPhotographer({ handle: 'suspended-one', status: 'suspended' });

    for (const handle of ['nobody-here', 'pending-one', 'suspended-one', 'Kigali-Lens', 'kigali%', '', 'x'.repeat(31)]) {
      await expect(findPublicPhotographer(prisma, handle)).resolves.toBeNull();
    }
  });

  it('becomes null when the photographer is suspended, and returns when they are approved again', async () => {
    await prisma.photographer.update({ where: { id: photographerId }, data: { status: 'suspended', suspendedAt: new Date('2026-10-01T06:00:00Z') } });
    await expect(findPublicPhotographer(prisma, PHOTOGRAPHER_HANDLE)).resolves.toBeNull();

    await prisma.photographer.update({ where: { id: photographerId }, data: { status: 'approved', suspendedAt: null } });
    expect((await findPublicPhotographer(prisma, PHOTOGRAPHER_HANDLE))?.id).toBe(photographerId);
  });
});
