import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import { insertBooking, seedSecondPhotographer, seedWorld } from '../test/payment-fixtures.js';
import {
  EMAIL_TEMPLATES,
  OUTBOX_KINDS,
  RESERVED_EMAIL_TEMPLATES,
  SENDABLE_EMAIL_TEMPLATES,
  type SendableEmailTemplate,
  enqueue,
} from './enqueue.js';

/**
 * Enqueuing (plan.md Task 14, data-model_v2.md §5.13), against real PostgreSQL:
 * "send exactly once" is the `dedupe_key` unique index, and a second enqueue is
 * success. The implementation uses ON CONFLICT DO NOTHING rather than catching
 * P2002, so these tests also pin that a duplicate inside a transaction does not
 * abort the transaction around it.
 *
 * Every row is filed under its booking's photographer (marketplace-data-model.md
 * §2.14), and a row with no booking may be filed under one explicitly.
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

const KEY = 'email:booking_confirmation:00000000-0000-0000-0000-000000000001';

function confirmation(payload: { clientName: string }) {
  return {
    kind: 'email' as const,
    template: 'booking_confirmation' as const,
    recipient: 'aline@example.com',
    dedupeKey: KEY,
    payload,
  };
}

describe('enqueue', () => {
  it('inserts a pending row with the message fields, due now', async () => {
    await expect(enqueue(prisma, confirmation({ clientName: 'Aline' }))).resolves.toBe('enqueued');

    const rows = await prisma.outbox.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'email',
      template: 'booking_confirmation',
      recipient: 'aline@example.com',
      dedupeKey: KEY,
      payload: { clientName: 'Aline' },
      bookingId: null,
      status: 'pending',
      attempts: 0,
      lastError: null,
      providerMessageId: null,
      completedAt: null,
    });
    const due = firstRow(
      await raw.query<{ lag: number }>(`SELECT extract(epoch FROM now() - next_attempt_at)::float AS lag FROM outbox`),
    );
    expect(due.lag).toBeGreaterThanOrEqual(0);
    expect(due.lag).toBeLessThan(5);
  });

  it('inserts one row for two enqueues of one dedupe_key: enqueued, then duplicate', async () => {
    await expect(enqueue(prisma, confirmation({ clientName: 'first' }))).resolves.toBe('enqueued');
    await expect(enqueue(prisma, confirmation({ clientName: 'second' }))).resolves.toBe('duplicate');

    const rows = await prisma.outbox.findMany();
    expect(rows).toHaveLength(1);
    // The message already on its way is the one that stands.
    expect(rows[0]?.payload).toEqual({ clientName: 'first' });
  });

  it('does not reset a row already delivered or failed when the key is enqueued again', async () => {
    await enqueue(prisma, confirmation({ clientName: 'first' }));
    await raw.query(`UPDATE outbox SET status = 'failed', attempts = 8, last_error = 'boom'`);

    await expect(enqueue(prisma, confirmation({ clientName: 'second' }))).resolves.toBe('duplicate');

    const row = await prisma.outbox.findFirstOrThrow();
    expect(row).toMatchObject({ status: 'failed', attempts: 8, lastError: 'boom', payload: { clientName: 'first' } });
  });

  it('treats a duplicate inside a transaction as success: the transaction still commits its other writes', async () => {
    await enqueue(prisma, confirmation({ clientName: 'first' }));

    const results = await prisma.$transaction(async (tx) => {
      const duplicate = await enqueue(tx, confirmation({ clientName: 'second' }));
      // A write after the conflict: a caught 23505 would have aborted the
      // transaction and this statement would fail with 25P02.
      await tx.client.create({ data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' } });
      const fresh = await enqueue(tx, { ...confirmation({ clientName: 'third' }), dedupeKey: `${KEY}:resend:1` });
      return [duplicate, fresh];
    });

    expect(results).toEqual(['duplicate', 'enqueued']);
    await expect(prisma.client.count()).resolves.toBe(1);
    const rows = await prisma.outbox.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => [row.dedupeKey, row.payload])).toEqual(
      expect.arrayContaining([
        [KEY, { clientName: 'first' }],
        [`${KEY}:resend:1`, { clientName: 'third' }],
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it('reports duplicate for a second enqueue of the same key within one transaction', async () => {
    const results = await prisma.$transaction(async (tx) => [
      await enqueue(tx, confirmation({ clientName: 'first' })),
      await enqueue(tx, confirmation({ clientName: 'second' })),
    ]);

    expect(results).toEqual(['enqueued', 'duplicate']);
    const rows = await prisma.outbox.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ clientName: 'first' });
  });

  it('rolls the message back with the transaction that enqueued it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueue(tx, confirmation({ clientName: 'first' }));
        throw new Error('the booking change failed');
      }),
    ).rejects.toThrow('the booking change failed');

    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('inserts exactly one row when the same key is enqueued concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => enqueue(prisma, confirmation({ clientName: `racer ${i}` }))),
    );

    expect(results.filter((result) => result === 'enqueued')).toHaveLength(1);
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(5);
    await expect(prisma.outbox.count()).resolves.toBe(1);
  });

  it("writes a calendar job with no template and no recipient, filed under the booking's photographer", async () => {
    const world = await seedWorld(prisma);
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });

    await expect(
      enqueue(prisma, { kind: 'gcal_create', bookingId: booking.id, dedupeKey: `gcal_create:${booking.id}`, payload: {} }),
    ).resolves.toBe('enqueued');

    const row = await prisma.outbox.findFirstOrThrow();
    expect(row).toMatchObject({
      kind: 'gcal_create',
      bookingId: booking.id,
      photographerId: world.photographerId,
      template: null,
      recipient: null,
    });
  });

  it.each(['booking_invite', 'admin_alert', 'admin_new_booking'])(
    'does not swallow a CHECK violation as a duplicate: %s is refused',
    async (template) => {
      await expect(
        enqueue(prisma, {
          ...confirmation({ clientName: 'x' }),
          template: template as string as SendableEmailTemplate,
        }),
      ).rejects.toThrow();
      await expect(prisma.outbox.count()).resolves.toBe(0);
    },
  );
});

describe('enqueue and the photographer a row is filed under', () => {
  it("takes an email's photographer from its booking", async () => {
    const world = await seedWorld(prisma);
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });

    await enqueue(prisma, { ...confirmation({ clientName: 'Aline' }), bookingId: booking.id });

    await expect(prisma.outbox.findFirstOrThrow()).resolves.toMatchObject({ bookingId: booking.id, photographerId: world.photographerId });
  });

  it("takes each booking's own photographer when two studios book at once", async () => {
    const first = await seedWorld(prisma);
    const second = await seedSecondPhotographer(prisma, first);
    const ours = await insertBooking(prisma, first, { status: 'confirmed' });
    const theirs = await insertBooking(prisma, second, { status: 'confirmed' });

    await enqueue(prisma, { ...confirmation({ clientName: 'Aline' }), bookingId: ours.id, dedupeKey: `${KEY}:ours` });
    await enqueue(prisma, { ...confirmation({ clientName: 'Aline' }), bookingId: theirs.id, dedupeKey: `${KEY}:theirs` });

    const rows = await prisma.outbox.findMany();
    expect(Object.fromEntries(rows.map((row) => [row.dedupeKey, row.photographerId]))).toEqual({
      [`${KEY}:ours`]: first.photographerId,
      [`${KEY}:theirs`]: second.photographerId,
    });
  });

  it('accepts a booking and the same photographer named explicitly', async () => {
    const world = await seedWorld(prisma);
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });

    await expect(
      enqueue(prisma, { ...confirmation({ clientName: 'Aline' }), bookingId: booking.id, photographerId: world.photographerId }),
    ).resolves.toBe('enqueued');
  });

  it("refuses a booking with another photographer named, enqueuing nothing: one studio's mail is never filed under another", async () => {
    const first = await seedWorld(prisma);
    const second = await seedSecondPhotographer(prisma, first);
    const booking = await insertBooking(prisma, first, { status: 'confirmed' });

    await expect(
      enqueue(prisma, { ...confirmation({ clientName: 'Aline' }), bookingId: booking.id, photographerId: second.photographerId }),
    ).rejects.toThrow(/names a photographer other than its booking's/);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('files a booking-less message under the photographer it names, such as a photographer alert', async () => {
    const world = await seedWorld(prisma);

    await enqueue(prisma, {
      kind: 'email',
      template: 'photographer_alert',
      recipient: 'photographer@bookly.example',
      photographerId: world.photographerId,
      dedupeKey: 'email:photographer_alert:test',
      payload: {},
    });

    await expect(prisma.outbox.findFirstOrThrow()).resolves.toMatchObject({ bookingId: null, photographerId: world.photographerId });
  });

  it('files platform and account mail under no photographer', async () => {
    await enqueue(prisma, { ...confirmation({ clientName: 'Aline' }), template: 'account_password_reset' });

    await expect(prisma.outbox.findFirstOrThrow()).resolves.toMatchObject({ bookingId: null, photographerId: null });
  });

  it('leaves a booking that does not exist to the foreign key', async () => {
    await expect(
      enqueue(prisma, { ...confirmation({ clientName: 'Aline' }), bookingId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow();
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });
});

describe('the vocabularies and the CHECK constraints', () => {
  async function allowedValues(constraint: string): Promise<string[]> {
    const result = await raw.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [constraint],
    );
    return [...firstRow(result).def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] ?? '').sort();
  }

  it('OUTBOX_KINDS is exactly outbox_kind_allowed', async () => {
    expect(await allowedValues('outbox_kind_allowed')).toEqual([...OUTBOX_KINDS].sort());
  });

  it('EMAIL_TEMPLATES is exactly outbox_template_allowed', async () => {
    expect(await allowedValues('outbox_template_allowed')).toEqual([...EMAIL_TEMPLATES].sort());
  });

  it('splits it into the sendable templates and the names reserved for later phases, with no overlap', () => {
    expect([...SENDABLE_EMAIL_TEMPLATES, ...RESERVED_EMAIL_TEMPLATES].sort()).toEqual([...EMAIL_TEMPLATES].sort());
    expect(SENDABLE_EMAIL_TEMPLATES.filter((template) => (RESERVED_EMAIL_TEMPLATES as readonly string[]).includes(template))).toEqual([]);
    expect(EMAIL_TEMPLATES).toHaveLength(24);
    // Phase 4 makes payout_sent sendable (R4.4); the subscription names stay reserved for Phase 5.
    expect(SENDABLE_EMAIL_TEMPLATES).toHaveLength(21);
    expect(RESERVED_EMAIL_TEMPLATES).toEqual(['subscription_reminder', 'subscription_receipt', 'subscription_expired']);
  });

  it('has retired admin_alert and admin_new_booking (marketplace-data-model.md §2.14)', () => {
    expect(EMAIL_TEMPLATES).not.toContain('admin_alert');
    expect(EMAIL_TEMPLATES).not.toContain('admin_new_booking');
    expect(EMAIL_TEMPLATES).toEqual(
      expect.arrayContaining(['photographer_alert', 'platform_alert', 'photographer_new_booking', 'account_password_reset', 'account_security_alert']),
    );
  });
});
