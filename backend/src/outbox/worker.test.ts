import { Prisma, type PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { renderEmail } from '../email/render.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  OUTBOX_HANDLER_TIMEOUT_MS,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  type OutboxHandler,
  type OutboxRow,
  type OutboxWorkerDeps,
  PermanentOutboxError,
  backoffMs,
  claimNext,
  drainQueue,
  dueRowQuery,
  processNext,
  startOutboxWorker,
} from './worker.js';

/**
 * The outbox worker (plan.md Task 14, spec §6.17, data-model_v2.md §5.13),
 * against real PostgreSQL. Handlers are fakes -- what is under test is the
 * queue: claiming, backoff, exhaustion, the partial index and the lifecycle.
 *
 * Every "when is it due" assertion is DB-side epoch arithmetic
 * (`next_attempt_at - now()`), so the test and PostgreSQL never compare clocks.
 */

let prisma: PrismaClient;
let raw: pg.Client;

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
});

// --- Fixtures ---------------------------------------------------------------

const MINUTE_S = 60;
const ADMIN_EMAIL = 'photographer@bookly.example';
const CLIENT_EMAIL = 'aline.private@example.com';
const CLIENT_NAME = 'Aline Uwase-Private';
const TOKEN = 'Zx9Q2mT7vL4pR8sK1nB6yH3cF5dG0wJe';
const REFERENCE = 'BKY-2610-7K3MQ';

type RowSeed = {
  kind?: string;
  template?: string | null;
  recipient?: string | null;
  dedupeKey?: string;
  payload?: unknown;
  status?: string;
  attempts?: number;
  /** Negative: already due. */
  dueInSeconds?: number;
  bookingId?: string | null;
};

let seedCounter = 0;

async function seedRow(seed: RowSeed = {}): Promise<string> {
  seedCounter += 1;
  const result = await raw.query<{ id: string }>(
    `INSERT INTO outbox (kind, booking_id, dedupe_key, template, recipient, payload, status, attempts, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now() + make_interval(secs => $9::double precision))
     RETURNING id`,
    [
      seed.kind ?? 'email',
      seed.bookingId ?? null,
      seed.dedupeKey ?? `email:booking_confirmation:test-${seedCounter}`,
      seed.template === undefined ? 'booking_confirmation' : seed.template,
      seed.recipient === undefined ? CLIENT_EMAIL : seed.recipient,
      seed.payload === undefined ? JSON.stringify({ clientName: CLIENT_NAME, accessToken: TOKEN }) : JSON.stringify(seed.payload),
      seed.status ?? 'pending',
      seed.attempts ?? 0,
      seed.dueInSeconds ?? -1,
    ],
  );
  return firstRow(result).id;
}

type RowState = {
  status: string;
  attempts: number;
  last_error: string | null;
  provider_message_id: string | null;
  completed: boolean;
  /** Seconds from the database's now() to next_attempt_at. */
  due_in: number;
};

async function stateOf(id: string): Promise<RowState> {
  const result = await raw.query<RowState>(
    `SELECT status, attempts, last_error, provider_message_id, completed_at IS NOT NULL AS completed,
            extract(epoch FROM next_attempt_at - now())::float AS due_in
       FROM outbox WHERE id = $1`,
    [id],
  );
  return firstRow(result);
}

async function makeDue(id: string): Promise<void> {
  await raw.query(`UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);
}

async function seedAdmin(email = ADMIN_EMAIL, createdAt?: string): Promise<void> {
  await raw.query(
    `INSERT INTO admin_user (email, password_hash, created_at) VALUES ($1, 'not-a-real-hash', COALESCE($2::timestamptz, now()))`,
    [email, createdAt ?? null],
  );
}

async function seedBooking(reference = REFERENCE): Promise<string> {
  const service = await prisma.service.create({ data: { slug: `portrait-${reference}`, nameEn: 'Portrait' } });
  const pkg = await prisma.package.create({
    data: { serviceId: service.id, nameEn: 'Standard', priceRwf: 45_000, photoCount: 20, durationMinutes: 60 },
  });
  const client = await prisma.client.create({
    data: { fullName: CLIENT_NAME, email: `${reference.toLowerCase()}@example.com`, phone: '+250788000000' },
  });
  const booking = await prisma.booking.create({
    data: {
      reference,
      clientId: client.id,
      contactName: CLIENT_NAME,
      contactEmail: CLIENT_EMAIL,
      contactPhone: '+250788000000',
      serviceId: service.id,
      packageId: pkg.id,
      serviceNameSnapshot: 'Portrait',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 45_000,
      packageDurationMinutes: 60,
      packagePhotoCount: 20,
      locationText: 'Kigali Heights',
      consentAt: new Date(),
      bookingFeeRate: '0.400',
      bookingFeeRwf: 18_000,
      status: 'confirmed',
      startsAt: new Date('2026-10-07T07:00:00Z'),
      endsAt: new Date('2026-10-07T08:00:00Z'),
      bufferEndsAt: new Date('2026-10-07T08:30:00Z'),
    },
  });
  return booking.id;
}

type LogEntry = Record<string, unknown>;

function deps(handlers: OutboxWorkerDeps['handlers'], logs: LogEntry[] = [], client: PrismaClient = prisma): OutboxWorkerDeps {
  return { prisma: client, handlers, log: (entry) => logs.push(entry) };
}

const failing =
  (message = 'Resend answered 503: upstream unavailable'): OutboxHandler =>
  async () => {
    throw new Error(message);
  };

const succeeding =
  (providerMessageId: string | null = 'provider-1'): OutboxHandler =>
  async () => ({ providerMessageId });

async function alertRows() {
  return prisma.outbox.findMany({ where: { template: 'admin_alert' }, orderBy: { createdAt: 'asc' } });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The same client, with `$queryRaw` (the claim) counted and optionally failing:
 * a stand-in for a database hiccup that the loop must survive.
 */
function instrumented(base: PrismaClient) {
  const state = { claims: 0, failNextClaims: 0 };
  const client = new Proxy(base, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === '$queryRaw') {
        return (...args: unknown[]) => {
          state.claims += 1;
          if (state.failNextClaims > 0) {
            state.failNextClaims -= 1;
            return Promise.reject(new Error('Connection terminated unexpectedly'));
          }
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { client, state };
}

// --- backoffMs ----------------------------------------------------------------

describe('backoffMs', () => {
  it('is one minute after the first failure and doubles after each one', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(backoffMs)).toEqual(
      [1, 2, 4, 8, 16, 32, 64, 128, 256].map((minutes) => minutes * 60_000),
    );
  });

  it('is capped at six hours', () => {
    expect(backoffMs(10)).toBe(6 * 60 * 60_000); // 512 min would exceed the cap
    expect(backoffMs(20)).toBe(6 * 60 * 60_000);
    expect(backoffMs(1000)).toBe(6 * 60 * 60_000);
  });

  it('never goes below one minute for a nonsensical attempt count', () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(-3)).toBe(60_000);
  });

  it('uses a lease well beyond the handler deadline, so a slow handler never overlaps its own retry', () => {
    expect(OUTBOX_LEASE_MS).toBe(5 * 60_000);
    expect(OUTBOX_HANDLER_TIMEOUT_MS).toBe(60_000);
    expect(OUTBOX_HANDLER_TIMEOUT_MS).toBeLessThan(OUTBOX_LEASE_MS);
    expect(OUTBOX_MAX_ATTEMPTS).toBe(8);
  });
});

// --- Claiming -------------------------------------------------------------------

describe('claimNext', () => {
  it('claims a due row: processing, attempt counted, leased for five minutes, fields mapped', async () => {
    const bookingId = await seedBooking();
    const id = await seedRow({ bookingId, dedupeKey: 'email:booking_confirmation:b1' });

    const row = await claimNext(prisma, ['email']);

    expect(row).toEqual<OutboxRow>({
      id,
      kind: 'email',
      bookingId,
      dedupeKey: 'email:booking_confirmation:b1',
      template: 'booking_confirmation',
      recipient: CLIENT_EMAIL,
      payload: { clientName: CLIENT_NAME, accessToken: TOKEN },
      attempts: 1,
    });
    const state = await stateOf(id);
    expect(state.status).toBe('processing');
    expect(state.attempts).toBe(1);
    expect(state.due_in).toBeGreaterThan(OUTBOX_LEASE_MS / 1000 - 5);
    expect(state.due_in).toBeLessThanOrEqual(OUTBOX_LEASE_MS / 1000);
  });

  it('returns null when nothing is due, and claims nothing for an empty kind list', async () => {
    const id = await seedRow({ dueInSeconds: 60 });

    await expect(claimNext(prisma, ['email'])).resolves.toBeNull();
    await makeDue(id);
    await expect(claimNext(prisma, [])).resolves.toBeNull();

    expect((await stateOf(id)).status).toBe('pending');
    expect((await stateOf(id)).attempts).toBe(0);
  });

  it('claims only kinds it was asked for: processNext never touches a kind without a handler', async () => {
    const gcal = await seedRow({ kind: 'gcal_create', template: null, recipient: null, dedupeKey: 'gcal:1' });
    const handler = vi.fn(succeeding());

    await expect(processNext(deps({ email: handler }))).resolves.toBe(false);

    expect(handler).not.toHaveBeenCalled();
    expect(await stateOf(gcal)).toMatchObject({ status: 'pending', attempts: 0 });

    const email = await seedRow();
    await expect(processNext(deps({ email: handler }))).resolves.toBe(true);
    expect((await stateOf(email)).status).toBe('done');
    expect(await stateOf(gcal)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('claims the oldest due row first', async () => {
    const middle = await seedRow({ dueInSeconds: -120 });
    const newest = await seedRow({ dueInSeconds: -60 });
    const oldest = await seedRow({ dueInSeconds: -180 });
    await seedRow({ dueInSeconds: 600 }); // not due at all

    const order = [];
    for (let i = 0; i < 4; i++) order.push((await claimNext(prisma, ['email']))?.id ?? null);

    expect(order).toEqual([oldest, middle, newest, null]);
  });

  it.each(['done', 'failed', 'cancelled'])('never claims a %s row, however overdue', async (status) => {
    const id = await seedRow({ status, attempts: 3, dueInSeconds: -86_400 });

    await expect(claimNext(prisma, ['email'])).resolves.toBeNull();
    expect(await stateOf(id)).toMatchObject({ status, attempts: 3 });
  });

  it('does not claim a processing row whose lease is still running', async () => {
    const id = await seedRow({ status: 'processing', attempts: 1, dueInSeconds: 200 });

    await expect(claimNext(prisma, ['email'])).resolves.toBeNull();
    expect(await stateOf(id)).toMatchObject({ status: 'processing', attempts: 1 });
  });

  it('reclaims a processing row whose lease ran out (crash recovery), counting the attempt', async () => {
    const id = await seedRow({ status: 'processing', attempts: 2, dueInSeconds: -1 });
    const handler = vi.fn(succeeding('after-crash'));

    await expect(processNext(deps({ email: handler }))).resolves.toBe(true);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ id, attempts: 3 });
    expect(await stateOf(id)).toMatchObject({ status: 'done', attempts: 3, provider_message_id: 'after-crash' });
  });

  it('a crash-recovered claim after an abandoned claim works end to end', async () => {
    const id = await seedRow();

    // A process claims the row and dies before finishing it.
    await expect(claimNext(prisma, ['email'])).resolves.toMatchObject({ id, attempts: 1 });
    await expect(claimNext(prisma, ['email'])).resolves.toBeNull(); // leased

    // Five minutes later the lease has run out.
    await makeDue(id);
    await expect(processNext(deps({ email: succeeding() }))).resolves.toBe(true);
    expect(await stateOf(id)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('gives two concurrent claims different rows, and one row to only one of them', async () => {
    await Promise.all(Array.from({ length: 4 }, () => prisma.outbox.count())); // warm the pool
    const a = await seedRow({ dueInSeconds: -20 });
    const b = await seedRow({ dueInSeconds: -10 });

    const pair = await Promise.all([claimNext(prisma, ['email']), claimNext(prisma, ['email'])]);
    expect(pair.map((row) => row?.id).sort()).toEqual([a, b].sort());

    await truncateAll(raw);
    const only = await seedRow();
    const race = await Promise.all([claimNext(prisma, ['email']), claimNext(prisma, ['email']), claimNext(prisma, ['email'])]);
    expect(race.filter((row) => row !== null).map((row) => row?.id)).toEqual([only]);
    expect((await stateOf(only)).attempts).toBe(1);
  });

  it('does not retry forever a message that kills the process on every attempt', async () => {
    // The worker's own doc comment: "The attempt is counted at claim time, so a
    // message that crashes the process cannot be retried forever either."
    // Simulate a poison message: every claim is followed by a crash (the row is
    // never finished) and, five minutes later, by the lease running out.
    const id = await seedRow();
    let claims = 0;
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 4; i++) {
      const row = await claimNext(prisma, ['email']);
      if (row === null) break;
      claims += 1;
      await makeDue(id);
    }

    expect(claims).toBeLessThanOrEqual(OUTBOX_MAX_ATTEMPTS);
    expect((await stateOf(id)).attempts).toBeLessThanOrEqual(OUTBOX_MAX_ATTEMPTS);
  });

  it('fails a row abandoned mid-delivery on its last attempt, with one alert, instead of claiming it again', async () => {
    await seedAdmin();
    const bookingId = await seedBooking();
    // Claimed for the last time, then the process died: its lease has run out.
    const id = await seedRow({ bookingId, status: 'processing', attempts: OUTBOX_MAX_ATTEMPTS });
    const logs: LogEntry[] = [];

    // Not the abandoned row: the alert about it, which is due at once and is
    // what the worker delivers next.
    const claimed = await claimNext(prisma, ['email'], (entry) => logs.push(entry));
    expect(claimed).toMatchObject({ template: 'admin_alert', recipient: ADMIN_EMAIL, attempts: 1 });
    expect(claimed?.id).not.toBe(id);
    // A second pass must not alert twice.
    await expect(claimNext(prisma, ['email'], (entry) => logs.push(entry))).resolves.toBeNull();

    const state = await stateOf(id);
    expect(state).toMatchObject({ status: 'failed', attempts: OUTBOX_MAX_ATTEMPTS });
    expect(state.last_error).toMatch(/^Abandoned mid-delivery on all \d+ attempts/);
    const alerts = await alertRows();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload).toMatchObject({
      variant: 'retries_exhausted',
      bookingReference: REFERENCE,
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: state.last_error,
    });
    expect(logs.filter((entry) => entry.event === 'outbox_message_abandoned')).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(CLIENT_EMAIL);
  });

  it('leaves an abandoned last attempt alone while its lease still runs, and claims a fresher row meanwhile', async () => {
    const leased = await seedRow({ status: 'processing', attempts: OUTBOX_MAX_ATTEMPTS, dueInSeconds: 120 });
    const fresh = await seedRow();

    const claimed = await claimNext(prisma, ['email']);

    expect(claimed?.id).toBe(fresh);
    expect((await stateOf(leased)).status).toBe('processing');
  });

  it('fails an abandoned admin_alert without alerting about the alert', async () => {
    await seedAdmin();
    const id = await seedRow({ template: 'admin_alert', recipient: ADMIN_EMAIL, status: 'processing', attempts: OUTBOX_MAX_ATTEMPTS });

    await claimNext(prisma, ['email']);

    expect((await stateOf(id)).status).toBe('failed');
    expect(await alertRows()).toHaveLength(1);
  });
});

// --- Success ------------------------------------------------------------------------

describe('processNext: a delivered row', () => {
  it('becomes done with completed_at and the provider message id', async () => {
    const id = await seedRow();
    const handler = vi.fn(succeeding('re_12345'));

    await expect(processNext(deps({ email: handler }))).resolves.toBe(true);

    expect(await stateOf(id)).toMatchObject({
      status: 'done',
      attempts: 1,
      completed: true,
      provider_message_id: 're_12345',
      last_error: null,
    });
    const [row, signal] = handler.mock.calls[0] ?? [];
    expect(row).toMatchObject({ id, attempts: 1 });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('stores a null provider id when the handler returns nothing', async () => {
    const id = await seedRow();

    await processNext(deps({ email: async () => undefined }));

    expect(await stateOf(id)).toMatchObject({ status: 'done', provider_message_id: null, completed: true });
  });

  it('returns false on an empty queue, so drainQueue stops', async () => {
    await expect(processNext(deps({ email: succeeding() }))).resolves.toBe(false);
    for (let i = 0; i < 3; i++) await seedRow();
    await seedRow({ dueInSeconds: 3600 });

    await expect(drainQueue(deps({ email: succeeding() }))).resolves.toBe(3);
    await expect(prisma.outbox.count({ where: { status: 'done' } })).resolves.toBe(3);
    await expect(prisma.outbox.count({ where: { status: 'pending' } })).resolves.toBe(1);
  });

  it('drainQueue honours shouldStop between rows', async () => {
    for (let i = 0; i < 3; i++) await seedRow();
    let processed = 0;

    const count = await drainQueue(
      deps({
        email: async () => {
          processed += 1;
          return undefined;
        },
      }),
      () => processed >= 2,
    );

    expect(count).toBe(2);
    await expect(prisma.outbox.count({ where: { status: 'pending' } })).resolves.toBe(1);
  });

  it('does not overwrite a row cancelled while its delivery was in flight', async () => {
    const id = await seedRow();

    await processNext(
      deps({
        email: async (row) => {
          await raw.query(`UPDATE outbox SET status = 'cancelled' WHERE id = $1`, [row.id]);
          return { providerMessageId: 'sent-anyway' };
        },
      }),
    );

    expect(await stateOf(id)).toMatchObject({ status: 'cancelled', completed: false, provider_message_id: null });
  });
});

// --- Failure and backoff -----------------------------------------------------------

describe('processNext: a throwing handler', () => {
  it('puts the row back to pending with the attempt counted, last_error set and a one-minute backoff', async () => {
    const id = await seedRow();
    const logs: LogEntry[] = [];

    await expect(processNext(deps({ email: failing('Resend answered 503: busy') }, logs))).resolves.toBe(true);

    const state = await stateOf(id);
    expect(state).toMatchObject({ status: 'pending', attempts: 1, last_error: 'Error: Resend answered 503: busy', completed: false });
    expect(state.due_in).toBeGreaterThan(MINUTE_S - 5);
    expect(state.due_in).toBeLessThanOrEqual(MINUTE_S);
    expect(logs).toEqual([
      expect.objectContaining({ level: 'warn', event: 'outbox_attempt_failed', id, attempts: 1 }),
    ]);
    // Not due, so not claimable again yet.
    await expect(claimNext(prisma, ['email'])).resolves.toBeNull();
    await expect(alertRows()).resolves.toHaveLength(0);
  });

  it('pushes next_attempt_at out exponentially across successive failures, then fails at the ceiling', async () => {
    await seedAdmin();
    const id = await seedRow();
    const delays: number[] = [];

    for (let attempt = 1; attempt < OUTBOX_MAX_ATTEMPTS; attempt++) {
      await makeDue(id);
      await processNext(deps({ email: failing(`failure ${attempt}`) }));
      const state = await stateOf(id);
      expect(state).toMatchObject({ status: 'pending', attempts: attempt, last_error: `Error: failure ${attempt}` });
      delays.push(state.due_in);
    }

    const expected = [1, 2, 4, 8, 16, 32, 64].map((minutes) => minutes * MINUTE_S);
    expect(delays).toHaveLength(expected.length);
    delays.forEach((delay, i) => {
      expect(delay).toBeGreaterThan((expected[i] ?? 0) - 5);
      expect(delay).toBeLessThanOrEqual(expected[i] ?? 0);
    });
    for (let i = 1; i < delays.length; i++) {
      expect((delays[i] ?? 0) / (delays[i - 1] ?? 1)).toBeCloseTo(2, 1);
    }

    await makeDue(id);
    await processNext(deps({ email: failing('the last straw') }));
    expect(await stateOf(id)).toMatchObject({ status: 'failed', attempts: OUTBOX_MAX_ATTEMPTS, last_error: 'Error: the last straw' });
    await expect(alertRows()).resolves.toHaveLength(1);
    // Only the alert is claimable now; the failed row never is again.
    await makeDue(id);
    const next = await claimNext(prisma, ['email']);
    expect(next).toMatchObject({ template: 'admin_alert' });
    expect(next?.id).not.toBe(id);
    await expect(claimNext(prisma, ['email'])).resolves.toBeNull();
  });

  it('truncates last_error to 1000 characters', async () => {
    const id = await seedRow();

    await processNext(deps({ email: failing('x'.repeat(5000)) }));

    const state = await stateOf(id);
    expect(state.last_error).toHaveLength(1000);
    expect(state.last_error?.startsWith('Error: xxx')).toBe(true);
  });

  it('records a thrown non-Error value', async () => {
    const id = await seedRow();

    await processNext(
      deps({
        email: async () => {
          throw 'a bare string';
        },
      }),
    );

    expect(await stateOf(id)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'a bare string' });
  });

  it('does not overwrite a row cancelled while a failing delivery was in flight', async () => {
    await seedAdmin();
    const retrying = await seedRow();
    const exhausted = await seedRow({ attempts: OUTBOX_MAX_ATTEMPTS - 1, dueInSeconds: -10 });

    const cancelThenThrow: OutboxHandler = async (row) => {
      await raw.query(`UPDATE outbox SET status = 'cancelled' WHERE id = $1`, [row.id]);
      throw new Error('too late');
    };
    await processNext(deps({ email: cancelThenThrow }));
    await processNext(deps({ email: cancelThenThrow }));

    expect(await stateOf(retrying)).toMatchObject({ status: 'cancelled', last_error: null });
    expect(await stateOf(exhausted)).toMatchObject({ status: 'cancelled', last_error: null });
    await expect(alertRows()).resolves.toHaveLength(0);
  });

  it('records a handler whose error message holds a NUL byte as a failed attempt', async () => {
    // PostgreSQL text cannot hold U+0000. A provider or library error carrying
    // one must still be recorded; otherwise the row is stranded in processing
    // and retried at every lease expiry without ever reaching the ceiling.
    const id = await seedRow();

    await processNext(deps({ email: failing(`bad byte ${String.fromCharCode(0)} in the response`) })).catch(() => undefined);

    expect((await stateOf(id)).status).toBe('pending');
  });
});

// --- Exhaustion -------------------------------------------------------------------

describe('processNext: past the attempt ceiling', () => {
  it('fails the row and enqueues exactly one retries_exhausted admin_alert carrying last_error and the booking reference', async () => {
    await seedAdmin();
    const bookingId = await seedBooking();
    const id = await seedRow({ bookingId, attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    const logs: LogEntry[] = [];

    await processNext(deps({ email: failing('Resend answered 500: internal') }, logs));

    expect(await stateOf(id)).toMatchObject({
      status: 'failed',
      attempts: OUTBOX_MAX_ATTEMPTS,
      last_error: 'Error: Resend answered 500: internal',
      completed: false,
    });
    const alerts = await alertRows();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'email',
      template: 'admin_alert',
      recipient: ADMIN_EMAIL,
      dedupeKey: `email:admin_alert:retries_exhausted:${id}`,
      status: 'pending',
      attempts: 0,
      payload: {
        variant: 'retries_exhausted',
        messageKind: 'email',
        template: 'booking_confirmation',
        bookingReference: REFERENCE,
        attempts: OUTBOX_MAX_ATTEMPTS,
        lastError: 'Error: Resend answered 500: internal',
      },
    });
    expect(logs).toEqual([
      expect.objectContaining({ level: 'error', event: 'outbox_message_failed', id, permanent: false }),
    ]);

    // The alert the worker writes is one the admin_alert template renders.
    const rendered = renderEmail('admin_alert', alerts[0]?.payload, { webOrigin: 'https://bookly.example' });
    expect(rendered.text).toContain(REFERENCE);
    expect(rendered.text).toContain('Error: Resend answered 500: internal');
    expect(rendered.text).toContain('Booking confirmation to the client');
  });

  it('addresses the alert to the oldest admin_user', async () => {
    await seedAdmin('newer@bookly.example', '2026-09-01T00:00:00Z');
    await seedAdmin('oldest@bookly.example', '2026-01-01T00:00:00Z');
    await seedRow({ attempts: OUTBOX_MAX_ATTEMPTS - 1 });

    await processNext(deps({ email: failing() }));

    expect((await alertRows()).map((row) => row.recipient)).toEqual(['oldest@bookly.example']);
  });

  it('carries a null booking reference for a row that addresses no booking, and still renders', async () => {
    await seedAdmin();
    await seedRow({ attempts: OUTBOX_MAX_ATTEMPTS - 1, template: 'access_link_resend' });

    await processNext(deps({ email: failing() }));

    const [alert] = await alertRows();
    expect(alert?.payload).toMatchObject({ bookingReference: null, template: 'access_link_resend' });
    expect(() => renderEmail('admin_alert', alert?.payload, { webOrigin: 'https://bookly.example' })).not.toThrow();
  });

  it('alerts for an exhausted calendar job too (spec §6.17), with a renderable payload', async () => {
    await seedAdmin();
    const bookingId = await seedBooking();
    const id = await seedRow({
      kind: 'gcal_create',
      template: null,
      recipient: null,
      bookingId,
      dedupeKey: `gcal_create:${bookingId}`,
      payload: {},
      attempts: OUTBOX_MAX_ATTEMPTS - 1,
    });

    await processNext(deps({ gcal_create: failing('Google answered 503') }));

    expect((await stateOf(id)).status).toBe('failed');
    const [alert] = await alertRows();
    expect(alert?.payload).toMatchObject({ messageKind: 'gcal_create', template: null, bookingReference: REFERENCE });
    const rendered = renderEmail('admin_alert', alert?.payload, { webOrigin: 'https://bookly.example' });
    expect(rendered.text).toContain('Adding the booking to your Google Calendar');
  });

  it('carries a truncated last_error that still renders', async () => {
    await seedAdmin();
    await seedRow({ attempts: OUTBOX_MAX_ATTEMPTS - 1 });

    await processNext(deps({ email: failing('y'.repeat(4000)) }));

    const [alert] = await alertRows();
    const lastError = (alert?.payload as { lastError: string }).lastError;
    expect(lastError).toHaveLength(1000);
    expect(() => renderEmail('admin_alert', alert?.payload, { webOrigin: 'https://bookly.example' })).not.toThrow();
  });

  it('fails a PermanentOutboxError on the first attempt, with an alert', async () => {
    await seedAdmin();
    const id = await seedRow();
    const logs: LogEntry[] = [];

    await processNext(
      deps(
        {
          email: async () => {
            throw new PermanentOutboxError('The booking_confirmation payload is invalid at: accessToken');
          },
        },
        logs,
      ),
    );

    expect(await stateOf(id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'PermanentOutboxError: The booking_confirmation payload is invalid at: accessToken',
    });
    const alerts = await alertRows();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload).toMatchObject({ attempts: 1, lastError: expect.stringContaining('PermanentOutboxError') });
    expect(logs).toEqual([expect.objectContaining({ event: 'outbox_message_failed', permanent: true })]);
  });

  it('sends no alert about a failed admin_alert', async () => {
    await seedAdmin();
    const id = await seedRow({
      template: 'admin_alert',
      recipient: ADMIN_EMAIL,
      dedupeKey: 'email:admin_alert:login_lockout:1',
      payload: { variant: 'login_lockout', failedLoginCount: 5, lockedUntil: '2026-10-07T07:00:00.000Z' },
      attempts: OUTBOX_MAX_ATTEMPTS - 1,
    });
    const logs: LogEntry[] = [];

    await processNext(deps({ email: failing() }, logs));

    expect((await stateOf(id)).status).toBe('failed');
    await expect(prisma.outbox.count()).resolves.toBe(1);
    expect(logs).toEqual([expect.objectContaining({ event: 'outbox_message_failed', id })]);
  });

  it('with no admin_user, fails the row, skips the alert and logs why', async () => {
    const id = await seedRow({ attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    const logs: LogEntry[] = [];

    await processNext(deps({ email: failing() }, logs));

    expect((await stateOf(id)).status).toBe('failed');
    await expect(prisma.outbox.count()).resolves.toBe(1);
    expect(logs).toEqual([
      expect.objectContaining({ level: 'error', event: 'outbox_alert_skipped', reason: 'no_admin_user', id }),
      expect.objectContaining({ level: 'error', event: 'outbox_message_failed', id }),
    ]);
  });

  it('does not duplicate the alert when the same row is exhausted a second time', async () => {
    await seedAdmin();
    const id = await seedRow({ attempts: OUTBOX_MAX_ATTEMPTS - 1 });

    await processNext(deps({ email: failing('first exhaustion') }));
    // Someone puts it back in the queue by hand, and it fails again.
    await raw.query(`UPDATE outbox SET status = 'pending', attempts = $2, next_attempt_at = now() - interval '1 second' WHERE id = $1`, [
      id,
      OUTBOX_MAX_ATTEMPTS - 1,
    ]);
    await processNext(deps({ email: failing('second exhaustion') }));

    expect(await stateOf(id)).toMatchObject({ status: 'failed', last_error: 'Error: second exhaustion' });
    const alerts = await alertRows();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload).toMatchObject({ lastError: 'Error: first exhaustion' });
  });

  it('is atomic: when the alert cannot be enqueued, the row is not marked failed', async () => {
    await seedAdmin();
    const id = await seedRow({ attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    await raw.query(`
      CREATE OR REPLACE FUNCTION bookly_test_refuse_admin_alert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'admin_alert refused by test trigger'; END $$`);
    await raw.query(`
      CREATE TRIGGER bookly_test_refuse_admin_alert BEFORE INSERT ON outbox
      FOR EACH ROW WHEN (NEW.template = 'admin_alert') EXECUTE FUNCTION bookly_test_refuse_admin_alert()`);
    try {
      await expect(processNext(deps({ email: failing('down') }))).rejects.toThrow();

      // Neither half happened: still claimed, no alert. The lease brings it back.
      expect(await stateOf(id)).toMatchObject({ status: 'processing', attempts: OUTBOX_MAX_ATTEMPTS, last_error: null });
      await expect(alertRows()).resolves.toHaveLength(0);
    } finally {
      await raw.query(`DROP TRIGGER IF EXISTS bookly_test_refuse_admin_alert ON outbox`);
      await raw.query(`DROP FUNCTION IF EXISTS bookly_test_refuse_admin_alert()`);
    }

    await makeDue(id);
    await processNext(deps({ email: failing('down again') }));
    expect((await stateOf(id)).status).toBe('failed');
    await expect(alertRows()).resolves.toHaveLength(1);
  });
});

// --- The partial index ------------------------------------------------------------

describe('the queue query and outbox_queue_idx', () => {
  const INDEX_SCAN = /(Index Scan|Index Only Scan) using outbox_queue_idx on outbox|Bitmap Index Scan on outbox_queue_idx/;

  async function planOf(client: Prisma.TransactionClient | PrismaClient): Promise<string> {
    const rows = await client.$queryRaw<{ 'QUERY PLAN': string }[]>(Prisma.sql`EXPLAIN ${dueRowQuery(['email'])}`);
    return rows.map((row) => row['QUERY PLAN']).join('\n');
  }

  it('matches the index predicate exactly', async () => {
    const result = await raw.query<{ def: string }>(`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'outbox_queue_idx'`);
    const def = firstRow(result).def;
    expect(def).toContain('(status, next_attempt_at)');
    expect(def).toMatch(/WHERE \(status = ANY \(ARRAY\['pending'::text, 'processing'::text\]\)\)/);
    expect(dueRowQuery(['email']).sql).toMatch(/status IN \('pending', 'processing'\)/);
  });

  it('can be answered from the partial index (enable_seqscan off)', async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return planOf(tx);
    });

    // Plain or bitmap, depending on the statistics autovacuum left behind: both
    // read the partial index, and neither is a sequential scan.
    expect(plan, plan).toMatch(INDEX_SCAN);
    expect(plan, plan).not.toMatch(/Seq Scan/);
  });

  it('uses the partial index with a few thousand realistic rows, left to the planner', async () => {
    // Years of history: nearly everything delivered, a few failures, a handful waiting.
    await raw.query(`
      INSERT INTO outbox (kind, dedupe_key, template, recipient, payload, status, attempts, next_attempt_at, completed_at, created_at)
      SELECT 'email', 'email:booking_confirmation:hist-' || g, 'booking_confirmation', 'client' || g || '@example.com',
             jsonb_build_object('reference', 'BKY-' || g, 'clientName', 'Client ' || g),
             CASE WHEN g % 200 = 0 THEN 'failed' ELSE 'done' END,
             CASE WHEN g % 200 = 0 THEN 8 ELSE 1 END,
             now() - make_interval(hours => g), now() - make_interval(hours => g), now() - make_interval(hours => g)
        FROM generate_series(1, 4000) AS g`);
    await raw.query(`
      INSERT INTO outbox (kind, dedupe_key, template, recipient, payload, status, next_attempt_at)
      SELECT 'email', 'email:payment_receipt:live-' || g, 'payment_receipt', 'live' || g || '@example.com', '{}'::jsonb,
             'pending', now() + make_interval(mins => g - 5)
        FROM generate_series(1, 12) AS g`);
    await raw.query('ANALYZE outbox');

    const plan = await planOf(prisma);

    expect(plan, plan).toMatch(INDEX_SCAN);
    expect(plan, plan).not.toMatch(/Seq Scan/);
    // And the worker agrees with the plan: the oldest due row comes first.
    const claimed = await claimNext(prisma, ['email']);
    expect(claimed?.dedupeKey).toBe('email:payment_receipt:live-1');
  });
});

// --- Handler timeout ----------------------------------------------------------------

describe('the handler deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('abandons a handler that never settles after OUTBOX_HANDLER_TIMEOUT_MS, aborting its signal and recording a failed attempt', async () => {
    const id = await seedRow();
    const started = deferred<AbortSignal>();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const processing = processNext(
      deps({
        email: (_row, signal) => {
          started.resolve(signal);
          return new Promise(() => undefined); // ignores the signal and never settles
        },
      }),
    );
    const signal = await started.promise;

    await vi.advanceTimersByTimeAsync(OUTBOX_HANDLER_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    expect((await stateOf(id)).status).toBe('processing');

    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await expect(processing).resolves.toBe(true);

    expect(signal.aborted).toBe(true);
    expect(await stateOf(id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: `Error: Handler timed out after ${OUTBOX_HANDLER_TIMEOUT_MS} ms`,
    });
  });

  it('clears the deadline when the handler finishes first', async () => {
    const id = await seedRow();
    let seen: AbortSignal | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await expect(
      processNext(
        deps({
          email: async (_row, signal) => {
            seen = signal;
            return { providerMessageId: 'quick' };
          },
        }),
      ),
    ).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(2 * OUTBOX_HANDLER_TIMEOUT_MS);
    vi.useRealTimers();

    expect(seen?.aborted).toBe(false);
    expect(await stateOf(id)).toMatchObject({ status: 'done', provider_message_id: 'quick', last_error: null });
  });
});

// --- The loop -----------------------------------------------------------------------

describe('startOutboxWorker', () => {
  it('drains every due row and keeps polling for new ones', async () => {
    for (let i = 0; i < 3; i++) await seedRow();
    const handler = vi.fn(succeeding());
    const worker = startOutboxWorker(deps({ email: handler }), 20);
    try {
      await vi.waitFor(async () => expect(await prisma.outbox.count({ where: { status: 'done' } })).toBe(3), {
        timeout: 5000,
      });

      await seedRow();
      await vi.waitFor(async () => expect(await prisma.outbox.count({ where: { status: 'done' } })).toBe(4), {
        timeout: 5000,
      });
    } finally {
      await worker.stop();
    }
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('stop() resolves only after the in-flight delivery finishes, and leaves nothing in processing', async () => {
    const id = await seedRow();
    const started = deferred();
    const release = deferred();
    const worker = startOutboxWorker(
      deps({
        email: async () => {
          started.resolve();
          await release.promise;
          return { providerMessageId: 'finished-during-shutdown' };
        },
      }),
      20,
    );

    await started.promise;
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stopped).toBe(false);
    expect((await stateOf(id)).status).toBe('processing');

    release.resolve();
    await stopping;

    expect(stopped).toBe(true);
    expect(await stateOf(id)).toMatchObject({ status: 'done', provider_message_id: 'finished-during-shutdown' });
    await expect(prisma.outbox.count({ where: { status: 'processing' } })).resolves.toBe(0);
  });

  it('does not start another row after stop(), even with more due', async () => {
    const first = await seedRow({ dueInSeconds: -30 });
    const second = await seedRow({ dueInSeconds: -20 });
    const started = deferred();
    const release = deferred();
    const handler = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return undefined;
    });
    const worker = startOutboxWorker(deps({ email: handler }), 20);

    await started.promise;
    const stopping = worker.stop();
    release.resolve();
    await stopping;

    expect(handler).toHaveBeenCalledTimes(1);
    expect((await stateOf(first)).status).toBe('done');
    expect(await stateOf(second)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('polls no more after stop()', async () => {
    const { client, state } = instrumented(prisma);
    const handler = vi.fn(succeeding());
    const worker = startOutboxWorker(deps({ email: handler }, [], client), 10);

    await vi.waitFor(() => expect(state.claims).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    await worker.stop();
    const claimsAtStop = state.claims;

    const id = await seedRow();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(state.claims).toBe(claimsAtStop);
    expect(handler).not.toHaveBeenCalled();
    expect(await stateOf(id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('stop() on an idle worker resolves promptly', async () => {
    const worker = startOutboxWorker(deps({ email: succeeding() }), 60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const began = Date.now();
    await worker.stop();

    expect(Date.now() - began).toBeLessThan(1000);
  });

  it('logs a failed drain and carries on at the next tick', async () => {
    const { client, state } = instrumented(prisma);
    state.failNextClaims = 2;
    const id = await seedRow();
    const logs: LogEntry[] = [];
    const worker = startOutboxWorker(deps({ email: succeeding('after-hiccup') }, logs, client), 10);
    try {
      await vi.waitFor(async () => expect((await stateOf(id)).status).toBe('done'), { timeout: 5000 });
    } finally {
      await worker.stop();
    }

    const drainFailures = logs.filter((entry) => entry.event === 'outbox_drain_failed');
    expect(drainFailures).toHaveLength(2);
    expect(drainFailures[0]).toMatchObject({ level: 'error', message: 'Error: Connection terminated unexpectedly' });
  });
});

// --- Logs -----------------------------------------------------------------------------

describe('logging', () => {
  it('never logs the recipient, payload values or tokens, on any path', async () => {
    const logs: LogEntry[] = [];
    const secretPayload = {
      clientName: CLIENT_NAME,
      accessToken: TOKEN,
      resetUrl: `https://bookly.example/admin/reset-password#token=${TOKEN}`,
    };

    // Retry, exhaustion with alert, permanent failure: an admin exists.
    await seedAdmin();
    await seedRow({ payload: secretPayload });
    await seedRow({ payload: secretPayload, attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    await drainQueue(deps({ email: failing('Resend answered 503') }, logs));
    await seedRow({ payload: secretPayload });
    await processNext(
      deps({ email: async () => Promise.reject(new PermanentOutboxError('The payload was erased')) }, logs),
    );
    // Alert skipped: no admin.
    await truncateAll(raw);
    await seedRow({ payload: secretPayload, attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    await processNext(deps({ email: failing() }, logs));
    // Drain failure.
    const { client, state } = instrumented(prisma);
    state.failNextClaims = 1;
    const worker = startOutboxWorker(deps({ email: succeeding() }, logs, client), 10);
    await vi.waitFor(() => expect(logs.some((entry) => entry.event === 'outbox_drain_failed')).toBe(true));
    await worker.stop();

    const events = new Set(logs.map((entry) => entry.event));
    for (const event of ['outbox_attempt_failed', 'outbox_message_failed', 'outbox_alert_skipped', 'outbox_drain_failed']) {
      expect(events).toContain(event);
    }
    const serialised = JSON.stringify(logs);
    for (const secret of [CLIENT_EMAIL, CLIENT_NAME, TOKEN, ADMIN_EMAIL, 'reset-password']) {
      expect(serialised).not.toContain(secret);
    }
    for (const entry of logs) {
      expect(entry).not.toHaveProperty('recipient');
      expect(entry).not.toHaveProperty('payload');
    }
  });

  it('defaults to one JSON line per event on the console, errors on stderr', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await seedRow();
      await seedRow({ attempts: OUTBOX_MAX_ATTEMPTS - 1 });
      await drainQueue({ prisma, handlers: { email: failing() } });

      const lines = [...out.mock.calls, ...err.mock.calls].map((call) => String(call[0]));
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
        expect(line).not.toContain(CLIENT_EMAIL);
        expect(line).not.toContain(TOKEN);
      }
      expect(out.mock.calls.map((call) => JSON.parse(String(call[0])).event)).toContain('outbox_attempt_failed');
      expect(err.mock.calls.map((call) => JSON.parse(String(call[0])).event)).toContain('outbox_message_failed');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
