import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { LOCKOUT_THRESHOLD } from '../auth/account-auth.js';
import { hashPassword } from '../auth/password.js';
import { issueToken } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { renderEmail } from '../email/render.js';
import { recordEarning, recordRefundDue } from '../payouts/ledger.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { expectMatchesSpec } from '../test/openapi.js';
import { PHOTOGRAPHER_EMAIL, type PaymentWorld, insertBooking, insertPayment, seedSecondPhotographer, seedWorld } from '../test/payment-fixtures.js';

/**
 * The studio's money pages over HTTP, against real PostgreSQL
 * (marketplace-spec.md R4.1, R4.5, T4.1, T4.4).
 *
 * - Earnings: every line in its state -- pending (a session fee before its
 *   shoot), payable, in a draft, paid, voided -- with its booking's id and
 *   reference, the totals of each, and the payout history; the photographer's
 *   own only.
 * - One payout: own only; another photographer's is a 404 (T4.4).
 * - The payout method: read, and changed only with the current password. A
 *   wrong or missing one is 403 and changes nothing; a wrong one counts toward
 *   the login lockout; a change retires the old row, inserts a new one and
 *   queues the security email (T4.4). Shapes are validated per kind, the MoMo
 *   number as an E.164 Rwandan number on its own network. Rate-limited.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let clock: Date;
let world: PaymentWorld;
let token: string;
let passwordHash: string;

const SECRET = 'studio-payouts-test-secret-at-least-32-chars';
const WEB_ORIGIN = 'https://bookly.example';
const PASSWORD = 'the photographer passphrase';
/** The injected clock. Fixture shoots fall on consecutive days from 5 January 2027 at 07:00 UTC. */
const NOW = new Date('2027-01-07T12:00:00.000Z');
/** Off the fixtures' days: a shoot long over, and one later today (after NOW, ending within a token's 8 hours). */
const ENDED = new Date('2026-12-01T07:00:00Z');
const ENDED_TOO = new Date('2026-12-01T12:00:00Z');
const LATER_TODAY = new Date('2027-01-07T14:00:00Z');
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const MOMO = { kind: 'momo', momoNetwork: 'mtn', momoNumber: '0788 123 456', accountName: 'Kigali Lens Ltd', currentPassword: PASSWORD };
const BANK = { kind: 'bank', bankName: 'Bank of Kigali', bankAccountNumber: '00040-0012345-67', accountName: 'Kigali Lens Ltd', currentPassword: PASSWORD };

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
  passwordHash = await hashPassword(PASSWORD);
});

afterAll(async () => {
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

function build(rateLimit?: number) {
  return createApp({
    corsOrigin: WEB_ORIGIN,
    auth: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock },
    ...(rateLimit === undefined ? {} : { rateLimits: { payoutMethodPerIp: { limit: rateLimit, windowMs: 60_000 } } }),
  });
}

beforeEach(async () => {
  await truncateAll(raw);
  clock = NOW;
  world = await seedWorld(prisma);
  const user = await prisma.appUser.update({ where: { id: world.photographerUserId }, data: { passwordHash } });
  token = (await issueToken(SECRET, 'studio', user, clock)).token;
  app = build();
});

// --- Helpers ----------------------------------------------------------------------------

const get = (path: string, bearer = token) => request(app).get(path).set('Authorization', `Bearer ${bearer}`);
const put = (body: object, bearer = token, server: Express = app) => request(server).put('/api/studio/payout-method').set('Authorization', `Bearer ${bearer}`).send(body);

/** A succeeded online fee with its earning, on a booking whose shoot starts at `startsAt` (default: a fixture day). */
async function earned(of: PaymentWorld, amountRwf: number, kind: 'booking_fee' | 'session_fee' = 'booking_fee', startsAt?: Date) {
  const booking = await insertBooking(prisma, of, { status: 'confirmed', ...(startsAt === undefined ? {} : { startsAt }) });
  const payment = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf, kind });
  await prisma.$transaction((tx) => recordEarning(tx, payment.id));
  return { booking, payment };
}

async function payoutWith(of: PaymentWorld, itemIds: string[], status: 'draft' | 'paid' | 'cancelled', amountRwf: number, reference?: string) {
  const admin = await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } });
  const method =
    (await prisma.payoutMethod.findFirst({ where: { photographerId: of.photographerId, retiredAt: null } })) ??
    (await prisma.payoutMethod.create({ data: { photographerId: of.photographerId, kind: 'momo', momoNetwork: 'mtn', momoNumber: '+250788999999', accountName: 'X' } }));
  const payout = await prisma.payout.create({
    data: {
      photographerId: of.photographerId,
      amountRwf,
      payoutMethodId: method.id,
      createdByUserId: admin.id,
      status,
      ...(status === 'paid' ? { transferReference: reference ?? 'MTN-PAID', paidAt: NOW, paidByUserId: admin.id } : {}),
      ...(status === 'cancelled' ? { cancelledAt: NOW, cancelledByUserId: admin.id } : {}),
    },
  });
  if (status !== 'cancelled') await prisma.payoutItem.updateMany({ where: { id: { in: itemIds } }, data: { payoutId: payout.id } });
  return payout;
}

async function earningOf(paymentId: string) {
  return prisma.payoutItem.findFirstOrThrow({ where: { paymentId, kind: 'earning' } });
}

async function methods() {
  return prisma.payoutMethod.findMany({ where: { photographerId: world.photographerId }, orderBy: { createdAt: 'asc' } });
}

async function failedCount() {
  return (await prisma.appUser.findUniqueOrThrow({ where: { id: world.photographerUserId } })).failedLoginCount;
}

// --- Earnings (R4.5, T4.1) ----------------------------------------------------------------

describe('GET /api/studio/earnings', () => {
  it('puts every line in its state, totals each, and links each to its booking', async () => {
    // Shoots in December (ended) and later today (not yet).
    const payable = await earned(world, 20_000, 'booking_fee', ENDED);
    const endedSession = await earned(world, 30_000, 'session_fee', ENDED_TOO);
    const pendingSession = await earned(world, 15_000, 'session_fee', LATER_TODAY);
    const inDraft = await earned(world, 8_000);
    const paid = await earned(world, 12_000);
    const voided = await earned(world, 9_000);
    await prisma.payment.update({ where: { id: voided.payment.id }, data: { status: 'refund_due' } });
    await prisma.$transaction((tx) => recordRefundDue(tx, voided.payment.id, NOW));
    const draft = await payoutWith(world, [(await earningOf(inDraft.payment.id)).id], 'draft', 8_000);
    const paidPayout = await payoutWith(world, [(await earningOf(paid.payment.id)).id], 'paid', 12_000, 'MTN-OLD');
    await payoutWith(world, [], 'cancelled', 1_000);

    const res = await get('/api/studio/earnings');

    await expectMatchesSpec(res, 'getEarnings', 200);
    const body = res.body as {
      totals: Record<string, number>;
      items: { payment: { id: string }; state: string; booking: { id: string; reference: string } }[];
      payouts: { id: string; status: string; transferReference: string | null; itemCount: number }[];
    };
    expect(body.totals).toEqual({ pendingRwf: 15_000, payableRwf: 50_000, inDraftRwf: 8_000, paidRwf: 12_000 });
    const stateOf = (paymentId: string) => body.items.find((item) => item.payment.id === paymentId)?.state;
    expect([payable, endedSession, pendingSession, inDraft, paid, voided].map((row) => stateOf(row.payment.id))).toEqual([
      'payable',
      'payable',
      'pending',
      'in_draft',
      'paid',
      'voided',
    ]);
    expect(body.items.find((item) => item.payment.id === payable.payment.id)?.booking).toMatchObject({ id: payable.booking.id, reference: payable.booking.reference });
    // The draft and the paid payout; never the cancelled one.
    expect(body.payouts.map((payout) => [payout.id, payout.status, payout.itemCount]).sort()).toEqual(
      [
        [draft.id, 'draft', 1],
        [paidPayout.id, 'paid', 1],
      ].sort(),
    );
  });

  it('a session fee moves from pending to payable once its shoot has ended (T4.1)', async () => {
    const { booking } = await earned(world, 30_000, 'session_fee', LATER_TODAY);

    expect(((await get('/api/studio/earnings')).body as { totals: { pendingRwf: number } }).totals.pendingRwf).toBe(30_000);
    clock = booking.endsAt;
    expect(((await get('/api/studio/earnings')).body as { totals: { payableRwf: number } }).totals.payableRwf).toBe(30_000);
  });

  it('shows a reversal as a negative payable line, netted into the payable total', async () => {
    const { payment } = await earned(world, 20_000);
    await payoutWith(world, [(await earningOf(payment.id)).id], 'paid', 20_000);
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'refund_due' } });
    await prisma.$transaction((tx) => recordRefundDue(tx, payment.id, NOW));
    await earned(world, 5_000);

    const body = (await get('/api/studio/earnings')).body as { totals: Record<string, number>; items: { kind: string; amountRwf: number; state: string }[] };

    expect(body.totals).toMatchObject({ payableRwf: -15_000, paidRwf: 20_000 });
    expect(body.items).toContainEqual(expect.objectContaining({ kind: 'reversal', amountRwf: -20_000, state: 'payable' }));
  });

  it('is empty for a photographer with nothing yet, and never shows another photographer’s lines (T4.4)', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    const theirs = await earned(second, 40_000);
    await payoutWith(second, [(await earningOf(theirs.payment.id)).id], 'paid', 40_000, 'THEIR-REF');

    const res = await get('/api/studio/earnings');

    expect(res.body).toEqual({ totals: { pendingRwf: 0, payableRwf: 0, inDraftRwf: 0, paidRwf: 0 }, items: [], payouts: [] });
    expect(res.text).not.toContain(theirs.payment.id);
    expect(res.text).not.toContain('THEIR-REF');
  });

  it('cash never appears (T4.1)', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', provider: 'cash', amountRwf: 30_000 });

    expect(((await get('/api/studio/earnings')).body as { items: unknown[] }).items).toEqual([]);
  });
});

describe('GET /api/studio/payouts/:id', () => {
  it('answers one of the photographer’s own payouts with its lines', async () => {
    const { payment, booking } = await earned(world, 20_000);
    const payout = await payoutWith(world, [(await earningOf(payment.id)).id], 'paid', 20_000, 'MTN-77');

    const res = await get(`/api/studio/payouts/${payout.id}`);

    await expectMatchesSpec(res, 'getStudioPayout', 200);
    expect((res.body as { payout: object }).payout).toMatchObject({
      id: payout.id,
      status: 'paid',
      amountRwf: 20_000,
      transferReference: 'MTN-77',
      items: [{ state: 'paid', booking: { id: booking.id, reference: booking.reference } }],
    });
    // Platform-internal fields never reach the studio.
    expect(res.text).not.toContain('createdBy');
    expect(res.text).not.toContain('"note"');
  });

  it('answers another photographer’s payout exactly as one that names nothing: 404 (T4.4)', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    const theirs = await earned(second, 40_000);
    const payout = await payoutWith(second, [(await earningOf(theirs.payment.id)).id], 'paid', 40_000);

    const named = await get(`/api/studio/payouts/${payout.id}`);
    const nothing = await get(`/api/studio/payouts/${UNKNOWN_ID}`);

    await expectMatchesSpec(named, 'getStudioPayout', 404);
    expect([named.status, named.body]).toEqual([nothing.status, nothing.body]);
  });

  it('answers a cancelled draft with 404, and a malformed id with 400', async () => {
    const cancelled = await payoutWith(world, [], 'cancelled', 1_000);
    expect((await get(`/api/studio/payouts/${cancelled.id}`)).status).toBe(404);
    expect((await get('/api/studio/payouts/nope')).status).toBe(400);
  });
});

// --- The payout method (R4.1, T4.4) --------------------------------------------------------

describe('GET /api/studio/payout-method', () => {
  it('is null until one is saved, then the current one only', async () => {
    const empty = await get('/api/studio/payout-method');
    await expectMatchesSpec(empty, 'getPayoutMethod', 200);
    expect(empty.body).toEqual({ payoutMethod: null });

    await put(MOMO);
    await put(BANK);

    const res = await get('/api/studio/payout-method');
    await expectMatchesSpec(res, 'getPayoutMethod', 200);
    expect((res.body as { payoutMethod: object }).payoutMethod).toMatchObject({ kind: 'bank', bankName: 'Bank of Kigali', momoNumber: null });
  });

  it('never shows another photographer’s method (T4.4)', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    await prisma.payoutMethod.create({ data: { photographerId: second.photographerId, kind: 'momo', momoNetwork: 'mtn', momoNumber: '+250788000111', accountName: 'Theirs' } });

    expect((await get('/api/studio/payout-method')).body).toEqual({ payoutMethod: null });
  });
});

describe('PUT /api/studio/payout-method', () => {
  it('saves a MoMo method as E.164, and emails the security alert (R4.1)', async () => {
    const res = await put(MOMO);

    await expectMatchesSpec(res, 'setPayoutMethod', 200);
    expect((res.body as { payoutMethod: object }).payoutMethod).toMatchObject({ kind: 'momo', momoNetwork: 'mtn', momoNumber: '+250788123456', accountName: 'Kigali Lens Ltd', bankName: null });
    const mail = await prisma.outbox.findFirstOrThrow({ where: { template: 'account_security_alert' } });
    expect(mail).toMatchObject({ recipient: PHOTOGRAPHER_EMAIL, photographerId: null });
    expect(mail.payload).toMatchObject({ variant: 'payout_method_changed', replaced: false, destination: { kind: 'momo', provider: 'mtn', last4: '3456' } });
    const rendered = renderEmail('account_security_alert', mail.payload, { webOrigin: WEB_ORIGIN });
    expect(rendered.subject).toBe('A payout method was added to your studio');
    expect(rendered.text).toContain('MTN MoMo number ending 3456');
    expect(rendered.text).not.toContain('788123456');
    expect(rendered.html).toContain(`${WEB_ORIGIN}/studio/payout-method`);
  });

  it('a change retires the old row and inserts a new one, never editing it, and says it was changed', async () => {
    const first = (await put(MOMO)).body as { payoutMethod: { id: string } };
    clock = new Date(NOW.getTime() + 60_000);

    const second = (await put(BANK)).body as { payoutMethod: { id: string } };

    expect(second.payoutMethod.id).not.toBe(first.payoutMethod.id);
    const rows = await methods();
    expect(rows.map((row) => [row.id, row.kind, row.retiredAt?.toISOString() ?? null])).toEqual([
      [first.payoutMethod.id, 'momo', clock.toISOString()],
      [second.payoutMethod.id, 'bank', null],
    ]);
    // The old row's destination is untouched: a payout built for it still names it.
    expect(rows[0]).toMatchObject({ momoNumber: '+250788123456', accountName: 'Kigali Lens Ltd' });
    const mails = await prisma.outbox.findMany({ where: { template: 'account_security_alert' }, orderBy: { createdAt: 'asc' } });
    expect(mails.map((mail) => (mail.payload as { replaced: boolean }).replaced)).toEqual([false, true]);
    expect(renderEmail('account_security_alert', mails[1]?.payload, { webOrigin: WEB_ORIGIN }).subject).toBe('Your payout method was changed');
  });

  it('keeps exactly one current method when two saves race', async () => {
    await put(MOMO);
    const results = await Promise.all([put(BANK), put({ ...MOMO, momoNumber: '0791234567' })]);

    expect(results.map((res) => res.status)).toEqual([200, 200]);
    const rows = await methods();
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.retiredAt === null)).toHaveLength(1);
  });

  it('refuses a change without the password with 403, changing and sending nothing, and counting nothing (T4.4)', async () => {
    await put(MOMO);
    const { currentPassword: _omit, ...withoutPassword } = BANK;

    for (const body of [withoutPassword, { ...BANK, currentPassword: '' }]) {
      const res = await put(body);
      await expectMatchesSpec(res, 'setPayoutMethod', 403);
      expect(res.body).toEqual({ error: 'invalid_password' });
    }

    expect((await methods()).map((row) => row.kind)).toEqual(['momo']);
    expect(await prisma.outbox.count({ where: { template: 'account_security_alert' } })).toBe(1);
    expect(await failedCount()).toBe(0);
  });

  it('refuses a wrong password with 403 and counts it toward the login lockout', async () => {
    const res = await put({ ...MOMO, currentPassword: 'not the passphrase' });

    expect([res.status, res.body]).toEqual([403, { error: 'invalid_password' }]);
    expect(await methods()).toEqual([]);
    expect(await prisma.outbox.count()).toBe(0);
    expect(await failedCount()).toBe(1);

    // The right one clears the count, as a successful login does.
    expect((await put(MOMO)).status).toBe(200);
    expect(await failedCount()).toBe(0);
  });

  it('locks after the login threshold, alerts as a lockout does, and refuses even the right password until the lock ends', async () => {
    for (let attempt = 1; attempt <= LOCKOUT_THRESHOLD; attempt += 1) {
      expect((await put({ ...MOMO, currentPassword: `wrong ${attempt}` })).body).toEqual({ error: 'invalid_password' });
    }

    const locked = await put(MOMO);
    await expectMatchesSpec(locked, 'setPayoutMethod', 403);
    expect(locked.body).toEqual({ error: 'password_locked' });
    expect(await methods()).toEqual([]);
    const alerts = await prisma.outbox.findMany({ where: { template: 'account_security_alert' } });
    expect(alerts.map((row) => (row.payload as { variant: string }).variant)).toEqual(['login_lockout']);

    // The sign-in shares the lock: the studio login is refused too.
    const login = await request(app).post('/api/studio/auth/login').send({ email: PHOTOGRAPHER_EMAIL, password: PASSWORD });
    expect(login.status).toBe(401);

    clock = new Date(NOW.getTime() + 2 * 60_000);
    expect((await put(MOMO)).status).toBe(200);
  });

  it.each<[string, object]>([
    ['a bank field on a MoMo method', { ...MOMO, bankName: 'Bank of Kigali' }],
    ['a MoMo field on a bank method', { ...BANK, momoNetwork: 'mtn' }],
    ['an unknown kind', { ...MOMO, kind: 'paypal' }],
    ['a network outside mtn and airtel', { ...MOMO, momoNetwork: 'tigo' }],
    ['no account name', { kind: 'momo', momoNetwork: 'mtn', momoNumber: '0788123456', currentPassword: PASSWORD }],
    ['an unknown field', { ...MOMO, iban: 'x' }],
  ])('refuses %s with 400', async (_label, body) => {
    const res = await put(body);
    expect([res.status, res.body]).toEqual([400, { error: 'invalid_request' }]);
    expect(await methods()).toEqual([]);
  });

  it.each<[string, object, string]>([
    ['a number from another country', { ...MOMO, momoNumber: '+254712345678' }, 'momoNumber'],
    ['a Rwandan landline', { ...MOMO, momoNumber: '+250252123456' }, 'momoNumber'],
    ['a number too short', { ...MOMO, momoNumber: '078812345' }, 'momoNumber'],
    ['an Airtel number on MTN', { ...MOMO, momoNumber: '0721234567' }, 'momoNumber'],
    ['an MTN number on Airtel', { ...MOMO, momoNetwork: 'airtel', momoNumber: '0781234567' }, 'momoNumber'],
    ['a blank account name', { ...MOMO, accountName: '   ' }, 'accountName'],
    ['an account name over 120 characters', { ...MOMO, accountName: 'x'.repeat(121) }, 'accountName'],
    ['an account number with no digit', { ...BANK, bankAccountNumber: 'ABCDEFG' }, 'bankAccountNumber'],
    ['an account number with symbols', { ...BANK, bankAccountNumber: '0004/0012' }, 'bankAccountNumber'],
    ['a blank bank name', { ...BANK, bankName: ' ' }, 'bankName'],
  ])('refuses %s with 422 naming the field, before checking the password', async (_label, body, field) => {
    const res = await put(body);

    await expectMatchesSpec(res, 'setPayoutMethod', 422);
    expect(res.body).toEqual({ error: 'validation_failed', fields: [field] });
    expect(await methods()).toEqual([]);
    expect(await failedCount()).toBe(0);
  });

  it.each([
    ['mtn', '0791234567', '+250791234567'],
    ['airtel', '+250 72 123 4567', '+250721234567'],
    ['airtel', '250731234567', '+250731234567'],
  ])('accepts a %s number typed as %s', async (network, typed, stored) => {
    const res = await put({ ...MOMO, momoNetwork: network, momoNumber: typed });
    expect([res.status, (res.body as { payoutMethod: { momoNumber: string } }).payoutMethod.momoNumber]).toEqual([200, stored]);
  });

  it('is rate-limited per address', async () => {
    const limited = build(2);

    expect((await put(MOMO, token, limited)).status).toBe(200);
    expect((await put({ ...MOMO, currentPassword: 'wrong' }, token, limited)).status).toBe(403);
    const third = await put(MOMO, token, limited);

    await expectMatchesSpec(third, 'setPayoutMethod', 429);
    expect(third.headers['retry-after']).toBeDefined();
  });

  it('refuses a platform admin’s or a client’s token: 401', async () => {
    const admin = await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } });
    const platformToken = (await issueToken(SECRET, 'platform', admin, clock)).token;

    expect((await put(MOMO, platformToken)).status).toBe(401);
    expect((await get('/api/studio/earnings', platformToken)).status).toBe(401);
    expect(await methods()).toEqual([]);
  });
});
