import type { Booking, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  type BookingSeed,
  type PaymentWorld,
  CLIENT,
  insertBooking,
  insertPayment,
  seedWorld,
} from '../test/payment-fixtures.js';
import { BOOKINGS_MAX_PAGE_SIZE, BOOKINGS_PAGE_SIZE, findBookings } from './admin-list.js';
import { BOOKING_STAGES, bookingStage } from './stage.js';
import { bookingTotals } from './totals.js';

/**
 * The bookings list (plan.md Task 19; spec §3.6), against real PostgreSQL.
 *
 * What is proven: the status filter takes one status or several; the date
 * bounds are Kigali days and inclusive at both ends -- a shoot at 00:00 on the
 * `from` day and one at 23:59 on the `to` day are both in, one an hour outside
 * either end is not; the search matches reference, name, email and phone
 * case-insensitively; filters combine as AND; the order is `starts_at DESC,
 * id DESC` with the id breaking real ties. Paging is by number with a total
 * (2026-09-27, replacing the cursor): pages walk the list in that order with
 * nothing repeated or skipped over an unchanged table, the total and the page
 * count follow the filter, a page past the end answers the last page, and an
 * empty list is still page 1 of 1. The page size defaults to 25 and clamps at
 * 100 however large a size is asked for; every money column on a row is
 * `bookingTotals()` and nothing else -- including the status-aware outstanding
 * that is 0 for a no-show, a cancellation or an expired hold.
 *
 * Kigali is UTC+2 with no DST, so `00:00` on 2027-03-10 is 2027-03-09T22:00Z.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The three-day window the date-bound tests filter on. */
const FROM = '2027-03-10';
const TO = '2027-03-12';

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
  world = await seedWorld(prisma);
});

// --- Helpers ----------------------------------------------------------------------------

type Seed = BookingSeed & { contactName?: string; contactEmail?: string; contactPhone?: string };

/** A booking with the contact snapshot a search test needs, which the shared fixture fixes. */
async function book(seed: Seed = {}): Promise<Booking> {
  const { contactName, contactEmail, contactPhone, ...rest } = seed;
  const booking = await insertBooking(prisma, world, rest);
  if (contactName === undefined && contactEmail === undefined && contactPhone === undefined) return booking;
  return prisma.booking.update({
    where: { id: booking.id },
    data: {
      ...(contactName === undefined ? {} : { contactName }),
      ...(contactEmail === undefined ? {} : { contactEmail }),
      ...(contactPhone === undefined ? {} : { contactPhone }),
    },
  });
}

/** A Kigali wall-clock time, as the UTC instant it is. */
function at(date: string, wallTime: string): Date {
  return new Date(`${date}T${wallTime}:00+02:00`);
}

/**
 * `count` bookings an hour apart, written in one statement. Cancelled, so the
 * exclusion constraint has no opinion about any of them, and add-on free, which
 * the paging tests do not read.
 */
async function bulkBookings(count: number, firstStart: Date): Promise<void> {
  await prisma.booking.createMany({
    data: Array.from({ length: count }, (_unused, index) => ({
      reference: `BKY-2703-${String(index).padStart(5, '0')}`,
      clientId: world.clientId,
      contactName: CLIENT.name,
      contactEmail: CLIENT.email,
      contactPhone: CLIENT.phone,
      serviceId: world.serviceId,
      packageId: world.packageId,
      serviceNameSnapshot: 'Portraits',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 40_000,
      packageDurationMinutes: 30,
      packagePhotoCount: 25,
      status: 'cancelled_by_client',
      startsAt: new Date(firstStart.getTime() + index * HOUR_MS),
      endsAt: new Date(firstStart.getTime() + index * HOUR_MS + 30 * MINUTE_MS),
      bufferEndsAt: new Date(firstStart.getTime() + index * HOUR_MS + 45 * MINUTE_MS),
      locationText: CLIENT.location,
      consentAt: new Date('2026-10-01T06:00:00Z'),
      bookingFeeRate: '0.400',
      bookingFeeRwf: 20_000,
      cancelledAt: new Date('2026-10-01T06:10:00Z'),
    })),
  });
}

/** The references a query answers, in the order it answered them. */
async function references(query: Parameters<typeof findBookings>[1] = {}): Promise<string[]> {
  const page = await findBookings(prisma, query);
  return page.bookings.map((row) => row.reference);
}

// --- The status filter --------------------------------------------------------------------

describe('filtering by status', () => {
  it('answers every booking when no status is named', async () => {
    const confirmed = await book({ status: 'confirmed' });
    const cancelled = await book({ status: 'cancelled_by_admin' });
    const pending = await book();

    expect((await references()).sort()).toEqual([confirmed.reference, cancelled.reference, pending.reference].sort());
    expect((await references({ statuses: [] })).sort()).toEqual(
      [confirmed.reference, cancelled.reference, pending.reference].sort(),
    );
  });

  it('answers only the one status named', async () => {
    const confirmed = await book({ status: 'confirmed' });
    await book({ status: 'cancelled_by_admin' });
    await book();

    expect(await references({ statuses: ['confirmed'] })).toEqual([confirmed.reference]);
  });

  it('answers the union when several statuses are named', async () => {
    const confirmed = await book({ status: 'confirmed' });
    const noShow = await book({ status: 'no_show' });
    await book({ status: 'cancelled_by_admin' });
    await book();

    expect((await references({ statuses: ['confirmed', 'no_show'] })).sort()).toEqual(
      [confirmed.reference, noShow.reference].sort(),
    );
  });

  it('answers nothing for a status nothing holds', async () => {
    await book({ status: 'confirmed' });

    expect(await findBookings(prisma, { statuses: ['expired'] })).toStrictEqual({
      bookings: [],
      total: 0,
      page: 1,
      pageSize: BOOKINGS_PAGE_SIZE,
      pageCount: 1,
    });
  });
});

// --- Kigali date bounds -------------------------------------------------------------------

describe('the from and to bounds, as Kigali days', () => {
  /** Five shoots around a three-day window: two on its edges, one inside, one an hour outside each end. */
  async function aWindowOfShoots() {
    return {
      // 23:00 Kigali the day before `from`: an hour before the window opens.
      beforeFrom: await book({ startsAt: at('2027-03-09', '23:00'), durationMinutes: 15, status: 'confirmed' }),
      fromEdge: await book({ startsAt: at(FROM, '00:00'), status: 'confirmed' }),
      middle: await book({ startsAt: at('2027-03-11', '10:00'), status: 'confirmed' }),
      toEdge: await book({ startsAt: at(TO, '23:59'), durationMinutes: 15, status: 'confirmed' }),
      // 01:00 Kigali the day after `to`: an hour after the window closes.
      afterTo: await book({ startsAt: at('2027-03-13', '01:00'), durationMinutes: 15, status: 'confirmed' }),
    };
  }

  it('includes midnight on the from day and 23:59 on the to day, and excludes an hour outside either end', async () => {
    const shoots = await aWindowOfShoots();

    expect((await references({ from: FROM, to: TO })).sort()).toEqual(
      [shoots.fromEdge.reference, shoots.middle.reference, shoots.toEdge.reference].sort(),
    );
  });

  it('takes from on its own as an open-ended lower bound', async () => {
    const shoots = await aWindowOfShoots();

    expect((await references({ from: FROM })).sort()).toEqual(
      [shoots.fromEdge.reference, shoots.middle.reference, shoots.toEdge.reference, shoots.afterTo.reference].sort(),
    );
  });

  it('takes to on its own as an open-ended upper bound', async () => {
    const shoots = await aWindowOfShoots();

    expect((await references({ to: TO })).sort()).toEqual(
      [shoots.beforeFrom.reference, shoots.fromEdge.reference, shoots.middle.reference, shoots.toEdge.reference].sort(),
    );
  });

  it('answers a single Kigali day when from and to are the same date', async () => {
    const shoots = await aWindowOfShoots();

    expect(await references({ from: '2027-03-11', to: '2027-03-11' })).toEqual([shoots.middle.reference]);
  });

  it('answers nothing when the window closes before it opens', async () => {
    await aWindowOfShoots();

    expect(await references({ from: TO, to: FROM })).toEqual([]);
  });
});

// --- Search -------------------------------------------------------------------------------

describe('searching', () => {
  async function threeClients() {
    return {
      aline: await book({
        reference: 'BKY-2703-AAAAA',
        contactName: 'Aline Uwase',
        contactEmail: 'aline@example.com',
        contactPhone: '+250788111111',
        status: 'confirmed',
      }),
      eric: await book({
        reference: 'BKY-2703-BBBBB',
        contactName: 'Eric Habimana',
        contactEmail: 'eric.habimana@mail.example',
        contactPhone: '+250722222222',
        status: 'confirmed',
      }),
      grace: await book({
        reference: 'BKY-2703-CCCCC',
        contactName: 'Grace MUKAMANA',
        contactEmail: 'grace@studio.example',
        contactPhone: '+250733333333',
        status: 'confirmed',
      }),
    };
  }

  it.each([
    ['a whole reference', 'BKY-2703-BBBBB', 'eric'],
    ['part of a reference, in the wrong case', 'bbbbb', 'eric'],
    ['a name', 'Uwase', 'aline'],
    ['a name in the wrong case', 'mukamana', 'grace'],
    ['an email', 'ERIC.HABIMANA@MAIL.EXAMPLE', 'eric'],
    ['part of an email domain', 'studio.example', 'grace'],
    ['part of a phone number', '788111', 'aline'],
  ] as const)('matches %s', async (_case, search, who) => {
    const clients = await threeClients();

    expect(await references({ search })).toEqual([clients[who].reference]);
  });

  it('matches nothing a booking does not hold', async () => {
    await threeClients();

    expect(await references({ search: 'nobody-by-that-name' })).toEqual([]);
  });

  it('ignores a search that is only whitespace, answering everything', async () => {
    const clients = await threeClients();

    expect((await references({ search: '   ' })).sort()).toEqual(
      [clients.aline.reference, clients.eric.reference, clients.grace.reference].sort(),
    );
  });

  it('trims what it is given before matching', async () => {
    const clients = await threeClients();

    expect(await references({ search: '  Uwase  ' })).toEqual([clients.aline.reference]);
  });
});

// --- Filters together ---------------------------------------------------------------------

describe('filters combined', () => {
  it('applies status, dates and search together as one AND', async () => {
    const wanted = await book({
      startsAt: at('2027-03-11', '10:00'),
      status: 'confirmed',
      contactName: 'Aline Uwase',
    });
    // Right name and date, wrong status.
    await book({ startsAt: at('2027-03-11', '14:00'), status: 'cancelled_by_admin', contactName: 'Aline Uwase' });
    // Right name and status, outside the window.
    await book({ startsAt: at('2027-03-20', '10:00'), status: 'confirmed', contactName: 'Aline Uwase' });
    // Right status and date, wrong name.
    await book({ startsAt: at('2027-03-11', '16:00'), status: 'confirmed', contactName: 'Eric Habimana' });

    expect(await references({ statuses: ['confirmed'], from: FROM, to: TO, search: 'uwase' })).toEqual([wanted.reference]);
  });
});

// --- Order --------------------------------------------------------------------------------

describe('the order', () => {
  it('puts the latest shoot first', async () => {
    const early = await book({ startsAt: at('2027-03-10', '09:00'), status: 'confirmed' });
    const late = await book({ startsAt: at('2027-03-12', '09:00'), status: 'confirmed' });
    const middle = await book({ startsAt: at('2027-03-11', '09:00'), status: 'confirmed' });

    expect(await references()).toEqual([late.reference, middle.reference, early.reference]);
  });

  it('breaks a tie on the same start by id, descending', async () => {
    const startsAt = at('2027-03-11', '09:00');
    // Cancelled, so two bookings may share an instant without the exclusion
    // constraint having a view.
    const first = await book({ startsAt, status: 'cancelled_by_client' });
    const second = await book({ startsAt, status: 'cancelled_by_client' });
    const expected = [first, second].sort((a, b) => (a.id < b.id ? 1 : -1)).map((row) => row.reference);

    expect(await references()).toEqual(expected);
  });
});

// --- Numbered pages -----------------------------------------------------------------------

describe('paging by number', () => {
  /** Five bookings an hour apart, newest first: the order the list will use. */
  async function inOrder(): Promise<string[]> {
    const created: Booking[] = [];
    for (let index = 0; index < 5; index += 1) {
      created.push(
        await book({
          startsAt: new Date(at('2027-03-11', '09:00').getTime() + index * HOUR_MS),
          durationMinutes: 30,
          status: 'confirmed',
        }),
      );
    }
    return created
      .slice()
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
      .map((row) => row.reference);
  }

  it('walks the whole list two rows at a time, with the total and the page count on every page', async () => {
    const shoots = await inOrder();

    const first = await findBookings(prisma, { page: 1, pageSize: 2 });
    expect(first.bookings.map((row) => row.reference)).toEqual([shoots[0], shoots[1]]);
    expect(first).toMatchObject({ total: 5, page: 1, pageSize: 2, pageCount: 3 });

    const second = await findBookings(prisma, { page: 2, pageSize: 2 });
    expect(second.bookings.map((row) => row.reference)).toEqual([shoots[2], shoots[3]]);
    expect(second).toMatchObject({ total: 5, page: 2, pageCount: 3 });

    const third = await findBookings(prisma, { page: 3, pageSize: 2 });
    expect(third.bookings.map((row) => row.reference)).toEqual([shoots[4]]);
    expect(third).toMatchObject({ total: 5, page: 3, pageCount: 3 });

    const walked = [...first.bookings, ...second.bookings, ...third.bookings].map((row) => row.reference);
    expect(walked).toEqual(shoots);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('answers the same rows for the same page asked twice over an unchanged table', async () => {
    await inOrder();

    const once = await findBookings(prisma, { page: 2, pageSize: 2 });
    const again = await findBookings(prisma, { page: 2, pageSize: 2 });

    expect(again.bookings.map((row) => row.id)).toEqual(once.bookings.map((row) => row.id));
  });

  it('counts a last page that is exactly full as the last page', async () => {
    await inOrder();

    const page = await findBookings(prisma, { page: 1, pageSize: 5 });

    expect(page.bookings).toHaveLength(5);
    expect(page).toMatchObject({ total: 5, page: 1, pageCount: 1 });
  });

  it('answers the last page for a page past the end, so a stale link still shows bookings', async () => {
    const shoots = await inOrder();

    const past = await findBookings(prisma, { page: 99, pageSize: 2 });

    expect(past.page).toBe(3);
    expect(past.bookings.map((row) => row.reference)).toEqual([shoots[4]]);
  });

  it('answers page 1 for a page below it', async () => {
    const shoots = await inOrder();

    for (const page of [0, -3]) {
      const answer = await findBookings(prisma, { page, pageSize: 2 });
      expect(answer.page).toBe(1);
      expect(answer.bookings.map((row) => row.reference)).toEqual([shoots[0], shoots[1]]);
    }
  });

  it('is page 1 of 1 for an empty list, not page 0 of 0', async () => {
    expect(await findBookings(prisma, { page: 4 })).toMatchObject({ bookings: [], total: 0, page: 1, pageCount: 1 });
  });

  it('carries its filter with it: the total, the page count and every page are filtered', async () => {
    await book({ startsAt: at('2027-03-11', '09:00'), status: 'confirmed' });
    const cancelledLate = await book({ startsAt: at('2027-03-11', '12:00'), status: 'cancelled_by_admin' });
    const cancelledEarly = await book({ startsAt: at('2027-03-11', '06:00'), status: 'cancelled_by_admin' });

    const first = await findBookings(prisma, { statuses: ['cancelled_by_admin'], page: 1, pageSize: 1 });
    expect(first.bookings.map((row) => row.reference)).toEqual([cancelledLate.reference]);
    expect(first).toMatchObject({ total: 2, pageCount: 2 });

    const second = await findBookings(prisma, { statuses: ['cancelled_by_admin'], page: 2, pageSize: 1 });
    expect(second.bookings.map((row) => row.reference)).toEqual([cancelledEarly.reference]);
  });
});

// --- Page size ----------------------------------------------------------------------------

describe('the page size', () => {
  it('defaults to 25, and the total says how many more there are', async () => {
    await bulkBookings(BOOKINGS_PAGE_SIZE + 1, at('2027-03-11', '09:00'));

    const page = await findBookings(prisma);

    expect(BOOKINGS_PAGE_SIZE).toBe(25);
    expect(page.bookings).toHaveLength(BOOKINGS_PAGE_SIZE);
    expect(page).toMatchObject({ total: BOOKINGS_PAGE_SIZE + 1, page: 1, pageSize: BOOKINGS_PAGE_SIZE, pageCount: 2 });
  });

  it('clamps at 100 however large a size is asked for', async () => {
    await bulkBookings(BOOKINGS_MAX_PAGE_SIZE + 1, at('2027-03-11', '09:00'));

    expect(BOOKINGS_MAX_PAGE_SIZE).toBe(100);
    expect((await findBookings(prisma, { pageSize: 1_000_000 })).bookings).toHaveLength(BOOKINGS_MAX_PAGE_SIZE);
    expect((await findBookings(prisma, { pageSize: BOOKINGS_MAX_PAGE_SIZE })).bookings).toHaveLength(BOOKINGS_MAX_PAGE_SIZE);
  });

  it('clamps a zero or negative size up to one row', async () => {
    await bulkBookings(3, at('2027-03-11', '09:00'));

    expect((await findBookings(prisma, { pageSize: 0 })).bookings).toHaveLength(1);
    expect((await findBookings(prisma, { pageSize: -10 })).bookings).toHaveLength(1);
  });
});

// --- Money on a row -----------------------------------------------------------------------

describe('each row’s money', () => {
  it('is bookingTotals(), add-ons and payments included', async () => {
    const booking = await book({ status: 'confirmed', addons: ['own', 'shared'] });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 22_000 });

    const row = (await findBookings(prisma)).bookings[0];
    const expected = bookingTotals(
      { status: 'confirmed', packagePriceRwf: 40_000 },
      [
        { stage: 'at_booking', amountRwf: 10_000 },
        { stage: 'at_booking', amountRwf: 5_000 },
      ],
      [{ status: 'succeeded', amountRwf: 22_000 }],
    );

    expect(row).toMatchObject({
      reference: booking.reference,
      grandTotalRwf: expected.grandTotalRwf,
      collectedRwf: expected.collectedRwf,
      outstandingRwf: expected.outstandingRwf,
      refundDueRwf: expected.refundDueRwf,
      hasRefundDue: false,
    });
    expect([expected.grandTotalRwf, expected.collectedRwf, expected.outstandingRwf]).toEqual([55_000, 22_000, 33_000]);
  });

  it('counts a post-shoot add-on into the grand total and what is owed', async () => {
    const booking = await book({ status: 'completed', startsAt: at('2027-03-01', '09:00') });
    await prisma.bookingAddon.create({
      data: {
        bookingId: booking.id,
        addonId: world.sharedAddonId,
        nameSnapshot: 'Rush edit',
        unitPriceRwf: 15_000,
        amountRwf: 15_000,
        stage: 'post_shoot',
      },
    });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    const row = (await findBookings(prisma)).bookings[0];

    expect(row).toMatchObject({ grandTotalRwf: 65_000, collectedRwf: 20_000, outstandingRwf: 45_000 });
  });

  it('surfaces money owed back, without netting it off what was collected', async () => {
    const booking = await book({ status: 'cancelled_by_admin' });
    await insertPayment(prisma, booking.id, { status: 'refund_due', amountRwf: 20_000 });

    const row = (await findBookings(prisma)).bookings[0];

    expect(row).toMatchObject({ collectedRwf: 0, refundDueRwf: 20_000, hasRefundDue: true, outstandingRwf: 0 });
  });

  it.each(['no_show', 'cancelled_by_client', 'cancelled_by_admin', 'expired'] as const)(
    'owes nothing on a %s booking, whatever the package cost',
    async (status) => {
      const booking = await book({ status });
      await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

      const row = (await findBookings(prisma)).bookings[0];

      expect(row).toMatchObject({ reference: booking.reference, status, grandTotalRwf: 50_000, outstandingRwf: 0 });
    },
  );

  it.each(['pending_payment', 'confirmed', 'completed'] as const)('still owes on a %s booking', async (status) => {
    const booking = await book({ status, startsAt: at('2027-03-01', '09:00') });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    const row = (await findBookings(prisma)).bookings[0];

    expect(row).toMatchObject({ reference: booking.reference, outstandingRwf: 30_000 });
  });

  it('ignores an unsettled attempt: only money collected counts', async () => {
    const booking = await book({ status: 'confirmed' });
    await insertPayment(prisma, booking.id, { status: 'pending', amountRwf: 20_000, ageSeconds: 300 });
    await insertPayment(prisma, booking.id, { status: 'failed', amountRwf: 20_000, ageSeconds: 200 });

    const row = (await findBookings(prisma)).bookings[0];

    expect(row).toMatchObject({ collectedRwf: 0, refundDueRwf: 0, outstandingRwf: 50_000 });
  });

  it('carries the contact and catalogue snapshots a list needs, and no access token', async () => {
    const booking = await book({ status: 'confirmed' });

    const row = (await findBookings(prisma)).bookings[0];

    expect(row).toMatchObject({
      id: booking.id,
      reference: booking.reference,
      status: 'confirmed',
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      contactName: CLIENT.name,
      contactEmail: CLIENT.email,
      contactPhone: CLIENT.phone,
      serviceName: 'Portraits',
      packageName: 'Standard',
    });
    expect(JSON.stringify(row)).not.toMatch(/accessToken|access_token/i);
  });
});

// --- Stages (2026-09-25) --------------------------------------------------------------

describe('filtering by display stage', () => {
  /** Mid-shoot for the "happening" booking: every stage has at least one booking at this instant. */
  const NOW = new Date('2027-03-11T08:00:00Z');

  async function everyStage(): Promise<Booking[]> {
    const at = (iso: string) => new Date(iso);
    const seeds: { seed: BookingSeed; delivered?: boolean }[] = [
      // Explicit days, far from the shared fixture's counter, so no two ever overlap.
      { seed: { status: 'pending_payment', startsAt: at('2027-03-13T07:00:00Z') } },
      { seed: { status: 'confirmed', holdMinutes: null, startsAt: at('2027-03-12T07:00:00Z') } },
      // Starting at 08:00 exactly: under way, the boundary included.
      { seed: { status: 'confirmed', holdMinutes: null, startsAt: at('2027-03-11T08:00:00Z') } },
      // 06:30 to 07:30, its buffer to 08:00: over, and clear of the one above.
      { seed: { status: 'confirmed', holdMinutes: null, startsAt: at('2027-03-11T06:30:00Z'), durationMinutes: 60 } },
      { seed: { status: 'confirmed', holdMinutes: null, startsAt: at('2027-03-08T07:00:00Z') } },
      { seed: { status: 'completed', holdMinutes: null, startsAt: at('2027-03-05T07:00:00Z') } },
      { seed: { status: 'completed', holdMinutes: null, startsAt: at('2027-03-04T07:00:00Z') }, delivered: true },
      { seed: { status: 'no_show', holdMinutes: null, startsAt: at('2027-03-03T07:00:00Z') } },
      { seed: { status: 'expired', startsAt: at('2027-03-02T07:00:00Z') } },
      { seed: { status: 'cancelled_by_client', holdMinutes: null, startsAt: at('2027-03-01T07:00:00Z') } },
      { seed: { status: 'cancelled_by_admin', holdMinutes: null, startsAt: at('2027-02-28T07:00:00Z') } },
    ];
    const made: Booking[] = [];
    for (const { seed, delivered } of seeds) {
      const booking = await insertBooking(prisma, world, seed);
      made.push(
        delivered === true
          ? await prisma.booking.update({
              where: { id: booking.id },
              data: { deliveryUrl: 'https://photos.example/x', deliverySentAt: at('2027-03-06T10:00:00Z') },
            })
          : booking,
      );
    }
    return made;
  }

  it('returns, for every stage, exactly the bookings bookingStage() puts in it', async () => {
    const bookings = await everyStage();

    for (const stage of BOOKING_STAGES) {
      const expected = bookings.filter((booking) => bookingStage(booking, NOW, 'admin') === stage).map((b) => b.id).sort();
      const page = await findBookings(prisma, { stages: [stage], now: NOW, pageSize: 100 });
      expect([stage, page.bookings.map((row) => row.id).sort()]).toEqual([stage, expected]);
      for (const row of page.bookings) expect(row.stage).toBe(stage);
    }
    // And the fixtures cover every stage, so the loop above is not vacuous.
    expect(new Set(bookings.map((booking) => bookingStage(booking, NOW, 'admin')))).toEqual(new Set(BOOKING_STAGES));
  });

  it('matches any of several stages, and still reads the old status filter', async () => {
    const bookings = await everyStage();
    const ids = (stage: string) => bookings.filter((b) => bookingStage(b, NOW, 'admin') === stage).map((b) => b.id);

    const several = await findBookings(prisma, { stages: ['in_progress', 'needs_review'], now: NOW, pageSize: 100 });
    expect(several.bookings.map((row) => row.id).sort()).toEqual([...ids('in_progress'), ...ids('needs_review')].sort());

    const byStatus = await findBookings(prisma, { statuses: ['completed'], now: NOW, pageSize: 100 });
    expect(byStatus.bookings.map((row) => row.id).sort()).toEqual([...ids('completed'), ...ids('closed')].sort());
  });

  it('stages every row it returns, filtered or not', async () => {
    const bookings = await everyStage();

    const page = await findBookings(prisma, { now: NOW, pageSize: 100 });

    for (const row of page.bookings) {
      const booking = bookings.find((b) => b.id === row.id);
      expect(row.stage).toBe(booking === undefined ? undefined : bookingStage(booking, NOW, 'admin'));
    }
  });
});
