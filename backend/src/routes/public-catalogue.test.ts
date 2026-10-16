import { randomUUID } from 'node:crypto';
import type { Addon, Package, Prisma, PrismaClient, Service } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { listPublicCatalogue } from '../catalogue/public.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';

/**
 * The public catalogue over HTTP, against real PostgreSQL (plan.md Task 11;
 * spec §3.1 steps 1-3 and 7, §6.14, P-01).
 *
 * Anonymous by design: no route here reads a credential, and a bogus one
 * changes nothing. The quote is the API's authority over money -- a body
 * carrying its own totals, rate or prices is priced from the catalogue as if
 * those keys were never sent, and none of them is echoed back.
 *
 * Validation follows the one rule (routes/validation.ts): a malformed body is a
 * 400, a well-formed one breaking a rule is a 422 naming the field. A package or
 * add-on the public cannot see is a 422 too, never a price.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;

const WEB_ORIGIN = 'https://bookly.example';
const SECRET = 'public-catalogue-test-secret-at-least-32-characters';
const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';
const MALFORMED_IDS = [
  'not-a-uuid',
  '12345',
  '',
  '00000000-0000-4000-8000-00000000000g',
  '00000000000040008000000000000000',
  '{00000000-0000-4000-8000-000000000000}',
];
const QUOTE = '/api/quote';
const SERVICES = '/api/services';

/** Column names and keys the public must never receive (spec A-4b; plan.md Task 10). */
const HIDDEN_KEYS = [
  'bookingFeeRateOverride',
  'booking_fee_rate_override',
  'isActive',
  'is_active',
  'sortOrder',
  'sort_order',
  'serviceId',
  'service_id',
  'createdAt',
  'updatedAt',
  'nameFr',
  'descriptionFr',
];

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
});

afterAll(async () => {
  // settings.test.ts seeds without truncating and asserts the defaults.
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  // getSettings() throws on a missing row (data-model_v2.md §5.2).
  await prisma.setting.create({ data: { id: 1, bookingFeeRate: '0.400' } });
  app = createApp({ corsOrigin: WEB_ORIGIN, publicApi: { prisma } });
});

// --- Fixtures ---------------------------------------------------------------

type Catalogue = {
  portraits: Service;
  weddings: Service;
  events: Service;
  standard: Package;
  retired: Package;
  fullDay: Package;
  halfDay: Package;
  extraHour: Addon;
  oldFrame: Addon;
  secondShooter: Addon;
  drone: Addon;
  rushEdit: Addon;
  discontinued: Addon;
};

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

/**
 * Portraits at the global 40%, Weddings overriding to 30%, and a deactivated
 * Events service, each with active and inactive rows, plus shared add-ons.
 * French text and sort keys are set so a leak would be visible.
 */
async function seedCatalogue(): Promise<Catalogue> {
  const portraits = await insertService('portraits', {
    nameEn: 'Portraits',
    nameFr: 'Portraits FR',
    descriptionEn: 'Studio portraits.',
    descriptionFr: 'Portraits en studio.',
    coverImageUrl: 'https://images.example.com/portraits.jpg',
  });
  const weddings = await insertService('weddings', { nameEn: 'Weddings', bookingFeeRateOverride: '0.300', sortOrder: 1 });
  const events = await insertService('events', { nameEn: 'Events', isActive: false, sortOrder: 2 });
  return {
    portraits,
    weddings,
    events,
    standard: await insertPackage(portraits.id, 'Standard', { descriptionEn: 'One look.', durationMinutes: 90, nameFr: 'Standard FR' }),
    retired: await insertPackage(portraits.id, 'Retired', { isActive: false, priceRwf: 1 }),
    fullDay: await insertPackage(weddings.id, 'Full day'),
    halfDay: await insertPackage(events.id, 'Half day'),
    extraHour: await insertAddon(portraits.id, 'Extra hour', { nameFr: 'Heure en plus' }),
    oldFrame: await insertAddon(portraits.id, 'Old frame', { isActive: false }),
    secondShooter: await insertAddon(weddings.id, 'Second shooter'),
    drone: await insertAddon(events.id, 'Drone'),
    rushEdit: await insertAddon(null, 'Rush edit', { priceRwf: 5_000, sortOrder: 3 }),
    discontinued: await insertAddon(null, 'Discontinued prints', { isActive: false }),
  };
}

function quote(body: unknown): request.Test {
  return request(app).post(QUOTE).send(body as object);
}

/** A body sent as literal text under a given content type. */
function quoteText(text: string, contentType = 'application/json'): request.Test {
  return request(app).post(QUOTE).set('Content-Type', contentType).send(text);
}

function bodyOf<T>(res: Response, status: number): T {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
}

function expectInvalid(res: Response): void {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body).toStrictEqual({ error: 'invalid_request' });
}

function expectRefused(res: Response, fields: string[]): void {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body).toStrictEqual({ error: 'validation_failed', fields });
}

// --- GET /api/services --------------------------------------------------------------------

describe('GET /api/services', () => {
  it('lists active services with their active packages, own add-ons and then shared add-ons', async () => {
    const c = await seedCatalogue();

    const body = bodyOf<unknown>(await request(app).get(SERVICES), 200);

    expect(body).toStrictEqual({
      services: [
        {
          id: c.portraits.id,
          slug: 'portraits',
          nameEn: 'Portraits',
          descriptionEn: 'Studio portraits.',
          coverImageUrl: 'https://images.example.com/portraits.jpg',
          packages: [
            { id: c.standard.id, nameEn: 'Standard', descriptionEn: 'One look.', priceRwf: 40_000, photoCount: 20, durationMinutes: 90 },
          ],
          addons: [
            { id: c.extraHour.id, nameEn: 'Extra hour', priceRwf: 10_000 },
            { id: c.rushEdit.id, nameEn: 'Rush edit', priceRwf: 5_000 },
          ],
        },
        {
          id: c.weddings.id,
          slug: 'weddings',
          nameEn: 'Weddings',
          descriptionEn: null,
          coverImageUrl: null,
          packages: [
            { id: c.fullDay.id, nameEn: 'Full day', descriptionEn: null, priceRwf: 40_000, photoCount: 20, durationMinutes: 60 },
          ],
          addons: [
            { id: c.secondShooter.id, nameEn: 'Second shooter', priceRwf: 10_000 },
            { id: c.rushEdit.id, nameEn: 'Rush edit', priceRwf: 5_000 },
          ],
        },
      ],
    });
  });

  it('serves listPublicCatalogue(), unchanged', async () => {
    await seedCatalogue();

    const body = bodyOf<unknown>(await request(app).get(SERVICES), 200);

    expect(body).toStrictEqual({ services: JSON.parse(JSON.stringify(await listPublicCatalogue(prisma))) });
  });

  it('lists nothing for an empty catalogue', async () => {
    expect(bodyOf<unknown>(await request(app).get(SERVICES), 200)).toStrictEqual({ services: [] });
  });

  it('drops a service the moment it is deactivated', async () => {
    const c = await seedCatalogue();
    await prisma.service.update({ where: { id: c.portraits.id }, data: { isActive: false } });

    const body = bodyOf<{ services: { slug: string }[] }>(await request(app).get(SERVICES), 200);

    expect(body.services.map((service) => service.slug)).toEqual(['weddings']);
  });
});

// --- GET /api/services/:slug --------------------------------------------------------------

describe('GET /api/services/:slug', () => {
  it('returns one active service with its active rows and the global rate', async () => {
    const c = await seedCatalogue();

    const body = bodyOf<unknown>(await request(app).get(`${SERVICES}/portraits`), 200);

    expect(body).toStrictEqual({
      service: {
        id: c.portraits.id,
        slug: 'portraits',
        nameEn: 'Portraits',
        descriptionEn: 'Studio portraits.',
        coverImageUrl: 'https://images.example.com/portraits.jpg',
        packages: [
          { id: c.standard.id, nameEn: 'Standard', descriptionEn: 'One look.', priceRwf: 40_000, photoCount: 20, durationMinutes: 90 },
        ],
        addons: [
          { id: c.extraHour.id, nameEn: 'Extra hour', priceRwf: 10_000 },
          { id: c.rushEdit.id, nameEn: 'Rush edit', priceRwf: 5_000 },
        ],
        bookingFeeRate: 0.4,
      },
    });
  });

  it('carries the service’s own rate where it overrides the global one: 0.300 is 0.3', async () => {
    await seedCatalogue();

    const body = bodyOf<{ service: { bookingFeeRate: unknown } }>(await request(app).get(`${SERVICES}/weddings`), 200);

    expect(body.service.bookingFeeRate).toBe(0.3);
  });

  it('404s an unknown slug', async () => {
    await seedCatalogue();

    for (const slug of ['nothing-here', 'Portraits', 'portrait', 'portraits-2', '%20portraits']) {
      const res = await request(app).get(`${SERVICES}/${slug}`);
      expect(res.status, slug).toBe(404);
      expect(res.body).toStrictEqual({ error: 'not_found' });
    }
  });

  it('404s a deactivated service exactly as it 404s an unknown one (spec §6.14)', async () => {
    await seedCatalogue();

    const deactivated = await request(app).get(`${SERVICES}/events`);
    const unknown = await request(app).get(`${SERVICES}/nothing-here`);

    expect(deactivated.status).toBe(404);
    expect(deactivated.body).toStrictEqual({ error: 'not_found' });
    expect(deactivated.body).toStrictEqual(unknown.body);
  });

  it('404s a service that was active a moment ago', async () => {
    const c = await seedCatalogue();
    expect((await request(app).get(`${SERVICES}/portraits`)).status).toBe(200);

    await prisma.service.update({ where: { id: c.portraits.id }, data: { isActive: false } });

    const res = await request(app).get(`${SERVICES}/portraits`);
    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'not_found' });
  });

  it('answers a slug with broken percent-encoding as a client error, not a 500', async () => {
    await seedCatalogue();

    // Anyone can send these; the router fails to decode them. That is the
    // visitor's malformed URL -- a 400 or a 404 -- never an internal error.
    for (const path of [`${SERVICES}/%E0%A4%A`, `${SERVICES}/%`, `${SERVICES}/portraits%`]) {
      const res = await request(app).get(path);
      expect([400, 404], `${path} answered ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
    }
  });

  it('serves nothing below a service', async () => {
    await seedCatalogue();

    const res = await request(app).get(`${SERVICES}/portraits/packages`);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'not_found' });
  });
});

// --- POST /api/quote: pricing ---------------------------------------------------------------

describe('POST /api/quote', () => {
  it('prices a 40,000 package plus a 10,000 add-on at 40%: 50,000 total, 20,000 now, 30,000 after', async () => {
    const c = await seedCatalogue();

    const body = bodyOf<unknown>(await quote({ packageId: c.standard.id, addonIds: [c.extraHour.id] }), 200);

    expect(body).toStrictEqual({
      quote: {
        service: { id: c.portraits.id, slug: 'portraits', nameEn: 'Portraits' },
        package: { id: c.standard.id, nameEn: 'Standard', priceRwf: 40_000 },
        addons: [{ id: c.extraHour.id, nameEn: 'Extra hour', priceRwf: 10_000 }],
        bookingFeeRate: 0.4,
        totalRwf: 50_000,
        bookingFeeRwf: 20_000,
        sessionFeeRwf: 30_000,
      },
    });
  });

  it('charges 15,000 now on the same 50,000 basket where the service overrides the rate to 0.300', async () => {
    const c = await seedCatalogue();

    const body = bodyOf<{ quote: Record<string, unknown> }>(
      await quote({ packageId: c.fullDay.id, addonIds: [c.secondShooter.id] }),
      200,
    );

    expect(body.quote).toMatchObject({ bookingFeeRate: 0.3, totalRwf: 50_000, bookingFeeRwf: 15_000, sessionFeeRwf: 35_000 });
  });

  it('prices a package alone, with addonIds empty or left out', async () => {
    const c = await seedCatalogue();

    for (const body of [{ packageId: c.standard.id }, { packageId: c.standard.id, addonIds: [] }]) {
      const res = bodyOf<{ quote: Record<string, unknown> }>(await quote(body), 200);
      expect(res.quote).toMatchObject({ addons: [], totalRwf: 40_000, bookingFeeRwf: 16_000, sessionFeeRwf: 24_000 });
    }
  });

  it('accepts a shared add-on on any active service, listed after the service’s own', async () => {
    const c = await seedCatalogue();

    const body = bodyOf<{ quote: { addons: { id: string }[]; totalRwf: number } }>(
      await quote({ packageId: c.fullDay.id, addonIds: [c.rushEdit.id, c.secondShooter.id] }),
      200,
    );

    expect(body.quote.addons.map((addon) => addon.id)).toEqual([c.secondShooter.id, c.rushEdit.id]);
    expect(body.quote.totalRwf).toBe(55_000);
  });

  it('prices the catalogue as it stands: an edited price is the new price on the next quote', async () => {
    const c = await seedCatalogue();
    const basket = { packageId: c.standard.id, addonIds: [c.extraHour.id] };
    expect(bodyOf<{ quote: { totalRwf: number } }>(await quote(basket), 200).quote.totalRwf).toBe(50_000);

    await prisma.package.update({ where: { id: c.standard.id }, data: { priceRwf: 55_000 } });

    const body = bodyOf<{ quote: Record<string, unknown> }>(await quote(basket), 200);
    expect(body.quote).toMatchObject({ totalRwf: 65_000, bookingFeeRwf: 26_000, sessionFeeRwf: 39_000 });
  });

  it('accepts 50 add-ons, the ceiling', async () => {
    const c = await seedCatalogue();
    await prisma.addon.createMany({
      data: Array.from({ length: 50 }, (_, index) => ({ serviceId: null, nameEn: `Print ${index}`, priceRwf: 1_000, sortOrder: 10 })),
    });
    const prints = await prisma.addon.findMany({ where: { nameEn: { startsWith: 'Print ' } } });
    expect(prints).toHaveLength(50);

    const body = bodyOf<{ quote: { addons: unknown[]; totalRwf: number } }>(
      await quote({ packageId: c.standard.id, addonIds: prints.map((addon) => addon.id) }),
      200,
    );

    expect(body.quote.addons).toHaveLength(50);
    expect(body.quote.totalRwf).toBe(90_000);
  });
});

// --- The API is authoritative for money (plan.md Task 11) -------------------------------------

describe('a tampered quote request', () => {
  it('is priced from the catalogue, and none of the sent amounts is echoed', async () => {
    const c = await seedCatalogue();
    const basket = { packageId: c.standard.id, addonIds: [c.extraHour.id] };
    const honest = bodyOf<unknown>(await quote(basket), 200);

    const res = await quote({
      ...basket,
      totalRwf: 1,
      bookingFeeRwf: 0,
      sessionFeeRwf: 0,
      bookingFeeRate: 0,
      bookingFeeRateOverride: 0,
      priceRwf: 1,
      package: { id: c.standard.id, nameEn: 'Free', priceRwf: 1 },
      addons: [{ id: c.extraHour.id, nameEn: 'Free', priceRwf: 1 }],
      addonPricesRwf: [1],
      packagePriceRwf: 1,
      quote: { totalRwf: 1 },
    });

    const tampered = bodyOf<unknown>(res, 200);
    expect(tampered).toStrictEqual(honest);
    expect(tampered).toMatchObject({ quote: { bookingFeeRate: 0.4, totalRwf: 50_000, bookingFeeRwf: 20_000, sessionFeeRwf: 30_000 } });
    expect(res.text).not.toContain('Free');
    expect(res.text).not.toContain('addonPricesRwf');
    expect(res.text).not.toContain('packagePriceRwf');
    expect(res.text).not.toContain('bookingFeeRateOverride');
  });

  it('sent as strings or as the wrong types is still priced from the catalogue', async () => {
    const c = await seedCatalogue();

    const body = bodyOf<{ quote: Record<string, unknown> }>(
      await quote({ packageId: c.fullDay.id, totalRwf: '1', bookingFeeRwf: null, bookingFeeRate: 'zero', sessionFeeRwf: -5 }),
      200,
    );

    expect(body.quote).toMatchObject({ bookingFeeRate: 0.3, totalRwf: 40_000, bookingFeeRwf: 12_000, sessionFeeRwf: 28_000 });
  });

  it('writes nothing: the catalogue and the settings are as they were', async () => {
    const c = await seedCatalogue();

    await quote({ packageId: c.standard.id, addonIds: [c.extraHour.id], totalRwf: 1, priceRwf: 1, bookingFeeRate: 0 });

    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: c.standard.id } });
    const addon = await prisma.addon.findUniqueOrThrow({ where: { id: c.extraHour.id } });
    const setting = await prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
    expect([pkg.priceRwf, addon.priceRwf, setting.bookingFeeRate.toFixed(3)]).toEqual([40_000, 10_000, '0.400']);
    expect(await prisma.booking.count()).toBe(0);
  });
});

// --- POST /api/quote: refusals -----------------------------------------------------------------

describe('POST /api/quote refuses a malformed body with 400', () => {
  it('when there is no body', async () => {
    await seedCatalogue();
    expectInvalid(await request(app).post(QUOTE));
  });

  it('when the JSON does not parse', async () => {
    await seedCatalogue();
    for (const text of ['{"packageId":', '{packageId: 1}', 'not json', '{"packageId": "a",}']) {
      expectInvalid(await quoteText(text));
    }
  });

  it('when the body is JSON but not an object', async () => {
    const c = await seedCatalogue();
    for (const text of ['[]', `["${c.standard.id}"]`, 'null', '"text"', '42', 'true']) {
      expectInvalid(await quoteText(text));
    }
  });

  it('when the body is not sent as JSON', async () => {
    const c = await seedCatalogue();
    expectInvalid(await quoteText(`packageId=${c.standard.id}`, 'application/x-www-form-urlencoded'));
    expectInvalid(await quoteText(JSON.stringify({ packageId: c.standard.id }), 'text/plain'));
  });

  it('when packageId is missing', async () => {
    const c = await seedCatalogue();
    expectInvalid(await quote({}));
    expectInvalid(await quote({ addonIds: [c.extraHour.id] }));
  });

  it('when packageId is not a uuid', async () => {
    await seedCatalogue();
    for (const packageId of [...MALFORMED_IDS, 42, null, true, {}, []]) {
      expectInvalid(await quote({ packageId }));
    }
  });

  it('when addonIds is not an array', async () => {
    const c = await seedCatalogue();
    for (const addonIds of [c.extraHour.id, null, 1, {}, { 0: c.extraHour.id }, true]) {
      expectInvalid(await quote({ packageId: c.standard.id, addonIds }));
    }
  });

  it('when an add-on id is not a uuid', async () => {
    const c = await seedCatalogue();
    for (const bad of [...MALFORMED_IDS, 42, null]) {
      expectInvalid(await quote({ packageId: c.standard.id, addonIds: [c.extraHour.id, bad] }));
    }
  });
});

describe('POST /api/quote refuses a well-formed basket it cannot price with 422', () => {
  it('names packageId for an unknown package', async () => {
    await seedCatalogue();
    expectRefused(await quote({ packageId: NONEXISTENT_ID }), ['packageId']);
    expectRefused(await quote({ packageId: randomUUID() }), ['packageId']);
  });

  it('names packageId for an inactive package', async () => {
    const c = await seedCatalogue();
    expectRefused(await quote({ packageId: c.retired.id }), ['packageId']);
  });

  it('names packageId for an active package on a deactivated service', async () => {
    const c = await seedCatalogue();
    expectRefused(await quote({ packageId: c.halfDay.id, addonIds: [c.drone.id] }), ['packageId']);
  });

  it('names packageId for the id of an add-on or a service', async () => {
    const c = await seedCatalogue();
    expectRefused(await quote({ packageId: c.extraHour.id }), ['packageId']);
    expectRefused(await quote({ packageId: c.portraits.id }), ['packageId']);
  });

  it('names addonIds for an add-on the package’s service does not offer', async () => {
    const c = await seedCatalogue();
    expectRefused(await quote({ packageId: c.standard.id, addonIds: [c.secondShooter.id] }), ['addonIds']);
    expectRefused(await quote({ packageId: c.fullDay.id, addonIds: [c.secondShooter.id, c.extraHour.id] }), ['addonIds']);
    // The deactivated service's add-on is not offered anywhere.
    expectRefused(await quote({ packageId: c.standard.id, addonIds: [c.drone.id] }), ['addonIds']);
  });

  it('names addonIds for an inactive add-on, own or shared', async () => {
    const c = await seedCatalogue();
    expectRefused(await quote({ packageId: c.standard.id, addonIds: [c.oldFrame.id] }), ['addonIds']);
    expectRefused(await quote({ packageId: c.standard.id, addonIds: [c.extraHour.id, c.discontinued.id] }), ['addonIds']);
  });

  it('names addonIds for an unknown add-on', async () => {
    const c = await seedCatalogue();
    expectRefused(await quote({ packageId: c.standard.id, addonIds: [NONEXISTENT_ID] }), ['addonIds']);
    expectRefused(await quote({ packageId: c.standard.id, addonIds: [c.extraHour.id, randomUUID()] }), ['addonIds']);
  });

  it('names addonIds when the same add-on is sent twice', async () => {
    const c = await seedCatalogue();
    expectRefused(await quote({ packageId: c.standard.id, addonIds: [c.extraHour.id, c.extraHour.id] }), ['addonIds']);
    expectRefused(await quote({ packageId: c.standard.id, addonIds: [c.extraHour.id, c.rushEdit.id, c.extraHour.id] }), ['addonIds']);
  });

  it('names addonIds when the same add-on is sent twice in different letter case, rather than charging it once', async () => {
    const c = await seedCatalogue();
    expectRefused(
      await quote({ packageId: c.standard.id, addonIds: [c.extraHour.id, c.extraHour.id.toUpperCase()] }),
      ['addonIds'],
    );
  });

  it('prices an add-on sent once in upper case -- lowercasing for the repeat check changes no lookup', async () => {
    const c = await seedCatalogue();

    const body = bodyOf<{ quote: { addons: { id: string }[] } }>(
      await quote({ packageId: c.standard.id.toUpperCase(), addonIds: [c.extraHour.id.toUpperCase()] }),
      200,
    );

    expect(body.quote).toMatchObject({ totalRwf: 50_000, bookingFeeRwf: 20_000, sessionFeeRwf: 30_000 });
    expect(body.quote.addons.map((addon) => addon.id)).toEqual([c.extraHour.id]);
  });

  it('names addonIds for 51 add-ons, one past the ceiling, before looking any of them up', async () => {
    const c = await seedCatalogue();
    const addonIds = Array.from({ length: 51 }, () => randomUUID());
    expectRefused(await quote({ packageId: c.standard.id, addonIds }), ['addonIds']);
  });
});

// --- Access (spec P-01) --------------------------------------------------------------------------

describe('anonymous access (spec P-01)', () => {
  it('serves every route with no Authorization header at all', async () => {
    const c = await seedCatalogue();

    expect((await request(app).get(SERVICES)).status).toBe(200);
    expect((await request(app).get(`${SERVICES}/portraits`)).status).toBe(200);
    expect((await quote({ packageId: c.standard.id })).status).toBe(200);
  });

  it('ignores an Authorization header, valid-looking or garbage: the answers are identical', async () => {
    const c = await seedCatalogue();
    const basket = { packageId: c.standard.id, addonIds: [c.extraHour.id] };

    for (const authorization of ['Bearer not-a-token', 'Bearer a.b.c', 'Basic dXNlcjpwYXNz', '']) {
      const list = await request(app).get(SERVICES).set('Authorization', authorization);
      const detail = await request(app).get(`${SERVICES}/portraits`).set('Authorization', authorization);
      const priced = await request(app).post(QUOTE).set('Authorization', authorization).send(basket);

      expect(list.status).toBe(200);
      expect(list.body).toStrictEqual(bodyOf(await request(app).get(SERVICES), 200));
      expect(detail.status).toBe(200);
      expect(detail.body).toStrictEqual(bodyOf(await request(app).get(`${SERVICES}/portraits`), 200));
      expect(priced.status).toBe(200);
      expect(priced.body).toStrictEqual(bodyOf(await quote(basket), 200));
      expect(priced.headers['www-authenticate']).toBeUndefined();
    }
  });

  it('sets no cookie', async () => {
    const c = await seedCatalogue();

    for (const res of [await request(app).get(SERVICES), await request(app).get(`${SERVICES}/portraits`), await quote({ packageId: c.standard.id })]) {
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('answers the web origin’s CORS preflight for the quote, and echoes the origin on the list', async () => {
    await seedCatalogue();

    const preflight = await request(app)
      .options(QUOTE)
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');

    const list = await request(app).get(SERVICES).set('Origin', WEB_ORIGIN);
    expect(list.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
  });
});

describe('mounting', () => {
  it('404s every public route when publicApi is omitted -- closed, not open', async () => {
    const c = await seedCatalogue();
    const closed = createApp({ corsOrigin: WEB_ORIGIN });

    for (const res of [
      await request(closed).get(SERVICES),
      await request(closed).get(`${SERVICES}/portraits`),
      await request(closed).post(QUOTE).send({ packageId: c.standard.id }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual({ error: 'not_found' });
    }
  });

  it('serves only the three routes it declares, with their own methods', async () => {
    const c = await seedCatalogue();

    for (const res of [
      await request(app).get(QUOTE),
      await request(app).post(SERVICES).send({ packageId: c.standard.id }),
      await request(app).delete(`${SERVICES}/portraits`),
      await request(app).patch(`${SERVICES}/portraits`).send({ nameEn: 'Hacked' }),
      await request(app).put(QUOTE).send({ packageId: c.standard.id }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual({ error: 'not_found' });
    }
    expect((await prisma.service.findUniqueOrThrow({ where: { id: c.portraits.id } })).nameEn).toBe('Portraits');
  });

  it('opens no /api/admin/* route: without the admin option they 404', async () => {
    await seedCatalogue();

    for (const res of [
      await request(app).get('/api/admin/catalogue'),
      await request(app).get('/api/admin/services'),
      await request(app).post('/api/admin/services').send({ slug: 'x', nameEn: 'X' }),
      await request(app).get('/api/admin/settings'),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual({ error: 'not_found' });
    }
    expect(await prisma.service.count()).toBe(3);
  });

  it('leaves /api/admin/* behind its bearer token when both routers are mounted', async () => {
    await seedCatalogue();
    const both = createApp({
      corsOrigin: WEB_ORIGIN,
      publicApi: { prisma },
      admin: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => new Date() },
    });

    const catalogue = await request(both).get('/api/admin/catalogue');
    expect(catalogue.status).toBe(401);
    expect(catalogue.body).toStrictEqual({ error: 'unauthenticated' });
    expect(catalogue.text).not.toContain('Portraits');

    expect((await request(both).get(SERVICES)).status).toBe(200);
  });
});

// --- What the public never receives ----------------------------------------------------------------

describe('every public response', () => {
  it('carries no processing-fee field and no raw internal column', async () => {
    const c = await seedCatalogue();

    const responses = [
      await request(app).get(SERVICES),
      await request(app).get(`${SERVICES}/portraits`),
      await request(app).get(`${SERVICES}/weddings`),
      await quote({ packageId: c.standard.id, addonIds: [c.extraHour.id, c.rushEdit.id] }),
      await quote({ packageId: c.fullDay.id, addonIds: [c.secondShooter.id] }),
    ];

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/processing/i);
      expect(res.text).not.toMatch(/gateway/i);
      for (const key of HIDDEN_KEYS) expect(res.text, key).not.toContain(key);
      for (const french of ['FR', 'en studio', 'Heure en plus']) expect(res.text, french).not.toContain(french);
      // Nor anything inactive.
      for (const inactive of ['Retired', 'Old frame', 'Discontinued prints', 'Events', 'Half day', 'Drone']) {
        expect(res.text, inactive).not.toContain(inactive);
      }
    }
  });

  it('projects the quote as an allowlist', async () => {
    const c = await seedCatalogue();

    const body = bodyOf<{ quote: Record<string, Record<string, unknown>> }>(
      await quote({ packageId: c.standard.id, addonIds: [c.extraHour.id] }),
      200,
    );

    expect(Object.keys(body)).toEqual(['quote']);
    expect(Object.keys(body.quote).sort()).toEqual([
      'addons',
      'bookingFeeRate',
      'bookingFeeRwf',
      'package',
      'service',
      'sessionFeeRwf',
      'totalRwf',
    ]);
    expect(Object.keys(body.quote.service ?? {}).sort()).toEqual(['id', 'nameEn', 'slug']);
    expect(Object.keys(body.quote.package ?? {}).sort()).toEqual(['id', 'nameEn', 'priceRwf']);
  });
});
