import type { AppUser, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { issueToken } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { recordEarning } from '../payouts/ledger.js';
import { approvePhotographer } from '../photographers/moderation.js';
import { AUDIT_PAGE_SIZE, PLATFORM_AUDIT_ACTIONS } from '../platform/audit.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { expectMatchesSpec } from '../test/openapi.js';
import {
  CLIENT,
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
 * The platform's audit trail (marketplace-spec.md R9.4; Phase 9 decision 1,
 * units P1 and P2), over HTTP against real PostgreSQL:
 *
 * - every platform action that changes something writes exactly one
 *   `platform_audit` row (two for a category rename-and-deactivate, tested in
 *   platform-categories.test.ts), naming the admin, the target and the
 *   photographer, with details of ids, statuses, amounts, references and
 *   reasons only, and one structured log line once it commits;
 * - a refused action (409, 422), an idempotent no-op and a failed action
 *   write nothing: the row is in the action's own transaction;
 * - no row ever carries a password hash, a token, a login email, a full
 *   payout number, a payout's internal note or a client's personal data;
 * - `GET /api/platform/audit`: newest first, filtered, paginated 50 at a time,
 *   its query validated, its shape the spec's.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let clock: Date;
let world: PaymentWorld;
let admin: AppUser;
let token: string;
/** The structured log lines, captured from stdout. */
let logged: Record<string, unknown>[];

const SECRET = 'platform-audit-test-secret-at-least-32-characters';
const WEB_ORIGIN = 'https://bookly.example';
/** After every fixture shoot (January 2027 onwards) has ended, so session fees are payable too. */
const NOW = new Date('2027-12-01T08:00:00.000Z');
const MOMO_NUMBER = '+250788123456';
const NOTE = 'Sent from the Equity account, ask Jean';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

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
  clock = NOW;
  world = await seedWorld(prisma);
  admin = await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } });
  token = (await issueToken(SECRET, 'platform', admin, clock)).token;
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line === 'string' && line.startsWith('{')) logged.push(JSON.parse(line) as Record<string, unknown>);
  });
  app = createApp({ corsOrigin: WEB_ORIGIN, auth: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock } });
});

// --- Helpers ----------------------------------------------------------------------------

const auth = (req: request.Test, bearer = token) => req.set('Authorization', `Bearer ${bearer}`);
const get = (path: string, bearer = token) => auth(request(app).get(path), bearer);
const post = (path: string, body?: object) => (body === undefined ? auth(request(app).post(path)) : auth(request(app).post(path)).send(body));
const patch = (path: string, body: object) => auth(request(app).patch(path)).send(body);

/** Moves the clock a minute on, so rows written by successive actions sort in the order they were made. */
function step(): void {
  clock = new Date(clock.getTime() + 60_000);
}

function auditRows() {
  return prisma.platformAudit.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}

/** The row's fields that matter, compared whole. */
async function audited() {
  return (await auditRows()).map((row) => ({
    action: row.action,
    actorUserId: row.actorUserId,
    targetType: row.targetType,
    targetId: row.targetId,
    photographerId: row.photographerId,
    details: row.details,
    createdAt: row.createdAt,
  }));
}

function actionLines() {
  return logged.filter((line) => line.event === 'platform_action');
}

async function pendingPhotographer({ submitted = true } = {}): Promise<string> {
  return (
    await createPhotographer(prisma, {
      email: 'pending.audit@bookly.example',
      handle: 'pending-audit',
      displayName: 'Pending Audit',
      status: 'pending',
      ...(submitted ? { submittedAt: new Date('2027-11-30T09:00:00Z') } : {}),
    })
  ).photographerId;
}

/** A succeeded online fee with its earning, as the webhook leaves them. */
async function earned(amountRwf: number) {
  const booking = await insertBooking(prisma, world, { status: 'confirmed' });
  const payment = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf });
  await prisma.$transaction((tx) => recordEarning(tx, payment.id));
  return { booking, payment };
}

async function giveMethod() {
  return prisma.payoutMethod.create({
    data: { photographerId: world.photographerId, kind: 'momo', momoNetwork: 'mtn', momoNumber: MOMO_NUMBER, accountName: 'Kigali Lens Ltd', createdAt: new Date('2027-10-01T00:00:00Z') },
  });
}

async function draft(): Promise<string> {
  const res = await post('/api/platform/payouts', { photographerId: world.photographerId });
  expect(res.status, res.text).toBe(201);
  return (res.body as { payout: { id: string } }).payout.id;
}

// --- P1: what each action writes ---------------------------------------------------------

describe('moderation writes its audit row in the same transaction (P1)', () => {
  it('approve: one row with the trial it started, one log line, and nothing for a repeat', async () => {
    const id = await pendingPhotographer();

    expect((await post(`/api/platform/photographers/${id}/approve`)).status).toBe(200);
    clock = new Date(NOW.getTime() + 60_000);
    expect((await post(`/api/platform/photographers/${id}/approve`)).status).toBe(200);

    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { photographerId: id } });
    expect(await audited()).toEqual([
      {
        action: 'photographer_approved',
        actorUserId: admin.id,
        targetType: 'photographer',
        targetId: id,
        photographerId: id,
        details: { status: 'approved', trialStarted: true, trialEndsAt: subscription.currentPeriodEndsAt.toISOString() },
        createdAt: NOW,
      },
    ]);
    const [row] = await auditRows();
    expect(actionLines()).toEqual([
      {
        level: 'info',
        event: 'platform_action',
        action: 'photographer_approved',
        auditId: row?.id,
        actorUserId: admin.id,
        targetType: 'photographer',
        targetId: id,
        photographerId: id,
        at: NOW.toISOString(),
      },
    ]);
  });

  it('a refused approval writes nothing: 409 not_submitted, and 409 invalid_transition', async () => {
    const unsubmitted = await pendingPhotographer({ submitted: false });
    expect((await post(`/api/platform/photographers/${unsubmitted}/approve`)).body).toMatchObject({ error: 'not_submitted' });

    await post(`/api/platform/photographers/${world.photographerId}/suspend`, { reason: 'Checking' });
    const before = await auditRows();
    expect((await post(`/api/platform/photographers/${world.photographerId}/approve`)).body).toMatchObject({ error: 'invalid_transition' });

    expect(await auditRows()).toEqual(before);
    expect((await auditRows()).map((row) => row.action)).toEqual(['photographer_suspended']);
    expect(actionLines().map((line) => line.action)).toEqual(['photographer_suspended']);
  });

  it('a failed approval writes nothing: the row rolls back with the change', async () => {
    const id = await pendingPhotographer();
    // The trial reads the platform settings inside the approval's transaction; without them it throws.
    await raw.query('DELETE FROM platform_setting');

    await expect(approvePhotographer({ prisma, now: () => clock }, { photographerId: id, adminUserId: admin.id })).rejects.toThrow();

    await expect(prisma.photographer.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({ status: 'pending', approvedAt: null });
    expect(await auditRows()).toEqual([]);
    expect(actionLines()).toEqual([]);
  });

  it('suspend: the reason, and nothing for a repeat; reactivate: the status it returned to, and nothing when not suspended', async () => {
    const id = world.photographerId;
    await post(`/api/platform/photographers/${id}/reactivate`);
    step();
    await post(`/api/platform/photographers/${id}/suspend`, { reason: '  Reported no-shows.  ' });
    step();
    await post(`/api/platform/photographers/${id}/suspend`, { reason: 'A second reason' });
    step();
    await post(`/api/platform/photographers/${id}/reactivate`);
    step();
    // A photographer suspended before approval returns to pending.
    const pending = await pendingPhotographer();
    await post(`/api/platform/photographers/${pending}/suspend`, { reason: 'Fake portfolio' });
    step();
    await post(`/api/platform/photographers/${pending}/reactivate`);

    expect((await audited()).map((row) => [row.action, row.targetId, row.details])).toEqual([
      ['photographer_suspended', id, { status: 'suspended', reason: 'Reported no-shows.' }],
      ['photographer_reactivated', id, { status: 'approved' }],
      ['photographer_suspended', pending, { status: 'suspended', reason: 'Fake portfolio' }],
      ['photographer_reactivated', pending, { status: 'pending' }],
    ]);
  });

  it('an id that names nobody writes nothing', async () => {
    for (const action of ['approve', 'reactivate']) expect((await post(`/api/platform/photographers/${UNKNOWN_ID}/${action}`)).status).toBe(404);
    expect((await post(`/api/platform/photographers/${UNKNOWN_ID}/suspend`, { reason: 'x' })).status).toBe(404);
    expect(await auditRows()).toEqual([]);
  });
});

describe('payouts write their audit rows in the same transaction (P1)', () => {
  it('created, paid with the transfer reference, and cancelled: one row each, never the note or the number', async () => {
    await earned(20_000);
    await earned(5_000);
    const method = await giveMethod();

    const first = await draft();
    step();
    expect((await post(`/api/platform/payouts/${first}/mark-paid`, { transferReference: 'MTN-TX-001', note: NOTE })).status).toBe(200);
    step();
    await earned(7_000);
    const second = await draft();
    step();
    expect((await post(`/api/platform/payouts/${second}/cancel`)).status).toBe(200);

    expect((await audited()).map((row) => [row.action, row.targetType, row.targetId, row.photographerId, row.details])).toEqual([
      ['payout_created', 'payout', first, world.photographerId, { amountRwf: 25_000, itemCount: 2, payoutMethodId: method.id }],
      ['payout_paid', 'payout', first, world.photographerId, { amountRwf: 25_000, itemCount: 2, transferReference: 'MTN-TX-001' }],
      ['payout_created', 'payout', second, world.photographerId, { amountRwf: 7_000, itemCount: 1, payoutMethodId: method.id }],
      ['payout_cancelled', 'payout', second, world.photographerId, { amountRwf: 7_000 }],
    ]);
    expect(actionLines().map((line) => line.action)).toEqual(['payout_created', 'payout_paid', 'payout_created', 'payout_cancelled']);
    const text = JSON.stringify(await auditRows());
    expect(text).not.toContain(NOTE);
    expect(text).not.toContain(MOMO_NUMBER);
    expect(text).not.toContain('8123456');
  });

  it('every refusal writes nothing: no method, nothing payable, a draft already there, a duplicate reference, not a draft, an unknown id', async () => {
    await earned(20_000);
    expect((await post('/api/platform/payouts', { photographerId: world.photographerId })).body).toMatchObject({ error: 'no_payout_method' });
    await giveMethod();
    const second = await seedSecondPhotographer(prisma, world);
    expect((await post('/api/platform/payouts', { photographerId: second.photographerId })).body).toMatchObject({ error: 'no_payout_method' });
    expect((await post('/api/platform/payouts', { photographerId: UNKNOWN_ID })).status).toBe(404);

    const id = await draft();
    const afterBuild = await auditRows();
    expect((await post('/api/platform/payouts', { photographerId: world.photographerId })).body).toMatchObject({ error: 'draft_exists' });
    expect((await post(`/api/platform/payouts/${id}/mark-paid`, { transferReference: '' })).status).toBe(422);
    step();
    await post(`/api/platform/payouts/${id}/mark-paid`, { transferReference: 'MTN-TX-001' });
    step();
    const afterPaid = await auditRows();

    expect((await post(`/api/platform/payouts/${id}/mark-paid`, { transferReference: 'MTN-TX-002' })).body).toMatchObject({ error: 'not_draft' });
    expect((await post(`/api/platform/payouts/${id}/cancel`)).body).toMatchObject({ error: 'not_draft' });
    expect((await post(`/api/platform/payouts/${UNKNOWN_ID}/cancel`)).status).toBe(404);
    // A second payout with a reference already used: refused, and its draft stays a draft.
    await earned(9_000);
    const other = await draft();
    const beforeDuplicate = await auditRows();
    expect((await post(`/api/platform/payouts/${other}/mark-paid`, { transferReference: 'MTN-TX-001' })).body).toEqual({ error: 'duplicate_transfer_reference' });
    expect(await auditRows()).toEqual(beforeDuplicate);

    expect(afterBuild.map((row) => row.action)).toEqual(['payout_created']);
    expect(afterPaid.map((row) => row.action)).toEqual(['payout_created', 'payout_paid']);
    expect((await auditRows()).map((row) => row.action)).toEqual(['payout_created', 'payout_paid', 'payout_created']);
  });

  it('a build with nothing payable writes nothing', async () => {
    await giveMethod();
    expect((await post('/api/platform/payouts', { photographerId: world.photographerId })).body).toMatchObject({ error: 'nothing_payable' });
    expect(await auditRows()).toEqual([]);
  });
});

describe('refunds write their audit row in the same transaction (P1)', () => {
  it('records the payment, the kind, the amount and the reference: never the client', async () => {
    const booking = await insertBooking(prisma, world, { status: 'cancelled_by_client' });
    const full = await insertPayment(prisma, booking.id, { status: 'refund_due', amountRwf: 20_000 });
    const overpaid = await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 30_000, overpaidRwf: 4_000 });

    expect((await post(`/api/platform/refunds/${full.id}`, { reference: 'REF-FULL-1' })).status).toBe(200);
    step();
    expect((await post(`/api/platform/refunds/${overpaid.id}`, { reference: 'REF-OVER-1', refundKind: 'overpayment' })).status).toBe(200);

    expect((await audited()).map((row) => [row.action, row.targetType, row.targetId, row.photographerId, row.details])).toEqual([
      ['refund_recorded', 'payment', full.id, world.photographerId, { paymentKind: 'booking_fee', refundKind: 'full', amountRwf: 20_000, reference: 'REF-FULL-1', bookingId: booking.id }],
      ['refund_recorded', 'payment', overpaid.id, world.photographerId, { paymentKind: 'session_fee', refundKind: 'overpayment', amountRwf: 4_000, reference: 'REF-OVER-1', bookingId: booking.id }],
    ]);
    const text = JSON.stringify(await auditRows());
    for (const personal of [CLIENT.name, CLIENT.email, CLIENT.phone, CLIENT.location]) expect(text).not.toContain(personal);
  });

  it('every refusal writes nothing: cash, nothing pending, a kind mismatch, a duplicate reference, an unknown payment', async () => {
    const booking = await insertBooking(prisma, world, { status: 'cancelled_by_client' });
    const cash = await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', provider: 'cash', amountRwf: 5_000 });
    const settled = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf: 20_000 });
    const due = await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', amountRwf: 9_000 });
    const other = await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', amountRwf: 8_000 });

    expect((await post(`/api/platform/refunds/${cash.id}`, { reference: 'R1' })).body).toEqual({ error: 'cash_payment' });
    expect((await post(`/api/platform/refunds/${settled.id}`, { reference: 'R2' })).body).toEqual({ error: 'not_refundable' });
    expect((await post(`/api/platform/refunds/${due.id}`, { reference: 'R3', refundKind: 'overpayment' })).body).toMatchObject({ error: 'refund_kind_mismatch' });
    expect((await post(`/api/platform/refunds/${UNKNOWN_ID}`, { reference: 'R4' })).status).toBe(404);
    expect(await auditRows()).toEqual([]);

    await post(`/api/platform/refunds/${due.id}`, { reference: 'R5' });
    expect((await post(`/api/platform/refunds/${other.id}`, { reference: 'R5' })).body).toEqual({ error: 'duplicate_refund_reference' });
    expect((await auditRows()).map((row) => row.targetId)).toEqual([due.id]);
  });
});

describe('settings write their audit row in the same transaction (P1)', () => {
  it('records the changed fields only, before and after, and nothing for a save that changes no value or is refused', async () => {
    expect((await patch('/api/platform/settings', { trialDays: 30, holdMinutes: 30 })).status).toBe(200);
    expect((await patch('/api/platform/settings', { trialDays: 0 })).status).toBe(422);
    expect((await patch('/api/platform/settings', { trialDays: 'x' })).status).toBe(400);
    expect((await patch('/api/platform/settings', { subscriptionReminderDays: [1, 3, 7] })).status).toBe(200);
    expect(await auditRows()).toEqual([]);

    expect((await patch('/api/platform/settings', { trialDays: 14, holdMinutes: 30, subscriptionGraceDays: 3 })).status).toBe(200);

    expect((await audited()).map((row) => [row.action, row.targetType, row.targetId, row.details])).toEqual([
      ['settings_updated', 'platform_setting', null, { changed: { trialDays: { before: 30, after: 14 }, subscriptionGraceDays: { before: 7, after: 3 } } }],
    ]);
  });
});

describe('what no audit row ever holds (P1)', () => {
  it('no password hash, token, login email, full payout number, payout note or client detail, after one of every action', async () => {
    const pending = await pendingPhotographer();
    await post(`/api/platform/photographers/${pending}/approve`);
    await post(`/api/platform/photographers/${pending}/suspend`, { reason: 'Checking the trail' });
    await post(`/api/platform/photographers/${pending}/reactivate`);
    await earned(20_000);
    await giveMethod();
    const payout = await draft();
    await post(`/api/platform/payouts/${payout}/mark-paid`, { transferReference: 'MTN-TX-009', note: NOTE });
    await earned(3_000);
    await post(`/api/platform/payouts/${await draft()}/cancel`);
    const booking = await insertBooking(prisma, world, { status: 'cancelled_by_client' });
    const due = await insertPayment(prisma, booking.id, { status: 'refund_due', amountRwf: 20_000 });
    await post(`/api/platform/refunds/${due.id}`, { reference: 'REF-9' });
    await patch('/api/platform/settings', { trialDays: 21 });
    const created = await post('/api/platform/categories', { slug: 'drone', nameEn: 'Drone' });
    const categoryId = (created.body as { category: { id: string } }).category.id;
    await patch(`/api/platform/categories/${categoryId}`, { nameEn: 'Drone & aerial', isActive: false });
    await auth(request(app).delete(`/api/platform/categories/${categoryId}`));

    const rows = await auditRows();
    expect(new Set(rows.map((row) => row.action))).toEqual(new Set(PLATFORM_AUDIT_ACTIONS.filter((action) => action !== 'category_reordered' && action !== 'category_reactivated')));
    const users = await prisma.appUser.findMany();
    const text = JSON.stringify(rows);
    const forbidden = [
      token,
      ...users.flatMap((user) => [user.passwordHash, user.email]).filter((value): value is string => value !== null && value.length > 0),
      PLATFORM_ADMIN_EMAIL,
      PHOTOGRAPHER_EMAIL,
      MOMO_NUMBER,
      NOTE,
      CLIENT.name,
      CLIENT.email,
      CLIENT.phone,
      CLIENT.location,
    ];
    for (const value of forbidden) expect(text, value).not.toContain(value);
    // And the log lines say even less: ids, the action and when.
    for (const line of actionLines()) {
      expect(Object.keys(line).sort()).toEqual(['action', 'actorUserId', 'at', 'auditId', 'event', 'level', 'photographerId', 'targetId', 'targetType']);
    }
    expect(actionLines()).toHaveLength(rows.length);
  });
});

// --- P2: GET /api/platform/audit -----------------------------------------------------------

describe('GET /api/platform/audit (P2)', () => {
  /** `n` rows a minute apart, the newest last, alternating between two actions and two photographers. */
  async function seedRows(n: number, second: PaymentWorld) {
    await prisma.platformAudit.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        actorUserId: admin.id,
        action: i % 2 === 0 ? 'photographer_suspended' : 'payout_created',
        targetType: i % 2 === 0 ? 'photographer' : 'payout',
        targetId: i % 2 === 0 ? (i % 4 === 0 ? world.photographerId : second.photographerId) : UNKNOWN_ID,
        photographerId: i % 4 === 0 ? world.photographerId : second.photographerId,
        details: { n: i },
        createdAt: new Date(NOW.getTime() - (n - i) * 60_000),
      })),
    });
  }

  it('answers the rows newest first, with the actor, the target and the photographer, in the spec’s shape', async () => {
    await post(`/api/platform/photographers/${world.photographerId}/suspend`, { reason: 'First' });
    clock = new Date(NOW.getTime() + 60_000);
    await patch('/api/platform/settings', { trialDays: 10 });

    const res = await get('/api/platform/audit');

    await expectMatchesSpec(res, 'listPlatformAudit', 200);
    const rows = await auditRows();
    expect(res.body).toEqual({
      entries: [
        {
          id: rows[1]?.id,
          action: 'settings_updated',
          actor: { id: admin.id, email: PLATFORM_ADMIN_EMAIL },
          target: { type: 'platform_setting', id: null },
          photographer: null,
          details: { changed: { trialDays: { before: 30, after: 10 } } },
          createdAt: clock.toISOString(),
        },
        {
          id: rows[0]?.id,
          action: 'photographer_suspended',
          actor: { id: admin.id, email: PLATFORM_ADMIN_EMAIL },
          target: { type: 'photographer', id: world.photographerId },
          photographer: { id: world.photographerId, handle: PHOTOGRAPHER_HANDLE, displayName: PHOTOGRAPHER_NAME },
          details: { status: 'suspended', reason: 'First' },
          createdAt: NOW.toISOString(),
        },
      ],
      total: 2,
      page: 1,
      pageSize: AUDIT_PAGE_SIZE,
      pageCount: 1,
    });
  });

  it('pages 50 at a time, newest first; a page past the end is empty', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    await seedRows(55, second);

    const one = await get('/api/platform/audit');
    const two = await get('/api/platform/audit?page=2');
    const three = await get('/api/platform/audit?page=3');

    expect([one.body.entries.length, one.body.total, one.body.pageCount]).toEqual([50, 55, 2]);
    expect(one.body.entries.map((entry: { details: { n: number } }) => entry.details.n)).toEqual(Array.from({ length: 50 }, (_, i) => 54 - i));
    expect(two.body.entries.map((entry: { details: { n: number } }) => entry.details.n)).toEqual([4, 3, 2, 1, 0]);
    expect(two.body).toMatchObject({ page: 2, total: 55, pageCount: 2 });
    expect(three.body).toEqual({ entries: [], total: 55, page: 3, pageSize: 50, pageCount: 2 });
    await expectMatchesSpec(three, 'listPlatformAudit', 200);
  });

  it('breaks a tie between rows of one instant by id, so pages never overlap', async () => {
    await prisma.platformAudit.createMany({
      data: Array.from({ length: 60 }, () => ({ actorUserId: admin.id, action: 'category_created', targetType: 'category', createdAt: NOW })),
    });
    const ids = [...(await get('/api/platform/audit')).body.entries, ...(await get('/api/platform/audit?page=2')).body.entries].map((entry: { id: string }) => entry.id);
    expect(new Set(ids).size).toBe(60);
  });

  it('filters by action, by photographer, and by both (AND)', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    await seedRows(8, second);
    const ns = async (query: string) => (await get(`/api/platform/audit?${query}`)).body.entries.map((entry: { details: { n: number } }) => entry.details.n);

    expect(await ns('action=payout_created')).toEqual([7, 5, 3, 1]);
    expect(await ns(`photographerId=${world.photographerId}`)).toEqual([4, 0]);
    expect(await ns(`photographerId=${second.photographerId.toUpperCase()}`)).toEqual([7, 6, 5, 3, 2, 1]);
    expect(await ns(`action=photographer_suspended&photographerId=${second.photographerId}`)).toEqual([6, 2]);
    expect(await ns(`action=category_deleted`)).toEqual([]);
    expect(await ns(`photographerId=${UNKNOWN_ID}`)).toEqual([]);
    expect((await get('/api/platform/audit?action=payout_created')).body).toMatchObject({ total: 4, pageCount: 1 });
  });

  it.each<[string, number]>([
    ['?unknown=1', 400],
    ['?action=photographer_deleted', 400],
    ['?action=', 400],
    ['?photographerId=not-a-uuid', 400],
    ['?page=abc', 400],
    ['?page=1.5', 400],
    ['?page=-1', 400],
    ['?page=1&page=2', 400],
    ['?action=payout_paid&action=payout_created', 400],
    ['?page=0', 422],
    ['?page=1000001', 422],
  ])('refuses %s with %i', async (query, status) => {
    const res = await get(`/api/platform/audit${query}`);
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(status === 400 ? 'invalid_request' : 'validation_failed');
  });

  it('refuses a photographer’s and a client’s token, and none (T9.1)', async () => {
    const photographer = await prisma.appUser.findUniqueOrThrow({ where: { id: world.photographerUserId } });
    const client = await prisma.appUser.create({ data: { email: 'client.audit@bookly.example', role: 'client', passwordHash: 'x', emailVerifiedAt: NOW } });
    expect((await get('/api/platform/audit', (await issueToken(SECRET, 'studio', photographer, clock)).token)).status).toBe(401);
    expect((await get('/api/platform/audit', (await issueToken(SECRET, 'account', client, clock)).token)).status).toBe(401);
    expect((await request(app).get('/api/platform/audit')).status).toBe(401);
  });
});
