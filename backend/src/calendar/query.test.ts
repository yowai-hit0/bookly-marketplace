import type { Booking, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import type { BookingStatus } from '../db/statuses.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type Calendar, findCalendar } from './query.js';

/**
 * `findCalendar`, the admin calendar's loading, against real PostgreSQL
 * (plan.md Task 9; spec §3.3 step 1, §6.4; data-model_v2.md §7.1, §9.2).
 *
 * What is proven: which bookings occupy time on the calendar (and which live in
 * the bookings list instead), that a hold counts only while it is live by the
 * injected clock, that a range of Kigali dates is bounded by Kigali midnights,
 * that the conflict flag measures the session and not the buffer, and that each
 * entry carries exactly the admin fields -- snapshots, not the live catalogue.
 *
 * Kigali is UTC+2 with no DST. 2026-10-05 is a Monday.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let catalogue: Catalogue;

const NOW = new Date('2026-10-01T06:00:00Z');
const MINUTE_MS = 60_000;

const SUNDAY_BEFORE = '2026-10-04';
const MONDAY = '2026-10-05';
const WEDNESDAY = '2026-10-07';
const THURSDAY = '2026-10-08';
const SUNDAY = '2026-10-11';
const NEXT_MONDAY = '2026-10-12';

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
  catalogue = await insertCatalogue();
});

// --- Fixtures ---------------------------------------------------------------

type Catalogue = { serviceId: string; packageId: string; clientId: string };

/** A Kigali wall-clock time on `date`, as the UTC instant. */
function at(date: string, wallTime: string): Date {
  return new Date(`${date}T${wallTime}:00+02:00`);
}

function minutesFrom(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MINUTE_MS);
}

async function insertCatalogue(): Promise<Catalogue> {
  const service = await prisma.service.create({ data: { slug: 'portrait', nameEn: 'Portrait' } });
  const pkg = await prisma.package.create({
    data: { serviceId: service.id, nameEn: 'Standard', priceRwf: 40_000, photoCount: 20, durationMinutes: 60 },
  });
  const client = await prisma.client.create({
    data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' },
  });
  return { serviceId: service.id, packageId: pkg.id, clientId: client.id };
}

type BookingFixture = {
  reference: string;
  startsAt: Date;
  endsAt: Date;
  /** Defaults to a 30-minute buffer after `endsAt`. */
  bufferEndsAt?: Date;
  status?: BookingStatus;
  /** Defaults to a live hold (NOW + 30 min) for `pending_payment`, null otherwise. */
  holdExpiresAt?: Date | null;
  contactName?: string;
};

function insertBooking(fixture: BookingFixture): Promise<Booking> {
  const status = fixture.status ?? 'confirmed';
  const defaultHold = status === 'pending_payment' ? minutesFrom(NOW, 30) : null;
  return prisma.booking.create({
    data: {
      reference: fixture.reference,
      clientId: catalogue.clientId,
      contactName: fixture.contactName ?? 'Aline Uwase',
      contactEmail: 'aline@example.com',
      contactPhone: '+250788000000',
      serviceId: catalogue.serviceId,
      packageId: catalogue.packageId,
      serviceNameSnapshot: 'Portrait',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 40_000,
      packageDurationMinutes: 60,
      packagePhotoCount: 20,
      locationText: 'Kigali Heights',
      consentAt: NOW,
      bookingFeeRate: '0.400',
      bookingFeeRwf: 16_000,
      status,
      startsAt: fixture.startsAt,
      endsAt: fixture.endsAt,
      bufferEndsAt: fixture.bufferEndsAt ?? minutesFrom(fixture.endsAt, 30),
      holdExpiresAt: fixture.holdExpiresAt === undefined ? defaultHold : fixture.holdExpiresAt,
    },
  });
}

function insertBlock(startsAt: Date, endsAt: Date, extra: { isAllDay?: boolean; reason?: string } = {}) {
  return prisma.availabilityBlock.create({ data: { startsAt, endsAt, ...extra } });
}

/** Wednesday 09:00–10:00 Kigali, its buffer running to 10:30. */
function insertNineOClock(reference = 'BKY-2610-00001', extra: Partial<BookingFixture> = {}): Promise<Booking> {
  return insertBooking({ reference, startsAt: at(WEDNESDAY, '09:00'), endsAt: at(WEDNESDAY, '10:00'), ...extra });
}

function find(from: string, to = from, now = NOW): Promise<Calendar> {
  return findCalendar(prisma, { from, to, now });
}

function references(calendar: Calendar): string[] {
  return calendar.bookings.map((booking) => booking.reference);
}

// --- Status --------------------------------------------------------------------

describe('which bookings the calendar shows (data-model_v2.md §7.1)', () => {
  const LIVE = minutesFrom(NOW, 30);
  const LAPSED = minutesFrom(NOW, -1);

  it.each<[BookingStatus, Date | null, boolean]>([
    ['pending_payment', LIVE, true],
    ['pending_payment', LAPSED, false],
    ['confirmed', null, true],
    // Liveness filters holds only; a stale hold_expires_at left on a confirmed row changes nothing.
    ['confirmed', LAPSED, true],
    ['completed', null, true],
    ['no_show', null, true],
    ['expired', null, false],
    // A future hold_expires_at does not bring an expired booking back.
    ['expired', LIVE, false],
    ['cancelled_by_client', null, false],
    ['cancelled_by_admin', null, false],
  ])('%s with hold_expires_at %j: shown = %s', async (status, holdExpiresAt, shown) => {
    await insertNineOClock('BKY-2610-00001', { status, holdExpiresAt });

    const calendar = await find(WEDNESDAY);

    expect(references(calendar)).toEqual(shown ? ['BKY-2610-00001'] : []);
  });

  it.each<[string, number, boolean]>([
    ['a minute after now', MINUTE_MS, true],
    ['one millisecond after now', 1, true],
    ['exactly now', 0, false],
    ['one millisecond before now', -1, false],
  ])('treats a hold expiring %s as live = %s', async (_label, offsetMs, shown) => {
    await insertNineOClock('BKY-2610-00001', {
      status: 'pending_payment',
      holdExpiresAt: new Date(NOW.getTime() + offsetMs),
    });

    expect(references(await find(WEDNESDAY))).toEqual(shown ? ['BKY-2610-00001'] : []);
  });

  it('judges a hold by the injected clock, not the machine clock', async () => {
    await insertNineOClock('BKY-2610-00001', { status: 'pending_payment', holdExpiresAt: at(MONDAY, '12:00') });

    // No single real "now" could make both of these hold.
    expect(references(await find(WEDNESDAY, WEDNESDAY, new Date('2000-01-01T00:00:00Z')))).toEqual(['BKY-2610-00001']);
    expect(references(await find(WEDNESDAY, WEDNESDAY, new Date('2100-01-01T00:00:00Z')))).toEqual([]);
  });

  it('shows every occupying status side by side, and nothing else', async () => {
    const statuses: [BookingStatus, string][] = [
      ['confirmed', '08:00'],
      ['pending_payment', '09:30'],
      ['completed', '11:00'],
      ['no_show', '12:30'],
      ['expired', '14:00'],
      ['cancelled_by_client', '15:30'],
      ['cancelled_by_admin', '17:00'],
    ];
    for (const [index, [status, time]] of statuses.entries()) {
      const startsAt = at(WEDNESDAY, time);
      await insertBooking({ reference: `BKY-2610-0000${index}`, status, startsAt, endsAt: minutesFrom(startsAt, 60) });
    }

    const calendar = await find(WEDNESDAY);

    expect(calendar.bookings.map((booking) => booking.status)).toEqual([
      'confirmed',
      'pending_payment',
      'completed',
      'no_show',
    ]);
  });
});

// --- Range -----------------------------------------------------------------------

describe('a range of Kigali dates, bounded by Kigali midnights', () => {
  it.each<[string, boolean, Date, Date]>([
    ['starts at 00:00 Kigali on the first day (22:00 UTC the day before)', true, at(MONDAY, '00:00'), at(MONDAY, '01:00')],
    ['ends exactly at 00:00 Kigali on the first day', false, at(SUNDAY_BEFORE, '23:00'), at(MONDAY, '00:00')],
    ['crosses 00:00 Kigali into the first day', true, at(SUNDAY_BEFORE, '23:30'), at(MONDAY, '00:30')],
    ['runs 23:00–24:00 Kigali on the last day', true, at(SUNDAY, '23:00'), at(NEXT_MONDAY, '00:00')],
    ['starts at 00:00 Kigali the day after the last', false, at(NEXT_MONDAY, '00:00'), at(NEXT_MONDAY, '01:00')],
    ['starts 01:00 Kigali the day after the last, still the last day in UTC', false, at(NEXT_MONDAY, '01:00'), at(NEXT_MONDAY, '02:00')],
  ])('a booking that %s: shown = %s', async (_label, shown, startsAt, endsAt) => {
    await insertBooking({ reference: 'BKY-2610-00001', startsAt, endsAt });

    expect(references(await find(MONDAY, SUNDAY))).toEqual(shown ? ['BKY-2610-00001'] : []);
  });

  it.each<[string, boolean, Date, Date]>([
    ['crosses 00:00 Kigali into the first day', true, at(SUNDAY_BEFORE, '20:00'), at(MONDAY, '02:00')],
    ['is the whole day before, ending exactly at 00:00 Kigali on the first day', false, at(SUNDAY_BEFORE, '00:00'), at(MONDAY, '00:00')],
    ['crosses 00:00 Kigali out of the last day', true, at(SUNDAY, '22:00'), at(NEXT_MONDAY, '03:00')],
    ['starts at 00:00 Kigali the day after the last', false, at(NEXT_MONDAY, '00:00'), at(NEXT_MONDAY, '12:00')],
    ['starts before the range and ends after it', true, at('2026-09-20', '00:00'), at('2026-10-20', '00:00')],
  ])('a block that %s: shown = %s', async (_label, shown, startsAt, endsAt) => {
    const block = await insertBlock(startsAt, endsAt);

    const calendar = await find(MONDAY, SUNDAY);

    expect(calendar.blocks.map((entry) => entry.id)).toEqual(shown ? [block.id] : []);
  });

  it('returns a multi-day block once, with its full extent, to a range that sees only one of its days', async () => {
    const block = await insertBlock(at('2026-10-03', '00:00'), at('2026-10-07', '00:00'), {
      isAllDay: true,
      reason: 'Travelling to Musanze',
    });

    const calendar = await find(MONDAY);

    expect(calendar.blocks).toEqual([
      {
        id: block.id,
        startsAt: '2026-10-02T22:00:00.000Z',
        endsAt: '2026-10-06T22:00:00.000Z',
        isAllDay: true,
        reason: 'Travelling to Musanze',
      },
    ]);
  });

  it('gives a one-day range exactly that day and not its neighbours', async () => {
    await insertBooking({ reference: 'TUE-LATE', startsAt: at('2026-10-06', '22:00'), endsAt: at('2026-10-06', '23:00') });
    await insertBooking({ reference: 'WED-EARLY', startsAt: at(WEDNESDAY, '00:30'), endsAt: at(WEDNESDAY, '01:30') });
    await insertBooking({ reference: 'WED-LATE', startsAt: at(WEDNESDAY, '22:30'), endsAt: at(WEDNESDAY, '23:30') });
    await insertBooking({ reference: 'THU-EARLY', startsAt: at(THURSDAY, '00:30'), endsAt: at(THURSDAY, '01:30') });

    expect(references(await find(WEDNESDAY))).toEqual(['WED-EARLY', 'WED-LATE']);
  });

  it('answers empty lists for a range with nothing in it', async () => {
    await insertNineOClock();
    await insertBlock(at(WEDNESDAY, '14:00'), at(WEDNESDAY, '16:00'));

    await expect(find(MONDAY, '2026-10-06')).resolves.toEqual({ bookings: [], blocks: [] });
  });
});

// --- Conflict ----------------------------------------------------------------------

describe('conflictsWithBlock (spec §6.4 aftermath)', () => {
  it.each<[string, boolean, Date, Date]>([
    ['covers the session exactly', true, at(WEDNESDAY, '09:00'), at(WEDNESDAY, '10:00')],
    ['overlaps the second half of the session', true, at(WEDNESDAY, '09:30'), at(WEDNESDAY, '11:00')],
    ['overlaps the session start by a minute', true, at(WEDNESDAY, '08:00'), at(WEDNESDAY, '09:01')],
    ['sits inside the session', true, at(WEDNESDAY, '09:15'), at(WEDNESDAY, '09:45')],
    ['contains the session', true, at(WEDNESDAY, '08:00'), at(WEDNESDAY, '12:00')],
    ['is the whole day, all-day', true, at(WEDNESDAY, '00:00'), at(THURSDAY, '00:00')],
    ['began days before the range and ends after it', true, at('2026-10-01', '00:00'), at('2026-10-10', '00:00')],
    ['ends exactly when the session starts', false, at(WEDNESDAY, '08:00'), at(WEDNESDAY, '09:00')],
    ['starts exactly when the session ends', false, at(WEDNESDAY, '10:00'), at(WEDNESDAY, '11:00')],
    ['covers only the trailing buffer', false, at(WEDNESDAY, '10:00'), at(WEDNESDAY, '10:30')],
    ['starts inside the buffer', false, at(WEDNESDAY, '10:15'), at(WEDNESDAY, '12:00')],
    ['is on another day of the range', false, at(THURSDAY, '09:00'), at(THURSDAY, '10:00')],
  ])('conflictsWithBlock is %s for a block that %s', async (_label, conflicts, startsAt, endsAt) => {
    await insertNineOClock();
    await insertBlock(startsAt, endsAt);

    const calendar = await find(MONDAY, SUNDAY);

    expect(calendar.bookings.map((booking) => booking.conflictsWithBlock)).toEqual([conflicts]);
  });

  it('is false for every booking when there are no blocks', async () => {
    await insertNineOClock('BKY-2610-00001');
    await insertBooking({ reference: 'BKY-2610-00002', startsAt: at(THURSDAY, '09:00'), endsAt: at(THURSDAY, '10:00') });

    const calendar = await find(MONDAY, SUNDAY);

    expect(calendar.bookings.map((booking) => booking.conflictsWithBlock)).toEqual([false, false]);
  });

  it('flags only the bookings a block overlaps, among several', async () => {
    await insertNineOClock('MORNING');
    await insertBooking({ reference: 'AFTERNOON', startsAt: at(WEDNESDAY, '14:00'), endsAt: at(WEDNESDAY, '15:00') });
    await insertBooking({ reference: 'THURSDAY', startsAt: at(THURSDAY, '14:00'), endsAt: at(THURSDAY, '15:00') });
    await insertBlock(at(WEDNESDAY, '13:00'), at(WEDNESDAY, '17:00'), { reason: 'Clinic' });

    const calendar = await find(MONDAY, SUNDAY);

    expect(calendar.bookings.map((booking) => [booking.reference, booking.conflictsWithBlock])).toEqual([
      ['MORNING', false],
      ['AFTERNOON', true],
      ['THURSDAY', false],
    ]);
  });
});

// --- Entries ---------------------------------------------------------------------------

describe('what each entry carries', () => {
  it('maps a booking and a block to exactly the admin fields, as UTC ISO strings', async () => {
    const booking = await insertNineOClock('BKY-2610-00001', { contactName: 'Grace Mukamana' });
    const block = await insertBlock(at(WEDNESDAY, '09:30'), at(WEDNESDAY, '11:00'), { reason: 'Clinic' });

    const calendar = await find(WEDNESDAY);

    expect(calendar).toEqual({
      bookings: [
        {
          id: booking.id,
          reference: 'BKY-2610-00001',
          status: 'confirmed',
          startsAt: '2026-10-07T07:00:00.000Z',
          endsAt: '2026-10-07T08:00:00.000Z',
          contactName: 'Grace Mukamana',
          serviceName: 'Portrait',
          packageName: 'Standard',
          conflictsWithBlock: true,
        },
      ],
      blocks: [
        {
          id: block.id,
          startsAt: '2026-10-07T07:30:00.000Z',
          endsAt: '2026-10-07T09:00:00.000Z',
          isAllDay: false,
          reason: 'Clinic',
        },
      ],
    });
  });

  it('carries no buffer, contact details, hold expiry or foreign keys', async () => {
    const booking = await insertNineOClock('BKY-2610-00001', { status: 'pending_payment' });
    await insertBlock(at(WEDNESDAY, '14:00'), at(WEDNESDAY, '16:00'));

    const calendar = await find(WEDNESDAY);

    expect(calendar.bookings.map((entry) => Object.keys(entry).sort())).toEqual([
      ['conflictsWithBlock', 'contactName', 'endsAt', 'id', 'packageName', 'reference', 'serviceName', 'startsAt', 'status'],
    ]);
    expect(calendar.blocks.map((entry) => Object.keys(entry).sort())).toEqual([
      ['endsAt', 'id', 'isAllDay', 'reason', 'startsAt'],
    ]);
    const json = JSON.stringify(calendar);
    const absent = [
      booking.contactEmail,
      booking.contactPhone,
      booking.bufferEndsAt.toISOString(),
      booking.holdExpiresAt?.toISOString(),
      catalogue.clientId,
      catalogue.serviceId,
      catalogue.packageId,
    ];
    for (const value of absent) {
      expect(value).toBeDefined();
      expect(json).not.toContain(value);
    }
  });

  it('names the service and package from the booking snapshots, not the renamed catalogue', async () => {
    await insertNineOClock();
    await prisma.service.update({ where: { id: catalogue.serviceId }, data: { nameEn: 'Portraits 2027' } });
    await prisma.package.update({ where: { id: catalogue.packageId }, data: { nameEn: 'Premium' } });

    const [entry] = (await find(WEDNESDAY)).bookings;

    expect(entry).toMatchObject({ serviceName: 'Portrait', packageName: 'Standard' });
  });

  it('orders bookings and blocks by start, whatever order they were saved in', async () => {
    await insertBooking({ reference: 'THIRD', startsAt: at(THURSDAY, '09:00'), endsAt: at(THURSDAY, '10:00') });
    await insertBooking({ reference: 'FIRST', startsAt: at(MONDAY, '15:00'), endsAt: at(MONDAY, '16:00') });
    await insertBooking({ reference: 'SECOND', startsAt: at(WEDNESDAY, '09:00'), endsAt: at(WEDNESDAY, '10:00') });
    const late = await insertBlock(at(SUNDAY, '10:00'), at(SUNDAY, '11:00'));
    const early = await insertBlock(at(SUNDAY_BEFORE, '12:00'), at(MONDAY, '12:00'));
    const middle = await insertBlock(at(WEDNESDAY, '00:00'), at(THURSDAY, '00:00'), { isAllDay: true });

    const calendar = await find(MONDAY, SUNDAY);

    expect(references(calendar)).toEqual(['FIRST', 'SECOND', 'THIRD']);
    expect(calendar.blocks.map((block) => block.id)).toEqual([early.id, middle.id, late.id]);
  });
});
