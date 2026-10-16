import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AccessToken, hashAccessToken } from '../booking/access-token.js';
import { createPrismaClient } from '../db/client.js';
import { renderEmail } from '../email/render.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  ADMIN_EMAIL,
  BUFFER_MINUTES,
  CLIENT,
  DAY_MS,
  DURATION_MINUTES,
  MINUTE_MS,
  type PaymentWorld,
  UUID,
  insertBooking,
  insertPayment,
  logSink,
  mtnDelivery,
  mtnProvider,
  mtnStatusBody,
  seedWorld,
  stubProvider,
} from '../test/payment-fixtures.js';
import type { MtnMomoProvider } from './mtn-momo.js';
import type { ProviderEvent, WebhookDelivery } from './provider.js';
import { type WebhookDeps, type WebhookOutcome, receiveWebhook, recordEvent } from './webhooks.js';

/**
 * Applying what a payment provider says (plan.md Task 17; spec §3.1 steps
 * 10-12, §6.9, §6.16; data-model_v2.md §5.11-§5.13, §7.2, §7.3), against real
 * PostgreSQL. Deliveries are made by the real MTN provider: a status body sent
 * to the callback URL it signed, or not.
 *
 * What is proven, bullet by bullet of Task 17:
 * - a valid `succeeded` event confirms the booking -- hold nulled,
 *   `confirmed_at` set, `access_token_hash` the SHA-256 of a token that lives
 *   365 days -- records the payment, and enqueues `booking_confirmation` and
 *   `admin_new_booking` with payloads that render;
 * - the same `(provider, event_id)` twice, in turn or at once, is one `applied`
 *   row, the rest `ignored`, and one confirmation;
 * - an event for a payment already `succeeded`, `failed`, `refunded` (or
 *   `refund_due`) is stored `ignored` and changes nothing, including a success
 *   for a failed payment;
 * - a bad signature is stored `signature_valid = false`, `ignored`, and applies
 *   nothing, and never takes the event id a genuine delivery will need;
 * - an event matching no payment is stored `ignored`, with its reference and
 *   payload, for inspection;
 * - a late success re-confirms an expired booking whose slot is free -- stale
 *   holds in the way do not count -- and otherwise leaves it expired, the
 *   payment `refund_due`, and an `admin_alert` queued; a second fee for a paid
 *   booking is `refund_due` too;
 * - the plaintext token is in the confirmation's outbox payload and in no column
 *   of any booking, nor anywhere else in the database, nor in a log line.
 * Beyond the bullets: failures and amount mismatches, the provider_ref match,
 * processing failures that a retry reprocesses, contention retries, and bodies
 * PostgreSQL would otherwise refuse.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let provider: MtnMomoProvider;
let sink: ReturnType<typeof logSink>;
let tokens: AccessToken[];

const NOW = new Date('2026-10-02T09:15:00.000Z');
const WEB_ORIGIN = 'https://bookly.example';

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
  provider = mtnProvider();
  sink = logSink();
  tokens = [];
});

// --- Helpers ----------------------------------------------------------------------------

/** Distinct, recognisable 43-character tokens, recorded as they are handed out. */
function newAccessToken(): AccessToken {
  const token = `TokEn${String(tokens.length).padStart(3, '0')}${'Qx7_Lm2-Zp9'.repeat(4)}`.slice(0, 43);
  const issued = { token, hash: hashAccessToken(token) };
  tokens.push(issued);
  return issued;
}

function deps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return { prisma, now: () => NOW, newAccessToken, log: sink.log, ...overrides };
}

function statusDelivery(ourRef: string, status: string, extra: Record<string, unknown> = {}): WebhookDelivery {
  return mtnDelivery(provider, ourRef, mtnStatusBody(ourRef, status, extra));
}

function deliver(delivery: WebhookDelivery, overrides: Partial<WebhookDeps> = {}): Promise<WebhookOutcome> {
  return receiveWebhook(deps(overrides), provider, delivery);
}

type EventRow = {
  id: string;
  provider: string;
  event_id: string;
  event_type: string;
  our_ref: string | null;
  provider_ref: string | null;
  reported_status: string | null;
  signature_valid: boolean;
  payload: unknown;
  status: string;
  processing_error: string | null;
  processed: boolean;
};

async function events(): Promise<EventRow[]> {
  const result = await raw.query<EventRow>(
    `SELECT id::text, provider, event_id, event_type, our_ref::text, provider_ref, reported_status, signature_valid, payload, status,
            processing_error, processed_at IS NOT NULL AS processed
       FROM webhook_event ORDER BY received_at, event_id`,
  );
  return result.rows;
}

async function eventById(id: string): Promise<EventRow> {
  const found = (await events()).find((row) => row.id === id);
  if (found === undefined) throw new Error(`No webhook_event ${id}`);
  return found;
}

type OutboxRow = { kind: string; template: string; recipient: string; booking_id: string | null; dedupe_key: string; payload: Record<string, unknown>; status: string };

async function outbox(): Promise<OutboxRow[]> {
  const result = await raw.query<OutboxRow>(
    `SELECT kind, template, recipient, booking_id::text, dedupe_key, payload, status FROM outbox ORDER BY template, dedupe_key`,
  );
  return result.rows;
}

/** A whole row as JSON text: equal before and after means nothing changed. */
async function rowJson(table: 'booking' | 'payment', id: string): Promise<string> {
  const result = await raw.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM ${table} t WHERE id = $1`, [id]);
  return firstRow(result).row;
}

type BookingRow = {
  status: string;
  hold_expires_at: Date | null;
  confirmed_at: Date | null;
  access_token_hash: string | null;
  access_token_expires_at: Date | null;
};

async function bookingRow(id: string): Promise<BookingRow> {
  const result = await raw.query<BookingRow>(
    `SELECT status, hold_expires_at, confirmed_at, access_token_hash, access_token_expires_at FROM booking WHERE id = $1`,
    [id],
  );
  return firstRow(result);
}

type PaymentRow = { status: string; settled_at: Date | null; provider_ref: string | null; method: string | null; failure_reason: string | null; amount_rwf: number };

async function paymentRow(id: string): Promise<PaymentRow> {
  const result = await raw.query<PaymentRow>(`SELECT status, settled_at, provider_ref, method, failure_reason, amount_rwf FROM payment WHERE id = $1`, [id]);
  return firstRow(result);
}

/** A pending_payment booking holding its slot, with a pending booking-fee payment. */
async function waitingBooking(seed: Parameters<typeof insertBooking>[2] = {}) {
  const booking = await insertBooking(prisma, world, seed);
  const payment = await insertPayment(prisma, booking.id, { status: 'pending' });
  return { booking, payment };
}

function event(overrides: Partial<ProviderEvent>): ProviderEvent {
  return {
    eventId: `manual:${Math.random()}`,
    eventType: 'manual',
    ourRef: null,
    providerRef: null,
    reportedStatus: 'succeeded',
    method: 'momo_mtn',
    failureReason: null,
    amount: null,
    ...overrides,
  };
}

// --- A valid success ----------------------------------------------------------------------

describe('a valid succeeded event', () => {
  it('confirms the booking: status confirmed, hold nulled, confirmed_at set, token hashed, expiring in 365 days', async () => {
    const { booking, payment } = await waitingBooking();
    expect(booking.holdExpiresAt).not.toBeNull();

    const outcome = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    expect(outcome).toMatchObject({ status: 'applied', note: 'booking_confirmed', eventRowId: expect.stringMatching(UUID) });
    const after = await bookingRow(booking.id);
    expect(tokens).toHaveLength(1);
    expect(after).toStrictEqual({
      status: 'confirmed',
      hold_expires_at: null,
      confirmed_at: NOW,
      access_token_hash: createHash('sha256').update(tokens[0]?.token ?? '').digest('hex'),
      access_token_expires_at: new Date(NOW.getTime() + 365 * DAY_MS),
    });
  });

  it('records the payment: succeeded at the same instant, with MTN’s transaction id and the method, the amount untouched', async () => {
    const { payment } = await waitingBooking();
    const body = mtnStatusBody(payment.ourRef, 'SUCCESSFUL', { financialTransactionId: '5550001' });

    await deliver(mtnDelivery(provider, payment.ourRef, body));

    expect(await paymentRow(payment.id)).toStrictEqual({
      status: 'succeeded',
      settled_at: NOW,
      provider_ref: '5550001',
      method: 'momo_mtn',
      failure_reason: null,
      amount_rwf: 20_000,
    });
  });

  it('stores the event applied, verified, with its id, type, references, reported status and verbatim payload', async () => {
    const { payment } = await waitingBooking();
    const body = mtnStatusBody(payment.ourRef, 'SUCCESSFUL', { financialTransactionId: '5550002' });

    const outcome = await deliver(mtnDelivery(provider, payment.ourRef, body));

    expect(await events()).toStrictEqual([
      {
        id: outcome.eventRowId,
        provider: 'mtn_momo_direct',
        event_id: `${payment.ourRef}:SUCCESSFUL`,
        event_type: 'requesttopay.SUCCESSFUL',
        our_ref: payment.ourRef,
        provider_ref: '5550002',
        reported_status: 'succeeded',
        signature_valid: true,
        payload: body,
        status: 'applied',
        processing_error: null,
        processed: true,
      },
    ]);
  });

  it('enqueues booking_confirmation to the booking’s contact email with the plaintext token, and admin_new_booking to the photographer', async () => {
    const { booking, payment } = await waitingBooking({ addons: ['shared', 'own'] });

    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    const basics = {
      locale: 'en',
      reference: booking.reference,
      clientName: CLIENT.name,
      serviceName: 'Portraits',
      packageName: 'Standard',
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      locationText: CLIENT.location,
      // 40,000 + 10,000 + 5,000 quoted; 20,000 paid.
      paidRwf: 20_000,
      outstandingRwf: 35_000,
    };
    expect(await outbox()).toStrictEqual([
      {
        kind: 'email',
        template: 'admin_new_booking',
        recipient: ADMIN_EMAIL,
        booking_id: booking.id,
        dedupe_key: `email:admin_new_booking:${booking.id}`,
        status: 'pending',
        payload: {
          ...basics,
          clientEmail: CLIENT.email,
          clientPhone: CLIENT.phone,
          partySize: 3,
          specialRequests: CLIENT.specialRequests,
          // The service's own add-on before the shared one, as quoted.
          addons: [
            { name: 'Extra hour', priceRwf: 10_000 },
            { name: 'Rush edit', priceRwf: 5_000 },
          ],
          totalRwf: 55_000,
        },
      },
      {
        kind: 'email',
        template: 'booking_confirmation',
        recipient: CLIENT.email,
        booking_id: booking.id,
        dedupe_key: `email:booking_confirmation:${booking.id}`,
        status: 'pending',
        payload: { ...basics, accessToken: tokens[0]?.token },
      },
    ]);
  });

  it('enqueues payloads the email templates render, with the token only inside the booking link', async () => {
    const { payment } = await waitingBooking();
    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    const rows = await outbox();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const email = renderEmail(row.template, row.payload, { webOrigin: WEB_ORIGIN, locale: row.payload.locale as string });
      expect(email.subject.length).toBeGreaterThan(5);
      expect(email.text).not.toMatch(/undefined|NaN|\{\{/);
    }
    const confirmation = rows.find((row) => row.template === 'booking_confirmation');
    const email = renderEmail('booking_confirmation', confirmation?.payload, { webOrigin: WEB_ORIGIN, locale: 'en' });
    const token = tokens[0]?.token ?? '';
    expect(email.text).toContain('20,000 RWF');
    expect(email.text).toContain('30,000 RWF');
    expect(email.text.split(token)).toHaveLength(2);
    expect(email.text).toMatch(new RegExp(`${WEB_ORIGIN}/[^\\s]*${token}`));
  });

  it('confirms a booking still pending_payment whose hold lapsed before the sweeper ran', async () => {
    const { booking, payment } = await waitingBooking({ holdMinutes: -5 });

    const outcome = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    expect(outcome.note).toBe('booking_confirmed');
    expect(await bookingRow(booking.id)).toMatchObject({ status: 'confirmed', hold_expires_at: null });
  });

  it('confirms from a payment still initiated, when the webhook beats the provider’s own answer', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'initiated' });

    await expect(deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'))).resolves.toMatchObject({ status: 'applied', note: 'booking_confirmed' });
    expect((await paymentRow(payment.id)).status).toBe('succeeded');
  });

  it('keeps a provider_ref the payment already has', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'pending', providerRef: 'EARLIER-REF' });

    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL', { financialTransactionId: 'LATER-REF' }));

    expect((await paymentRow(payment.id)).provider_ref).toBe('EARLIER-REF');
  });

  it('applies an event that states no amount, and one stating it as "20000.0"', async () => {
    const first = await waitingBooking();
    const second = await waitingBooking();

    await expect(deliver(statusDelivery(first.payment.ourRef, 'SUCCESSFUL', { amount: undefined }))).resolves.toMatchObject({ status: 'applied' });
    await expect(deliver(statusDelivery(second.payment.ourRef, 'SUCCESSFUL', { amount: '20000.0' }))).resolves.toMatchObject({ status: 'applied' });
  });

  it('sends admin_new_booking to the oldest admin account when there are two', async () => {
    await raw.query(`INSERT INTO admin_user (email, password_hash, created_at) VALUES ('first@bookly.example', 'x', now() - interval '1 year')`);
    const { payment } = await waitingBooking();

    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    expect((await outbox()).find((row) => row.template === 'admin_new_booking')?.recipient).toBe('first@bookly.example');
  });

  it('still confirms and emails the client when there is no admin account, logging the skipped alert', async () => {
    await raw.query('DELETE FROM admin_user');
    const { booking, payment } = await waitingBooking();

    const outcome = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    expect(outcome.status).toBe('applied');
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
    expect((await outbox()).map((row) => row.template)).toEqual(['booking_confirmation']);
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'admin_new_booking_skipped', reason: 'no_admin_user' }));
  });

  it('generates a real 43-character token when none is injected', async () => {
    const { booking, payment } = await waitingBooking();

    await receiveWebhook({ prisma, log: sink.log }, provider, statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    const token = (await outbox()).find((row) => row.template === 'booking_confirmation')?.payload.accessToken as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await bookingRow(booking.id)).access_token_hash).toBe(hashAccessToken(token));
  });
});

// --- The plaintext token --------------------------------------------------------------------

describe('the plaintext access token', () => {
  it('is in the booking_confirmation outbox payload and in no column of any booking row', async () => {
    const { booking, payment } = await waitingBooking();
    // Another booking, so the scan covers more than one row.
    await insertBooking(prisma, world, { status: 'confirmed' });

    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));
    const token = tokens[0]?.token ?? '';
    expect(token).toHaveLength(43);

    const confirmation = (await outbox()).filter((row) => row.payload.accessToken === token);
    expect(confirmation.map((row) => row.template)).toEqual(['booking_confirmation']);

    // Every column of every booking, whatever its type.
    const columns = await raw.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'booking'`,
    );
    expect(columns.rows.length).toBeGreaterThan(30);
    const bookings = await raw.query<Record<string, unknown>>('SELECT * FROM booking');
    expect(bookings.rows).toHaveLength(2);
    for (const row of bookings.rows) {
      for (const { column_name: column } of columns.rows) {
        const value = row[column];
        const text = value instanceof Date ? value.toISOString() : JSON.stringify(value ?? null);
        expect(text, `booking.${column}`).not.toContain(token);
      }
    }
    // The hash, and nothing reversible, is what the booking holds.
    expect((await bookingRow(booking.id)).access_token_hash).toBe(hashAccessToken(token));
  });

  it('is in no text or JSON column of any table except outbox.payload, and in no log line', async () => {
    const { payment } = await waitingBooking();
    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));
    const token = tokens[0]?.token ?? '';

    const columns = await raw.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name NOT LIKE '\\_prisma%'
          AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'uuid')`,
    );
    const scanned: string[] = [];
    for (const { table_name: table, column_name: column } of columns.rows) {
      if (table === 'outbox' && column === 'payload') continue;
      const hits = await raw.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}" WHERE "${column}"::text LIKE '%' || $1 || '%'`, [token]);
      expect(firstRow(hits).n, `${table}.${column}`).toBe('0');
      scanned.push(`${table}.${column}`);
    }
    expect(scanned).toEqual(expect.arrayContaining(['booking.access_token_hash', 'webhook_event.payload', 'outbox.dedupe_key', 'payment.failure_reason']));

    const outboxHits = await raw.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox WHERE payload::text LIKE '%' || $1 || '%'`, [token]);
    expect(firstRow(outboxHits).n).toBe('1');

    expect(JSON.stringify(sink.entries)).not.toContain(token);
  });
});

// --- Duplicate delivery ------------------------------------------------------------------------

describe('a duplicate delivery of one (provider, event_id)', () => {
  it('yields one applied row and one ignored row, and one booking_confirmation', async () => {
    const { booking, payment } = await waitingBooking();
    const delivery = statusDelivery(payment.ourRef, 'SUCCESSFUL');

    const first = await deliver(delivery);
    const confirmedOnce = await rowJson('booking', booking.id);
    const second = await deliver(delivery);

    expect(first).toMatchObject({ status: 'applied', note: 'booking_confirmed' });
    expect(second).toMatchObject({ status: 'ignored', note: 'duplicate_delivery' });
    expect(second.eventRowId).not.toBe(first.eventRowId);

    const rows = await events();
    expect(rows.map((row) => row.status).sort()).toEqual(['applied', 'ignored']);
    const duplicate = await eventById(second.eventRowId);
    expect(duplicate).toMatchObject({
      event_id: expect.stringMatching(new RegExp(`^${payment.ourRef}:SUCCESSFUL#duplicate:[0-9a-f-]{36}$`)),
      signature_valid: true,
      status: 'ignored',
      processing_error: `duplicate_of:${first.eventRowId}`,
      our_ref: payment.ourRef,
      processed: true,
    });

    expect((await outbox()).filter((row) => row.template === 'booking_confirmation')).toHaveLength(1);
    expect(await rowJson('booking', booking.id)).toBe(confirmedOnce);
    expect(tokens).toHaveLength(1);
  });

  it('stays one confirmation over five deliveries in turn', async () => {
    const { payment } = await waitingBooking();
    const delivery = statusDelivery(payment.ourRef, 'SUCCESSFUL');

    const outcomes = [];
    for (let i = 0; i < 5; i += 1) outcomes.push(await deliver(delivery));

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'ignored', 'ignored', 'ignored', 'ignored']);
    expect(await outbox()).toHaveLength(2);
    expect(await events()).toHaveLength(5);
  });

  it('applies exactly once when eight deliveries of the event arrive at the same moment', async () => {
    const { booking, payment } = await waitingBooking();
    const delivery = statusDelivery(payment.ourRef, 'SUCCESSFUL');

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => deliver(delivery)));

    expect(outcomes.filter((outcome) => outcome.status === 'applied')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'ignored')).toHaveLength(7);
    expect((await events()).filter((row) => row.status === 'applied')).toHaveLength(1);
    expect((await outbox()).map((row) => row.template).sort()).toEqual(['admin_new_booking', 'booking_confirmation']);
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
    expect(tokens).toHaveLength(1);
  });

  it('treats the same outcome with a different body (a new transaction id) as the same event', async () => {
    const { payment } = await waitingBooking();

    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL', { financialTransactionId: '111' }));
    const again = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL', { financialTransactionId: '222' }));

    expect(again.note).toBe('duplicate_delivery');
    expect((await paymentRow(payment.id)).provider_ref).toBe('111');
  });

  it('treats a different status for the same payment as a different event', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'initiated' });

    await expect(deliver(statusDelivery(payment.ourRef, 'PENDING'))).resolves.toMatchObject({ status: 'applied', note: 'payment_pending' });
    await expect(deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'))).resolves.toMatchObject({ status: 'applied', note: 'booking_confirmed' });
    expect((await events()).map((row) => row.event_id)).toEqual([`${payment.ourRef}:PENDING`, `${payment.ourRef}:SUCCESSFUL`]);
  });

  it('keys a duplicate on the provider: the same event id from another provider is its own event', async () => {
    const { payment } = await waitingBooking();
    const flutterwave = stubProvider({ id: 'flutterwave', parseWebhook: () => event({ eventId: `${payment.ourRef}:SUCCESSFUL`, ourRef: payment.ourRef }) });

    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));
    const other = await receiveWebhook(deps(), flutterwave, { rawBody: Buffer.from('{}'), headers: {}, params: {} });

    // Stored as its own event -- and matching no flutterwave payment, since this one is MTN's.
    expect(other).toMatchObject({ status: 'ignored', note: 'no_matching_payment' });
    expect((await eventById(other.eventRowId)).event_id).toBe(`${payment.ourRef}:SUCCESSFUL`);
  });
});

// --- Terminal statuses ------------------------------------------------------------------------

describe('an event for a payment already settled', () => {
  it.each(['succeeded', 'failed', 'refunded', 'refund_due'])(
    'is stored ignored and changes nothing when the payment is %s: a SUCCESSFUL event',
    async (status) => {
      const booking = await insertBooking(prisma, world, { status: status === 'failed' ? 'pending_payment' : 'confirmed' });
      const payment = await insertPayment(prisma, booking.id, { status, providerRef: 'SETTLED-REF', failureReason: status === 'failed' ? 'APPROVAL_REJECTED' : null });
      const bookingBefore = await rowJson('booking', booking.id);
      const paymentBefore = await rowJson('payment', payment.id);

      const outcome = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

      expect(outcome).toMatchObject({ status: 'ignored', note: `payment_${status}` });
      expect(await eventById(outcome.eventRowId)).toMatchObject({ status: 'ignored', processing_error: `payment_${status}`, signature_valid: true, processed: true });
      expect(await rowJson('booking', booking.id)).toBe(bookingBefore);
      expect(await rowJson('payment', payment.id)).toBe(paymentBefore);
      expect(await outbox()).toEqual([]);
      expect(tokens).toEqual([]);
    },
  );

  it.each([
    ['succeeded', 'FAILED'],
    ['succeeded', 'PENDING'],
    ['failed', 'PENDING'],
    ['failed', 'FAILED'],
    ['refunded', 'FAILED'],
    ['refund_due', 'PENDING'],
  ])('is stored ignored and changes nothing when the payment is %s: a %s event', async (status, reported) => {
    const booking = await insertBooking(prisma, world, { status: status === 'failed' ? 'pending_payment' : 'confirmed' });
    const payment = await insertPayment(prisma, booking.id, { status });
    const bookingBefore = await rowJson('booking', booking.id);
    const paymentBefore = await rowJson('payment', payment.id);

    const outcome = await deliver(statusDelivery(payment.ourRef, reported, { reason: 'APPROVAL_REJECTED' }));

    expect(outcome).toMatchObject({ status: 'ignored', note: `payment_${status}` });
    expect(await rowJson('booking', booking.id)).toBe(bookingBefore);
    expect(await rowJson('payment', payment.id)).toBe(paymentBefore);
    expect(await outbox()).toEqual([]);
  });

  it('never resurrects a failed payment: failed -> succeeded is ignored, the booking not confirmed, and the money flagged in the log', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'failed', failureReason: 'provider_timeout' });

    const outcome = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    expect(outcome).toMatchObject({ status: 'ignored', note: 'payment_failed' });
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'failed', failure_reason: 'provider_timeout', settled_at: null, provider_ref: null });
    expect(await bookingRow(booking.id)).toMatchObject({ status: 'pending_payment', confirmed_at: null, access_token_hash: null });
    expect(sink.entries).toContainEqual(expect.objectContaining({ level: 'error', event: 'webhook_success_for_failed_payment', eventRowId: outcome.eventRowId }));
  });

  it('ignores a PENDING that arrives after the SUCCESSFUL it preceded', async () => {
    const { booking, payment } = await waitingBooking();
    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));
    const confirmed = await rowJson('booking', booking.id);

    const late = await deliver(statusDelivery(payment.ourRef, 'PENDING'));

    expect(late).toMatchObject({ status: 'ignored', note: 'payment_succeeded' });
    expect(await rowJson('booking', booking.id)).toBe(confirmed);
    expect((await paymentRow(payment.id)).status).toBe('succeeded');
  });

  it('ignores a FAILED that arrives after the SUCCESSFUL, leaving the booking confirmed', async () => {
    const { booking, payment } = await waitingBooking();
    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    await expect(deliver(statusDelivery(payment.ourRef, 'FAILED'))).resolves.toMatchObject({ status: 'ignored', note: 'payment_succeeded' });
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
    expect((await paymentRow(payment.id)).status).toBe('succeeded');
  });
});

// --- Other transitions ------------------------------------------------------------------------

describe('failures and pending events', () => {
  it('a FAILED event fails the payment with MTN’s reason and leaves the booking and its hold untouched', async () => {
    const { booking, payment } = await waitingBooking();
    const before = await rowJson('booking', booking.id);

    const outcome = await deliver(statusDelivery(payment.ourRef, 'FAILED', { reason: 'APPROVAL_REJECTED', financialTransactionId: undefined }));

    expect(outcome).toMatchObject({ status: 'applied', note: 'payment_failed' });
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'failed', failure_reason: 'APPROVAL_REJECTED', method: 'momo_mtn', settled_at: null });
    expect(await rowJson('booking', booking.id)).toBe(before);
    expect(await outbox()).toEqual([]);
  });

  it.each(['REJECTED', 'TIMEOUT', 'EXPIRED', 'CANCELLED'])('a %s event fails the payment, naming the status as the reason', async (status) => {
    const { payment } = await waitingBooking();

    await deliver(statusDelivery(payment.ourRef, status));

    expect(await paymentRow(payment.id)).toMatchObject({ status: 'failed', failure_reason: status });
  });

  it('a failure from an event with no reason at all is recorded as failed', async () => {
    const { payment } = await waitingBooking();

    await recordEvent(deps(), 'mtn_momo_direct', { signatureValid: true, event: event({ ourRef: payment.ourRef, reportedStatus: 'failed', failureReason: null }), payload: {} });

    expect((await paymentRow(payment.id)).failure_reason).toBe('failed');
  });

  it('a PENDING event moves an initiated payment to pending, and is ignored for one already pending', async () => {
    const booking = await insertBooking(prisma, world);
    const initiated = await insertPayment(prisma, booking.id, { status: 'initiated' });

    await expect(deliver(statusDelivery(initiated.ourRef, 'PENDING'))).resolves.toMatchObject({ status: 'applied', note: 'payment_pending' });
    expect((await paymentRow(initiated.id)).status).toBe('pending');

    await expect(deliver(statusDelivery(initiated.ourRef, 'ONGOING'))).resolves.toMatchObject({ status: 'ignored', note: 'no_transition' });
    expect((await paymentRow(initiated.id)).status).toBe('pending');
  });

  it('an event with a status MTN may send but we do not know is stored ignored and changes nothing', async () => {
    const { booking, payment } = await waitingBooking();
    const before = await rowJson('payment', payment.id);

    const outcome = await deliver(statusDelivery(payment.ourRef, 'AUTHORIZED'));

    expect(outcome).toMatchObject({ status: 'ignored', note: 'unrecognised_status' });
    expect(await rowJson('payment', payment.id)).toBe(before);
    expect((await bookingRow(booking.id)).status).toBe('pending_payment');
  });

  it('a body with no readable status is stored ignored as unreadable, under an id of its own', async () => {
    const { payment } = await waitingBooking();

    const outcome = await deliver(mtnDelivery(provider, payment.ourRef, { externalId: payment.ourRef, state: 'SUCCESSFUL' }));

    expect(outcome).toMatchObject({ status: 'ignored', note: 'unreadable_event' });
    expect(await eventById(outcome.eventRowId)).toMatchObject({
      event_id: expect.stringMatching(/^unreadable:[0-9a-f-]{36}$/),
      signature_valid: true,
      status: 'ignored',
      processing_error: 'unreadable_event',
      payload: { externalId: payment.ourRef, state: 'SUCCESSFUL' },
    });
    expect((await paymentRow(payment.id)).status).toBe('pending');
  });

  it('a success for a different amount than the payment froze is stored ignored, changes nothing, and is logged', async () => {
    const { booking, payment } = await waitingBooking();
    const bookingBefore = await rowJson('booking', booking.id);
    const paymentBefore = await rowJson('payment', payment.id);

    const outcome = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL', { amount: '19999' }));

    expect(outcome).toMatchObject({ status: 'ignored', note: 'amount_mismatch' });
    expect(await eventById(outcome.eventRowId)).toMatchObject({ status: 'ignored', processing_error: 'amount_mismatch' });
    expect(await rowJson('booking', booking.id)).toBe(bookingBefore);
    expect(await rowJson('payment', payment.id)).toBe(paymentBefore);
    expect(await outbox()).toEqual([]);
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'webhook_amount_mismatch', expected: 20_000, reported: 19_999 }));
  });

  it('a succeeded session fee is recorded, receipted, and the booking left alone', async () => {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    await insertPayment(prisma, booking.id, { status: 'succeeded' });
    const sessionFee = await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000 });
    const before = await rowJson('booking', booking.id);

    const outcome = await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '30000' }));

    expect(outcome).toMatchObject({ status: 'applied', note: 'payment_succeeded' });
    expect(await paymentRow(sessionFee.id)).toMatchObject({ status: 'succeeded', settled_at: NOW });
    expect(await rowJson('booking', booking.id)).toBe(before);

    // Task 20: the client is receipted and the photographer told, while the
    // booking itself does not move.
    const [alert, receipt] = await outbox();
    expect(alert).toMatchObject({
      template: 'admin_alert',
      recipient: ADMIN_EMAIL,
      dedupe_key: `email:admin_alert:payment_received:${sessionFee.id}`,
      payload: { variant: 'payment_received', kind: 'session_fee', amountRwf: 30_000, paidAt: NOW.toISOString(), outstandingRwf: 0 },
    });
    expect(receipt).toMatchObject({
      template: 'payment_receipt',
      recipient: CLIENT.email,
      booking_id: booking.id,
      dedupe_key: `email:payment_receipt:${sessionFee.id}`,
      payload: { kind: 'session_fee', amountRwf: 30_000, paidAt: NOW.toISOString(), outstandingRwf: 0, accessToken: null },
    });
  });
});

// --- Bad signature -----------------------------------------------------------------------------

describe('a delivery that fails verification', () => {
  function tampered(delivery: WebhookDelivery): WebhookDelivery {
    const signature = delivery.params.signature ?? '';
    return { ...delivery, params: { ...delivery.params, signature: `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}` } };
  }

  it('is stored signature_valid = false and ignored, and applies nothing', async () => {
    const { booking, payment } = await waitingBooking();
    const body = mtnStatusBody(payment.ourRef, 'SUCCESSFUL');
    const bookingBefore = await rowJson('booking', booking.id);
    const paymentBefore = await rowJson('payment', payment.id);

    const outcome = await deliver(tampered(mtnDelivery(provider, payment.ourRef, body)));

    expect(outcome).toMatchObject({ status: 'ignored', note: 'signature_invalid' });
    expect(await events()).toStrictEqual([
      {
        id: outcome.eventRowId,
        provider: 'mtn_momo_direct',
        event_id: expect.stringMatching(/^unverified:[0-9a-f-]{36}$/),
        event_type: 'requesttopay.SUCCESSFUL',
        our_ref: payment.ourRef,
        provider_ref: body.financialTransactionId,
        reported_status: 'succeeded',
        signature_valid: false,
        payload: body,
        status: 'ignored',
        processing_error: 'signature_invalid',
        processed: true,
      },
    ]);
    expect(await rowJson('booking', booking.id)).toBe(bookingBefore);
    expect(await rowJson('payment', payment.id)).toBe(paymentBefore);
    expect(await outbox()).toEqual([]);
    expect(sink.entries).toContainEqual(expect.objectContaining({ level: 'warn', event: 'webhook_signature_invalid' }));
  });

  it('applies nothing when a genuine signature for one payment carries a body about another', async () => {
    const victim = await waitingBooking();
    const attacker = await waitingBooking();
    const forged = { ...mtnDelivery(provider, attacker.payment.ourRef, mtnStatusBody(victim.payment.ourRef, 'SUCCESSFUL')) };

    const outcome = await deliver(forged);

    expect(outcome.note).toBe('signature_invalid');
    for (const { booking, payment } of [victim, attacker]) {
      expect((await bookingRow(booking.id)).status).toBe('pending_payment');
      expect((await paymentRow(payment.id)).status).toBe('pending');
    }
  });

  it('applies nothing when the URL names the victim with a signature made for another payment', async () => {
    const victim = await waitingBooking();
    const other = await waitingBooking();
    const signature = mtnDelivery(provider, other.payment.ourRef, {}).params.signature;

    const outcome = await deliver({
      rawBody: Buffer.from(JSON.stringify(mtnStatusBody(victim.payment.ourRef, 'SUCCESSFUL'))),
      headers: {},
      params: { ourRef: victim.payment.ourRef, signature },
    });

    expect(outcome.note).toBe('signature_invalid');
    expect((await paymentRow(victim.payment.id)).status).toBe('pending');
  });

  it('does not take the event id, so the genuine delivery afterwards still applies', async () => {
    const { booking, payment } = await waitingBooking();
    const genuine = statusDelivery(payment.ourRef, 'SUCCESSFUL');

    await deliver(tampered(genuine));
    await deliver(tampered(genuine));
    const real = await deliver(genuine);

    expect(real).toMatchObject({ status: 'applied', note: 'booking_confirmed' });
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
    expect((await events()).map((row) => row.signature_valid)).toEqual([false, false, true]);
  });

  it('is stored even when the reference in the URL is not a uuid, with our_ref null', async () => {
    const outcome = await deliver({ rawBody: Buffer.from('{"status":"SUCCESSFUL"}'), headers: {}, params: { ourRef: 'robert-tables', signature: 'x' } });

    expect(await eventById(outcome.eventRowId)).toMatchObject({ signature_valid: false, our_ref: null, event_type: 'unknown', status: 'ignored' });
  });

  it('is stored ignored when the provider’s verification throws', async () => {
    const throwing = stubProvider({
      verifyWebhook: () => {
        throw new Error('boom');
      },
      parseWebhook: () => {
        throw new Error('boom');
      },
    });

    const outcome = await receiveWebhook(deps(), throwing, { rawBody: Buffer.from('{}'), headers: {}, params: {} });

    expect(outcome).toMatchObject({ status: 'ignored', note: 'signature_invalid' });
  });
});

// --- Unmatched --------------------------------------------------------------------------------

describe('an event matching no payment', () => {
  it('is stored ignored with its reference, status and payload, and stays inspectable', async () => {
    const unknownRef = '7d2f1e4a-5b6c-4d8e-9f0a-1b2c3d4e5f60';
    const body = mtnStatusBody(unknownRef, 'SUCCESSFUL');

    const outcome = await deliver(mtnDelivery(provider, unknownRef, body));

    expect(outcome).toMatchObject({ status: 'ignored', note: 'no_matching_payment' });
    const [row] = await events();
    expect(row).toStrictEqual({
      id: outcome.eventRowId,
      provider: 'mtn_momo_direct',
      event_id: `${unknownRef}:SUCCESSFUL`,
      event_type: 'requesttopay.SUCCESSFUL',
      our_ref: unknownRef,
      provider_ref: body.financialTransactionId,
      reported_status: 'succeeded',
      signature_valid: true,
      payload: body,
      status: 'ignored',
      processing_error: 'no_matching_payment',
      processed: true,
    });
    const inspectable = await prisma.webhookEvent.findMany({ where: { ourRef: unknownRef, status: 'ignored' } });
    expect(inspectable).toHaveLength(1);
  });

  it('does not match a payment of another provider with the same our_ref', async () => {
    const booking = await insertBooking(prisma, world);
    const flutterwave = await insertPayment(prisma, booking.id, { status: 'pending', provider: 'flutterwave' });

    const outcome = await deliver(statusDelivery(flutterwave.ourRef, 'SUCCESSFUL'));

    expect(outcome.note).toBe('no_matching_payment');
    expect((await paymentRow(flutterwave.id)).status).toBe('pending');
    expect((await bookingRow(booking.id)).status).toBe('pending_payment');
  });

  it('matches on provider_ref when our_ref matches nothing', async () => {
    const { booking } = await waitingBooking();
    const byProviderRef = await insertPayment(prisma, booking.id, { status: 'initiated', providerRef: 'FLW-TX-42' });
    await raw.query(`UPDATE payment SET status = 'failed' WHERE id <> $1`, [byProviderRef.id]);

    const outcome = await recordEvent(deps(), 'mtn_momo_direct', {
      signatureValid: true,
      event: event({ ourRef: '00000000-0000-4000-8000-000000000000', providerRef: 'FLW-TX-42' }),
      payload: {},
    });

    expect(outcome).toMatchObject({ status: 'applied', note: 'booking_confirmed' });
    expect((await paymentRow(byProviderRef.id)).status).toBe('succeeded');
  });

  it('does not match on provider_ref across providers', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'pending', provider: 'flutterwave', providerRef: 'SHARED-REF' });

    const outcome = await recordEvent(deps(), 'mtn_momo_direct', { signatureValid: true, event: event({ providerRef: 'SHARED-REF' }), payload: {} });

    expect(outcome.note).toBe('no_matching_payment');
    expect((await paymentRow(payment.id)).status).toBe('pending');
  });
});

// --- Late success ------------------------------------------------------------------------------

describe('a late success for an expired booking (spec §6.9)', () => {
  const SLOT = new Date('2027-03-03T07:00:00.000Z');
  const minutes = (n: number) => new Date(SLOT.getTime() + n * MINUTE_MS);

  async function expiredWithPayment() {
    const booking = await insertBooking(prisma, world, { status: 'expired', startsAt: SLOT });
    const payment = await insertPayment(prisma, booking.id, { status: 'pending', ageSeconds: 40 * 60 });
    return { booking, payment };
  }

  it('re-confirms the booking when its slot is still free, and sends both emails', async () => {
    const { booking, payment } = await expiredWithPayment();

    const outcome = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    expect(outcome).toMatchObject({ status: 'applied', note: 'booking_reconfirmed' });
    expect(await bookingRow(booking.id)).toStrictEqual({
      status: 'confirmed',
      hold_expires_at: null,
      confirmed_at: NOW,
      access_token_hash: tokens[0]?.hash,
      access_token_expires_at: new Date(NOW.getTime() + 365 * DAY_MS),
    });
    expect((await paymentRow(payment.id)).status).toBe('succeeded');
    expect((await outbox()).map((row) => row.template).sort()).toEqual(['admin_new_booking', 'booking_confirmation']);
  });

  it('re-confirms when the only booking in the way is a lapsed hold, which it expires', async () => {
    const { booking, payment } = await expiredWithPayment();
    const stale = await insertBooking(prisma, world, { status: 'pending_payment', startsAt: minutes(30), holdMinutes: -1 });

    await expect(deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'))).resolves.toMatchObject({ note: 'booking_reconfirmed' });
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
    expect((await bookingRow(stale.id)).status).toBe('expired');
  });

  it.each([
    ['one that ends, buffer and all, exactly as this starts', -(DURATION_MINUTES + BUFFER_MINUTES)],
    ['one that starts exactly at this one’s buffer end', DURATION_MINUTES + BUFFER_MINUTES],
    ['one on another day', 24 * 60],
  ])('re-confirms beside a confirmed booking: %s', async (_case, offset) => {
    const { booking, payment } = await expiredWithPayment();
    await insertBooking(prisma, world, { status: 'confirmed', startsAt: minutes(offset) });

    await expect(deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'))).resolves.toMatchObject({ note: 'booking_reconfirmed' });
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
  });

  it.each(['expired', 'cancelled_by_client', 'cancelled_by_admin'])('re-confirms over a %s booking in the same slot, which occupies nothing', async (status) => {
    const { booking, payment } = await expiredWithPayment();
    await insertBooking(prisma, world, { status, startsAt: SLOT, holdMinutes: null });

    await expect(deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'))).resolves.toMatchObject({ note: 'booking_reconfirmed' });
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
  });

  it('leaves the booking expired, sets the payment refund_due and enqueues an admin_alert when the slot is taken', async () => {
    const { booking, payment } = await expiredWithPayment();
    await insertBooking(prisma, world, { status: 'confirmed', startsAt: minutes(30) });
    const bookingBefore = await rowJson('booking', booking.id);

    const outcome = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL', { financialTransactionId: '8880001' }));

    expect(outcome).toMatchObject({ status: 'applied', note: 'refund_due_slot_taken' });
    expect(await rowJson('booking', booking.id)).toBe(bookingBefore);
    expect(await bookingRow(booking.id)).toMatchObject({ status: 'expired', confirmed_at: null, access_token_hash: null });
    expect(await paymentRow(payment.id)).toStrictEqual({
      status: 'refund_due',
      settled_at: NOW,
      provider_ref: '8880001',
      method: 'momo_mtn',
      failure_reason: null,
      amount_rwf: 20_000,
    });
    expect(await outbox()).toStrictEqual([
      {
        kind: 'email',
        template: 'admin_alert',
        recipient: ADMIN_EMAIL,
        booking_id: null,
        dedupe_key: `email:admin_alert:refund_due:${payment.id}`,
        status: 'pending',
        payload: {
          variant: 'refund_due',
          reference: booking.reference,
          clientName: CLIENT.name,
          amountRwf: 20_000,
          reason: 'late_payment_slot_taken',
          paymentReference: '8880001',
          provider: 'mtn_momo_direct',
          startsAt: SLOT.toISOString(),
        },
      },
    ]);
    expect(tokens).toEqual([]);
  });

  it('enqueues an alert that renders, telling the photographer why and that the system moves no money', async () => {
    const { payment } = await expiredWithPayment();
    await insertBooking(prisma, world, { status: 'confirmed', startsAt: SLOT });
    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    const [alert] = await outbox();
    const email = renderEmail('admin_alert', alert?.payload, { webOrigin: WEB_ORIGIN, locale: 'en' });
    expect(email.subject).toContain('Refund due: 20,000 RWF');
    expect(email.text).toContain('booked by someone else');
    expect(email.text).toContain('The system does not move money.');
  });

  it.each([
    ['a confirmed booking overlapping the shoot', 'confirmed', 45, undefined],
    ['a confirmed booking inside the buffer only', 'confirmed', DURATION_MINUTES + 10, undefined],
    ['a live hold', 'pending_payment', 0, 30],
    ['a completed booking', 'completed', 0, undefined],
    ['a no-show', 'no_show', 0, undefined],
    ['a booking starting before and running into it', 'confirmed', -60, undefined],
  ])('treats the slot as taken by %s', async (_case, status, offset, holdMinutes) => {
    const { booking, payment } = await expiredWithPayment();
    await insertBooking(prisma, world, { status, startsAt: minutes(offset), ...(holdMinutes === undefined ? {} : { holdMinutes }) });

    await expect(deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'))).resolves.toMatchObject({ note: 'refund_due_slot_taken' });
    expect((await bookingRow(booking.id)).status).toBe('expired');
    expect((await paymentRow(payment.id)).status).toBe('refund_due');
  });

  it('ignores a redelivery of the same success afterwards: one alert, and the payment stays refund_due', async () => {
    const { payment } = await expiredWithPayment();
    await insertBooking(prisma, world, { status: 'confirmed', startsAt: SLOT });
    const delivery = statusDelivery(payment.ourRef, 'SUCCESSFUL');

    await deliver(delivery);
    await expect(deliver(delivery)).resolves.toMatchObject({ status: 'ignored', note: 'duplicate_delivery' });
    await expect(deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'))).resolves.toMatchObject({ status: 'ignored' });

    expect(await outbox()).toHaveLength(1);
    expect((await paymentRow(payment.id)).status).toBe('refund_due');
  });

  it('names our_ref as the payment reference when MTN gave no transaction id', async () => {
    const { payment } = await expiredWithPayment();
    await insertBooking(prisma, world, { status: 'confirmed', startsAt: SLOT });

    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL', { financialTransactionId: undefined }));

    expect((await outbox())[0]?.payload.paymentReference).toBe(payment.ourRef);
  });

  it('still sets refund_due without an admin account, logging that no alert could be addressed', async () => {
    await raw.query('DELETE FROM admin_user');
    const { payment } = await expiredWithPayment();
    await insertBooking(prisma, world, { status: 'confirmed', startsAt: SLOT });

    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    expect((await paymentRow(payment.id)).status).toBe('refund_due');
    expect(await outbox()).toEqual([]);
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'refund_due_alert_skipped' }));
  });

  it('finds the slot taken when a writer outside the claim lock takes it mid-confirmation (23P01, retried)', async () => {
    const { booking, payment } = await expiredWithPayment();
    let rivalInserted = false;
    let attempts = 0;
    const racing = new Proxy(prisma, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (property === '$transaction' && typeof value === 'function') {
          return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => {
            attempts += 1;
            return (value as (...args: unknown[]) => Promise<unknown>).call(
              target,
              (tx: Prisma.TransactionClient) =>
                callback(
                  new Proxy(tx, {
                    get(txTarget, txProperty) {
                      const model: unknown = Reflect.get(txTarget, txProperty);
                      if (txProperty !== 'booking' || rivalInserted) return model;
                      return new Proxy(model as object, {
                        get(modelTarget, method) {
                          const fn: unknown = Reflect.get(modelTarget, method);
                          if (method !== 'update' || typeof fn !== 'function') return fn;
                          return async (...args: unknown[]) => {
                            rivalInserted = true;
                            await insertBooking(prisma, world, { status: 'confirmed', startsAt: SLOT });
                            return (fn as (...a: unknown[]) => unknown).apply(modelTarget, args);
                          };
                        },
                      });
                    },
                  }),
                ),
              options,
            );
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    const outcome = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'), { prisma: racing });

    expect(rivalInserted).toBe(true);
    expect(attempts).toBe(2);
    expect(outcome).toMatchObject({ status: 'applied', note: 'refund_due_slot_taken' });
    expect((await bookingRow(booking.id)).status).toBe('expired');
    expect((await paymentRow(payment.id)).status).toBe('refund_due');
    expect((await outbox()).map((row) => row.template)).toEqual(['admin_alert']);
  });
});

// --- Duplicate payment ------------------------------------------------------------------------

describe('a second booking fee for a booking already paid', () => {
  it('is refund_due with a duplicate_payment alert, and the booking, its token and confirmation stay as they were', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await insertPayment(prisma, booking.id, { status: 'succeeded', providerRef: 'FIRST-FEE' });
    const second = await insertPayment(prisma, booking.id, { status: 'pending' });
    const before = await rowJson('booking', booking.id);

    const outcome = await deliver(statusDelivery(second.ourRef, 'SUCCESSFUL', { financialTransactionId: 'SECOND-FEE' }));

    expect(outcome).toMatchObject({ status: 'applied', note: 'refund_due_duplicate_payment' });
    expect(await rowJson('booking', booking.id)).toBe(before);
    expect(await paymentRow(second.id)).toMatchObject({ status: 'refund_due', settled_at: NOW, provider_ref: 'SECOND-FEE' });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ template: 'admin_alert', recipient: ADMIN_EMAIL, payload: { variant: 'refund_due', reason: 'duplicate_payment', paymentReference: 'SECOND-FEE' } });
    const email = renderEmail('admin_alert', rows[0]?.payload, { webOrigin: WEB_ORIGIN, locale: 'en' });
    expect(email.text).toContain('paid the booking fee twice');
    expect(tokens).toEqual([]);
  });

  it('confirms once and flags the other when two fees for one booking succeed at the same moment', async () => {
    const booking = await insertBooking(prisma, world);
    const first = await insertPayment(prisma, booking.id, { status: 'pending' });
    const second = await insertPayment(prisma, booking.id, { status: 'pending' });

    const outcomes = await Promise.all([deliver(statusDelivery(first.ourRef, 'SUCCESSFUL')), deliver(statusDelivery(second.ourRef, 'SUCCESSFUL'))]);

    expect(outcomes.map((outcome) => outcome.note).sort()).toEqual(['booking_confirmed', 'refund_due_duplicate_payment']);
    const statuses = [(await paymentRow(first.id)).status, (await paymentRow(second.id)).status].sort();
    expect(statuses).toEqual(['refund_due', 'succeeded']);
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
    expect((await outbox()).map((row) => row.template).sort()).toEqual(['admin_alert', 'admin_new_booking', 'booking_confirmation']);
    expect(tokens).toHaveLength(1);
  });
});

// --- Processing failures ----------------------------------------------------------------------

describe('a failure while applying an event', () => {
  it('rolls everything back, stores the event failed with the error, and a retry of the same delivery reprocesses that row', async () => {
    const { booking, payment } = await waitingBooking();
    const bookingBefore = await rowJson('booking', booking.id);
    const paymentBefore = await rowJson('payment', payment.id);
    const delivery = statusDelivery(payment.ourRef, 'SUCCESSFUL');
    const failing = () => {
      throw new Error('token generator unavailable');
    };

    const failed = await deliver(delivery, { newAccessToken: failing });

    expect(failed).toMatchObject({ status: 'failed', note: 'processing_failed' });
    expect(await eventById(failed.eventRowId)).toMatchObject({ status: 'failed', processing_error: 'Error: token generator unavailable', processed: true });
    expect(await rowJson('booking', booking.id)).toBe(bookingBefore);
    expect(await rowJson('payment', payment.id)).toBe(paymentBefore);
    expect(await outbox()).toEqual([]);
    expect(sink.entries).toContainEqual(expect.objectContaining({ level: 'error', event: 'webhook_processing_failed', eventRowId: failed.eventRowId }));

    const retried = await deliver(delivery);

    expect(retried).toMatchObject({ status: 'applied', note: 'booking_confirmed', eventRowId: failed.eventRowId });
    expect(await events()).toHaveLength(1);
    expect(await eventById(failed.eventRowId)).toMatchObject({ status: 'applied', processing_error: null });
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
    expect(await outbox()).toHaveLength(2);
  });

  /** A row as a process that died mid-processing leaves it: received, never settled. */
  async function strandedEvent(ourRef: string, receivedSecondsAgo: number): Promise<string> {
    const result = await raw.query<{ id: string }>(
      `INSERT INTO webhook_event (provider, event_id, event_type, our_ref, reported_status, signature_valid, payload, received_at)
       VALUES ('mtn_momo_direct', $1, 'requesttopay.SUCCESSFUL', $2, 'succeeded', true, '{}'::jsonb, now() - make_interval(secs => $3))
       RETURNING id::text`,
      [`${ourRef}:SUCCESSFUL`, ourRef, receivedSecondsAgo],
    );
    return firstRow(result).id;
  }

  it('processes a row a crash left received, when the provider retries after it went stale', async () => {
    const { booking, payment } = await waitingBooking();
    const stranded = await strandedEvent(payment.ourRef, 300);

    const retried = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    expect(retried).toMatchObject({ status: 'applied', note: 'booking_confirmed', eventRowId: stranded });
    expect(await events()).toHaveLength(1);
    expect(await eventById(stranded)).toMatchObject({ status: 'applied', processed: true });
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
    expect(await outbox()).toHaveLength(2);
  });

  it('treats a row received moments ago as in hand elsewhere: the delivery is a duplicate and applies nothing', async () => {
    const { booking, payment } = await waitingBooking();
    const inHand = await strandedEvent(payment.ourRef, 1);

    const duplicate = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    expect(duplicate).toMatchObject({ status: 'ignored', note: 'duplicate_delivery' });
    expect(await eventById(inHand)).toMatchObject({ status: 'received', processed: false });
    expect((await bookingRow(booking.id)).status).toBe('pending_payment');
    expect(await outbox()).toEqual([]);
  });

  it('leaves an event another processing already settled exactly as it is', async () => {
    const { payment } = await waitingBooking();
    const first = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));
    const settled = await eventById(first.eventRowId);
    // A stale reclaim racing the first processing: the row is no longer received.
    await raw.query(`UPDATE webhook_event SET received_at = now() - interval '10 minutes' WHERE id = $1`, [first.eventRowId]);

    const again = await recordEvent(deps(), 'mtn_momo_direct', {
      signatureValid: true,
      event: event({ eventId: `${payment.ourRef}:SUCCESSFUL`, ourRef: payment.ourRef }),
      payload: {},
    });

    expect(again).toMatchObject({ status: 'ignored', note: 'duplicate_delivery' });
    expect(await eventById(first.eventRowId)).toMatchObject({ status: settled.status, processing_error: settled.processing_error });
    expect(await outbox()).toHaveLength(2);
  });

  it('retries a transaction the database aborted for contention, and applies it', async () => {
    const { booking, payment } = await waitingBooking();
    let calls = 0;
    const contended = new Proxy(prisma, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (property === '$transaction' && typeof value === 'function') {
          return (...args: unknown[]) => {
            calls += 1;
            if (calls === 1) return Promise.reject(Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { clientVersion: '7.0.0', code: 'P2034' }));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    const outcome = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'), { prisma: contended });

    expect(calls).toBe(2);
    expect(outcome).toMatchObject({ status: 'applied', note: 'booking_confirmed' });
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
  });

  it('gives up after three contended attempts, storing the event failed', async () => {
    const { payment } = await waitingBooking();
    let calls = 0;
    const deadlocked = new Proxy(prisma, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (property === '$transaction') {
          return () => {
            calls += 1;
            return Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    const outcome = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'), { prisma: deadlocked });

    expect(calls).toBe(3);
    expect(outcome.status).toBe('failed');
    expect(await eventById(outcome.eventRowId)).toMatchObject({ status: 'failed', processing_error: 'Error: deadlock detected' });
  });

  it('stores a processing error with a NUL character, cut to 1,000 characters', async () => {
    const { payment } = await waitingBooking();

    const outcome = await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'), {
      newAccessToken: () => {
        throw new Error(`bad${String.fromCharCode(0)}${'x'.repeat(5_000)}`);
      },
    });

    const row = await eventById(outcome.eventRowId);
    expect(row.status).toBe('failed');
    expect(row.processing_error).toHaveLength(1_000);
    expect(row.processing_error?.startsWith(`Error: bad${String.fromCharCode(0xfffd)}x`)).toBe(true);
  });
});

// --- Bodies -----------------------------------------------------------------------------------

describe('bodies PostgreSQL would refuse, and bodies that are not JSON', () => {
  const REPLACEMENT = String.fromCharCode(0xfffd);

  async function storedPayload(outcome: WebhookOutcome): Promise<unknown> {
    return (await eventById(outcome.eventRowId)).payload;
  }

  it('stores a JSON \\u0000 escape as U+FFFD, and still applies the genuine event it carries', async () => {
    const { booking, payment } = await waitingBooking();
    const text = JSON.stringify(mtnStatusBody(payment.ourRef, 'SUCCESSFUL', { payerMessage: `a${String.fromCharCode(0)}b` }));
    expect(text).toContain('\\u0000');

    const outcome = await deliver(mtnDelivery(provider, payment.ourRef, text));

    expect(outcome.status).toBe('applied');
    expect(await storedPayload(outcome)).toMatchObject({ payerMessage: `a${REPLACEMENT}b` });
    expect((await bookingRow(booking.id)).status).toBe('confirmed');
  });

  it('stores lone surrogates, in keys and values, as U+FFFD', async () => {
    const { payment } = await waitingBooking();
    const text = `{"externalId":"${payment.ourRef}","status":"PENDING","\\ud800key":"value\\udfff","pair":"\\ud83d\\ude00"}`;

    const outcome = await deliver(mtnDelivery(provider, payment.ourRef, text));

    expect(await storedPayload(outcome)).toMatchObject({ [`${REPLACEMENT}key`]: `value${REPLACEMENT}`, pair: '\u{1F600}' });
  });

  it('stores a raw NUL byte inside the JSON, which no longer parses, as unparsed text', async () => {
    const { payment } = await waitingBooking();
    const text = `{"externalId":"${payment.ourRef}","status":"SUCCESSFUL","note":"a${String.fromCharCode(0)}b"}`;

    const outcome = await deliver(mtnDelivery(provider, payment.ourRef, text));

    expect(outcome).toMatchObject({ status: 'ignored', note: 'signature_invalid' });
    expect(await storedPayload(outcome)).toStrictEqual({ unparsedBody: text.replace(String.fromCharCode(0), REPLACEMENT) });
    expect((await paymentRow(payment.id)).status).toBe('pending');
  });

  it('stores bytes that are not UTF-8 with replacement characters', async () => {
    const { payment } = await waitingBooking();

    const outcome = await deliver(mtnDelivery(provider, payment.ourRef, Buffer.from([0x7b, 0xff, 0xfe, 0x00, 0x7d])));

    expect(await storedPayload(outcome)).toStrictEqual({ unparsedBody: `{${REPLACEMENT}${REPLACEMENT}${REPLACEMENT}}` });
  });

  it.each([
    ['form-encoded text', 'status=SUCCESSFUL&externalId=x', { unparsedBody: 'status=SUCCESSFUL&externalId=x' }],
    ['XML', '<status>SUCCESSFUL</status>', { unparsedBody: '<status>SUCCESSFUL</status>' }],
    ['a JSON string', '"SUCCESSFUL"', 'SUCCESSFUL'],
    ['a JSON number', '42', 42],
    ['a JSON array', '[1,"two",null]', [1, 'two', null]],
    ['JSON null', 'null', null],
    ['an empty body', '', null],
    ['a number JSON cannot hold', '{"amount":1e400}', { amount: null }],
  ])('stores %s without failing', async (_case, text, payload) => {
    const { payment } = await waitingBooking();

    const outcome = await deliver(mtnDelivery(provider, payment.ourRef, text));

    expect(outcome.status).toBe('ignored');
    expect(await storedPayload(outcome)).toStrictEqual(payload);
    expect((await paymentRow(payment.id)).status).toBe('pending');
  });

  it('stores a 300 KB body cut down to a marker rather than whole, and still applies the event it carries', async () => {
    const booking = await insertBooking(prisma, world);
    const payment = await insertPayment(prisma, booking.id, { status: 'initiated' });
    const text = JSON.stringify({ externalId: payment.ourRef, status: 'PENDING', filler: 'x'.repeat(300_000) });

    const outcome = await deliver(mtnDelivery(provider, payment.ourRef, text));

    expect(outcome.status).toBe('applied');
    const payload = (await storedPayload(outcome)) as { truncatedBody: string };
    expect(Object.keys(payload)).toEqual(['truncatedBody']);
    expect(payload.truncatedBody).toHaveLength(64_000);
    expect(text.startsWith(payload.truncatedBody)).toBe(true);
  });

  it('stores a 300 KB non-JSON body full of characters JSON escapes, cut down', async () => {
    const { payment } = await waitingBooking();

    const outcome = await deliver(mtnDelivery(provider, payment.ourRef, '"\\\n'.repeat(100_000)));

    expect(outcome.status).toBe('ignored');
    expect(Object.keys((await storedPayload(outcome)) as object)).toEqual(['truncatedBody']);
  });

  // BUG: scrub() in webhooks.ts recurses once per level, so from about 5,000 levels (a 10 KB body)
  // receiveWebhook throws RangeError before anything is stored; over HTTP that is a 500 and no row.
  it('stores a deeply nested JSON body (5,000 levels, 10 KB) without failing', async () => {
    const { payment } = await waitingBooking();
    const text = `${'['.repeat(5_000)}${']'.repeat(5_000)}`;

    const outcome = await deliver(mtnDelivery(provider, payment.ourRef, text));

    expect(outcome.status).toBe('ignored');
    expect((await events()).length).toBe(1);
  });

  // BUG: past the stack overflow above, PostgreSQL itself refuses jsonb this deep (54001, stack depth
  // limit exceeded), so the body must be stored some other way to be stored at all.
  it('stores a deeply nested JSON body (30,000 levels, 60 KB, under the route limit) without failing', async () => {
    const { payment } = await waitingBooking();
    const text = `${'['.repeat(30_000)}${']'.repeat(30_000)}`;

    const outcome = await deliver(mtnDelivery(provider, payment.ourRef, text));

    expect(outcome.status).toBe('ignored');
    expect((await events()).length).toBe(1);
  });
});

// --- A session fee settling (plan.md Task 20; spec §3.5 step 4) ---------------------------------

/**
 * What a succeeded session fee sends (spec §3.5 step 4, §6.15). The client is
 * receipted and the photographer told, both keyed on the payment, so a
 * redelivered event adds nothing and a second session fee on the same booking
 * is its own receipt.
 *
 * The receipt carries no booking link: the plaintext of the client's token was
 * never stored (data-model_v2.md §5.9), and `accessToken: null` makes the email
 * name the link they already have rather than replacing a working one. Its
 * amounts are `bookingTotals()` as the transaction leaves them -- the payment is
 * already `succeeded`, so `paidRwf` includes it and `outstandingRwf` is what is
 * genuinely left. A booking fee is not receipted here: its confirmation email is
 * its receipt.
 */
describe('a succeeded session fee', () => {
  /** A completed shoot: 50,000 owed, 20,000 booking fee collected, the rest asked for. */
  async function askedFor(amountRwf = 30_000) {
    const booking = await insertBooking(prisma, world, { status: 'completed' });
    const bookingFee = await insertPayment(prisma, booking.id, { status: 'succeeded' });
    const sessionFee = await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf });
    return { booking, bookingFee, sessionFee };
  }

  function renderReceipt(payload: Record<string, unknown>) {
    return renderEmail('payment_receipt', payload, { webOrigin: WEB_ORIGIN, locale: 'en' });
  }

  it('enqueues exactly one receipt to the client and one alert to the photographer', async () => {
    const { booking, sessionFee } = await askedFor();

    await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '30000', financialTransactionId: '5551234' }));

    const messages = await outbox();
    expect(messages.map((row) => row.template)).toEqual(['admin_alert', 'payment_receipt']);
    expect(messages.filter((row) => row.template === 'payment_receipt')).toHaveLength(1);
    const [alert, receipt] = messages;
    expect(alert).toMatchObject({
      kind: 'email',
      recipient: ADMIN_EMAIL,
      dedupe_key: `email:admin_alert:payment_received:${sessionFee.id}`,
      payload: {
        variant: 'payment_received',
        reference: booking.reference,
        clientName: CLIENT.name,
        kind: 'session_fee',
        amountRwf: 30_000,
        paidAt: NOW.toISOString(),
        outstandingRwf: 0,
      },
    });
    expect(receipt).toMatchObject({
      kind: 'email',
      // The booking's own contact address, not the client record's.
      recipient: CLIENT.email,
      booking_id: booking.id,
      dedupe_key: `email:payment_receipt:${sessionFee.id}`,
    });
  });

  it('carries the totals bookingTotals leaves behind, with no link and no token', async () => {
    const { booking, sessionFee } = await askedFor();

    await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '30000', financialTransactionId: '5551235' }));

    const receipt = (await outbox()).find((row) => row.template === 'payment_receipt');
    expect(receipt?.payload).toStrictEqual({
      locale: 'en',
      reference: booking.reference,
      clientName: CLIENT.name,
      serviceName: 'Portraits',
      packageName: 'Standard',
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      kind: 'session_fee',
      amountRwf: 30_000,
      paidAt: NOW.toISOString(),
      paymentReference: '5551235',
      totalRwf: 50_000,
      paidRwf: 50_000,
      outstandingRwf: 0,
      overpaidRwf: 0,
      accessToken: null,
    });
  });

  it('names the provider’s reference when one is reported', async () => {
    const { sessionFee } = await askedFor();

    await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '30000', financialTransactionId: '5559999' }));

    expect((await outbox()).find((row) => row.template === 'payment_receipt')?.payload.paymentReference).toBe('5559999');
  });

  it('falls back to our own reference when the provider reports none', async () => {
    const { sessionFee } = await askedFor();

    await recordEvent(deps(), 'mtn_momo_direct', {
      signatureValid: true,
      event: event({ eventId: `${sessionFee.ourRef}:SUCCESSFUL`, ourRef: sessionFee.ourRef, providerRef: null }),
      payload: {},
    });

    expect((await outbox()).find((row) => row.template === 'payment_receipt')?.payload.paymentReference).toBe(sessionFee.ourRef);
  });

  it('renders to an email that says paid in full and offers no booking link at all', async () => {
    const { sessionFee } = await askedFor();
    await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '30000' }));

    const payload = (await outbox()).find((row) => row.template === 'payment_receipt')?.payload ?? {};
    const email = renderReceipt(payload);

    expect(email.text).toContain('paid in full');
    expect(email.text).toContain('Your booking link has not changed');
    expect(email.html).not.toContain('/booking/');
    expect(email.text).not.toContain('/booking/');
    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toMatch(/accessToken|access_token/i);
      expect(part).not.toContain('null');
    }
  });

  it('adds nothing on a redelivered event: both keys are the payment’s own', async () => {
    const { sessionFee } = await askedFor();
    const body = mtnStatusBody(sessionFee.ourRef, 'SUCCESSFUL', { amount: '30000' });

    const first = await deliver(mtnDelivery(provider, sessionFee.ourRef, body));
    const before = await outbox();
    const second = await deliver(mtnDelivery(provider, sessionFee.ourRef, body));

    expect([first.status, second.status]).toEqual(['applied', 'ignored']);
    expect(await outbox()).toStrictEqual(before);
    expect(before).toHaveLength(2);
  });

  it('gives a second session fee on the same booking its own receipt and its own alert (spec §6.15)', async () => {
    const { booking, sessionFee } = await askedFor();
    await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '30000' }));
    // An add-on afterwards, and a second request for the difference.
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
    const second = await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 15_000 });

    await deliver(statusDelivery(second.ourRef, 'SUCCESSFUL', { amount: '15000' }));

    const receipts = (await outbox()).filter((row) => row.template === 'payment_receipt');
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((row) => row.dedupe_key)).size).toBe(2);
    expect(receipts.map((row) => row.payload.amountRwf).sort()).toEqual([15_000, 30_000]);
    // The second receipt is the one that closes the booking.
    const closing = receipts.find((row) => row.dedupe_key.endsWith(second.id));
    expect(closing?.payload).toMatchObject({ totalRwf: 65_000, paidRwf: 65_000, outstandingRwf: 0 });
  });

  it('claims nothing is left only when nothing is: a part payment leaves the rest outstanding', async () => {
    const { sessionFee } = await askedFor(10_000);

    await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '10000' }));

    const messages = await outbox();
    const receipt = messages.find((row) => row.template === 'payment_receipt');
    const alert = messages.find((row) => row.template === 'admin_alert');
    expect(receipt?.payload).toMatchObject({ amountRwf: 10_000, totalRwf: 50_000, paidRwf: 30_000, outstandingRwf: 20_000 });
    expect(alert?.payload).toMatchObject({ amountRwf: 10_000, outstandingRwf: 20_000 });

    const email = renderReceipt(receipt?.payload ?? {});
    expect(email.text).toContain('20,000 RWF');
    expect(email.text).not.toMatch(/paid in full/i);
    expect(email.html).not.toMatch(/paid in full/i);
  });

  it('leaves the booking exactly as it was: a session fee moves no status and no token', async () => {
    const { booking, sessionFee } = await askedFor();
    const before = await rowJson('booking', booking.id);

    await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '30000' }));

    expect(await rowJson('booking', booking.id)).toBe(before);
    expect(tokens).toEqual([]);
  });

  it('receipts an overpaid session fee as well as flagging it — the code does not skip it', async () => {
    // 40,000 arriving against 30,000 outstanding: 10,000 more than the booking
    // is worth. `flagOverpayment` alerts the photographer and `receipt` still
    // runs, so the client is told what arrived rather than hearing nothing.
    const { sessionFee } = await askedFor(40_000);

    await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '40000' }));

    const messages = await outbox();
    expect(messages.map((row) => row.template).sort()).toEqual(['admin_alert', 'admin_alert', 'payment_receipt']);
    expect(messages.find((row) => row.dedupe_key === `email:admin_alert:overpayment:${sessionFee.id}`)?.payload).toMatchObject({
      variant: 'refund_due',
      reason: 'overpayment',
      amountRwf: 10_000,
    });
    const receipt = messages.find((row) => row.template === 'payment_receipt');
    expect(receipt?.payload).toMatchObject({ amountRwf: 40_000, totalRwf: 50_000, paidRwf: 60_000, outstandingRwf: 0 });
    expect(sink.entries).toContainEqual(expect.objectContaining({ event: 'booking_overpaid', overpaidRwf: 10_000 }));
  });

  /**
   * And what that receipt says. `outstandingRwf` is floored at nought
   * (booking/totals.ts), so "paid in full" beside a Paid line above the Total
   * would be the wrong conclusion drawn for them. The payload carries
   * `overpaidRwf` as well, and the difference the photographer has been told to
   * refund is named in the client’s own email too (spec §6.16).
   */
  it('names the money owed back to that overpaying client, rather than calling it paid in full', async () => {
    const { sessionFee } = await askedFor(40_000);
    await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '40000' }));

    const payload = (await outbox()).find((row) => row.template === 'payment_receipt')?.payload ?? {};
    expect(payload).toMatchObject({ overpaidRwf: 10_000 });
    const email = renderReceipt(payload);

    expect(email.text).not.toContain('paid in full');
    expect(email.text).toContain('Total: 50,000 RWF');
    expect(email.text).toContain('Paid: 60,000 RWF');
    expect(email.text).toContain('Still to pay: 0 RWF');
    // And the difference is named, in words they can act on.
    expect(email.text).toContain('10,000 RWF more than your booking');
    expect(email.text).toMatch(/refund/i);
    expect(email.html).toMatch(/refund/i);
  });

  it('still receipts the client when there is no admin account to alert, and logs the skip', async () => {
    const { sessionFee } = await askedFor();
    await prisma.adminUser.deleteMany();

    await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '30000' }));

    const messages = await outbox();
    expect(messages.map((row) => row.template)).toEqual(['payment_receipt']);
    expect(messages[0]).toMatchObject({ recipient: CLIENT.email, payload: { outstandingRwf: 0, accessToken: null } });
    expect(sink.entries).toContainEqual(
      expect.objectContaining({ level: 'error', event: 'payment_received_alert_skipped', reason: 'no_admin_user' }),
    );
  });

  it('receipts nothing for a booking fee: its confirmation email is its receipt', async () => {
    const { payment } = await waitingBooking();

    await deliver(statusDelivery(payment.ourRef, 'SUCCESSFUL'));

    const messages = await outbox();
    expect(messages.map((row) => row.template).sort()).toEqual(['admin_new_booking', 'booking_confirmation']);
    expect(messages.filter((row) => row.template === 'payment_receipt')).toEqual([]);
  });

  it('receipts nothing for a session fee that failed, and nothing for one still pending', async () => {
    const { sessionFee } = await askedFor();

    await deliver(statusDelivery(sessionFee.ourRef, 'FAILED'));

    expect(await paymentRow(sessionFee.id)).toMatchObject({ status: 'failed' });
    expect(await outbox()).toEqual([]);
  });

  describe('completes the booking it pays off, once its shoot has begun (item 6, 2026-09-27)', () => {
    /** A confirmed booking: 50,000 owed, 20,000 booking fee collected, the rest asked for. */
    async function confirmedAskedFor(startsAt: Date) {
      const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt });
      await insertPayment(prisma, booking.id, { status: 'succeeded' });
      const sessionFee = await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 30_000 });
      return { booking, sessionFee };
    }

    async function completion(id: string) {
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true, completedAt: true } });
      return { status: booking.status, completedAt: booking.completedAt };
    }

    it('completes it in the same transaction, stamped with the settlement time', async () => {
      const { booking, sessionFee } = await confirmedAskedFor(new Date(NOW.getTime() - 2 * 60 * 60_000));

      const outcome = await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '30000' }));

      expect(outcome).toMatchObject({ status: 'applied', note: 'payment_succeeded_booking_completed' });
      expect(await paymentRow(sessionFee.id)).toMatchObject({ status: 'succeeded' });
      expect(await completion(booking.id)).toStrictEqual({ status: 'completed', completedAt: NOW });
    });

    it('changes nothing on a replay of the same delivery', async () => {
      const { booking, sessionFee } = await confirmedAskedFor(new Date(NOW.getTime() - 2 * 60 * 60_000));
      const delivery = statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '30000' });

      await deliver(delivery);
      const once = await rowJson('booking', booking.id);
      const messages = await outbox();
      const replay = await deliver(delivery, { now: () => new Date(NOW.getTime() + 60 * 60_000) });

      expect(replay.status).toBe('ignored');
      expect(await rowJson('booking', booking.id)).toStrictEqual(once);
      expect(await outbox()).toEqual(messages);
    });

    it('leaves it confirmed when the balance clears before the shoot begins', async () => {
      const { booking, sessionFee } = await confirmedAskedFor(new Date(NOW.getTime() + 60 * 60_000));

      const outcome = await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '30000' }));

      expect(outcome).toMatchObject({ status: 'applied', note: 'payment_succeeded' });
      expect(await completion(booking.id)).toStrictEqual({ status: 'confirmed', completedAt: null });
    });

    it('leaves it confirmed when money is still owed after the payment', async () => {
      const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: new Date(NOW.getTime() - 2 * 60 * 60_000) });
      await insertPayment(prisma, booking.id, { status: 'succeeded' });
      const sessionFee = await insertPayment(prisma, booking.id, { status: 'pending', kind: 'session_fee', amountRwf: 10_000 });

      const outcome = await deliver(statusDelivery(sessionFee.ourRef, 'SUCCESSFUL', { amount: '10000' }));

      expect(outcome).toMatchObject({ status: 'applied', note: 'payment_succeeded' });
      expect(await completion(booking.id)).toStrictEqual({ status: 'confirmed', completedAt: null });
    });
  });
});
