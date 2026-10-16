import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findAvailability } from '../availability/query.js';
import { createPrismaClient } from '../db/client.js';
import { renderEmail } from '../email/render.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  ADMIN_EMAIL,
  CLIENT,
  type PaymentWorld,
  grantAccessToken,
  insertBooking,
  insertBookingWithToken,
  insertPayment,
  seedWorld,
} from '../test/payment-fixtures.js';
import { cancelByClient } from './cancel.js';

/**
 * A client cancelling their own booking (plan.md Task 18; spec §3.6, §6.10,
 * §6.16), against real PostgreSQL.
 *
 * What is proven: confirming moves the booking to `cancelled_by_client` with
 * `cancelled_at` set, and the slot AND its buffer come straight back to the
 * public calendar -- checked through the same availability query the booking
 * page uses. The booking fee is **not** refunded: it stays `succeeded`,
 * forfeited. A session fee already collected is different money -- it becomes
 * `refund_due`, the photographer gets a `refund_due` alert naming
 * `session_fee_after_client_cancel`, and the cancellation email promises the
 * client exactly that sum and no more. Both emails are enqueued once, with
 * payloads that render. Cancelling twice changes nothing and enqueues nothing
 * more; a shoot that has started, a completed, no-show, expired or already
 * cancelled booking, and an unknown token, are all `not_cancellable` and touch
 * nothing. With no photographer on file the booking still cancels and no admin
 * mail is queued. And when an enqueue fails, the status, the refund and the
 * other message roll back with it.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;

/** The injected app clock: long before every fixture shoot (January 2027). */
const NOW = new Date('2026-10-01T06:00:00Z');

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

type BookingRow = { status: string; cancelled_at: Date | null; cancellation_reason: string | null };

async function bookingRow(id: string): Promise<BookingRow> {
  const result = await raw.query<BookingRow>('SELECT status, cancelled_at, cancellation_reason FROM booking WHERE id = $1', [id]);
  if (result.rows[0] === undefined) throw new Error('No such booking');
  return result.rows[0];
}

async function paymentStatuses(bookingId: string): Promise<{ kind: string; status: string; amount_rwf: number }[]> {
  const result = await raw.query<{ kind: string; status: string; amount_rwf: number }>(
    'SELECT kind, status, amount_rwf FROM payment WHERE booking_id = $1 ORDER BY initiated_at, amount_rwf',
    [bookingId],
  );
  return result.rows;
}

/** Mon-Fri 09:00-17:00, so the fixture days generate slots at all. */
async function openTheDiary(): Promise<void> {
  await prisma.workingHours.createMany({
    data: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinute: 540, closesMinute: 1020 })),
  });
}

/** Every free start on the Kigali date of `instant`, as a visitor would see it. */
async function freeStarts(instant: Date): Promise<string[]> {
  const date = new Date(instant.getTime() + 2 * 60 * 60_000).toISOString().slice(0, 10);
  const days = await findAvailability(prisma, {
    from: date,
    to: date,
    packageDurationMinutes: 90,
    now: NOW,
  });
  return days[0]?.starts ?? [];
}

// --- Cancelling ------------------------------------------------------------------------------

describe('a confirmed booking the client cancels', () => {
  it('becomes cancelled_by_client, stamped with the injected clock, and answers the booking as it now stands', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded' });

    const result = await cancelByClient(deps(), token);

    expect(result.status).toBe('cancelled');
    if (result.status !== 'cancelled') throw new Error('unreachable');
    expect(result.booking).toMatchObject({ id: booking.id, status: 'cancelled_by_client', cancelledAt: NOW });
    expect(await bookingRow(booking.id)).toMatchObject({ status: 'cancelled_by_client', cancelled_at: NOW });
  });

  it('writes no cancellation reason: the client gives none (spec §6.10)', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);

    await cancelByClient(deps(), token);

    expect((await bookingRow(booking.id)).cancellation_reason).toBeNull();
  });

  it('returns the slot and its buffer to the public calendar at once', async () => {
    await openTheDiary();
    const startsAt = new Date('2027-01-06T07:00:00Z'); // 09:00 Kigali, a Wednesday.
    const { booking, token } = await insertBookingWithToken(prisma, world, { startsAt });
    const iso = startsAt.toISOString();

    const before = await freeStarts(startsAt);
    expect(before).not.toContain(iso);
    // And the buffer with it: a 10:00 start would run into the shoot's 11:00 buffer end.
    expect(before).not.toContain(new Date('2027-01-06T08:00:00Z').toISOString());

    await cancelByClient(deps(), token);

    const after = await freeStarts(startsAt);
    expect(after).toContain(iso);
    expect(after).toContain(new Date('2027-01-06T08:00:00Z').toISOString());
    expect(await bookingRow(booking.id)).toMatchObject({ status: 'cancelled_by_client' });
  });

  it('leaves the booking fee succeeded and forfeited: the system refunds nothing here', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world, { bookingFeeRwf: 22_000 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 22_000 });

    await cancelByClient(deps(), token);

    expect(await paymentStatuses(booking.id)).toStrictEqual([{ kind: 'booking_fee', status: 'succeeded', amount_rwf: 22_000 }]);
  });

  it('leaves an unsettled attempt alone: only money actually collected can be owed back', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded', ageSeconds: 300 });
    await insertPayment(prisma, booking.id, { status: 'failed', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 200 });
    await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 100 });

    await cancelByClient(deps(), token);

    expect((await paymentStatuses(booking.id)).map((row) => row.status)).toEqual(['succeeded', 'failed', 'pending']);
  });
});

// --- The emails -------------------------------------------------------------------------------

describe('the emails a cancellation enqueues', () => {
  it('queues the client’s cancellation and the photographer’s alert, once each, with the plan’s dedupe keys', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);

    await cancelByClient(deps(), token);

    const rows = await outbox();
    expect(rows.map((row) => row.dedupe_key).sort()).toEqual(
      [`email:admin_alert:booking_cancelled:${booking.id}`, `email:cancellation:${booking.id}`].sort(),
    );
    expect(rows.map((row) => [row.template, row.recipient]).sort()).toEqual(
      [
        ['admin_alert', ADMIN_EMAIL],
        ['cancellation', CLIENT.email],
      ].sort(),
    );
    expect(rows.every((row) => row.kind === 'email')).toBe(true);
  });

  it('addresses the client at the booking’s snapshot, not the live client row', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await prisma.booking.update({ where: { id: booking.id }, data: { contactEmail: 'moved@example.com' } });
    await prisma.client.update({ where: { id: world.clientId }, data: { email: 'live-row@example.com' } });

    await cancelByClient(deps(), token);

    const cancellation = (await outbox()).find((row) => row.template === 'cancellation');
    expect(cancellation?.recipient).toBe('moved@example.com');
  });

  it('says the client cancelled, names the fee, promises no refund, and carries no reason', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world, { bookingFeeRwf: 18_000 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 18_000 });

    await cancelByClient(deps(), token);

    const cancellation = (await outbox()).find((row) => row.template === 'cancellation');
    expect(cancellation?.booking_id).toBe(booking.id);
    expect(cancellation?.payload).toStrictEqual({
      locale: 'en',
      reference: booking.reference,
      clientName: CLIENT.name,
      serviceName: 'Portraits',
      packageName: 'Standard',
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      cancelledBy: 'client',
      reason: null,
      bookingFeeRwf: 18_000,
      refundRwf: 0,
    });
  });

  it('tells the photographer which booking went, with no booking id attached to the alert', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world, { bookingFeeRwf: 18_000 });

    await cancelByClient(deps(), token);

    const alert = (await outbox()).find((row) => row.dedupe_key.includes('booking_cancelled'));
    expect(alert?.booking_id).toBeNull();
    expect(alert?.payload).toStrictEqual({
      variant: 'booking_cancelled',
      reference: booking.reference,
      clientName: CLIENT.name,
      serviceName: 'Portraits',
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      bookingFeeRwf: 18_000,
    });
  });

  it('renders both payloads through the real templates', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000 });

    await cancelByClient(deps(), token);

    for (const row of await outbox()) {
      const email = renderEmail(row.template as string, row.payload, { webOrigin: 'https://bookly.example' });
      expect(email.subject.length).toBeGreaterThan(5);
      expect(email.text).toContain(booking.reference);
      expect([email.subject, email.text, email.html].join('\n')).not.toMatch(/\{\{|undefined|NaN|\[object Object\]/);
    }
  });

  it('carries no access token into either payload', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);

    await cancelByClient(deps(), token);

    const serialised = JSON.stringify(await outbox());
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain('accessToken');
    expect(serialised).not.toContain(CLIENT.phone);
    expect(booking.reference.length).toBeGreaterThan(0);
  });
});

// --- A session fee already paid ----------------------------------------------------------------

describe('cancelling after paying a session fee (spec §6.10, §6.16)', () => {
  it('marks it refund_due, alerts the photographer with the right reason, and promises the client exactly that sum', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world, { bookingFeeRwf: 18_000 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 18_000, ageSeconds: 300 });
    const sessionFee = await insertPayment(prisma, booking.id, {
      status: 'succeeded',
      kind: 'session_fee',
      amountRwf: 27_000,
      ageSeconds: 100,
      providerRef: '4100000123',
    });

    await cancelByClient(deps(), token);

    expect(await paymentStatuses(booking.id)).toStrictEqual([
      { kind: 'booking_fee', status: 'succeeded', amount_rwf: 18_000 },
      { kind: 'session_fee', status: 'refund_due', amount_rwf: 27_000 },
    ]);

    const rows = await outbox();
    const refund = rows.find((row) => row.dedupe_key === `email:admin_alert:refund_due:${sessionFee.id}`);
    expect(refund?.recipient).toBe(ADMIN_EMAIL);
    expect(refund?.payload).toStrictEqual({
      variant: 'refund_due',
      reference: booking.reference,
      clientName: CLIENT.name,
      amountRwf: 27_000,
      reason: 'session_fee_after_client_cancel',
      paymentReference: '4100000123',
      provider: 'mtn_momo_direct',
      startsAt: booking.startsAt.toISOString(),
    });

    const cancellation = rows.find((row) => row.template === 'cancellation');
    expect(cancellation?.payload).toMatchObject({ refundRwf: 27_000, bookingFeeRwf: 18_000 });
  });

  it('owes back every succeeded session fee, one alert each, and sums them for the client', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded', ageSeconds: 400 });
    const first = await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 20_000, ageSeconds: 300 });
    const second = await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 7_000, ageSeconds: 200 });

    await cancelByClient(deps(), token);

    const rows = await outbox();
    expect(rows.filter((row) => row.dedupe_key.includes('refund_due')).map((row) => row.dedupe_key).sort()).toEqual(
      [`email:admin_alert:refund_due:${first.id}`, `email:admin_alert:refund_due:${second.id}`].sort(),
    );
    expect(rows.find((row) => row.template === 'cancellation')?.payload).toMatchObject({ refundRwf: 27_000 });
    expect((await paymentStatuses(booking.id)).map((row) => row.status)).toEqual(['succeeded', 'refund_due', 'refund_due']);
  });

  it('falls back to our own reference when the provider gave none', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    const sessionFee = await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 27_000 });

    await cancelByClient(deps(), token);

    const refund = (await outbox()).find((row) => row.dedupe_key.includes('refund_due'));
    expect(refund?.payload).toMatchObject({ paymentReference: sessionFee.ourRef });
  });

  it('never marks a session fee that was only pending, and then owes nothing back', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 27_000 });

    await cancelByClient(deps(), token);

    expect((await paymentStatuses(booking.id)).map((row) => row.status)).toEqual(['pending']);
    expect((await outbox()).some((row) => row.dedupe_key.includes('refund_due'))).toBe(false);
    expect((await outbox()).find((row) => row.template === 'cancellation')?.payload).toMatchObject({ refundRwf: 0 });
  });

  it('renders the refund alert through the real template, naming the reason in words', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 27_000 });

    await cancelByClient(deps(), token);

    const refund = (await outbox()).find((row) => row.dedupe_key.includes('refund_due'));
    const email = renderEmail('admin_alert', refund?.payload, { webOrigin: 'https://bookly.example' });
    expect(email.subject).toContain('Refund due: 27,000 RWF');
    expect(email.text).toContain('cancelled after paying the session fee');
    expect(email.text).toContain(booking.reference);
  });
});

// --- Cancelling twice -------------------------------------------------------------------------

describe('cancelling twice', () => {
  it('changes nothing the second time and enqueues nothing more', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 27_000 });

    const first = await cancelByClient(deps(), token);
    const before = { row: await bookingRow(booking.id), payments: await paymentStatuses(booking.id), mail: await outbox() };
    const second = await cancelByClient(deps(new Date('2026-10-02T06:00:00Z')), token);

    expect(first.status).toBe('cancelled');
    expect(second).toStrictEqual({ status: 'not_cancellable' });
    expect(await bookingRow(booking.id)).toStrictEqual(before.row);
    expect(await paymentStatuses(booking.id)).toStrictEqual(before.payments);
    expect(await outbox()).toStrictEqual(before.mail);
  });

  it('makes one cancellation of five simultaneous confirmations', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 27_000 });

    const results = await Promise.all(Array.from({ length: 5 }, () => cancelByClient(deps(), token)));

    expect(results.filter((result) => result.status === 'cancelled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'not_cancellable')).toHaveLength(4);
    expect(await outbox()).toHaveLength(3);
    expect((await paymentStatuses(booking.id)).map((row) => row.status)).toEqual(['refund_due']);
  });
});

// --- What cannot be cancelled -------------------------------------------------------------------

describe('a booking the client cannot cancel', () => {
  async function expectNothingHappened(bookingId: string, status: string): Promise<void> {
    expect(await bookingRow(bookingId)).toMatchObject({ status });
    expect(await outbox()).toEqual([]);
  }

  it('is not_cancellable once the shoot has started', async () => {
    const startsAt = new Date('2026-09-30T07:00:00Z');
    const { booking, token } = await insertBookingWithToken(prisma, world, { startsAt });

    await expect(cancelByClient(deps(), token)).resolves.toStrictEqual({ status: 'not_cancellable' });
    await expectNothingHappened(booking.id, 'confirmed');
  });

  it('is cancellable up to the second before the shoot, and not after', async () => {
    const startsAt = new Date('2027-02-03T07:00:00Z');
    const { booking, token } = await insertBookingWithToken(prisma, world, { startsAt });

    await expect(cancelByClient(deps(startsAt), token)).resolves.toStrictEqual({ status: 'not_cancellable' });
    await expectNothingHappened(booking.id, 'confirmed');

    const justBefore = new Date(startsAt.getTime() - 1);
    await expect(cancelByClient(deps(justBefore), token)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it.each(['pending_payment', 'completed', 'no_show', 'expired', 'cancelled_by_admin', 'cancelled_by_client'])(
    'is not_cancellable when it is %s',
    async (status) => {
      const { booking, token } = await insertBookingWithToken(prisma, world, { status });

      await expect(cancelByClient(deps(), token)).resolves.toStrictEqual({ status: 'not_cancellable' });
      await expectNothingHappened(booking.id, status);
    },
  );

  it.each([
    ['an unknown token', 'unknown'],
    ['an expired token', 'expired'],
    ['a superseded token', 'superseded'],
    ['a malformed token', 'malformed'],
  ])('is not_cancellable for %s, and nothing is touched', async (_case, kind) => {
    const live = await insertBookingWithToken(prisma, world);
    const expired = await insertBookingWithToken(prisma, world, { expiresInMinutes: -1 });
    const superseded = await insertBookingWithToken(prisma, world);
    const oldToken = superseded.token;
    await grantAccessToken(prisma, superseded.booking.id);

    const token = {
      unknown: 'Zx9Q2mT7vL4pR8sK1nB6yH3cF5dG0wJe',
      expired: expired.token,
      superseded: oldToken,
      malformed: "not a token' OR 1=1",
    }[kind] as string;

    await expect(cancelByClient(deps(), token)).resolves.toStrictEqual({ status: 'not_cancellable' });
    for (const id of [live.booking.id, expired.booking.id, superseded.booking.id]) {
      expect(await bookingRow(id)).toMatchObject({ status: 'confirmed', cancelled_at: null });
    }
    expect(await outbox()).toEqual([]);
  });
});

// --- No photographer on file -----------------------------------------------------------------

describe('with no admin account', () => {
  beforeEach(async () => {
    await truncateAll(raw);
    world = await seedWorld(prisma, { admin: false });
  });

  it('still cancels, still emails the client, and queues no admin mail', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 27_000 });

    await expect(cancelByClient(deps(), token)).resolves.toMatchObject({ status: 'cancelled' });

    expect(await bookingRow(booking.id)).toMatchObject({ status: 'cancelled_by_client' });
    const rows = await outbox();
    expect(rows.map((row) => row.template)).toEqual(['cancellation']);
    // The refund is still owed, even with nobody queued to be told.
    expect((await paymentStatuses(booking.id)).map((row) => row.status)).toEqual(['refund_due']);
  });

  it('sends the alert to the oldest admin when there are several', async () => {
    await prisma.adminUser.create({ data: { email: 'first@bookly.example', passwordHash: 'x', createdAt: new Date('2020-01-01T00:00:00Z') } });
    await prisma.adminUser.create({ data: { email: 'second@bookly.example', passwordHash: 'x', createdAt: new Date('2021-01-01T00:00:00Z') } });
    const { token } = await insertBookingWithToken(prisma, world);

    await cancelByClient(deps(), token);

    expect((await outbox()).find((row) => row.template === 'admin_alert')?.recipient).toBe('first@bookly.example');
  });
});

// --- All or nothing ----------------------------------------------------------------------------

describe('everything commits together', () => {
  /** Makes the outbox refuse writes, so the enqueue inside the transaction fails. */
  async function breakTheOutbox(): Promise<void> {
    await raw.query(`
      CREATE OR REPLACE FUNCTION test_refuse_outbox() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'outbox is refusing writes in this test'; END;
      $$ LANGUAGE plpgsql`);
    await raw.query('CREATE TRIGGER test_refuse_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION test_refuse_outbox()');
  }

  async function mendTheOutbox(): Promise<void> {
    await raw.query('DROP TRIGGER IF EXISTS test_refuse_outbox ON outbox');
    await raw.query('DROP FUNCTION IF EXISTS test_refuse_outbox()');
  }

  it('rolls the status and the refund back when an enqueue fails', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, booking.id, { status: 'succeeded', ageSeconds: 200 });
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 27_000, ageSeconds: 100 });

    await breakTheOutbox();
    try {
      await expect(cancelByClient(deps(), token)).rejects.toThrow(/refusing writes/);

      expect(await bookingRow(booking.id)).toMatchObject({ status: 'confirmed', cancelled_at: null });
      expect((await paymentStatuses(booking.id)).map((row) => row.status)).toEqual(['succeeded', 'succeeded']);
      expect(await outbox()).toEqual([]);
    } finally {
      await mendTheOutbox();
    }

    // And with the outbox mended, the same token still cancels.
    await expect(cancelByClient(deps(), token)).resolves.toMatchObject({ status: 'cancelled' });
    expect((await paymentStatuses(booking.id)).map((row) => row.status)).toEqual(['succeeded', 'refund_due']);
  });
});

// --- The booking it cancels ---------------------------------------------------------------------

describe('scope comes from the token alone', () => {
  it('cancels only the booking the token addresses, never a neighbour', async () => {
    const mine = await insertBookingWithToken(prisma, world);
    const theirs = await insertBookingWithToken(prisma, world);
    await insertPayment(prisma, theirs.booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 27_000 });

    await cancelByClient(deps(), mine.token);

    expect(await bookingRow(mine.booking.id)).toMatchObject({ status: 'cancelled_by_client' });
    expect(await bookingRow(theirs.booking.id)).toMatchObject({ status: 'confirmed', cancelled_at: null });
    expect((await paymentStatuses(theirs.booking.id)).map((row) => row.status)).toEqual(['succeeded']);
    expect((await outbox()).every((row) => row.booking_id === null || row.booking_id === mine.booking.id)).toBe(true);
  });

  it('leaves a booking with no token alone', async () => {
    const orphan = await insertBooking(prisma, world, { status: 'confirmed' });
    const { token } = await insertBookingWithToken(prisma, world);

    await cancelByClient(deps(), token);

    expect(await bookingRow(orphan.id)).toMatchObject({ status: 'confirmed' });
  });
});
