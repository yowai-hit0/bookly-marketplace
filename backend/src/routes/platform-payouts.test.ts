import type { AppUser, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { issueToken } from '../auth/token.js';
import { cancelByAdmin } from '../booking/admin-actions.js';
import { bookingTotals } from '../booking/totals.js';
import { createPrismaClient } from '../db/client.js';
import { renderEmail } from '../email/render.js';
import { recordEarning } from '../payouts/ledger.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { expectMatchesSpec, loadSpec, specOperations } from '../test/openapi.js';
import {
  PHOTOGRAPHER_EMAIL,
  type PaymentWorld,
  insertBooking,
  insertPayment,
  seedSecondPhotographer,
  seedWorld,
} from '../test/payment-fixtures.js';

/**
 * The platform's payouts and refunds over HTTP, against real PostgreSQL
 * (marketplace-spec.md R4.1, R4.4, R4.6, T4.3, T4.4; Phase 4 refund decision).
 *
 * - Payouts due: who has a payable balance above nought, their method, and the
 *   72-hour flag on a destination saved recently.
 * - Building a draft: the payable lines locked and totalled, `payout_id` set,
 *   who built it recorded; refused without a method, with a draft already
 *   there (also when two builds race), and for a total of nought or less.
 * - Marking it paid: the reference required and unique (also when two race),
 *   who and when recorded, `payout_sent` queued and renderable; only a draft.
 * - Cancelling: the lines released and payable again; only a draft.
 * - Refunds: online `refund_due` payments and overpaid parts of succeeded
 *   ones (Phase 4 overpayment decision), recorded with who did it; a full
 *   refund covering an overpayment, and less an overpaid part already
 *   returned; references used once across both kinds, cash outside the rule;
 *   cash and anything not owed back refused.
 * - Every route refuses a photographer's and a client's token.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let clock: Date;
let world: PaymentWorld;
let admin: AppUser;
let token: string;

const SECRET = 'platform-payouts-test-secret-at-least-32-chars';
const WEB_ORIGIN = 'https://bookly.example';
/** After every fixture shoot (January 2027 onwards) has ended. */
const NOW = new Date('2027-12-01T08:00:00.000Z');
const HOUR_MS = 3_600_000;
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
  app = createApp({ corsOrigin: WEB_ORIGIN, auth: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock } });
});

// --- Helpers ----------------------------------------------------------------------------

function get(path: string, bearer: string = token) {
  return request(app).get(path).set('Authorization', `Bearer ${bearer}`);
}

function post(path: string, body?: object, bearer: string = token) {
  const req = request(app).post(path).set('Authorization', `Bearer ${bearer}`);
  return body === undefined ? req : req.send(body);
}

/** A succeeded online fee with its earning, as the webhook leaves them. */
async function earned(of: PaymentWorld, amountRwf: number, kind: 'booking_fee' | 'session_fee' = 'booking_fee') {
  const booking = await insertBooking(prisma, of, { status: 'confirmed' });
  const payment = await insertPayment(prisma, booking.id, { status: 'succeeded', amountRwf, kind });
  await prisma.$transaction((tx) => recordEarning(tx, payment.id));
  return { booking, payment };
}

async function giveMethod(of: PaymentWorld, createdAt: Date = new Date(NOW.getTime() - 30 * 24 * HOUR_MS)) {
  return prisma.payoutMethod.create({
    data: { photographerId: of.photographerId, kind: 'momo', momoNetwork: 'mtn', momoNumber: '+250788123456', accountName: 'Kigali Lens Ltd', createdAt },
  });
}

async function draftFor(of: PaymentWorld): Promise<string> {
  const res = await post('/api/platform/payouts', { photographerId: of.photographerId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { payout: { id: string } }).payout.id;
}

async function payoutRow(id: string) {
  return prisma.payout.findUniqueOrThrow({ where: { id } });
}

// --- Payouts due (R4.4 step 1, R4.1) -----------------------------------------------------

describe('GET /api/platform/payouts/due', () => {
  it('lists photographers with a payable balance above nought, largest first, with their method', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    await earned(world, 20_000);
    await earned(world, 5_000);
    await earned(second, 40_000);
    await giveMethod(world);

    const res = await get('/api/platform/payouts/due');

    await expectMatchesSpec(res, 'listPayoutsDue', 200);
    const due = (res.body as { due: { photographer: { id: string; email: string }; payableRwf: number; itemCount: number; payoutMethod: unknown }[] }).due;
    expect(due.map((row) => [row.photographer.id, row.payableRwf, row.itemCount])).toEqual([
      [second.photographerId, 40_000, 1],
      [world.photographerId, 25_000, 2],
    ]);
    expect(due[1]?.photographer.email).toBe(PHOTOGRAPHER_EMAIL);
    expect(due[1]?.payoutMethod).toMatchObject({ kind: 'momo', momoNumber: '+250788123456', retiredAt: null });
    expect(due[0]?.payoutMethod).toBeNull();
  });

  it('flags a method saved within the last 72 hours, and not one older (R4.1)', async () => {
    await earned(world, 20_000);
    await giveMethod(world, new Date(NOW.getTime() - 71 * HOUR_MS));

    const recent = await get('/api/platform/payouts/due');
    expect((recent.body as { due: { methodChangedRecently: boolean }[] }).due[0]?.methodChangedRecently).toBe(true);

    clock = new Date(NOW.getTime() + 2 * HOUR_MS);
    const later = await get('/api/platform/payouts/due');
    expect((later.body as { due: { methodChangedRecently: boolean }[] }).due[0]?.methodChangedRecently).toBe(false);
  });

  it('leaves out a negative balance: a reversal with nothing new to net it against', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    const { booking } = await earned(second, 20_000);
    await giveMethod(second);
    const payoutId = await draftFor(second);
    await post(`/api/platform/payouts/${payoutId}/mark-paid`, { transferReference: 'MTN-1' });
    expect((await cancelByAdmin({ prisma, now: () => clock, photographerId: second.photographerId }, booking.id, null)).status).toBe('ok');

    expect((await get('/api/platform/payouts/due')).body).toEqual({ due: [] });
  });

  it('leaves out a session fee whose shoot has not ended: pending, not payable', async () => {
    clock = new Date('2026-10-01T00:00:00Z');
    token = (await issueToken(SECRET, 'platform', admin, clock)).token;
    await earned(world, 30_000, 'session_fee');

    expect((await get('/api/platform/payouts/due')).body).toEqual({ due: [] });
  });

  it('names a draft already being prepared', async () => {
    await earned(world, 20_000);
    await giveMethod(world);
    const payoutId = await draftFor(world);
    await earned(world, 3_000);

    const due = (await get('/api/platform/payouts/due')).body as { due: { draftPayoutId: string | null; payableRwf: number }[] };
    expect(due.due).toMatchObject([{ draftPayoutId: payoutId, payableRwf: 3_000 }]);
  });
});

// --- Build a draft (R4.4 step 2, T4.3) ---------------------------------------------------

describe('POST /api/platform/payouts', () => {
  it('locks the payable lines into a draft for their total, to the current method, recording who built it', async () => {
    const one = await earned(world, 20_000);
    const two = await earned(world, 10_000);
    const method = await giveMethod(world);

    const res = await post('/api/platform/payouts', { photographerId: world.photographerId });

    await expectMatchesSpec(res, 'buildPayout', 201);
    const { payout } = res.body as { payout: { id: string; amountRwf: number; status: string; itemCount: number; items: { payment: { id: string } }[]; createdBy: { id: string } } };
    expect(payout).toMatchObject({ amountRwf: 30_000, status: 'draft', itemCount: 2, createdBy: { id: admin.id } });
    expect(payout.items.map((item) => item.payment.id).sort()).toEqual([one.payment.id, two.payment.id].sort());
    expect(await payoutRow(payout.id)).toMatchObject({ payoutMethodId: method.id, createdByUserId: admin.id, amountRwf: 30_000 });
    expect(await prisma.payoutItem.count({ where: { payoutId: payout.id } })).toBe(2);
  });

  it('refuses a second draft for the same photographer (T4.3), naming the first', async () => {
    await earned(world, 20_000);
    await giveMethod(world);
    const first = await draftFor(world);
    await earned(world, 5_000);

    const res = await post('/api/platform/payouts', { photographerId: world.photographerId });

    await expectMatchesSpec(res, 'buildPayout', 409);
    expect(res.body).toEqual({ error: 'draft_exists', payoutId: first });
    expect(await prisma.payout.count()).toBe(1);
  });

  it('builds exactly one draft when two builds race', async () => {
    await earned(world, 20_000);
    await earned(world, 7_000);
    await giveMethod(world);

    const results = await Promise.all([1, 2, 3].map(() => post('/api/platform/payouts', { photographerId: world.photographerId })));

    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409]);
    for (const res of results.filter((r) => r.status === 409)) expect((res.body as { error: string }).error).toBe('draft_exists');
    const payouts = await prisma.payout.findMany();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]?.amountRwf).toBe(27_000);
  });

  it('refuses a photographer with no payout method', async () => {
    await earned(world, 20_000);

    const res = await post('/api/platform/payouts', { photographerId: world.photographerId });

    await expectMatchesSpec(res, 'buildPayout', 409);
    expect(res.body).toEqual({ error: 'no_payout_method' });
    expect(await prisma.payout.count()).toBe(0);
  });

  it('creates nothing for a total of nought, and the balance carries forward', async () => {
    await giveMethod(world);

    const res = await post('/api/platform/payouts', { photographerId: world.photographerId });

    await expectMatchesSpec(res, 'buildPayout', 409);
    expect(res.body).toEqual({ error: 'nothing_payable', payableRwf: 0 });
    expect(await prisma.payout.count()).toBe(0);
  });

  it('a retired method is never used: the draft goes to the current one', async () => {
    await earned(world, 20_000);
    const old = await giveMethod(world);
    await prisma.payoutMethod.update({ where: { id: old.id }, data: { retiredAt: NOW } });
    const current = await prisma.payoutMethod.create({
      data: { photographerId: world.photographerId, kind: 'bank', bankName: 'Bank of Kigali', bankAccountNumber: '00040-0012345-67', accountName: 'Kigali Lens Ltd' },
    });

    const payoutId = await draftFor(world);

    expect((await payoutRow(payoutId)).payoutMethodId).toBe(current.id);
  });

  it('answers 404 for a photographer who does not exist, and 400 for a malformed body', async () => {
    expect((await post('/api/platform/payouts', { photographerId: UNKNOWN_ID })).status).toBe(404);
    expect((await post('/api/platform/payouts', { photographerId: 'nope' })).status).toBe(400);
    expect((await post('/api/platform/payouts', { photographerId: world.photographerId, amountRwf: 1 })).status).toBe(400);
  });

  it('orders a build and a refund racing for the same earning: the draft never pays money owed back', async () => {
    const { booking } = await earned(world, 20_000);
    await earned(world, 10_000);
    await giveMethod(world);

    const [built] = await Promise.all([
      post('/api/platform/payouts', { photographerId: world.photographerId }),
      cancelByAdmin({ prisma, now: () => clock, photographerId: world.photographerId }, booking.id, null),
    ]);

    expect(built.status).toBe(201);
    const payout = (built.body as { payout: { id: string; amountRwf: number } }).payout;
    const items = await prisma.payoutItem.findMany({ where: { photographerId: world.photographerId } });
    const inPayout = items.filter((item) => item.payoutId === payout.id).reduce((sum, item) => sum + item.amountRwf, 0);
    expect(inPayout).toBe(payout.amountRwf);
    const reversal = items.find((item) => item.kind === 'reversal');
    if (payout.amountRwf === 30_000) {
      // The build won: the refunded earning was paid out, so a reversal nets it off next time.
      expect(reversal?.amountRwf).toBe(-20_000);
    } else {
      // The refund won: the earning was voided before the build could take it.
      expect(payout.amountRwf).toBe(10_000);
      expect(reversal).toBeUndefined();
    }
  });
});

// --- List and read ----------------------------------------------------------------------------

describe('GET /api/platform/payouts and /:id', () => {
  it('lists payouts newest first, filtered by status', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    await earned(world, 20_000);
    await earned(second, 10_000);
    await giveMethod(world);
    await giveMethod(second);
    const first = await draftFor(world);
    clock = new Date(NOW.getTime() + 1000);
    const other = await draftFor(second);
    await post(`/api/platform/payouts/${first}/mark-paid`, { transferReference: 'MTN-9' });

    const all = await get('/api/platform/payouts');
    await expectMatchesSpec(all, 'listPlatformPayouts', 200);
    expect((all.body as { payouts: { id: string }[] }).payouts.map((p) => p.id)).toEqual([other, first]);
    const paid = await get('/api/platform/payouts?status=paid');
    expect((paid.body as { payouts: { id: string; status: string }[] }).payouts).toMatchObject([{ id: first, status: 'paid' }]);
    expect((await get('/api/platform/payouts?status=bogus')).status).toBe(400);
  });

  it('reads one payout with its lines, each linked to its booking', async () => {
    const { booking } = await earned(world, 20_000);
    await giveMethod(world);
    const payoutId = await draftFor(world);

    const res = await get(`/api/platform/payouts/${payoutId}`);

    await expectMatchesSpec(res, 'getPlatformPayout', 200);
    expect((res.body as { payout: { items: { booking: { id: string; reference: string }; state: string }[] } }).payout.items).toMatchObject([
      { state: 'in_draft', booking: { id: booking.id, reference: booking.reference } },
    ]);
    expect((await get(`/api/platform/payouts/${UNKNOWN_ID}`)).status).toBe(404);
    expect((await get('/api/platform/payouts/not-a-uuid')).status).toBe(400);
  });

  it('says when the draft’s method has since been replaced', async () => {
    await earned(world, 20_000);
    const method = await giveMethod(world);
    const payoutId = await draftFor(world);
    await prisma.payoutMethod.update({ where: { id: method.id }, data: { retiredAt: NOW } });
    await prisma.payoutMethod.create({ data: { photographerId: world.photographerId, kind: 'momo', momoNetwork: 'airtel', momoNumber: '+250731234567', accountName: 'X', createdAt: NOW } });

    const res = await get(`/api/platform/payouts/${payoutId}`);

    expect((res.body as { payout: object }).payout).toMatchObject({ payoutMethodIsCurrent: false, methodChangedRecently: true, payoutMethod: { id: method.id } });
  });
});

// --- Mark paid (R4.4 step 4, T4.3) ----------------------------------------------------------

describe('POST /api/platform/payouts/:id/mark-paid', () => {
  async function draft(): Promise<string> {
    await earned(world, 20_000);
    await giveMethod(world);
    return draftFor(world);
  }

  it('records the reference, when and who, and emails payout_sent to the photographer', async () => {
    const payoutId = await draft();

    const res = await post(`/api/platform/payouts/${payoutId}/mark-paid`, { transferReference: '  MTN-TX-4471  ', note: 'Sent from the business line' });

    await expectMatchesSpec(res, 'markPayoutPaid', 200);
    expect((res.body as { payout: object }).payout).toMatchObject({ status: 'paid', transferReference: 'MTN-TX-4471', paidBy: { id: admin.id }, paidAt: NOW.toISOString() });
    expect(await payoutRow(payoutId)).toMatchObject({ status: 'paid', transferReference: 'MTN-TX-4471', paidByUserId: admin.id, paidAt: NOW, note: 'Sent from the business line' });

    const mail = await prisma.outbox.findFirstOrThrow({ where: { template: 'payout_sent' } });
    expect(mail).toMatchObject({ recipient: PHOTOGRAPHER_EMAIL, photographerId: world.photographerId, dedupeKey: `email:payout_sent:${payoutId}` });
    const rendered = renderEmail('payout_sent', mail.payload, { webOrigin: WEB_ORIGIN });
    expect(rendered.text).toContain('MTN-TX-4471');
    expect(rendered.text).toContain('ending 3456');
    // The destination is masked: never the whole number, and never the admin's note.
    expect(rendered.text).not.toContain('788123456');
    expect(rendered.text).not.toContain('business line');
  });

  it('refuses a missing reference with 400 and a blank one with 422, changing nothing (T4.3)', async () => {
    const payoutId = await draft();

    expect((await post(`/api/platform/payouts/${payoutId}/mark-paid`, {})).status).toBe(400);
    const blank = await post(`/api/platform/payouts/${payoutId}/mark-paid`, { transferReference: '   ' });
    await expectMatchesSpec(blank, 'markPayoutPaid', 422);
    expect(blank.body).toEqual({ error: 'validation_failed', fields: ['transferReference'] });

    expect((await payoutRow(payoutId)).status).toBe('draft');
    expect(await prisma.outbox.count({ where: { template: 'payout_sent' } })).toBe(0);
  });

  it('refuses a reference already recorded on another payout (T4.3)', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    const first = await draft();
    await post(`/api/platform/payouts/${first}/mark-paid`, { transferReference: 'MTN-SAME' });
    await earned(second, 10_000);
    await giveMethod(second);
    const other = await draftFor(second);

    const res = await post(`/api/platform/payouts/${other}/mark-paid`, { transferReference: 'MTN-SAME' });

    await expectMatchesSpec(res, 'markPayoutPaid', 409);
    expect(res.body).toEqual({ error: 'duplicate_transfer_reference' });
    expect((await payoutRow(other)).status).toBe('draft');
    expect(await prisma.outbox.count({ where: { template: 'payout_sent' } })).toBe(1);
  });

  it('refuses one reference for two payouts marked paid at the same moment', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    const first = await draft();
    await earned(second, 10_000);
    await giveMethod(second);
    const other = await draftFor(second);

    const results = await Promise.all([first, other].map((id) => post(`/api/platform/payouts/${id}/mark-paid`, { transferReference: 'MTN-RACE' })));

    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(results.find((res) => res.status === 409)?.body).toEqual({ error: 'duplicate_transfer_reference' });
    expect(await prisma.payout.count({ where: { status: 'paid' } })).toBe(1);
    expect(await prisma.outbox.count({ where: { template: 'payout_sent' } })).toBe(1);
  });

  it('marks paid once when two admins click at the same moment', async () => {
    const payoutId = await draft();

    const results = await Promise.all(['MTN-A', 'MTN-B'].map((ref) => post(`/api/platform/payouts/${payoutId}/mark-paid`, { transferReference: ref })));

    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect((results.find((res) => res.status === 409)?.body as { error: string }).error).toBe('not_draft');
    expect(await prisma.outbox.count({ where: { template: 'payout_sent' } })).toBe(1);
  });

  it('refuses a payout that is not a draft, with the payout as it stands', async () => {
    const payoutId = await draft();
    await post(`/api/platform/payouts/${payoutId}/mark-paid`, { transferReference: 'MTN-1' });

    const again = await post(`/api/platform/payouts/${payoutId}/mark-paid`, { transferReference: 'MTN-2' });

    await expectMatchesSpec(again, 'markPayoutPaid', 409);
    expect(again.body).toMatchObject({ error: 'not_draft', payout: { id: payoutId, status: 'paid', transferReference: 'MTN-1' } });
    expect((await post(`/api/platform/payouts/${UNKNOWN_ID}/mark-paid`, { transferReference: 'X' })).status).toBe(404);
  });
});

// --- Cancel ------------------------------------------------------------------------------------

describe('POST /api/platform/payouts/:id/cancel', () => {
  it('releases the lines back to the balance, recording who cancelled', async () => {
    await earned(world, 20_000);
    await giveMethod(world);
    const payoutId = await draftFor(world);

    const res = await post(`/api/platform/payouts/${payoutId}/cancel`);

    await expectMatchesSpec(res, 'cancelPayout', 200);
    expect((res.body as { payout: object }).payout).toMatchObject({ status: 'cancelled', itemCount: 0, items: [], cancelledBy: { id: admin.id } });
    expect(await payoutRow(payoutId)).toMatchObject({ status: 'cancelled', cancelledByUserId: admin.id, cancelledAt: NOW });
    expect(await prisma.payoutItem.count({ where: { payoutId: { not: null } } })).toBe(0);
    // Payable again, so a new draft can be built for the same lines.
    const rebuilt = await post('/api/platform/payouts', { photographerId: world.photographerId });
    expect([rebuilt.status, (rebuilt.body as { payout: { amountRwf: number } }).payout.amountRwf]).toEqual([201, 20_000]);
  });

  it('refuses to cancel a paid payout, or to pay a cancelled one', async () => {
    await earned(world, 20_000);
    await giveMethod(world);
    const paid = await draftFor(world);
    await post(`/api/platform/payouts/${paid}/mark-paid`, { transferReference: 'MTN-1' });

    const cancel = await post(`/api/platform/payouts/${paid}/cancel`);
    await expectMatchesSpec(cancel, 'cancelPayout', 409);
    expect((await payoutRow(paid)).status).toBe('paid');

    await earned(world, 5_000);
    const draft = await draftFor(world);
    await post(`/api/platform/payouts/${draft}/cancel`);
    expect((await post(`/api/platform/payouts/${draft}/mark-paid`, { transferReference: 'MTN-2' })).body).toMatchObject({ error: 'not_draft' });
    expect((await post(`/api/platform/payouts/${UNKNOWN_ID}/cancel`)).status).toBe(404);
  });
});

// --- Refunds of money paid online (R4.6) -------------------------------------------------------

describe('/api/platform/refunds', () => {
  it('lists every online payment owed back, with its booking and photographer, and no cash', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    const mine = await insertBooking(prisma, world, { status: 'cancelled_by_photographer' });
    const theirs = await insertBooking(prisma, second, { status: 'cancelled_by_photographer' });
    const online = await insertPayment(prisma, mine.id, { status: 'refund_due', provider: 'flutterwave' });
    const other = await insertPayment(prisma, theirs.id, { status: 'refund_due', ageSeconds: 60 });
    await insertPayment(prisma, mine.id, { status: 'refund_due', kind: 'session_fee', provider: 'cash' });
    await insertPayment(prisma, theirs.id, { status: 'succeeded', kind: 'session_fee' });

    const res = await get('/api/platform/refunds');

    await expectMatchesSpec(res, 'listRefundsDue', 200);
    const refunds = (res.body as { refunds: { paymentId: string; provider: string; booking: { reference: string }; photographer: { id: string } }[] }).refunds;
    expect(refunds.map((row) => row.paymentId).sort()).toEqual([online.id, other.id].sort());
    expect(refunds.find((row) => row.paymentId === online.id)).toMatchObject({ provider: 'flutterwave', booking: { reference: mine.reference }, photographer: { id: world.photographerId } });
  });

  it('records a refund with the reference and the admin, and it leaves the list', async () => {
    const booking = await insertBooking(prisma, world, { status: 'cancelled_by_photographer' });
    const payment = await insertPayment(prisma, booking.id, { status: 'refund_due' });

    const res = await post(`/api/platform/refunds/${payment.id}`, { reference: 'MTN-REFUND-77' });

    await expectMatchesSpec(res, 'recordPlatformRefund', 200);
    expect(res.body).toMatchObject({ refund: { paymentId: payment.id, status: 'refunded', refundReference: 'MTN-REFUND-77', refundedByUserId: admin.id } });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ status: 'refunded', refundedByUserId: admin.id, refundedAt: NOW });
    expect((await get('/api/platform/refunds')).body).toEqual({ refunds: [] });
  });

  it('refuses cash (the photographer records it) and anything not owed back, writing nothing', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const cash = await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', provider: 'cash' });
    const held = await insertPayment(prisma, booking.id, { status: 'succeeded' });

    const refusedCash = await post(`/api/platform/refunds/${cash.id}`, { reference: 'R-1' });
    await expectMatchesSpec(refusedCash, 'recordPlatformRefund', 409);
    expect(refusedCash.body).toEqual({ error: 'cash_payment' });
    expect((await post(`/api/platform/refunds/${held.id}`, { reference: 'R-1' })).body).toEqual({ error: 'not_refundable' });
    expect((await post(`/api/platform/refunds/${UNKNOWN_ID}`, { reference: 'R-1' })).status).toBe(404);
    expect((await post(`/api/platform/refunds/${held.id}`, {})).status).toBe(400);
    expect((await post(`/api/platform/refunds/${held.id}`, { reference: ' ' })).status).toBe(422);

    expect((await prisma.payment.findUniqueOrThrow({ where: { id: cash.id } })).status).toBe('refund_due');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('succeeded');
  });
});

// --- Only a platform admin (T4.3, T4.4, T9.1) --------------------------------------------------

describe('every payouts and refunds route refuses every token but a platform admin’s', () => {
  async function routes() {
    return specOperations(await loadSpec()).filter((op) => /^\/api\/platform\/(payouts|refunds)/.test(op.path));
  }

  it('covers the eight routes', async () => {
    expect(await routes()).toHaveLength(8);
  });

  it.each(['studio', 'account'] as const)('a %s token is a 401 everywhere, and nothing changes', async (area) => {
    await earned(world, 20_000);
    await giveMethod(world);
    const user = area === 'studio'
      ? await prisma.appUser.findUniqueOrThrow({ where: { id: world.photographerUserId } })
      : await prisma.appUser.create({ data: { email: 'client@bookly.example', role: 'client', passwordHash: 'x', emailVerifiedAt: NOW } });
    const other = (await issueToken(SECRET, area, user, clock)).token;

    for (const op of await routes()) {
      const path = op.path.replace(':id', UNKNOWN_ID).replace(':paymentId', UNKNOWN_ID);
      const res = await request(app)[op.method as 'get' | 'post'](path)
        .set('Authorization', `Bearer ${other}`)
        .send({ photographerId: world.photographerId, transferReference: 'X', reference: 'X' });
      expect([op.path, res.status]).toEqual([op.path, 401]);
    }
    expect(await prisma.payout.count()).toBe(0);
  });
});

// --- Overpayment refunds (Phase 4 overpayment decision) -------------------------------------------

/**
 * A session fee paid online for more than the booking was worth stays
 * `succeeded`, earned only what was due, and has its overpaid part listed for
 * the platform to send back. One endpoint records whichever refund is pending;
 * a full refund covers the overpaid part and takes precedence. Online refund
 * references are used once across both kinds; cash references are the
 * photographer's and stay outside the rule.
 */
describe('/api/platform/refunds: overpayments', () => {
  type RefundRow = { paymentId: string; refundKind: string; refundAmountRwf: number; overpaidRwf: number; amountRwf: number };

  /** A confirmed booking whose shoot has ended: 50,000 owed, 20,000 booking fee, and 40,000 paid against the 30,000 left. */
  async function overpaidBooking(of: PaymentWorld = world) {
    const booking = await insertBooking(prisma, of, { status: 'confirmed' });
    const bookingFee = await insertPayment(prisma, booking.id, { status: 'succeeded' });
    const sessionFee = await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 40_000, overpaidRwf: 10_000, ageSeconds: 60 });
    await prisma.$transaction(async (tx) => {
      await recordEarning(tx, bookingFee.id);
      await recordEarning(tx, sessionFee.id);
    });
    return { booking, bookingFee, sessionFee };
  }

  async function refunds(): Promise<RefundRow[]> {
    const res = await get('/api/platform/refunds');
    await expectMatchesSpec(res, 'listRefundsDue', 200);
    return (res.body as { refunds: RefundRow[] }).refunds;
  }

  async function paymentOf(id: string) {
    return prisma.payment.findUniqueOrThrow({ where: { id } });
  }

  async function items(paymentId: string) {
    return (await prisma.payoutItem.findMany({ where: { paymentId }, orderBy: { kind: 'asc' } })).map((item) => ({
      kind: item.kind,
      amountRwf: item.amountRwf,
      voided: item.voidedAt !== null,
    }));
  }

  async function totalsOf(bookingId: string) {
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { addons: true, payments: true } });
    return bookingTotals(booking, booking.addons, booking.payments);
  }

  const cancel = (bookingId: string) => cancelByAdmin({ prisma, now: () => clock, photographerId: world.photographerId }, bookingId, null);

  async function refundAlert(paymentId: string) {
    const row = await prisma.outbox.findFirstOrThrow({ where: { dedupeKey: `email:photographer_alert:refund_due:${paymentId}` } });
    return row.payload as Record<string, unknown>;
  }

  async function photographerToken(): Promise<string> {
    const user = await prisma.appUser.findUniqueOrThrow({ where: { id: world.photographerUserId } });
    return (await issueToken(SECRET, 'studio', user, clock)).token;
  }

  it('lists the overpaid part of a succeeded online fee beside a full refund, each once', async () => {
    const { booking, sessionFee } = await overpaidBooking();
    const other = await insertBooking(prisma, world, { status: 'cancelled_by_photographer' });
    const full = await insertPayment(prisma, other.id, { status: 'refund_due', ageSeconds: 300 });

    const listed = await refunds();

    expect(listed.map((row) => row.paymentId).sort()).toEqual([full.id, sessionFee.id].sort());
    expect(listed.find((row) => row.paymentId === sessionFee.id)).toMatchObject({
      refundKind: 'overpayment',
      refundAmountRwf: 10_000,
      overpaidRwf: 10_000,
      amountRwf: 40_000,
      kind: 'session_fee',
      booking: { id: booking.id },
      photographer: { id: world.photographerId },
    });
    expect(listed.find((row) => row.paymentId === full.id)).toMatchObject({ refundKind: 'full', refundAmountRwf: 20_000, overpaidRwf: 0 });
  });

  it('records the overpayment refund: the payment stays succeeded, the entry leaves, and no payout item moves', async () => {
    const { booking, sessionFee } = await overpaidBooking();
    const before = await items(sessionFee.id);
    const sentOn = new Date('2027-11-30T10:00:00.000Z');

    const res = await post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'MTN-OVER-1', refundedAt: sentOn.toISOString() });

    await expectMatchesSpec(res, 'recordPlatformRefund', 200);
    expect(res.body).toStrictEqual({
      refund: {
        paymentId: sessionFee.id,
        kind: 'session_fee',
        provider: 'mtn_momo_direct',
        amountRwf: 40_000,
        status: 'succeeded',
        refundKind: 'overpayment',
        refundAmountRwf: 10_000,
        overpaidRwf: 10_000,
        refundedAt: sentOn.toISOString(),
        refundReference: 'MTN-OVER-1',
        refundedByUserId: admin.id,
      },
    });
    expect(await paymentOf(sessionFee.id)).toMatchObject({
      status: 'succeeded',
      overpaidRwf: 10_000,
      overpaymentRefundedAt: sentOn,
      overpaymentRefundReference: 'MTN-OVER-1',
      overpaymentRefundedByUserId: admin.id,
      refundedAt: null,
      refundReference: null,
      refundedByUserId: null,
    });
    expect(await refunds()).toEqual([]);
    expect(await items(sessionFee.id)).toStrictEqual(before);
    expect(before).toStrictEqual([{ kind: 'earning', amountRwf: 30_000, voided: false }]);
    expect(await totalsOf(booking.id)).toMatchObject({ collectedRwf: 50_000, refundDueRwf: 0, outstandingRwf: 0 });
  });

  it('refuses a second recording as not_refundable, leaving the first reference standing', async () => {
    const { sessionFee } = await overpaidBooking();
    await post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'MTN-OVER-1' });
    const after = await paymentOf(sessionFee.id);

    const again = await post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'MTN-OVER-2' });

    await expectMatchesSpec(again, 'recordPlatformRefund', 409);
    expect(again.body).toEqual({ error: 'not_refundable' });
    expect(await paymentOf(sessionFee.id)).toStrictEqual(after);
  });

  it('records once when two admins record the same overpayment at the same moment', async () => {
    const { sessionFee } = await overpaidBooking();

    const results = await Promise.all([
      post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'A-1' }),
      post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'B-1' }),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(['A-1', 'B-1']).toContain((await paymentOf(sessionFee.id)).overpaymentRefundReference);
  });

  describe('a full refund after an overpayment', () => {
    it('drops the overpayment entry while it was still pending, and refunds the whole amount', async () => {
      const { booking, sessionFee } = await overpaidBooking();

      expect((await cancel(booking.id)).status).toBe('ok');

      const listed = await refunds();
      expect(listed.filter((row) => row.paymentId === sessionFee.id)).toMatchObject([{ refundKind: 'full', refundAmountRwf: 40_000, overpaidRwf: 10_000 }]);
      expect(await refundAlert(sessionFee.id)).toMatchObject({ amountRwf: 40_000, reason: 'admin_cancelled' });
      // The earning voided is the earning's own 30,000: the overpaid part was never earned.
      expect(await items(sessionFee.id)).toStrictEqual([{ kind: 'earning', amountRwf: 30_000, voided: true }]);
      expect(await totalsOf(booking.id)).toMatchObject({ collectedRwf: 0, refundDueRwf: 60_000 });

      const res = await post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'MTN-FULL-1' });
      expect(res.body).toMatchObject({ refund: { status: 'refunded', refundKind: 'full', refundAmountRwf: 40_000, refundReference: 'MTN-FULL-1' } });
      expect(await paymentOf(sessionFee.id)).toMatchObject({ status: 'refunded', overpaymentRefundedAt: null, overpaymentRefundReference: null });
      expect((await refunds()).map((row) => row.paymentId)).not.toContain(sessionFee.id);
    });

    it('reverses the earning’s own amount when it was already in a payout', async () => {
      const { booking, sessionFee } = await overpaidBooking();
      await giveMethod(world);
      await draftFor(world);

      expect((await cancel(booking.id)).status).toBe('ok');

      expect(await items(sessionFee.id)).toStrictEqual([
        { kind: 'earning', amountRwf: 30_000, voided: false },
        { kind: 'reversal', amountRwf: -30_000, voided: false },
      ]);
    });

    it('refunds the amount less the overpaid part when the platform had already returned that part', async () => {
      const { booking, sessionFee } = await overpaidBooking();
      await post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'MTN-OVER-1' });

      expect((await cancel(booking.id)).status).toBe('ok');

      expect((await refunds()).filter((row) => row.paymentId === sessionFee.id)).toMatchObject([{ refundKind: 'full', refundAmountRwf: 30_000, amountRwf: 40_000 }]);
      expect(await refundAlert(sessionFee.id)).toMatchObject({ amountRwf: 30_000 });
      const cancellation = await prisma.outbox.findFirstOrThrow({ where: { template: 'cancellation', bookingId: booking.id } });
      // 20,000 booking fee + 30,000 of the session fee still held.
      expect(cancellation.payload).toMatchObject({ refundRwf: 50_000 });
      expect(await totalsOf(booking.id)).toMatchObject({ refundDueRwf: 50_000 });

      const res = await post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'MTN-FULL-1' });
      expect(res.body).toMatchObject({ refund: { status: 'refunded', refundKind: 'full', refundAmountRwf: 30_000 } });
      // Both records stand: the overpaid part sent first, the rest after.
      expect(await paymentOf(sessionFee.id)).toMatchObject({ refundReference: 'MTN-FULL-1', overpaymentRefundReference: 'MTN-OVER-1' });
    });

    it('records the full refund when both could apply, leaving the overpayment columns empty', async () => {
      // Not reachable through the app -- refund_due covers the overpaid part --
      // but if it ever were, the full refund takes precedence.
      const booking = await insertBooking(prisma, world, { status: 'cancelled_by_photographer' });
      const payment = await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', amountRwf: 40_000, overpaidRwf: 10_000 });

      expect(await refunds()).toMatchObject([{ paymentId: payment.id, refundKind: 'full', refundAmountRwf: 40_000 }]);
      const res = await post(`/api/platform/refunds/${payment.id}`, { reference: 'MTN-BOTH-1' });

      expect(res.body).toMatchObject({ refund: { refundKind: 'full', status: 'refunded', refundAmountRwf: 40_000 } });
      expect(await paymentOf(payment.id)).toMatchObject({ status: 'refunded', refundReference: 'MTN-BOTH-1', overpaymentRefundedAt: null, overpaymentRefundReference: null });
      expect(await refunds()).toEqual([]);
    });
  });

  describe('the kind the admin meant', () => {
    it('refuses refund_kind_mismatch when the list changed under them, writing nothing', async () => {
      const { booking, sessionFee } = await overpaidBooking();
      // The admin sends back the 10,000 from the list; meanwhile the booking is cancelled.
      await cancel(booking.id);
      const before = await paymentOf(sessionFee.id);

      const res = await post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'MTN-OVER-1', refundKind: 'overpayment' });

      await expectMatchesSpec(res, 'recordPlatformRefund', 409);
      expect(res.body).toEqual({ error: 'refund_kind_mismatch', pending: 'full' });
      expect(await paymentOf(sessionFee.id)).toStrictEqual(before);
    });

    it('records when the kind named is the one pending', async () => {
      const { sessionFee } = await overpaidBooking();
      const res = await post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'MTN-OVER-1', refundKind: 'overpayment' });
      expect(res.body).toMatchObject({ refund: { refundKind: 'overpayment' } });
      // A kind outside the vocabulary is a malformed request.
      expect((await post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'X', refundKind: 'sideways' })).status).toBe(400);
    });
  });

  describe('references, used once across every online refund', () => {
    async function fullRefundDue(ageSeconds = 0) {
      const booking = await insertBooking(prisma, world, { status: 'cancelled_by_photographer' });
      return insertPayment(prisma, booking.id, { status: 'refund_due', ageSeconds });
    }

    it('refuses a duplicate between two full refunds', async () => {
      const first = await fullRefundDue();
      const second = await fullRefundDue(60);
      await post(`/api/platform/refunds/${first.id}`, { reference: 'MTN-DUP' });

      const res = await post(`/api/platform/refunds/${second.id}`, { reference: 'MTN-DUP' });

      await expectMatchesSpec(res, 'recordPlatformRefund', 409);
      expect(res.body).toEqual({ error: 'duplicate_refund_reference' });
      expect(await paymentOf(second.id)).toMatchObject({ status: 'refund_due', refundReference: null, refundedByUserId: null });
    });

    it('refuses a duplicate between two overpayment refunds, across photographers', async () => {
      const second = await seedSecondPhotographer(prisma, world);
      const mine = await overpaidBooking();
      const theirs = await overpaidBooking(second);
      await post(`/api/platform/refunds/${mine.sessionFee.id}`, { reference: 'MTN-DUP' });

      const res = await post(`/api/platform/refunds/${theirs.sessionFee.id}`, { reference: 'MTN-DUP' });

      expect(res.body).toEqual({ error: 'duplicate_refund_reference' });
      expect(await paymentOf(theirs.sessionFee.id)).toMatchObject({ overpaymentRefundedAt: null, overpaymentRefundReference: null });
    });

    it('refuses a duplicate across kinds, in either order', async () => {
      const overpaid = await overpaidBooking();
      const full = await fullRefundDue();
      await post(`/api/platform/refunds/${full.id}`, { reference: 'FULL-FIRST' });
      expect((await post(`/api/platform/refunds/${overpaid.sessionFee.id}`, { reference: 'FULL-FIRST' })).body).toEqual({ error: 'duplicate_refund_reference' });

      await post(`/api/platform/refunds/${overpaid.sessionFee.id}`, { reference: 'OVER-FIRST' });
      const later = await fullRefundDue(60);
      expect((await post(`/api/platform/refunds/${later.id}`, { reference: 'OVER-FIRST' })).body).toEqual({ error: 'duplicate_refund_reference' });
      expect(await paymentOf(later.id)).toMatchObject({ status: 'refund_due', refundReference: null });
    });

    it('records one of two different payments racing with one reference', async () => {
      const overpaid = await overpaidBooking();
      const full = await fullRefundDue();

      const results = await Promise.all([
        post(`/api/platform/refunds/${overpaid.sessionFee.id}`, { reference: 'RACE-1' }),
        post(`/api/platform/refunds/${full.id}`, { reference: 'RACE-1' }),
      ]);

      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(results.find((res) => res.status === 409)?.body).toEqual({ error: 'duplicate_refund_reference' });
      const written = await prisma.payment.count({ where: { OR: [{ refundReference: 'RACE-1' }, { overpaymentRefundReference: 'RACE-1' }] } });
      expect(written).toBe(1);
    });

    it('leaves cash outside the rule: the photographer may reuse words an online refund used', async () => {
      const full = await fullRefundDue();
      await post(`/api/platform/refunds/${full.id}`, { reference: 'Handed back' });
      const booking = await insertBooking(prisma, world, { status: 'cancelled_by_photographer' });
      const cashA = await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', provider: 'cash', amountRwf: 10_000 });
      const cashB = await insertPayment(prisma, booking.id, { status: 'refund_due', kind: 'session_fee', provider: 'cash', amountRwf: 5_000, ageSeconds: 60 });
      const studio = await photographerToken();

      for (const cash of [cashA, cashB]) {
        const res = await post(`/api/studio/payments/${cash.id}/refund`, { reference: 'Handed back' }, studio);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      expect(await prisma.payment.count({ where: { refundReference: 'Handed back' } })).toBe(3);
    });
  });

  it('refuses cash and a payment with nothing pending', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });
    const cash = await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', provider: 'cash', amountRwf: 10_000 });
    const exact = await insertPayment(prisma, booking.id, { status: 'succeeded', kind: 'session_fee', amountRwf: 20_000 });

    expect((await post(`/api/platform/refunds/${cash.id}`, { reference: 'R-1' })).body).toEqual({ error: 'cash_payment' });
    expect((await post(`/api/platform/refunds/${exact.id}`, { reference: 'R-1' })).body).toEqual({ error: 'not_refundable' });
    expect(await prisma.payment.count({ where: { overpaymentRefundReference: { not: null } } })).toBe(0);
  });

  it.each(['studio', 'account'] as const)('refuses a %s token on an overpayment, and nothing changes', async (area) => {
    const { sessionFee } = await overpaidBooking();
    const user = area === 'studio'
      ? await prisma.appUser.findUniqueOrThrow({ where: { id: world.photographerUserId } })
      : await prisma.appUser.create({ data: { email: 'client@bookly.example', role: 'client', passwordHash: 'x', emailVerifiedAt: NOW } });
    const other = (await issueToken(SECRET, area, user, clock)).token;
    const before = await paymentOf(sessionFee.id);

    expect((await get('/api/platform/refunds', other)).status).toBe(401);
    expect((await post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'R-1' }, other)).status).toBe(401);
    expect(await paymentOf(sessionFee.id)).toStrictEqual(before);
  });

  it('shows the studio the overpayment pending with the platform, then returned', async () => {
    const { booking, sessionFee } = await overpaidBooking();
    const studio = await photographerToken();
    type ViewPayment = { id: string; overpaidRwf: number; overpaymentRefundPendingWithPlatform: boolean; overpaymentRefundedAt: string | null; overpaymentRefundReference: string | null; canRecordRefund: boolean; refundPendingWithPlatform: boolean };
    const view = async () => {
      const res = await get(`/api/studio/bookings/${booking.id}`, studio);
      await expectMatchesSpec(res, 'getBooking', 200);
      return (res.body as { booking: { payments: ViewPayment[] } }).booking.payments.find((row) => row.id === sessionFee.id);
    };

    expect(await view()).toMatchObject({
      overpaidRwf: 10_000,
      overpaymentRefundPendingWithPlatform: true,
      overpaymentRefundedAt: null,
      overpaymentRefundReference: null,
      canRecordRefund: false,
      refundPendingWithPlatform: false,
    });

    await post(`/api/platform/refunds/${sessionFee.id}`, { reference: 'MTN-OVER-1' });

    expect(await view()).toMatchObject({ overpaymentRefundPendingWithPlatform: false, overpaymentRefundedAt: NOW.toISOString(), overpaymentRefundReference: 'MTN-OVER-1' });
    // And the photographer cannot record it: it is money paid online.
    expect((await post(`/api/studio/payments/${sessionFee.id}/refund`, { reference: 'MINE' }, studio)).body).toMatchObject({ error: 'refund_with_platform' });
  });

  it('shows the studio the full refund pending instead, once the overpaid payment is owed back whole', async () => {
    const { booking, sessionFee } = await overpaidBooking();
    await cancel(booking.id);
    const res = await get(`/api/studio/bookings/${booking.id}`, await photographerToken());
    const payment = (res.body as { booking: { payments: { id: string; overpaymentRefundPendingWithPlatform: boolean; refundPendingWithPlatform: boolean }[] } }).booking.payments.find(
      (row) => row.id === sessionFee.id,
    );
    expect(payment).toMatchObject({ overpaymentRefundPendingWithPlatform: false, refundPendingWithPlatform: true });
  });
});
