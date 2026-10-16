import type { Prisma, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { updateSettings } from '../settings/index.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type BasketResult, type PricedBasket, priceBasket } from './basket.js';
import { findPublicService } from './public.js';

/**
 * `priceBasket()` against real PostgreSQL (plan.md Task 11; data-model_v2.md
 * §6.2, §9.5). The API is authoritative for money: a basket names rows by id
 * and every amount is read off those rows as they stand now.
 *
 * Only what the public can see is priced -- an active package on an active
 * service, and active add-ons that service offers (its own or the shared ones).
 * Anything else is refused by field. The add-ons come back as the service page
 * lists them: the service's own, then the shared ones, each in display order.
 */

let prisma: PrismaClient;
let raw: pg.Client;

const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
});

afterAll(async () => {
  // settings.test.ts seeds without truncating and asserts the defaults; an
  // edited row left here would fail it.
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  // getSettings() throws on a missing row (data-model_v2.md §5.2).
  await prisma.setting.create({ data: { id: 1, bookingFeeRate: '0.400' } });
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

/** The quote of a result that must have priced, with a readable failure if not. */
function quoted(result: BasketResult): PricedBasket {
  if (!result.ok) throw new Error(`Expected a quote, got a refusal of ${result.fields.join(', ')}`);
  return result.quote;
}

function amounts(quote: PricedBasket) {
  return { totalRwf: quote.totalRwf, bookingFeeRwf: quote.bookingFeeRwf, sessionFeeRwf: quote.sessionFeeRwf };
}

// --- plan.md Task 11 ------------------------------------------------------------------

describe('priceBasket', () => {
  it('prices a 40,000 package plus a 10,000 add-on at 40%: 50,000 total, 20,000 now, 30,000 after', async () => {
    const portraits = await insertService('portraits', { nameEn: 'Portraits' });
    const standard = await insertPackage(portraits.id, 'Standard', { priceRwf: 40_000 });
    const extraHour = await insertAddon(portraits.id, 'Extra hour', { priceRwf: 10_000 });

    const result = await priceBasket(prisma, { packageId: standard.id, addonIds: [extraHour.id] });

    expect(result).toStrictEqual({
      ok: true,
      quote: {
        service: { id: portraits.id, slug: 'portraits', nameEn: 'Portraits' },
        package: { id: standard.id, nameEn: 'Standard', priceRwf: 40_000 },
        addons: [{ id: extraHour.id, nameEn: 'Extra hour', priceRwf: 10_000 }],
        bookingFeeRate: 0.4,
        totalRwf: 50_000,
        bookingFeeRwf: 20_000,
        sessionFeeRwf: 30_000,
      },
    });
  });

  it('charges the same basket on a service overriding the rate to 0.300: 15,000 now, 35,000 after', async () => {
    const weddings = await insertService('weddings', { bookingFeeRateOverride: '0.300' });
    const standard = await insertPackage(weddings.id, 'Standard', { priceRwf: 40_000 });
    const extraHour = await insertAddon(weddings.id, 'Extra hour', { priceRwf: 10_000 });

    const quote = quoted(await priceBasket(prisma, { packageId: standard.id, addonIds: [extraHour.id] }));

    expect(quote.bookingFeeRate).toBe(0.3);
    expect(amounts(quote)).toEqual({ totalRwf: 50_000, bookingFeeRwf: 15_000, sessionFeeRwf: 35_000 });
  });

  it('prices a package with no add-ons', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, 'Standard', { priceRwf: 45_000 });

    const quote = quoted(await priceBasket(prisma, { packageId: pkg.id, addonIds: [] }));

    expect(quote.addons).toEqual([]);
    expect(amounts(quote)).toEqual({ totalRwf: 45_000, bookingFeeRwf: 18_000, sessionFeeRwf: 27_000 });
  });

  it('rounds the booking fee half-up in exact arithmetic: 5,500 at 17.5% is 963, not float 962', async () => {
    const service = await insertService('portraits', { bookingFeeRateOverride: '0.175' });
    const pkg = await insertPackage(service.id, 'Mini', { priceRwf: 5_000 });
    const addon = await insertAddon(null, 'Print', { priceRwf: 500 });

    const quote = quoted(await priceBasket(prisma, { packageId: pkg.id, addonIds: [addon.id] }));

    expect(amounts(quote)).toEqual({ totalRwf: 5_500, bookingFeeRwf: 963, sessionFeeRwf: 4_537 });
  });

  it('accepts a shared add-on, offered on every service', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, 'Standard');
    const rush = await insertAddon(null, 'Rush edit', { priceRwf: 5_000 });

    const quote = quoted(await priceBasket(prisma, { packageId: pkg.id, addonIds: [rush.id] }));

    expect(quote.addons).toEqual([{ id: rush.id, nameEn: 'Rush edit', priceRwf: 5_000 }]);
    expect(quote.totalRwf).toBe(45_000);
  });
});

// --- Refusals -------------------------------------------------------------------------

describe('priceBasket refuses what the public cannot see', () => {
  it('refuses an add-on that belongs to another service', async () => {
    const portraits = await insertService('portraits');
    const weddings = await insertService('weddings');
    const pkg = await insertPackage(portraits.id, 'Standard');
    const own = await insertAddon(portraits.id, 'Extra hour');
    const foreign = await insertAddon(weddings.id, 'Second shooter');

    await expect(priceBasket(prisma, { packageId: pkg.id, addonIds: [foreign.id] })).resolves.toStrictEqual({
      ok: false,
      fields: ['addonIds'],
    });
    // Alongside a valid add-on, too: one bad id fails the whole basket.
    await expect(priceBasket(prisma, { packageId: pkg.id, addonIds: [own.id, foreign.id] })).resolves.toStrictEqual({
      ok: false,
      fields: ['addonIds'],
    });
  });

  it('refuses an inactive add-on, whether the service’s own or shared', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, 'Standard');
    const retiredOwn = await insertAddon(service.id, 'Old frame', { isActive: false });
    const retiredShared = await insertAddon(null, 'Discontinued prints', { isActive: false });

    for (const addonIds of [[retiredOwn.id], [retiredShared.id]]) {
      await expect(priceBasket(prisma, { packageId: pkg.id, addonIds })).resolves.toStrictEqual({
        ok: false,
        fields: ['addonIds'],
      });
    }
  });

  it('refuses an add-on id that names no row', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, 'Standard');
    const addon = await insertAddon(service.id, 'Extra hour');

    await expect(priceBasket(prisma, { packageId: pkg.id, addonIds: [NONEXISTENT_ID] })).resolves.toStrictEqual({
      ok: false,
      fields: ['addonIds'],
    });
    await expect(priceBasket(prisma, { packageId: pkg.id, addonIds: [addon.id, NONEXISTENT_ID] })).resolves.toStrictEqual({
      ok: false,
      fields: ['addonIds'],
    });
  });

  it('refuses an id naming a package or service where an add-on is expected', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, 'Standard');

    for (const addonIds of [[pkg.id], [service.id]]) {
      await expect(priceBasket(prisma, { packageId: pkg.id, addonIds })).resolves.toStrictEqual({
        ok: false,
        fields: ['addonIds'],
      });
    }
  });

  it('refuses an inactive package', async () => {
    const service = await insertService('portraits');
    const retired = await insertPackage(service.id, 'Retired', { isActive: false });

    await expect(priceBasket(prisma, { packageId: retired.id, addonIds: [] })).resolves.toStrictEqual({
      ok: false,
      fields: ['packageId'],
    });
  });

  it('refuses an active package on a deactivated service, with its active add-ons', async () => {
    const service = await insertService('events', { isActive: false });
    const pkg = await insertPackage(service.id, 'Half day');
    const addon = await insertAddon(service.id, 'Drone');

    await expect(priceBasket(prisma, { packageId: pkg.id, addonIds: [addon.id] })).resolves.toStrictEqual({
      ok: false,
      fields: ['packageId'],
    });
  });

  it('refuses a package id that names no row, or names an add-on or a service', async () => {
    const service = await insertService('portraits');
    const addon = await insertAddon(service.id, 'Extra hour');

    for (const packageId of [NONEXISTENT_ID, addon.id, service.id]) {
      await expect(priceBasket(prisma, { packageId, addonIds: [] })).resolves.toStrictEqual({
        ok: false,
        fields: ['packageId'],
      });
    }
  });

  it('names the package, not the add-ons, when both are wrong', async () => {
    await expect(priceBasket(prisma, { packageId: NONEXISTENT_ID, addonIds: [NONEXISTENT_ID] })).resolves.toStrictEqual({
      ok: false,
      fields: ['packageId'],
    });
  });

  it('refuses a package the moment it or its service is deactivated', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, 'Standard');
    expect((await priceBasket(prisma, { packageId: pkg.id, addonIds: [] })).ok).toBe(true);

    await prisma.service.update({ where: { id: service.id }, data: { isActive: false } });
    expect(await priceBasket(prisma, { packageId: pkg.id, addonIds: [] })).toStrictEqual({ ok: false, fields: ['packageId'] });

    await prisma.service.update({ where: { id: service.id }, data: { isActive: true } });
    await prisma.package.update({ where: { id: pkg.id }, data: { isActive: false } });
    expect(await priceBasket(prisma, { packageId: pkg.id, addonIds: [] })).toStrictEqual({ ok: false, fields: ['packageId'] });
  });
});

// --- Ordering -------------------------------------------------------------------------

describe('the quote’s add-ons', () => {
  it('come back in catalogue order, whatever order they were selected in', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, 'Standard');
    const album = await insertAddon(service.id, 'Album', { sortOrder: 0 });
    const secondShooter = await insertAddon(service.id, 'Second shooter', { sortOrder: 1 });
    const extraHour = await insertAddon(service.id, 'Extra hour', { sortOrder: 1 });
    const prints = await insertAddon(null, 'Prints', { sortOrder: 0 });
    const rush = await insertAddon(null, 'Rush edit', { sortOrder: 2 });

    const ids = [rush.id, secondShooter.id, prints.id, album.id, extraHour.id];
    for (const addonIds of [ids, [...ids].reverse()]) {
      const quote = quoted(await priceBasket(prisma, { packageId: pkg.id, addonIds }));
      expect(quote.addons.map((addon) => addon.nameEn)).toEqual(['Album', 'Extra hour', 'Second shooter', 'Prints', 'Rush edit']);
    }
  });

  it('list the service’s own before the shared ones: own sortOrder 5 comes before shared sortOrder 0', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, 'Standard');
    const own = await insertAddon(service.id, 'Zoom lens', { sortOrder: 5 });
    const shared = await insertAddon(null, 'Album', { sortOrder: 0 });

    const quote = quoted(await priceBasket(prisma, { packageId: pkg.id, addonIds: [shared.id, own.id] }));

    expect(quote.addons.map((addon) => addon.id)).toEqual([own.id, shared.id]);
  });

  it('are in the order the service page lists the same ids', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, 'Standard');
    const created = [
      await insertAddon(null, 'Prints', { sortOrder: 0 }),
      await insertAddon(service.id, 'Zoom lens', { sortOrder: 9 }),
      await insertAddon(null, 'Rush edit', { sortOrder: 3 }),
      await insertAddon(service.id, 'Album', { sortOrder: 9 }),
      await insertAddon(service.id, 'Drone', { sortOrder: 1 }),
      await insertAddon(null, 'Canvas', { sortOrder: 3 }),
    ];
    const chosen = [created[5], created[0], created[1], created[4]].map((addon) => addon?.id ?? '');

    const quote = quoted(await priceBasket(prisma, { packageId: pkg.id, addonIds: chosen }));
    const detail = await findPublicService(prisma, 'portraits');

    const pageOrder = (detail?.addons ?? []).map((addon) => addon.id).filter((id) => chosen.includes(id));
    expect(quote.addons.map((addon) => addon.id)).toEqual(pageOrder);
    expect(quote.addons.map((addon) => addon.nameEn)).toEqual(['Drone', 'Zoom lens', 'Prints', 'Canvas']);
    // The quote's add-on entries are the page's entries, field for field.
    expect(quote.addons).toEqual((detail?.addons ?? []).filter((addon) => chosen.includes(addon.id)));
  });
});

// --- Live catalogue -----------------------------------------------------------------------

describe('the quote reflects the catalogue as it stands', () => {
  it('re-prices after a package or add-on price is edited', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, 'Standard', { priceRwf: 40_000 });
    const addon = await insertAddon(service.id, 'Extra hour', { priceRwf: 10_000 });
    const basket = { packageId: pkg.id, addonIds: [addon.id] };
    expect(amounts(quoted(await priceBasket(prisma, basket)))).toEqual({ totalRwf: 50_000, bookingFeeRwf: 20_000, sessionFeeRwf: 30_000 });

    await prisma.package.update({ where: { id: pkg.id }, data: { priceRwf: 60_000 } });
    await prisma.addon.update({ where: { id: addon.id }, data: { priceRwf: 15_000, nameEn: 'Extra 90 minutes' } });

    const quote = quoted(await priceBasket(prisma, basket));
    expect(quote.package.priceRwf).toBe(60_000);
    expect(quote.addons).toEqual([{ id: addon.id, nameEn: 'Extra 90 minutes', priceRwf: 15_000 }]);
    expect(amounts(quote)).toEqual({ totalRwf: 75_000, bookingFeeRwf: 30_000, sessionFeeRwf: 45_000 });
  });

  it('re-prices after the global rate changes, and after an override is set or cleared', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, 'Standard', { priceRwf: 50_000 });
    const basket = { packageId: pkg.id, addonIds: [] };

    await updateSettings({ bookingFeeRate: 0.25 }, prisma);
    let quote = quoted(await priceBasket(prisma, basket));
    expect([quote.bookingFeeRate, quote.bookingFeeRwf]).toEqual([0.25, 12_500]);

    await prisma.service.update({ where: { id: service.id }, data: { bookingFeeRateOverride: '0.300' } });
    quote = quoted(await priceBasket(prisma, basket));
    expect([quote.bookingFeeRate, quote.bookingFeeRwf]).toEqual([0.3, 15_000]);

    await prisma.service.update({ where: { id: service.id }, data: { bookingFeeRateOverride: null } });
    quote = quoted(await priceBasket(prisma, basket));
    expect([quote.bookingFeeRate, quote.bookingFeeRwf]).toEqual([0.25, 12_500]);
  });

  it('uses an override of 0.000 as a 0% booking fee, not the global rate', async () => {
    const service = await insertService('portraits', { bookingFeeRateOverride: '0.000' });
    const pkg = await insertPackage(service.id, 'Standard', { priceRwf: 50_000 });

    const quote = quoted(await priceBasket(prisma, { packageId: pkg.id, addonIds: [] }));

    expect(quote.bookingFeeRate).toBe(0);
    expect(amounts(quote)).toEqual({ totalRwf: 50_000, bookingFeeRwf: 0, sessionFeeRwf: 50_000 });
  });

  it('refuses an add-on once it is deactivated', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, 'Standard');
    const addon = await insertAddon(null, 'Rush edit');
    expect((await priceBasket(prisma, { packageId: pkg.id, addonIds: [addon.id] })).ok).toBe(true);

    await prisma.addon.update({ where: { id: addon.id }, data: { isActive: false } });

    expect(await priceBasket(prisma, { packageId: pkg.id, addonIds: [addon.id] })).toStrictEqual({
      ok: false,
      fields: ['addonIds'],
    });
  });
});
