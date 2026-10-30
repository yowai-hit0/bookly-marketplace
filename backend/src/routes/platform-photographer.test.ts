import type { AppUser, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { issueToken } from '../auth/token.js';
import { BOOKING_STATUSES } from '../db/statuses.js';
import { createPrismaClient } from '../db/client.js';
import { recordEarning } from '../payouts/ledger.js';
import { PHOTOGRAPHER_ACTIVITY_LIMIT } from '../platform/audit.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { seedStarterCategories } from '../test/directory-fixtures.js';
import { expectMatchesSpec } from '../test/openapi.js';
import {
  PHOTOGRAPHER_EMAIL,
  PHOTOGRAPHER_HANDLE,
  PHOTOGRAPHER_NAME,
  PLATFORM_ADMIN_EMAIL,
  type PaymentWorld,
  createPhotographer,
  insertBooking,
  insertPayment,
  seedSecondPhotographer,
  seedWorld,
} from '../test/payment-fixtures.js';

/**
 * `GET /api/platform/photographers/:id` (Phase 9 unit P4): one photographer,
 * in full, for the console's detail page -- the moderation record and who
 * approved them, the profile with every category (inactive marked), the setup
 * checklist, the subscription with its periods, the payout method MASKED with
 * its 72-hour flag, bookings by status and services, earnings, and the latest
 * 20 audit rows about them. Never a credential, never the full payout number.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let clock: Date;
let world: PaymentWorld;
let admin: AppUser;
let token: string;

const SECRET = 'platform-photographer-test-secret-at-least-32-chars';
const WEB_ORIGIN = 'https://bookly.example';
/** After every fixture shoot (January 2027 onwards) has ended. */
const NOW = new Date('2027-12-01T08:00:00.000Z');
const HOUR_MS = 3_600_000;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const MOMO_NUMBER = '+250788123456';

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
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await truncateAll(raw);
  clock = NOW;
  world = await seedWorld(prisma);
  admin = await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } });
  token = (await issueToken(SECRET, 'platform', admin, clock)).token;
  app = createApp({ corsOrigin: WEB_ORIGIN, auth: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock } });
});

const get = (path: string, bearer = token) => request(app).get(path).set('Authorization', `Bearer ${bearer}`);
const post = (path: string, body?: object) => {
  const req = request(app).post(path).set('Authorization', `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
};
const detail = (id: string) => get(`/api/platform/photographers/${id}`);

async function earned(of: PaymentWorld, amountRwf: number) {
  const booking = await insertBooking(prisma, of, { status: 'completed' });
  const payment = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf });
  await prisma.$transaction((tx) => recordEarning(tx, payment.id));
}

async function momoMethod(createdAt: Date) {
  return prisma.payoutMethod.create({
    data: { photographerId: world.photographerId, kind: 'momo', momoNetwork: 'mtn', momoNumber: MOMO_NUMBER, accountName: 'Kigali Lens Ltd', createdAt },
  });
}

describe('GET /api/platform/photographers/:id', () => {
  it('answers everything the detail page shows, in the spec’s shape', async () => {
    const categories = await seedStarterCategories(prisma);
    await prisma.photographer.update({
      where: { id: world.photographerId },
      data: {
        bio: 'Portraits around Kigali.',
        contactPhone: '+250788000111',
        whatsappPhone: '+250788000222',
        contactEmail: 'hello@kigali-lens.example',
        coverImageUrl: 'https://images.example.com/cover.jpg',
        submittedAt: new Date('2026-09-01T09:00:00Z'),
        approvedByUserId: admin.id,
      },
    });
    await prisma.photographerDistrict.createMany({ data: ['nyarugenge', 'gasabo'].map((districtCode) => ({ photographerId: world.photographerId, districtCode })) });
    await prisma.photographerCategory.createMany({
      data: ['wedding', 'event'].map((slug) => ({ photographerId: world.photographerId, categoryId: categories.get(slug) ?? '' })),
    });
    await prisma.category.update({ where: { slug: 'event' }, data: { isActive: false } });
    await prisma.workingHours.create({ data: { photographerId: world.photographerId, weekday: 1, opensMinute: 540, closesMinute: 1020 } });
    const method = await momoMethod(new Date(NOW.getTime() - 30 * 24 * HOUR_MS));
    await prisma.service.create({ data: { photographerId: world.photographerId, slug: 'retired', nameEn: 'Retired', isActive: false } });
    await insertBooking(prisma, world, { status: 'confirmed' });
    await insertBooking(prisma, world, { status: 'cancelled_by_client' });
    // Earnings: 20,000 paid out, 7,000 in a draft, 5,000 payable now.
    await earned(world, 20_000);
    const paid = await post('/api/platform/payouts', { photographerId: world.photographerId });
    await post(`/api/platform/payouts/${paid.body.payout.id}/mark-paid`, { transferReference: 'TX-1' });
    await earned(world, 7_000);
    clock = new Date(NOW.getTime() + 60_000);
    await post('/api/platform/payouts', { photographerId: world.photographerId });
    await earned(world, 5_000);

    const res = await detail(world.photographerId);

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'getPlatformPhotographer', 200);
    const body = res.body;
    expect(body.photographer).toMatchObject({
      id: world.photographerId,
      handle: PHOTOGRAPHER_HANDLE,
      displayName: PHOTOGRAPHER_NAME,
      email: PHOTOGRAPHER_EMAIL,
      status: 'approved',
      submittedAt: '2026-09-01T09:00:00.000Z',
      handleChangedAt: null,
      approvedAt: '2026-09-02T06:00:00.000Z',
      approvedByUserId: admin.id,
      approvedBy: { id: admin.id, email: PLATFORM_ADMIN_EMAIL },
      suspendedAt: null,
      suspensionReason: null,
    });
    expect(body.profile).toEqual({
      bio: 'Portraits around Kigali.',
      contactPhone: '+250788000111',
      whatsappPhone: '+250788000222',
      contactEmail: 'hello@kigali-lens.example',
      coverImageUrl: 'https://images.example.com/cover.jpg',
      // In the migration's order, as the public profile lists them.
      districts: expect.arrayContaining([
        { code: 'gasabo', name: 'Gasabo' },
        { code: 'nyarugenge', name: 'Nyarugenge' },
      ]),
      // Every category they have, the inactive one marked: the public sees only Wedding.
      categories: [
        { slug: 'wedding', name: 'Wedding', isActive: true },
        { slug: 'event', name: 'Event', isActive: false },
      ],
    });
    expect(body.profile.districts).toHaveLength(2);
    expect(body.setup).toEqual({
      items: [
        { key: 'profile', done: true },
        { key: 'categories', done: true },
        { key: 'districts', done: true },
        { key: 'payoutMethod', done: true },
        { key: 'services', done: true },
        { key: 'workingHours', done: true },
      ],
      missing: [],
      canSubmit: false,
    });
    expect(body.subscription).toMatchObject({
      status: 'trialing',
      currentPeriodEndsAt: '2100-01-01T00:00:00.000Z',
      takingBookings: true,
      photographer: { id: world.photographerId, handle: PHOTOGRAPHER_HANDLE, status: 'approved' },
      periods: [{ kind: 'trial', priceRwf: 0, planInterval: null, startsAt: '2026-09-02T06:00:00.000Z', endsAt: '2100-01-01T00:00:00.000Z', paidAt: null }],
    });
    expect(body.payoutMethod).toEqual({
      id: method.id,
      kind: 'momo',
      provider: 'mtn',
      accountName: 'Kigali Lens Ltd',
      last4: '3456',
      createdAt: method.createdAt.toISOString(),
    });
    expect(body.methodChangedRecently).toBe(false);
    expect(body.counts).toEqual({
      bookings: { ...Object.fromEntries(BOOKING_STATUSES.map((status) => [status, 0])), confirmed: 1, cancelled_by_client: 1, completed: 3 },
      services: { total: 2, active: 1 },
    });
    expect(body.earnings).toEqual({ payableRwf: 5_000, inDraftRwf: 7_000, paidOutRwf: 20_000 });
    expect(body.activity.map((entry: { action: string }) => entry.action)).toEqual(['payout_created', 'payout_paid', 'payout_created']);
    expect(body.activity[0]).toMatchObject({ actor: { id: admin.id, email: PLATFORM_ADMIN_EMAIL }, photographer: { id: world.photographerId } });
    // The full payout number is the payouts screen's, never this page's.
    expect(res.text).not.toContain(MOMO_NUMBER);
    expect(res.text).not.toContain('788123456');
  });

  it('a photographer still setting up: no subscription, approval, method or bookings, the checklist’s missing items', async () => {
    const pending = await createPhotographer(prisma, { email: 'new@bookly.example', handle: 'new-lens', displayName: 'New Lens', status: 'pending' });

    const res = await detail(pending.photographerId);

    await expectMatchesSpec(res, 'getPlatformPhotographer', 200);
    expect(res.body).toMatchObject({
      photographer: { status: 'pending', submittedAt: null, approvedAt: null, approvedByUserId: null, approvedBy: null },
      profile: { bio: null, contactPhone: null, whatsappPhone: null, contactEmail: null, coverImageUrl: null, districts: [], categories: [] },
      setup: { missing: ['profile', 'categories', 'districts', 'payoutMethod', 'services', 'workingHours'], canSubmit: false },
      subscription: null,
      payoutMethod: null,
      methodChangedRecently: false,
      counts: { bookings: Object.fromEntries(BOOKING_STATUSES.map((status) => [status, 0])), services: { total: 0, active: 0 } },
      earnings: { payableRwf: 0, inDraftRwf: 0, paidOutRwf: 0 },
      activity: [],
    });
  });

  it('flags a method saved within the last 72 hours, and not one older (R4.1)', async () => {
    await momoMethod(new Date(NOW.getTime() - 71 * HOUR_MS));
    expect((await detail(world.photographerId)).body.methodChangedRecently).toBe(true);
    clock = new Date(NOW.getTime() + 2 * HOUR_MS);
    expect((await detail(world.photographerId)).body.methodChangedRecently).toBe(false);
  });

  it('masks a bank account to its bank and last four digits, and shows only the current method', async () => {
    await prisma.payoutMethod.create({
      data: { photographerId: world.photographerId, kind: 'momo', momoNetwork: 'airtel', momoNumber: '+250731234567', accountName: 'Old', createdAt: new Date('2027-01-01T00:00:00Z'), retiredAt: new Date('2027-02-01T00:00:00Z') },
    });
    await prisma.payoutMethod.create({
      data: { photographerId: world.photographerId, kind: 'bank', bankName: 'Bank of Kigali', bankAccountNumber: '00040-0123456-78', accountName: 'Kigali Lens Ltd', createdAt: new Date('2027-02-01T00:00:00Z') },
    });

    const res = await detail(world.photographerId);

    expect(res.body.payoutMethod).toMatchObject({ kind: 'bank', provider: 'Bank of Kigali', accountName: 'Kigali Lens Ltd', last4: '5678' });
    expect(res.text).not.toContain('0123456');
    expect(res.text).not.toContain('731234567');
  });

  it('shows a suspension with its reason and the status at the clock of a lapsed subscription', async () => {
    await prisma.subscription.update({ where: { photographerId: world.photographerId }, data: { currentPeriodEndsAt: new Date(NOW.getTime() - 2 * 24 * HOUR_MS) } });
    await post(`/api/platform/photographers/${world.photographerId}/suspend`, { reason: 'Unpaid clients' });

    const res = await detail(world.photographerId);

    expect(res.body.photographer).toMatchObject({ status: 'suspended', suspendedAt: NOW.toISOString(), suspensionReason: 'Unpaid clients' });
    // Stored `trialing`, but its period ended two days ago: past due at the clock, and not taking bookings.
    expect(res.body.subscription).toMatchObject({ status: 'past_due', takingBookings: false });
  });

  it('lists the latest 20 audit rows about this photographer only, newest first', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    await prisma.platformAudit.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        actorUserId: admin.id,
        action: 'photographer_suspended',
        targetType: 'photographer',
        targetId: world.photographerId,
        photographerId: world.photographerId,
        details: { n: i },
        createdAt: new Date(NOW.getTime() - (25 - i) * 60_000),
      })),
    });
    await prisma.platformAudit.create({
      data: { actorUserId: admin.id, action: 'photographer_suspended', targetType: 'photographer', targetId: second.photographerId, photographerId: second.photographerId, createdAt: NOW },
    });

    const activity = (await detail(world.photographerId)).body.activity as { details: { n: number }; photographer: { id: string } }[];

    expect(activity).toHaveLength(PHOTOGRAPHER_ACTIVITY_LIMIT);
    expect(activity.map((entry) => entry.details.n)).toEqual(Array.from({ length: 20 }, (_, i) => 24 - i));
    expect(new Set(activity.map((entry) => entry.photographer.id))).toEqual(new Set([world.photographerId]));
  });

  it('never answers a password hash, a token hash or a Google subject', async () => {
    await prisma.appUser.update({
      where: { id: world.photographerUserId },
      data: { passwordHash: 'argon2-secret-hash-value', passwordResetTokenHash: 'a'.repeat(64), passwordResetExpiresAt: new Date(NOW.getTime() + HOUR_MS) },
    });
    const text = (await detail(world.photographerId)).text;
    for (const secret of ['argon2-secret-hash-value', 'a'.repeat(64), 'passwordHash', 'TokenHash', 'googleSub', 'tokenVersion']) expect(text).not.toContain(secret);
  });

  it('answers 404 for an id that names nobody, 400 for one that is not a uuid, and 401 for a studio token', async () => {
    const res = await detail(UNKNOWN_ID);
    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
    await expectMatchesSpec(res, 'getPlatformPhotographer', 404);
    expect((await detail(PHOTOGRAPHER_HANDLE)).status).toBe(400);
    const user = await prisma.appUser.findUniqueOrThrow({ where: { id: world.photographerUserId } });
    expect((await get(`/api/platform/photographers/${world.photographerId}`, (await issueToken(SECRET, 'studio', user, clock)).token)).status).toBe(401);
  });
});
