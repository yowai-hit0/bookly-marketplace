import type { AppUser, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { SignJWT } from 'jose';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { LOCKOUT_THRESHOLD } from '../auth/account-auth.js';
import { hashPassword } from '../auth/password.js';
import { TOKEN_AUDIENCES, TOKEN_ISSUER, TOKEN_TTL_SECONDS, credentialFingerprint, issueToken } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { approvePhotographer, reactivatePhotographer, suspendPhotographer } from '../photographers/moderation.js';
import { isBookable } from '../photographers/bookable.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { expectMatchesSpec, loadSpec, specOperations } from '../test/openapi.js';
import {
  PHOTOGRAPHER_EMAIL,
  PHOTOGRAPHER_HANDLE,
  PHOTOGRAPHER_NAME,
  PLATFORM_ADMIN_EMAIL,
  type PaymentWorld,
  createPhotographer,
  insertBooking,
  logSink,
  seedWorld,
} from '../test/payment-fixtures.js';

/**
 * `/api/platform/*` over HTTP, against real PostgreSQL (Phase 2 decision 7;
 * marketplace-spec.md R9.1, R9.4, T9.1): the platform admin's login and reset,
 * `/me`, and moderating photographers -- list, approve, suspend, reactivate.
 *
 * Every transition is checked for its row (status, who, when), its email, its
 * idempotency and its behaviour under a race; every platform route for refusing
 * every token but a platform admin's.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let clock: Date;
let world: PaymentWorld;
let admin: AppUser;
let token: string;
let passwordHash: string;

const SECRET = 'platform-routes-test-secret-at-least-32-characters';
const WEB_ORIGIN = 'https://bookly.example';
const PASSWORD = 'the platform admin passphrase';
const WRONG = 'not the platform admin passphrase';
const START = new Date('2026-10-17T07:00:00Z');
const MINUTE_MS = 60_000;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const PENDING_EMAIL = 'pending.photographer@bookly.example';

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

beforeEach(async () => {
  // The structured log of each moderation action (R9.4) goes to stdout; keep the run quiet.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await truncateAll(raw);
  clock = START;
  world = await seedWorld(prisma);
  const seeded = await prisma.appUser.findFirstOrThrow({ where: { role: 'platform_admin' } });
  admin = await prisma.appUser.update({ where: { id: seeded.id }, data: { passwordHash } });
  token = (await issueToken(SECRET, 'platform', admin, clock)).token;
  app = createApp({ corsOrigin: WEB_ORIGIN, auth: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock } });
});

// --- Fixtures ------------------------------------------------------------------------

function get(path: string, bearer: string | null = token): request.Test {
  const req = request(app).get(path);
  return bearer === null ? req : req.set('Authorization', `Bearer ${bearer}`);
}

function post(path: string, body?: object, bearer: string | null = token): request.Test {
  const req = request(app).post(path);
  const authed = bearer === null ? req : req.set('Authorization', `Bearer ${bearer}`);
  return body === undefined ? authed : authed.send(body);
}

const approve = (id: string, bearer?: string | null) => post(`/api/platform/photographers/${id}/approve`, undefined, bearer);
const suspend = (id: string, reason: unknown = 'Clients reported shoots that never happened.', bearer?: string | null) =>
  post(`/api/platform/photographers/${id}/suspend`, { reason }, bearer);
const reactivate = (id: string, bearer?: string | null) => post(`/api/platform/photographers/${id}/reactivate`, undefined, bearer);

async function pendingPhotographer(): Promise<string> {
  return (await createPhotographer(prisma, { email: PENDING_EMAIL, handle: 'new-in-town', displayName: 'New in Town', status: 'pending' })).photographerId;
}

function photographerRow(id: string) {
  return prisma.photographer.findUniqueOrThrow({ where: { id }, include: { subscription: true } });
}

const DAY_MS = 24 * 60 * MINUTE_MS;

/** Bookable at the test's clock, by the one rule (photographers/bookable.ts, R5.4). */
function bookable(row: Awaited<ReturnType<typeof photographerRow>>): boolean {
  return isBookable(row, row.subscription, clock);
}

function emails(template: 'photographer_approved' | 'photographer_suspended') {
  return prisma.outbox.findMany({ where: { template }, orderBy: { createdAt: 'asc' } });
}

async function photographerUser(): Promise<AppUser> {
  return prisma.appUser.findUniqueOrThrow({ where: { id: world.photographerUserId } });
}

async function clientUser(): Promise<AppUser> {
  return prisma.appUser.create({ data: { email: 'client.account@bookly.example', role: 'client', passwordHash, emailVerifiedAt: START } });
}

function expectUnauthenticated(res: Response, error?: 'invalid_token'): void {
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'unauthenticated' });
  const challenge = String(res.headers['www-authenticate']);
  expect(challenge).toMatch(/^Bearer realm="bookly-platform"/);
  if (error === undefined) expect(challenge).not.toContain('error=');
  else expect(challenge).toContain(`error="${error}"`);
}

// --- Auth ----------------------------------------------------------------------------

describe('POST /api/platform/auth/login', () => {
  const login = (email: string, password: string) => request(app).post('/api/platform/auth/login').send({ email, password });

  it('signs a platform admin in with a bookly-platform token valid 8 hours', async () => {
    const res = await login(PLATFORM_ADMIN_EMAIL, PASSWORD);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      user: { id: admin.id, email: PLATFORM_ADMIN_EMAIL, lastLoginAt: START.toISOString() },
      tokenType: 'Bearer',
      expiresAt: new Date(START.getTime() + TOKEN_TTL_SECONDS.platform * 1000).toISOString(),
    });
    await expectMatchesSpec(res, 'platformLogin', 200);
    expect((await get('/api/platform/me', (res.body as { token: string }).token)).status).toBe(200);
  });

  it('answers a wrong password, an unknown email, a photographer and a client identically, counting only the admin’s own failure', async () => {
    await prisma.appUser.update({ where: { id: world.photographerUserId }, data: { passwordHash } });
    const client = await clientUser();
    const photographerBefore = await photographerUser();

    const unknown = await login('nobody@bookly.example', PASSWORD);
    const wrong = await login(PLATFORM_ADMIN_EMAIL, WRONG);
    const photographer = await login(PHOTOGRAPHER_EMAIL, PASSWORD);
    const asClient = await login(client.email, PASSWORD);

    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({ error: 'invalid_credentials' });
    for (const res of [wrong, photographer, asClient]) {
      expect(res.status).toBe(unknown.status);
      expect(res.text).toBe(unknown.text);
    }
    await expect(photographerUser()).resolves.toEqual(photographerBefore);
    await expect(prisma.appUser.findUniqueOrThrow({ where: { id: client.id } })).resolves.toEqual(client);
    await expect(prisma.appUser.findUniqueOrThrow({ where: { id: admin.id } })).resolves.toMatchObject({ failedLoginCount: 1 });
  });

  it('locks the platform admin after repeated failures and alerts them with the platform sign-in page', async () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) await login(PLATFORM_ADMIN_EMAIL, WRONG);

    expect((await login(PLATFORM_ADMIN_EMAIL, PASSWORD)).status).toBe(401);
    const alerts = await prisma.outbox.findMany({ where: { template: 'account_security_alert' } });
    expect(alerts.map((row) => [row.recipient, (row.payload as { area: string }).area])).toEqual([[PLATFORM_ADMIN_EMAIL, 'platform']]);
  }, 30_000);
});

describe('platform password reset over HTTP', () => {
  const requestReset = (email: string) => request(app).post('/api/platform/auth/password-reset/request').send({ email });

  async function latestResetUrl(): Promise<URL> {
    const row = await prisma.outbox.findFirstOrThrow({ where: { template: 'account_password_reset' }, orderBy: { createdAt: 'desc' } });
    return new URL(String((row.payload as { resetUrl: string }).resetUrl));
  }

  it('emails a link to /platform/reset-password, answers like an unknown email, and the link sets the password', async () => {
    const unknown = await requestReset('nobody@bookly.example');
    const known = await requestReset(PLATFORM_ADMIN_EMAIL);

    expect([known.status, known.text]).toEqual([unknown.status, unknown.text]);
    const url = await latestResetUrl();
    expect(url.origin + url.pathname).toBe(`${WEB_ORIGIN}/platform/reset-password`);

    const resetToken = url.hash.slice('#token='.length);
    const confirm = await request(app).post('/api/platform/auth/password-reset/confirm').send({ token: resetToken, newPassword: 'a brand new admin passphrase' });
    expect(confirm.status).toBe(204);
    // The token issued before the reset no longer works (T2.5).
    expectUnauthenticated(await get('/api/platform/me'), 'invalid_token');
  });

  it('sends a photographer and a client no platform reset link', async () => {
    const client = await clientUser();

    for (const email of [PHOTOGRAPHER_EMAIL, client.email]) expect((await requestReset(email)).status).toBe(202);

    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('refuses a studio reset token at the platform confirm', async () => {
    await request(app).post('/api/studio/auth/password-reset/request').send({ email: PHOTOGRAPHER_EMAIL });
    const resetToken = (await latestResetUrl()).hash.slice('#token='.length);

    const res = await request(app).post('/api/platform/auth/password-reset/confirm').send({ token: resetToken, newPassword: 'a brand new passphrase here' });

    expect([res.status, res.body]).toEqual([400, { error: 'invalid_or_expired_token' }]);
  });
});

describe('GET /api/platform/me', () => {
  it('answers with the public user only', async () => {
    const res = await get('/api/platform/me');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { id: admin.id, email: PLATFORM_ADMIN_EMAIL, lastLoginAt: null } });
    await expectMatchesSpec(res, 'getPlatformMe', 200);
  });

  it('refuses the token once the admin is disabled (T2.5)', async () => {
    await prisma.appUser.update({ where: { id: admin.id }, data: { disabledAt: START } });

    expectUnauthenticated(await get('/api/platform/me'), 'invalid_token');
  });
});

// --- Every platform route refuses every other token (T9.1) --------------------------

describe('who the platform admits', () => {
  /** Every non-auth platform operation in the spec, with its parameters filled in. */
  async function platformRoutes(): Promise<{ method: 'get' | 'post'; path: string }[]> {
    const operations = specOperations(await loadSpec()).filter((op) => op.path.startsWith('/api/platform/') && !op.path.startsWith('/api/platform/auth/'));
    // Every path parameter (`:id`, `:paymentId`) gets a real row's id, so a leak would act on something.
    return operations.map((op) => ({ method: op.method as 'get' | 'post', path: op.path.replace(/:\w+/g, world.photographerId) }));
  }

  async function forged(user: AppUser, aud: string, role: string): Promise<string> {
    const now = Math.floor(clock.getTime() / 1000);
    return new SignJWT({ role, cred_fp: credentialFingerprint(SECRET, user) })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(aud)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(SECRET));
  }

  it('covers every platform route the spec declares', async () => {
    // Moderation (5), Phase 4's payouts and refunds (8), and Phase 5's settings (2) and subscriptions (1).
    expect((await platformRoutes()).length).toBe(16);
  });

  it.each<[string, () => Promise<string | null>, 'invalid_token' | undefined]>([
    ['no token', () => Promise.resolve(null), undefined],
    ['a photographer’s studio token', async () => (await issueToken(SECRET, 'studio', await photographerUser(), clock)).token, 'invalid_token'],
    ['a client’s account token', async () => (await issueToken(SECRET, 'account', await clientUser(), clock)).token, 'invalid_token'],
    ['a photographer’s credentials signed for the platform audience', async () => forged(await photographerUser(), TOKEN_AUDIENCES.platform, 'photographer'), 'invalid_token'],
    ['a photographer’s credentials claiming platform_admin', async () => forged(await photographerUser(), TOKEN_AUDIENCES.platform, 'platform_admin'), 'invalid_token'],
    ['the platform admin’s credentials signed for the studio audience', () => forged(admin, TOKEN_AUDIENCES.studio, 'platform_admin'), 'invalid_token'],
  ])('refuses %s on every platform route with 401, changing nothing', async (_label, bearer, error) => {
    const before = await photographerRow(world.photographerId);
    const credential = await bearer();

    for (const route of await platformRoutes()) {
      const req = request(app)[route.method](route.path);
      const res = await (credential === null ? req : req.set('Authorization', `Bearer ${credential}`)).send({ reason: 'x' });
      expectUnauthenticated(res, error);
    }
    await expect(photographerRow(world.photographerId)).resolves.toEqual(before);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('answers an unknown platform path with 401 before sign-in and 404 after', async () => {
    expectUnauthenticated(await get('/api/platform/nope', null));
    expect((await get('/api/platform/nope')).status).toBe(404);
  });
});

// --- Listing ----------------------------------------------------------------------------

describe('GET /api/platform/photographers', () => {
  it('lists every photographer, newest first, with their login email and moderation record', async () => {
    const pendingId = await pendingPhotographer();

    const res = await get('/api/platform/photographers');

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'listPlatformPhotographers', 200);
    const { photographers } = res.body as { photographers: { id: string; email: string; status: string; handle: string }[] };
    expect(photographers.map((p) => [p.id, p.email, p.status])).toEqual([
      [pendingId, PENDING_EMAIL, 'pending'],
      [world.photographerId, PHOTOGRAPHER_EMAIL, 'approved'],
    ]);
    expect(photographers[1]).toMatchObject({ handle: PHOTOGRAPHER_HANDLE, displayName: PHOTOGRAPHER_NAME, approvedAt: '2026-09-02T06:00:00.000Z' });
  });

  it.each(['pending', 'approved', 'suspended'])('filters by status=%s', async (status) => {
    const pendingId = await pendingPhotographer();
    const expected = { pending: [pendingId], approved: [world.photographerId], suspended: [] }[status];

    const res = await get(`/api/platform/photographers?status=${status}`);

    expect((res.body as { photographers: { id: string }[] }).photographers.map((p) => p.id)).toEqual(expected);
  });

  it.each(['?status=banned', '?status=pending&status=approved', '?page=2'])('answers %s with 400', async (query) => {
    expect((await get(`/api/platform/photographers${query}`)).body).toEqual({ error: 'invalid_request' });
  });

  it('never shows a password hash, a token hash or a Google subject', async () => {
    const res = await get('/api/platform/photographers');

    for (const secret of ['passwordHash', 'password_hash', 'not-a-real-hash', 'googleSub', 'tokenVersion', 'ResetToken']) expect(res.text).not.toContain(secret);
  });
});

// --- Approve ---------------------------------------------------------------------------

describe('POST /api/platform/photographers/:id/approve', () => {
  it('approves a pending photographer, recording who and when, and emails them once', async () => {
    const id = await pendingPhotographer();

    const res = await approve(id);

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'approvePhotographer', 200);
    expect(res.body).toMatchObject({ photographer: { id, status: 'approved', approvedAt: START.toISOString(), approvedByUserId: admin.id } });
    const row = await photographerRow(id);
    expect(row).toMatchObject({ status: 'approved', approvedAt: START, approvedByUserId: admin.id });
    expect(bookable(row)).toBe(true);
    const sent = await emails('photographer_approved');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ recipient: PENDING_EMAIL, photographerId: id, bookingId: null, status: 'pending' });
    // The trial this approval started, in the email (R5.1).
    expect(sent[0]?.payload).toEqual({ displayName: 'New in Town', handle: 'new-in-town', trialEndsAt: new Date(START.getTime() + 30 * DAY_MS).toISOString() });
  });

  it('starts the subscription and its 30-day trial at the approval, in the same change (R5.1)', async () => {
    const id = await pendingPhotographer();
    await expect(prisma.subscription.count({ where: { photographerId: id } })).resolves.toBe(0);

    await approve(id);

    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { photographerId: id }, include: { periods: true } });
    const trialEnd = new Date(START.getTime() + 30 * DAY_MS);
    expect(subscription).toMatchObject({ status: 'trialing', currentPeriodEndsAt: trialEnd, createdAt: START });
    expect(subscription.periods).toEqual([
      expect.objectContaining({ kind: 'trial', planInterval: null, priceRwf: 0, startsAt: START, endsAt: trialEnd, paymentId: null, voidedAt: null }),
    ]);
    // Bookable from the approval until the trial's last instant, and not at it.
    const row = await photographerRow(id);
    clock = new Date(trialEnd.getTime() - 1);
    expect(bookable(row)).toBe(true);
    clock = trialEnd;
    expect(bookable(row)).toBe(false);
  });

  it("uses the platform's trial days as they stand at the approval", async () => {
    await prisma.platformSetting.update({ where: { id: 1 }, data: { trialDays: 14 } });
    const id = await pendingPhotographer();

    await approve(id);

    await expect(prisma.subscription.findUniqueOrThrow({ where: { photographerId: id } })).resolves.toMatchObject({
      currentPeriodEndsAt: new Date(START.getTime() + 14 * DAY_MS),
    });
  });

  it('never grants a second trial: a photographer approved again keeps the subscription they have, and the email promises none', async () => {
    const id = await pendingPhotographer();
    await approve(id);
    const first = await prisma.subscription.findUniqueOrThrow({ where: { photographerId: id }, include: { periods: true } });
    // Back to pending by hand (no route does this), then approved again later.
    await prisma.photographer.update({ where: { id }, data: { status: 'pending' } });
    clock = new Date(START.getTime() + 40 * DAY_MS);
    token = (await issueToken(SECRET, 'platform', admin, clock)).token;

    expect((await approve(id)).status).toBe(200);

    await expect(prisma.subscription.findUniqueOrThrow({ where: { photographerId: id }, include: { periods: true } })).resolves.toEqual(first);
    await expect(prisma.subscriptionPeriod.count({ where: { subscriptionId: first.id, kind: 'trial' } })).resolves.toBe(1);
    const sent = await emails('photographer_approved');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.payload).toEqual({ displayName: 'New in Town', handle: 'new-in-town' });
    // Its trial ran out long ago: approved, and still not bookable until it pays (R5.4).
    expect(bookable(await photographerRow(id))).toBe(false);
  });

  it('keeps the subscription through a suspension and a reactivation: no new trial, the same clock', async () => {
    const before = await prisma.subscription.findUniqueOrThrow({ where: { photographerId: world.photographerId }, include: { periods: true } });

    await suspend(world.photographerId);
    expect(bookable(await photographerRow(world.photographerId))).toBe(false);
    await reactivate(world.photographerId);

    await expect(prisma.subscription.findUniqueOrThrow({ where: { photographerId: world.photographerId }, include: { periods: true } })).resolves.toEqual(before);
    expect(bookable(await photographerRow(world.photographerId))).toBe(true);
  });

  it('is idempotent: approving again changes nothing and sends nothing', async () => {
    const id = await pendingPhotographer();
    await approve(id);
    const once = await photographerRow(id);
    clock = new Date(START.getTime() + 5 * MINUTE_MS);

    const again = await approve(id);

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ photographer: { status: 'approved', approvedAt: START.toISOString() } });
    await expect(photographerRow(id)).resolves.toEqual(once);
    await expect(emails('photographer_approved')).resolves.toHaveLength(1);
  });

  it('lets exactly one of several simultaneous approvals make the change: one email, one approval time', async () => {
    const id = await pendingPhotographer();
    await Promise.all(Array.from({ length: 5 }, () => prisma.appUser.count()));

    const results = await Promise.all(Array.from({ length: 5 }, () => approve(id)));

    expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    await expect(emails('photographer_approved')).resolves.toHaveLength(1);
    await expect(photographerRow(id)).resolves.toMatchObject({ status: 'approved', approvedAt: START });
    // One subscription, one trial (R5.1).
    await expect(prisma.subscription.count({ where: { photographerId: id } })).resolves.toBe(1);
    await expect(prisma.subscriptionPeriod.count({ where: { subscription: { photographerId: id } } })).resolves.toBe(1);
  });

  it('refuses to approve a suspended photographer with 409: they are reactivated instead', async () => {
    await suspend(world.photographerId);

    const res = await approve(world.photographerId);

    expect(res.status).toBe(409);
    await expectMatchesSpec(res, 'approvePhotographer', 409);
    expect(res.body).toMatchObject({ error: 'invalid_transition', photographer: { status: 'suspended' } });
    await expect(emails('photographer_approved')).resolves.toHaveLength(0);
    await expect(prisma.subscriptionPeriod.count()).resolves.toBe(1);
  });

  it('answers 404 for an id that names nobody, and 400 for one that is not a uuid', async () => {
    expect([(await approve(UNKNOWN_ID)).status, (await approve(UNKNOWN_ID)).body]).toEqual([404, { error: 'not_found' }]);
    expect((await approve('not-a-uuid')).body).toEqual({ error: 'invalid_request' });
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });
});

// --- Suspend ----------------------------------------------------------------------------

describe('POST /api/platform/photographers/:id/suspend', () => {
  it('suspends an approved photographer with the reason, keeps their bookings, and emails them once', async () => {
    const booking = await insertBooking(prisma, world, { status: 'confirmed' });

    const res = await suspend(world.photographerId, '  Clients reported shoots that never happened.  ');

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'suspendPhotographer', 200);
    const row = await photographerRow(world.photographerId);
    expect(row).toMatchObject({ status: 'suspended', suspendedAt: START, suspensionReason: 'Clients reported shoots that never happened.' });
    expect(bookable(row)).toBe(false);
    // Existing bookings carry on (decisions table).
    await expect(prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).resolves.toMatchObject({ status: 'confirmed' });
    const sent = await emails('photographer_suspended');
    expect(sent.map((r) => [r.recipient, r.photographerId, r.payload])).toEqual([
      [PHOTOGRAPHER_EMAIL, world.photographerId, { displayName: PHOTOGRAPHER_NAME, reason: 'Clients reported shoots that never happened.' }],
    ]);
  });

  it('suspends a pending photographer too', async () => {
    const id = await pendingPhotographer();

    expect((await suspend(id)).body).toMatchObject({ photographer: { status: 'suspended', approvedAt: null } });
  });

  it('is idempotent: suspending again keeps the first reason and time, and sends nothing', async () => {
    await suspend(world.photographerId, 'The first reason');
    clock = new Date(START.getTime() + MINUTE_MS);

    const again = await suspend(world.photographerId, 'A second reason');

    expect(again.status).toBe(200);
    await expect(photographerRow(world.photographerId)).resolves.toMatchObject({ suspensionReason: 'The first reason', suspendedAt: START });
    await expect(emails('photographer_suspended')).resolves.toHaveLength(1);
  });

  it('lets exactly one of several simultaneous suspensions make the change: one email', async () => {
    await Promise.all(Array.from({ length: 5 }, () => prisma.appUser.count()));

    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => suspend(world.photographerId, `Reason ${i}`)));

    expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    await expect(emails('photographer_suspended')).resolves.toHaveLength(1);
  });

  it.each<[string, unknown, number]>([
    ['no reason', undefined, 400],
    ['a numeric reason', 42, 400],
    ['a blank reason', '   ', 422],
    ['a 501-character reason', 'r'.repeat(501), 422],
  ])('answers %s with %i, changing nothing', async (_label, reason, status) => {
    const before = await photographerRow(world.photographerId);

    const res = await post(`/api/platform/photographers/${world.photographerId}/suspend`, reason === undefined ? {} : { reason });

    expect(res.status).toBe(status);
    await expect(photographerRow(world.photographerId)).resolves.toEqual(before);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('refuses an unknown key in the body', async () => {
    expect((await post(`/api/platform/photographers/${world.photographerId}/suspend`, { reason: 'x', status: 'approved' })).status).toBe(400);
  });

  it('answers 404 for an id that names nobody', async () => {
    expect((await suspend(UNKNOWN_ID)).status).toBe(404);
  });
});

// --- Reactivate --------------------------------------------------------------------------

describe('POST /api/platform/photographers/:id/reactivate', () => {
  it('returns a suspended, once-approved photographer to approved, clearing the suspension', async () => {
    await suspend(world.photographerId);

    const res = await reactivate(world.photographerId);

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'reactivatePhotographer', 200);
    const row = await photographerRow(world.photographerId);
    expect(row).toMatchObject({ status: 'approved', suspendedAt: null, suspensionReason: null, approvedAt: new Date('2026-09-02T06:00:00Z') });
    expect(bookable(row)).toBe(true);
  });

  it('returns a photographer suspended before approval to pending: reactivating approves nobody', async () => {
    const id = await pendingPhotographer();
    await suspend(id);

    expect((await reactivate(id)).body).toMatchObject({ photographer: { status: 'pending', approvedAt: null, suspendedAt: null } });
  });

  it('is idempotent: reactivating someone not suspended changes nothing', async () => {
    const before = await photographerRow(world.photographerId);

    const res = await reactivate(world.photographerId);

    expect(res.status).toBe(200);
    await expect(photographerRow(world.photographerId)).resolves.toEqual(before);
  });

  it('answers 404 for an id that names nobody', async () => {
    expect((await reactivate(UNKNOWN_ID)).status).toBe(404);
  });

  it('allows the full cycle and a second suspension emails again', async () => {
    await suspend(world.photographerId, 'First');
    await reactivate(world.photographerId);
    clock = new Date(START.getTime() + MINUTE_MS);
    await suspend(world.photographerId, 'Second');

    await expect(emails('photographer_suspended')).resolves.toHaveLength(2);
    await expect(photographerRow(world.photographerId)).resolves.toMatchObject({ status: 'suspended', suspensionReason: 'Second' });
  });
});

// --- The structured log (R9.4) ------------------------------------------------------------

describe('the moderation log', () => {
  it('records who did each action and when, and nothing for a no-op', async () => {
    const id = await pendingPhotographer();
    const { entries, log } = logSink();
    const deps = { prisma, now: () => clock, log };
    const action = { photographerId: id, adminUserId: admin.id };

    await approvePhotographer(deps, action);
    await approvePhotographer(deps, action);
    await suspendPhotographer(deps, { ...action, reason: 'Logged' });
    await reactivatePhotographer(deps, action);

    expect(entries).toEqual(
      ['photographer_approve', 'photographer_suspend', 'photographer_reactivate'].map((event, i) => ({
        level: 'info',
        event,
        photographerId: id,
        byUserId: admin.id,
        at: START.toISOString(),
        status: ['approved', 'suspended', 'approved'][i],
      })),
    );
  });
});

