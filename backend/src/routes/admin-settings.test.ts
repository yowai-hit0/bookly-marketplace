import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { issueAdminToken } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { type PhotographerSettings, getPhotographerSettings, getPlatformSettings } from '../settings/index.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type PaymentWorld, insertBooking, seedSecondPhotographer, seedWorld } from '../test/payment-fixtures.js';

/**
 * `/api/admin/settings` over HTTP, against real PostgreSQL (plan.md Task 8;
 * spec §3.3 step 2, P-15, P-24, P-30; data-model_v2.md §5.2, §5.9).
 *
 * The signed-in photographer's six values (brief decision 5,
 * marketplace-spec.md R1.8) are editable and persist, and each is range-checked
 * before it reaches the `photographer_setting` CHECKs, so a bad value is a 422
 * naming the field -- never a 23514 surfacing as a 500. "Persists" is asserted
 * through `getPhotographerSettings()`, the one accessor every business module
 * reads from, not just through the response the route chose to send.
 *
 * The checkout hold is the platform's now: it is not in this API, a PATCH
 * naming it is a 400, and the platform's value never moves. Each photographer
 * reads and writes only their own row (R1.4).
 *
 * The buffer, the fee rate and the cancellation policy are snapshotted per
 * booking: changing them must not move an existing reservation or its terms,
 * and that is asserted against the stored columns.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let passwordHash: string;
let token: string;
let app: Express;

const SECRET = 'admin-settings-test-secret-at-least-32-characters-long';
const WEB_ORIGIN = 'https://admin.bookly.example';
const NOW = new Date('2026-09-30T08:00:00Z');
const PATH = '/api/admin/settings';
const INT4_MAX = 2_147_483_647;

type Settings = PhotographerSettings;

/** The schema defaults, which are what approval leaves a photographer with. */
const DEFAULTS: Settings = {
  bookingFeeRate: 0.4,
  minLeadTimeMinutes: 120,
  bufferMinutes: 30,
  deliveryExpiryDays: 90,
  clientCancelCutoffHours: 0,
  bookingFeeRefundableOnClientCancel: false,
};

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
  passwordHash = await hashPassword('correct horse battery staple');
});

afterAll(async () => {
  // settings.test.ts seeds without truncating and asserts the defaults; an
  // edited row left here would fail it.
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  world = await seedWorld(prisma);
  const user = await prisma.appUser.update({ where: { id: world.photographerUserId }, data: { passwordHash } });
  token = (await issueAdminToken(SECRET, user, NOW)).token;
  app = createApp({
    corsOrigin: WEB_ORIGIN,
    admin: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => NOW },
  });
});

// --- Fixtures ---------------------------------------------------------------

function getRoute(bearer: string | null = token): request.Test {
  const req = request(app).get(PATH);
  return bearer === null ? req : req.set('Authorization', `Bearer ${bearer}`);
}

function patch(body: unknown, bearer: string | null = token): request.Test {
  const req = request(app).patch(PATH);
  if (bearer !== null) req.set('Authorization', `Bearer ${bearer}`);
  return req.send(body as object);
}

function expectSettings(res: Response, settings: Settings): void {
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ settings });
}

/** The same values again through the accessor business logic uses, and GET. */
async function expectPersisted(settings: Settings): Promise<void> {
  await expect(mine()).resolves.toEqual(settings);
  expectSettings(await getRoute(), settings);
}

/** The signed-in photographer's row, through the accessor. */
function mine(): Promise<Settings> {
  return getPhotographerSettings(world.photographerId, prisma);
}

// --- Auth -------------------------------------------------------------------------

describe('/api/admin/settings without a valid token', () => {
  it.each<[string, string | null]>([
    ['no token', null],
    ['a garbage token', 'not.a.token'],
  ])('answers GET and PATCH with 401 for %s, changing nothing', async (_label, bearer) => {
    const responses = [await getRoute(bearer), await patch({ bookingFeeRate: 0.9, bufferMinutes: 5 }, bearer)];

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthenticated' });
      expect(String(res.headers['www-authenticate'])).toMatch(/^Bearer realm="bookly-admin"/);
    }
    await expect(mine()).resolves.toEqual(DEFAULTS);
  });
});

// --- GET --------------------------------------------------------------------------

describe('GET /api/admin/settings', () => {
  it('returns exactly the six values a photographer sets, and not the platform’s hold', async () => {
    const res = await getRoute();

    expectSettings(res, DEFAULTS);
    expect(Object.keys((res.body as { settings: Settings }).settings).sort()).toEqual([
      'bookingFeeRate',
      'bookingFeeRefundableOnClientCancel',
      'bufferMinutes',
      'clientCancelCutoffHours',
      'deliveryExpiryDays',
      'minLeadTimeMinutes',
    ]);
  });

  it('returns the signed-in photographer’s own row, never another’s', async () => {
    const second = await seedSecondPhotographer(prisma, world);
    await prisma.photographerSetting.update({
      where: { photographerId: second.photographerId },
      data: { bufferMinutes: 75, clientCancelCutoffHours: 48 },
    });

    expectSettings(await getRoute(), DEFAULTS);
  });

  it('returns the fee rate as a JSON number, never a Decimal string', async () => {
    const res = await getRoute();

    expect(res.text).toContain('"bookingFeeRate":0.4');
  });
});

// --- PATCH: values that save --------------------------------------------------------

describe('PATCH /api/admin/settings', () => {
  it.each<[keyof Settings, number | boolean]>([
    ['bookingFeeRate', 0.5],
    ['bookingFeeRate', 0],
    ['bookingFeeRate', 1],
    ['bookingFeeRate', 0.001],
    ['bookingFeeRate', 0.035],
    ['minLeadTimeMinutes', 0],
    ['minLeadTimeMinutes', 1440],
    ['minLeadTimeMinutes', INT4_MAX],
    ['bufferMinutes', 0],
    ['bufferMinutes', 60],
    ['deliveryExpiryDays', 1],
    ['deliveryExpiryDays', 365],
    ['clientCancelCutoffHours', 0],
    ['clientCancelCutoffHours', 24],
    ['clientCancelCutoffHours', INT4_MAX],
    ['bookingFeeRefundableOnClientCancel', true],
    ['bookingFeeRefundableOnClientCancel', false],
  ])('saves %s = %s, leaving the other five untouched', async (key, value) => {
    const expected = { ...DEFAULTS, [key]: value };

    expectSettings(await patch({ [key]: value }), expected);

    await expectPersisted(expected);
  });

  it('saves all six at once', async () => {
    const all: Settings = {
      bookingFeeRate: 0.25,
      minLeadTimeMinutes: 60,
      bufferMinutes: 45,
      deliveryExpiryDays: 30,
      clientCancelCutoffHours: 48,
      bookingFeeRefundableOnClientCancel: true,
    };

    expectSettings(await patch(all), all);

    await expectPersisted(all);
  });

  it('keeps earlier edits when a later PATCH names other values', async () => {
    await patch({ bufferMinutes: 45 });
    await patch({ clientCancelCutoffHours: 20 });

    await expectPersisted({ ...DEFAULTS, bufferMinutes: 45, clientCancelCutoffHours: 20 });
  });

  it('writes the signed-in photographer’s row only: another photographer’s stays as it was', async () => {
    const second = await seedSecondPhotographer(prisma, world);

    await patch({ bufferMinutes: 45, clientCancelCutoffHours: 12, bookingFeeRefundableOnClientCancel: true });

    await expect(getPhotographerSettings(second.photographerId, prisma)).resolves.toEqual(DEFAULTS);
  });

  it('stores a rate of 0.125 exactly, with no float residue in the column', async () => {
    expectSettings(await patch({ bookingFeeRate: 0.125 }), { ...DEFAULTS, bookingFeeRate: 0.125 });

    const row = firstRow(
      await raw.query<{ rate: string }>(`SELECT booking_fee_rate::text AS rate FROM photographer_setting WHERE photographer_id = $1`, [
        world.photographerId,
      ]),
    );
    expect(row.rate).toBe('0.125');
    await expect(mine()).resolves.toMatchObject({ bookingFeeRate: 0.125 });
  });

  it('answers an empty object with 200 and the values unchanged', async () => {
    await patch({ bufferMinutes: 45 });

    expectSettings(await patch({}), { ...DEFAULTS, bufferMinutes: 45 });

    await expectPersisted({ ...DEFAULTS, bufferMinutes: 45 });
  });

  // --- PATCH: rule violations -------------------------------------------------------

  it('answers a rate above 1 with 422, not a 23514 from the database', async () => {
    const res = await patch({ bookingFeeRate: 1.5 });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'validation_failed', fields: ['bookingFeeRate'] });
    await expect(mine()).resolves.toEqual(DEFAULTS);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['a rate just above 1', { bookingFeeRate: 1.001 }, ['bookingFeeRate']],
    ['a rate of 2', { bookingFeeRate: 2 }, ['bookingFeeRate']],
    ['a negative rate', { bookingFeeRate: -0.001 }, ['bookingFeeRate']],
    ['a rate with four decimal places', { bookingFeeRate: 0.4567 }, ['bookingFeeRate']],
    ['a rate below the third decimal place', { bookingFeeRate: 0.0001 }, ['bookingFeeRate']],
    ['a negative lead time', { minLeadTimeMinutes: -1 }, ['minLeadTimeMinutes']],
    ['a negative cancellation cut-off', { clientCancelCutoffHours: -1 }, ['clientCancelCutoffHours']],
    ['a negative buffer', { bufferMinutes: -1 }, ['bufferMinutes']],
    ['a zero delivery expiry', { deliveryExpiryDays: 0 }, ['deliveryExpiryDays']],
    ['a negative delivery expiry', { deliveryExpiryDays: -1 }, ['deliveryExpiryDays']],
    ['a lead time past int4', { minLeadTimeMinutes: INT4_MAX + 1 }, ['minLeadTimeMinutes']],
    ['a cancellation cut-off past int4', { clientCancelCutoffHours: INT4_MAX + 1 }, ['clientCancelCutoffHours']],
    ['a buffer past int4', { bufferMinutes: INT4_MAX + 1 }, ['bufferMinutes']],
    ['a delivery expiry past int4', { deliveryExpiryDays: INT4_MAX + 1 }, ['deliveryExpiryDays']],
    ['a buffer past the safe-integer range', { bufferMinutes: 1e20 }, ['bufferMinutes']],
    ['two out-of-range values', { bufferMinutes: -1, deliveryExpiryDays: 0 }, ['bufferMinutes', 'deliveryExpiryDays']],
  ])('answers %s with 422 naming the fields, saving nothing', async (_label, body, fields) => {
    const res = await patch(body);

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'validation_failed', fields });
    await expect(mine()).resolves.toEqual(DEFAULTS);
  });

  // --- PATCH: malformed requests ------------------------------------------------------

  it.each<[string, unknown]>([
    ['fractional minutes', { bufferMinutes: 30.5 }],
    ['a fractional cut-off', { clientCancelCutoffHours: 0.5 }],
    ['minutes as a string', { bufferMinutes: '30' }],
    ['the refund flag as a string', { bookingFeeRefundableOnClientCancel: 'true' }],
    ['a null refund flag', { bookingFeeRefundableOnClientCancel: null }],
    ['the checkout hold, which is the platform’s now (brief decision 5)', { holdMinutes: 45 }],
    ['the hold alongside a valid value', { holdMinutes: 45, bufferMinutes: 45 }],
    ['a photographer id, which only the token decides', { photographerId: '00000000-0000-4000-8000-000000000000', bufferMinutes: 45 }],
    ['a rate as a string', { bookingFeeRate: '0.5' }],
    ['a null rate', { bookingFeeRate: null }],
    ['a null lead time', { minLeadTimeMinutes: null }],
    ['a boolean expiry', { deliveryExpiryDays: true }],
    ['a misspelt key', { bufferMinute: 45 }],
    ['a snake_case key', { booking_fee_rate: 0.5 }],
    ['the payment provider, which is not a setting (data-model_v2.md §5.2)', { paymentProvider: 'flutterwave' }],
    ['an id alongside a valid value', { id: 2, bufferMinutes: 45 }],
    ['a valid value alongside a malformed one', { bookingFeeRate: 0.5, bufferMinutes: 30.5 }],
    ['a rule violation alongside a malformed value', { deliveryExpiryDays: 0, bufferMinutes: '30' }],
    ['a JSON array', [{ bufferMinutes: 45 }]],
  ])('answers %s with 400, saving nothing', async (_label, body) => {
    const res = await patch(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    await expect(mine()).resolves.toEqual(DEFAULTS);
    await expect(getPlatformSettings(prisma)).resolves.toMatchObject({ holdMinutes: 30 });
  });

  it('answers malformed JSON with 400', async () => {
    const res = await request(app)
      .patch(PATH)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send('{"bufferMinutes": ');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
  });

  it('saves none of a PATCH that fails, even the values in it that were valid', async () => {
    await patch({ bufferMinutes: 45 });
    const edited = { ...DEFAULTS, bufferMinutes: 45 };

    expect((await patch({ bufferMinutes: 60, bookingFeeRate: 0.3, deliveryExpiryDays: 0 })).status).toBe(422);
    expect((await patch({ bufferMinutes: 60, bookingFeeRate: 0.3, typo: 1 })).status).toBe(400);

    await expectPersisted(edited);
  });
});

// --- data-model_v2.md §5.9, R1.8: a booking keeps what it was made under ---------------

describe('changing the settings after a booking', () => {
  // Wednesday 6 January 2027, 09:00-10:30 Kigali, buffered with the 30 in force when made.
  const STARTS_AT = new Date('2027-01-06T07:00:00Z');

  async function bufferEndsAtMs(id: string): Promise<number> {
    const row = firstRow(
      await raw.query<{ ms: string }>(
        `SELECT (extract(epoch from buffer_ends_at) * 1000)::bigint AS ms FROM booking WHERE id = $1`,
        [id],
      ),
    );
    return Number(row.ms);
  }

  it.each([0, 90])('to a buffer of %i does not move an existing booking’s buffer_ends_at', async (bufferMinutes) => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: STARTS_AT });
    const bufferEndsAt = await bufferEndsAtMs(booking.id);

    expectSettings(await patch({ bufferMinutes }), { ...DEFAULTS, bufferMinutes });

    await expect(bufferEndsAtMs(booking.id)).resolves.toBe(bufferEndsAt);
    await expect(prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).resolves.toEqual(booking);
  });

  it('does not move the fee rate a booking was quoted either (spec §6.13)', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: STARTS_AT });

    await patch({ bookingFeeRate: 0.25 });

    const row = firstRow(
      await raw.query<{ rate: string }>(`SELECT booking_fee_rate::text AS rate FROM booking WHERE id = $1`, [
        booking.id,
      ]),
    );
    expect(row.rate).toBe('0.400');
  });

  it('does not change the cancellation terms a booking was made under (R1.8)', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed', startsAt: STARTS_AT, clientCancelCutoffHours: 24 });

    await patch({ clientCancelCutoffHours: 72, bookingFeeRefundableOnClientCancel: true });

    await expect(prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).resolves.toMatchObject({
      clientCancelCutoffHours: 24,
      bookingFeeRefundableOnClientCancel: false,
    });
  });
});
