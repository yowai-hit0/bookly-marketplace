import type { Booking, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOOKING_STATUSES } from '../db/statuses.js';
import { createPrismaClient } from '../db/client.js';
import { renderEmail } from '../email/render.js';
import { connect, firstRow, sqlstateOf, testDatabaseUrl, truncateAll } from '../test/database.js';
import { CLIENT, type PaymentWorld, insertBooking, insertPayment, seedWorld } from '../test/payment-fixtures.js';
import { FULL_BOOKING } from './access.js';
import { adminBookingView, findAdminBooking } from './admin-view.js';
import { clientBookingView } from './client-view.js';
import { saveDelivery, sendDelivery } from './delivery.js';

/**
 * Photo delivery (plan.md Task 21; spec §3.5 steps 5-7, §6.20, A-7, A-8;
 * data-model_v2.md §5.9, §6.5), against real PostgreSQL.
 *
 * What is proven. **Saving** stores the external host's link and dates it:
 * today plus `setting.delivery_expiry_days` -- 90 by A-8 -- measured in
 * **Kigali**, so an evening save that is still yesterday in UTC takes
 * tomorrow's ninety days and not today's. The photographer can type any date
 * over it. Saving stores and clears the optional note, replaces a link already
 * on file, and works only on a `completed` shoot: every other status is
 * `not_allowed` and an unknown booking is `not_found`. Saving is **not**
 * sending -- it puts nothing on the outbox and never touches
 * `delivery_sent_at`, because replacing a link does not unsend an email.
 *
 * **Sending** refuses `no_link` with nothing saved. Otherwise it stamps
 * `delivery_sent_at` and enqueues one `photo_delivery` carrying the link, the
 * expiry as a `YYYY-MM-DD` string, the note, the booking's own contact address
 * and its id. A second send is a second row under its own dedupe key, with the
 * first row left byte for byte as it was (spec §6.20: he can resend whenever an
 * email goes astray). Sending a booking whose expiry was never set dates it on
 * the way out, so the email can state a date in words.
 *
 * The email really carries both: rendering the enqueued payload produces the
 * external link as its button and the expiry spelled out in prose. And a link
 * that is not https cannot reach the column at all -- the `booking_delivery_url_https`
 * CHECK refuses even a raw `UPDATE`, behind the route's zod schema.
 *
 * Finally, **no download count exists** anywhere (plan.md Task 21,
 * data-model_v2.md §5.9): under hybrid delivery the files sit on a third party,
 * so a number here would be one the site invented.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;

/** The injected app clock: 08:00 Kigali on 1 October 2026. */
const NOW = new Date('2026-10-01T06:00:00Z');
/** 00:30 Kigali on 2 October -- still 1 October in UTC. */
const LATE_ON_THE_FIRST = new Date('2026-10-01T22:30:00Z');
/** 1 October 2026 plus the 90 days of spec A-8. */
const NINETY_FROM_THE_FIRST = '2026-12-30';
/** 2 October 2026 plus the same 90 days: one day later, and one day on. */
const NINETY_FROM_THE_SECOND = '2026-12-31';

const LINK = 'https://photos.example-host.com/s/abc123';
const OTHER_LINK = 'https://wetransfer.example/download/9f2c';
const NOTE = 'Thank you for a lovely morning!';
const WEB_ORIGIN = 'https://bookly.example';
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ee';

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

function deps(now: Date = NOW) {
  return { prisma, now: () => now };
}

type DeliveryRow = {
  delivery_url: string | null;
  /** Read as text: a `date` must never take a timezone on the way out. */
  delivery_expires_on: string | null;
  delivery_sent_at: Date | null;
  delivery_note: string | null;
};

/** The four delivery columns, through the raw driver rather than the client under test. */
async function deliveryRow(bookingId: string): Promise<DeliveryRow> {
  const result = await raw.query<DeliveryRow>(
    `SELECT delivery_url, delivery_expires_on::text AS delivery_expires_on, delivery_sent_at, delivery_note
       FROM booking WHERE id = $1`,
    [bookingId],
  );
  return firstRow(result);
}

type OutboxRow = {
  kind: string;
  template: string | null;
  recipient: string | null;
  booking_id: string | null;
  dedupe_key: string;
  status: string;
  attempts: number;
  payload: Record<string, unknown>;
  created_at: Date;
};

async function outbox(): Promise<OutboxRow[]> {
  const result = await raw.query<OutboxRow>(
    `SELECT kind, template, recipient, booking_id::text AS booking_id, dedupe_key, status, attempts, payload, created_at
       FROM outbox ORDER BY created_at, dedupe_key`,
  );
  return result.rows;
}

async function deliveries(): Promise<OutboxRow[]> {
  return (await outbox()).filter((row) => row.template === 'photo_delivery');
}

/** The one delivery message on the outbox, or a clear failure. */
async function onlyDelivery(): Promise<OutboxRow> {
  const rows = await deliveries();
  expect(rows).toHaveLength(1);
  return rows[0] as OutboxRow;
}

/** A completed shoot with its booking fee settled: 50,000 owed, 20,000 paid. */
async function completedBooking(): Promise<Booking> {
  const booking = await insertBooking(prisma, world, { status: 'completed' });
  await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000, ageSeconds: 600 });
  return booking;
}

/** Writes all four delivery columns directly, for states the editor cannot reach. */
async function setDeliveryRaw(
  bookingId: string,
  fields: { url?: string | null; expiresOn?: string | null; sentAt?: Date | null; note?: string | null },
): Promise<void> {
  await raw.query(
    `UPDATE booking
        SET delivery_url = $2, delivery_expires_on = $3::date, delivery_sent_at = $4::timestamptz, delivery_note = $5
      WHERE id = $1`,
    [bookingId, fields.url ?? null, fields.expiresOn ?? null, fields.sentAt ?? null, fields.note ?? null],
  );
}

async function adminView(bookingId: string, at: Date = NOW) {
  const booking = await findAdminBooking(prisma, bookingId);
  if (booking === null) throw new Error('No such booking');
  return adminBookingView(booking, at);
}

// --- Saving: the link and its date ---------------------------------------------------------

describe('saving the link (spec §3.5 step 5)', () => {
  it('stores the external host’s link on the booking', async () => {
    const booking = await completedBooking();

    const result = await saveDelivery(deps(), booking.id, { url: LINK });

    expect(result.status).toBe('ok');
    expect(await deliveryRow(booking.id)).toMatchObject({ delivery_url: LINK });
  });

  it('dates it today plus the configured ninety days, as spec A-8 asks', async () => {
    const booking = await completedBooking();

    await saveDelivery(deps(), booking.id, { url: LINK });

    expect((await deliveryRow(booking.id)).delivery_expires_on).toBe(NINETY_FROM_THE_FIRST);
  });

  /**
   * The default is "today plus ninety" in **Kigali**, not in UTC. At 22:30Z it
   * is already tomorrow in Kigali (spec §6.5), so the ninety days run from
   * tomorrow -- and a save a few hours earlier the same UTC day gets a
   * different date.
   */
  it('measures today in Kigali: an evening save takes tomorrow’s ninety days', async () => {
    const early = await completedBooking();
    const late = await completedBooking();

    await saveDelivery(deps(NOW), early.id, { url: LINK });
    await saveDelivery(deps(LATE_ON_THE_FIRST), late.id, { url: LINK });

    expect((await deliveryRow(early.id)).delivery_expires_on).toBe(NINETY_FROM_THE_FIRST);
    expect((await deliveryRow(late.id)).delivery_expires_on).toBe(NINETY_FROM_THE_SECOND);
  });

  it('reads the lifetime from the setting rather than hard-coding ninety', async () => {
    await prisma.setting.update({ where: { id: 1 }, data: { deliveryExpiryDays: 30 } });
    const booking = await completedBooking();

    await saveDelivery(deps(), booking.id, { url: LINK });

    // 1 October plus thirty days.
    expect((await deliveryRow(booking.id)).delivery_expires_on).toBe('2026-10-31');
  });

  it('honours a date he typed over the default', async () => {
    const booking = await completedBooking();

    await saveDelivery(deps(), booking.id, { url: LINK, expiresOn: '2027-03-15' });

    expect((await deliveryRow(booking.id)).delivery_expires_on).toBe('2027-03-15');
  });

  it('takes a date in the past, which is how he closes a link early', async () => {
    const booking = await completedBooking();

    const result = await saveDelivery(deps(), booking.id, { url: LINK, expiresOn: '2026-09-01' });

    expect(result.status).toBe('ok');
    expect((await deliveryRow(booking.id)).delivery_expires_on).toBe('2026-09-01');
  });

  it('stores the note, and clears it again when he sends null', async () => {
    const booking = await completedBooking();

    await saveDelivery(deps(), booking.id, { url: LINK, note: NOTE });
    expect((await deliveryRow(booking.id)).delivery_note).toBe(NOTE);

    await saveDelivery(deps(), booking.id, { url: LINK, note: null });
    expect((await deliveryRow(booking.id)).delivery_note).toBeNull();
  });

  it('leaves a note it was not asked about exactly where it was', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK, note: NOTE });

    await saveDelivery(deps(), booking.id, { url: OTHER_LINK });

    expect(await deliveryRow(booking.id)).toMatchObject({ delivery_url: OTHER_LINK, delivery_note: NOTE });
  });

  /**
   * Tested as the code behaves, and flagged rather than "fixed".
   * `data-model_v2.md` §5.9 says the default applies "when first set"; the code
   * applies it on **every** save that carries no date, so re-saving to change a
   * note moves the expiry the client has already been told about. Whether that
   * is right is a decision, not a bug this suite may make.
   */
  it('replaces a link already on file, and re-dates it from today', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK, expiresOn: '2026-11-01' });

    await saveDelivery(deps(), booking.id, { url: OTHER_LINK });

    expect(await deliveryRow(booking.id)).toMatchObject({
      delivery_url: OTHER_LINK,
      delivery_expires_on: NINETY_FROM_THE_FIRST,
    });
  });

  it('moves the date a client was already told, when only the note is being changed', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK });
    await sendDelivery(deps(), booking.id);
    expect((await deliveryRow(booking.id)).delivery_expires_on).toBe(NINETY_FROM_THE_FIRST);

    // A week later he adds a line for the client, and touches nothing else.
    await saveDelivery(deps(new Date('2026-10-08T06:00:00Z')), booking.id, { url: LINK, note: NOTE });

    // The email said 30 December; the booking now says 6 January.
    expect((await deliveryRow(booking.id)).delivery_expires_on).toBe('2027-01-06');
    expect((await onlyDelivery()).payload.expiresOn).toBe(NINETY_FROM_THE_FIRST);
  });

  it('answers the booking as it now stands, with both delivery flags set', async () => {
    const booking = await completedBooking();

    const result = await saveDelivery(deps(), booking.id, { url: LINK, note: NOTE });
    if (result.status !== 'ok') throw new Error(`Expected ok, got ${result.status}`);

    const view = adminBookingView(result.booking, NOW);
    expect(view.delivery).toStrictEqual({
      url: LINK,
      expiresOn: NINETY_FROM_THE_FIRST,
      sentAt: null,
      note: NOTE,
    });
    expect(view.actions).toMatchObject({ canEditDelivery: true, canSendDelivery: true });
  });
});

// --- Saving: only a shoot that happened -----------------------------------------------------

describe('which bookings may be given a link', () => {
  it.each(BOOKING_STATUSES.filter((status) => status !== 'completed'))(
    'refuses a %s booking with not_allowed and stores nothing',
    async (status) => {
      const booking = await insertBooking(prisma, world, { status });

      const result = await saveDelivery(deps(), booking.id, { url: LINK });

      expect(result).toStrictEqual({ status: 'not_allowed' });
      expect(await deliveryRow(booking.id)).toStrictEqual({
        delivery_url: null,
        delivery_expires_on: null,
        delivery_sent_at: null,
        delivery_note: null,
      });
    },
  );

  it('answers not_found for a booking id nothing matches, and touches no other booking', async () => {
    const other = await completedBooking();

    const result = await saveDelivery(deps(), UNKNOWN_ID, { url: LINK });

    expect(result).toStrictEqual({ status: 'not_found' });
    expect((await deliveryRow(other.id)).delivery_url).toBeNull();
  });

  it('opens the moment the shoot is completed, and says so through canEditDelivery', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    expect(await saveDelivery(deps(), booking.id, { url: LINK })).toStrictEqual({ status: 'not_allowed' });
    expect((await adminView(booking.id)).actions.canEditDelivery).toBe(false);

    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'completed', completedAt: NOW } });

    expect((await saveDelivery(deps(), booking.id, { url: LINK })).status).toBe('ok');
    expect((await adminView(booking.id)).actions).toMatchObject({ canEditDelivery: true, canSendDelivery: true });
  });
});

// --- Saving is not sending ------------------------------------------------------------------

describe('saving sends nothing (spec §3.5, steps 5 and 6 are separate acts)', () => {
  it('puts no message on the outbox at all', async () => {
    const booking = await completedBooking();

    await saveDelivery(deps(), booking.id, { url: LINK, note: NOTE });

    expect(await outbox()).toEqual([]);
  });

  it('leaves delivery_sent_at null on a booking that has never been written to', async () => {
    const booking = await completedBooking();

    await saveDelivery(deps(), booking.id, { url: LINK });

    expect((await deliveryRow(booking.id)).delivery_sent_at).toBeNull();
    expect((await adminView(booking.id)).delivery.sentAt).toBeNull();
  });

  it('never unsends an earlier email by replacing the link it named', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK });
    await sendDelivery(deps(), booking.id);
    const sentAt = (await deliveryRow(booking.id)).delivery_sent_at;
    expect(sentAt).not.toBeNull();

    await saveDelivery(deps(new Date('2026-10-05T06:00:00Z')), booking.id, { url: OTHER_LINK });

    expect((await deliveryRow(booking.id)).delivery_sent_at).toEqual(sentAt);
    expect(await deliveries()).toHaveLength(1);
  });
});

// --- Sending --------------------------------------------------------------------------------

describe('sending the photos (spec §3.5 step 6)', () => {
  it('refuses no_link when nothing has been saved, and writes nothing', async () => {
    const booking = await completedBooking();

    const result = await sendDelivery(deps(), booking.id);

    expect(result).toStrictEqual({ status: 'no_link' });
    expect((await deliveryRow(booking.id)).delivery_sent_at).toBeNull();
    expect(await outbox()).toEqual([]);
  });

  it.each(BOOKING_STATUSES.filter((status) => status !== 'completed'))('refuses a %s booking with not_allowed', async (status) => {
    const booking = await insertBooking(prisma, world, { status });
    // A link the editor would never have let him save, put there directly.
    await setDeliveryRaw(booking.id, { url: LINK, expiresOn: '2027-01-01' });

    const result = await sendDelivery(deps(), booking.id);

    expect(result).toStrictEqual({ status: 'not_allowed' });
    expect((await deliveryRow(booking.id)).delivery_sent_at).toBeNull();
    expect(await outbox()).toEqual([]);
  });

  it('answers not_found for a booking id nothing matches', async () => {
    expect(await sendDelivery(deps(), UNKNOWN_ID)).toStrictEqual({ status: 'not_found' });
  });

  it('stamps delivery_sent_at with the injected clock', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK });
    const at = new Date('2026-10-02T09:15:00Z');

    const result = await sendDelivery(deps(at), booking.id);

    expect(result.status).toBe('ok');
    expect((await deliveryRow(booking.id)).delivery_sent_at).toEqual(at);
    expect((await adminView(booking.id)).delivery.sentAt).toBe(at.toISOString());
  });

  it('enqueues exactly one photo_delivery, to the booking’s own contact address', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK, note: NOTE });
    const at = new Date('2026-10-02T09:15:00Z');

    await sendDelivery(deps(at), booking.id);

    const message = await onlyDelivery();
    expect(message).toMatchObject({
      kind: 'email',
      template: 'photo_delivery',
      recipient: CLIENT.email,
      booking_id: booking.id,
      dedupe_key: `email:photo_delivery:${booking.id}:${at.toISOString()}`,
      status: 'pending',
      attempts: 0,
    });
  });

  it('carries the link, the expiry as a YYYY-MM-DD string, and the note', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK, expiresOn: '2027-01-01', note: NOTE });

    await sendDelivery(deps(), booking.id);

    expect((await onlyDelivery()).payload).toStrictEqual({
      locale: 'en',
      reference: booking.reference,
      clientName: CLIENT.name,
      serviceName: 'Portraits',
      deliveryUrl: LINK,
      expiresOn: '2027-01-01',
      note: NOTE,
    });
  });

  it('carries a null note when he wrote none', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK });

    await sendDelivery(deps(), booking.id);

    expect((await onlyDelivery()).payload.note).toBeNull();
  });

  it('dates a booking whose expiry was never set, rather than sending a date-less email', async () => {
    const booking = await completedBooking();
    // A link with no expiry: not something the editor writes, but the column allows it.
    await setDeliveryRaw(booking.id, { url: LINK });
    expect((await deliveryRow(booking.id)).delivery_expires_on).toBeNull();

    const result = await sendDelivery(deps(), booking.id);

    expect(result.status).toBe('ok');
    expect((await deliveryRow(booking.id)).delivery_expires_on).toBe(NINETY_FROM_THE_FIRST);
    expect((await onlyDelivery()).payload.expiresOn).toBe(NINETY_FROM_THE_FIRST);
  });

  it('leaves the expiry he chose alone', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK, expiresOn: '2026-11-11' });

    await sendDelivery(deps(), booking.id);

    expect((await deliveryRow(booking.id)).delivery_expires_on).toBe('2026-11-11');
  });
});

// --- Sending again (spec §6.20) ---------------------------------------------------------------

describe('sending again', () => {
  it('writes a second row under its own dedupe key and leaves the first untouched', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK, expiresOn: '2027-01-01', note: NOTE });
    const first = new Date('2026-10-02T09:15:00Z');
    const second = new Date('2026-10-09T11:00:00Z');

    await sendDelivery(deps(first), booking.id);
    const before = (await deliveries())[0] as OutboxRow;

    await sendDelivery(deps(second), booking.id);

    const rows = await deliveries();
    expect(rows).toHaveLength(2);
    // The whole first row, byte for byte, including its payload and its status.
    expect(rows[0]).toStrictEqual(before);
    expect(rows.map((row) => row.dedupe_key)).toEqual([
      `email:photo_delivery:${booking.id}:${first.toISOString()}`,
      `email:photo_delivery:${booking.id}:${second.toISOString()}`,
    ]);
    expect(new Set(rows.map((row) => row.dedupe_key)).size).toBe(2);
  });

  it('re-stamps delivery_sent_at with the latest send', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK });
    const second = new Date('2026-10-09T11:00:00Z');

    await sendDelivery(deps(new Date('2026-10-02T09:15:00Z')), booking.id);
    await sendDelivery(deps(second), booking.id);

    expect((await deliveryRow(booking.id)).delivery_sent_at).toEqual(second);
  });

  it('sends the replaced link, leaving the message that named the old one in the history', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK });
    await sendDelivery(deps(new Date('2026-10-02T09:15:00Z')), booking.id);

    await saveDelivery(deps(new Date('2026-10-05T06:00:00Z')), booking.id, { url: OTHER_LINK });
    await sendDelivery(deps(new Date('2026-10-05T06:01:00Z')), booking.id);

    expect((await deliveries()).map((row) => row.payload.deliveryUrl)).toEqual([LINK, OTHER_LINK]);
  });

  it('collapses two sends inside one millisecond: the same click twice is one message', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK });
    const at = new Date('2026-10-02T09:15:00Z');

    await sendDelivery(deps(at), booking.id);
    const again = await sendDelivery(deps(at), booking.id);

    expect(again.status).toBe('ok');
    expect(await deliveries()).toHaveLength(1);
  });

  it('shows every send in the booking’s own message history (spec P-28)', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK });
    await sendDelivery(deps(new Date('2026-10-02T09:15:00Z')), booking.id);
    await sendDelivery(deps(new Date('2026-10-09T11:00:00Z')), booking.id);

    const messages = (await adminView(booking.id)).messages.filter((message) => message.template === 'photo_delivery');

    expect(messages).toHaveLength(2);
    expect(messages.every((message) => message.recipient === CLIENT.email)).toBe(true);
  });
});

// --- A booking that moves while the photos are going out ------------------------------------------

/**
 * Tested as the code behaves, and left failing rather than "fixed".
 *
 * `saveDelivery` checks the `count` its guarded `updateMany` returns
 * (delivery.ts:59-68): a booking cancelled between the status read and the
 * write keeps no delivery it could no longer honour. `sendDelivery` runs the
 * same guarded `updateMany` (delivery.ts:87-90) and **throws the count away**,
 * then enqueues the email inside the same transaction -- so a booking cancelled
 * in that window gets its client an email about photos for a booking that no
 * longer stands, while `delivery_sent_at` stays null and the client's own page
 * shows nothing at all.
 *
 * The window is opened deterministically here, by holding the booking row from
 * a second connection until the send is waiting on it.
 */
describe('a booking cancelled while the send is in flight', () => {
  /** Waits until some other session is blocked on a lock in this database. */
  async function waitForABlockedWriter(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await raw.query<{ blocked: string }>(
        `SELECT count(*) AS blocked FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`,
      );
      if (Number(result.rows[0]?.blocked ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('The send never reached the row the cancellation was holding');
  }

  it('sends no email for a booking it could not stamp', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK, expiresOn: '2027-01-01' });

    const blocker = connect();
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM booking WHERE id = $1 FOR UPDATE', [booking.id]);

      // The send now blocks on that row, as the photographer's cancel lands.
      const sending = sendDelivery(deps(), booking.id);
      await waitForABlockedWriter();
      await blocker.query(`UPDATE booking SET status = 'cancelled_by_admin', cancelled_at = now() WHERE id = $1`, [booking.id]);
      await blocker.query('COMMIT');
      await sending;
    } finally {
      await blocker.end();
    }

    // The booking was no longer completed, so nothing was stamped...
    expect((await deliveryRow(booking.id)).delivery_sent_at).toBeNull();
    // ...and nothing should have been written to the client either.
    expect(await deliveries()).toEqual([]);
  });
});

// --- What the client is actually sent -----------------------------------------------------------

describe('the email the payload renders to', () => {
  /** Renders whatever the send put on the outbox, exactly as the worker would. */
  async function renderQueued() {
    const message = await onlyDelivery();
    return renderEmail('photo_delivery', message.payload, { webOrigin: WEB_ORIGIN, locale: 'en' });
  }

  it('offers the external link as its button and states the date in words', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK, expiresOn: '2027-01-01', note: NOTE });
    await sendDelivery(deps(), booking.id);

    const email = await renderQueued();

    expect(email.html).toContain(`href="${LINK}"`);
    expect(email.text).toContain(LINK);
    expect(email.text).toContain('until the end of Friday, 1 January 2027 (Kigali time)');
    expect(email.html).toContain('Friday, 1 January 2027');
    expect(email.text).toContain(NOTE);
    expect(email.subject).toContain(booking.reference);
  });

  it('states the default ninety-day date in words too, when he typed none', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK });
    await sendDelivery(deps(), booking.id);

    const email = await renderQueued();

    // NINETY_FROM_THE_FIRST, spelled out.
    expect(email.text).toContain('until the end of Wednesday, 30 December 2026 (Kigali time)');
  });
});

// --- The column will not hold a link that is not https --------------------------------------------

describe('booking_delivery_url_https (data-model_v2.md §5.9)', () => {
  it.each(['http://photos.example-host.com/s/abc', 'ftp://photos.example-host.com/abc', 'javascript:alert(1)', 'photos.example-host.com'])(
    'refuses a raw UPDATE writing %s',
    async (url) => {
      const booking = await completedBooking();

      const sqlstate = await sqlstateOf(raw, () =>
        raw.query('UPDATE booking SET delivery_url = $2 WHERE id = $1', [booking.id, url]),
      );

      expect(sqlstate).toBe('23514');
      expect((await deliveryRow(booking.id)).delivery_url).toBeNull();
    },
  );

  it('refuses the same link through saveDelivery, rather than letting the CHECK throw', async () => {
    const booking = await completedBooking();

    // Answered, not raised: the column is the backstop, never the validator
    // (routes/validation.ts), so nothing here can reach the caller as a 500.
    const result = await saveDelivery(deps(), booking.id, { url: 'http://photos.example-host.com/s/abc' });

    expect(result).toStrictEqual({ status: 'not_allowed' });
    expect((await deliveryRow(booking.id)).delivery_url).toBeNull();
  });

  it('stores an uppercase scheme the way the column spells it', async () => {
    const booking = await completedBooking();

    const result = await saveDelivery(deps(), booking.id, { url: 'HTTPS://photos.example-host.com/s/abc' });

    // https by every reasonable reading, so it is saved rather than refused --
    // in the spelling the CHECK insists on.
    expect(result.status).toBe('ok');
    expect((await deliveryRow(booking.id)).delivery_url).toBe('https://photos.example-host.com/s/abc');
  });

  it('takes an uppercase scheme nowhere: the CHECK is on the literal text', async () => {
    const booking = await completedBooking();

    const sqlstate = await sqlstateOf(raw, () =>
      raw.query('UPDATE booking SET delivery_url = $2 WHERE id = $1', [booking.id, 'HTTPS://photos.example-host.com/s/abc']),
    );

    expect(sqlstate).toBe('23514');
  });

  it('allows null, because a completed shoot need not have a link yet', async () => {
    const booking = await completedBooking();

    const sqlstate = await sqlstateOf(raw, () => raw.query('UPDATE booking SET delivery_url = NULL WHERE id = $1', [booking.id]));

    expect(sqlstate).toBeUndefined();
  });
});

// --- No download count exists (plan.md Task 21, data-model_v2.md §5.9) -------------------------------

/**
 * The files are on a third party's host (A-7), so a download happens entirely
 * between the client and that host. Any number the site showed would be one it
 * invented. This asserts the absence at three levels: the column, the
 * photographer's view and the client's.
 */
describe('nothing counts downloads', () => {
  it('has no such column on booking: the four delivery columns are all there are', async () => {
    const result = await raw.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'booking' AND column_name LIKE 'delivery%' ORDER BY column_name`,
    );

    expect(result.rows.map((row) => row.column_name)).toEqual([
      'delivery_expires_on',
      'delivery_note',
      'delivery_sent_at',
      'delivery_url',
    ]);
  });

  it('has no column anywhere in the schema that counts downloads or opens', async () => {
    const result = await raw.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name ~* 'download' OR column_name ~* '(open|view|fetch)_count')`,
    );

    expect(result.rows).toEqual([]);
  });

  it('reports no count to the photographer: the delivery block is link, date, sent and note', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK, note: NOTE });
    await sendDelivery(deps(), booking.id);

    const view = await adminView(booking.id);

    expect(Object.keys(view.delivery).sort()).toEqual(['expiresOn', 'note', 'sentAt', 'url']);
    expect(JSON.stringify(view)).not.toMatch(/download/i);
  });

  it('reports no count to the client either', async () => {
    const booking = await completedBooking();
    await saveDelivery(deps(), booking.id, { url: LINK, note: NOTE });
    await sendDelivery(deps(), booking.id);
    const accessed = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id }, include: FULL_BOOKING });

    const view = clientBookingView(accessed, NOW);

    expect(Object.keys(view.delivery ?? {}).sort()).toEqual(['expired', 'expiresOn', 'note', 'url']);
    expect(JSON.stringify(view)).not.toMatch(/download/i);
  });
});
