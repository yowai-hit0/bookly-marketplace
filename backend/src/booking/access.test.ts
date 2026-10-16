import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import {
  type PaymentWorld,
  grantAccessToken,
  insertBooking,
  insertBookingWithToken,
  insertPayment,
  seedWorld,
} from '../test/payment-fixtures.js';
import { generateAccessToken, hashAccessToken } from './access-token.js';
import { findBookingByToken } from './access.js';

/**
 * Reaching a booking by its access token (plan.md Task 18; spec §2.2, §3.9,
 * §6.21), against real PostgreSQL.
 *
 * What is proven: a live token answers its own booking with its add-ons and
 * payments, and stamps `access_token_last_used_at` on the database clock -- and
 * stamps it only then. A token that is unknown, that has passed its expiry, or
 * that a resend replaced answers null and stamps nothing, so "wrong token" and
 * "no such booking" are one answer. A malformed token -- a quote, a NUL, 5,000
 * characters -- never reaches the database at all, proven by handing the
 * function a client that throws if it is asked anything. Two bookings never
 * answer for each other, and the lookup is by hash: the plaintext is nowhere in
 * the row.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;

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

type AccessRow = { id: string; access_token_hash: string | null; last_used: Date | null };

async function accessRows(): Promise<AccessRow[]> {
  const result = await raw.query<AccessRow>(
    'SELECT id::text, access_token_hash, access_token_last_used_at AS last_used FROM booking ORDER BY starts_at',
  );
  return result.rows;
}

async function lastUsed(bookingId: string): Promise<Date | null> {
  const rows = await accessRows();
  return rows.find((row) => row.id === bookingId)?.last_used ?? null;
}

/** A client that fails the test if the code under test asks the database anything. */
function forbiddenPrisma(): PrismaClient {
  const refuse = (): never => {
    throw new Error('The database was queried for a token that cannot be one');
  };
  return new Proxy({} as PrismaClient, {
    get: () => refuse(),
  });
}

// --- A live token -----------------------------------------------------------------------

describe('a token that addresses a booking', () => {
  it('answers that booking with its add-ons and payments', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world, { addons: ['own', 'shared'] });
    const payment = await insertPayment(prisma, booking.id, { status: 'succeeded' });

    const found = await findBookingByToken(prisma, token);

    expect(found?.id).toBe(booking.id);
    expect(found?.reference).toBe(booking.reference);
    expect(found?.addons.map((addon) => addon.nameSnapshot).sort()).toEqual(['Extra hour', 'Rush edit']);
    expect(found?.payments.map((row) => row.id)).toEqual([payment.id]);
  });

  it('stamps access_token_last_used_at, which was null before', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    expect(await lastUsed(booking.id)).toBeNull();

    await findBookingByToken(prisma, token);

    const stamped = await lastUsed(booking.id);
    expect(stamped).not.toBeNull();
    // The database clock, not the process's: within a minute of now() there.
    const { rows } = await raw.query<{ now: Date }>('SELECT now() AS now');
    expect(Math.abs((stamped as Date).getTime() - (rows[0] as { now: Date }).now.getTime())).toBeLessThan(60_000);
  });

  it('moves the stamp on every later use', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);

    await findBookingByToken(prisma, token);
    const first = await lastUsed(booking.id);
    await raw.query('SELECT pg_sleep(0.01)');
    await findBookingByToken(prisma, token);

    expect((await lastUsed(booking.id))?.getTime()).toBeGreaterThan((first as Date).getTime());
  });

  it('works for a booking in any status, not only confirmed', async () => {
    for (const status of ['confirmed', 'completed', 'no_show', 'cancelled_by_client', 'cancelled_by_admin']) {
      const { booking, token } = await insertBookingWithToken(prisma, world, { status });
      await expect(findBookingByToken(prisma, token)).resolves.toMatchObject({ id: booking.id, status });
    }
  });

  it('stores only the hash: the plaintext is in no column of the row', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);

    const row = await raw.query<{ whole: string }>('SELECT booking::text AS whole FROM booking WHERE id = $1', [booking.id]);

    expect(row.rows[0]?.whole).toContain(hashAccessToken(token));
    expect(row.rows[0]?.whole).not.toContain(token);
  });
});

// --- Tokens that address nothing ----------------------------------------------------------

describe('a token that addresses nothing answers null and stamps nothing', () => {
  it('an unknown token of the right shape', async () => {
    const { booking } = await insertBookingWithToken(prisma, world);

    await expect(findBookingByToken(prisma, generateAccessToken().token)).resolves.toBeNull();
    expect(await lastUsed(booking.id)).toBeNull();
  });

  it('a token whose expiry has passed', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world, { expiresInMinutes: -1 });

    await expect(findBookingByToken(prisma, token)).resolves.toBeNull();
    expect(await lastUsed(booking.id)).toBeNull();
  });

  it('a token superseded by a resend: the old link 404s, the new one opens', async () => {
    const { booking, token: old } = await insertBookingWithToken(prisma, world);
    const resent = await grantAccessToken(prisma, booking.id);

    await expect(findBookingByToken(prisma, old)).resolves.toBeNull();
    expect(await lastUsed(booking.id)).toBeNull();
    await expect(findBookingByToken(prisma, resent)).resolves.toMatchObject({ id: booking.id });
  });

  it('a booking that never had a token', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });

    await expect(findBookingByToken(prisma, generateAccessToken().token)).resolves.toBeNull();
    expect(await lastUsed(booking.id)).toBeNull();
  });

  it('a token with its last character changed', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    const off = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    await expect(findBookingByToken(prisma, off)).resolves.toBeNull();
    expect(await lastUsed(booking.id)).toBeNull();
  });

  it('the stored hash itself, offered as if it were the token', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);

    await expect(findBookingByToken(prisma, hashAccessToken(token))).resolves.toBeNull();
    expect(await lastUsed(booking.id)).toBeNull();
  });
});

// --- Tokens that are not tokens -----------------------------------------------------------

describe('a malformed token is refused without touching the database', () => {
  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['fifteen characters', 'a'.repeat(15)],
    ['5,000 characters', 'a'.repeat(5_000)],
    ['257 characters', 'a'.repeat(257)],
    ['a single quote', "abcdefghijklmnop' OR '1'='1"],
    ['a statement separator', 'abcdefghijklmnop;DROP TABLE booking'],
    ['a NUL character', `abcdefghijklmnop${String.fromCharCode(0)}`],
    ['a slash', 'abcdefghijklmnop/../secret'],
    ['a percent sign', 'abcdefghijklmnop%00'],
    ['whitespace', 'abcdefghijklmnop abcdefghijklmnop'],
    ['standard base64 padding', `${'a'.repeat(42)}=`],
    ['a plus sign', `${'a'.repeat(20)}+${'b'.repeat(20)}`],
  ])('%s', async (_case, token) => {
    await expect(findBookingByToken(forbiddenPrisma(), token)).resolves.toBeNull();
  });

  it('a well-formed token of the same length does reach the database, so the check above is not vacuous', async () => {
    await expect(findBookingByToken(forbiddenPrisma(), 'a'.repeat(43))).rejects.toThrow(
      'The database was queried for a token that cannot be one',
    );
  });

  it('touches nothing when a real client is handed a malformed token', async () => {
    const { booking } = await insertBookingWithToken(prisma, world);

    await expect(findBookingByToken(prisma, `${'a'.repeat(5_000)}'`)).resolves.toBeNull();

    expect(await lastUsed(booking.id)).toBeNull();
    expect(await accessRows()).toHaveLength(1);
  });
});

// --- Two bookings ------------------------------------------------------------------------

describe('two bookings', () => {
  it('never answer for each other, and each stamps only its own', async () => {
    const first = await insertBookingWithToken(prisma, world);
    const second = await insertBookingWithToken(prisma, world);

    await expect(findBookingByToken(prisma, first.token)).resolves.toMatchObject({ id: first.booking.id });
    await expect(findBookingByToken(prisma, second.token)).resolves.toMatchObject({ id: second.booking.id });

    expect(await lastUsed(first.booking.id)).not.toBeNull();
    expect(await lastUsed(second.booking.id)).not.toBeNull();
  });

  it('stamp only the one whose token was used', async () => {
    const first = await insertBookingWithToken(prisma, world);
    const second = await insertBookingWithToken(prisma, world);

    await findBookingByToken(prisma, first.token);

    expect(await lastUsed(first.booking.id)).not.toBeNull();
    expect(await lastUsed(second.booking.id)).toBeNull();
  });

  it('answer only their own add-ons and payments', async () => {
    const first = await insertBookingWithToken(prisma, world, { addons: ['own'] });
    const second = await insertBookingWithToken(prisma, world, { addons: ['shared'] });
    await insertPayment(prisma, first.booking.id, { status: 'succeeded', amountRwf: 11_111 });
    await insertPayment(prisma, second.booking.id, { status: 'succeeded', amountRwf: 22_222 });

    const found = await findBookingByToken(prisma, second.token);

    expect(found?.addons.map((addon) => addon.nameSnapshot)).toEqual(['Rush edit']);
    expect(found?.payments.map((payment) => payment.amountRwf)).toEqual([22_222]);
  });
});
