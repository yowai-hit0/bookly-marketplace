import type { Booking, Prisma, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type ClaimResult, type ClaimSlotInput, MAX_CLAIM_ATTEMPTS, claimSlot } from './claim.js';

/**
 * The slot claim transaction, against real PostgreSQL (plan.md Task 6).
 *
 * Nothing here is mocked, because nothing here is application logic: the
 * guarantee under test is `booking_no_overlap` plus the in-transaction expiry of
 * stale holds (data-model_v2.md §9.2), and neither exists outside the database.
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

type Slot = { startsAt: Date; endsAt: Date; bufferEndsAt: Date };
type Catalogue = { serviceId: string; packageId: string; clientId: string };

function slot(startsAt: string, endsAt: string, bufferEndsAt: string): Slot {
  return {
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    bufferEndsAt: new Date(bufferEndsAt),
  };
}

/** Kigali is UTC+2, so 09:00 local is 07:00Z. Wednesday 7 October 2026. */
const NINE = slot('2026-10-07T07:00:00Z', '2026-10-07T08:00:00Z', '2026-10-07T08:30:00Z');
/** Starts exactly at NINE's buffer end: adjacent, not overlapping. */
const TEN_THIRTY = slot('2026-10-07T08:30:00Z', '2026-10-07T09:30:00Z', '2026-10-07T10:00:00Z');
/** Starts inside NINE's buffer only, never inside the shoot itself. */
const IN_BUFFER = slot('2026-10-07T08:15:00Z', '2026-10-07T09:15:00Z', '2026-10-07T09:45:00Z');
/** Overlaps NINE on its left edge. */
const EIGHT = slot('2026-10-07T06:00:00Z', '2026-10-07T06:45:00Z', '2026-10-07T07:30:00Z');
/** Overlaps NINE on its right edge, and not EIGHT. */
const TEN = slot('2026-10-07T08:00:00Z', '2026-10-07T09:00:00Z', '2026-10-07T09:30:00Z');
/** Nowhere near any of the above. */
const AFTERNOON = slot('2026-10-07T12:00:00Z', '2026-10-07T13:00:00Z', '2026-10-07T13:30:00Z');

async function insertCatalogue(): Promise<Catalogue> {
  const service = await prisma.service.create({ data: { slug: 'portrait', nameEn: 'Portrait' } });
  const pkg = await prisma.package.create({
    data: {
      serviceId: service.id,
      nameEn: 'Standard',
      priceRwf: 40_000,
      photoCount: 20,
      durationMinutes: 60,
    },
  });
  const client = await prisma.client.create({
    data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' },
  });
  return { serviceId: service.id, packageId: pkg.id, clientId: client.id };
}

/** `reference` is UNIQUE; a repeat raises 23505 and looks nothing like a lost race. */
function reference(n: number): string {
  return `BKY-2610-${String(n).padStart(5, '0')}`;
}

/** Everything Task 13 will resolve for real. Here it only has to be valid. */
function claimInput(ids: Catalogue, ref: string, when: Slot): ClaimSlotInput {
  return {
    reference: ref,
    clientId: ids.clientId,
    contactName: 'Aline Uwase',
    contactEmail: 'aline@example.com',
    contactPhone: '+250788000000',
    serviceId: ids.serviceId,
    packageId: ids.packageId,
    serviceNameSnapshot: 'Portrait',
    packageNameSnapshot: 'Standard',
    packagePriceRwf: 40_000,
    packageDurationMinutes: 60,
    packagePhotoCount: 20,
    locationText: 'Kigali Heights',
    consentAt: new Date(),
    bookingFeeRate: '0.400',
    bookingFeeRwf: 16_000,
    ...when,
  };
}

/** An existing row in whatever state the test needs, bypassing claimSlot. */
async function insertBooking(
  ids: Catalogue,
  ref: string,
  when: Slot,
  status: string,
  holdExpiresAt: Date | null = null,
): Promise<Booking> {
  return prisma.booking.create({
    data: { ...claimInput(ids, ref, when), status, holdExpiresAt },
  });
}

function claimedBooking(result: ClaimResult | undefined): Booking {
  if (result === undefined) throw new Error("Expected a 'claimed' result, got none");
  if (result.status !== 'claimed') throw new Error(`Expected 'claimed', got '${result.status}'`);
  return result.booking;
}

async function statusOf(ref: string): Promise<string> {
  const booking = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
  return booking.status;
}

/** Rows whose stored range overlaps `when`, as PostgreSQL itself reads them. */
async function bookingsOverlapping(when: Slot): Promise<number> {
  const result = await raw.query<{ n: string }>(
    `SELECT count(*) AS n FROM booking
      WHERE tstzrange(starts_at, buffer_ends_at, '[)')
         && tstzrange($1::timestamptz, $2::timestamptz, '[)')`,
    [when.startsAt.toISOString(), when.bufferEndsAt.toISOString()],
  );
  return Number(firstRow(result).n);
}

/**
 * Rows reserving the same range as `bookingId`, itself included.
 *
 * Relative to the row that won rather than to a literal, so this counts
 * reservations of one range without also asserting where that range landed —
 * that is its own test below.
 */
async function bookingsSharingRangeWith(bookingId: string): Promise<number> {
  const result = await raw.query<{ n: string }>(
    `SELECT count(*) AS n FROM booking b, booking winner
      WHERE winner.id = $1
        AND tstzrange(b.starts_at, b.buffer_ends_at, '[)')
         && tstzrange(winner.starts_at, winner.buffer_ends_at, '[)')`,
    [bookingId],
  );
  return Number(firstRow(result).n);
}

type RangeColumn = 'starts_at' | 'ends_at' | 'buffer_ends_at';

/** One column of one booking, as epoch milliseconds — no wall time anywhere. */
async function columnMs(ref: string, column: RangeColumn): Promise<number> {
  const result = await raw.query<{ ms: string }>(
    `SELECT (extract(epoch from ${column}) * 1000)::bigint AS ms
       FROM booking WHERE reference = $1`,
    [ref],
  );
  return Number(firstRow(result).ms);
}

/**
 * `hold_expires_at` as epoch milliseconds, read through the raw driver.
 *
 * Epoch milliseconds because a `timestamptz` read back through Prisma's
 * `$queryRaw` is rendered in the session timezone and re-read as UTC; asserting
 * on a value that never becomes a wall-clock string cannot inherit that fault.
 */
async function holdExpiresAtMs(ref: string): Promise<number> {
  const result = await raw.query<{ ms: string | null }>(
    `SELECT (extract(epoch from hold_expires_at) * 1000)::bigint AS ms
       FROM booking WHERE reference = $1`,
    [ref],
  );
  const ms = firstRow(result).ms;
  if (ms === null) throw new Error(`Booking ${ref} has no hold_expires_at`);
  return Number(ms);
}

const HOLD_MINUTES = 30;
const MINUTE_MS = 60_000;

// --- The headline: concurrency ----------------------------------------------

describe('claimSlot under concurrency', () => {
  it('lets exactly one of 20 simultaneous claims on one slot win', async () => {
    const ids = await insertCatalogue();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_unused, i) =>
        claimSlot(prisma, claimInput(ids, reference(i), NINE), HOLD_MINUTES),
      ),
    );

    const claimed = results.filter((r) => r.status === 'claimed');
    const taken = results.filter((r) => r.status === 'slot_taken');
    expect(claimed).toHaveLength(1);
    expect(taken).toHaveLength(19);

    // The database is the arbiter, not the count above: exactly one row may
    // reserve this range, whatever the twenty callers were told.
    const winner = claimedBooking(claimed[0]);
    await expect(bookingsSharingRangeWith(winner.id)).resolves.toBe(1);
    await expect(prisma.booking.count()).resolves.toBe(1);
  });

  it('returns a typed result rather than throwing when it loses the race', async () => {
    const ids = await insertCatalogue();
    await claimSlot(prisma, claimInput(ids, reference(1), NINE), HOLD_MINUTES);

    const loser = claimSlot(prisma, claimInput(ids, reference(2), NINE), HOLD_MINUTES);

    await expect(loser).resolves.toEqual({ status: 'slot_taken' });
  });
});

// --- The stale-hold race (data-model_v2.md §9.2) -----------------------------

describe('claimSlot and stale holds', () => {
  it('expires a lapsed overlapping hold and claims the slot, with no sweeper run', async () => {
    const ids = await insertCatalogue();
    const lapsed = new Date(Date.now() - MINUTE_MS);
    await insertBooking(ids, reference(1), NINE, 'pending_payment', lapsed);

    const result = await claimSlot(prisma, claimInput(ids, reference(2), NINE), HOLD_MINUTES);

    expect(result.status).toBe('claimed');
    await expect(statusOf(reference(1))).resolves.toBe('expired');
    await expect(statusOf(reference(2))).resolves.toBe('pending_payment');
  });

  it('refuses the slot while the overlapping hold is still live', async () => {
    const ids = await insertCatalogue();
    const live = new Date(Date.now() + 10 * MINUTE_MS);
    await insertBooking(ids, reference(1), NINE, 'pending_payment', live);

    const result = await claimSlot(prisma, claimInput(ids, reference(2), NINE), HOLD_MINUTES);

    expect(result).toEqual({ status: 'slot_taken' });
    await expect(statusOf(reference(1))).resolves.toBe('pending_payment');
    await expect(prisma.booking.count()).resolves.toBe(1);
  });

  it('leaves a lapsed hold elsewhere in the day alone', async () => {
    // §9.2 scopes step 2 to rows in the way. Expiring the whole table would be a
    // wider effect than the claim is entitled to.
    const ids = await insertCatalogue();
    const lapsed = new Date(Date.now() - MINUTE_MS);
    await insertBooking(ids, reference(1), AFTERNOON, 'pending_payment', lapsed);

    const result = await claimSlot(prisma, claimInput(ids, reference(2), NINE), HOLD_MINUTES);

    expect(result.status).toBe('claimed');
    await expect(statusOf(reference(1))).resolves.toBe('pending_payment');
  });

  it('rolls back the expiry it performed when the insert is then refused', async () => {
    const ids = await insertCatalogue();
    // Both overlap the requested range; neither overlaps the other.
    const lapsed = new Date(Date.now() - MINUTE_MS);
    await insertBooking(ids, reference(1), EIGHT, 'pending_payment', lapsed);
    await insertBooking(ids, reference(2), TEN, 'confirmed');

    const result = await claimSlot(prisma, claimInput(ids, reference(3), NINE), HOLD_MINUTES);

    expect(result).toEqual({ status: 'slot_taken' });
    // No partial row, and the stale hold is as it was: the whole step-2 UPDATE
    // went back with the transaction.
    await expect(prisma.booking.count()).resolves.toBe(2);
    await expect(statusOf(reference(1))).resolves.toBe('pending_payment');
    await expect(statusOf(reference(2))).resolves.toBe('confirmed');
  });
});

// --- Occupancy by status (data-model_v2.md §7.1) -----------------------------

describe('claimSlot and the occupancy table', () => {
  it.each(['expired', 'cancelled_by_client', 'cancelled_by_admin'])(
    'claims a slot held only by a %s booking',
    async (status) => {
      const ids = await insertCatalogue();
      await insertBooking(ids, reference(1), NINE, status);

      const result = await claimSlot(prisma, claimInput(ids, reference(2), NINE), HOLD_MINUTES);

      const booking = claimedBooking(result);
      await expect(bookingsSharingRangeWith(booking.id)).resolves.toBe(2);
      await expect(statusOf(reference(1))).resolves.toBe(status);
    },
  );

  it.each(['confirmed', 'completed', 'no_show'])(
    'refuses a slot occupied by a %s booking',
    async (status) => {
      const ids = await insertCatalogue();
      await insertBooking(ids, reference(1), NINE, status);

      const result = await claimSlot(prisma, claimInput(ids, reference(2), NINE), HOLD_MINUTES);

      expect(result).toEqual({ status: 'slot_taken' });
      await expect(prisma.booking.count()).resolves.toBe(1);
    },
  );
});

// --- Range edges -------------------------------------------------------------

describe('claimSlot and the range edges', () => {
  it('accepts a claim starting exactly at the previous buffer end', async () => {
    const ids = await insertCatalogue();
    const first = await claimSlot(prisma, claimInput(ids, reference(1), NINE), HOLD_MINUTES);
    expect(first.status).toBe('claimed');

    const second = await claimSlot(prisma, claimInput(ids, reference(2), TEN_THIRTY), HOLD_MINUTES);

    expect(second.status).toBe('claimed');
    await expect(prisma.booking.count()).resolves.toBe(2);
  });

  it('refuses a claim that overlaps only the buffer of an existing booking', async () => {
    const ids = await insertCatalogue();
    await claimSlot(prisma, claimInput(ids, reference(1), NINE), HOLD_MINUTES);

    const result = await claimSlot(prisma, claimInput(ids, reference(2), IN_BUFFER), HOLD_MINUTES);

    expect(result).toEqual({ status: 'slot_taken' });
    await expect(prisma.booking.count()).resolves.toBe(1);
  });
});

// --- The hold window ---------------------------------------------------------

describe('the hold window', () => {
  // REGRESSION. `SELECT now()` read back through $queryRaw arrives rendered in
  // the session timezone and parsed as UTC, so on a +02:00 session a 30-minute
  // hold lasted 150. A tolerance of seconds catches a fault measured in hours.
  const TOLERANCE_MS = 5_000;

  it.each([5, 30, 120])('expires ~%i minutes from now, not hours out', async (minutes) => {
    const ids = await insertCatalogue();

    const before = Date.now();
    const result = await claimSlot(prisma, claimInput(ids, reference(1), NINE), minutes);
    const after = Date.now();

    const booking = claimedBooking(result);
    expect(booking.holdExpiresAt).not.toBeNull();
    const returned = booking.holdExpiresAt?.getTime() ?? 0;
    expect(returned).toBeGreaterThanOrEqual(before + minutes * MINUTE_MS - TOLERANCE_MS);
    expect(returned).toBeLessThanOrEqual(after + minutes * MINUTE_MS + TOLERANCE_MS);

    // And the same again straight off the column, so a Prisma-side parsing
    // quirk cannot make a wrong stored value look right.
    const stored = await holdExpiresAtMs(reference(1));
    expect(stored).toBeGreaterThanOrEqual(before + minutes * MINUTE_MS - TOLERANCE_MS);
    expect(stored).toBeLessThanOrEqual(after + minutes * MINUTE_MS + TOLERANCE_MS);
  });

  it('measures the hold against the database clock, not the session rendering', async () => {
    const ids = await insertCatalogue();
    const clock = await raw.query<{ ms: string }>(
      `SELECT (extract(epoch from now()) * 1000)::bigint AS ms`,
    );
    const databaseNow = Number(firstRow(clock).ms);

    await claimSlot(prisma, claimInput(ids, reference(1), NINE), HOLD_MINUTES);

    const stored = await holdExpiresAtMs(reference(1));
    expect(stored - databaseNow).toBeGreaterThan(29 * MINUTE_MS);
    expect(stored - databaseNow).toBeLessThan(31 * MINUTE_MS);
  });
});

// --- What a claim writes -----------------------------------------------------

describe('what claimSlot writes', () => {
  it('always creates the booking as pending_payment', async () => {
    const ids = await insertCatalogue();

    const booking = claimedBooking(
      await claimSlot(prisma, claimInput(ids, reference(1), NINE), HOLD_MINUTES),
    );

    expect(booking.status).toBe('pending_payment');
    await expect(statusOf(reference(1))).resolves.toBe('pending_payment');
  });

  it('returns the range it was asked for', async () => {
    const ids = await insertCatalogue();

    const booking = claimedBooking(
      await claimSlot(prisma, claimInput(ids, reference(1), NINE), HOLD_MINUTES),
    );

    expect(booking.startsAt.toISOString()).toBe(NINE.startsAt.toISOString());
    expect(booking.endsAt.toISOString()).toBe(NINE.endsAt.toISOString());
    expect(booking.bufferEndsAt.toISOString()).toBe(NINE.bufferEndsAt.toISOString());
  });

  it('reserves that range at the instants PostgreSQL itself reads back', async () => {
    // The assertion above round-trips through Prisma, which renders and parses
    // a timestamptz with the same offset both ways: a write landing at the
    // wrong instant still reads back looking right. Epoch milliseconds, read
    // through the raw driver, is the only honest witness.
    const ids = await insertCatalogue();

    await claimSlot(prisma, claimInput(ids, reference(1), NINE), HOLD_MINUTES);

    await expect(columnMs(reference(1), 'starts_at')).resolves.toBe(NINE.startsAt.getTime());
    await expect(columnMs(reference(1), 'ends_at')).resolves.toBe(NINE.endsAt.getTime());
    await expect(columnMs(reference(1), 'buffer_ends_at')).resolves.toBe(
      NINE.bufferEndsAt.getTime(),
    );
    await expect(bookingsOverlapping(NINE)).resolves.toBe(1);
  });

  it('sends nothing when it expires a stale hold (spec §3.2)', async () => {
    const ids = await insertCatalogue();
    const lapsed = new Date(Date.now() - MINUTE_MS);
    await insertBooking(ids, reference(1), NINE, 'pending_payment', lapsed);

    await claimSlot(prisma, claimInput(ids, reference(2), NINE), HOLD_MINUTES);

    await expect(statusOf(reference(1))).resolves.toBe('expired');
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });
});

// --- Errors that are not a lost race -----------------------------------------

describe('claimSlot and errors that are not 23P01', () => {
  it('throws on a duplicate reference rather than reporting a taken slot', async () => {
    const ids = await insertCatalogue();
    await claimSlot(prisma, claimInput(ids, reference(1), NINE), HOLD_MINUTES);

    // A different, non-overlapping slot: only `reference` can fail here, with
    // 23505. Swallowing it as `slot_taken` would hide a real defect.
    const duplicate = claimSlot(prisma, claimInput(ids, reference(1), AFTERNOON), HOLD_MINUTES);

    await expect(duplicate).rejects.toThrow();
    await expect(prisma.booking.count()).resolves.toBe(1);
  });

  it('throws on a package that does not exist (23503)', async () => {
    const ids = await insertCatalogue();
    const input = claimInput(ids, reference(1), NINE);
    input.packageId = '00000000-0000-0000-0000-000000000000';

    await expect(claimSlot(prisma, input, HOLD_MINUTES)).rejects.toThrow();
    await expect(prisma.booking.count()).resolves.toBe(0);
  });

  it('throws on a value the CHECK constraints refuse (23514)', async () => {
    const ids = await insertCatalogue();
    const input = { ...claimInput(ids, reference(1), NINE), locale: 'rw' };

    await expect(claimSlot(prisma, input, HOLD_MINUTES)).rejects.toThrow();
    await expect(prisma.booking.count()).resolves.toBe(0);
  });
});

// --- The builder form (plan.md Task 13) ---------------------------------------

describe('claimSlot with an input builder', () => {
  /** A client written through the builder's transaction, as booking creation does. */
  async function insertClientThrough(tx: Prisma.TransactionClient, email: string): Promise<string> {
    const client = await tx.client.create({
      data: { fullName: 'Built Inside', email, phone: '+250788111111' },
    });
    return client.id;
  }

  it('builds the input inside the claim transaction, so a write it makes can be referenced by the booking', async () => {
    const ids = await insertCatalogue();
    const builder = vi.fn(async (tx: Prisma.TransactionClient) => ({
      ...claimInput(ids, reference(1), NINE),
      clientId: await insertClientThrough(tx, 'built@example.com'),
    }));

    const booking = claimedBooking(await claimSlot(prisma, builder, HOLD_MINUTES));

    expect(builder).toHaveBeenCalledTimes(1);
    // A transaction client, not the root client the claim was handed.
    expect(builder.mock.calls[0]?.[0]).not.toBe(prisma);
    const client = await prisma.client.findFirstOrThrow({ where: { email: 'built@example.com' } });
    expect(booking.clientId).toBe(client.id);
    expect(booking.status).toBe('pending_payment');
    await expect(statusOf(reference(1))).resolves.toBe('pending_payment');
  });

  it('rolls back what the builder wrote when the slot turns out to be taken', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, reference(1), NINE, 'confirmed');

    const result = await claimSlot(
      prisma,
      async (tx) => ({
        ...claimInput(ids, reference(2), NINE),
        clientId: await insertClientThrough(tx, 'loser@example.com'),
      }),
      HOLD_MINUTES,
    );

    expect(result).toEqual({ status: 'slot_taken' });
    await expect(prisma.client.count({ where: { email: 'loser@example.com' } })).resolves.toBe(0);
    await expect(prisma.client.count()).resolves.toBe(1);
    await expect(prisma.booking.count()).resolves.toBe(1);
  });

  /** What Prisma throws when PostgreSQL aborts a transaction as a deadlock victim. */
  const DEADLOCK = {
    name: 'PrismaClientKnownRequestError',
    code: 'P2034',
    clientVersion: '7.10.0',
    meta: {},
  };

  it('runs the whole claim again, builder included, after the database aborts it as a deadlock victim', async () => {
    const ids = await insertCatalogue();
    let attempts = 0;

    const booking = claimedBooking(
      await claimSlot(
        prisma,
        async (tx) => {
          attempts += 1;
          const clientId = await insertClientThrough(tx, `attempt-${attempts}@example.com`);
          if (attempts === 1) throw DEADLOCK;
          return { ...claimInput(ids, reference(1), NINE), clientId };
        },
        HOLD_MINUTES,
      ),
    );

    expect(attempts).toBe(2);
    // The aborted attempt's client write rolled back with it.
    await expect(prisma.client.count({ where: { email: 'attempt-1@example.com' } })).resolves.toBe(0);
    const client = await prisma.client.findFirstOrThrow({ where: { email: 'attempt-2@example.com' } });
    expect(booking.clientId).toBe(client.id);
  });

  it(`gives up after ${MAX_CLAIM_ATTEMPTS} deadlocks in a row, writing nothing`, async () => {
    await insertCatalogue();
    const clientsBefore = await prisma.client.count();
    const builder = vi.fn(async (tx: Prisma.TransactionClient) => {
      await insertClientThrough(tx, `doomed-${builder.mock.calls.length}@example.com`);
      throw DEADLOCK;
    });

    await expect(claimSlot(prisma, builder, HOLD_MINUTES)).rejects.toMatchObject({ code: 'P2034' });

    expect(builder).toHaveBeenCalledTimes(MAX_CLAIM_ATTEMPTS);
    await expect(prisma.client.count()).resolves.toBe(clientsBefore);
    await expect(prisma.booking.count()).resolves.toBe(0);
  });

  it('does not retry an error that is not contention', async () => {
    await insertCatalogue();
    const builder = vi.fn(async () => {
      throw new Error('the builder failed');
    });

    await expect(claimSlot(prisma, builder, HOLD_MINUTES)).rejects.toThrow('the builder failed');
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('rolls back the builder’s writes and the stale-hold expiry together on a lost race', async () => {
    const ids = await insertCatalogue();
    const lapsed = new Date(Date.now() - MINUTE_MS);
    await insertBooking(ids, reference(1), EIGHT, 'pending_payment', lapsed);
    await insertBooking(ids, reference(2), TEN, 'confirmed');

    const result = await claimSlot(
      prisma,
      async (tx) => ({
        ...claimInput(ids, reference(3), NINE),
        clientId: await insertClientThrough(tx, 'loser@example.com'),
      }),
      HOLD_MINUTES,
    );

    expect(result).toEqual({ status: 'slot_taken' });
    await expect(prisma.client.count({ where: { email: 'loser@example.com' } })).resolves.toBe(0);
    await expect(statusOf(reference(1))).resolves.toBe('pending_payment');
  });

  it('aborts with the builder’s own error and writes nothing when the builder throws', async () => {
    await insertCatalogue();
    const failure = new Error('the builder could not resolve its input');

    const claim = claimSlot(
      prisma,
      async (tx) => {
        await insertClientThrough(tx, 'half-done@example.com');
        throw failure;
      },
      HOLD_MINUTES,
    );

    await expect(claim).rejects.toBe(failure);
    await expect(prisma.client.count({ where: { email: 'half-done@example.com' } })).resolves.toBe(0);
    await expect(prisma.booking.count()).resolves.toBe(0);
  });

  it('does not report a builder that throws before writing anything as a taken slot', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, reference(1), NINE, 'confirmed');

    const claim = claimSlot(
      prisma,
      async () => {
        throw new RangeError('no input');
      },
      HOLD_MINUTES,
    );

    await expect(claim).rejects.toBeInstanceOf(RangeError);
    await expect(prisma.booking.count()).resolves.toBe(1);
  });

  it('expires a stale hold and sets the hold window exactly as the object form does', async () => {
    const ids = await insertCatalogue();
    const lapsed = new Date(Date.now() - MINUTE_MS);
    await insertBooking(ids, reference(1), NINE, 'pending_payment', lapsed);

    const before = Date.now();
    const booking = claimedBooking(
      await claimSlot(prisma, async () => claimInput(ids, reference(2), NINE), HOLD_MINUTES),
    );
    const after = Date.now();

    await expect(statusOf(reference(1))).resolves.toBe('expired');
    const stored = await holdExpiresAtMs(reference(2));
    expect(stored).toBeGreaterThanOrEqual(before + HOLD_MINUTES * MINUTE_MS - 5_000);
    expect(stored).toBeLessThanOrEqual(after + HOLD_MINUTES * MINUTE_MS + 5_000);
    expect(booking.startsAt.toISOString()).toBe(NINE.startsAt.toISOString());
  });

  // A single round of this race passes or fails by timing: conflicting inserts
  // under an exclusion constraint can deadlock (40P01) -- most readily on an
  // empty table, as on a fresh database -- and lock waits can outlast Prisma's
  // 5 s interactive transaction (P2028). Every loser must still be a typed
  // slot_taken, and every round must leave exactly one winner, so the race is
  // run from an empty booking table round after round until a timing-dependent
  // fault shows.
  it('lets exactly one of 10 simultaneous builder claims win, and never throws, over 5 rounds', { timeout: 300_000 }, async () => {
    const ids = await insertCatalogue();
    const outcomes: Record<string, number> = {};
    const badRounds: string[] = [];

    for (let round = 0; round < 5; round += 1) {
      await raw.query('TRUNCATE booking_addon, booking CASCADE');
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_unused, i) =>
          claimSlot(
            prisma,
            async (tx) => ({
              ...claimInput(ids, reference(i), NINE),
              clientId: await insertClientThrough(tx, `racer-${round}-${i}@example.com`),
            }),
            HOLD_MINUTES,
          ),
        ),
      );
      for (const result of results) {
        const key =
          result.status === 'fulfilled'
            ? result.value.status
            : `threw ${(result.reason as { code?: string }).code ?? String(result.reason)}`;
        outcomes[key] = (outcomes[key] ?? 0) + 1;
      }
      const winners = results.filter((r) => r.status === 'fulfilled' && r.value.status === 'claimed').length;
      const clients = await prisma.client.count({ where: { email: { startsWith: `racer-${round}-` } } });
      if (winners !== 1 || clients !== winners) badRounds.push(`round ${round}: ${winners} claimed, ${clients} clients`);
    }

    expect(Object.keys(outcomes).filter((key) => key.startsWith('threw')), JSON.stringify(outcomes)).toEqual([]);
    // One winner per round, and the nine losers left no client behind.
    expect(badRounds, JSON.stringify(outcomes)).toEqual([]);
  });
});
