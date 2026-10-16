import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { createPrismaClient } from './client.js';

/**
 * Proves the generated client actually reaches the schema the migration built:
 * Prisma 7 takes its connection through a driver adapter, so a client that
 * generates cleanly can still be wired to nothing.
 */

let prisma: PrismaClient;
let raw: Awaited<ReturnType<typeof openRaw>>;

async function openRaw() {
  const client = connect();
  await client.connect();
  return client;
}

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = await openRaw();
});

afterAll(async () => {
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
});

async function seedBooking(startsAt: Date, endsAt: Date, bufferEndsAt: Date, reference: string) {
  const service = await prisma.service.create({
    data: { slug: 'portrait', nameEn: 'Portrait' },
  });
  const pkg = await prisma.package.create({
    data: {
      serviceId: service.id,
      nameEn: 'Standard',
      priceRwf: 40000,
      photoCount: 20,
      durationMinutes: 60,
    },
  });
  const client = await prisma.client.create({
    data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' },
  });

  return prisma.booking.create({
    data: {
      reference,
      clientId: client.id,
      serviceId: service.id,
      packageId: pkg.id,
      contactName: 'Aline Uwase',
      contactEmail: 'aline@example.com',
      contactPhone: '+250788000000',
      serviceNameSnapshot: 'Portrait',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 40000,
      packageDurationMinutes: 60,
      packagePhotoCount: 20,
      status: 'confirmed',
      startsAt,
      endsAt,
      bufferEndsAt,
      locationText: 'Kigali Heights',
      consentAt: new Date(),
      bookingFeeRate: '0.400',
      bookingFeeRwf: 16000,
    },
  });
}

const NINE = new Date('2026-10-07T07:00:00Z');
const TEN = new Date('2026-10-07T08:00:00Z');
const TEN_THIRTY = new Date('2026-10-07T08:30:00Z');
const ELEVEN = new Date('2026-10-07T09:00:00Z');
const ELEVEN_THIRTY = new Date('2026-10-07T09:30:00Z');

describe('the generated client', () => {
  it('writes and reads a booking through the camelCase mapping', async () => {
    const booking = await seedBooking(NINE, TEN, TEN_THIRTY, 'BKY-2610-AAAAA');

    expect(booking.reference).toBe('BKY-2610-AAAAA');
    expect(booking.status).toBe('confirmed');
    expect(booking.bufferEndsAt.toISOString()).toBe(TEN_THIRTY.toISOString());
    // Rates arrive as Decimal objects, never number (data-model_v2.md 2.1).
    expect(booking.bookingFeeRate.toString()).toBe('0.4');
    // updated_at has a database default, so raw SQL writes work too.
    expect(booking.updatedAt).toBeInstanceOf(Date);
  });

  it('surfaces the exclusion constraint rather than silently double-booking', async () => {
    const first = await seedBooking(NINE, TEN, TEN_THIRTY, 'BKY-2610-AAAAA');

    const overlapping = prisma.booking.create({
      data: {
        reference: 'BKY-2610-BBBBB',
        contactName: 'Eric Habimana',
        contactEmail: 'eric@example.com',
        contactPhone: '+250788111111',
        serviceNameSnapshot: 'Portrait',
        packageNameSnapshot: 'Standard',
        packagePriceRwf: 40000,
        packageDurationMinutes: 60,
        packagePhotoCount: 20,
        status: 'confirmed',
        locationText: 'Kigali Heights',
        bookingFeeRwf: 16000,
        clientId: first.clientId,
        serviceId: first.serviceId,
        packageId: first.packageId,
        startsAt: TEN,
        endsAt: ELEVEN,
        bufferEndsAt: ELEVEN_THIRTY,
        consentAt: new Date(),
        bookingFeeRate: '0.400',
      },
    });

    // Task 6 turns this into a typed "slot taken" result. Here we only prove the
    // database refuses the write and names 23P01 in what Prisma throws.
    await expect(overlapping).rejects.toThrow(/23P01|exclusion|conflicting key/i);

    const count = await prisma.booking.count();
    expect(count).toBe(1);
  });
});
