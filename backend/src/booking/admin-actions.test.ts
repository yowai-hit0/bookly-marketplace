import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findAvailability } from '../availability/query.js';
import { createPrismaClient } from '../db/client.js';
import { renderEmail } from '../email/render.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  ADMIN_EMAIL,
  BUFFER_MINUTES,
  CLIENT,
  DURATION_MINUTES,
  type PaymentWorld,
  grantAccessToken,
  insertBooking,
  insertBookingWithToken,
  insertPayment,
  seedWorld,
} from '../test/payment-fixtures.js';
import { findBookingByToken } from './access.js';
import { hashAccessToken } from './access-token.js';
import { type RescheduleResult, cancelByAdmin, markCompleted, markNoShow, rescheduleBooking, resendAccessLink } from './admin-actions.js';
import { type AdminBooking, adminBookingView, findAdminBooking } from './admin-view.js';
import { bookingTotals } from './totals.js';

/**
 * Everything the photographer does to a booking after it exists (plan.md Task
 * 19; spec §3.6, §6.11, §6.12, §6.16, §6.21), against real PostgreSQL.
 *
 * What is proven. **Reschedule:** the booking is the same booking at a new
 * time -- same id, reference, access token and payments -- with `ends_at` and
 * `buffer_ends_at` both recomputed from the new start (a buffer left behind
 * would hold time the booking no longer occupies, or break its own CHECK),
 * `original_starts_at` written on the first move only and `rescheduled_at` on
 * every one. The old slot is free the moment it commits, the new one is
 * decided by the exclusion constraint -- a taken slot is `slot_taken`, never a
 * 500 -- and a lapsed hold in the way is expired rather than allowed to block.
 * Two moves racing for one slot produce one winner.
 *
 * **Cancel:** `cancelled_by_admin` with the reason, the slot released, every
 * penny collected flagged `refund_due` (the booking fee by policy, a session
 * fee because the shoot will not happen), the client emailed once and the
 * photographer alerted once per flagged payment (spec §6.16).
 *
 * **Complete and no-show:** only from `confirmed`, and only once the shoot has
 * begun. Completing is refused `balance_due` while anything is still owed --
 * "completed" means paid (2026-09-27) -- and only sets `completed` once it is
 * not. A no-show keeps its slot -- the time was consumed -- keeps the
 * booking fee, owes nothing further, and sends the client nothing (spec §6.12).
 *
 * **Resend:** a new token, a fresh expiry, the previous link dead the moment it
 * commits, and the plaintext in the outbox payload and nowhere else.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;

/** The injected app clock: long before every fixture shoot (January 2027). */
const NOW = new Date('2026-10-01T06:00:00Z');
/** After every fixture shoot, for the actions that need one to have started. */
const AFTER_THE_SHOOT = new Date('2027-06-01T06:00:00Z');
const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;

function deps(now: Date = NOW) {
  return { prisma, now: () => now };
}

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

type OutboxRow = {
  kind: string;
  template: string | null;
  recipient: string | null;
  dedupe_key: string;
  booking_id: string | null;
  payload: Record<string, unknown>;
};

async function outbox(): Promise<OutboxRow[]> {
  const result = await raw.query<OutboxRow>(
    'SELECT kind, template, recipient, dedupe_key, booking_id::text AS booking_id, payload FROM outbox ORDER BY created_at, dedupe_key',
  );
  return result.rows;
}

type BookingRow = {
  reference: string;
  status: string;
  starts_at: Date;
  ends_at: Date;
  buffer_ends_at: Date;
  original_starts_at: Date | null;
  rescheduled_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  access_token_hash: string | null;
  access_token_expires_at: Date | null;
  access_token_last_used_at: Date | null;
};

async function bookingRow(id: string): Promise<BookingRow> {
  const result = await raw.query<BookingRow>(
    `SELECT reference, status, starts_at, ends_at, buffer_ends_at, original_starts_at, rescheduled_at,
            completed_at, cancelled_at, cancellation_reason,
            access_token_hash, access_token_expires_at, access_token_last_used_at
       FROM booking WHERE id = $1`,
    [id],
  );
  if (result.rows[0] === undefined) throw new Error('No such booking');
  return result.rows[0];
}

type PaymentRow = { id: string; kind: string; status: string; amount_rwf: number; settled_at: Date | null; refunded_at: Date | null };

async function payments(bookingId: string): Promise<PaymentRow[]> {
  const result = await raw.query<PaymentRow>(
    `SELECT id::text AS id, kind, status, amount_rwf, settled_at, refunded_at
       FROM payment WHERE booking_id = $1 ORDER BY initiated_at, amount_rwf`,
    [bookingId],
  );
  return result.rows;
}

/** The booking a successful action answered with, or a clear failure. */
function ok(result: RescheduleResult): { status: 'ok'; booking: AdminBooking } {
  if (result.status !== 'ok') throw new Error(`Expected ok, got ${result.status}`);
  return result;
}

/** The booking as the admin screen loads it, or a clear failure. */
async function adminBooking(id: string): Promise<AdminBooking> {
  const booking = await findAdminBooking(prisma, id);
  if (booking === null) throw new Error('No such booking');
  return booking;
}

/** The single outbox row, or a clear failure. */
async function onlyMessage(): Promise<OutboxRow> {
  const rows = await outbox();
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(`Expected one message, got ${rows.length}`);
  return rows[0];
}

/** Mon-Fri 09:00-17:00, so the fixture days generate slots at all. */
async function openTheDiary(): Promise<void> {
  await prisma.workingHours.createMany({
    data: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinute: 540, closesMinute: 1020 })),
  });
}

/** Every free start on the Kigali date of `instant`, as a visitor would see it. */
async function freeStarts(instant: Date, now: Date = NOW): Promise<string[]> {
  const date = new Date(instant.getTime() + 2 * 60 * MINUTE_MS).toISOString().slice(0, 10);
  const days = await findAvailability(prisma, { from: date, to: date, packageDurationMinutes: DURATION_MINUTES, now });
  return days[0]?.starts ?? [];
}

/** Can another booking be written across this range? The exclusion constraint decides. */
async function slotIsFree(startsAt: Date): Promise<boolean> {
  try {
    const taker = await insertBooking(prisma, world, { startsAt, status: 'confirmed' });
    await prisma.booking.delete({ where: { id: taker.id } });
    return true;
  } catch {
    return false;
  }
}

/** A confirmed booking on a Wednesday in January 2027, 09:00 Kigali. */
const WEDNESDAY_0900 = new Date('2027-01-06T07:00:00Z');
const WEDNESDAY_1400 = new Date('2027-01-06T12:00:00Z');
const THURSDAY_0900 = new Date('2027-01-07T07:00:00Z');

// --- Reschedule -------------------------------------------------------------------------

describe('rescheduling a confirmed booking', () => {
  it('is the same booking at a new time: same id, reference and access token', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world, { startsAt: WEDNESDAY_0900 });
    const before = await bookingRow(booking.id);

    const result = ok(await rescheduleBooking(deps(), booking.id, THURSDAY_0900));

    expect(result.booking.id).toBe(booking.id);
    const after = await bookingRow(booking.id);
    expect(after.reference).toBe(before.reference);
    expect(after.access_token_hash).toBe(before.access_token_hash);
    expect(after.access_token_expires_at?.toISOString()).toBe(before.access_token_expires_at?.toISOString());
    // The link the client already holds still opens the booking.
    expect((await findBookingByToken(prisma, token))?.id).toBe(booking.id);
  });

  it('leaves every payment row exactly as it was', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000, ageSeconds: 300 });
    await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 100 });
    const before = await payments(booking.id);

    await rescheduleBooking(deps(), booking.id, THURSDAY_0900);

    expect(await payments(booking.id)).toStrictEqual(before);
  });

  it('recomputes ends_at and buffer_ends_at from the new start, the package duration and the buffer in force', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    await rescheduleBooking(deps(), booking.id, THURSDAY_0900);

    const row = await bookingRow(booking.id);
    expect(row.starts_at.toISOString()).toBe(THURSDAY_0900.toISOString());
    expect(row.ends_at.getTime()).toBe(THURSDAY_0900.getTime() + DURATION_MINUTES * MINUTE_MS);
    expect(row.buffer_ends_at.getTime()).toBe(row.ends_at.getTime() + BUFFER_MINUTES * MINUTE_MS);
  });

  it('uses the buffer setting as it stands now, not the one the booking was created under', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await prisma.setting.update({ where: { id: 1 }, data: { bufferMinutes: 45 } });

    await rescheduleBooking(deps(), booking.id, THURSDAY_0900);

    const row = await bookingRow(booking.id);
    expect(row.buffer_ends_at.getTime() - row.ends_at.getTime()).toBe(45 * MINUTE_MS);
    // And the CHECK it would otherwise break still holds.
    expect(row.buffer_ends_at.getTime()).toBeGreaterThanOrEqual(row.ends_at.getTime());
  });

  it('writes original_starts_at on the first move only, and rescheduled_at on every move', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    const secondMove = new Date('2027-01-08T07:00:00Z');

    await rescheduleBooking(deps(), booking.id, THURSDAY_0900);
    const afterFirst = await bookingRow(booking.id);
    await rescheduleBooking(deps(new Date(NOW.getTime() + DAY_MS)), booking.id, secondMove);
    const afterSecond = await bookingRow(booking.id);

    expect(afterFirst.original_starts_at?.toISOString()).toBe(WEDNESDAY_0900.toISOString());
    expect(afterFirst.rescheduled_at?.toISOString()).toBe(NOW.toISOString());
    // The time originally agreed survives the second move; the stamp does not.
    expect(afterSecond.original_starts_at?.toISOString()).toBe(WEDNESDAY_0900.toISOString());
    expect(afterSecond.rescheduled_at?.toISOString()).toBe(new Date(NOW.getTime() + DAY_MS).toISOString());
    expect(afterSecond.starts_at.toISOString()).toBe(secondMove.toISOString());
  });

  it('releases the old slot the moment it commits', async () => {
    await openTheDiary();
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    expect(await freeStarts(WEDNESDAY_0900)).not.toContain(WEDNESDAY_0900.toISOString());

    await rescheduleBooking(deps(), booking.id, THURSDAY_0900);

    expect(await freeStarts(WEDNESDAY_0900)).toContain(WEDNESDAY_0900.toISOString());
    expect(await slotIsFree(WEDNESDAY_0900)).toBe(true);
    // And the time it moved to is occupied instead.
    expect(await freeStarts(THURSDAY_0900)).not.toContain(THURSDAY_0900.toISOString());
  });

  it('refuses a slot a live booking already holds, as slot_taken rather than a 500', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertBooking(prisma, world, { status: 'confirmed', startsAt: THURSDAY_0900 });

    expect(await rescheduleBooking(deps(), booking.id, THURSDAY_0900)).toStrictEqual({ status: 'slot_taken' });
    expect((await bookingRow(booking.id)).starts_at.toISOString()).toBe(WEDNESDAY_0900.toISOString());
  });

  it('refuses a slot that only overlaps the other booking’s buffer', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    const neighbour = await insertBooking(prisma, world, { status: 'confirmed', startsAt: THURSDAY_0900 });
    // Starts while the neighbour's 30-minute buffer is still running.
    const intoTheBuffer = new Date(neighbour.startsAt.getTime() + (DURATION_MINUTES + 15) * MINUTE_MS);

    expect(await rescheduleBooking(deps(), booking.id, intoTheBuffer)).toStrictEqual({ status: 'slot_taken' });
  });

  it('takes a slot a lapsed hold was sitting on, expiring the hold rather than failing', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    const stale = await insertBooking(prisma, world, { status: 'pending_payment', holdMinutes: -30, startsAt: THURSDAY_0900 });

    const result = ok(await rescheduleBooking(deps(), booking.id, THURSDAY_0900));

    expect(result.booking.startsAt.toISOString()).toBe(THURSDAY_0900.toISOString());
    expect((await bookingRow(stale.id)).status).toBe('expired');
  });

  it('is blocked by a hold that has not lapsed yet', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    const live = await insertBooking(prisma, world, { status: 'pending_payment', holdMinutes: 30, startsAt: THURSDAY_0900 });

    expect(await rescheduleBooking(deps(), booking.id, THURSDAY_0900)).toStrictEqual({ status: 'slot_taken' });
    expect((await bookingRow(live.id)).status).toBe('pending_payment');
  });

  it('answers unchanged for the instant the booking already has, and touches nothing', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    expect(await rescheduleBooking(deps(), booking.id, new Date(WEDNESDAY_0900.getTime()))).toStrictEqual({ status: 'unchanged' });
    expect(await bookingRow(booking.id)).toMatchObject({ rescheduled_at: null, original_starts_at: null });
    expect(await outbox()).toEqual([]);
  });

  it('answers not_found for a booking that does not exist', async () => {
    expect(await rescheduleBooking(deps(), '3f1b9c2a-0000-4000-8000-00000000abcd', THURSDAY_0900)).toStrictEqual({
      status: 'not_found',
    });
  });

  it.each(['pending_payment', 'completed', 'no_show', 'expired', 'cancelled_by_client', 'cancelled_by_admin'] as const)(
    'refuses a %s booking: only a confirmed one can be moved',
    async (status) => {
      const booking = await insertBooking(prisma, world, { status, startsAt: WEDNESDAY_0900 });

      expect(await rescheduleBooking(deps(), booking.id, THURSDAY_0900)).toStrictEqual({ status: 'not_allowed' });
      expect((await bookingRow(booking.id)).starts_at.toISOString()).toBe(WEDNESDAY_0900.toISOString());
      expect(await outbox()).toEqual([]);
    },
  );
});

// --- The reschedule email ----------------------------------------------------------------

describe('the email a reschedule enqueues', () => {
  it('queues one reschedule to the booking’s own contact address, keyed per move', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    await rescheduleBooking(deps(), booking.id, THURSDAY_0900);

    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'email',
      template: 'reschedule',
      recipient: CLIENT.email,
      booking_id: booking.id,
      dedupe_key: `email:reschedule:${booking.id}:${NOW.toISOString()}:${THURSDAY_0900.toISOString()}`,
    });
  });

  it('carries both the old time and the new one, and no access token at all', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world, { startsAt: WEDNESDAY_0900 });

    await rescheduleBooking(deps(), booking.id, THURSDAY_0900);

    const row = await onlyMessage();
    expect(row.payload).toStrictEqual({
      locale: 'en',
      reference: booking.reference,
      clientName: CLIENT.name,
      serviceName: 'Portraits',
      packageName: 'Standard',
      startsAt: THURSDAY_0900.toISOString(),
      endsAt: new Date(THURSDAY_0900.getTime() + DURATION_MINUTES * MINUTE_MS).toISOString(),
      previousStartsAt: WEDNESDAY_0900.toISOString(),
      previousEndsAt: booking.endsAt.toISOString(),
      locationText: CLIENT.location,
      // The booking keeps its token and the plaintext was never stored, so the
      // email points at the link the client already has (spec §6.21).
      accessToken: null,
    });
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('renders through the real template', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    await rescheduleBooking(deps(), booking.id, THURSDAY_0900);

    const row = await onlyMessage();
    const email = renderEmail(row.template as string, row.payload, { webOrigin: 'https://bookly.example' });
    expect(email.text).toContain(booking.reference);
    expect([email.subject, email.text, email.html].join('\n')).not.toMatch(/\{\{|undefined|NaN|\[object Object\]/);
  });

  it('queues a second email for a second move, keeping the first in the history', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    const later = new Date(NOW.getTime() + DAY_MS);

    await rescheduleBooking(deps(), booking.id, THURSDAY_0900);
    await rescheduleBooking(deps(later), booking.id, new Date('2027-01-08T07:00:00Z'));

    expect((await outbox()).map((row) => row.dedupe_key)).toEqual([
      `email:reschedule:${booking.id}:${NOW.toISOString()}:${THURSDAY_0900.toISOString()}`,
      `email:reschedule:${booking.id}:${later.toISOString()}:2027-01-08T07:00:00.000Z`,
    ]);
  });

  it('still emails both moves when they land on the same millisecond, because the target time keys them apart', async () => {
    // The clock alone cannot tell two moves apart at millisecond resolution,
    // and a move whose email were dropped as a duplicate would leave the
    // client at a time nobody told him about.
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    await rescheduleBooking(deps(), booking.id, THURSDAY_0900);
    await rescheduleBooking(deps(), booking.id, new Date('2027-01-08T07:00:00Z'));

    expect((await bookingRow(booking.id)).starts_at.toISOString()).toBe('2027-01-08T07:00:00.000Z');
    expect((await outbox()).map((row) => row.dedupe_key).sort()).toEqual(
      [
        `email:reschedule:${booking.id}:${NOW.toISOString()}:${THURSDAY_0900.toISOString()}`,
        `email:reschedule:${booking.id}:${NOW.toISOString()}:2027-01-08T07:00:00.000Z`,
      ].sort(),
    );
  });
});

// --- Two moves racing for one slot --------------------------------------------------------

describe('two reschedules racing for the same free slot', () => {
  it('produces exactly one winner and one slot_taken, never two bookings on the slot', async () => {
    const first = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    const second = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_1400 });

    const results = await Promise.all([
      rescheduleBooking(deps(), first.id, THURSDAY_0900),
      rescheduleBooking(deps(), second.id, THURSDAY_0900),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['ok', 'slot_taken']);
    const onTheSlot = await prisma.booking.count({ where: { startsAt: THURSDAY_0900 } });
    expect(onTheSlot).toBe(1);
  });
});

// --- Cancel by the photographer -----------------------------------------------------------

describe('the photographer cancelling', () => {
  it('sets cancelled_by_admin with the clock’s instant and stores the reason', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    const result = ok(await cancelByAdmin(deps(), booking.id, 'The photographer is unwell.'));

    expect(result.booking.status).toBe('cancelled_by_admin');
    expect(await bookingRow(booking.id)).toMatchObject({
      status: 'cancelled_by_admin',
      cancelled_at: NOW,
      cancellation_reason: 'The photographer is unwell.',
    });
  });

  it('accepts no reason at all', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    ok(await cancelByAdmin(deps(), booking.id, null));

    expect((await bookingRow(booking.id)).cancellation_reason).toBeNull();
  });

  it('returns the slot and its buffer to the public calendar', async () => {
    await openTheDiary();
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    await cancelByAdmin(deps(), booking.id, null);

    const free = await freeStarts(WEDNESDAY_0900);
    expect(free).toContain(WEDNESDAY_0900.toISOString());
    // The buffer too: a 10:00 start would have run into the shoot's 11:00 buffer end.
    expect(free).toContain(new Date('2027-01-06T08:00:00Z').toISOString());
  });

  it('flags every penny collected for refund: the booking fee and a session fee alike (A-5, spec §6.11)', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900, bookingFeeRwf: 18_000 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 18_000, ageSeconds: 300 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 27_000, ageSeconds: 200 });

    await cancelByAdmin(deps(), booking.id, null);

    expect((await payments(booking.id)).map((row) => [row.kind, row.status])).toEqual([
      ['booking_fee', 'refund_due'],
      ['session_fee', 'refund_due'],
    ]);
  });

  it('leaves what was never collected alone', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000, ageSeconds: 300 });
    await insertPayment(prisma, booking.id, { status: 'failed', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 200 });
    await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 100 });

    await cancelByAdmin(deps(), booking.id, null);

    expect((await payments(booking.id)).map((row) => row.status)).toEqual(['refund_due', 'failed', 'pending']);
  });

  it('reports the money owed back without netting it off what was collected', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    const result = ok(await cancelByAdmin(deps(), booking.id, null));
    const full = await adminBooking(result.booking.id);
    const totals = bookingTotals(full, full.addons, full.payments);

    expect(totals).toMatchObject({ collectedRwf: 0, refundDueRwf: 20_000, outstandingRwf: 0 });
  });

  it('emails the client once, saying the photographer cancelled and naming the refund', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900, bookingFeeRwf: 18_000 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 18_000, ageSeconds: 300 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 27_000, ageSeconds: 200 });

    await cancelByAdmin(deps(), booking.id, 'Studio flooded.');

    const cancellation = (await outbox()).find((row) => row.template === 'cancellation');
    expect(cancellation).toMatchObject({ recipient: CLIENT.email, dedupe_key: `email:cancellation:${booking.id}`, booking_id: booking.id });
    expect(cancellation?.payload).toStrictEqual({
      locale: 'en',
      reference: booking.reference,
      clientName: CLIENT.name,
      serviceName: 'Portraits',
      packageName: 'Standard',
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      cancelledBy: 'admin',
      reason: 'Studio flooded.',
      bookingFeeRwf: 18_000,
      refundRwf: 45_000,
    });
  });

  it('alerts the photographer once per flagged payment, naming admin_cancelled as the reason (spec §6.16)', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000, ageSeconds: 300, providerRef: '4100000999' });
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 200 });

    await cancelByAdmin(deps(), booking.id, null);

    const alerts = (await outbox()).filter((row) => row.template === 'admin_alert');
    expect(alerts).toHaveLength(2);
    expect(alerts.every((row) => row.recipient === ADMIN_EMAIL && row.booking_id === null)).toBe(true);
    expect(alerts.map((row) => row.payload.variant)).toEqual(['refund_due', 'refund_due']);
    expect(alerts.map((row) => row.payload.reason)).toEqual(['admin_cancelled', 'admin_cancelled']);
    expect(alerts.map((row) => row.payload.amountRwf).sort((a, b) => Number(a) - Number(b))).toEqual([20_000, 30_000]);
    expect(alerts.map((row) => row.payload.paymentReference)).toContain('4100000999');
  });

  it('queues exactly one cancellation and one alert per refund, and nothing else', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    await cancelByAdmin(deps(), booking.id, null);

    const rows = await outbox();
    expect(rows.map((row) => row.template).sort()).toEqual(['admin_alert', 'cancellation']);
    expect(rows.every((row) => row.kind === 'email')).toBe(true);
    // Unlike a client cancellation, no `booking_cancelled` alert: the
    // photographer is the one who did it (plan.md Task 19).
    expect(rows.some((row) => row.dedupe_key.includes('booking_cancelled'))).toBe(false);
  });

  it('alerts nobody when there is no photographer on file, but still cancels and still emails the client', async () => {
    await truncateAll(raw);
    world = await seedWorld(prisma, { admin: false });
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    ok(await cancelByAdmin(deps(), booking.id, null));

    expect((await bookingRow(booking.id)).status).toBe('cancelled_by_admin');
    expect((await outbox()).map((row) => row.template)).toEqual(['cancellation']);
    expect((await payments(booking.id))[0]?.status).toBe('refund_due');
  });

  it('renders every payload it queues through the real templates', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    await cancelByAdmin(deps(), booking.id, 'Studio flooded.');

    for (const row of await outbox()) {
      const email = renderEmail(row.template as string, row.payload, { webOrigin: 'https://bookly.example' });
      expect(email.subject.length).toBeGreaterThan(5);
      expect([email.subject, email.text, email.html].join('\n')).not.toMatch(/\{\{|undefined|NaN|\[object Object\]/);
    }
  });

  it('answers not_found for a booking that does not exist', async () => {
    expect(await cancelByAdmin(deps(), '3f1b9c2a-0000-4000-8000-00000000abcd', null)).toStrictEqual({ status: 'not_found' });
  });

  it.each(['pending_payment', 'completed', 'no_show', 'expired', 'cancelled_by_client', 'cancelled_by_admin'] as const)(
    'refuses a %s booking and changes nothing',
    async (status) => {
      const booking = await insertBooking(prisma, world, { status, startsAt: WEDNESDAY_0900 });
      await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

      expect(await cancelByAdmin(deps(), booking.id, 'no')).toStrictEqual({ status: 'not_allowed' });
      expect((await bookingRow(booking.id)).status).toBe(status);
      expect((await payments(booking.id))[0]?.status).toBe('succeeded');
      expect(await outbox()).toEqual([]);
    },
  );
});

// --- Completing -----------------------------------------------------------------------------

describe('marking a booking completed', () => {
  it('sets completed and stamps completed_at once the shoot has begun', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    // (2026-09-27: completed means paid) nothing owed, or this would be balance_due.
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 50_000 });

    const result = ok(await markCompleted(deps(AFTER_THE_SHOOT), booking.id));

    expect(result.booking.status).toBe('completed');
    expect(await bookingRow(booking.id)).toMatchObject({ status: 'completed', completed_at: AFTER_THE_SHOOT });
  });

  it('allows it at the very instant the shoot starts', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 50_000 });

    expect(ok(await markCompleted(deps(WEDNESDAY_0900), booking.id)).booking.status).toBe('completed');
  });

  it('refuses before the shoot has started (spec §3.5)', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    const aMinuteEarly = new Date(WEDNESDAY_0900.getTime() - MINUTE_MS);

    expect(await markCompleted(deps(aMinuteEarly), booking.id)).toStrictEqual({ status: 'not_allowed' });
    expect(await bookingRow(booking.id)).toMatchObject({ status: 'confirmed', completed_at: null });
  });

  it('emails the client nothing: the money conversation is Task 20’s', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    await markCompleted(deps(AFTER_THE_SHOOT), booking.id);

    expect(await outbox()).toEqual([]);
  });

  it('refuses balance_due while the session fee is unpaid, and completes once it is settled (2026-09-27: completed means paid)', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    expect(await markCompleted(deps(AFTER_THE_SHOOT), booking.id)).toStrictEqual({ status: 'balance_due' });
    expect((await bookingRow(booking.id)).status).toBe('confirmed');

    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000 });
    const result = ok(await markCompleted(deps(AFTER_THE_SHOOT), booking.id));
    const full = await adminBooking(result.booking.id);

    expect(result.booking.status).toBe('completed');
    expect(bookingTotals(full, full.addons, full.payments)).toMatchObject({ grandTotalRwf: 50_000, outstandingRwf: 0 });
  });

  it('reads the balance under the booking lock: an add-on committed while it waits is owed, not skipped', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 50_000 });

    // Another writer holds the lock, as an add-on edit does, and adds 15,000.
    await raw.query('BEGIN');
    let completing: ReturnType<typeof markCompleted>;
    try {
      await raw.query('SELECT 1 FROM booking WHERE id = $1 FOR UPDATE', [booking.id]);
      completing = markCompleted(deps(AFTER_THE_SHOOT), booking.id);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await raw.query(
        `INSERT INTO booking_addon (booking_id, addon_id, name_snapshot, unit_price_rwf, quantity, amount_rwf, stage)
         VALUES ($1, $2, 'Extra hour', 15000, 1, 15000, 'post_shoot')`,
        [booking.id, world.ownAddonId],
      );
      await raw.query('COMMIT');
    } catch (error) {
      await raw.query('ROLLBACK');
      throw error;
    }

    expect(await completing).toStrictEqual({ status: 'balance_due' });
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
  });

  it.each(['pending_payment', 'completed', 'no_show', 'expired', 'cancelled_by_client', 'cancelled_by_admin'] as const)(
    'refuses a %s booking',
    async (status) => {
      const booking = await insertBooking(prisma, world, { status, startsAt: WEDNESDAY_0900 });

      expect(await markCompleted(deps(AFTER_THE_SHOOT), booking.id)).toStrictEqual({ status: 'not_allowed' });
    },
  );

  it('answers not_found for a booking that does not exist', async () => {
    expect(await markCompleted(deps(AFTER_THE_SHOOT), '3f1b9c2a-0000-4000-8000-00000000abcd')).toStrictEqual({ status: 'not_found' });
  });
});

// --- No-show --------------------------------------------------------------------------------

describe('marking a no-show (spec §6.12, A-6)', () => {
  it('sets no_show and stamps no completion', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    const result = ok(await markNoShow(deps(AFTER_THE_SHOOT), booking.id));

    expect(result.booking.status).toBe('no_show');
    expect(await bookingRow(booking.id)).toMatchObject({ status: 'no_show', completed_at: null, cancelled_at: null });
  });

  it('keeps the slot: the time was consumed, so it never returns to availability', async () => {
    await openTheDiary();
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    await markNoShow(deps(AFTER_THE_SHOOT), booking.id);

    // Availability is asked as a visitor would ask it, from before the shoot:
    // the action's clock and the query's are separate by design.
    expect(await freeStarts(WEDNESDAY_0900)).not.toContain(WEDNESDAY_0900.toISOString());
    expect(await slotIsFree(WEDNESDAY_0900)).toBe(false);
  });

  it('keeps the booking fee succeeded and forfeited', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900, bookingFeeRwf: 18_000 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 18_000 });

    await markNoShow(deps(AFTER_THE_SHOOT), booking.id);

    expect((await payments(booking.id)).map((row) => [row.kind, row.status])).toEqual([['booking_fee', 'succeeded']]);
  });

  it('owes no session fee, whatever the package cost', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    const result = ok(await markNoShow(deps(AFTER_THE_SHOOT), booking.id));
    const full = await adminBooking(result.booking.id);

    expect(bookingTotals(full, full.addons, full.payments)).toMatchObject({
      grandTotalRwf: 50_000,
      collectedRwf: 20_000,
      outstandingRwf: 0,
      refundDueRwf: 0,
    });
  });

  it('sends the client nothing at all', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });

    await markNoShow(deps(AFTER_THE_SHOOT), booking.id);

    expect(await outbox()).toEqual([]);
  });

  it('refuses before the shoot has started', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    expect(await markNoShow(deps(), booking.id)).toStrictEqual({ status: 'not_allowed' });
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
  });

  it.each(['pending_payment', 'completed', 'no_show', 'expired', 'cancelled_by_client', 'cancelled_by_admin'] as const)(
    'refuses a %s booking',
    async (status) => {
      const booking = await insertBooking(prisma, world, { status, startsAt: WEDNESDAY_0900 });

      expect(await markNoShow(deps(AFTER_THE_SHOOT), booking.id)).toStrictEqual({ status: 'not_allowed' });
    },
  );
});

// --- Resending the access link ----------------------------------------------------------------

describe('resending the access link (spec §6.21, P-29)', () => {
  it('issues a new token, stamps a fresh expiry and forgets the last use', async () => {
    const { booking } = await insertBookingWithToken(prisma, world, { startsAt: WEDNESDAY_0900 });
    await prisma.booking.update({ where: { id: booking.id }, data: { accessTokenLastUsedAt: NOW } });
    const before = await bookingRow(booking.id);

    ok(await resendAccessLink(deps(), booking.id));

    const after = await bookingRow(booking.id);
    expect(after.access_token_hash).not.toBe(before.access_token_hash);
    expect(after.access_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(after.access_token_last_used_at).toBeNull();
    // 365 days from the injected clock (ACCESS_TOKEN_LIFETIME_DAYS).
    expect(after.access_token_expires_at?.toISOString()).toBe(new Date(NOW.getTime() + 365 * DAY_MS).toISOString());
  });

  it('kills the old link the moment it commits, and the new one opens the booking', async () => {
    const { booking, token: old } = await insertBookingWithToken(prisma, world, { startsAt: WEDNESDAY_0900 });
    expect((await findBookingByToken(prisma, old))?.id).toBe(booking.id);

    ok(await resendAccessLink(deps(), booking.id));

    expect(await findBookingByToken(prisma, old)).toBeNull();
    const fresh = (await onlyMessage()).payload.accessToken as string;
    expect((await findBookingByToken(prisma, fresh))?.id).toBe(booking.id);
  });

  it('queues access_link_resend carrying the plaintext, which matches the stored hash', async () => {
    const { booking } = await insertBookingWithToken(prisma, world, { startsAt: WEDNESDAY_0900 });

    await resendAccessLink(deps(), booking.id);

    const row = await onlyMessage();
    const token = row.payload.accessToken as string;
    expect(row).toMatchObject({
      kind: 'email',
      template: 'access_link_resend',
      recipient: CLIENT.email,
      booking_id: booking.id,
      // Keyed by the token it carries, so no resend can lose its email.
      dedupe_key: `email:access_link_resend:${booking.id}:${hashAccessToken(token).slice(0, 16)}`,
    });
    expect(hashAccessToken(token)).toBe((await bookingRow(booking.id)).access_token_hash);
    const email = renderEmail('access_link_resend', row.payload, { webOrigin: 'https://bookly.example' });
    expect(email.html).toContain(token);
  });

  it('keeps each resend in the history as its own message', async () => {
    const { booking } = await insertBookingWithToken(prisma, world, { startsAt: WEDNESDAY_0900 });
    const later = new Date(NOW.getTime() + DAY_MS);

    await resendAccessLink(deps(), booking.id);
    await resendAccessLink(deps(later), booking.id);

    const tokens = (await outbox()).map((row) => row.payload.accessToken as string);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    // Only the newest link works.
    expect(await findBookingByToken(prisma, String(tokens[0]))).toBeNull();
    expect((await findBookingByToken(prisma, String(tokens[1])))?.id).toBe(booking.id);
  });

  it('refuses a booking that was never confirmed, which has no link to resend', async () => {
    const booking = await insertBooking(prisma, world, { status: 'pending_payment', startsAt: WEDNESDAY_0900 });

    expect(await resendAccessLink(deps(), booking.id)).toStrictEqual({ status: 'not_allowed' });
    expect(await outbox()).toEqual([]);
  });

  it('answers not_found for a booking that does not exist', async () => {
    expect(await resendAccessLink(deps(), '3f1b9c2a-0000-4000-8000-00000000abcd')).toStrictEqual({ status: 'not_found' });
  });

  it.each(['completed', 'no_show', 'cancelled_by_client', 'cancelled_by_admin'] as const)(
    'still resends on a %s booking, exactly as canResendLink advertises',
    async (status) => {
      const booking = await insertBooking(prisma, world, { status, startsAt: WEDNESDAY_0900 });
      await grantAccessToken(prisma, booking.id);
      // insertBooking stamps confirmed_at for `confirmed` only; a booking that
      // reached these states was confirmed once, so say so.
      await prisma.booking.update({ where: { id: booking.id }, data: { confirmedAt: NOW } });
      const view = adminBookingView(await adminBooking(booking.id), AFTER_THE_SHOOT);

      const result = await resendAccessLink(deps(), booking.id);

      expect(view.actions.canResendLink).toBe(true);
      expect(result.status).toBe('ok');
      expect((await outbox()).map((row) => row.template)).toEqual(['access_link_resend']);
    },
  );

  it('advertises no resend for a booking that was never confirmed, and refuses it too', async () => {
    const booking = await insertBooking(prisma, world, { status: 'expired', startsAt: WEDNESDAY_0900 });
    const view = adminBookingView(await adminBooking(booking.id), AFTER_THE_SHOOT);

    expect(view.actions.canResendLink).toBe(false);
    expect(await resendAccessLink(deps(), booking.id)).toStrictEqual({ status: 'not_allowed' });
  });
});

// --- What the view advertises matches what the actions do ---------------------------------------

describe('the actions flags and the actions themselves agree', () => {
  it.each([
    ['confirmed', true],
    ['pending_payment', false],
    ['completed', false],
    ['no_show', false],
    ['expired', false],
    ['cancelled_by_client', false],
    ['cancelled_by_admin', false],
  ] as const)('canReschedule and canCancel are %s = %s, and the actions follow', async (status, allowed) => {
    const booking = await insertBooking(prisma, world, { status, startsAt: WEDNESDAY_0900 });
    const view = adminBookingView(await adminBooking(booking.id), NOW);

    expect([view.actions.canReschedule, view.actions.canCancel]).toEqual([allowed, allowed]);
    expect((await rescheduleBooking(deps(), booking.id, THURSDAY_0900)).status).toBe(allowed ? 'ok' : 'not_allowed');
  });

  it('withholds complete and no-show until the shoot has started, as the actions do', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });
    // Paid in full, so time is the only gate this test is proving.
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 50_000 });
    const full = await adminBooking(booking.id);

    const before = adminBookingView(full, NOW);
    const after = adminBookingView(full, AFTER_THE_SHOOT);

    expect([before.actions.canComplete, before.actions.canMarkNoShow]).toEqual([false, false]);
    expect([after.actions.canComplete, after.actions.canMarkNoShow]).toEqual([true, true]);
    expect(await markCompleted(deps(), booking.id)).toStrictEqual({ status: 'not_allowed' });
    expect(ok(await markCompleted(deps(AFTER_THE_SHOOT), booking.id)).booking.status).toBe('completed');
  });

  it('withholds canComplete while money is owed, and grants it once paid (2026-09-27: completed means paid)', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: WEDNESDAY_0900 });

    const unpaid = adminBookingView(await adminBooking(booking.id), AFTER_THE_SHOOT);
    expect(unpaid.actions.canComplete).toBe(false);
    expect(await markCompleted(deps(AFTER_THE_SHOOT), booking.id)).toStrictEqual({ status: 'balance_due' });

    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 50_000 });
    const paid = adminBookingView(await adminBooking(booking.id), AFTER_THE_SHOOT);
    expect(paid.actions.canComplete).toBe(true);
    expect(ok(await markCompleted(deps(AFTER_THE_SHOOT), booking.id)).booking.status).toBe('completed');
  });
});
