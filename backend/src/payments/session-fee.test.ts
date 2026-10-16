import type { Booking, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findBookingByToken } from '../booking/access.js';
import { hashAccessToken } from '../booking/access-token.js';
import { adminBookingView, findAdminBooking } from '../booking/admin-view.js';
import { addPostShootAddon, removePostShootAddon } from '../booking/addons.js';
import { createPrismaClient } from '../db/client.js';
import { renderEmail } from '../email/render.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  CLIENT,
  type PaymentWorld,
  UUID,
  insertBooking,
  insertBookingWithToken,
  insertPayment,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';
import { PAYMENT_ATTEMPT_WINDOW_SECONDS, startSessionFeePayment } from './initiate.js';
import { requestSessionFee } from './session-fee.js';

/**
 * "Request session fee" (plan.md Task 20; spec §3.5 step 3, §6.15;
 * data-model_v2.md §5.11, §6.1, §6.2), against real PostgreSQL.
 *
 * What is proven. The request **is** the payment row: `initiated`, against the
 * configured provider, with an `our_ref` the database generated, for exactly
 * `bookingTotals().outstandingRwf` at that instant -- and nothing is charged,
 * because no provider is called here. That figure is then **frozen**: add-ons
 * added afterwards raise what is outstanding and leave the row alone, so the
 * amount in the client's inbox is the amount they are asked for.
 *
 * Asking again for the same amount is a reminder: the same row, a second email,
 * its own dedupe key. Asking after the amount has moved is a second request: a
 * new row, the first left exactly where it was. That is spec §6.15 -- a settled
 * payment is never edited -- and the booking-fee partial unique index, which is
 * booking-fee only, does not stand in the way of two succeeded session fees.
 *
 * The email carries a **new** access token. The plaintext of the old one was
 * never stored (data-model_v2.md §5.9), and a request for money whose link does
 * not work is a request that does not get paid -- so the previous link stops
 * resolving the moment this commits, exactly as a resend's does (spec §6.21).
 *
 * It refuses: `nothing_to_pay` where nothing is owed, `not_allowed` on a
 * booking that no longer stands and therefore owes nothing (§6.1), `in_progress`
 * while a prompt may still be on the payer's phone, and `not_found`.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;

/** The injected app clock: long before every fixture shoot (January 2027). */
const NOW = new Date('2026-10-01T06:00:00Z');
const DAY_MS = 24 * 60 * 60_000;
const ACCESS_TOKEN_LIFETIME_DAYS = 365;
const PROVIDER = 'mtn_momo_direct';
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ff';

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

function deps(now: Date = NOW, providerId: 'mtn_momo_direct' | 'flutterwave' = PROVIDER) {
  return { prisma, providerId, now: () => now };
}

type PaymentRow = {
  id: string;
  booking_id: string;
  kind: string;
  provider: string;
  our_ref: string;
  provider_ref: string | null;
  method: string | null;
  amount_rwf: number;
  status: string;
  settled_at: Date | null;
};

/** Every payment, through the raw driver: another connection than the code used. */
async function payments(): Promise<PaymentRow[]> {
  const result = await raw.query<PaymentRow>(
    `SELECT id::text, booking_id::text, kind, provider, our_ref::text, provider_ref, method, amount_rwf, status, settled_at
       FROM payment ORDER BY initiated_at, id`,
  );
  return result.rows;
}

async function sessionFees(): Promise<PaymentRow[]> {
  return (await payments()).filter((row) => row.kind === 'session_fee');
}

type OutboxRow = {
  kind: string;
  template: string | null;
  recipient: string | null;
  booking_id: string | null;
  dedupe_key: string;
  payload: Record<string, unknown>;
};

async function outbox(): Promise<OutboxRow[]> {
  const result = await raw.query<OutboxRow>(
    `SELECT kind, template, recipient, booking_id::text AS booking_id, dedupe_key, payload
       FROM outbox ORDER BY created_at, dedupe_key`,
  );
  return result.rows;
}

type TokenRow = { access_token_hash: string | null; access_token_expires_at: Date | null; access_token_last_used_at: Date | null };

async function tokenRow(bookingId: string): Promise<TokenRow> {
  const result = await raw.query<TokenRow>(
    'SELECT access_token_hash, access_token_expires_at, access_token_last_used_at FROM booking WHERE id = $1',
    [bookingId],
  );
  return firstRow(result);
}

async function totalsOf(bookingId: string) {
  const booking = await findAdminBooking(prisma, bookingId);
  if (booking === null) throw new Error('No such booking');
  return adminBookingView(booking, NOW).money.totals;
}

/** A catalogue add-on of this service, at whatever price the test needs. */
async function catalogueAddon(priceRwf: number, name = 'Extra prints') {
  return prisma.addon.create({ data: { serviceId: world.serviceId, nameEn: name, priceRwf } });
}

/**
 * Adds a post-shoot add-on through the real editor, which is what moves the
 * money. Since 2026-09-27 the editor is open only while the booking is
 * `confirmed` and its shoot has begun, so the add-on goes on in that state, a
 * minute into the shoot, and the booking is put back in whatever status the
 * test set -- a `completed` booking carrying an add-on is the legacy data
 * these tests are about, and it still exists.
 */
async function addAddon(bookingId: string, priceRwf: number): Promise<void> {
  const addon = await catalogueAddon(priceRwf, `Prints ${priceRwf}`);
  const before = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true, startsAt: true } });
  await prisma.booking.update({ where: { id: bookingId }, data: { status: 'confirmed' } });
  const now = () => new Date(before.startsAt.getTime() + 60_000);
  const result = await addPostShootAddon({ prisma, now }, bookingId, { addonId: addon.id, quantity: 1 });
  await prisma.booking.update({ where: { id: bookingId }, data: { status: before.status } });
  if (result.status !== 'ok') throw new Error(`The add-on would not go on: ${result.status}`);
}

/**
 * A completed shoot with a live client link: 40,000 package + a 10,000
 * at-booking add-on, 20,000 booking fee collected, 30,000 outstanding.
 */
async function owingBooking(status = 'completed'): Promise<{ booking: Booking; token: string }> {
  const { booking, token } = await insertBookingWithToken(prisma, world, { status });
  await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000, ageSeconds: 600 });
  return { booking, token };
}

/** The one session-fee request on the outbox, or a clear failure. */
async function onlyRequest(): Promise<OutboxRow> {
  const rows = (await outbox()).filter((row) => row.template === 'session_fee_request');
  expect(rows).toHaveLength(1);
  return rows[0] as OutboxRow;
}

// --- What the request writes ----------------------------------------------------------------

describe('the payment row a request opens', () => {
  it('is initiated, against the configured provider, for what bookingTotals says is outstanding', async () => {
    const { booking } = await owingBooking();
    expect(await totalsOf(booking.id)).toMatchObject({ outstandingRwf: 30_000 });

    const result = await requestSessionFee(deps(), booking.id);

    expect(result.status).toBe('ok');
    expect(await sessionFees()).toStrictEqual([
      {
        id: expect.any(String),
        booking_id: booking.id,
        kind: 'session_fee',
        provider: PROVIDER,
        our_ref: expect.stringMatching(UUID),
        provider_ref: null,
        method: null,
        amount_rwf: 30_000,
        status: 'initiated',
        settled_at: null,
      },
    ]);
  });

  it('asks for the post-shoot add-ons too, because outstanding includes them (data-model_v2.md §6.1)', async () => {
    const { booking } = await owingBooking();
    await addAddon(booking.id, 15_000);

    await requestSessionFee(deps(), booking.id);

    expect((await sessionFees())[0]).toMatchObject({ amount_rwf: 45_000 });
  });

  it('counts only payments that succeeded: a failed attempt does not reduce the ask', async () => {
    const { booking } = await owingBooking();
    await insertPayment(prisma, booking.id, { status: 'failed', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 5_000 });
    await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', amountRwf: 5_000, ageSeconds: 4_000 });

    await requestSessionFee(deps(), booking.id);

    expect((await sessionFees()).at(-1)).toMatchObject({ amount_rwf: 30_000, status: 'initiated' });
  });

  it('opens the row against the provider it was given, not the one a previous attempt used (spec §6.18)', async () => {
    const { booking } = await owingBooking();

    await requestSessionFee(deps(NOW, 'flutterwave'), booking.id);

    expect((await sessionFees())[0]).toMatchObject({ provider: 'flutterwave', status: 'initiated' });
  });

  it('calls no provider: asking is not collecting', async () => {
    const { booking } = await owingBooking();

    await requestSessionFee(deps(), booking.id);

    // Nothing has been attempted, so nothing has a provider reference or a method.
    expect((await sessionFees())[0]).toMatchObject({ status: 'initiated', provider_ref: null, method: null, settled_at: null });
  });

  it('answers the booking as it now stands, the new request listed among its payments', async () => {
    const { booking } = await owingBooking();

    const result = await requestSessionFee(deps(), booking.id);
    if (result.status !== 'ok') throw new Error(`Expected ok, got ${result.status}`);

    const view = adminBookingView(result.booking, NOW);
    expect(view.payments.map((payment) => [payment.kind, payment.status, payment.amountRwf])).toEqual([
      ['booking_fee', 'succeeded', 20_000],
      ['session_fee', 'initiated', 30_000],
    ]);
    // Still outstanding: an ask is not a payment.
    expect(view.money.totals.outstandingRwf).toBe(30_000);
  });
});

// --- The email ---------------------------------------------------------------------------------

describe('the email the request enqueues', () => {
  it('carries the reference, the amount asked for, and the booking it belongs to', async () => {
    const { booking } = await owingBooking();
    await addAddon(booking.id, 15_000);

    await requestSessionFee(deps(), booking.id);

    const message = await onlyRequest();
    expect(message).toMatchObject({ kind: 'email', template: 'session_fee_request', recipient: CLIENT.email, booking_id: booking.id });
    expect(message.payload).toMatchObject({
      reference: booking.reference,
      clientName: CLIENT.name,
      serviceName: 'Portraits',
      packageName: 'Standard',
      amountRwf: 45_000,
      locale: 'en',
    });
  });

  it('names the amount that was asked for, not the amount outstanding when it is read', async () => {
    const { booking } = await owingBooking();
    await requestSessionFee(deps(), booking.id);

    await addAddon(booking.id, 15_000);

    expect((await onlyRequest()).payload.amountRwf).toBe(30_000);
    expect(await totalsOf(booking.id)).toMatchObject({ outstandingRwf: 45_000 });
  });

  it('renders to an email naming that amount and a link the client can pay through', async () => {
    const { booking } = await owingBooking();

    await requestSessionFee(deps(), booking.id);

    const payload = (await onlyRequest()).payload;
    const email = renderEmail('session_fee_request', payload, { webOrigin: 'https://bookly.example', locale: 'en' });
    expect(email.text).toContain('30,000 RWF');
    expect(email.html).toContain(`https://bookly.example/booking/${String(payload.accessToken)}`);
    expect(email.subject).toContain(booking.reference);
  });

  it('carries a plaintext token that hashes to the booking’s new access_token_hash', async () => {
    const { booking } = await owingBooking();

    await requestSessionFee(deps(), booking.id);

    const token = String((await onlyRequest()).payload.accessToken);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await tokenRow(booking.id)).access_token_hash).toBe(hashAccessToken(token));
    // And it is the only place the plaintext exists.
    const scan = await raw.query<{ found: number }>(
      `SELECT count(*)::int AS found FROM booking WHERE access_token_hash = $1`,
      [token],
    );
    expect(firstRow(scan).found).toBe(0);
  });

  it('is keyed per ask, so a reminder is never swallowed as a duplicate', async () => {
    const { booking } = await owingBooking();

    await requestSessionFee(deps(), booking.id);
    const first = await outbox();
    await requestSessionFee(deps(), booking.id);

    const messages = (await outbox()).filter((row) => row.template === 'session_fee_request');
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((row) => row.dedupe_key)).size).toBe(2);
    expect(messages[0]?.dedupe_key).toBe(first[0]?.dedupe_key);
  });

  it('enqueues nothing at all when the request is refused', async () => {
    const { booking } = await owingBooking('cancelled_by_admin');

    const result = await requestSessionFee(deps(), booking.id);

    expect(result).toStrictEqual({ status: 'not_allowed' });
    expect(await outbox()).toEqual([]);
    expect(await sessionFees()).toEqual([]);
  });
});

// --- The access token it rotates (spec §6.21) ----------------------------------------------------

describe('the link the email carries', () => {
  it('works, and the previous one stops resolving the moment it commits', async () => {
    const { booking, token: old } = await owingBooking();
    expect(await findBookingByToken(prisma, old)).not.toBeNull();

    await requestSessionFee(deps(), booking.id);

    const fresh = String((await onlyRequest()).payload.accessToken);
    expect(fresh).not.toBe(old);
    expect(await findBookingByToken(prisma, old)).toBeNull();
    expect((await findBookingByToken(prisma, fresh))?.id).toBe(booking.id);
  });

  it('refreshes the expiry from the injected clock and clears the last use', async () => {
    const { booking } = await owingBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { accessTokenLastUsedAt: NOW } });
    const before = await tokenRow(booking.id);

    await requestSessionFee(deps(), booking.id);

    const after = await tokenRow(booking.id);
    expect(after.access_token_expires_at).toStrictEqual(new Date(NOW.getTime() + ACCESS_TOKEN_LIFETIME_DAYS * DAY_MS));
    expect(after.access_token_expires_at).not.toStrictEqual(before.access_token_expires_at);
    expect(after.access_token_last_used_at).toBeNull();
  });

  it('gives a reminder its own working link, and kills the one the first email carried', async () => {
    const { booking } = await owingBooking();
    await requestSessionFee(deps(), booking.id);
    const first = String(((await outbox())[0] as OutboxRow).payload.accessToken);

    await requestSessionFee(deps(), booking.id);

    const messages = (await outbox()).filter((row) => row.template === 'session_fee_request');
    const second = String((messages[1] as OutboxRow).payload.accessToken);
    expect(second).not.toBe(first);
    expect(await findBookingByToken(prisma, first)).toBeNull();
    expect((await findBookingByToken(prisma, second))?.id).toBe(booking.id);
  });

  it('issues a link even for a booking that had none', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000, ageSeconds: 600 });
    expect((await tokenRow(booking.id)).access_token_hash).toBeNull();

    await requestSessionFee(deps(), booking.id);

    const token = String((await onlyRequest()).payload.accessToken);
    expect((await findBookingByToken(prisma, token))?.id).toBe(booking.id);
  });
});

// --- The frozen amount (data-model_v2.md §6.2) -----------------------------------------------------

describe('the amount is frozen once it is asked for', () => {
  it('leaves amount_rwf untouched when an add-on is added afterwards, while outstanding rises', async () => {
    const { booking } = await owingBooking();
    await requestSessionFee(deps(), booking.id);
    const before = (await sessionFees())[0];

    await addAddon(booking.id, 15_000);

    expect((await sessionFees())[0]).toStrictEqual(before);
    expect((await sessionFees())[0]).toMatchObject({ amount_rwf: 30_000 });
    expect(await totalsOf(booking.id)).toMatchObject({ grandTotalRwf: 65_000, outstandingRwf: 45_000 });
  });

  it('opens a second row for the new amount when he asks again, and leaves the first exactly as it was', async () => {
    const { booking } = await owingBooking();
    await requestSessionFee(deps(), booking.id);
    const first = (await sessionFees())[0];
    await addAddon(booking.id, 15_000);

    const result = await requestSessionFee(deps(), booking.id);

    expect(result.status).toBe('ok');
    const rows = await sessionFees();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first?.id)).toStrictEqual(first);
    expect(rows.find((row) => row.id !== first?.id)).toMatchObject({ amount_rwf: 45_000, status: 'initiated' });
  });

  it('reuses the same row when he asks again for the same amount, and sends a second email', async () => {
    const { booking } = await owingBooking();
    await requestSessionFee(deps(), booking.id);
    const first = (await sessionFees())[0];

    const result = await requestSessionFee(deps(), booking.id);

    expect(result.status).toBe('ok');
    expect(await sessionFees()).toStrictEqual([first]);
    const messages = (await outbox()).filter((row) => row.template === 'session_fee_request');
    expect(messages).toHaveLength(2);
    expect(messages.every((row) => row.payload.amountRwf === 30_000)).toBe(true);
  });

  it('opens a new row rather than reusing one recorded against another provider (spec §6.18)', async () => {
    const { booking } = await owingBooking();
    await requestSessionFee(deps(NOW, 'flutterwave'), booking.id);

    await requestSessionFee(deps(NOW, PROVIDER), booking.id);

    const rows = await sessionFees();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.provider).sort()).toEqual(['flutterwave', PROVIDER]);
  });

  it('opens a new row rather than reusing an attempt that failed', async () => {
    const { booking } = await owingBooking();
    const failed = await insertPayment(prisma, booking.id, {
      status: 'failed',
      kind: 'session_fee',
      amountRwf: 30_000,
      ageSeconds: PAYMENT_ATTEMPT_WINDOW_SECONDS + 60,
    });

    await requestSessionFee(deps(), booking.id);

    const rows = await sessionFees();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === failed.id)).toMatchObject({ status: 'failed' });
  });

  it('reuses the row the client has not attempted even long after it was written', async () => {
    const { booking } = await owingBooking();
    const requested = await insertPayment(prisma, booking.id, {
      status: 'initiated',
      kind: 'session_fee',
      amountRwf: 30_000,
      ageSeconds: 30 * 24 * 3_600,
    });

    await requestSessionFee(deps(), booking.id);

    expect(await sessionFees()).toHaveLength(1);
    expect((await sessionFees())[0]).toMatchObject({ id: requested.id, amount_rwf: 30_000 });
  });
});

// --- Refusals ---------------------------------------------------------------------------------

describe('a request that cannot be made', () => {
  it('answers not_found for a booking id nothing matches, and writes nothing', async () => {
    const result = await requestSessionFee(deps(), UNKNOWN_ID);

    expect(result).toStrictEqual({ status: 'not_found' });
    expect(await payments()).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it('answers nothing_to_pay once the shoot is paid in full', async () => {
    const { booking } = await owingBooking();
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 500 });

    const result = await requestSessionFee(deps(), booking.id);

    expect(result).toStrictEqual({ status: 'nothing_to_pay' });
    expect(await sessionFees()).toHaveLength(1);
    expect(await outbox()).toEqual([]);
  });

  it('answers nothing_to_pay for a free booking that never owed anything', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed', addons: [], bookingFeeRwf: 0 });
    await prisma.booking.update({ where: { id: booking.id }, data: { packagePriceRwf: 0 } });

    expect(await requestSessionFee(deps(), booking.id)).toStrictEqual({ status: 'nothing_to_pay' });
    expect(await payments()).toEqual([]);
  });

  it.each(['pending_payment', 'expired', 'no_show', 'cancelled_by_client', 'cancelled_by_admin'])(
    'answers not_allowed for a %s booking, which owes nothing (data-model_v2.md §6.1)',
    async (status) => {
      const { booking } = await owingBooking(status);

      const result = await requestSessionFee(deps(), booking.id);

      expect(result).toStrictEqual({ status: 'not_allowed' });
      expect(await sessionFees()).toEqual([]);
      expect(await outbox()).toEqual([]);
    },
  );

  it('allows it on a confirmed booking too: the money is owed before the shoot is marked done', async () => {
    const { booking } = await owingBooking('confirmed');

    const result = await requestSessionFee(deps(), booking.id);

    expect(result.status).toBe('ok');
    expect((await sessionFees())[0]).toMatchObject({ amount_rwf: 30_000 });
  });

  it('answers in_progress while a recent attempt is pending, and writes nothing', async () => {
    const { booking } = await owingBooking();
    const waiting = await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 30 });
    const before = await tokenRow(booking.id);

    const result = await requestSessionFee(deps(), booking.id);

    expect(result).toStrictEqual({ status: 'in_progress' });
    expect(await sessionFees()).toHaveLength(1);
    expect((await sessionFees())[0]).toMatchObject({ id: waiting.id, status: 'pending' });
    expect(await outbox()).toEqual([]);
    // And the client's link is untouched: a refusal rotates nothing.
    expect(await tokenRow(booking.id)).toStrictEqual(before);
  });

  it('answers in_progress right up to the edge of the window, and asks again past it', async () => {
    const { booking } = await owingBooking();
    const waiting = await insertPayment(prisma, booking.id, {
      status: 'pending',
      kind: 'session_fee',
      amountRwf: 30_000,
      ageSeconds: PAYMENT_ATTEMPT_WINDOW_SECONDS - 10,
    });

    expect(await requestSessionFee(deps(), booking.id)).toStrictEqual({ status: 'in_progress' });

    await raw.query(`UPDATE payment SET initiated_at = now() - interval '1 hour' WHERE id = $1`, [waiting.id]);

    expect((await requestSessionFee(deps(), booking.id)).status).toBe('ok');
    expect(await sessionFees()).toHaveLength(2);
  });

  it('is not blocked by a pending booking fee, nor by another booking’s session fee', async () => {
    const other = await owingBooking();
    await insertPayment(prisma, other.booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 10 });
    const { booking } = await owingBooking();
    await insertPayment(prisma, booking.id, { status: 'pending', kind: 'booking_fee', amountRwf: 20_000, ageSeconds: 10 });

    expect((await requestSessionFee(deps(), booking.id)).status).toBe('ok');
  });
});

// --- The second request (spec §6.15) ---------------------------------------------------------------

describe('a second request after one has succeeded (spec §6.15)', () => {
  it('opens a second row rather than editing the settled one, and both can succeed', async () => {
    const { booking } = await owingBooking();
    // The first session fee, asked for and paid.
    await requestSessionFee(deps(), booking.id);
    const first = (await sessionFees())[0];
    await raw.query(`UPDATE payment SET status = 'succeeded', settled_at = now() WHERE id = $1`, [first?.id]);
    expect(await totalsOf(booking.id)).toMatchObject({ outstandingRwf: 0 });

    // An add-on afterwards, and a second ask.
    await addAddon(booking.id, 15_000);
    const result = await requestSessionFee(deps(), booking.id);

    expect(result.status).toBe('ok');
    const rows = await sessionFees();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first?.id)).toMatchObject({ status: 'succeeded', amount_rwf: 30_000 });
    const second = rows.find((row) => row.id !== first?.id);
    expect(second).toMatchObject({ status: 'initiated', amount_rwf: 15_000 });

    await raw.query(`UPDATE payment SET status = 'succeeded', settled_at = now() WHERE id = $1`, [second?.id]);

    expect((await sessionFees()).filter((row) => row.status === 'succeeded')).toHaveLength(2);
    expect(await totalsOf(booking.id)).toMatchObject({ grandTotalRwf: 65_000, collectedRwf: 65_000, outstandingRwf: 0 });
  });

  it('violates no index doing so: payment_one_succeeded_booking_fee is booking-fee only', async () => {
    const { booking } = await owingBooking();
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 900 });
    await addAddon(booking.id, 15_000);
    await requestSessionFee(deps(), booking.id);
    const opened = (await sessionFees()).find((row) => row.status === 'initiated');

    await expect(
      raw.query(`UPDATE payment SET status = 'succeeded', settled_at = now() WHERE id = $1`, [opened?.id]),
    ).resolves.toBeDefined();

    // And a second succeeded booking fee is still impossible.
    await expect(
      raw.query(
        `INSERT INTO payment (booking_id, kind, provider, amount_rwf, status) VALUES ($1, 'booking_fee', 'mtn_momo_direct', 1, 'succeeded')`,
        [booking.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('asks only for the difference, never for the whole booking again', async () => {
    const { booking } = await owingBooking();
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 900 });
    await addAddon(booking.id, 15_000);

    await requestSessionFee(deps(), booking.id);

    expect((await sessionFees()).find((row) => row.status === 'initiated')).toMatchObject({ amount_rwf: 15_000 });
    expect((await onlyRequest()).payload.amountRwf).toBe(15_000);
  });
});

// --- Two asks at once ---------------------------------------------------------------------------

describe('two requests arriving at once', () => {
  it('writes one row and one ask per email, never two bills for the same money', async () => {
    const { booking } = await owingBooking();

    const results = await Promise.all(Array.from({ length: 4 }, () => requestSessionFee(deps(), booking.id)));

    expect(results.map((result) => result.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(await sessionFees()).toHaveLength(1);
    expect((await sessionFees())[0]).toMatchObject({ amount_rwf: 30_000 });
    const messages = (await outbox()).filter((row) => row.template === 'session_fee_request');
    expect(messages).toHaveLength(4);
    expect(new Set(messages.map((row) => row.dedupe_key)).size).toBe(4);
  });

  it('leaves exactly one token live afterwards, whichever ask committed last', async () => {
    const { booking } = await owingBooking();

    await Promise.all(Array.from({ length: 4 }, () => requestSessionFee(deps(), booking.id)));

    const tokens = (await outbox()).filter((row) => row.template === 'session_fee_request').map((row) => String(row.payload.accessToken));
    const live = [];
    for (const token of tokens) if ((await findBookingByToken(prisma, token)) !== null) live.push(token);
    expect(live).toHaveLength(1);
  });
});

// --- Where asking meets paying ---------------------------------------------------------------

/**
 * Two rules that meet here, both about money that may already be moving.
 *
 * An ask waits while an attempt is in hand: a prompt on the payer’s phone, or
 * an `initiated` row younger than `CALL_IN_FLIGHT_SECONDS`, whose provider call
 * may still be running (payments/initiate.ts). Asking rotates the access token,
 * so an ask let through at that moment would kill the link the client is paying
 * on.
 *
 * And a request the photographer has since made smaller is not billed. The
 * frozen amount holds against what was added after it (spec §6.15), never
 * against what was taken off: paying a stale ask would overpay the client by
 * construction, so what is actually owed is charged instead.
 */
describe('asking while the client is already paying', () => {
  it('waits while an initiated attempt could still be at the provider, and leaves that link alone', async () => {
    const { booking, token: old } = await owingBooking();
    // Exactly the row startSessionFeePayment calls `in_progress`: initiated, seconds old.
    const inFlight = await insertPayment(prisma, booking.id, { status: 'initiated', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 5 });

    expect(await requestSessionFee(deps(), booking.id)).toStrictEqual({ status: 'in_progress' });

    expect(await sessionFees()).toHaveLength(1);
    expect((await sessionFees())[0]).toMatchObject({ id: inFlight.id, amount_rwf: 30_000 });
    // The link the client is paying through still opens their booking.
    expect((await findBookingByToken(prisma, old))?.id).toBe(booking.id);
  });

  it('asks again once that attempt is too old to be a call in flight', async () => {
    const { booking, token: old } = await owingBooking();
    const stale = await insertPayment(prisma, booking.id, { status: 'initiated', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 120 });

    expect((await requestSessionFee(deps(), booking.id)).status).toBe('ok');

    // The same row, asked for again: a reminder, not a second bill.
    expect(await sessionFees()).toHaveLength(1);
    expect((await sessionFees())[0]).toMatchObject({ id: stale.id, amount_rwf: 30_000 });
    expect(await findBookingByToken(prisma, old)).toBeNull();
  });

  it('does block once that attempt reaches pending', async () => {
    const { booking, token: old } = await owingBooking();
    await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000, ageSeconds: 5 });

    expect(await requestSessionFee(deps(), booking.id)).toStrictEqual({ status: 'in_progress' });
    expect((await findBookingByToken(prisma, old))?.id).toBe(booking.id);
  });
});

// Add-ons are edited while the booking is confirmed and its shoot has begun (2026-09-27).
describe('removing an add-on after the request was sent', () => {
  it('leaves the frozen amount above what the booking is now worth', async () => {
    const { booking } = await owingBooking('confirmed');
    await addAddon(booking.id, 15_000);
    await requestSessionFee(deps(), booking.id);
    expect((await sessionFees())[0]).toMatchObject({ amount_rwf: 45_000 });

    // The photographer changes his mind and takes the add-on off again.
    const line = await prisma.bookingAddon.findFirstOrThrow({ where: { bookingId: booking.id, stage: 'post_shoot' } });
    const removed = await removePostShootAddon({ prisma, now: () => new Date(booking.startsAt.getTime() + 60_000) }, booking.id, line.id);

    expect(removed.status).toBe('ok');
    // Nothing reconsiders the request: it still asks for 45,000 against 30,000 owed.
    expect((await sessionFees())[0]).toMatchObject({ amount_rwf: 45_000, status: 'initiated' });
    expect(await totalsOf(booking.id)).toMatchObject({ grandTotalRwf: 50_000, outstandingRwf: 30_000 });
    // And the email in the client's inbox still names the larger figure.
    expect((await onlyRequest()).payload.amountRwf).toBe(45_000);
  });

  it('bills what is owed when the client pays, because an ask for more than that is stale', async () => {
    const { booking } = await owingBooking('confirmed');
    await addAddon(booking.id, 15_000);
    await requestSessionFee(deps(), booking.id);
    const line = await prisma.bookingAddon.findFirstOrThrow({ where: { bookingId: booking.id, stage: 'post_shoot' } });
    await removePostShootAddon({ prisma, now: () => new Date(booking.startsAt.getTime() + 60_000) }, booking.id, line.id);
    // Past the in-flight window, so the request reads as a request (initiate.ts).
    await prisma.$executeRaw`UPDATE payment SET initiated_at = initiated_at - interval '5 minutes' WHERE kind = 'session_fee'`;
    const provider = stubProvider();

    await startSessionFeePayment(
      { prisma, provider },
      { bookingId: booking.id, reference: booking.reference, method: 'momo_mtn', payerPhone: '+250788123456' },
    );

    // Not the 45,000 the stale ask still names: the client owes 30,000.
    expect(provider.initiated).toStrictEqual([expect.objectContaining({ amountRwf: 30_000 })]);
    const rows = await sessionFees();
    expect(rows).toHaveLength(2);
    // The ask stays on record; the attempt that will settle is the new one.
    expect(rows.map((row) => `${row.amount_rwf}:${row.status}`).sort()).toStrictEqual(
      ['30000:pending', '45000:initiated'],
    );
  });
});
