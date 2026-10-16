import type { AdminUser, Booking, Prisma, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { issueAdminToken } from '../auth/token.js';
import { listPublicCatalogue } from '../catalogue/public.js';
import { createPrismaClient } from '../db/client.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';

/**
 * The catalogue CMS over HTTP, against real PostgreSQL (plan.md Task 10; spec
 * §3.4, §6.8, §6.13, §6.14, P-17 to P-20; data-model_v2.md §5.5–5.7, §5.9, §9.4).
 *
 * "The public list" is `listPublicCatalogue()`, the projection Task 11's route
 * serves; its own filtering rules are proven in catalogue/public.test.ts.
 *
 * Validation follows the one admin rule (routes/validation.ts): a malformed
 * request is a 400, a well-formed one breaking a rule is a 422 naming the
 * fields. Referenced rows are protected by the database's RESTRICT foreign
 * keys, answered as 409 `in_use`.
 *
 * Kigali is UTC+2 with no DST. The clock starts at Thursday 1 October 2026,
 * 08:00 in Kigali; the §6.8 warning reads "today" off it.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let admin: AdminUser;
let token: string;
let clock: Date;
let app: Express;
let clientId: string;

const SECRET = 'admin-catalogue-test-secret-at-least-32-characters';
const WEB_ORIGIN = 'https://admin.bookly.example';
const START = new Date('2026-10-01T06:00:00Z');
const INT4_MAX = 2_147_483_647;
const MINUTE_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';
const MALFORMED_IDS = [
  'not-a-uuid',
  '12345',
  '00000000-0000-4000-8000-00000000000g',
  '00000000000040008000000000000000',
];

const CATALOGUE = '/api/admin/catalogue';
const SERVICES = '/api/admin/services';
const PACKAGES = '/api/admin/packages';
const ADDONS = '/api/admin/addons';

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
  // No login happens in this file, so no Argon2 is spent: the token only needs
  // the stored hash to fingerprint it.
  admin = await prisma.adminUser.create({
    data: { email: 'photographer@bookly.example', passwordHash: '$argon2id$placeholder-never-verified' },
  });
  await setClock(START);
  app = createApp({
    corsOrigin: WEB_ORIGIN,
    admin: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock },
  });
  clientId = (
    await prisma.client.create({
      data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' },
    })
  ).id;
});

// --- Fixtures ---------------------------------------------------------------

type Method = 'get' | 'post' | 'patch' | 'delete';

type ServiceJson = {
  id: string;
  slug: string;
  nameEn: string;
  nameFr: string | null;
  descriptionEn: string | null;
  descriptionFr: string | null;
  coverImageUrl: string | null;
  bookingFeeRateOverride: number | null;
  isActive: boolean;
  sortOrder: number;
};

type PackageJson = {
  id: string;
  serviceId: string;
  nameEn: string;
  nameFr: string | null;
  descriptionEn: string | null;
  descriptionFr: string | null;
  priceRwf: number;
  photoCount: number;
  durationMinutes: number;
  isActive: boolean;
  sortOrder: number;
};

type AddonJson = {
  id: string;
  serviceId: string | null;
  nameEn: string;
  nameFr: string | null;
  priceRwf: number;
  isActive: boolean;
  sortOrder: number;
};

type OpenWindow = { opensMinute: number; closesMinute: number };
type WarningJson = { code: 'duration_exceeds_longest_window'; longestWindow: OpenWindow | null };
type PackageSavedJson = { package: PackageJson; warning: WarningJson | null };

type CatalogueJson = {
  services: (ServiceJson & { packages: PackageJson[]; addons: AddonJson[] })[];
  sharedAddons: AddonJson[];
};

/** Moves the injected clock and mints a token valid at that instant. */
async function setClock(instant: Date): Promise<void> {
  clock = instant;
  token = (await issueAdminToken(SECRET, admin, instant)).token;
}

/** `bearer: null` sends no Authorization header at all. */
function send(method: Method, path: string, body?: unknown, bearer: string | null = token): request.Test {
  const req = request(app)[method](path);
  if (bearer !== null) req.set('Authorization', `Bearer ${bearer}`);
  return body === undefined ? req : req.send(body as object);
}

/** A body sent as literal JSON text, for bodies supertest would not serialise as-is. */
function sendText(method: Method, path: string, text: string): request.Test {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .send(text);
}

function bodyOf<T>(res: Response, status: number): T {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
}

async function getCatalogue(): Promise<CatalogueJson> {
  return bodyOf<CatalogueJson>(await send('get', CATALOGUE), 200);
}

const SERVICE_BODY = { slug: 'portraits', nameEn: 'Portraits' } as const;

function packageBody(serviceId: string, extra: object = {}): Record<string, unknown> {
  return { serviceId, nameEn: 'Standard', priceRwf: 40_000, photoCount: 20, durationMinutes: 60, ...extra };
}

function addonBody(serviceId: string | null, extra: object = {}): Record<string, unknown> {
  return { serviceId, nameEn: 'Extra hour', priceRwf: 15_000, ...extra };
}

function without(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = body;
  return rest;
}

/** What a service is when only slug and name were sent. */
const SERVICE_DEFAULTS = {
  nameFr: null,
  descriptionEn: null,
  descriptionFr: null,
  coverImageUrl: null,
  bookingFeeRateOverride: null,
  isActive: true,
  sortOrder: 0,
} as const;

function insertService(slug: string, data: Partial<Prisma.ServiceUncheckedCreateInput> = {}) {
  return prisma.service.create({ data: { slug, nameEn: 'Portraits', ...data } });
}

function insertPackage(serviceId: string, data: Partial<Prisma.PackageUncheckedCreateInput> = {}) {
  return prisma.package.create({
    data: { serviceId, nameEn: 'Standard', priceRwf: 40_000, photoCount: 20, durationMinutes: 60, ...data },
  });
}

function insertAddon(serviceId: string | null, data: Partial<Prisma.AddonUncheckedCreateInput> = {}) {
  return prisma.addon.create({ data: { serviceId, nameEn: 'Extra hour', priceRwf: 15_000, ...data } });
}

/** Mon–Fri 09:00–17:00, the seeded weekly rule (data-model_v2.md §13): a 480-minute window. */
async function seedWeekdayHours(): Promise<void> {
  await prisma.workingHours.createMany({
    data: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinute: 540, closesMinute: 1020 })),
  });
}

/**
 * A 60-minute booking on Wednesday 7 October, `slot` two-hour steps after
 * 09:00 Kigali so no two fixtures trip the exclusion constraint. Every
 * snapshot column carries what the catalogue said when it was sold.
 */
function insertBooking(ids: { serviceId: string; packageId: string }, reference: string, slot = 0): Promise<Booking> {
  const startsAt = new Date(Date.parse('2026-10-07T07:00:00Z') + slot * 120 * MINUTE_MS);
  const endsAt = new Date(startsAt.getTime() + 60 * MINUTE_MS);
  return prisma.booking.create({
    data: {
      reference,
      clientId,
      contactName: 'Aline Uwase',
      contactEmail: 'aline@example.com',
      contactPhone: '+250788000000',
      serviceId: ids.serviceId,
      packageId: ids.packageId,
      serviceNameSnapshot: 'Portraits',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 40_000,
      packageDurationMinutes: 60,
      packagePhotoCount: 20,
      locationText: 'Kigali Heights',
      consentAt: START,
      bookingFeeRate: '0.400',
      bookingFeeRwf: 22_000,
      status: 'confirmed',
      startsAt,
      endsAt,
      bufferEndsAt: new Date(endsAt.getTime() + 30 * MINUTE_MS),
    },
  });
}

function insertBookingAddon(bookingId: string, addonId: string) {
  return prisma.bookingAddon.create({
    data: {
      bookingId,
      addonId,
      nameSnapshot: 'Extra hour',
      unitPriceRwf: 15_000,
      quantity: 1,
      amountRwf: 15_000,
      stage: 'at_booking',
    },
  });
}

/** A booking's snapshot and money columns, read straight off the row. */
async function bookingColumns(id: string) {
  return firstRow(
    await raw.query<Record<string, unknown>>(
      `SELECT service_name_snapshot, package_name_snapshot, package_price_rwf, package_duration_minutes,
              package_photo_count, booking_fee_rate::text AS booking_fee_rate, booking_fee_rwf,
              starts_at, ends_at, buffer_ends_at, status
         FROM booking WHERE id = $1`,
      [id],
    ),
  );
}

async function bookingAddonColumns(id: string) {
  return firstRow(
    await raw.query<Record<string, unknown>>(
      'SELECT name_snapshot, unit_price_rwf, quantity, amount_rwf, stage FROM booking_addon WHERE id = $1',
      [id],
    ),
  );
}

function expectInvalidRequest(res: Response): void {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body).toEqual({ error: 'invalid_request' });
}

function expectValidationFailed(res: Response, fields: string[]): void {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body).toEqual({ error: 'validation_failed', fields });
}

function expectNotFound(res: Response): void {
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: 'not_found' });
}

function expectUnauthenticated(res: Response): void {
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'unauthenticated' });
  expect(String(res.headers['www-authenticate'])).toMatch(/^Bearer realm="bookly-admin"/);
}

function warning(longestWindow: OpenWindow | null): WarningJson {
  return { code: 'duration_exceeds_longest_window', longestWindow };
}

async function catalogueRows() {
  return {
    services: await prisma.service.findMany({ orderBy: { slug: 'asc' } }),
    packages: await prisma.package.findMany({ orderBy: { nameEn: 'asc' } }),
    addons: await prisma.addon.findMany({ orderBy: { nameEn: 'asc' } }),
  };
}

// --- Auth (global definition of done) ------------------------------------------------

describe('catalogue routes without a valid token', () => {
  const ROUTES: [Method, string][] = [
    ['get', CATALOGUE],
    ['post', SERVICES],
    ['patch', `${SERVICES}/${NONEXISTENT_ID}`],
    ['delete', `${SERVICES}/${NONEXISTENT_ID}`],
    ['post', PACKAGES],
    ['patch', `${PACKAGES}/${NONEXISTENT_ID}`],
    ['delete', `${PACKAGES}/${NONEXISTENT_ID}`],
    ['post', ADDONS],
    ['patch', `${ADDONS}/${NONEXISTENT_ID}`],
    ['delete', `${ADDONS}/${NONEXISTENT_ID}`],
  ];

  // The body is malformed on purpose: a stranger learns nothing about validation.
  it.each(ROUTES)('%s %s answers 401 with no token, before validating', async (method, path) => {
    expectUnauthenticated(await send(method, path, { slug: 'Not A Slug', priceRwf: -1 }, null));
  });

  it.each(ROUTES)('%s %s answers 401 with a garbage token', async (method, path) => {
    const res = await send(method, path, { slug: 'Not A Slug' }, 'not.a.token');

    expectUnauthenticated(res);
    expect(String(res.headers['www-authenticate'])).toContain('error="invalid_token"');
  });

  it('answers 401 once the token has expired by the injected clock', async () => {
    clock = new Date(START.getTime() + 8 * 60 * MINUTE_MS);

    expectUnauthenticated(await send('get', CATALOGUE));
  });

  it.each([null, 'not.a.token'])('writes nothing for valid writes sent with bearer %j', async (bearer) => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id);
    const addon = await insertAddon(null);
    const before = await catalogueRows();

    const statuses = [
      (await send('post', SERVICES, { slug: 'events', nameEn: 'Events' }, bearer)).status,
      (await send('patch', `${SERVICES}/${service.id}`, { isActive: false }, bearer)).status,
      (await send('post', PACKAGES, packageBody(service.id), bearer)).status,
      (await send('patch', `${PACKAGES}/${pkg.id}`, { priceRwf: 1 }, bearer)).status,
      (await send('post', ADDONS, addonBody(service.id), bearer)).status,
      (await send('patch', `${ADDONS}/${addon.id}`, { priceRwf: 1 }, bearer)).status,
      (await send('delete', `${ADDONS}/${addon.id}`, undefined, bearer)).status,
      (await send('delete', `${PACKAGES}/${pkg.id}`, undefined, bearer)).status,
      (await send('delete', `${SERVICES}/${service.id}`, undefined, bearer)).status,
    ];

    expect(statuses).toEqual(Array<number>(9).fill(401));
    expect(await catalogueRows()).toEqual(before);
  });
});

// --- Plan.md Task 10 verification, end to end --------------------------------------------

describe('plan.md Task 10 verification', () => {
  beforeEach(seedWeekdayHours);

  it('creates a service with a package and two add-ons that persist and appear on the public list', async () => {
    const service = bodyOf<{ service: ServiceJson }>(
      await send('post', SERVICES, {
        slug: 'portraits',
        nameEn: 'Portraits',
        descriptionEn: 'Studio and outdoor portraits.',
        coverImageUrl: 'https://images.example.com/portraits.jpg',
      }),
      201,
    ).service;
    const saved = bodyOf<PackageSavedJson>(
      await send('post', PACKAGES, packageBody(service.id, { descriptionEn: 'One look, one location.' })),
      201,
    );
    const extraHour = bodyOf<{ addon: AddonJson }>(await send('post', ADDONS, addonBody(service.id)), 201).addon;
    const album = bodyOf<{ addon: AddonJson }>(
      await send('post', ADDONS, addonBody(service.id, { nameEn: 'Printed album', priceRwf: 25_000 })),
      201,
    ).addon;

    expect(saved.warning).toBeNull();
    expect(await listPublicCatalogue(prisma)).toEqual([
      {
        id: service.id,
        slug: 'portraits',
        nameEn: 'Portraits',
        descriptionEn: 'Studio and outdoor portraits.',
        coverImageUrl: 'https://images.example.com/portraits.jpg',
        packages: [
          {
            id: saved.package.id,
            nameEn: 'Standard',
            descriptionEn: 'One look, one location.',
            priceRwf: 40_000,
            photoCount: 20,
            durationMinutes: 60,
          },
        ],
        addons: [
          { id: extraHour.id, nameEn: 'Extra hour', priceRwf: 15_000 },
          { id: album.id, nameEn: 'Printed album', priceRwf: 25_000 },
        ],
      },
    ]);
    expect(await getCatalogue()).toEqual({
      services: [{ ...service, packages: [saved.package], addons: [extraHour, album] }],
      sharedAddons: [],
    });
  });

  it('leaves an existing booking’s package_price_rwf, and every other snapshot, as it was sold (spec §6.13)', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id);
    const addon = await insertAddon(service.id);
    const booking = await insertBooking({ serviceId: service.id, packageId: pkg.id }, 'BKY-2610-00001');
    const bookingAddon = await insertBookingAddon(booking.id, addon.id);
    const soldAs = await bookingColumns(booking.id);
    const addonSoldAs = await bookingAddonColumns(bookingAddon.id);
    expect(soldAs).toMatchObject({ package_price_rwf: 40_000, booking_fee_rate: '0.400' });

    const edited = bodyOf<PackageSavedJson>(
      await send('patch', `${PACKAGES}/${pkg.id}`, {
        priceRwf: 55_000,
        nameEn: 'Premium',
        durationMinutes: 90,
        photoCount: 40,
      }),
      200,
    );
    bodyOf(await send('patch', `${SERVICES}/${service.id}`, { nameEn: 'Portrait sessions', bookingFeeRateOverride: 0.3 }), 200);
    bodyOf(await send('patch', `${ADDONS}/${addon.id}`, { nameEn: 'Two extra hours', priceRwf: 30_000 }), 200);

    expect(edited.package).toMatchObject({ priceRwf: 55_000, nameEn: 'Premium', durationMinutes: 90, photoCount: 40 });
    await expect(prisma.package.findUniqueOrThrow({ where: { id: pkg.id } })).resolves.toMatchObject({ priceRwf: 55_000 });
    expect(await bookingColumns(booking.id)).toEqual(soldAs);
    expect(await bookingAddonColumns(bookingAddon.id)).toEqual(addonSoldAs);
  });

  it('removes a deactivated service from the public list while its bookings stay readable with their snapshots (spec §6.14)', async () => {
    const portraits = await insertService('portraits', { nameEn: 'Portraits' });
    const events = await insertService('events', { nameEn: 'Events' });
    const portraitPackage = await insertPackage(portraits.id);
    await insertPackage(events.id, { nameEn: 'Half day' });
    const booking = await insertBooking({ serviceId: portraits.id, packageId: portraitPackage.id }, 'BKY-2610-00001');
    const soldAs = await bookingColumns(booking.id);

    const res = await send('patch', `${SERVICES}/${portraits.id}`, { isActive: false });

    expect(bodyOf<{ service: ServiceJson }>(res, 200).service).toMatchObject({ id: portraits.id, isActive: false });
    expect((await listPublicCatalogue(prisma)).map((service) => service.slug)).toEqual(['events']);

    const readable = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: { service: true, package: true },
    });
    expect(readable).toMatchObject({
      serviceNameSnapshot: 'Portraits',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 40_000,
      packageDurationMinutes: 60,
      packagePhotoCount: 20,
      status: 'confirmed',
      service: { id: portraits.id, isActive: false },
      package: { id: portraitPackage.id },
    });
    expect(await bookingColumns(booking.id)).toEqual(soldAs);

    // Still in the admin catalogue, and one PATCH puts it back on sale.
    expect((await getCatalogue()).services.map((s) => [s.slug, s.isActive])).toEqual([
      ['events', true],
      ['portraits', false],
    ]);
    bodyOf(await send('patch', `${SERVICES}/${portraits.id}`, { isActive: true }), 200);
    expect((await listPublicCatalogue(prisma)).map((service) => service.slug)).toEqual(['events', 'portraits']);
  });

  it('refuses to hard-delete a package a booking references with 409, and the row survives', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id);
    await insertBooking({ serviceId: service.id, packageId: pkg.id }, 'BKY-2610-00001');

    const res = await send('delete', `${PACKAGES}/${pkg.id}`);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'in_use' });
    await expect(prisma.package.findUnique({ where: { id: pkg.id } })).resolves.toEqual(pkg);
  });

  it('warns, naming the longest window, when a package cannot fit any open day -- and saves it anyway (spec §6.8)', async () => {
    const service = await insertService('events');

    const saved = bodyOf<PackageSavedJson>(
      await send('post', PACKAGES, packageBody(service.id, { nameEn: 'Full day', durationMinutes: 600 })),
      201,
    );

    expect(saved.warning).toEqual(warning({ opensMinute: 540, closesMinute: 1020 }));
    await expect(prisma.package.findUniqueOrThrow({ where: { id: saved.package.id } })).resolves.toMatchObject({
      nameEn: 'Full day',
      durationMinutes: 600,
    });
  });

  it('accepts the French fields as optional: absent is null, present is stored (spec §7)', async () => {
    const withoutFrench = bodyOf<{ service: ServiceJson }>(await send('post', SERVICES, SERVICE_BODY), 201).service;
    const withFrench = bodyOf<{ service: ServiceJson }>(
      await send('post', SERVICES, { slug: 'evenements', nameEn: 'Events', nameFr: 'Événements', descriptionFr: 'Mariages et fêtes.' }),
      201,
    ).service;

    expect(withoutFrench).toMatchObject({ nameFr: null, descriptionFr: null });
    expect(withFrench).toMatchObject({ nameFr: 'Événements', descriptionFr: 'Mariages et fêtes.' });
  });
});

// --- GET /catalogue --------------------------------------------------------------------

describe('GET /api/admin/catalogue', () => {
  it('answers an empty catalogue', async () => {
    expect(await getCatalogue()).toEqual({ services: [], sharedAddons: [] });
  });

  it('returns every row, inactive included, with exactly the admin fields', async () => {
    const service = await insertService('portraits', {
      nameFr: 'Portraits FR',
      descriptionEn: 'Studio portraits.',
      descriptionFr: 'Portraits en studio.',
      coverImageUrl: 'https://images.example.com/p.jpg',
      bookingFeeRateOverride: '0.300',
      isActive: false,
      sortOrder: 3,
    });
    const pkg = await insertPackage(service.id, { nameFr: 'Standard FR', descriptionEn: 'One look.', isActive: false, sortOrder: 2 });
    const own = await insertAddon(service.id, { nameFr: 'Heure', isActive: false, sortOrder: 1 });
    const shared = await insertAddon(null, { nameEn: 'Rush edit', priceRwf: 5_000 });

    expect(await getCatalogue()).toEqual({
      services: [
        {
          id: service.id,
          slug: 'portraits',
          nameEn: 'Portraits',
          nameFr: 'Portraits FR',
          descriptionEn: 'Studio portraits.',
          descriptionFr: 'Portraits en studio.',
          coverImageUrl: 'https://images.example.com/p.jpg',
          bookingFeeRateOverride: 0.3,
          isActive: false,
          sortOrder: 3,
          packages: [
            {
              id: pkg.id,
              serviceId: service.id,
              nameEn: 'Standard',
              nameFr: 'Standard FR',
              descriptionEn: 'One look.',
              descriptionFr: null,
              priceRwf: 40_000,
              photoCount: 20,
              durationMinutes: 60,
              isActive: false,
              sortOrder: 2,
            },
          ],
          addons: [
            { id: own.id, serviceId: service.id, nameEn: 'Extra hour', nameFr: 'Heure', priceRwf: 15_000, isActive: false, sortOrder: 1 },
          ],
        },
      ],
      sharedAddons: [
        { id: shared.id, serviceId: null, nameEn: 'Rush edit', nameFr: null, priceRwf: 5_000, isActive: true, sortOrder: 0 },
      ],
    });
  });

  it('orders services, packages and add-ons by display order, then name, then age', async () => {
    const older = new Date('2026-09-01T00:00:00Z');
    const newer = new Date('2026-09-02T00:00:00Z');
    // Inserted out of order, so insertion order cannot pass for sorting.
    const alpha = await insertService('alpha', { nameEn: 'Alpha', sortOrder: 2 });
    await insertService('mike-newer', { nameEn: 'Mike', sortOrder: 1, createdAt: newer });
    await insertService('zulu', { nameEn: 'Zulu', sortOrder: 1 });
    await insertService('yankee', { nameEn: 'Yankee', sortOrder: 0, isActive: false });
    await insertService('mike-older', { nameEn: 'Mike', sortOrder: 1, createdAt: older });

    await insertPackage(alpha.id, { nameEn: 'Beta', sortOrder: 1 });
    await insertPackage(alpha.id, { nameEn: 'Gamma', sortOrder: 0, priceRwf: 2, createdAt: newer });
    await insertPackage(alpha.id, { nameEn: 'Alpha', sortOrder: 1 });
    await insertPackage(alpha.id, { nameEn: 'Gamma', sortOrder: 0, priceRwf: 1, createdAt: older });

    await insertAddon(alpha.id, { nameEn: 'Zoom', sortOrder: 0 });
    await insertAddon(alpha.id, { nameEn: 'Album', sortOrder: 5 });
    await insertAddon(null, { nameEn: 'Retouch', sortOrder: 1 });
    await insertAddon(null, { nameEn: 'Drone', sortOrder: 1 });
    await insertAddon(null, { nameEn: 'Prints', sortOrder: 0 });

    const catalogue = await getCatalogue();

    expect(catalogue.services.map((s) => s.slug)).toEqual(['yankee', 'mike-older', 'mike-newer', 'zulu', 'alpha']);
    const alphaJson = catalogue.services.find((s) => s.id === alpha.id);
    expect(alphaJson?.packages.map((p) => [p.nameEn, p.priceRwf])).toEqual([
      ['Gamma', 1],
      ['Gamma', 2],
      ['Alpha', 40_000],
      ['Beta', 40_000],
    ]);
    expect(alphaJson?.addons.map((a) => a.nameEn)).toEqual(['Zoom', 'Album']);
    expect(catalogue.sharedAddons.map((a) => a.nameEn)).toEqual(['Prints', 'Drone', 'Retouch']);
    // A service's own list holds its own add-ons only.
    expect(catalogue.services.filter((s) => s.id !== alpha.id).every((s) => s.addons.length === 0)).toBe(true);
  });
});

// --- Services ---------------------------------------------------------------------------

describe('POST /api/admin/services', () => {
  it('creates a service with 201, trimming names and defaulting what was not sent', async () => {
    const res = await send('post', SERVICES, { slug: 'portraits', nameEn: '  Portraits  ', nameFr: '  Portraits FR ' });

    const { service } = bodyOf<{ service: ServiceJson }>(res, 201);
    expect(service).toEqual({
      ...SERVICE_DEFAULTS,
      id: expect.stringMatching(UUID) as string,
      slug: 'portraits',
      nameEn: 'Portraits',
      nameFr: 'Portraits FR',
    });
    expect((await getCatalogue()).services).toEqual([{ ...service, packages: [], addons: [] }]);
  });

  it('stores every field it is sent', async () => {
    const body = {
      slug: 'corporate-events',
      nameEn: 'Corporate events',
      nameFr: 'Événements d’entreprise',
      descriptionEn: 'Conferences and launches.',
      descriptionFr: 'Conférences.',
      coverImageUrl: 'https://images.example.com/events.jpg?w=1200',
      bookingFeeRateOverride: 0.25,
      isActive: false,
      sortOrder: 7,
    };

    const { service } = bodyOf<{ service: ServiceJson }>(await send('post', SERVICES, body), 201);

    expect(service).toEqual({ ...body, id: service.id });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a fee override of 0', { bookingFeeRateOverride: 0 }],
    ['a fee override of 1', { bookingFeeRateOverride: 1 }],
    ['an explicit null for every nullable field', { nameFr: null, descriptionEn: null, descriptionFr: null, coverImageUrl: null, bookingFeeRateOverride: null }],
    ['a sort order at the int4 maximum', { sortOrder: INT4_MAX }],
    ['a 200-character name', { nameEn: 'n'.repeat(200), nameFr: 'n'.repeat(200) }],
    ['a 100-character slug', { slug: 's'.repeat(100) }],
    ['a slug of digits and single hyphens', { slug: '2026-wedding-films' }],
    ['5000-character descriptions', { descriptionEn: 'd'.repeat(5000), descriptionFr: 'd'.repeat(5000) }],
    ['an https cover URL with an uppercase scheme', { coverImageUrl: 'HTTPS://images.example.com/cover.jpg' }],
  ])('accepts %s', async (_label, extra) => {
    const res = await send('post', SERVICES, { ...SERVICE_BODY, ...extra });

    expect(bodyOf<{ service: ServiceJson }>(res, 201).service).toMatchObject(extra);
  });

  it('stores blank optional text as null, not as an empty string', async () => {
    const created = await send('post', SERVICES, { ...SERVICE_BODY, nameFr: '   ', descriptionEn: '', descriptionFr: ' \n ' });

    const { service } = bodyOf<{ service: ServiceJson }>(created, 201);
    expect(service).toMatchObject({ nameFr: null, descriptionEn: null, descriptionFr: null });

    const patched = await send('patch', `${SERVICES}/${service.id}`, { nameFr: 'Portraits', descriptionEn: 'Studio.' });
    expect(bodyOf<{ service: ServiceJson }>(patched, 200).service).toMatchObject({ nameFr: 'Portraits', descriptionEn: 'Studio.' });

    const blanked = await send('patch', `${SERVICES}/${service.id}`, { nameFr: ' ', descriptionEn: '  ' });
    expect(bodyOf<{ service: ServiceJson }>(blanked, 200).service).toMatchObject({ nameFr: null, descriptionEn: null });
  });

  it.each<[string, unknown]>([
    ['no slug', { nameEn: 'Portraits' }],
    ['no nameEn', { slug: 'portraits' }],
    ['a numeric nameEn', { ...SERVICE_BODY, nameEn: 42 }],
    ['a null nameEn', { ...SERVICE_BODY, nameEn: null }],
    ['a null slug', { ...SERVICE_BODY, slug: null }],
    ['an unknown key', { ...SERVICE_BODY, priceRwf: 40_000 }],
    ['a client-chosen id', { ...SERVICE_BODY, id: NONEXISTENT_ID }],
    ['an uppercase slug', { ...SERVICE_BODY, slug: 'Portraits' }],
    ['a slug with a double hyphen', { ...SERVICE_BODY, slug: 'corporate--events' }],
    ['a slug with a leading hyphen', { ...SERVICE_BODY, slug: '-portraits' }],
    ['a slug with a trailing hyphen', { ...SERVICE_BODY, slug: 'portraits-' }],
    ['a slug with an underscore', { ...SERVICE_BODY, slug: 'corporate_events' }],
    ['a slug with a space', { ...SERVICE_BODY, slug: 'corporate events' }],
    ['a slug with an accent', { ...SERVICE_BODY, slug: 'soirée' }],
    ['an empty slug', { ...SERVICE_BODY, slug: '' }],
    ['a malformed cover URL', { ...SERVICE_BODY, coverImageUrl: 'not a url' }],
    ['an empty cover URL', { ...SERVICE_BODY, coverImageUrl: '' }],
    ['a fee override sent as a string', { ...SERVICE_BODY, bookingFeeRateOverride: '0.3' }],
    ['a string isActive', { ...SERVICE_BODY, isActive: 'true' }],
    ['a fractional sort order', { ...SERVICE_BODY, sortOrder: 1.5 }],
    ['a string sort order', { ...SERVICE_BODY, sortOrder: '1' }],
    ['a numeric description', { ...SERVICE_BODY, descriptionEn: 1 }],
    ['a numeric nameFr', { ...SERVICE_BODY, nameFr: 1 }],
    ['a shape error beside a rule error', { ...SERVICE_BODY, nameEn: '', sortOrder: 'first' }],
    ['an array', [SERVICE_BODY]],
  ])('refuses %s with 400, writing nothing', async (_label, body) => {
    expectInvalidRequest(await send('post', SERVICES, body));
    expect(await prisma.service.count()).toBe(0);
  });

  it.each<[string, string]>([
    ['no body', ''],
    ['a JSON null', 'null'],
    ['a JSON string', '"portraits"'],
    ['malformed JSON', '{"slug":'],
  ])('refuses %s with 400', async (_label, text) => {
    expectInvalidRequest(await sendText('post', SERVICES, text));
    expect(await prisma.service.count()).toBe(0);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['a blank nameEn', { nameEn: '   ' }, ['nameEn']],
    ['a nameEn over 200 characters', { nameEn: 'n'.repeat(201) }, ['nameEn']],
    ['a nameFr over 200 characters', { nameFr: 'n'.repeat(201) }, ['nameFr']],
    ['a slug over 100 characters', { slug: 's'.repeat(101) }, ['slug']],
    ['a description over 5000 characters', { descriptionEn: 'd'.repeat(5001) }, ['descriptionEn']],
    ['a French description over 5000 characters', { descriptionFr: 'd'.repeat(5001) }, ['descriptionFr']],
    ['an http cover URL', { coverImageUrl: 'http://images.example.com/cover.jpg' }, ['coverImageUrl']],
    ['a javascript: cover URL', { coverImageUrl: 'javascript:alert(1)' }, ['coverImageUrl']],
    ['a fee override above 1', { bookingFeeRateOverride: 1.001 }, ['bookingFeeRateOverride']],
    ['a negative fee override', { bookingFeeRateOverride: -0.001 }, ['bookingFeeRateOverride']],
    ['a fee override with four decimal places', { bookingFeeRateOverride: 0.1234 }, ['bookingFeeRateOverride']],
    ['a negative sort order', { sortOrder: -1 }, ['sortOrder']],
    ['a sort order past int4', { sortOrder: INT4_MAX + 1 }, ['sortOrder']],
    ['several rules at once', { slug: 's'.repeat(101), nameEn: '', sortOrder: -1 }, ['slug', 'nameEn', 'sortOrder']],
  ])('refuses %s with 422 naming the fields, writing nothing', async (_label, extra, fields) => {
    expectValidationFailed(await send('post', SERVICES, { ...SERVICE_BODY, ...extra }), fields);
    expect(await prisma.service.count()).toBe(0);
  });

  it('refuses a slug another service has with 409, keeping the first', async () => {
    const first = await insertService('portraits', { nameEn: 'Portraits' });

    const res = await send('post', SERVICES, { slug: 'portraits', nameEn: 'Portraits again' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'slug_taken' });
    await expect(prisma.service.findMany()).resolves.toEqual([first]);
  });

  it('counts an inactive service’s slug as taken', async () => {
    await insertService('portraits', { isActive: false });

    expect((await send('post', SERVICES, SERVICE_BODY)).status).toBe(409);
  });
});

describe('PATCH /api/admin/services/:id', () => {
  it('changes only the fields it names', async () => {
    const service = await insertService('portraits', { descriptionEn: 'Studio portraits.', sortOrder: 1 });

    const res = await send('patch', `${SERVICES}/${service.id}`, { sortOrder: 5, nameEn: '  Portrait sessions ' });

    expect(bodyOf<{ service: ServiceJson }>(res, 200).service).toEqual({
      ...SERVICE_DEFAULTS,
      id: service.id,
      slug: 'portraits',
      nameEn: 'Portrait sessions',
      descriptionEn: 'Studio portraits.',
      sortOrder: 5,
    });
  });

  it('answers an empty object with 200 and the service unchanged', async () => {
    const service = await insertService('portraits', { coverImageUrl: 'https://images.example.com/p.jpg' });
    const before = await getCatalogue();

    const res = await send('patch', `${SERVICES}/${service.id}`, {});

    expect(bodyOf<{ service: ServiceJson }>(res, 200).service).toMatchObject({
      id: service.id,
      slug: 'portraits',
      coverImageUrl: 'https://images.example.com/p.jpg',
    });
    expect(await getCatalogue()).toEqual(before);
  });

  it('clears nullable fields sent as null', async () => {
    const service = await insertService('portraits', {
      descriptionEn: 'Studio portraits.',
      coverImageUrl: 'https://images.example.com/p.jpg',
      bookingFeeRateOverride: '0.300',
    });

    const res = await send('patch', `${SERVICES}/${service.id}`, {
      descriptionEn: null,
      coverImageUrl: null,
      bookingFeeRateOverride: null,
    });

    expect(bodyOf<{ service: ServiceJson }>(res, 200).service).toMatchObject({
      descriptionEn: null,
      coverImageUrl: null,
      bookingFeeRateOverride: null,
    });
  });

  it('accepts a service keeping its own slug', async () => {
    const service = await insertService('portraits');

    expect(bodyOf<{ service: ServiceJson }>(await send('patch', `${SERVICES}/${service.id}`, { slug: 'portraits' }), 200).service.slug).toBe(
      'portraits',
    );
  });

  it('refuses a slug another service has with 409, leaving the row as it was', async () => {
    await insertService('portraits');
    const events = await insertService('events', { nameEn: 'Events' });

    const res = await send('patch', `${SERVICES}/${events.id}`, { slug: 'portraits', nameEn: 'Renamed' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'slug_taken' });
    await expect(prisma.service.findUniqueOrThrow({ where: { id: events.id } })).resolves.toEqual(events);
  });

  it.each<[string, unknown]>([
    ['an unknown key', { priceRwf: 1 }],
    ['a null nameEn', { nameEn: null }],
    ['a null slug', { slug: null }],
    ['a malformed slug', { slug: 'Corporate Events' }],
    ['a string isActive', { isActive: 'false' }],
    ['a malformed cover URL', { coverImageUrl: 'images/cover.jpg' }],
    ['a fee override sent as a string', { bookingFeeRateOverride: '0.3' }],
    ['an array', [{ isActive: false }]],
  ])('refuses %s with 400, leaving the row as it was', async (_label, body) => {
    const service = await insertService('portraits');

    expectInvalidRequest(await send('patch', `${SERVICES}/${service.id}`, body));
    await expect(prisma.service.findUniqueOrThrow({ where: { id: service.id } })).resolves.toEqual(service);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['a blank nameEn', { nameEn: '' }, ['nameEn']],
    ['an http cover URL', { coverImageUrl: 'http://images.example.com/p.jpg' }, ['coverImageUrl']],
    ['a fee override above 1', { bookingFeeRateOverride: 1.5 }, ['bookingFeeRateOverride']],
    ['a negative sort order', { sortOrder: -1 }, ['sortOrder']],
    ['a valid change beside a rule error', { isActive: false, sortOrder: INT4_MAX + 1 }, ['sortOrder']],
  ])('refuses %s with 422, leaving the row as it was', async (_label, body, fields) => {
    const service = await insertService('portraits');

    expectValidationFailed(await send('patch', `${SERVICES}/${service.id}`, body), fields);
    await expect(prisma.service.findUniqueOrThrow({ where: { id: service.id } })).resolves.toEqual(service);
  });
});

// --- Packages ---------------------------------------------------------------------------

describe('POST /api/admin/packages', () => {
  let serviceId: string;

  beforeEach(async () => {
    await seedWeekdayHours();
    serviceId = (await insertService('portraits')).id;
  });

  it('creates a package with 201 and no warning when it fits', async () => {
    const res = await send(
      'post',
      PACKAGES,
      packageBody(serviceId, { nameFr: 'Standard FR', descriptionEn: 'One look.', descriptionFr: 'Un look.', isActive: false, sortOrder: 3 }),
    );

    expect(bodyOf<PackageSavedJson>(res, 201)).toEqual({
      package: {
        id: expect.stringMatching(UUID) as string,
        serviceId,
        nameEn: 'Standard',
        nameFr: 'Standard FR',
        descriptionEn: 'One look.',
        descriptionFr: 'Un look.',
        priceRwf: 40_000,
        photoCount: 20,
        durationMinutes: 60,
        isActive: false,
        sortOrder: 3,
      },
      warning: null,
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a price, photo count and sort order of 0 and a 1-minute duration', { priceRwf: 0, photoCount: 0, sortOrder: 0, durationMinutes: 1 }],
    ['a price and photo count at the int4 maximum', { priceRwf: INT4_MAX, photoCount: INT4_MAX }],
  ])('accepts %s', async (_label, extra) => {
    const res = await send('post', PACKAGES, packageBody(serviceId, extra));

    expect(bodyOf<PackageSavedJson>(res, 201).package).toMatchObject(extra);
  });

  it.each<[string, (id: string) => unknown]>([
    ['no serviceId', (id) => without(packageBody(id), 'serviceId')],
    ['a null serviceId', (id) => packageBody(id, { serviceId: null })],
    ['a malformed serviceId', (id) => packageBody(id, { serviceId: 'portraits' })],
    ['no nameEn', (id) => without(packageBody(id), 'nameEn')],
    ['no priceRwf', (id) => without(packageBody(id), 'priceRwf')],
    ['no photoCount', (id) => without(packageBody(id), 'photoCount')],
    ['no durationMinutes', (id) => without(packageBody(id), 'durationMinutes')],
    ['a string price', (id) => packageBody(id, { priceRwf: '40000' })],
    ['a fractional price', (id) => packageBody(id, { priceRwf: 40_000.5 })],
    ['a fractional duration', (id) => packageBody(id, { durationMinutes: 60.5 })],
    ['a null photo count', (id) => packageBody(id, { photoCount: null })],
    ['a numeric description', (id) => packageBody(id, { descriptionEn: 7 })],
    ['a fee override, which belongs to services', (id) => packageBody(id, { bookingFeeRateOverride: 0.3 })],
    ['a slug, which packages do not have', (id) => packageBody(id, { slug: 'standard' })],
    ['a shape error beside a rule error', (id) => packageBody(id, { priceRwf: -1, photoCount: 'twenty' })],
  ])('refuses %s with 400, writing nothing', async (_label, body) => {
    expectInvalidRequest(await send('post', PACKAGES, body(serviceId)));
    expect(await prisma.package.count()).toBe(0);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['a negative price', { priceRwf: -1 }, ['priceRwf']],
    ['a price past int4', { priceRwf: INT4_MAX + 1 }, ['priceRwf']],
    ['a negative photo count', { photoCount: -1 }, ['photoCount']],
    ['a duration of 0', { durationMinutes: 0 }, ['durationMinutes']],
    ['a negative duration', { durationMinutes: -30 }, ['durationMinutes']],
    ['a duration past int4', { durationMinutes: INT4_MAX + 1 }, ['durationMinutes']],
    ['a blank name', { nameEn: '  ' }, ['nameEn']],
    ['a negative sort order', { sortOrder: -1 }, ['sortOrder']],
    ['a description over 5000 characters', { descriptionEn: 'd'.repeat(5001) }, ['descriptionEn']],
    ['several rules at once', { priceRwf: -1, durationMinutes: 0 }, ['priceRwf', 'durationMinutes']],
  ])('refuses %s with 422 naming the fields, writing nothing', async (_label, extra, fields) => {
    expectValidationFailed(await send('post', PACKAGES, packageBody(serviceId, extra)), fields);
    expect(await prisma.package.count()).toBe(0);
  });

  it('refuses a serviceId naming no service with 422, writing nothing', async () => {
    expectValidationFailed(await send('post', PACKAGES, packageBody(NONEXISTENT_ID)), ['serviceId']);
    expect(await prisma.package.count()).toBe(0);
  });
});

describe('PATCH /api/admin/packages/:id', () => {
  beforeEach(seedWeekdayHours);

  it('changes only the fields it names', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id, { descriptionEn: 'One look.' });

    const res = await send('patch', `${PACKAGES}/${pkg.id}`, { priceRwf: 55_000, isActive: false });

    expect(bodyOf<PackageSavedJson>(res, 200)).toEqual({
      package: {
        id: pkg.id,
        serviceId: service.id,
        nameEn: 'Standard',
        nameFr: null,
        descriptionEn: 'One look.',
        descriptionFr: null,
        priceRwf: 55_000,
        photoCount: 20,
        durationMinutes: 60,
        isActive: false,
        sortOrder: 0,
      },
      warning: null,
    });
  });

  it('answers an empty object with 200 and the package unchanged', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id);
    const before = await getCatalogue();

    const res = await send('patch', `${PACKAGES}/${pkg.id}`, {});

    expect(bodyOf<PackageSavedJson>(res, 200)).toMatchObject({ package: { id: pkg.id, priceRwf: 40_000 }, warning: null });
    expect(await getCatalogue()).toEqual(before);
  });

  it.each<[string, (otherServiceId: string) => unknown]>([
    ['moving it to another service', (other) => ({ serviceId: other })],
    ['a null serviceId', () => ({ serviceId: null })],
    ['an unknown key', () => ({ slug: 'standard' })],
    ['a string price', () => ({ priceRwf: '55000' })],
    ['a null name', () => ({ nameEn: null })],
    ['a null duration', () => ({ durationMinutes: null })],
  ])('refuses %s with 400, leaving the row as it was', async (_label, body) => {
    const service = await insertService('portraits');
    const other = await insertService('events');
    const pkg = await insertPackage(service.id);

    expectInvalidRequest(await send('patch', `${PACKAGES}/${pkg.id}`, body(other.id)));
    await expect(prisma.package.findUniqueOrThrow({ where: { id: pkg.id } })).resolves.toEqual(pkg);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['a negative price', { priceRwf: -5 }, ['priceRwf']],
    ['a duration of 0', { durationMinutes: 0 }, ['durationMinutes']],
    ['a blank name', { nameEn: '' }, ['nameEn']],
    ['a photo count past int4', { photoCount: INT4_MAX + 1 }, ['photoCount']],
  ])('refuses %s with 422, leaving the row as it was', async (_label, body, fields) => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id);

    expectValidationFailed(await send('patch', `${PACKAGES}/${pkg.id}`, body), fields);
    await expect(prisma.package.findUniqueOrThrow({ where: { id: pkg.id } })).resolves.toEqual(pkg);
  });
});

// --- Add-ons ----------------------------------------------------------------------------

describe('POST /api/admin/addons', () => {
  let serviceId: string;

  beforeEach(async () => {
    serviceId = (await insertService('portraits')).id;
  });

  it('creates a service’s own add-on with 201', async () => {
    const res = await send('post', ADDONS, addonBody(serviceId, { nameFr: 'Heure en plus', isActive: false, sortOrder: 2 }));

    const { addon } = bodyOf<{ addon: AddonJson }>(res, 201);
    expect(addon).toEqual({
      id: expect.stringMatching(UUID) as string,
      serviceId,
      nameEn: 'Extra hour',
      nameFr: 'Heure en plus',
      priceRwf: 15_000,
      isActive: false,
      sortOrder: 2,
    });
    const catalogue = await getCatalogue();
    expect(catalogue.services[0]?.addons).toEqual([addon]);
    expect(catalogue.sharedAddons).toEqual([]);
  });

  it('creates an add-on for every service with a null serviceId', async () => {
    const res = await send('post', ADDONS, addonBody(null, { nameEn: ' Rush edit ', priceRwf: 0 }));

    const { addon } = bodyOf<{ addon: AddonJson }>(res, 201);
    expect(addon).toMatchObject({ serviceId: null, nameEn: 'Rush edit', priceRwf: 0, nameFr: null, isActive: true, sortOrder: 0 });
    const catalogue = await getCatalogue();
    expect(catalogue.sharedAddons).toEqual([addon]);
    expect(catalogue.services[0]?.addons).toEqual([]);
  });

  it('accepts a price at the int4 maximum', async () => {
    const res = await send('post', ADDONS, addonBody(serviceId, { priceRwf: INT4_MAX }));

    expect(bodyOf<{ addon: AddonJson }>(res, 201).addon.priceRwf).toBe(INT4_MAX);
  });

  it.each<[string, (id: string) => unknown]>([
    ['no serviceId -- it is required, even as null', (id) => without(addonBody(id), 'serviceId')],
    ['a malformed serviceId', (id) => addonBody(id, { serviceId: 'portraits' })],
    ['no nameEn', (id) => without(addonBody(id), 'nameEn')],
    ['no priceRwf', (id) => without(addonBody(id), 'priceRwf')],
    ['a string price', (id) => addonBody(id, { priceRwf: '15000' })],
    ['a fractional price', (id) => addonBody(id, { priceRwf: 0.5 })],
    ['a string isActive', (id) => addonBody(id, { isActive: 'yes' })],
    ['a numeric nameFr', (id) => addonBody(id, { nameFr: 3 })],
    ['a description, which add-ons do not have', (id) => addonBody(id, { descriptionEn: 'One more hour.' })],
    ['a duration, which add-ons do not have', (id) => addonBody(id, { durationMinutes: 60 })],
  ])('refuses %s with 400, writing nothing', async (_label, body) => {
    expectInvalidRequest(await send('post', ADDONS, body(serviceId)));
    expect(await prisma.addon.count()).toBe(0);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['a negative price', { priceRwf: -1 }, ['priceRwf']],
    ['a price past int4', { priceRwf: INT4_MAX + 1 }, ['priceRwf']],
    ['a blank name', { nameEn: ' ' }, ['nameEn']],
    ['a French name over 200 characters', { nameFr: 'n'.repeat(201) }, ['nameFr']],
    ['a negative sort order', { sortOrder: -2 }, ['sortOrder']],
  ])('refuses %s with 422 naming the fields, writing nothing', async (_label, extra, fields) => {
    expectValidationFailed(await send('post', ADDONS, addonBody(serviceId, extra)), fields);
    expect(await prisma.addon.count()).toBe(0);
  });

  it('refuses a serviceId naming no service with 422, writing nothing', async () => {
    expectValidationFailed(await send('post', ADDONS, addonBody(NONEXISTENT_ID)), ['serviceId']);
    expect(await prisma.addon.count()).toBe(0);
  });
});

describe('PATCH /api/admin/addons/:id', () => {
  it('changes only the fields it names', async () => {
    const service = await insertService('portraits');
    const addon = await insertAddon(service.id, { nameFr: 'Heure' });

    const res = await send('patch', `${ADDONS}/${addon.id}`, { priceRwf: 20_000, sortOrder: 4 });

    expect(bodyOf<{ addon: AddonJson }>(res, 200).addon).toEqual({
      id: addon.id,
      serviceId: service.id,
      nameEn: 'Extra hour',
      nameFr: 'Heure',
      priceRwf: 20_000,
      isActive: true,
      sortOrder: 4,
    });
  });

  it('answers an empty object with 200 and the add-on unchanged', async () => {
    const addon = await insertAddon(null);
    const before = await getCatalogue();

    expect(bodyOf<{ addon: AddonJson }>(await send('patch', `${ADDONS}/${addon.id}`, {}), 200).addon).toMatchObject({
      id: addon.id,
      serviceId: null,
    });
    expect(await getCatalogue()).toEqual(before);
  });

  it.each<[string, (serviceId: string) => unknown]>([
    ['making a service’s add-on shared', () => ({ serviceId: null })],
    ['moving it to another service', (serviceId) => ({ serviceId })],
    ['an unknown key', () => ({ photoCount: 2 })],
    ['a null price', () => ({ priceRwf: null })],
  ])('refuses %s with 400, leaving the row as it was', async (_label, body) => {
    const service = await insertService('portraits');
    const other = await insertService('events');
    const addon = await insertAddon(service.id);

    expectInvalidRequest(await send('patch', `${ADDONS}/${addon.id}`, body(other.id)));
    await expect(prisma.addon.findUniqueOrThrow({ where: { id: addon.id } })).resolves.toEqual(addon);
  });

  it('refuses to scope a shared add-on to one service with 400', async () => {
    const service = await insertService('portraits');
    const addon = await insertAddon(null);

    expectInvalidRequest(await send('patch', `${ADDONS}/${addon.id}`, { serviceId: service.id }));
    await expect(prisma.addon.findUniqueOrThrow({ where: { id: addon.id } })).resolves.toEqual(addon);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['a negative price', { priceRwf: -1 }, ['priceRwf']],
    ['a blank name', { nameEn: '' }, ['nameEn']],
  ])('refuses %s with 422, leaving the row as it was', async (_label, body, fields) => {
    const addon = await insertAddon(null);

    expectValidationFailed(await send('patch', `${ADDONS}/${addon.id}`, body), fields);
    await expect(prisma.addon.findUniqueOrThrow({ where: { id: addon.id } })).resolves.toEqual(addon);
  });
});

// --- Unknown ids ----------------------------------------------------------------------------

describe('ids that name no row', () => {
  const PATHS: [string, Record<string, unknown>][] = [
    [SERVICES, { sortOrder: 1 }],
    [PACKAGES, { sortOrder: 1 }],
    [ADDONS, { sortOrder: 1 }],
  ];
  const CASES = PATHS.flatMap(([path, body]) =>
    [NONEXISTENT_ID, ...MALFORMED_IDS].map((id) => [path, id, body] as [string, string, Record<string, unknown>]),
  );

  it.each(CASES)('PATCH %s/%s answers 404, changing nothing', async (path, id, body) => {
    const service = await insertService('portraits');
    await insertPackage(service.id);
    await insertAddon(service.id);
    const before = await catalogueRows();

    expectNotFound(await send('patch', `${path}/${id}`, body));
    expect(await catalogueRows()).toEqual(before);
  });

  it.each(CASES)('DELETE %s/%s answers 404, deleting nothing', async (path, id) => {
    const service = await insertService('portraits');
    await insertPackage(service.id);
    await insertAddon(null);
    const before = await catalogueRows();

    expectNotFound(await send('delete', `${path}/${id}`));
    expect(await catalogueRows()).toEqual(before);
  });

  it.each([SERVICES, PACKAGES, ADDONS])('has no GET by id on %s', async (path) => {
    const service = await insertService('portraits');

    expectNotFound(await send('get', `${path}/${service.id}`));
  });
});

// --- Delete -------------------------------------------------------------------------------

type Target = { path: string; find: () => Promise<object | null> };

describe('DELETE an unreferenced row', () => {
  it.each<[string, () => Promise<Target>]>([
    [
      'a service with nothing under it',
      async () => {
        const service = await insertService('portraits');
        return { path: `${SERVICES}/${service.id}`, find: () => prisma.service.findUnique({ where: { id: service.id } }) };
      },
    ],
    [
      'a package nobody booked, its service keeping',
      async () => {
        const service = await insertService('portraits');
        const pkg = await insertPackage(service.id, { isActive: false });
        return { path: `${PACKAGES}/${pkg.id}`, find: () => prisma.package.findUnique({ where: { id: pkg.id } }) };
      },
    ],
    [
      'a service’s add-on nobody booked',
      async () => {
        const service = await insertService('portraits');
        const addon = await insertAddon(service.id);
        return { path: `${ADDONS}/${addon.id}`, find: () => prisma.addon.findUnique({ where: { id: addon.id } }) };
      },
    ],
    [
      'a shared add-on nobody booked',
      async () => {
        const addon = await insertAddon(null);
        return { path: `${ADDONS}/${addon.id}`, find: () => prisma.addon.findUnique({ where: { id: addon.id } }) };
      },
    ],
  ])('deletes %s with 204, and a second delete is a 404', async (_label, arrange) => {
    const { path, find } = await arrange();
    const servicesBefore = await prisma.service.count();

    const res = await send('delete', path);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    await expect(find()).resolves.toBeNull();
    expect(await prisma.service.count()).toBe(path.startsWith(SERVICES) ? servicesBefore - 1 : servicesBefore);
    expectNotFound(await send('delete', path));
  });

  it('deletes a service once its package and add-on are gone', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id);
    const addon = await insertAddon(service.id);

    expect((await send('delete', `${SERVICES}/${service.id}`)).status).toBe(409);
    expect((await send('delete', `${PACKAGES}/${pkg.id}`)).status).toBe(204);
    expect((await send('delete', `${ADDONS}/${addon.id}`)).status).toBe(204);
    expect((await send('delete', `${SERVICES}/${service.id}`)).status).toBe(204);
    await expect(prisma.service.count()).resolves.toBe(0);
  });
});

describe('DELETE a referenced row (RESTRICT foreign keys, data-model_v2.md §9.4)', () => {
  it.each<[string, () => Promise<Target>]>([
    [
      'a package a booking was made with',
      async () => {
        const service = await insertService('portraits');
        const pkg = await insertPackage(service.id);
        await insertBooking({ serviceId: service.id, packageId: pkg.id }, 'BKY-2610-00001');
        return { path: `${PACKAGES}/${pkg.id}`, find: () => prisma.package.findUnique({ where: { id: pkg.id } }) };
      },
    ],
    [
      'an inactive package a cancelled booking was made with',
      async () => {
        const service = await insertService('portraits');
        const pkg = await insertPackage(service.id, { isActive: false });
        const booking = await insertBooking({ serviceId: service.id, packageId: pkg.id }, 'BKY-2610-00001');
        await prisma.booking.update({ where: { id: booking.id }, data: { status: 'cancelled_by_admin' } });
        return { path: `${PACKAGES}/${pkg.id}`, find: () => prisma.package.findUnique({ where: { id: pkg.id } }) };
      },
    ],
    [
      'a service that still has a package, nothing booked',
      async () => {
        const service = await insertService('portraits');
        await insertPackage(service.id);
        return { path: `${SERVICES}/${service.id}`, find: () => prisma.service.findUnique({ where: { id: service.id } }) };
      },
    ],
    [
      'a service that still has an add-on, nothing booked',
      async () => {
        const service = await insertService('portraits');
        await insertAddon(service.id);
        return { path: `${SERVICES}/${service.id}`, find: () => prisma.service.findUnique({ where: { id: service.id } }) };
      },
    ],
    [
      'a service a booking names, with no package or add-on of its own',
      async () => {
        const booked = await insertService('portraits');
        const other = await insertService('events');
        const pkg = await insertPackage(other.id);
        await insertBooking({ serviceId: booked.id, packageId: pkg.id }, 'BKY-2610-00001');
        return { path: `${SERVICES}/${booked.id}`, find: () => prisma.service.findUnique({ where: { id: booked.id } }) };
      },
    ],
    [
      'a service’s add-on a booking bought',
      async () => {
        const service = await insertService('portraits');
        const pkg = await insertPackage(service.id);
        const addon = await insertAddon(service.id);
        const booking = await insertBooking({ serviceId: service.id, packageId: pkg.id }, 'BKY-2610-00001');
        await insertBookingAddon(booking.id, addon.id);
        return { path: `${ADDONS}/${addon.id}`, find: () => prisma.addon.findUnique({ where: { id: addon.id } }) };
      },
    ],
    [
      'a shared add-on a booking bought',
      async () => {
        const service = await insertService('portraits');
        const pkg = await insertPackage(service.id);
        const addon = await insertAddon(null);
        const booking = await insertBooking({ serviceId: service.id, packageId: pkg.id }, 'BKY-2610-00001');
        await insertBookingAddon(booking.id, addon.id);
        return { path: `${ADDONS}/${addon.id}`, find: () => prisma.addon.findUnique({ where: { id: addon.id } }) };
      },
    ],
  ])('refuses %s with 409 in_use, and the row survives', async (_label, arrange) => {
    const { path, find } = await arrange();
    const before = await find();
    const bookingsBefore = await prisma.booking.findMany();
    expect(before).not.toBeNull();

    const res = await send('delete', path);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'in_use' });
    await expect(find()).resolves.toEqual(before);
    await expect(prisma.booking.findMany()).resolves.toEqual(bookingsBefore);
  });

  it('lets the same delete through once nothing references the row -- the foreign key decides', async () => {
    const service = await insertService('portraits');
    const pkg = await insertPackage(service.id);
    const booking = await insertBooking({ serviceId: service.id, packageId: pkg.id }, 'BKY-2610-00001');
    expect((await send('delete', `${PACKAGES}/${pkg.id}`)).status).toBe(409);

    await prisma.booking.delete({ where: { id: booking.id } });

    expect((await send('delete', `${PACKAGES}/${pkg.id}`)).status).toBe(204);
  });
});

// --- Impossible package warning (spec §6.8) -------------------------------------------------

type HoursRow = Prisma.WorkingHoursCreateManyInput;

function weekly(weekday: number, opensMinute: number, closesMinute: number, isOpen = true): HoursRow {
  return { weekday, opensMinute, closesMinute, isOpen };
}

function dated(date: string, opensMinute: number, closesMinute: number, isOpen = true): HoursRow {
  return { effectiveDate: new Date(`${date}T00:00:00Z`), opensMinute, closesMinute, isOpen };
}

describe('the duration warning (spec §6.8)', () => {
  const NINE_TO_FIVE = { opensMinute: 540, closesMinute: 1020 };

  async function postPackage(durationMinutes: number): Promise<PackageSavedJson> {
    const service = await insertService('portraits');
    return bodyOf<PackageSavedJson>(await send('post', PACKAGES, packageBody(service.id, { durationMinutes })), 201);
  }

  // The clock is Thursday 1 October 2026 in Kigali.
  it.each<[string, HoursRow[], number, WarningJson | null]>([
    ['exactly the weekly window', [weekly(1, 540, 1020)], 480, null],
    ['one minute past the weekly window', [weekly(1, 540, 1020)], 481, warning(NINE_TO_FIVE)],
    [
      'exactly the longest of several weekly windows',
      [weekly(1, 540, 1020), weekly(6, 480, 1080), weekly(3, 600, 720)],
      600,
      null,
    ],
    [
      'one minute past the longest of several weekly windows',
      [weekly(1, 540, 1020), weekly(6, 480, 1080), weekly(3, 600, 720)],
      601,
      warning({ opensMinute: 480, closesMinute: 1080 }),
    ],
    ['exactly a future dated override longer than any weekly rule', [weekly(1, 540, 1020), dated('2026-10-10', 360, 1260)], 900, null],
    [
      'one minute past a future dated override',
      [weekly(1, 540, 1020), dated('2026-10-10', 360, 1260)],
      901,
      warning({ opensMinute: 360, closesMinute: 1260 }),
    ],
    ['a whole day opened by today’s override', [weekly(1, 540, 1020), dated('2026-10-01', 0, 1440)], 1440, null],
    ['a window only a past override opened', [weekly(1, 540, 1020), dated('2026-09-30', 0, 1440)], 481, warning(NINE_TO_FIVE)],
    ['a window only a closed weekly row carries', [weekly(1, 540, 1020), weekly(0, 0, 1440, false)], 481, warning(NINE_TO_FIVE)],
    ['a window only a closed future override carries', [weekly(1, 540, 1020), dated('2026-10-10', 0, 1440, false)], 481, warning(NINE_TO_FIVE)],
    ['any duration with no working hours at all', [], 1, warning(null)],
    ['any duration when every row is closed or past', [weekly(0, 0, 1440, false), dated('2026-09-30', 0, 1440)], 1, warning(null)],
  ])('saving a package of %s answers the expected warning', async (_label, hours, durationMinutes, expected) => {
    await prisma.workingHours.createMany({ data: hours });

    const saved = await postPackage(durationMinutes);

    expect(saved.warning).toEqual(expected);
    await expect(prisma.package.findUniqueOrThrow({ where: { id: saved.package.id } })).resolves.toMatchObject({
      durationMinutes,
    });
  });

  it('reads today as the Kigali date, not the UTC one', async () => {
    // 22:30 UTC on 30 September is already 00:30 on 1 October in Kigali: the
    // 30th has passed there, and the 1st is today.
    await setClock(new Date('2026-09-30T22:30:00Z'));
    await prisma.workingHours.createMany({ data: [dated('2026-09-30', 0, 1440), dated('2026-10-01', 540, 1020)] });

    expect((await postPackage(481)).warning).toEqual(warning(NINE_TO_FIVE));
  });

  it('reads the injected clock on every save, so an override stops counting once its day has passed', async () => {
    await prisma.workingHours.createMany({ data: [weekly(1, 540, 1020), dated('2026-10-10', 0, 1440)] });
    const { package: pkg, warning: first } = await postPackage(1440);
    const resave = async () => bodyOf<PackageSavedJson>(await send('patch', `${PACKAGES}/${pkg.id}`, {}), 200).warning;
    expect(first).toBeNull();

    await setClock(new Date('2026-10-10T21:59:00Z')); // 23:59 on the 10th in Kigali
    expect(await resave()).toBeNull();

    await setClock(new Date('2026-10-10T22:00:00Z')); // midnight into the 11th
    expect(await resave()).toEqual(warning(NINE_TO_FIVE));
  });

  it('recomputes on PATCH from the stored duration, whichever fields changed', async () => {
    await seedWeekdayHours();
    const { package: pkg } = await postPackage(480);
    const patch = async (body: object) => bodyOf<PackageSavedJson>(await send('patch', `${PACKAGES}/${pkg.id}`, body), 200);

    const lengthened = await patch({ durationMinutes: 481 });
    expect(lengthened.warning).toEqual(warning(NINE_TO_FIVE));
    expect(lengthened.package.durationMinutes).toBe(481);

    expect((await patch({ priceRwf: 1 })).warning).toEqual(warning(NINE_TO_FIVE));
    expect((await patch({ isActive: false })).warning).toEqual(warning(NINE_TO_FIVE));
    expect((await patch({ durationMinutes: 480 })).warning).toBeNull();
  });

  it('recomputes when the hours change between saves', async () => {
    await seedWeekdayHours();
    const { package: pkg, warning: first } = await postPackage(600);
    expect(first).toEqual(warning(NINE_TO_FIVE));

    await prisma.workingHours.create({ data: weekly(6, 480, 1080) });

    expect(bodyOf<PackageSavedJson>(await send('patch', `${PACKAGES}/${pkg.id}`, {}), 200).warning).toBeNull();
  });
});

// --- French fields (spec §7) ------------------------------------------------------------------

describe('French fields', () => {
  type Entity = {
    path: string;
    key: 'service' | 'package' | 'addon';
    create: (serviceId: string) => Record<string, unknown>;
    french: Record<string, string>;
  };

  const ENTITIES: [string, Entity][] = [
    [
      'a service',
      {
        path: SERVICES,
        key: 'service',
        create: () => ({ slug: 'evenements', nameEn: 'Events', nameFr: 'Événements', descriptionFr: 'Mariages et fêtes.' }),
        french: { nameFr: 'Événements', descriptionFr: 'Mariages et fêtes.' },
      },
    ],
    [
      'a package',
      {
        path: PACKAGES,
        key: 'package',
        create: (serviceId) => packageBody(serviceId, { nameFr: 'Journée', descriptionFr: 'Du matin au soir.' }),
        french: { nameFr: 'Journée', descriptionFr: 'Du matin au soir.' },
      },
    ],
    [
      'an add-on',
      {
        path: ADDONS,
        key: 'addon',
        create: (serviceId) => addonBody(serviceId, { nameFr: 'Heure en plus' }),
        french: { nameFr: 'Heure en plus' },
      },
    ],
  ];

  it.each(ENTITIES)('are stored for %s, untouched by a PATCH that omits them, and cleared by null', async (_label, entity) => {
    await seedWeekdayHours();
    const service = await insertService('portraits');

    const created = bodyOf<Record<string, Record<string, unknown>>>(await send('post', entity.path, entity.create(service.id)), 201);
    const id = String(created[entity.key]?.id);
    expect(created[entity.key]).toMatchObject(entity.french);

    const renamed = bodyOf<Record<string, Record<string, unknown>>>(
      await send('patch', `${entity.path}/${id}`, { nameEn: 'Renamed', sortOrder: 9 }),
      200,
    );
    expect(renamed[entity.key]).toMatchObject({ ...entity.french, nameEn: 'Renamed', sortOrder: 9 });

    const nulls = Object.fromEntries(Object.keys(entity.french).map((field) => [field, null]));
    const cleared = bodyOf<Record<string, Record<string, unknown>>>(await send('patch', `${entity.path}/${id}`, nulls), 200);
    expect(cleared[entity.key]).toMatchObject({ ...nulls, nameEn: 'Renamed' });
  });

  it('stores them in the _fr columns', async () => {
    const { service } = bodyOf<{ service: ServiceJson }>(
      await send('post', SERVICES, { slug: 'evenements', nameEn: 'Events', nameFr: 'Événements', descriptionFr: 'Fêtes.' }),
      201,
    );

    const row = firstRow(await raw.query<Record<string, unknown>>('SELECT name_fr, description_fr FROM service WHERE id = $1', [service.id]));
    expect(row).toEqual({ name_fr: 'Événements', description_fr: 'Fêtes.' });
  });
});

// --- Booking-fee override (P-20) ------------------------------------------------------------------

describe('the booking-fee override', () => {
  async function overrideColumn(id: string): Promise<string | null> {
    const row = firstRow(
      await raw.query<{ rate: string | null }>('SELECT booking_fee_rate_override::text AS rate FROM service WHERE id = $1', [id]),
    );
    return row.rate;
  }

  it.each<[string, number | null, string | null]>([
    ['null (the global rate)', null, null],
    ['0.3', 0.3, '0.300'],
    ['0.125', 0.125, '0.125'],
    ['0', 0, '0.000'],
    ['1', 1, '1.000'],
  ])('round-trips %s as a JSON number, stored exactly', async (_label, rate, column) => {
    const res = await send('post', SERVICES, { ...SERVICE_BODY, bookingFeeRateOverride: rate });

    const { service } = bodyOf<{ service: ServiceJson }>(res, 201);
    expect(service.bookingFeeRateOverride).toBe(rate);
    expect(res.text).toContain(`"bookingFeeRateOverride":${JSON.stringify(rate)}`);
    expect(await overrideColumn(service.id)).toBe(column);
    expect((await getCatalogue()).services[0]?.bookingFeeRateOverride).toBe(rate);
  });

  it('is set, kept and cleared by PATCH', async () => {
    const service = await insertService('portraits');
    const patch = async (body: object) =>
      bodyOf<{ service: ServiceJson }>(await send('patch', `${SERVICES}/${service.id}`, body), 200).service.bookingFeeRateOverride;

    expect(await patch({ bookingFeeRateOverride: 0.125 })).toBe(0.125);
    expect(await patch({ nameEn: 'Portrait sessions' })).toBe(0.125);
    expect(await overrideColumn(service.id)).toBe('0.125');
    expect(await patch({ bookingFeeRateOverride: null })).toBeNull();
    expect(await overrideColumn(service.id)).toBeNull();
  });
});
