import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  CLIENT,
  type PaymentWorld,
  insertBooking,
  insertBookingWithToken,
  insertPayment,
  seedWorld,
} from '../test/payment-fixtures.js';
import { type AccessedBooking, FULL_BOOKING } from './access.js';
import { canCancel, clientBookingView } from './client-view.js';
import { saveDelivery, sendDelivery } from './delivery.js';

/**
 * The booking a client sees (plan.md Task 18; spec §3.9, §6.10, §6.20;
 * data-model_v2.md §6.1), built from real rows.
 *
 * What is proven: every field is the booking's own, and every amount is
 * `bookingTotals()`'s -- including the status-aware `outstandingRwf`, so a
 * cancelled or no-show booking shows nothing outstanding, which is the bug
 * v2.0's view would have produced. The session-fee block appears only while
 * there is a confirmed or completed booking with money owed, and names an
 * attempt still waiting on the payer. The delivery appears only once the photos
 * have been sent, and its link dies at the end of its last day in Kigali, read
 * from the injected clock. The payment list is money that moved -- succeeded,
 * owed back, refunded -- and never an abandoned attempt. `canCancel` is true
 * only for a confirmed booking whose shoot is still ahead. And the serialised
 * view carries no token, no booking id, no client id and no email address.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;

/** The injected app clock: well before every fixture day (2027). */
const NOW = new Date('2026-10-01T06:00:00Z');

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

/** The booking as `findBookingByToken` hands it over, with its own include. */
async function accessed(bookingId: string): Promise<AccessedBooking> {
  return prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: FULL_BOOKING });
}

async function viewOf(bookingId: string, now: Date = NOW) {
  return clientBookingView(await accessed(bookingId), now);
}

async function addPostShootAddon(bookingId: string, amountRwf: number, name = 'Extra prints'): Promise<void> {
  await prisma.bookingAddon.create({
    data: {
      bookingId,
      addonId: world.ownAddonId,
      nameSnapshot: name,
      unitPriceRwf: amountRwf,
      amountRwf,
      stage: 'post_shoot',
    },
  });
}

async function setDelivery(bookingId: string, fields: { url?: string | null; expiresOn?: string | null; sent?: boolean; note?: string | null }) {
  await prisma.$executeRaw`
    UPDATE booking
       SET delivery_url = ${fields.url === undefined ? 'https://photos.example-host.com/s/abc123' : fields.url},
           delivery_expires_on = ${fields.expiresOn === undefined ? '2027-01-01' : fields.expiresOn}::date,
           delivery_sent_at = ${(fields.sent ?? true) ? new Date('2026-10-02T08:00:00Z') : null}::timestamptz,
           delivery_note = ${fields.note === undefined ? 'Thank you for a lovely morning!' : fields.note}
     WHERE id = ${bookingId}::uuid`;
}

// --- Every field -------------------------------------------------------------------------

describe('the whole view', () => {
  it('is exactly the booking’s own details, add-ons, totals, payments and flags', async () => {
    const { booking } = await insertBookingWithToken(prisma, world, { addons: ['own', 'shared'], bookingFeeRwf: 22_000 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 22_000 });
    await addPostShootAddon(booking.id, 15_000);

    const view = await viewOf(booking.id);

    expect(view).toStrictEqual({
      reference: booking.reference,
      status: 'confirmed',
      // The shoot is still ahead of NOW (2026-09-25, booking/stage.ts).
      stage: 'confirmed',
      clientName: CLIENT.name,
      // Masked, never the address itself (2026-09-25).
      maskedEmail: 'a•••••@example.com',
      pendingMaskedEmail: null,
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      serviceName: 'Portraits',
      packageName: 'Standard',
      packagePriceRwf: 40_000,
      packagePhotoCount: 25,
      packageDurationMinutes: 90,
      locationText: CLIENT.location,
      partySize: 3,
      specialRequests: CLIENT.specialRequests,
      addons: [
        { name: 'Extra hour', priceRwf: 10_000, stage: 'at_booking' },
        { name: 'Rush edit', priceRwf: 5_000, stage: 'at_booking' },
        { name: 'Extra prints', priceRwf: 15_000, stage: 'post_shoot' },
      ],
      totals: {
        quotedTotalRwf: 55_000,
        grandTotalRwf: 70_000,
        collectedRwf: 22_000,
        refundDueRwf: 0,
        outstandingRwf: 48_000,
      },
      bookingFeeRwf: 22_000,
      payments: [{ kind: 'booking_fee', status: 'succeeded', amountRwf: 22_000, settledAt: '2026-10-01T06:05:00.000Z' }],
      canCancel: true,
      cancellationReason: null,
      cancelledAt: null,
      sessionFee: { outstandingRwf: 48_000, waitingPayment: null },
      delivery: null,
      // Nothing sent, no notes, the shoot still ahead (2026-09-25).
      notices: [],
    });
  });

  it('carries a null party size, null special requests and no add-ons as they stand', async () => {
    const { booking } = await insertBookingWithToken(prisma, world, { addons: [] });
    await prisma.booking.update({ where: { id: booking.id }, data: { partySize: null, specialRequests: null } });

    const view = await viewOf(booking.id);

    expect(view).toMatchObject({ partySize: null, specialRequests: null, addons: [] });
    expect(view.totals.quotedTotalRwf).toBe(40_000);
  });

  it('shows the photographer’s cancellation reason and the moment of cancelling', async () => {
    const { booking } = await insertBookingWithToken(prisma, world, { status: 'cancelled_by_admin' });
    await prisma.booking.update({
      where: { id: booking.id },
      data: { cancellationReason: 'The photographer is unwell.', cancelledAt: new Date('2026-10-02T09:00:00Z') },
    });

    expect(await viewOf(booking.id)).toMatchObject({
      cancellationReason: 'The photographer is unwell.',
      cancelledAt: '2026-10-02T09:00:00.000Z',
    });
  });
});

// --- Totals, by status --------------------------------------------------------------------

describe('totals follow the booking’s status (data-model_v2.md §6.1)', () => {
  /** 40,000 package + 10,000 at-booking add-on + 15,000 post-shoot = 65,000 grand; 20,000 collected. */
  async function priced(status: string) {
    const booking = await insertBooking(prisma, world, { status });
    await addPostShootAddon(booking.id, 15_000);
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
    return booking;
  }

  it.each([
    ['pending_payment', 45_000],
    ['confirmed', 45_000],
    ['completed', 45_000],
  ])('%s owes grand total less collected: %i', async (status, outstanding) => {
    const booking = await priced(status);

    expect((await viewOf(booking.id)).totals).toStrictEqual({
      quotedTotalRwf: 50_000,
      grandTotalRwf: 65_000,
      collectedRwf: 20_000,
      refundDueRwf: 0,
      outstandingRwf: outstanding,
    });
  });

  it.each(['no_show', 'cancelled_by_client', 'cancelled_by_admin', 'expired'])(
    '%s owes nothing: the session fee is never shown as outstanding',
    async (status) => {
      const booking = await priced(status);

      const view = await viewOf(booking.id);

      expect(view.totals.outstandingRwf).toBe(0);
      expect(view.totals.grandTotalRwf).toBe(65_000);
      expect(view.totals.collectedRwf).toBe(20_000);
      expect(view.sessionFee).toBeNull();
    },
  );

  it('reports money owed back separately, never netted off what was collected', async () => {
    const booking = await insertBooking(prisma, world, { status: 'cancelled_by_client' });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
    await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', amountRwf: 30_000 });

    expect((await viewOf(booking.id)).totals).toMatchObject({
      collectedRwf: 20_000,
      refundDueRwf: 30_000,
      outstandingRwf: 0,
    });
  });

  it('never owes a negative amount when more was collected than the booking cost', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', addons: [] });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 60_000 });

    expect((await viewOf(booking.id)).totals.outstandingRwf).toBe(0);
  });
});

// --- The session fee -----------------------------------------------------------------------

describe('the session fee block', () => {
  it('is the outstanding amount for a confirmed booking with money owed', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    expect((await viewOf(booking.id)).sessionFee).toStrictEqual({ outstandingRwf: 30_000, waitingPayment: null });
  });

  it('is null once the booking is paid in full', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000 });

    const view = await viewOf(booking.id);

    expect(view.totals.outstandingRwf).toBe(0);
    expect(view.sessionFee).toBeNull();
  });

  it.each(['pending_payment', 'expired', 'no_show', 'cancelled_by_client', 'cancelled_by_admin'])(
    'is null for a %s booking, however much is unpaid',
    async (status) => {
      const booking = await insertBooking(prisma, world, { status });

      expect((await viewOf(booking.id)).sessionFee).toBeNull();
    },
  );

  it.each(['initiated', 'pending'])('names a session-fee attempt still %s', async (status) => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
    const waiting = await insertPayment(prisma, booking.id, { status, kind: 'session_fee', amountRwf: 30_000 });

    expect((await viewOf(booking.id)).sessionFee).toStrictEqual({
      outstandingRwf: 30_000,
      waitingPayment: { ourRef: waiting.ourRef },
    });
  });

  it.each(['failed', 'refund_due', 'refunded'])('names no waiting attempt when the only session fee is %s', async (status) => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
    await insertPayment(prisma, booking.id, { status, kind: 'session_fee', amountRwf: 30_000 });

    expect((await viewOf(booking.id)).sessionFee?.waitingPayment).toBeNull();
  });

  it('never names a waiting booking-fee attempt as a session fee', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await insertPayment(prisma, booking.id, { status: 'pending', kind: 'booking_fee' });

    expect((await viewOf(booking.id)).sessionFee).toStrictEqual({ outstandingRwf: 50_000, waitingPayment: null });
  });
});

// --- The payment list ----------------------------------------------------------------------

describe('the payments a client is shown', () => {
  it('are the ones that moved money: succeeded, owed back, refunded', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000, ageSeconds: 300 });
    await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 200 });
    await insertPayment(prisma, booking.id, { status: 'refunded', kind: 'session_fee', amountRwf: 5_000, ageSeconds: 100 });

    expect((await viewOf(booking.id)).payments).toStrictEqual([
      { kind: 'booking_fee', status: 'succeeded', amountRwf: 20_000, settledAt: '2026-10-01T06:05:00.000Z' },
      { kind: 'session_fee', status: 'refund_due', amountRwf: 30_000, settledAt: '2026-10-01T06:05:00.000Z' },
      { kind: 'session_fee', status: 'refunded', amountRwf: 5_000, settledAt: '2026-10-01T06:05:00.000Z' },
    ]);
  });

  it.each(['initiated', 'pending', 'failed'])('exclude an attempt that is only %s', async (status) => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await insertPayment(prisma, booking.id, { status, amountRwf: 20_000 });

    expect((await viewOf(booking.id)).payments).toEqual([]);
  });

  it('never carry the provider’s reference, our_ref, the failure reason or a payment id', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const payment = await insertPayment(prisma, booking.id, {
      status: 'succeeded',
      providerRef: 'PROVIDER-SECRET-REF',
      failureReason: 'PAYER_NOT_FOUND',
    });

    const serialised = JSON.stringify(await viewOf(booking.id));

    expect(serialised).not.toContain('PROVIDER-SECRET-REF');
    expect(serialised).not.toContain('PAYER_NOT_FOUND');
    expect(serialised).not.toContain(payment.id);
    expect(serialised).not.toContain(payment.ourRef);
  });
});

// --- Cancelling ----------------------------------------------------------------------------

describe('canCancel', () => {
  it('is true for a confirmed booking whose shoot is still ahead', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });

    expect(canCancel(booking, NOW)).toBe(true);
    expect((await viewOf(booking.id)).canCancel).toBe(true);
  });

  it('is false once the shoot has started, to the millisecond', async () => {
    const startsAt = new Date('2027-03-01T07:00:00Z');
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt });

    expect(canCancel(booking, new Date(startsAt.getTime() - 1))).toBe(true);
    expect(canCancel(booking, startsAt)).toBe(false);
    expect(canCancel(booking, new Date(startsAt.getTime() + 1))).toBe(false);
    expect((await viewOf(booking.id, new Date(startsAt.getTime() + 1))).canCancel).toBe(false);
  });

  it.each(['pending_payment', 'completed', 'no_show', 'expired', 'cancelled_by_client', 'cancelled_by_admin'])(
    'is false for a %s booking',
    async (status) => {
      const booking = await insertBooking(prisma, world, { status });

      expect(canCancel(booking, NOW)).toBe(false);
      expect((await viewOf(booking.id)).canCancel).toBe(false);
    },
  );
});

// --- Delivery ------------------------------------------------------------------------------

describe('the delivery (spec §6.5, §6.20)', () => {
  it('is absent until the photos have been sent, even with a link on file', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    await setDelivery(booking.id, { sent: false });

    expect((await viewOf(booking.id)).delivery).toBeNull();
  });

  it('is absent when the email went out with no link, which should not happen', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    await setDelivery(booking.id, { url: null, expiresOn: null });

    expect((await viewOf(booking.id)).delivery).toBeNull();
  });

  it('carries the link, the date and the note while it is live', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    await setDelivery(booking.id, {});

    expect((await viewOf(booking.id, new Date('2026-12-20T10:00:00Z'))).delivery).toStrictEqual({
      url: 'https://photos.example-host.com/s/abc123',
      expiresOn: '2027-01-01',
      expired: false,
      note: 'Thank you for a lovely morning!',
    });
  });

  it('lives all through its last day in Kigali and dies at the end of it', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    await setDelivery(booking.id, { expiresOn: '2027-01-01' });

    // 23:59:59 Kigali on 1 January is 21:59:59Z: still the last day.
    const lastMoment = await viewOf(booking.id, new Date('2027-01-01T21:59:59Z'));
    expect(lastMoment.delivery).toMatchObject({ expired: false, url: 'https://photos.example-host.com/s/abc123' });

    // 22:00:00Z is 00:00 on 2 January in Kigali: over.
    const justAfter = await viewOf(booking.id, new Date('2027-01-01T22:00:00Z'));
    expect(justAfter.delivery).toStrictEqual({
      url: null,
      expiresOn: '2027-01-01',
      expired: true,
      note: 'Thank you for a lovely morning!',
    });
  });

  it('is live on a day that is still yesterday in UTC but today in Kigali', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    await setDelivery(booking.id, { expiresOn: '2027-01-02' });

    // 22:30Z on 1 January is already 2 January in Kigali: the last day, not past it.
    expect((await viewOf(booking.id, new Date('2027-01-01T22:30:00Z'))).delivery).toMatchObject({ expired: false });
  });

  it('never expires when no date was set, and carries no note when none was written', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    await setDelivery(booking.id, { expiresOn: null, note: null });

    expect((await viewOf(booking.id, new Date('2099-01-01T00:00:00Z'))).delivery).toStrictEqual({
      url: 'https://photos.example-host.com/s/abc123',
      expiresOn: null,
      expired: false,
      note: null,
    });
  });

  it('withholds the link once expired, so a dead URL is never offered', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    await setDelivery(booking.id, { expiresOn: '2026-01-01' });

    const view = await viewOf(booking.id);

    expect(view.delivery?.url).toBeNull();
    expect(JSON.stringify(view)).not.toContain('photos.example-host.com');
  });
});

// --- Delivery, as Task 21 actually writes it ---------------------------------------------------

/**
 * The same §6.20 behaviour, but driven by the real editor rather than by a raw
 * `UPDATE`: what `saveDelivery` and `sendDelivery` leave on the booking is
 * exactly what the client's page then shows, and when it stops showing it.
 */
describe('the delivery the photographer actually saved (plan.md Task 21)', () => {
  const LINK = 'https://photos.example-host.com/s/abc123';
  const NOTE = 'Thank you for a lovely morning!';

  /** A completed shoot the delivery editor will accept. */
  async function completed() {
    return insertBooking(prisma, world, { status: 'completed' });
  }

  function deps(now: Date = NOW) {
    return { prisma, now: () => now };
  }

  it('shows nothing at all while the link is saved but unsent', async () => {
    const booking = await completed();
    await saveDelivery(deps(), booking.id, { url: LINK, note: NOTE });

    const view = await viewOf(booking.id);

    expect(view.delivery).toBeNull();
    expect(JSON.stringify(view)).not.toContain(LINK);
    expect(JSON.stringify(view)).not.toContain(NOTE);
  });

  it('stays hidden even after the unsent link’s own date has passed', async () => {
    const booking = await completed();
    await saveDelivery(deps(), booking.id, { url: LINK, expiresOn: '2026-10-02' });

    expect((await viewOf(booking.id, new Date('2027-05-01T06:00:00Z'))).delivery).toBeNull();
  });

  it('appears the moment he sends it, with the link, the note and the default date', async () => {
    const booking = await completed();
    await saveDelivery(deps(), booking.id, { url: LINK, note: NOTE });

    await sendDelivery(deps(), booking.id);

    // NOW is 1 October 2026 in Kigali; spec A-8's ninety days land on 30 December.
    expect((await viewOf(booking.id)).delivery).toStrictEqual({
      url: LINK,
      expiresOn: '2026-12-30',
      expired: false,
      note: NOTE,
    });
  });

  /** The link it wrote, as the clock crosses the end of its last day in Kigali. */
  async function deliveryAt(instant: string) {
    const booking = await completed();
    await saveDelivery(deps(), booking.id, { url: LINK });
    await sendDelivery(deps(), booking.id);
    return (await viewOf(booking.id, new Date(instant))).delivery;
  }

  it.each([
    ['the morning it was sent', '2026-10-01T06:00:00Z'],
    ['the middle of its last day', '2026-12-30T10:00:00Z'],
    ['23:59 Kigali on its last day', '2026-12-30T21:59:00Z'],
    ['the last second of its last day', '2026-12-30T21:59:59Z'],
  ])('still offers the link at %s', async (_case, instant) => {
    expect(await deliveryAt(instant)).toMatchObject({ expiresOn: '2026-12-30', expired: false, url: LINK });
  });

  it.each([
    ['midnight Kigali the next day', '2026-12-30T22:00:00Z'],
    ['the following morning in Kigali', '2026-12-31T06:00:00Z'],
    ['months later', '2027-05-01T06:00:00Z'],
  ])('withholds it and says so at %s', async (_case, instant) => {
    expect(await deliveryAt(instant)).toStrictEqual({ url: null, expiresOn: '2026-12-30', expired: true, note: null });
  });

  it('shows the replaced link, not the one the first email named', async () => {
    const booking = await completed();
    await saveDelivery(deps(), booking.id, { url: LINK });
    await sendDelivery(deps(), booking.id);

    const replacement = 'https://wetransfer.example/download/9f2c';
    await saveDelivery(deps(new Date('2026-10-05T06:00:00Z')), booking.id, { url: replacement });

    const view = await viewOf(booking.id, new Date('2026-10-05T07:00:00Z'));
    expect(view.delivery).toMatchObject({ url: replacement, expired: false });
    expect(JSON.stringify(view)).not.toContain('photos.example-host.com');
  });

  it('never reports how many times the photos were fetched (data-model_v2.md §5.9)', async () => {
    const booking = await completed();
    await saveDelivery(deps(), booking.id, { url: LINK, note: NOTE });
    await sendDelivery(deps(), booking.id);

    const view = await viewOf(booking.id);

    expect(Object.keys(view.delivery ?? {}).sort()).toEqual(['expired', 'expiresOn', 'note', 'url']);
    expect(JSON.stringify(view)).not.toMatch(/download/i);
  });
});

// --- Nothing private -----------------------------------------------------------------------

describe('what the view never carries', () => {
  it('has no token, no hash, no booking id, no client id, no email and no phone', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded' });
    await setDelivery(booking.id, {});

    const serialised = JSON.stringify(await viewOf(booking.id));

    const hash = await raw.query<{ hash: string }>('SELECT access_token_hash AS hash FROM booking WHERE id = $1', [booking.id]);
    for (const secret of [token, hash.rows[0]?.hash, booking.id, world.clientId, CLIENT.email, CLIENT.phone, '788123456']) {
      expect(serialised).not.toContain(secret);
    }
    for (const key of ['"id"', '"bookingId"', '"clientId"', '"contactEmail"', '"contactPhone"', '"accessToken"', '"ourRef"']) {
      // `waitingPayment.ourRef` is the client's own attempt, and this booking has none.
      expect(serialised).not.toContain(key);
    }
  });

  it('masks the email it carries, and a pending change, to the first letter and the domain (2026-09-25)', async () => {
    const { booking } = await insertBookingWithToken(prisma, world);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { pendingContactEmail: 'zoe.new@other.example', pendingEmailTokenHash: 'f'.repeat(64), pendingEmailExpiresAt: new Date(NOW.getTime() + 60_000) },
    });

    const view = await viewOf(booking.id);

    expect(view.maskedEmail).toBe('a•••••@example.com');
    expect(view.pendingMaskedEmail).toBe('z•••••@other.example');
    expect(JSON.stringify(view)).not.toContain('zoe.new');
  });

  it('carries the client’s own name, which is theirs to see (spec §2.2 P-13)', async () => {
    const { booking } = await insertBookingWithToken(prisma, world);

    expect((await viewOf(booking.id)).clientName).toBe(CLIENT.name);
  });
});
