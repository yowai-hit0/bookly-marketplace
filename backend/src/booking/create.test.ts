import type { Addon, Package, PrismaClient, Service } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { sqlstateOf } from '../db/errors.js';
import { updatePhotographerSettings, updatePlatformSettings } from '../settings/index.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import { PHOTOGRAPHER_EMAIL, PHOTOGRAPHER_HANDLE, createPhotographer, grantAccessToken, insertPayment } from '../test/payment-fixtures.js';
import { cancelByClient } from './cancel.js';
import { type BookingRequest, type CreateBookingResult, MAX_LIVE_HOLDS_PER_EMAIL, MAX_REFERENCE_ATTEMPTS, createBooking } from './create.js';

/**
 * Booking creation against real PostgreSQL (plan.md Task 13; spec §3.1 steps
 * 6-8, §6.1, §6.13; data-model_v2.md §5.8-§5.10, §9.2, §9.5).
 *
 * What is proven: a success writes one `pending_payment` booking, one client
 * (matched on lowercased email) and `at_booking` add-on rows, with every
 * snapshot populated from the catalogue as it stood; later catalogue, settings
 * and client edits change none of it; the range, buffer, hold and consent are
 * written from the right clocks; the reference has its shape and a collision is
 * retried; nothing the engine would not offer is booked, and a refusal writes
 * nothing; a race lost inside the claim leaves no client behind and overwrites
 * no one's details; and concurrent creations converge on one booking per slot
 * and one client per email.
 *
 * Per photographer (marketplace-spec.md R1.3, R1.5; brief decisions 2, 4, 5):
 * the booking is the package's photographer's, priced and buffered by their
 * settings and checked against their calendar alone; the hold is the
 * platform's; another photographer's add-on and an unbookable photographer's
 * package are refused like anything else the public cannot book; and the cap
 * of three live holds spans every photographer.
 *
 * Kigali is UTC+2 with no DST. The injected clock is Thursday 1 October 2026,
 * 08:00 Kigali, so the earliest bookable start that day is 10:00.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let catalogue: Catalogue;
/** The approved photographer who owns `catalogue`. */
let photographerId: string;

const NOW = new Date('2026-10-01T06:00:00Z');
const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;
const KIGALI_OFFSET_MS = 120 * MINUTE_MS;
/** Seconds of slack for a value measured against a clock that keeps running. */
const CLOCK_TOLERANCE_MS = 5_000;

const REFERENCE = /^BKY-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$/;

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
});

afterAll(async () => {
  // Leave no edited setting behind for a suite that seeds instead of truncating.
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  // The platform's 30-minute hold, and a photographer at the defaults: 0.400 / 120 / 30 / 90.
  await prisma.platformSetting.create({ data: { id: 1 } });
  ({ photographerId } = await createPhotographer(prisma, { email: PHOTOGRAPHER_EMAIL, handle: PHOTOGRAPHER_HANDLE, displayName: 'Kigali Lens' }));
  await weekdayHours(photographerId);
  catalogue = await seedCatalogue(photographerId);
});

// --- Fixtures ---------------------------------------------------------------

type Catalogue = {
  portraits: Service;
  weddings: Service;
  events: Service;
  /** 40,000 RWF, 25 photos, 90 minutes. */
  standard: Package;
  retired: Package;
  /** 40,000 RWF, 150 photos, 60 minutes, at the Weddings 30% override. */
  fullDay: Package;
  /** Active, but on the inactive Events service. */
  halfDay: Package;
  /** Portraits' own, 10,000 RWF. */
  extraHour: Addon;
  oldFrame: Addon;
  /** Weddings' own, 10,000 RWF. */
  secondShooter: Addon;
  /** Offered on every service, 5,000 RWF. */
  rushEdit: Addon;
};

/** The weekly rule sign-up gives a photographer: Mon–Fri 09:00–17:00. */
async function weekdayHours(owner: string): Promise<void> {
  await prisma.workingHours.createMany({
    data: [1, 2, 3, 4, 5].map((weekday) => ({ photographerId: owner, weekday, opensMinute: 540, closesMinute: 1020 })),
  });
}

async function seedCatalogue(owner: string): Promise<Catalogue> {
  const portraits = await prisma.service.create({ data: { photographerId: owner, slug: 'portraits', nameEn: 'Portraits' } });
  const weddings = await prisma.service.create({
    data: { photographerId: owner, slug: 'weddings', nameEn: 'Weddings', bookingFeeRateOverride: '0.300', sortOrder: 1 },
  });
  const events = await prisma.service.create({
    data: { photographerId: owner, slug: 'events', nameEn: 'Events', isActive: false, sortOrder: 2 },
  });
  const pkg = (serviceId: string, nameEn: string, priceRwf: number, photoCount: number, durationMinutes: number, isActive = true) =>
    prisma.package.create({ data: { photographerId: owner, serviceId, nameEn, priceRwf, photoCount, durationMinutes, isActive } });
  const addon = (serviceId: string | null, nameEn: string, priceRwf: number, isActive = true) =>
    prisma.addon.create({ data: { photographerId: owner, serviceId, nameEn, priceRwf, isActive } });
  return {
    portraits,
    weddings,
    events,
    standard: await pkg(portraits.id, 'Standard', 40_000, 25, 90),
    retired: await pkg(portraits.id, 'Retired', 1, 1, 60, false),
    fullDay: await pkg(weddings.id, 'Full day', 40_000, 150, 60),
    halfDay: await pkg(events.id, 'Half day', 30_000, 50, 60),
    extraHour: await addon(portraits.id, 'Extra hour', 10_000),
    oldFrame: await addon(portraits.id, 'Old frame', 2_000, false),
    secondShooter: await addon(weddings.id, 'Second shooter', 10_000),
    rushEdit: await addon(null, 'Rush edit', 5_000),
  };
}

/** A Kigali wall-clock time on `date`, as the UTC instant. */
function kigali(date: string, wallTime: string): Date {
  return new Date(`${date}T${wallTime}:00+02:00`);
}

const WEDNESDAY = '2026-10-07';
const THURSDAY = '2026-10-08';
const FRIDAY = '2026-10-09';

function bookingRequest(overrides: Partial<BookingRequest> = {}): BookingRequest {
  return {
    packageId: catalogue.standard.id,
    addonIds: [],
    startsAt: kigali(WEDNESDAY, '09:00'),
    fullName: 'Aline Uwase',
    email: 'aline@example.com',
    phone: '+250788123456',
    locationText: 'Kigali Heights, KG 7 Ave',
    partySize: 3,
    specialRequests: 'Golden hour if possible.',
    ...overrides,
  };
}

function create(overrides: Partial<BookingRequest> = {}, deps: { now?: () => Date; newReference?: (at: Date) => string } = {}) {
  return createBooking({ prisma, now: deps.now ?? (() => NOW), newReference: deps.newReference }, bookingRequest(overrides));
}

function created(result: CreateBookingResult) {
  if (result.status !== 'created') throw new Error(`Expected 'created', got ${JSON.stringify(result)}`);
  return result;
}

type StoredBooking = {
  reference: string;
  status: string;
  client_id: string;
  service_id: string;
  package_id: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  locale: string;
  service_name_snapshot: string;
  package_name_snapshot: string;
  package_price_rwf: number;
  package_duration_minutes: number;
  package_photo_count: number;
  starts_at_ms: number;
  ends_at_ms: number;
  buffer_ends_at_ms: number;
  hold_expires_at_ms: number | null;
  consent_at_ms: number;
  location_text: string;
  party_size: number | null;
  special_requests: string | null;
  booking_fee_rate: string;
  booking_fee_rwf: number;
  confirmed_at: Date | null;
  access_token_hash: string | null;
  original_starts_at: Date | null;
};

/** One booking as PostgreSQL stores it: instants as epoch ms, the rate as its numeric text. */
async function storedBooking(reference: string): Promise<StoredBooking> {
  const result = await raw.query<Record<string, unknown>>(
    `SELECT reference, status, client_id, service_id, package_id,
            contact_name, contact_email, contact_phone, locale,
            service_name_snapshot, package_name_snapshot, package_price_rwf,
            package_duration_minutes, package_photo_count,
            (extract(epoch from starts_at) * 1000)::bigint AS starts_at_ms,
            (extract(epoch from ends_at) * 1000)::bigint AS ends_at_ms,
            (extract(epoch from buffer_ends_at) * 1000)::bigint AS buffer_ends_at_ms,
            (extract(epoch from hold_expires_at) * 1000)::bigint AS hold_expires_at_ms,
            (extract(epoch from consent_at) * 1000)::bigint AS consent_at_ms,
            location_text, party_size, special_requests,
            booking_fee_rate::text AS booking_fee_rate, booking_fee_rwf,
            confirmed_at, access_token_hash, original_starts_at
       FROM booking WHERE reference = $1`,
    [reference],
  );
  const row = firstRow(result);
  const ms = (value: unknown) => (value === null ? null : Number(value));
  return {
    ...row,
    starts_at_ms: Number(row.starts_at_ms),
    ends_at_ms: Number(row.ends_at_ms),
    buffer_ends_at_ms: Number(row.buffer_ends_at_ms),
    hold_expires_at_ms: ms(row.hold_expires_at_ms),
    consent_at_ms: Number(row.consent_at_ms),
  } as StoredBooking;
}

type StoredAddon = {
  addon_id: string;
  name_snapshot: string;
  unit_price_rwf: number;
  quantity: number;
  amount_rwf: number;
  stage: string;
};

async function storedAddons(reference: string): Promise<StoredAddon[]> {
  const result = await raw.query<StoredAddon>(
    `SELECT ba.addon_id, ba.name_snapshot, ba.unit_price_rwf, ba.quantity, ba.amount_rwf, ba.stage
       FROM booking_addon ba JOIN booking b ON b.id = ba.booking_id
      WHERE b.reference = $1
      ORDER BY ba.name_snapshot`,
    [reference],
  );
  return result.rows;
}

async function databaseNowMs(): Promise<number> {
  const result = await raw.query<{ ms: string }>(`SELECT (extract(epoch from now()) * 1000)::bigint AS ms`);
  return Number(firstRow(result).ms);
}

type Counts = { bookings: number; clients: number; addons: number };

async function counts(): Promise<Counts> {
  const [bookings, clients, addons] = await Promise.all([
    prisma.booking.count(),
    prisma.client.count(),
    prisma.bookingAddon.count(),
  ]);
  return { bookings, clients, addons };
}

/** A booking in whatever state a test needs, written directly, never through createBooking. */
async function insertExistingBooking(options: {
  reference: string;
  startsAt: Date;
  durationMinutes?: number;
  bufferMinutes?: number;
  status?: string;
  holdExpiresAt?: Date | null;
  email?: string;
  /** Another photographer's booking: their own catalogue. Default: the world photographer's. */
  owner?: { photographerId: string; catalogue: Catalogue };
}) {
  const { durationMinutes = 90, bufferMinutes = 30, status = 'confirmed', holdExpiresAt = null } = options;
  const owner = options.owner ?? { photographerId, catalogue };
  const email = options.email ?? `rival-${options.reference.toLowerCase()}@example.com`;
  const client = await prisma.client.create({ data: { fullName: 'Rival Visitor', email, phone: '+250788999999' } });
  const endsAt = new Date(options.startsAt.getTime() + durationMinutes * MINUTE_MS);
  return prisma.booking.create({
    data: {
      reference: options.reference,
      photographerId: owner.photographerId,
      clientId: client.id,
      contactName: 'Rival Visitor',
      contactEmail: email,
      contactPhone: '+250788999999',
      serviceId: owner.catalogue.portraits.id,
      packageId: owner.catalogue.standard.id,
      serviceNameSnapshot: 'Portraits',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 40_000,
      packageDurationMinutes: durationMinutes,
      packagePhotoCount: 25,
      startsAt: options.startsAt,
      endsAt,
      bufferEndsAt: new Date(endsAt.getTime() + bufferMinutes * MINUTE_MS),
      status,
      holdExpiresAt,
      locationText: 'Elsewhere',
      consentAt: NOW,
      bookingFeeRate: '0.400',
      bookingFeeRwf: 16_000,
      clientCancelCutoffHours: 0,
      bookingFeeRefundableOnClientCancel: false,
    },
  });
}

/**
 * The root client with a competing booking slipped in immediately before the
 * claim transaction opens -- after the availability check has already passed.
 * That is the race the engine cannot see and the claim must lose cleanly.
 */
function withRivalBeforeClaim(rival: () => Promise<unknown>): PrismaClient {
  let fired = false;
  return new Proxy(prisma, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property === '$transaction' && typeof value === 'function') {
        return async (...args: unknown[]) => {
          if (!fired) {
            fired = true;
            await rival();
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The first Kigali Wednesday at least `days` after `instant`. */
function kigaliWednesdayAfter(instant: number, days: number): string {
  for (let t = instant + days * DAY_MS; ; t += DAY_MS) {
    const local = new Date(t + KIGALI_OFFSET_MS);
    if (local.getUTCDay() === 3) return local.toISOString().slice(0, 10);
  }
}

// --- A successful booking ---------------------------------------------------

describe('a successful booking', () => {
  it('creates one pending_payment booking, one client and at_booking add-on rows', async () => {
    const { extraHour, rushEdit } = catalogue;

    const result = created(await create({ addonIds: [rushEdit.id, extraHour.id] }));

    await expect(counts()).resolves.toEqual({ bookings: 1, clients: 1, addons: 2 });
    const booking = await storedBooking(result.booking.reference);
    expect(booking.status).toBe('pending_payment');
    expect(result.booking.status).toBe('pending_payment');
    await expect(storedAddons(result.booking.reference)).resolves.toStrictEqual([
      { addon_id: extraHour.id, name_snapshot: 'Extra hour', unit_price_rwf: 10_000, quantity: 1, amount_rwf: 10_000, stage: 'at_booking' },
      { addon_id: rushEdit.id, name_snapshot: 'Rush edit', unit_price_rwf: 5_000, quantity: 1, amount_rwf: 5_000, stage: 'at_booking' },
    ]);

    const client = await prisma.client.findFirstOrThrow();
    expect(client).toMatchObject({ fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788123456', anonymizedAt: null });
    expect(booking.client_id).toBe(client.id);
  });

  it('writes no add-on rows for a basket without add-ons', async () => {
    const result = created(await create());

    await expect(counts()).resolves.toEqual({ bookings: 1, clients: 1, addons: 0 });
    await expect(storedAddons(result.booking.reference)).resolves.toEqual([]);
  });

  it('populates every snapshot column from the catalogue and the form', async () => {
    const { portraits, standard, extraHour } = catalogue;

    const result = created(await create({ addonIds: [extraHour.id] }));
    const booking = await storedBooking(result.booking.reference);

    expect(booking.service_id).toBe(portraits.id);
    expect(booking.package_id).toBe(standard.id);
    expect(booking.service_name_snapshot).toBe('Portraits');
    expect(booking.package_name_snapshot).toBe('Standard');
    expect(booking.package_price_rwf).toBe(40_000);
    expect(booking.package_duration_minutes).toBe(90);
    expect(booking.package_photo_count).toBe(25);
    expect(booking.contact_name).toBe('Aline Uwase');
    expect(booking.contact_email).toBe('aline@example.com');
    expect(booking.contact_phone).toBe('+250788123456');
    // 40,000 + 10,000 at the global 40%.
    expect(booking.booking_fee_rate).toBe('0.400');
    expect(booking.booking_fee_rwf).toBe(20_000);
    expect(booking.locale).toBe('en');
    expect(booking.location_text).toBe('Kigali Heights, KG 7 Ave');
    expect(booking.party_size).toBe(3);
    expect(booking.special_requests).toBe('Golden hour if possible.');
    // Nothing a later step owns is written now.
    expect(booking.confirmed_at).toBeNull();
    expect(booking.access_token_hash).toBeNull();
    expect(booking.original_starts_at).toBeNull();
  });

  it('snapshots the service’s own rate when it overrides the global one: 15,000 at 30%', async () => {
    const { weddings, fullDay, secondShooter } = catalogue;

    const result = created(await create({ packageId: fullDay.id, addonIds: [secondShooter.id] }));
    const booking = await storedBooking(result.booking.reference);

    expect(booking.service_id).toBe(weddings.id);
    expect(booking.service_name_snapshot).toBe('Weddings');
    expect(booking.package_name_snapshot).toBe('Full day');
    expect(booking.package_duration_minutes).toBe(60);
    expect(booking.package_photo_count).toBe(150);
    expect(booking.booking_fee_rate).toBe('0.300');
    expect(booking.booking_fee_rwf).toBe(15_000);
  });

  it('rounds the frozen fee half-up to the franc, as the quote does', async () => {
    // 5,500 at 17.5% is exactly 962.5; float arithmetic would make it 962.
    await prisma.service.update({ where: { id: catalogue.portraits.id }, data: { bookingFeeRateOverride: '0.175' } });
    await prisma.package.update({ where: { id: catalogue.standard.id }, data: { priceRwf: 5_500 } });

    const result = created(await create());
    const booking = await storedBooking(result.booking.reference);

    expect(booking.booking_fee_rate).toBe('0.175');
    expect(booking.booking_fee_rwf).toBe(963);
    expect(result.basket.quote).toEqual({ totalRwf: 5_500, bookingFeeRwf: 963, sessionFeeRwf: 4_537 });
  });

  it('records the rate in force at creation when the photographer’s rate has been edited', async () => {
    await updatePhotographerSettings(photographerId, { bookingFeeRate: 0.375 }, prisma);

    const result = created(await create({ addonIds: [catalogue.extraHour.id] }));
    const booking = await storedBooking(result.booking.reference);

    expect(booking.booking_fee_rate).toBe('0.375');
    // 50,000 × 0.375 = 18,750.
    expect(booking.booking_fee_rwf).toBe(18_750);
  });

  it('snapshots a shared add-on booked on another service', async () => {
    const result = created(await create({ packageId: catalogue.fullDay.id, addonIds: [catalogue.rushEdit.id] }));

    await expect(storedAddons(result.booking.reference)).resolves.toStrictEqual([
      { addon_id: catalogue.rushEdit.id, name_snapshot: 'Rush edit', unit_price_rwf: 5_000, quantity: 1, amount_rwf: 5_000, stage: 'at_booking' },
    ]);
  });

  it('stores a null party size and null special requests as given', async () => {
    const result = created(await create({ partySize: null, specialRequests: null }));
    const booking = await storedBooking(result.booking.reference);

    expect(booking.party_size).toBeNull();
    expect(booking.special_requests).toBeNull();
  });

  it('returns the booking as written, with the basket it was priced from', async () => {
    const result = created(await create({ addonIds: [catalogue.rushEdit.id, catalogue.extraHour.id] }));

    const stored = await prisma.booking.findUniqueOrThrow({ where: { reference: result.booking.reference } });
    expect(result.booking).toEqual(stored);
    expect(result.basket.package.id).toBe(catalogue.standard.id);
    // Catalogue order: the service's own add-ons, then the shared ones.
    expect(result.basket.addons.map((addon) => addon.nameEn)).toEqual(['Extra hour', 'Rush edit']);
    expect(result.basket.quote).toEqual({ totalRwf: 55_000, bookingFeeRwf: 22_000, sessionFeeRwf: 33_000 });
    expect(result.basket.bookingFeeRate).toBe(0.4);
  });
});

// --- Snapshots survive edits (spec §6.13) -------------------------------------

describe('snapshots after the catalogue changes', () => {
  it('keeps every snapshot and add-on row when the package, add-ons, service and settings are edited', async () => {
    const { portraits, standard, extraHour, rushEdit } = catalogue;
    const result = created(await create({ addonIds: [extraHour.id, rushEdit.id] }));
    const reference = result.booking.reference;
    const bookingBefore = await storedBooking(reference);
    const addonsBefore = await storedAddons(reference);

    await prisma.package.update({
      where: { id: standard.id },
      data: { priceRwf: 99_000, nameEn: 'Standard (new)', durationMinutes: 150, photoCount: 5, isActive: false },
    });
    await prisma.addon.update({ where: { id: extraHour.id }, data: { priceRwf: 77_000, nameEn: 'Extra hour (new)' } });
    await prisma.addon.update({ where: { id: rushEdit.id }, data: { priceRwf: 1, isActive: false } });
    await prisma.service.update({
      where: { id: portraits.id },
      data: { nameEn: 'Portraits (renamed)', bookingFeeRateOverride: '0.900', isActive: false },
    });
    await updatePhotographerSettings(photographerId, { bookingFeeRate: 0.1, bufferMinutes: 90 }, prisma);
    await updatePlatformSettings({ holdMinutes: 5 }, prisma);

    await expect(storedBooking(reference)).resolves.toStrictEqual(bookingBefore);
    await expect(storedAddons(reference)).resolves.toStrictEqual(addonsBefore);
    // And the values are the ones from creation, not merely equal to a stale read.
    expect(bookingBefore).toMatchObject({
      service_name_snapshot: 'Portraits',
      package_name_snapshot: 'Standard',
      package_price_rwf: 40_000,
      package_duration_minutes: 90,
      package_photo_count: 25,
      booking_fee_rate: '0.400',
      booking_fee_rwf: 22_000,
    });
  });
});

// --- The client (data-model_v2.md §5.8, fix #9) -------------------------------

describe('the client a booking belongs to', () => {
  it('reuses the client for the same email in another case, refreshes its name and phone, and leaves the first booking’s contact alone', async () => {
    const first = created(await create());
    const firstBefore = await storedBooking(first.booking.reference);

    const second = created(
      await create({
        startsAt: kigali(THURSDAY, '14:00'),
        email: 'ALINE@Example.COM',
        fullName: 'Aline U. Mugisha',
        phone: '+250722000111',
      }),
    );

    await expect(prisma.client.count()).resolves.toBe(1);
    const client = await prisma.client.findFirstOrThrow();
    expect(client.fullName).toBe('Aline U. Mugisha');
    expect(client.phone).toBe('+250722000111');
    // The row keeps the address it was first made with; it is matched, not rewritten.
    expect(client.email).toBe('aline@example.com');
    expect(client.updatedAt.getTime()).toBeGreaterThan(client.createdAt.getTime());

    const firstAfter = await storedBooking(first.booking.reference);
    expect(firstAfter).toStrictEqual(firstBefore);
    expect(firstAfter.contact_phone).toBe('+250788123456');
    expect(firstAfter.contact_name).toBe('Aline Uwase');

    const secondStored = await storedBooking(second.booking.reference);
    expect(secondStored.client_id).toBe(firstAfter.client_id);
    expect(secondStored.contact_phone).toBe('+250722000111');
    expect(secondStored.contact_name).toBe('Aline U. Mugisha');
    expect(secondStored.contact_email).toBe('ALINE@Example.COM');
  });

  it('creates a separate client for a different email', async () => {
    created(await create());
    created(await create({ startsAt: kigali(THURSDAY, '14:00'), email: 'eric@example.com', fullName: 'Eric Habimana' }));

    await expect(prisma.client.count()).resolves.toBe(2);
  });

  it('matches a client that already exists from before, whatever case it was stored in', async () => {
    const existing = await prisma.client.create({
      data: { fullName: 'Old Name', email: 'Aline@Example.com', phone: '0000000' },
    });

    const result = created(await create());

    await expect(prisma.client.count()).resolves.toBe(1);
    expect(result.booking.clientId).toBe(existing.id);
    await expect(prisma.client.findUniqueOrThrow({ where: { id: existing.id } })).resolves.toMatchObject({
      fullName: 'Aline Uwase',
      phone: '+250788123456',
    });
  });
});

// --- Range, buffer, hold and consent ------------------------------------------

describe('the reserved range, the hold and consent', () => {
  it('ends at start + package duration and buffers 30 minutes past the end', async () => {
    const startsAt = kigali(WEDNESDAY, '09:00');

    const result = created(await create({ startsAt }));
    const booking = await storedBooking(result.booking.reference);

    expect(booking.starts_at_ms).toBe(startsAt.getTime());
    expect(booking.ends_at_ms).toBe(startsAt.getTime() + 90 * MINUTE_MS);
    expect(booking.buffer_ends_at_ms).toBe(booking.ends_at_ms + 30 * MINUTE_MS);
    expect(result.booking.endsAt.toISOString()).toBe('2026-10-07T08:30:00.000Z');
    expect(result.booking.bufferEndsAt.toISOString()).toBe('2026-10-07T09:00:00.000Z');
  });

  it('uses the duration of the package booked, not another', async () => {
    const startsAt = kigali(WEDNESDAY, '14:00');

    const result = created(await create({ packageId: catalogue.fullDay.id, startsAt }));
    const booking = await storedBooking(result.booking.reference);

    expect(booking.ends_at_ms - booking.starts_at_ms).toBe(60 * MINUTE_MS);
    expect(booking.buffer_ends_at_ms - booking.ends_at_ms).toBe(30 * MINUTE_MS);
  });

  it('applies an edited buffer to the next booking only', async () => {
    const first = created(await create());
    await updatePhotographerSettings(photographerId, { bufferMinutes: 45 }, prisma);

    const second = created(await create({ startsAt: kigali(THURSDAY, '14:00'), email: 'eric@example.com' }));

    const a = await storedBooking(first.booking.reference);
    const b = await storedBooking(second.booking.reference);
    expect(a.buffer_ends_at_ms - a.ends_at_ms).toBe(30 * MINUTE_MS);
    expect(b.buffer_ends_at_ms - b.ends_at_ms).toBe(45 * MINUTE_MS);
  });

  it('applies a zero buffer as no buffer at all', async () => {
    await updatePhotographerSettings(photographerId, { bufferMinutes: 0 }, prisma);

    const result = created(await create());
    const booking = await storedBooking(result.booking.reference);

    expect(booking.buffer_ends_at_ms).toBe(booking.ends_at_ms);
  });

  it('holds the slot for hold_minutes measured on the database clock, not the injected one', async () => {
    const before = await databaseNowMs();
    const result = created(await create());
    const after = await databaseNowMs();

    const booking = await storedBooking(result.booking.reference);
    expect(booking.hold_expires_at_ms).not.toBeNull();
    const hold = booking.hold_expires_at_ms ?? 0;
    expect(hold).toBeGreaterThanOrEqual(before + 30 * MINUTE_MS - CLOCK_TOLERANCE_MS);
    expect(hold).toBeLessThanOrEqual(after + 30 * MINUTE_MS + CLOCK_TOLERANCE_MS);
    // Not measured from the injected clock -- provable whenever the two clocks are apart.
    if (Math.abs(before - NOW.getTime()) > MINUTE_MS) {
      expect(Math.abs(hold - (NOW.getTime() + 30 * MINUTE_MS))).toBeGreaterThan(CLOCK_TOLERANCE_MS);
    }
    expect(result.booking.holdExpiresAt?.getTime()).toBe(hold);
  });

  it('applies an edited platform hold duration to the next booking', async () => {
    await updatePlatformSettings({ holdMinutes: 15 }, prisma);

    const before = await databaseNowMs();
    const result = created(await create());
    const after = await databaseNowMs();

    const hold = (await storedBooking(result.booking.reference)).hold_expires_at_ms ?? 0;
    expect(hold).toBeGreaterThanOrEqual(before + 15 * MINUTE_MS - CLOCK_TOLERANCE_MS);
    expect(hold).toBeLessThanOrEqual(after + 15 * MINUTE_MS + CLOCK_TOLERANCE_MS);
  });

  it('records consent at the injected now, to the millisecond', async () => {
    const now = new Date('2026-10-01T06:12:34.567Z');

    const result = created(await create({}, { now: () => now }));

    const booking = await storedBooking(result.booking.reference);
    expect(booking.consent_at_ms).toBe(now.getTime());
    expect(result.booking.consentAt.toISOString()).toBe('2026-10-01T06:12:34.567Z');
  });

  it('reads the clock once, so consent and the reference month agree', async () => {
    const now = vi.fn(() => new Date('2026-10-31T21:59:59.999Z'));

    const result = created(await create({ startsAt: kigali('2026-11-04', '09:00') }, { now }));

    expect(now).toHaveBeenCalledTimes(1);
    expect(result.booking.reference.slice(4, 8)).toBe('2610');
  });
});

// --- The reference ------------------------------------------------------------

describe('the booking reference', () => {
  it('matches BKY-YYMM-XXXXX with the Kigali month of creation', async () => {
    const result = created(await create());

    expect(result.booking.reference).toMatch(REFERENCE);
    expect(result.booking.reference.startsWith('BKY-2610-')).toBe(true);
  });

  it('takes YYMM from the Kigali creation month, not the UTC month and not the shoot month', async () => {
    // 22:30Z on 31 October is 00:30 on 1 November in Kigali. The shoot is in December.
    const now = () => new Date('2026-10-31T22:30:00Z');

    const result = created(await create({ startsAt: kigali('2026-12-02', '09:00') }, { now }));

    expect(result.booking.reference).toMatch(/^BKY-2611-[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it('passes the injected now to the reference generator', async () => {
    const newReference = vi.fn(() => 'BKY-2610-AAAAA');

    const result = created(await create({}, { newReference }));

    expect(newReference).toHaveBeenCalledTimes(1);
    expect(newReference).toHaveBeenCalledWith(NOW);
    expect(result.booking.reference).toBe('BKY-2610-AAAAA');
  });

  it('retries a collision with a fresh reference, leaving no row from the failed attempt', async () => {
    await insertExistingBooking({ reference: 'BKY-2610-TAKEN', startsAt: kigali(FRIDAY, '14:00') });
    const before = await counts();
    const newReference = vi.fn<(at: Date) => string>().mockReturnValueOnce('BKY-2610-TAKEN').mockReturnValueOnce('BKY-2610-FRESH');

    const result = created(
      await create({ email: 'first-timer@example.com', addonIds: [catalogue.extraHour.id, catalogue.rushEdit.id] }, { newReference }),
    );

    expect(result.booking.reference).toBe('BKY-2610-FRESH');
    expect(newReference).toHaveBeenCalledTimes(2);
    // One booking, one client and two add-on rows more: exactly the successful attempt.
    await expect(counts()).resolves.toEqual({
      bookings: before.bookings + 1,
      clients: before.clients + 1,
      addons: before.addons + 2,
    });
    // The rival booking holding the colliding reference is untouched.
    await expect(storedBooking('BKY-2610-TAKEN')).resolves.toMatchObject({ contact_name: 'Rival Visitor', status: 'confirmed' });
    await expect(storedAddons('BKY-2610-TAKEN')).resolves.toEqual([]);
  });

  it(`succeeds on the last of ${MAX_REFERENCE_ATTEMPTS} attempts`, async () => {
    await insertExistingBooking({ reference: 'BKY-2610-TAKEN', startsAt: kigali(FRIDAY, '14:00') });
    const references = [...Array<string>(MAX_REFERENCE_ATTEMPTS - 1).fill('BKY-2610-TAKEN'), 'BKY-2610-FRESH'];
    const newReference = vi.fn(() => references.shift() ?? 'BKY-2610-EXTRA');

    const result = created(await create({}, { newReference }));

    expect(result.booking.reference).toBe('BKY-2610-FRESH');
    expect(newReference).toHaveBeenCalledTimes(MAX_REFERENCE_ATTEMPTS);
  });

  it(`gives up after ${MAX_REFERENCE_ATTEMPTS} collisions in a row and writes nothing`, async () => {
    const existingClient = await prisma.client.create({
      data: { fullName: 'Aline Uwase (before)', email: 'aline@example.com', phone: '+250788000000' },
    });
    await insertExistingBooking({ reference: 'BKY-2610-TAKEN', startsAt: kigali(FRIDAY, '14:00') });
    const before = await counts();
    const newReference = vi.fn(() => 'BKY-2610-TAKEN');

    const attempt = create({ addonIds: [catalogue.extraHour.id] }, { newReference });

    await expect(attempt).rejects.toThrow();
    expect(newReference).toHaveBeenCalledTimes(MAX_REFERENCE_ATTEMPTS);
    await expect(counts()).resolves.toEqual(before);
    // The upsert inside each failed attempt rolled back with it.
    await expect(prisma.client.findUniqueOrThrow({ where: { id: existingClient.id } })).resolves.toMatchObject({
      fullName: 'Aline Uwase (before)',
      phone: '+250788000000',
    });
  });

  it('leaves no client behind for a brand-new email when every attempt collides', async () => {
    await insertExistingBooking({ reference: 'BKY-2610-TAKEN', startsAt: kigali(FRIDAY, '14:00') });

    await expect(create({ email: 'never-saved@example.com' }, { newReference: () => 'BKY-2610-TAKEN' })).rejects.toThrow();

    await expect(prisma.client.count({ where: { email: 'never-saved@example.com' } })).resolves.toBe(0);
  });
});

// --- What the public cannot book ----------------------------------------------

describe('a basket the public cannot book', () => {
  const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';

  it.each<[string, (c: Catalogue) => Partial<BookingRequest>, string]>([
    ['an unknown package', () => ({ packageId: NONEXISTENT_ID }), 'packageId'],
    ['an inactive package', (c) => ({ packageId: c.retired.id }), 'packageId'],
    ['an active package on an inactive service', (c) => ({ packageId: c.halfDay.id }), 'packageId'],
    ['an add-on id as the package', (c) => ({ packageId: c.extraHour.id }), 'packageId'],
    ['an unknown add-on', () => ({ addonIds: [NONEXISTENT_ID] }), 'addonIds'],
    ['an inactive add-on', (c) => ({ addonIds: [c.oldFrame.id] }), 'addonIds'],
    ['an add-on of another service', (c) => ({ addonIds: [c.secondShooter.id] }), 'addonIds'],
    ['a good add-on alongside another service’s', (c) => ({ addonIds: [c.extraHour.id, c.secondShooter.id] }), 'addonIds'],
    ['a package id as an add-on', (c) => ({ addonIds: [c.standard.id] }), 'addonIds'],
  ])('refuses %s and writes nothing', async (_label, request, field) => {
    const result = await create(request(catalogue));

    expect(result).toEqual({ status: 'invalid', fields: [field] });
    await expect(counts()).resolves.toEqual({ bookings: 0, clients: 0, addons: 0 });
  });
});

describe('a start the calendar does not offer', () => {
  it.each<[string, () => Date | Promise<Date>]>([
    ['before opening (08:30)', () => kigali(WEDNESDAY, '08:30')],
    ['at closing (17:00)', () => kigali(WEDNESDAY, '17:00')],
    ['a 90-minute session running past closing (16:00)', () => kigali(WEDNESDAY, '16:00')],
    ['in the evening', () => kigali(WEDNESDAY, '19:00')],
    ['on a Saturday', () => kigali('2026-10-10', '10:00')],
    ['on a Sunday', () => kigali('2026-10-11', '10:00')],
    ['off the 30-minute grid (09:15)', () => kigali(WEDNESDAY, '09:15')],
    ['a second off the grid', () => new Date(kigali(WEDNESDAY, '09:00').getTime() + 1_000)],
    ['a millisecond off the grid', () => new Date(kigali(WEDNESDAY, '09:00').getTime() + 1)],
    ['inside the 120-minute lead time (today 09:30)', () => kigali('2026-10-01', '09:30')],
    ['inside the lead time at the day’s opening (today 09:00)', () => kigali('2026-10-01', '09:00')],
    ['in the past', () => kigali('2026-09-30', '10:00')],
    ['years in the past', () => kigali('2020-10-07', '10:00')],
    [
      'inside an availability block',
      async () => {
        await prisma.availabilityBlock.create({ data: { photographerId, startsAt: kigali(WEDNESDAY, '12:00'), endsAt: kigali(WEDNESDAY, '14:00') } });
        return kigali(WEDNESDAY, '12:30');
      },
    ],
    [
      'a session that would run into a block',
      async () => {
        await prisma.availabilityBlock.create({ data: { photographerId, startsAt: kigali(WEDNESDAY, '12:00'), endsAt: kigali(WEDNESDAY, '14:00') } });
        return kigali(WEDNESDAY, '11:00');
      },
    ],
    [
      'on a day blocked in full',
      async () => {
        await prisma.availabilityBlock.create({
          data: { photographerId, startsAt: kigali(WEDNESDAY, '00:00'), endsAt: kigali(THURSDAY, '00:00'), isAllDay: true },
        });
        return kigali(WEDNESDAY, '09:00');
      },
    ],
    [
      'overlapping a confirmed booking',
      async () => {
        await insertExistingBooking({ reference: 'BKY-2610-CONF1', startsAt: kigali(WEDNESDAY, '09:00') });
        return kigali(WEDNESDAY, '10:00');
      },
    ],
    [
      'inside a confirmed booking’s buffer',
      async () => {
        // 09:00–10:30, buffered to 11:00.
        await insertExistingBooking({ reference: 'BKY-2610-CONF1', startsAt: kigali(WEDNESDAY, '09:00') });
        return kigali(WEDNESDAY, '10:30');
      },
    ],
    [
      'whose own buffer would run into a confirmed booking',
      async () => {
        await insertExistingBooking({ reference: 'BKY-2610-CONF1', startsAt: kigali(WEDNESDAY, '12:00') });
        // 10:00–11:30 is clear of 12:00, but its buffer runs to 12:00 exactly -- fine; 10:30 is not.
        return kigali(WEDNESDAY, '10:30');
      },
    ],
    [
      'held by a live pending booking',
      async () => {
        await insertExistingBooking({
          reference: 'BKY-2610-HOLD1',
          startsAt: kigali(WEDNESDAY, '09:00'),
          status: 'pending_payment',
          holdExpiresAt: new Date(NOW.getTime() + 10 * MINUTE_MS),
        });
        return kigali(WEDNESDAY, '09:00');
      },
    ],
    [
      'occupied by a no-show',
      async () => {
        await insertExistingBooking({ reference: 'BKY-2610-NOSHW', startsAt: kigali(WEDNESDAY, '09:00'), status: 'no_show' });
        return kigali(WEDNESDAY, '09:00');
      },
    ],
    [
      'closed by a dated override',
      async () => {
        await prisma.workingHours.create({ data: { photographerId, effectiveDate: new Date(`${WEDNESDAY}T00:00:00Z`), isOpen: false } });
        return kigali(WEDNESDAY, '09:00');
      },
    ],
  ])('refuses a start %s with startsAt, and writes nothing', async (_label, start) => {
    const startsAt = await start();
    const before = await counts();

    const result = await create({ startsAt, addonIds: [catalogue.extraHour.id] });

    expect(result).toEqual({ status: 'invalid', fields: ['startsAt'] });
    await expect(counts()).resolves.toEqual(before);
    await expect(prisma.client.count({ where: { email: 'aline@example.com' } })).resolves.toBe(0);
  });

  it('accepts the edges the refusals sit beside', async () => {
    // Exactly the lead time: 08:00 now, 10:00 start.
    created(await create({ startsAt: kigali('2026-10-01', '10:00'), email: 'a@example.com' }));
    // The last 90-minute start that fits before 17:00.
    created(await create({ startsAt: kigali(WEDNESDAY, '15:30'), email: 'b@example.com' }));
    // Starting exactly where a confirmed booking's buffer ends.
    await insertExistingBooking({ reference: 'BKY-2610-CONF1', startsAt: kigali(THURSDAY, '09:00') });
    created(await create({ startsAt: kigali(THURSDAY, '11:00'), email: 'c@example.com' }));

    await expect(prisma.booking.count()).resolves.toBe(4);
  });

  it('accepts a start given with any offset, as long as it is the same instant', async () => {
    const result = created(await create({ startsAt: new Date('2026-10-07T01:00:00-06:00') }));

    expect(result.booking.startsAt.toISOString()).toBe(kigali(WEDNESDAY, '09:00').toISOString());
  });

  it.each(['expired', 'cancelled_by_client', 'cancelled_by_photographer'])('books a start freed by a %s booking', async (status) => {
    await insertExistingBooking({ reference: 'BKY-2610-GONE1', startsAt: kigali(WEDNESDAY, '09:00'), status });

    const result = created(await create());

    expect(result.booking.startsAt.toISOString()).toBe(kigali(WEDNESDAY, '09:00').toISOString());
  });

  it('books over a hold that has lapsed on both clocks, expiring it in the same transaction', async () => {
    // Lapsed for the engine (before NOW) and for the database (before its now()).
    const lapsed = new Date(Math.min(NOW.getTime(), Date.now()) - 60 * MINUTE_MS);
    await insertExistingBooking({
      reference: 'BKY-2610-STALE',
      startsAt: kigali(WEDNESDAY, '09:00'),
      status: 'pending_payment',
      holdExpiresAt: lapsed,
    });

    created(await create());

    await expect(storedBooking('BKY-2610-STALE')).resolves.toMatchObject({ status: 'expired' });
    await expect(prisma.booking.count({ where: { status: 'pending_payment' } })).resolves.toBe(1);
  });

  it('refuses a basket problem before looking at the start', async () => {
    const result = await create({ packageId: catalogue.retired.id, startsAt: kigali('2026-10-10', '10:00') });

    expect(result).toEqual({ status: 'invalid', fields: ['packageId'] });
  });
});

// --- A race lost inside the claim (spec §6.1) ---------------------------------

describe('a race lost inside the claim', () => {
  const rival = () => insertExistingBooking({ reference: 'BKY-2610-RIVAL', startsAt: kigali(WEDNESDAY, '09:30') });

  it('answers slot_taken when a booking lands between the availability check and the claim', async () => {
    const racing = withRivalBeforeClaim(rival);

    const result = await createBooking({ prisma: racing, now: () => NOW }, bookingRequest({ addonIds: [catalogue.extraHour.id] }));

    expect(result).toEqual({ status: 'slot_taken' });
    await expect(prisma.booking.count()).resolves.toBe(1);
    await expect(prisma.bookingAddon.count()).resolves.toBe(0);
    await expect(storedBooking('BKY-2610-RIVAL')).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('leaves no client row for a brand-new email', async () => {
    const racing = withRivalBeforeClaim(rival);

    const result = await createBooking({ prisma: racing, now: () => NOW }, bookingRequest({ email: 'brand-new@example.com' }));

    expect(result).toEqual({ status: 'slot_taken' });
    await expect(prisma.client.count({ where: { email: 'brand-new@example.com' } })).resolves.toBe(0);
  });

  it('does not overwrite an existing client’s name or phone', async () => {
    const existing = await prisma.client.create({
      data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788123456' },
    });
    const racing = withRivalBeforeClaim(rival);

    const result = await createBooking(
      { prisma: racing, now: () => NOW },
      bookingRequest({ email: 'aline@example.com', fullName: 'Someone Else', phone: '+250722999999' }),
    );

    expect(result).toEqual({ status: 'slot_taken' });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after).toEqual(existing);
  });

  it('answers slot_taken for a hold the engine saw as lapsed but the database clock still holds', async () => {
    // Relative to the real database clock, so this stays true whenever it runs:
    // the hold lapses a day from now, the injected clock is two days from now.
    const dbNow = await databaseNowMs();
    const holdExpiresAt = new Date(dbNow + DAY_MS);
    const now = new Date(dbNow + 2 * DAY_MS);
    const date = kigaliWednesdayAfter(now.getTime(), 3);
    await insertExistingBooking({
      reference: 'BKY-2610-LIVE1',
      startsAt: kigali(date, '09:00'),
      status: 'pending_payment',
      holdExpiresAt,
    });
    const before = await counts();

    const result = await createBooking(
      { prisma, now: () => now },
      bookingRequest({ startsAt: kigali(date, '09:00'), email: 'brand-new@example.com', addonIds: [catalogue.rushEdit.id] }),
    );

    expect(result).toEqual({ status: 'slot_taken' });
    await expect(counts()).resolves.toEqual(before);
    // The claim only expires what the DATABASE sees as lapsed.
    await expect(storedBooking('BKY-2610-LIVE1')).resolves.toMatchObject({ status: 'pending_payment' });
  });
});

// --- Concurrency --------------------------------------------------------------

describe('concurrent creations', () => {
  it('lets exactly one of 12 simultaneous bookings of one slot through, leaving one booking and one client', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_unused, i) =>
        create({ email: `racer-${i}@example.com`, addonIds: [catalogue.extraHour.id] }),
      ),
    );

    const winners = results.filter((r) => r.status === 'created');
    const losers = results.filter((r) => r.status !== 'created');
    expect(winners).toHaveLength(1);
    for (const loser of losers) {
      expect([{ status: 'slot_taken' }, { status: 'invalid', fields: ['startsAt'] }]).toContainEqual(loser);
    }
    await expect(counts()).resolves.toEqual({ bookings: 1, clients: 1, addons: 1 });
  });

  // One round of the race above passes or fails by timing. Concurrent inserts
  // that conflict under an exclusion constraint can deadlock in PostgreSQL
  // (40P01) -- most readily on an empty table, as on a fresh database -- and
  // the lock waits can outlast Prisma's 5 s interactive transaction (P2028). A
  // loser must still read as slot_taken -- a 409 -- not a thrown error the
  // route turns into a 500, and a round must never end with nobody holding the
  // slot. Five rounds from an empty booking table make the fault show.
  it('never throws, and books the slot exactly once, over 5 rounds of 12 racing creations', { timeout: 300_000 }, async () => {
    const ROUNDS = 5;
    const outcomes: Record<string, number> = {};
    const badRounds: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      await raw.query('TRUNCATE booking_addon, booking, client CASCADE');
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_unused, i) => create({ email: `racer-${round}-${i}@example.com` })),
      );
      for (const result of results) {
        const key =
          result.status === 'fulfilled'
            ? result.value.status
            : `threw ${sqlstateOf(result.reason) ?? (result.reason as { code?: string }).code ?? String(result.reason)}`;
        outcomes[key] = (outcomes[key] ?? 0) + 1;
      }
      const { bookings, clients } = await counts();
      if (bookings !== 1 || clients !== 1) badRounds.push(`round ${round}: ${bookings} bookings, ${clients} clients`);
    }

    expect(Object.keys(outcomes).filter((key) => key.startsWith('threw')), JSON.stringify(outcomes)).toEqual([]);
    expect(badRounds, JSON.stringify(outcomes)).toEqual([]);
    expect(outcomes.created).toBe(ROUNDS);
  });

  // Six at once against a cap of three live holds per address (spec §6.22):
  // the cap is counted behind the claim's lock, so exactly three get through.
  it('gives several simultaneous first bookings from one new email, for different slots, one client and at most three holds', async () => {
    const starts = [
      kigali(WEDNESDAY, '09:00'),
      kigali(WEDNESDAY, '11:00'),
      kigali(WEDNESDAY, '13:00'),
      kigali(THURSDAY, '09:00'),
      kigali(THURSDAY, '11:00'),
      kigali(FRIDAY, '09:00'),
    ];

    const results = await Promise.all(
      starts.map((startsAt, i) =>
        create({ startsAt, email: i % 2 === 0 ? 'twin@example.com' : 'TWIN@example.com', fullName: `Twin ${i}` }),
      ),
    );

    expect(results.filter((r) => r.status === 'created')).toHaveLength(MAX_LIVE_HOLDS_PER_EMAIL);
    expect(results.filter((r) => r.status === 'too_many_holds')).toHaveLength(starts.length - MAX_LIVE_HOLDS_PER_EMAIL);
    await expect(prisma.client.count()).resolves.toBe(1);
    const client = await prisma.client.findFirstOrThrow();
    const bookings = await prisma.booking.findMany();
    expect(bookings).toHaveLength(MAX_LIVE_HOLDS_PER_EMAIL);
    expect(new Set(bookings.map((booking) => booking.clientId))).toEqual(new Set([client.id]));
    expect(new Set(bookings.map((booking) => booking.reference)).size).toBe(MAX_LIVE_HOLDS_PER_EMAIL);
  });
});

// --- Per photographer (marketplace-spec.md R1.3, R1.5; brief decisions 2, 4, 5) ---------

describe('a booking of one photographer among several', () => {
  let other: { photographerId: string; catalogue: Catalogue };

  beforeEach(async () => {
    const created = await createPhotographer(prisma, { email: 'other@bookly.example', handle: 'hills-and-light', displayName: 'Hills & Light' });
    await weekdayHours(created.photographerId);
    other = { photographerId: created.photographerId, catalogue: await seedCatalogue(created.photographerId) };
  });

  it('belongs to the package’s photographer, whatever else the request says', async () => {
    const mine = created(await create());
    const theirs = created(await create({ packageId: other.catalogue.standard.id, email: 'eric@example.com' }));

    expect(mine.booking.photographerId).toBe(photographerId);
    expect(theirs.booking.photographerId).toBe(other.photographerId);
    expect(theirs.booking.serviceId).toBe(other.catalogue.portraits.id);
  });

  it('books a time another photographer has already booked', async () => {
    await insertExistingBooking({ reference: 'BKY-2610-OTHER', startsAt: kigali(WEDNESDAY, '09:00'), owner: other });

    const result = created(await create({ startsAt: kigali(WEDNESDAY, '09:00') }));

    expect(result.booking.photographerId).toBe(photographerId);
    await expect(storedBooking('BKY-2610-OTHER')).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('is offered only the photographer’s own hours: another photographer’s Saturday is not theirs', async () => {
    await prisma.workingHours.create({
      data: { photographerId: other.photographerId, effectiveDate: new Date('2026-10-10T00:00:00Z'), opensMinute: 540, closesMinute: 1020 },
    });

    await expect(create({ startsAt: kigali('2026-10-10', '10:00') })).resolves.toEqual({ status: 'invalid', fields: ['startsAt'] });
    created(await create({ packageId: other.catalogue.standard.id, startsAt: kigali('2026-10-10', '10:00') }));
  });

  it('prices and buffers with its photographer’s settings, and holds for the platform’s minutes', async () => {
    await updatePhotographerSettings(other.photographerId, { bookingFeeRate: 0.1, bufferMinutes: 60 }, prisma);
    await updatePlatformSettings({ holdMinutes: 20 }, prisma);

    const before = await databaseNowMs();
    const theirs = created(await create({ packageId: other.catalogue.standard.id }));
    const mine = created(await create({ email: 'eric@example.com', startsAt: kigali(THURSDAY, '09:00') }));

    const theirsStored = await storedBooking(theirs.booking.reference);
    const mineStored = await storedBooking(mine.booking.reference);
    expect([theirsStored.booking_fee_rate, theirsStored.buffer_ends_at_ms - theirsStored.ends_at_ms]).toEqual(['0.100', 60 * MINUTE_MS]);
    expect([mineStored.booking_fee_rate, mineStored.buffer_ends_at_ms - mineStored.ends_at_ms]).toEqual(['0.400', 30 * MINUTE_MS]);
    for (const stored of [theirsStored, mineStored]) {
      expect(stored.hold_expires_at_ms ?? 0).toBeGreaterThanOrEqual(before + 20 * MINUTE_MS - CLOCK_TOLERANCE_MS);
      expect(stored.hold_expires_at_ms ?? 0).toBeLessThanOrEqual(before + 20 * MINUTE_MS + CLOCK_TOLERANCE_MS + 60_000);
    }
  });

  it.each<[string, () => string[]]>([
    ['their add-on for that service', () => [other.catalogue.extraHour.id]],
    ['their add-on offered on all their services (service_id null)', () => [other.catalogue.rushEdit.id]],
    ['a good add-on alongside theirs', () => [catalogue.extraHour.id, other.catalogue.rushEdit.id]],
  ])('refuses another photographer’s add-on -- %s -- and writes nothing', async (_label, addonIds) => {
    await expect(create({ addonIds: addonIds() })).resolves.toEqual({ status: 'invalid', fields: ['addonIds'] });
    await expect(counts()).resolves.toEqual({ bookings: 0, clients: 0, addons: 0 });
  });

  it.each(['pending', 'suspended'] as const)('refuses a %s photographer’s package as one that cannot be booked, and writes nothing', async (status) => {
    await prisma.photographer.update({
      where: { id: other.photographerId },
      data: { status, approvedAt: null, suspendedAt: status === 'suspended' ? NOW : null },
    });

    await expect(create({ packageId: other.catalogue.standard.id, addonIds: [other.catalogue.rushEdit.id] })).resolves.toEqual({
      status: 'invalid',
      fields: ['packageId'],
    });
    await expect(counts()).resolves.toEqual({ bookings: 0, clients: 0, addons: 0 });
  });

  it('refuses a photographer suspended after the basket was read, inside the claim, writing nothing', async () => {
    const racing = withRivalBeforeClaim(() =>
      prisma.photographer.update({ where: { id: photographerId }, data: { status: 'suspended', suspendedAt: NOW } }),
    );

    const result = await createBooking({ prisma: racing, now: () => NOW }, bookingRequest({ email: 'brand-new@example.com' }));

    expect(result).toEqual({ status: 'invalid', fields: ['packageId'] });
    await expect(counts()).resolves.toEqual({ bookings: 0, clients: 0, addons: 0 });
  });

  it('counts the three live holds per email across photographers', async () => {
    created(await create({ startsAt: kigali(WEDNESDAY, '09:00') }));
    created(await create({ startsAt: kigali(THURSDAY, '09:00') }));
    created(await create({ packageId: other.catalogue.standard.id, startsAt: kigali(WEDNESDAY, '09:00') }));

    await expect(create({ packageId: other.catalogue.standard.id, startsAt: kigali(FRIDAY, '09:00') })).resolves.toEqual({
      status: 'too_many_holds',
    });
  });

  // The claim lock is per photographer now, so the cap needs a lock of its own:
  // without one, two photographers' claims at once could each count two holds.
  it('lets at most three of six simultaneous holds from one email through, spread across two photographers', async () => {
    const results = await Promise.all(
      [WEDNESDAY, THURSDAY, FRIDAY].flatMap((date) => [
        create({ startsAt: kigali(date, '09:00'), email: 'twin@example.com' }),
        create({ packageId: other.catalogue.standard.id, startsAt: kigali(date, '09:00'), email: 'TWIN@example.com' }),
      ]),
    );

    expect(results.filter((r) => r.status === 'created')).toHaveLength(MAX_LIVE_HOLDS_PER_EMAIL);
    expect(results.filter((r) => r.status === 'too_many_holds')).toHaveLength(6 - MAX_LIVE_HOLDS_PER_EMAIL);
    await expect(prisma.booking.count()).resolves.toBe(MAX_LIVE_HOLDS_PER_EMAIL);
  });

  it('lets two photographers’ clients book the same hour at once, one booking each', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        create({ packageId: i % 2 === 0 ? catalogue.standard.id : other.catalogue.standard.id, email: `racer-${i}@example.com` }),
      ),
    );

    const winners = results.flatMap((r) => (r.status === 'created' ? [r.booking.photographerId] : []));
    expect(winners.sort()).toEqual([photographerId, other.photographerId].sort());
  });
});

// --- The cancellation policy, snapshotted (R1.8) ------------------------------------------

describe('the client cancellation policy a booking is made under', () => {
  const HOUR_MS = 60 * MINUTE_MS;

  async function policyColumns(id: string) {
    return prisma.booking.findUniqueOrThrow({
      where: { id },
      select: { clientCancelCutoffHours: true, bookingFeeRefundableOnClientCancel: true },
    });
  }

  it('is the photographer’s at the moment of booking, written on the booking', async () => {
    const lenient = created(await create()).booking;
    await updatePhotographerSettings(photographerId, { clientCancelCutoffHours: 48, bookingFeeRefundableOnClientCancel: true }, prisma);
    const strict = created(await create({ startsAt: kigali(THURSDAY, '09:00'), email: 'eric@example.com' })).booking;

    await expect(policyColumns(lenient.id)).resolves.toEqual({ clientCancelCutoffHours: 0, bookingFeeRefundableOnClientCancel: false });
    await expect(policyColumns(strict.id)).resolves.toEqual({ clientCancelCutoffHours: 48, bookingFeeRefundableOnClientCancel: true });
  });

  it('is not changed by the photographer editing their settings afterwards, and is what a cancellation obeys', async () => {
    await updatePhotographerSettings(photographerId, { clientCancelCutoffHours: 48, bookingFeeRefundableOnClientCancel: true }, prisma);
    const booking = created(await create()).booking;
    // Paid and confirmed, as the webhook would leave it.
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'confirmed', holdExpiresAt: null, confirmedAt: NOW } });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: booking.bookingFeeRwf });
    const token = await grantAccessToken(prisma, booking.id);

    // The photographer loosens one term and withdraws the other.
    await updatePhotographerSettings(photographerId, { clientCancelCutoffHours: 0, bookingFeeRefundableOnClientCancel: false }, prisma);

    await expect(policyColumns(booking.id)).resolves.toEqual({ clientCancelCutoffHours: 48, bookingFeeRefundableOnClientCancel: true });
    // A day before the shoot is inside the 48 hours the client agreed to, whatever the setting says now...
    const dayBefore = new Date(booking.startsAt.getTime() - 24 * HOUR_MS);
    await expect(cancelByClient({ prisma, now: () => dayBefore }, token)).resolves.toStrictEqual({ status: 'not_cancellable' });
    // ...and three days before, the booking fee they were promised back is owed back.
    const threeDaysBefore = new Date(booking.startsAt.getTime() - 72 * HOUR_MS);
    await expect(cancelByClient({ prisma, now: () => threeDaysBefore }, token)).resolves.toMatchObject({ status: 'cancelled' });
    const payments = await prisma.payment.findMany({ where: { bookingId: booking.id }, select: { kind: true, status: true } });
    expect(payments).toEqual([{ kind: 'booking_fee', status: 'refund_due' }]);
  });
});
