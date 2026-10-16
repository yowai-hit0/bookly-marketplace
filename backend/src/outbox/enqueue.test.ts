import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import { EMAIL_TEMPLATES, type EmailTemplate, OUTBOX_KINDS, enqueue } from './enqueue.js';

/**
 * Enqueuing (plan.md Task 14, data-model_v2.md §5.13), against real PostgreSQL:
 * "send exactly once" is the `dedupe_key` unique index, and a second enqueue is
 * success. The implementation uses ON CONFLICT DO NOTHING rather than catching
 * P2002, so these tests also pin that a duplicate inside a transaction does not
 * abort the transaction around it.
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
      await tx.service.create({ data: { slug: 'portrait', nameEn: 'Portrait' } });
      const fresh = await enqueue(tx, { ...confirmation({ clientName: 'third' }), dedupeKey: `${KEY}:resend:1` });
      return [duplicate, fresh];
    });

    expect(results).toEqual(['duplicate', 'enqueued']);
    await expect(prisma.service.count()).resolves.toBe(1);
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

  it('writes a calendar job with no template and no recipient', async () => {
    const service = await prisma.service.create({ data: { slug: 'portrait', nameEn: 'Portrait' } });
    const pkg = await prisma.package.create({
      data: { serviceId: service.id, nameEn: 'Standard', priceRwf: 40_000, photoCount: 20, durationMinutes: 60 },
    });
    const client = await prisma.client.create({
      data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' },
    });
    const booking = await prisma.booking.create({
      data: {
        reference: 'BKY-2610-00001',
        clientId: client.id,
        contactName: 'Aline Uwase',
        contactEmail: 'aline@example.com',
        contactPhone: '+250788000000',
        serviceId: service.id,
        packageId: pkg.id,
        serviceNameSnapshot: 'Portrait',
        packageNameSnapshot: 'Standard',
        packagePriceRwf: 40_000,
        packageDurationMinutes: 60,
        packagePhotoCount: 20,
        locationText: 'Kigali Heights',
        consentAt: new Date(),
        bookingFeeRate: '0.400',
        bookingFeeRwf: 16_000,
        status: 'confirmed',
        startsAt: new Date('2026-10-07T07:00:00Z'),
        endsAt: new Date('2026-10-07T08:00:00Z'),
        bufferEndsAt: new Date('2026-10-07T08:30:00Z'),
      },
    });

    await expect(
      enqueue(prisma, { kind: 'gcal_create', bookingId: booking.id, dedupeKey: `gcal_create:${booking.id}`, payload: {} }),
    ).resolves.toBe('enqueued');

    const row = await prisma.outbox.findFirstOrThrow();
    expect(row).toMatchObject({ kind: 'gcal_create', bookingId: booking.id, template: null, recipient: null });
  });

  it('does not swallow a CHECK violation as a duplicate', async () => {
    await expect(
      enqueue(prisma, {
        ...confirmation({ clientName: 'x' }),
        template: 'booking_invite' as string as EmailTemplate,
      }),
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
});
