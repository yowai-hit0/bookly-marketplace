import type { Booking, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type PaymentWorld, insertBooking, insertPayment, seedWorld } from '../test/payment-fixtures.js';
import { ADDON_MAX_QUANTITY, addPostShootAddon, removePostShootAddon } from './addons.js';
import { adminBookingView, findAdminBooking } from './admin-view.js';

/**
 * Post-shoot add-ons (plan.md Task 20; spec §3.5 step 2, §6.15;
 * data-model_v2.md §6.1, §6.2), against real PostgreSQL.
 *
 * What is proven. **Adding** copies the catalogue's name and price into the
 * booking at the instant it is added and never reads the catalogue again: the
 * add-on can be renamed, repriced or deactivated afterwards and the booking's
 * line and totals do not move (spec §6.13). `amount_rwf` is unit × quantity,
 * which the CHECK insists on, and the quantity is bounded at both ends. Only
 * something he sells for this service -- its own add-on, or one shared with
 * every service -- and, since 2026-09-27, only while the booking is
 * `confirmed` and its shoot has begun: add-ons come before completion, which
 * needs everything paid, so they are locked once the booking is `completed`
 * and refused before the shoot. `canEditAddons` says the same.
 *
 * The money is the point: a 15,000 add-on raises `grandTotalRwf` and
 * `outstandingRwf` by exactly 15,000 and leaves `quotedTotalRwf` alone (the v1
 * under-reporting bug made impossible rather than fixed), because there is no
 * stored total to fall out of step.
 *
 * **Removing** is for the mistake just made, not for unwinding money. It takes
 * the line off and drops both totals; it refuses a line the client chose at
 * booking, a line belonging to some other booking (answering `not_found`, never
 * that booking's data), and a line the client has already paid for -- which
 * would silently turn their payment into an overpayment nobody was told about.
 *
 * **At once:** the booking row is locked for the length of every edit, so two
 * adds arriving together both land and neither loses the other's money, and an
 * add racing a remove leaves totals that agree with the lines on the booking.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;

/** Long after every fixture shoot, for rendering the view. */
const NOW = new Date('2027-06-01T06:00:00Z');
/** A catalogue add-on priced at the plan's 15,000 case. */
const PRINTS = 15_000;

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

function deps() {
  return { prisma, now: () => NOW };
}

type AddonRow = {
  id: string;
  booking_id: string;
  addon_id: string;
  name_snapshot: string;
  unit_price_rwf: number;
  quantity: number;
  amount_rwf: number;
  stage: string;
};

/** Every booking_addon row, through the raw driver rather than the client under test. */
async function addonRows(bookingId: string): Promise<AddonRow[]> {
  const result = await raw.query<AddonRow>(
    `SELECT id::text, booking_id::text, addon_id::text, name_snapshot, unit_price_rwf, quantity, amount_rwf, stage
       FROM booking_addon WHERE booking_id = $1 ORDER BY stage, created_at, id`,
    [bookingId],
  );
  return result.rows;
}

async function totalsOf(bookingId: string) {
  const booking = await findAdminBooking(prisma, bookingId);
  if (booking === null) throw new Error('No such booking');
  return adminBookingView(booking, NOW).money.totals;
}

/**
 * A confirmed booking whose shoot has begun (every fixture shoot is before NOW):
 * 40,000 package + a 10,000 at-booking add-on, 20,000 collected.
 */
async function startedBooking(seed: Parameters<typeof insertBooking>[2] = {}): Promise<Booking> {
  const booking = await insertBooking(prisma, world, { status: 'confirmed', ...seed });
  await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000, ageSeconds: 600 });
  return booking;
}

/** A catalogue add-on of this service, at whatever price the test needs. */
async function catalogueAddon(priceRwf: number, options: { name?: string; serviceId?: string | null; isActive?: boolean } = {}) {
  return prisma.addon.create({
    data: {
      serviceId: options.serviceId === undefined ? world.serviceId : options.serviceId,
      nameEn: options.name ?? 'Extra prints',
      priceRwf,
      ...(options.isActive === undefined ? {} : { isActive: options.isActive }),
    },
  });
}

async function add(bookingId: string, addonId: string, quantity = 1) {
  return addPostShootAddon(deps(), bookingId, { addonId, quantity });
}

// --- Adding: the snapshot ----------------------------------------------------------------

describe('adding a post-shoot add-on', () => {
  it('copies the catalogue name and unit price onto the booking, at post_shoot stage', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS, { name: 'Twenty prints' });

    const result = await add(booking.id, prints.id);

    expect(result.status).toBe('ok');
    expect(await addonRows(booking.id)).toStrictEqual([
      expect.objectContaining({ stage: 'at_booking', name_snapshot: 'Extra hour' }),
      {
        id: expect.any(String),
        booking_id: booking.id,
        addon_id: prints.id,
        name_snapshot: 'Twenty prints',
        unit_price_rwf: PRINTS,
        quantity: 1,
        amount_rwf: PRINTS,
        stage: 'post_shoot',
      },
    ]);
  });

  it('never re-reads the catalogue afterwards: renaming, repricing and deactivating it change nothing', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS, { name: 'Twenty prints' });
    await add(booking.id, prints.id, 2);
    const before = await totalsOf(booking.id);

    await prisma.addon.update({
      where: { id: prints.id },
      data: { nameEn: 'Forty prints', priceRwf: 99_000, isActive: false },
    });

    const line = (await addonRows(booking.id)).find((row) => row.stage === 'post_shoot');
    expect(line).toMatchObject({ name_snapshot: 'Twenty prints', unit_price_rwf: PRINTS, quantity: 2, amount_rwf: 2 * PRINTS });
    expect(await totalsOf(booking.id)).toStrictEqual(before);
  });

  it('defaults the quantity to one', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS);

    await addPostShootAddon(deps(), booking.id, { addonId: prints.id, quantity: 1 });

    expect((await addonRows(booking.id)).at(-1)).toMatchObject({ quantity: 1, amount_rwf: PRINTS });
  });

  it.each([
    [1, PRINTS],
    [3, 3 * PRINTS],
    [ADDON_MAX_QUANTITY, ADDON_MAX_QUANTITY * PRINTS],
  ])('writes amount_rwf as unit × quantity for a quantity of %i', async (quantity, amountRwf) => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS);

    const result = await add(booking.id, prints.id, quantity);

    expect(result.status).toBe('ok');
    expect((await addonRows(booking.id)).at(-1)).toMatchObject({ quantity, unit_price_rwf: PRINTS, amount_rwf: amountRwf });
  });

  it.each([0, -1, ADDON_MAX_QUANTITY + 1, 10_000])('refuses a quantity of %i and writes nothing', async (quantity) => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS);

    const result = await add(booking.id, prints.id, quantity);

    expect(result).toStrictEqual({ status: 'not_allowed' });
    expect((await addonRows(booking.id)).filter((row) => row.stage === 'post_shoot')).toEqual([]);
  });
});

// --- Adding: which add-ons are his to add -------------------------------------------------

describe('which catalogue add-on may be added', () => {
  it('takes this service’s own add-on', async () => {
    const booking = await startedBooking();

    const result = await add(booking.id, world.ownAddonId);

    expect(result.status).toBe('ok');
    expect((await addonRows(booking.id)).at(-1)).toMatchObject({ name_snapshot: 'Extra hour', unit_price_rwf: 10_000, stage: 'post_shoot' });
  });

  it('takes an add-on shared with every service', async () => {
    const booking = await startedBooking();

    const result = await add(booking.id, world.sharedAddonId);

    expect(result.status).toBe('ok');
    expect((await addonRows(booking.id)).at(-1)).toMatchObject({ name_snapshot: 'Rush edit', unit_price_rwf: 5_000, stage: 'post_shoot' });
  });

  it('refuses an add-on that belongs to a different service', async () => {
    const booking = await startedBooking();
    const other = await prisma.service.create({ data: { slug: 'weddings', nameEn: 'Weddings' } });
    const theirs = await catalogueAddon(20_000, { name: 'Second shooter', serviceId: other.id });

    const result = await add(booking.id, theirs.id);

    expect(result).toStrictEqual({ status: 'not_allowed' });
    expect((await addonRows(booking.id)).filter((row) => row.stage === 'post_shoot')).toEqual([]);
  });

  it('refuses an add-on he has deactivated: it is not something he sells today', async () => {
    const booking = await startedBooking();
    const retired = await catalogueAddon(PRINTS, { name: 'Polaroid pack', isActive: false });

    const result = await add(booking.id, retired.id);

    expect(result).toStrictEqual({ status: 'not_allowed' });
    expect(await totalsOf(booking.id)).toMatchObject({ grandTotalRwf: 50_000 });
  });

  it('answers not_found for an add-on id nothing matches', async () => {
    const booking = await startedBooking();

    const result = await add(booking.id, '00000000-0000-4000-8000-0000000000aa');

    expect(result).toStrictEqual({ status: 'not_found' });
  });

  it('answers not_found for a booking id nothing matches, and touches no other booking', async () => {
    const other = await startedBooking();
    const prints = await catalogueAddon(PRINTS);

    const result = await add('00000000-0000-4000-8000-0000000000bb', prints.id);

    expect(result).toStrictEqual({ status: 'not_found' });
    expect((await addonRows(other.id)).filter((row) => row.stage === 'post_shoot')).toEqual([]);
  });
});

// --- Adding: while the shoot is under way, before completion ------------------------------

describe('the editor is open once the shoot has begun, and until the booking is completed (2026-09-27)', () => {
  it.each(['pending_payment', 'completed', 'expired', 'no_show', 'cancelled_by_client', 'cancelled_by_admin'])(
    'refuses an add-on on a %s booking',
    async (status) => {
      const booking = await insertBooking(prisma, world, { status });
      const prints = await catalogueAddon(PRINTS);

      const result = await add(booking.id, prints.id);

      expect(result).toStrictEqual({ status: 'not_allowed' });
      expect((await addonRows(booking.id)).filter((row) => row.stage === 'post_shoot')).toEqual([]);
    },
  );

  it('refuses one on a confirmed booking whose shoot has not begun', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: new Date(NOW.getTime() + 60 * 60_000) });
    const prints = await catalogueAddon(PRINTS);

    expect(await add(booking.id, prints.id)).toStrictEqual({ status: 'not_allowed' });
    const view = adminBookingView((await findAdminBooking(prisma, booking.id)) ?? (() => { throw new Error('gone'); })(), NOW);
    expect(view.actions.canEditAddons).toBe(false);
  });

  it('allows it once the shoot has begun, says so through canEditAddons, and locks it once completed', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS);

    expect((await add(booking.id, prints.id)).status).toBe('ok');
    const open = adminBookingView((await findAdminBooking(prisma, booking.id)) ?? (() => { throw new Error('gone'); })(), NOW);
    expect(open.actions.canEditAddons).toBe(true);
    // Delivery is for after: it still needs `completed`.
    expect(open.actions.canEditDelivery).toBe(false);

    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'completed', completedAt: NOW } });

    expect(await add(booking.id, prints.id)).toStrictEqual({ status: 'not_allowed' });
    const locked = adminBookingView((await findAdminBooking(prisma, booking.id)) ?? (() => { throw new Error('gone'); })(), NOW);
    expect(locked.actions.canEditAddons).toBe(false);
    expect(locked.actions.canEditDelivery).toBe(true);
  });
});

// --- Adding: the money ----------------------------------------------------------------------

describe('what adding one does to the money (data-model_v2.md §6.1)', () => {
  it('raises grandTotalRwf and outstandingRwf by 15,000, and leaves quotedTotalRwf alone (plan.md Task 20)', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS);
    const before = await totalsOf(booking.id);
    expect(before).toStrictEqual({
      quotedTotalRwf: 50_000,
      grandTotalRwf: 50_000,
      collectedRwf: 20_000,
      refundDueRwf: 0,
      outstandingRwf: 30_000,
    });

    await add(booking.id, prints.id);

    expect(await totalsOf(booking.id)).toStrictEqual({
      quotedTotalRwf: 50_000,
      grandTotalRwf: 65_000,
      collectedRwf: 20_000,
      refundDueRwf: 0,
      outstandingRwf: 45_000,
    });
  });

  it('raises them by unit × quantity, not by the unit price', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS);

    await add(booking.id, prints.id, 4);

    expect(await totalsOf(booking.id)).toMatchObject({ grandTotalRwf: 50_000 + 4 * PRINTS, outstandingRwf: 30_000 + 4 * PRINTS });
  });

  it('adds up across several add-ons', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS);

    await add(booking.id, prints.id);
    await add(booking.id, world.sharedAddonId, 2);

    expect(await totalsOf(booking.id)).toMatchObject({
      quotedTotalRwf: 50_000,
      grandTotalRwf: 50_000 + PRINTS + 10_000,
      outstandingRwf: 30_000 + PRINTS + 10_000,
    });
  });

  it('answers the booking as it now stands, the new line included', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS, { name: 'Twenty prints' });

    const result = await add(booking.id, prints.id);
    if (result.status !== 'ok') throw new Error(`Expected ok, got ${result.status}`);

    const view = adminBookingView(result.booking, NOW);
    expect(view.money.totals.grandTotalRwf).toBe(65_000);
    expect(view.addons.map((line) => [line.name, line.stage, line.amountRwf])).toEqual([
      ['Extra hour', 'at_booking', 10_000],
      ['Twenty prints', 'post_shoot', PRINTS],
    ]);
  });
});

// --- Removing ---------------------------------------------------------------------------------

describe('removing a post-shoot add-on', () => {
  /** A completed booking carrying one 15,000 post-shoot line. */
  async function withPostShootLine(): Promise<{ booking: Booking; lineId: string }> {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS, { name: 'Twenty prints' });
    await add(booking.id, prints.id);
    const line = (await addonRows(booking.id)).find((row) => row.stage === 'post_shoot');
    if (line === undefined) throw new Error('The add did not land');
    return { booking, lineId: line.id };
  }

  it('takes the line off and drops both totals by its amount', async () => {
    const { booking, lineId } = await withPostShootLine();
    expect(await totalsOf(booking.id)).toMatchObject({ grandTotalRwf: 65_000, outstandingRwf: 45_000 });

    const result = await removePostShootAddon(deps(), booking.id, lineId);

    expect(result.status).toBe('ok');
    expect((await addonRows(booking.id)).map((row) => row.stage)).toEqual(['at_booking']);
    expect(await totalsOf(booking.id)).toStrictEqual({
      quotedTotalRwf: 50_000,
      grandTotalRwf: 50_000,
      collectedRwf: 20_000,
      refundDueRwf: 0,
      outstandingRwf: 30_000,
    });
  });

  it('refuses an at_booking line: what the client chose and paid a booking fee on is not his to delete', async () => {
    const { booking } = await withPostShootLine();
    const atBooking = (await addonRows(booking.id)).find((row) => row.stage === 'at_booking');

    const result = await removePostShootAddon(deps(), booking.id, atBooking?.id ?? '');

    expect(result).toStrictEqual({ status: 'not_allowed' });
    expect((await addonRows(booking.id)).map((row) => row.stage)).toEqual(['at_booking', 'post_shoot']);
  });

  it('refuses a line of another booking with not_found, and never that booking’s data', async () => {
    const mine = await withPostShootLine();
    const theirs = await withPostShootLine();

    const result = await removePostShootAddon(deps(), mine.booking.id, theirs.lineId);

    expect(result).toStrictEqual({ status: 'not_found' });
    expect((await addonRows(theirs.booking.id)).filter((row) => row.stage === 'post_shoot')).toHaveLength(1);
    expect((await addonRows(mine.booking.id)).filter((row) => row.stage === 'post_shoot')).toHaveLength(1);
  });

  it('answers not_found for a line id nothing matches', async () => {
    const { booking } = await withPostShootLine();

    const result = await removePostShootAddon(deps(), booking.id, '00000000-0000-4000-8000-0000000000cc');

    expect(result).toStrictEqual({ status: 'not_found' });
  });

  it.each(['completed', 'no_show', 'cancelled_by_admin'])('refuses on a %s booking, which has no open editor', async (status) => {
    const { booking, lineId } = await withPostShootLine();
    await prisma.booking.update({ where: { id: booking.id }, data: { status } });

    const result = await removePostShootAddon(deps(), booking.id, lineId);

    expect(result).toStrictEqual({ status: 'not_allowed' });
    expect((await addonRows(booking.id)).filter((row) => row.stage === 'post_shoot')).toHaveLength(1);
  });

  it('refuses already_paid once the client has paid for it, and leaves the line where it is', async () => {
    const { booking, lineId } = await withPostShootLine();
    // The session fee arrived: 20,000 + 45,000 is the whole 65,000.
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 45_000, ageSeconds: 300 });

    const result = await removePostShootAddon(deps(), booking.id, lineId);

    expect(result).toStrictEqual({ status: 'already_paid' });
    expect((await addonRows(booking.id)).filter((row) => row.stage === 'post_shoot')).toHaveLength(1);
    expect(await totalsOf(booking.id)).toMatchObject({ grandTotalRwf: 65_000, collectedRwf: 65_000, outstandingRwf: 0 });
  });

  it('refuses the moment removing it would leave the client having overpaid, by a single franc', async () => {
    const { booking, lineId } = await withPostShootLine();
    // Removing 15,000 leaves 50,000 owed against 50,001 collected.
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_001, ageSeconds: 300 });

    expect(await removePostShootAddon(deps(), booking.id, lineId)).toStrictEqual({ status: 'already_paid' });

    // One franc less and the sums allow it.
    await prisma.payment.updateMany({ where: { bookingId: booking.id, kind: 'session_fee' }, data: { amountRwf: 30_000 } });

    expect((await removePostShootAddon(deps(), booking.id, lineId)).status).toBe('ok');
  });

  it('removes one line while another is paid for, when the sums allow it', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS, { name: 'Twenty prints' });
    await add(booking.id, prints.id);
    await add(booking.id, world.sharedAddonId);
    // 50,000 + 15,000 + 5,000 = 70,000 owed, 60,000 collected.
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 40_000, ageSeconds: 300 });
    const lines = (await addonRows(booking.id)).filter((row) => row.stage === 'post_shoot');
    const small = lines.find((row) => row.amount_rwf === 5_000);
    const large = lines.find((row) => row.amount_rwf === PRINTS);

    // The 15,000 cannot go: 55,000 would be less than the 60,000 collected.
    expect(await removePostShootAddon(deps(), booking.id, large?.id ?? '')).toStrictEqual({ status: 'already_paid' });
    // The 5,000 can: 65,000 still covers it.
    expect((await removePostShootAddon(deps(), booking.id, small?.id ?? '')).status).toBe('ok');
    expect(await totalsOf(booking.id)).toMatchObject({ grandTotalRwf: 65_000, collectedRwf: 60_000, outstandingRwf: 5_000 });
  });

  it('counts only payments that succeeded: a failed or refunded attempt does not protect a line', async () => {
    const { booking, lineId } = await withPostShootLine();
    await insertPayment(prisma, booking.id, { status: 'failed', kind: 'session_fee', amountRwf: 45_000, ageSeconds: 300 });
    await insertPayment(prisma, booking.id, { status: 'refunded', kind: 'session_fee', amountRwf: 45_000, ageSeconds: 300 });

    expect((await removePostShootAddon(deps(), booking.id, lineId)).status).toBe('ok');
  });

  it('answers the booking without the line it removed', async () => {
    const { booking, lineId } = await withPostShootLine();

    const result = await removePostShootAddon(deps(), booking.id, lineId);
    if (result.status !== 'ok') throw new Error(`Expected ok, got ${result.status}`);

    expect(adminBookingView(result.booking, NOW).addons.map((line) => line.stage)).toEqual(['at_booking']);
  });

  it('marks in the view exactly the lines it would allow removing', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS);
    await add(booking.id, prints.id);
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 45_000, ageSeconds: 300 });

    const view = adminBookingView((await findAdminBooking(prisma, booking.id)) ?? (() => { throw new Error('gone'); })(), NOW);

    expect(view.addons.map((line) => [line.stage, line.canRemove])).toEqual([
      ['at_booking', false],
      ['post_shoot', false],
    ]);
  });
});

// --- Two edits at once -------------------------------------------------------------------------

describe('two edits arriving at once', () => {
  it('lands both adds, with no lost update in the totals', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS);

    const results = await Promise.all([add(booking.id, prints.id), add(booking.id, world.sharedAddonId)]);

    expect(results.map((result) => result.status)).toEqual(['ok', 'ok']);
    expect((await addonRows(booking.id)).filter((row) => row.stage === 'post_shoot')).toHaveLength(2);
    expect(await totalsOf(booking.id)).toMatchObject({ grandTotalRwf: 50_000 + PRINTS + 5_000, outstandingRwf: 30_000 + PRINTS + 5_000 });
  });

  it('lands five of the same add-on as five lines, each counted once', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS);

    const results = await Promise.all(Array.from({ length: 5 }, () => add(booking.id, prints.id)));

    expect(results.every((result) => result.status === 'ok')).toBe(true);
    expect((await addonRows(booking.id)).filter((row) => row.stage === 'post_shoot')).toHaveLength(5);
    expect(await totalsOf(booking.id)).toMatchObject({ grandTotalRwf: 50_000 + 5 * PRINTS });
  });

  it('leaves the totals agreeing with the lines when an add races a remove', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS);
    await add(booking.id, prints.id);
    const first = (await addonRows(booking.id)).find((row) => row.stage === 'post_shoot');

    const [added, removed] = await Promise.all([
      add(booking.id, world.sharedAddonId),
      removePostShootAddon(deps(), booking.id, first?.id ?? ''),
    ]);

    expect([added.status, removed.status]).toEqual(['ok', 'ok']);
    const lines = await addonRows(booking.id);
    const expected = lines.reduce((sum, row) => sum + row.amount_rwf, 0) + 40_000;
    expect(await totalsOf(booking.id)).toMatchObject({ grandTotalRwf: expected });
  });

  it('never lets a remove racing a payment leave the client overpaid', async () => {
    const booking = await startedBooking();
    const prints = await catalogueAddon(PRINTS);
    await add(booking.id, prints.id);
    const line = (await addonRows(booking.id)).find((row) => row.stage === 'post_shoot');
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 45_000, ageSeconds: 300 });

    const results = await Promise.all([
      removePostShootAddon(deps(), booking.id, line?.id ?? ''),
      removePostShootAddon(deps(), booking.id, line?.id ?? ''),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['already_paid', 'already_paid']);
    const totals = await totalsOf(booking.id);
    expect(totals.collectedRwf).toBeLessThanOrEqual(totals.grandTotalRwf);
  });
});

// --- The arithmetic the database has to store ---------------------------------------------------

/**
 * `amount_rwf` is an `integer`, and the CHECK insists it equals
 * `unit_price_rwf * quantity`. The catalogue lets an add-on be priced anywhere
 * up to `INT4_MAX` (routes/validation.ts), and the editor multiplies that by up
 * to 99, so the product can leave the column's range. Nothing between the two
 * bounds the result.
 */
describe('a price and a quantity whose product an integer cannot hold', () => {
  /** Above this, some legal quantity overflows `integer`. */
  const INT4_MAX = 2_147_483_647;

  it('takes the largest amount the booking can still hold', async () => {
    const booking = await startedBooking();
    // The ceiling is the booking's total, not the line by itself: the payment
    // that would collect what it owes has to fit the same `integer` column.
    const room = INT4_MAX - (await totalsOf(booking.id)).grandTotalRwf;
    const expensive = await catalogueAddon(Math.floor(room / 99), { name: 'The whole studio' });

    const result = await add(booking.id, expensive.id, 99);

    expect(result.status).toBe('ok');
    expect((await addonRows(booking.id)).at(-1)?.amount_rwf).toBe(Math.floor(room / 99) * 99);
    expect((await totalsOf(booking.id)).grandTotalRwf).toBeLessThanOrEqual(INT4_MAX);
  });

  it('refuses the line that would take the booking past it', async () => {
    const booking = await startedBooking();
    const total = (await totalsOf(booking.id)).grandTotalRwf;
    // One rwf too many for the booking, though the line itself would fit.
    const expensive = await catalogueAddon(INT4_MAX - total + 1, { name: 'The whole studio' });

    expect(await add(booking.id, expensive.id)).toStrictEqual({ status: 'too_large' });
    expect((await totalsOf(booking.id)).grandTotalRwf).toBe(total);
  });

  /**
   * The catalogue allows a price up to `INT4_MAX` and the editor a quantity up
   * to 99, so two legal values multiply into one the `integer` column cannot
   * hold. Answered here as `too_large`, rather than reaching PostgreSQL as a
   * 22003 and surfacing as a 500 (routes/validation.ts).
   */
  it('refuses a product larger than an integer rather than throwing', async () => {
    const booking = await startedBooking();
    const expensive = await catalogueAddon(INT4_MAX, { name: 'A price the catalogue allows' });

    const result = await add(booking.id, expensive.id, 2);

    expect(result).toStrictEqual({ status: 'too_large' });
    expect((await addonRows(booking.id)).filter((row) => row.stage === 'post_shoot')).toEqual([]);
  });
});
