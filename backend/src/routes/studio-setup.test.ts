import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { issueToken } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { SETUP_ITEMS, type SetupItem, setupChecklist, submitForReview } from '../photographers/setup.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { seedStarterCategories } from '../test/directory-fixtures.js';
import { expectMatchesSpec } from '../test/openapi.js';
import {
  PLATFORM_ADMIN_EMAIL,
  type PaymentWorld,
  TEST_SECRET,
  createPhotographer,
  logSink,
  seedWorld,
} from '../test/payment-fixtures.js';

/**
 * The setup checklist and its submission over HTTP, against real PostgreSQL
 * (marketplace-spec.md R7.3, T7.1; Phase 7 user decision: approval requires a
 * submission), the studio's `/me` banners (R7.4), and the whole onboarding
 * through the API: sign up, verify, set up, submit, approved by the platform,
 * listed in the directory with a trial (T7.2's backend half).
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let clock: Date;
let world: PaymentWorld;
/** A pending photographer with nothing set up, signed in as `token`. */
let pendingId: string;
let token: string;
let categoryIds: Map<string, string>;

const WEB_ORIGIN = 'https://bookly.example';
const START = new Date('2026-10-20T07:00:00Z');
const DAY_MS = 24 * 60 * 60_000;
const SECOND_ADMIN_EMAIL = 'ops.two@bookly.example';

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
  // The structured log of each submission goes to stdout; keep the run quiet.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await truncateAll(raw);
  clock = START;
  world = await seedWorld(prisma);
  // A second platform admin, and a disabled one who must hear nothing.
  await prisma.appUser.create({ data: { email: SECOND_ADMIN_EMAIL, role: 'platform_admin', passwordHash: 'x', emailVerifiedAt: START } });
  await prisma.appUser.create({ data: { email: 'off@bookly.example', role: 'platform_admin', passwordHash: 'x', emailVerifiedAt: START, disabledAt: START } });
  pendingId = (await createPhotographer(prisma, { email: 'pending@bookly.example', handle: 'new-in-town', displayName: 'New in Town', status: 'pending' }))
    .photographerId;
  categoryIds = await seedStarterCategories(prisma);
  token = await tokenOf(pendingId);
  app = createApp({
    corsOrigin: WEB_ORIGIN,
    auth: { prisma, sessionSecret: TEST_SECRET, webOrigin: WEB_ORIGIN, now: () => clock },
    publicApi: { prisma, now: () => clock },
  });
});

// --- Fixtures ---------------------------------------------------------------------

async function tokenOf(photographerId: string): Promise<string> {
  const photographer = await prisma.photographer.findUniqueOrThrow({ where: { id: photographerId }, include: { user: true } });
  return (await issueToken(TEST_SECRET, 'studio', photographer.user, clock)).token;
}

const getSetup = (bearer = token) => request(app).get('/api/studio/setup').set('Authorization', `Bearer ${bearer}`);
const submit = (bearer = token) => request(app).post('/api/studio/setup/submit').set('Authorization', `Bearer ${bearer}`);
const getMe = (bearer = token) => request(app).get('/api/studio/me').set('Authorization', `Bearer ${bearer}`);

type Setup = { items: { key: SetupItem; done: boolean }[]; missing: SetupItem[]; status: string; submittedAt: string | null; canSubmit: boolean };
const setupOf = (res: request.Response) => (res.body as { setup: Setup }).setup;
const doneOf = (setup: Setup) => Object.fromEntries(setup.items.map((item) => [item.key, item.done]));

/** One item's rows, done (`complete`) for `photographerId`. */
const COMPLETE: Record<SetupItem, (photographerId: string) => Promise<unknown>> = {
  profile: (photographerId) => prisma.photographer.update({ where: { id: photographerId }, data: { bio: 'Portraits across Kigali.' } }),
  categories: (photographerId) => prisma.photographerCategory.create({ data: { photographerId, categoryId: categoryIds.get('portrait')! } }),
  districts: (photographerId) => prisma.photographerDistrict.create({ data: { photographerId, districtCode: 'gasabo' } }),
  payoutMethod: (photographerId) =>
    prisma.payoutMethod.create({ data: { photographerId, kind: 'momo', momoNetwork: 'mtn', momoNumber: '+250788000111', accountName: 'New in Town' } }),
  services: async (photographerId) => {
    const service = await prisma.service.create({ data: { photographerId, slug: 'portraits', nameEn: 'Portraits' } });
    await prisma.package.create({ data: { photographerId, serviceId: service.id, nameEn: 'Standard', priceRwf: 30_000, photoCount: 20, durationMinutes: 60 } });
  },
  workingHours: (photographerId) => prisma.workingHours.create({ data: { photographerId, weekday: 1, opensMinute: 540, closesMinute: 1020 } }),
};

async function completeAll(photographerId = pendingId, except: SetupItem[] = []): Promise<void> {
  for (const key of SETUP_ITEMS) if (!except.includes(key)) await COMPLETE[key](photographerId);
}

function applicationEmails() {
  return prisma.outbox.findMany({ where: { template: 'photographer_application_received' }, orderBy: { recipient: 'asc' } });
}

// --- GET /setup -------------------------------------------------------------------

describe('GET /api/studio/setup (R7.3)', () => {
  it('lists every item in a fixed order, none done for a studio just signed up', async () => {
    const res = await getSetup();

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'getStudioSetup', 200);
    expect(res.body).toEqual({
      setup: {
        items: SETUP_ITEMS.map((key) => ({ key, done: false })),
        missing: [...SETUP_ITEMS],
        status: 'pending',
        submittedAt: null,
        canSubmit: false,
      },
    });
    expect(SETUP_ITEMS).toEqual(['profile', 'categories', 'districts', 'payoutMethod', 'services', 'workingHours']);
  });

  it.each(SETUP_ITEMS)('marks %s done once its rows exist, and only it', async (key) => {
    await COMPLETE[key](pendingId);

    const setup = setupOf(await getSetup());

    expect(doneOf(setup)).toEqual(Object.fromEntries(SETUP_ITEMS.map((item) => [item, item === key])));
    expect(setup.missing).toEqual(SETUP_ITEMS.filter((item) => item !== key));
    expect(setup.canSubmit).toBe(false);
  });

  it('can submit once every item is done', async () => {
    await completeAll();

    const setup = setupOf(await getSetup());

    expect(setup).toEqual({ items: SETUP_ITEMS.map((key) => ({ key, done: true })), missing: [], status: 'pending', submittedAt: null, canSubmit: true });
  });

  describe('exactly what counts', () => {
    const itemDone = async (key: SetupItem) => doneOf(setupOf(await getSetup()))[key];

    it.each([
      ['a bio', 'Portraits.', true],
      ['a one-character bio', 'x', true],
      ['no bio', null, false],
      ['an empty bio', '', false],
      ['a bio of spaces and newlines only', '  \n\t ', false],
    ])('profile, with %s', async (_label, bio, done) => {
      await prisma.photographer.update({ where: { id: pendingId }, data: { bio } });
      expect(await itemDone('profile')).toBe(done);
    });

    it('profile needs a display name with a non-blank character too', async () => {
      await prisma.photographer.update({ where: { id: pendingId }, data: { bio: 'Portraits.', displayName: '   ' } });
      expect(await itemDone('profile')).toBe(false);
    });

    it('profile does not need a cover image or any contact detail', async () => {
      await prisma.photographer.update({ where: { id: pendingId }, data: { bio: 'Portraits.', coverImageUrl: null, contactPhone: null, contactEmail: null } });
      expect(await itemDone('profile')).toBe(true);
    });

    it('categories: a deactivated category does not count', async () => {
      await COMPLETE.categories(pendingId);
      await prisma.category.update({ where: { slug: 'portrait' }, data: { isActive: false } });
      expect(await itemDone('categories')).toBe(false);
    });

    it('payoutMethod: a retired method alone does not count', async () => {
      await prisma.payoutMethod.create({
        data: { photographerId: pendingId, kind: 'momo', momoNetwork: 'mtn', momoNumber: '+250788000111', accountName: 'Old', retiredAt: START },
      });
      expect(await itemDone('payoutMethod')).toBe(false);
      await COMPLETE.payoutMethod(pendingId);
      expect(await itemDone('payoutMethod')).toBe(true);
    });

    it.each([
      ['an active service with an active package', true, true, true],
      ['an active service whose only package is inactive', true, false, true],
      ['an inactive service with an active package', false, true, true],
      ['an active service with no package', true, true, false],
    ])('services: %s', async (_label, serviceActive, packageActive, withPackage) => {
      const service = await prisma.service.create({ data: { photographerId: pendingId, slug: 'portraits', nameEn: 'Portraits', isActive: serviceActive } });
      if (withPackage) {
        await prisma.package.create({
          data: { photographerId: pendingId, serviceId: service.id, nameEn: 'Standard', priceRwf: 30_000, photoCount: 20, durationMinutes: 60, isActive: packageActive },
        });
      }
      expect(await itemDone('services')).toBe(serviceActive && packageActive && withPackage);
    });

    it.each([
      ['an open weekly rule', { weekday: 3, opensMinute: 540, closesMinute: 1020 }, true],
      ['a closed weekly rule', { weekday: 3, isOpen: false }, false],
      ['an open one-date override only', { effectiveDate: new Date('2026-11-02T00:00:00Z'), opensMinute: 540, closesMinute: 1020 }, false],
    ])('workingHours: %s', async (_label, data, done) => {
      await prisma.workingHours.create({ data: { photographerId: pendingId, ...data } });
      expect(await itemDone('workingHours')).toBe(done);
    });
  });

  it('judges the signed-in photographer’s rows only: another studio fully set up changes nothing', async () => {
    const other = await createPhotographer(prisma, { email: 'other@bookly.example', handle: 'other-studio', displayName: 'Other', status: 'pending' });
    await completeAll(other.photographerId);

    expect(setupOf(await getSetup()).missing).toEqual([...SETUP_ITEMS]);
    expect(setupOf(await getSetup(await tokenOf(other.photographerId))).canSubmit).toBe(true);
  });

  it('cannot submit when approved, even with every item done', async () => {
    await completeAll(world.photographerId, ['services']);

    const setup = setupOf(await getSetup(await tokenOf(world.photographerId)));

    expect([setup.status, setup.missing, setup.canSubmit]).toEqual(['approved', [], false]);
  });
});

// --- POST /setup/submit -----------------------------------------------------------

describe('POST /api/studio/setup/submit (R7.3, T7.1)', () => {
  it('answers 422 listing every missing item, in checklist order, and records and sends nothing (T7.1)', async () => {
    const res = await submit();

    expect([res.status, res.body]).toEqual([422, { error: 'setup_incomplete', missing: [...SETUP_ITEMS] }]);
    await expectMatchesSpec(res, 'submitStudioSetup', 422);
    await expect(prisma.photographer.findUniqueOrThrow({ where: { id: pendingId } })).resolves.toMatchObject({ submittedAt: null });
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it.each(SETUP_ITEMS)('refuses with only %s missing, naming it alone', async (key) => {
    await completeAll(pendingId, [key]);

    const res = await submit();

    expect([res.status, res.body]).toEqual([422, { error: 'setup_incomplete', missing: [key] }]);
    await expect(prisma.photographer.findUniqueOrThrow({ where: { id: pendingId } })).resolves.toMatchObject({ submittedAt: null });
  });

  it('records the submission, answers the checklist, and emails every active platform admin once', async () => {
    await completeAll();
    const log = logSink();
    const before = await prisma.photographer.findUniqueOrThrow({ where: { id: pendingId } });

    const res = await submit();

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'submitStudioSetup', 200);
    expect(setupOf(res)).toEqual({ items: SETUP_ITEMS.map((key) => ({ key, done: true })), missing: [], status: 'pending', submittedAt: START.toISOString(), canSubmit: false });
    const after = await prisma.photographer.findUniqueOrThrow({ where: { id: pendingId } });
    expect(after).toEqual({ ...before, submittedAt: START, updatedAt: START });

    const sent = await applicationEmails();
    expect(sent.map((row) => row.recipient)).toEqual([SECOND_ADMIN_EMAIL, PLATFORM_ADMIN_EMAIL].sort());
    for (const row of sent) {
      expect(row.payload).toEqual({ variant: 'submitted', displayName: 'New in Town', handle: 'new-in-town', email: 'pending@bookly.example' });
      // Filed under no studio: a failure to deliver alerts the platform, not the applicant.
      expect(row.photographerId).toBeNull();
    }

    await submitForReview({ prisma, now: () => clock, log: log.log }, pendingId);
    expect(log.entries).toEqual([]);
  });

  it('logs who submitted and when, once', async () => {
    await completeAll();
    const log = logSink();

    await expect(submitForReview({ prisma, now: () => clock, log: log.log }, pendingId)).resolves.toMatchObject({ status: 'ok', changed: true });
    await expect(submitForReview({ prisma, now: () => clock, log: log.log }, pendingId)).resolves.toMatchObject({ status: 'ok', changed: false });

    expect(log.entries).toEqual([{ level: 'info', event: 'photographer_submit', photographerId: pendingId, at: START.toISOString() }]);
  });

  it('is idempotent: submitting again keeps the first time and sends nothing more', async () => {
    await completeAll();
    await submit();
    clock = new Date(START.getTime() + DAY_MS);

    // A day later: a fresh token (sessions last 8 hours).
    const again = await submit(await tokenOf(pendingId));

    expect(again.status).toBe(200);
    expect(setupOf(again).submittedAt).toBe(START.toISOString());
    await expect(applicationEmails()).resolves.toHaveLength(2);
  });

  it('keeps the submission when the studio is edited afterwards, and does not re-judge it (the Phase 7 design call)', async () => {
    await completeAll();
    await submit();

    // An item undone after submitting: still submitted, and the checklist shows the item's live state.
    await request(app).patch('/api/studio/profile').set('Authorization', `Bearer ${token}`).send({ bio: null });
    const setup = setupOf(await getSetup());
    expect([setup.submittedAt, setup.missing, setup.canSubmit]).toEqual([START.toISOString(), ['profile'], false]);

    const again = await submit();
    expect([again.status, setupOf(again).submittedAt]).toEqual([200, START.toISOString()]);
    await expect(applicationEmails()).resolves.toHaveLength(2);
  });

  it('lets one of several simultaneous submissions record it: one time, one email per admin', async () => {
    await completeAll();

    const results = await Promise.all(Array.from({ length: 5 }, () => submit()));

    expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(results.map((res) => setupOf(res).submittedAt))).toEqual(new Set([START.toISOString()]));
    await expect(applicationEmails()).resolves.toHaveLength(2);
  });

  it.each([
    ['approved', { status: 'approved', approvedAt: START }],
    ['suspended before approval', { status: 'suspended', suspendedAt: START }],
    ['suspended after approval', { status: 'suspended', suspendedAt: START, approvedAt: START }],
  ])('refuses a photographer who is %s with 409 not_pending, changing nothing', async (_label, data) => {
    await completeAll();
    await prisma.photographer.update({ where: { id: pendingId }, data });
    const before = await prisma.photographer.findUniqueOrThrow({ where: { id: pendingId } });

    const res = await submit();

    expect([res.status, res.body]).toEqual([409, { error: 'not_pending' }]);
    await expectMatchesSpec(res, 'submitStudioSetup', 409);
    await expect(prisma.photographer.findUniqueOrThrow({ where: { id: pendingId } })).resolves.toEqual(before);
    await expect(prisma.outbox.count()).resolves.toBe(0);
  });

  it('says not_pending before anything is missing: a suspended applicant is not told to finish setting up', async () => {
    await prisma.photographer.update({ where: { id: pendingId }, data: { status: 'suspended', suspendedAt: START } });

    expect((await submit()).body).toEqual({ error: 'not_pending' });
  });

  it('submits the signed-in photographer only, never another', async () => {
    const other = await createPhotographer(prisma, { email: 'other@bookly.example', handle: 'other-studio', displayName: 'Other', status: 'pending' });
    await completeAll(other.photographerId);
    await completeAll();

    await submit();

    await expect(prisma.photographer.findUniqueOrThrow({ where: { id: other.photographerId } })).resolves.toMatchObject({ submittedAt: null });
    expect((await applicationEmails()).every((row) => (row.payload as { handle: string }).handle === 'new-in-town')).toBe(true);
  });

  it('ignores a body: there is nothing the caller may set', async () => {
    await completeAll();

    const res = await request(app).post('/api/studio/setup/submit').set('Authorization', `Bearer ${token}`).send({ submittedAt: '2020-01-01T00:00:00Z', photographerId: world.photographerId });

    expect(setupOf(res).submittedAt).toBe(START.toISOString());
    await expect(prisma.photographer.findUniqueOrThrow({ where: { id: world.photographerId } })).resolves.toMatchObject({ submittedAt: null });
  });

  it('refuses a request without a studio token', async () => {
    expect((await request(app).post('/api/studio/setup/submit')).status).toBe(401);
    expect((await request(app).get('/api/studio/setup')).status).toBe(401);
  });

  it('a submission races an approval safely: the approval either sees it or refuses, never approves an unsubmitted studio', async () => {
    await completeAll();
    const admin = await prisma.appUser.findFirstOrThrow({ where: { email: PLATFORM_ADMIN_EMAIL } });
    const platform = (await issueToken(TEST_SECRET, 'platform', admin, clock)).token;
    const approve = () => request(app).post(`/api/platform/photographers/${pendingId}/approve`).set('Authorization', `Bearer ${platform}`);

    const [submitted, approved] = await Promise.all([submit(), approve()]);

    expect(submitted.status).toBe(200);
    const row = await prisma.photographer.findUniqueOrThrow({ where: { id: pendingId } });
    expect(row.submittedAt).toEqual(START);
    if (approved.status === 200) expect(row.status).toBe('approved');
    else expect([approved.status, row.status]).toEqual([409, 'pending']);
  });
});

describe('setupChecklist', () => {
  it('throws for a photographer that does not exist', async () => {
    await expect(setupChecklist(prisma, '00000000-0000-4000-8000-000000000000')).rejects.toThrow();
  });
});

// --- /me (R7.4) -------------------------------------------------------------------

describe('GET /api/studio/me carries every banner (R7.4)', () => {
  it('pending, not submitted: no submission, no subscription', async () => {
    const res = await getMe();

    await expectMatchesSpec(res, 'getStudioMe', 200);
    expect(res.body).toMatchObject({
      photographer: { id: pendingId, handle: 'new-in-town', status: 'pending', submittedAt: null, suspensionReason: null },
      subscription: null,
    });
  });

  it('pending, submitted: the time it was submitted', async () => {
    await completeAll();
    await submit();

    expect((await getMe()).body).toMatchObject({ photographer: { status: 'pending', submittedAt: START.toISOString() }, subscription: null });
  });

  it('suspended: the reason as the platform wrote it', async () => {
    await prisma.photographer.update({ where: { id: pendingId }, data: { status: 'suspended', suspendedAt: START, suspensionReason: 'Fake portfolio.' } });

    const res = await getMe();

    await expectMatchesSpec(res, 'getStudioMe', 200);
    expect(res.body).toMatchObject({ photographer: { status: 'suspended', suspensionReason: 'Fake portfolio.' } });
  });

  describe('the subscription, at the clock', () => {
    const endsAt = new Date('2026-11-19T07:00:00Z');
    const setEnd = (status: string) => prisma.subscription.update({ where: { photographerId: world.photographerId }, data: { status, currentPeriodEndsAt: endsAt } });
    const subscriptionAt = async (at: Date) => {
      clock = at;
      // A token issued at the moment asked about: sessions last 8 hours.
      const res = await getMe(await tokenOf(world.photographerId));
      await expectMatchesSpec(res, 'getStudioMe', 200);
      return (res.body as { subscription: Record<string, unknown> }).subscription;
    };

    it('trialing well before the end: taking bookings, not ending soon', async () => {
      await setEnd('trialing');

      expect(await subscriptionAt(START)).toEqual({
        status: 'trialing',
        currentPeriodEndsAt: endsAt.toISOString(),
        graceEndsAt: new Date(endsAt.getTime() + 7 * DAY_MS).toISOString(),
        takingBookings: true,
        endingSoon: false,
      });
    });

    it('ending soon from exactly the largest reminder day before the end, not a millisecond earlier', async () => {
      await setEnd('trialing');

      expect((await subscriptionAt(new Date(endsAt.getTime() - 7 * DAY_MS - 1))).endingSoon).toBe(false);
      expect((await subscriptionAt(new Date(endsAt.getTime() - 7 * DAY_MS))).endingSoon).toBe(true);
      expect(await subscriptionAt(new Date(endsAt.getTime() - 1))).toMatchObject({ status: 'trialing', endingSoon: true, takingBookings: true });
    });

    it('follows the platform’s reminder days: the largest one is the window', async () => {
      await setEnd('active');
      await prisma.platformSetting.update({ where: { id: 1 }, data: { subscriptionReminderDays: [2, 10] } });

      expect(await subscriptionAt(new Date(endsAt.getTime() - 10 * DAY_MS))).toMatchObject({ status: 'active', endingSoon: true });
      expect((await subscriptionAt(new Date(endsAt.getTime() - 10 * DAY_MS - 1))).endingSoon).toBe(false);
    });

    it('is never ending soon with no reminder days set', async () => {
      await setEnd('trialing');
      await prisma.platformSetting.update({ where: { id: 1 }, data: { subscriptionReminderDays: [] } });

      expect((await subscriptionAt(new Date(endsAt.getTime() - 1))).endingSoon).toBe(false);
    });

    it('past due from the end, even before the job has recorded it, until the grace ends; then expired', async () => {
      await setEnd('trialing');

      expect(await subscriptionAt(endsAt)).toMatchObject({ status: 'past_due', takingBookings: false, endingSoon: false });
      expect(await subscriptionAt(new Date(endsAt.getTime() + 7 * DAY_MS - 1))).toMatchObject({ status: 'past_due' });
      expect(await subscriptionAt(new Date(endsAt.getTime() + 7 * DAY_MS))).toMatchObject({ status: 'expired', takingBookings: false, endingSoon: false });
    });

    it('not taking bookings while suspended, though the subscription runs', async () => {
      await setEnd('active');
      await prisma.photographer.update({ where: { id: world.photographerId }, data: { status: 'suspended', suspendedAt: START, suspensionReason: 'Review.' } });

      expect(await subscriptionAt(START)).toMatchObject({ status: 'active', takingBookings: false });
    });
  });
});

// --- The whole onboarding, through the API (T7.2's backend half) -------------------

describe('sign up, verify, set up, submit, approved: listed with a trial (T7.2)', () => {
  it('runs end to end through the HTTP API alone', async () => {
    const email = 'fresh.studio@bookly.example';
    const password = 'a long enough studio passphrase';
    const admin = await prisma.appUser.findFirstOrThrow({ where: { email: PLATFORM_ADMIN_EMAIL } });
    const platform = { Authorization: `Bearer ${(await issueToken(TEST_SECRET, 'platform', admin, clock)).token}` };

    // Sign up and verify.
    expect((await request(app).post('/api/studio/auth/signup').send({ email, password, displayName: 'Fresh Studio', handle: 'fresh-studio' })).status).toBe(202);
    const link = await prisma.outbox.findFirstOrThrow({ where: { template: 'account_verify_email', recipient: email } });
    const verified = await request(app).post('/api/studio/auth/verify').send({ token: String((link.payload as { token: string }).token), password });
    expect(verified.status).toBe(200);
    const auth = { Authorization: `Bearer ${(verified.body as { token: string }).token}` };
    const photographerId = (await prisma.photographer.findUniqueOrThrow({ where: { handle: 'fresh-studio' } })).id;

    // Not approvable yet: never submitted.
    expect((await request(app).post(`/api/platform/photographers/${photographerId}/approve`).set(platform)).body).toMatchObject({ error: 'not_submitted' });
    expect((await request(app).post('/api/studio/setup/submit').set(auth)).body).toEqual({ error: 'setup_incomplete', missing: [...SETUP_ITEMS] });

    // Set up, item by item, through the studio's own routes.
    expect(
      (await request(app).patch('/api/studio/profile').set(auth).send({ handle: 'fresh-lens', bio: 'Fresh portraits.', districts: ['gasabo'], categories: ['portrait'] })).status,
    ).toBe(200);
    expect(
      (await request(app).put('/api/studio/payout-method').set(auth).send({ kind: 'momo', momoNetwork: 'mtn', momoNumber: '0788 123 456', accountName: 'Fresh Studio', currentPassword: password }))
        .status,
    ).toBe(200);
    const service = await request(app).post('/api/studio/services').set(auth).send({ slug: 'portraits', nameEn: 'Portraits' });
    expect(service.status).toBe(201);
    const serviceId = (service.body as { service: { id: string } }).service.id;
    expect((await request(app).post('/api/studio/packages').set(auth).send({ serviceId, nameEn: 'Standard', priceRwf: 25_000, photoCount: 20, durationMinutes: 60 })).status).toBe(201);
    expect((await request(app).post('/api/studio/working-hours').set(auth).send({ weekday: 2, opensMinute: 540, closesMinute: 1020 })).status).toBe(201);
    expect((await request(app).post('/api/studio/portfolio').set(auth).send({ url: 'https://img.example/fresh.jpg', caption: 'Fresh' })).status).toBe(201);

    // Submit; the platform finds it awaiting review, and approves it.
    const setup = await request(app).get('/api/studio/setup').set(auth);
    expect(setupOf(setup).canSubmit).toBe(true);
    expect(setupOf(await request(app).post('/api/studio/setup/submit').set(auth)).submittedAt).toBe(START.toISOString());
    const awaiting = await request(app).get('/api/platform/photographers?review=awaiting').set(platform);
    expect((awaiting.body as { photographers: { id: string }[] }).photographers.map((p) => p.id)).toEqual([photographerId]);
    expect((await request(app).post(`/api/platform/photographers/${photographerId}/approve`).set(platform)).status).toBe(200);

    // Listed in the directory, with a 30-day trial; the handle is now locked.
    const directory = await request(app).get('/api/photographers?category=portrait&district=gasabo');
    expect((directory.body as { photographers: { handle: string; takingBookings: boolean }[] }).photographers).toEqual([
      expect.objectContaining({ handle: 'fresh-lens', takingBookings: true }),
    ]);
    const profile = await request(app).get('/api/photographers/fresh-lens');
    expect((profile.body as { photographer: { portfolio: { url: string }[] } }).photographer.portfolio).toEqual([{ url: 'https://img.example/fresh.jpg', caption: 'Fresh' }]);
    const me = await request(app).get('/api/studio/me').set(auth);
    expect(me.body).toMatchObject({
      photographer: { status: 'approved', submittedAt: START.toISOString() },
      subscription: { status: 'trialing', currentPeriodEndsAt: new Date(START.getTime() + 30 * DAY_MS).toISOString(), takingBookings: true },
    });
    expect((await request(app).patch('/api/studio/profile').set(auth).send({ handle: 'another-name' })).body).toEqual({ error: 'handle_locked' });
    expect((await request(app).post('/api/studio/setup/submit').set(auth)).body).toEqual({ error: 'not_pending' });
  });
});
