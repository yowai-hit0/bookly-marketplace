import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { issueToken } from '../auth/token.js';
import { createPrismaClient } from '../db/client.js';
import { SQLSTATE } from '../db/errors.js';
import { RESERVED_HANDLES } from '../photographers/handle.js';
import { connect, sqlstateOf, testDatabaseUrl, truncateAll } from '../test/database.js';
import { seedStarterCategories } from '../test/directory-fixtures.js';
import { expectMatchesSpec } from '../test/openapi.js';
import {
  PHOTOGRAPHER_HANDLE,
  PHOTOGRAPHER_NAME,
  PLATFORM_ADMIN_EMAIL,
  type PaymentWorld,
  SECOND_PHOTOGRAPHER_HANDLE,
  TEST_SECRET,
  createPhotographer,
  seedSecondPhotographer,
  seedWorld,
} from '../test/payment-fixtures.js';

/**
 * The studio's Profile and Portfolio pages over HTTP, against real PostgreSQL
 * (marketplace-spec.md R7.2; routes/studio-profile.ts): every field and its
 * bounds, the handle's lock at approval, districts and categories replacing the
 * whole set, the portfolio's limit, captions and order, and that one
 * photographer's requests never reach another's rows (R1.4; the id-taking
 * routes are also in the isolation sweep, studio-isolation.test.ts).
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let clock: Date;
/** Photographer A, approved; signed in as `tokenA`. */
let a: PaymentWorld;
/** Photographer B, approved. */
let b: PaymentWorld;
let tokenA: string;
let tokenB: string;
/** Photographer P, pending (never approved); signed in as `tokenP`. */
let pendingId: string;
let tokenP: string;
let categoryIds: Map<string, string>;

const WEB_ORIGIN = 'https://bookly.example';
const START = new Date('2026-10-20T07:00:00Z');
const PENDING_HANDLE = 'new-in-town';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
/** Four bytes in UTF-8, two UTF-16 units, ONE character to PostgreSQL's char_length. */
const EMOJI = '\u{1F4F7}';

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
  clock = START;
  a = await seedWorld(prisma);
  b = await seedSecondPhotographer(prisma, a);
  pendingId = (await createPhotographer(prisma, { email: 'pending@bookly.example', handle: PENDING_HANDLE, displayName: 'New in Town', status: 'pending' }))
    .photographerId;
  categoryIds = await seedStarterCategories(prisma);
  tokenA = await tokenOf(a.photographerId);
  tokenB = await tokenOf(b.photographerId);
  tokenP = await tokenOf(pendingId);
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

const getProfile = (token = tokenA) => request(app).get('/api/studio/profile').set('Authorization', `Bearer ${token}`);
const patchProfile = (body: unknown, token = tokenA) => request(app).patch('/api/studio/profile').set('Authorization', `Bearer ${token}`).send(body as object);
const getPortfolio = (token = tokenA) => request(app).get('/api/studio/portfolio').set('Authorization', `Bearer ${token}`);
const addImage = (body: unknown, token = tokenA) => request(app).post('/api/studio/portfolio').set('Authorization', `Bearer ${token}`).send(body as object);
const patchImage = (id: string, body: unknown, token = tokenA) =>
  request(app).patch(`/api/studio/portfolio/${id}`).set('Authorization', `Bearer ${token}`).send(body as object);
const deleteImage = (id: string, token = tokenA) => request(app).delete(`/api/studio/portfolio/${id}`).set('Authorization', `Bearer ${token}`);
const reorder = (body: unknown, token = tokenA) => request(app).put('/api/studio/portfolio/order').set('Authorization', `Bearer ${token}`).send(body as object);

function row(id: string) {
  return prisma.photographer.findUniqueOrThrow({ where: { id } });
}

/** Every row of a photographer's that the profile writes, for "nothing changed". */
async function profileRows(photographerId: string) {
  return {
    photographer: await row(photographerId),
    districts: await prisma.photographerDistrict.findMany({ where: { photographerId }, orderBy: { districtCode: 'asc' } }),
    categories: await prisma.photographerCategory.findMany({ where: { photographerId }, orderBy: { categoryId: 'asc' } }),
  };
}

async function portfolioRows(photographerId: string) {
  return prisma.portfolioImage.findMany({ where: { photographerId }, orderBy: { id: 'asc' } });
}

async function seedImages(photographerId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    ids.push((await prisma.portfolioImage.create({ data: { photographerId, url: `https://img.example/${photographerId}/${n}.jpg`, sortOrder: n } })).id);
  }
  return ids;
}

type Profile = Record<string, unknown> & { districts: { code: string }[]; categories: { slug: string }[] };
const profileOf = (res: request.Response) => (res.body as { profile: Profile }).profile;

// --- GET /profile -----------------------------------------------------------------

describe('GET /api/studio/profile', () => {
  it('answers the signed-in photographer’s profile, with nothing set yet as null and empty lists', async () => {
    const res = await getProfile();

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'getStudioProfile', 200);
    expect(res.body).toEqual({
      profile: {
        handle: PHOTOGRAPHER_HANDLE,
        handleEditable: false,
        displayName: PHOTOGRAPHER_NAME,
        bio: null,
        contactPhone: null,
        whatsappPhone: null,
        contactEmail: null,
        coverImageUrl: null,
        districts: [],
        categories: [],
        status: 'approved',
        submittedAt: null,
      },
    });
  });

  it('says when the studio was submitted for review, null until then', async () => {
    expect(profileOf(await getProfile(tokenP))).toMatchObject({ status: 'pending', submittedAt: null });

    await prisma.photographer.update({ where: { id: pendingId }, data: { submittedAt: START } });

    const res = await getProfile(tokenP);
    await expectMatchesSpec(res, 'getStudioProfile', 200);
    expect(profileOf(res)).toMatchObject({ status: 'pending', submittedAt: START.toISOString() });
  });

  it('says the handle is editable only for a photographer never approved (R7.2)', async () => {
    expect(profileOf(await getProfile(tokenP))).toMatchObject({ handle: PENDING_HANDLE, handleEditable: true, status: 'pending' });

    // Suspended after approval: still locked. Suspended before approval: still editable.
    await prisma.photographer.update({ where: { id: a.photographerId }, data: { status: 'suspended', suspendedAt: START } });
    await prisma.photographer.update({ where: { id: pendingId }, data: { status: 'suspended', suspendedAt: START } });
    expect(profileOf(await getProfile())).toMatchObject({ handleEditable: false, status: 'suspended' });
    expect(profileOf(await getProfile(tokenP))).toMatchObject({ handleEditable: true, status: 'suspended' });
  });

  it('lists districts in the migration’s order and active categories in the platform’s order, hiding a deactivated one', async () => {
    for (const districtCode of ['rusizi', 'gasabo', 'huye']) await prisma.photographerDistrict.create({ data: { photographerId: a.photographerId, districtCode } });
    for (const slug of ['family', 'wedding', 'event']) {
      await prisma.photographerCategory.create({ data: { photographerId: a.photographerId, categoryId: categoryIds.get(slug)! } });
    }
    await prisma.category.update({ where: { slug: 'event' }, data: { isActive: false } });

    const profile = profileOf(await getProfile());

    expect(profile.districts).toEqual([
      { code: 'gasabo', name: 'Gasabo' },
      { code: 'huye', name: 'Huye' },
      { code: 'rusizi', name: 'Rusizi' },
    ]);
    expect(profile.categories).toEqual([
      { slug: 'wedding', name: 'Wedding' },
      { slug: 'family', name: 'Family' },
    ]);
  });

  it('answers each photographer with their own profile only', async () => {
    await prisma.photographer.update({ where: { id: b.photographerId }, data: { bio: 'B’s bio' } });

    expect(profileOf(await getProfile(tokenB))).toMatchObject({ handle: SECOND_PHOTOGRAPHER_HANDLE, bio: 'B’s bio' });
    expect(profileOf(await getProfile())).toMatchObject({ handle: PHOTOGRAPHER_HANDLE, bio: null });
  });

  it('refuses a request without a studio token', async () => {
    expect((await request(app).get('/api/studio/profile')).status).toBe(401);
    expect((await request(app).patch('/api/studio/profile').send({ bio: 'x' })).status).toBe(401);
  });
});

// --- PATCH /profile ---------------------------------------------------------------

describe('PATCH /api/studio/profile', () => {
  const FULL = {
    displayName: '  Kigali Lens Studio  ',
    bio: '  Portraits and weddings across Kigali.\nBook a session.  ',
    contactPhone: '078 123 4567',
    whatsappPhone: '+250 72 123 4567',
    contactEmail: '  Hello@Kigali-Lens.Example ',
    coverImageUrl: 'https://img.example/cover.jpg',
    districts: ['kicukiro', 'gasabo'],
    categories: ['portrait', 'wedding'],
  };

  it('saves every field, trimmed and normalised, and answers what a fresh GET answers', async () => {
    const res = await patchProfile(FULL);

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'updateStudioProfile', 200);
    expect(res.body).toEqual({
      profile: {
        handle: PHOTOGRAPHER_HANDLE,
        handleEditable: false,
        displayName: 'Kigali Lens Studio',
        bio: 'Portraits and weddings across Kigali.\nBook a session.',
        contactPhone: '+250781234567',
        whatsappPhone: '+250721234567',
        contactEmail: 'hello@kigali-lens.example',
        coverImageUrl: 'https://img.example/cover.jpg',
        districts: [
          { code: 'gasabo', name: 'Gasabo' },
          { code: 'kicukiro', name: 'Kicukiro' },
        ],
        categories: [
          { slug: 'wedding', name: 'Wedding' },
          { slug: 'portrait', name: 'Portrait' },
        ],
        status: 'approved',
        submittedAt: null,
      },
    });
    expect((await getProfile()).body).toEqual(res.body);
    await expect(row(a.photographerId)).resolves.toMatchObject({ updatedAt: START });
  });

  it('shows on the public profile at once (R6.2)', async () => {
    await patchProfile(FULL);

    const res = await request(app).get(`/api/photographers/${PHOTOGRAPHER_HANDLE}`);

    expect(res.body).toMatchObject({
      photographer: { displayName: 'Kigali Lens Studio', contactPhone: '+250781234567', email: 'hello@kigali-lens.example', coverImageUrl: 'https://img.example/cover.jpg' },
    });
  });

  it('changes only what is sent', async () => {
    await patchProfile(FULL);
    const before = await profileRows(a.photographerId);

    clock = new Date(START.getTime() + 60_000);
    const res = await patchProfile({ bio: 'Only the bio.' });

    expect(profileOf(res)).toMatchObject({ bio: 'Only the bio.', displayName: 'Kigali Lens Studio', contactPhone: '+250781234567' });
    const after = await profileRows(a.photographerId);
    expect({ ...after.photographer, bio: null, updatedAt: null }).toEqual({ ...before.photographer, bio: null, updatedAt: null });
    expect([after.districts, after.categories]).toEqual([before.districts, before.categories]);
  });

  it('accepts an empty body, changing nothing but the save time', async () => {
    const before = await row(a.photographerId);
    clock = new Date(START.getTime() + 60_000);

    expect((await patchProfile({})).status).toBe(200);

    expect({ ...(await row(a.photographerId)), updatedAt: null }).toEqual({ ...before, updatedAt: null });
    await expect(row(a.photographerId)).resolves.toMatchObject({ updatedAt: clock });
  });

  it.each(['bio', 'contactPhone', 'whatsappPhone', 'contactEmail', 'coverImageUrl'])('clears %s with null and with a blank string', async (field) => {
    await patchProfile(FULL);
    expect(profileOf(await patchProfile({ [field]: null }))[field]).toBeNull();

    await patchProfile(FULL);
    expect(profileOf(await patchProfile({ [field]: '   ' }))[field]).toBeNull();
  });

  describe('displayName (`photographer_display_name_length`: 1-80 characters)', () => {
    it.each([
      ['one character', 'K'],
      ['80 characters', 'x'.repeat(80)],
      ['80 characters each two UTF-16 units', EMOJI.repeat(80)],
    ])('accepts %s', async (_label, displayName) => {
      expect(profileOf(await patchProfile({ displayName })).displayName).toBe(displayName);
      await expect(row(a.photographerId)).resolves.toMatchObject({ displayName });
    });

    it.each([
      ['blank', '   '],
      ['81 characters', 'x'.repeat(81)],
      ['81 emoji', EMOJI.repeat(81)],
      ['a NUL character', `Kigali${String.fromCharCode(0)}Lens`],
    ])('refuses %s with 422', async (_label, displayName) => {
      expect([(await patchProfile({ displayName })).status, (await patchProfile({ displayName })).body]).toEqual([422, { error: 'validation_failed', fields: ['displayName'] }]);
      await expect(row(a.photographerId)).resolves.toMatchObject({ displayName: PHOTOGRAPHER_NAME });
    });

    it.each([null, 42, ['Kigali']])('refuses %j with 400: a name is required text', async (displayName) => {
      expect((await patchProfile({ displayName })).body).toEqual({ error: 'invalid_request' });
    });
  });

  describe('bio (`photographer_bio_length`: at most 2,000 characters)', () => {
    it.each([
      ['2,000 characters', 'b'.repeat(2000)],
      ['2,000 emoji', EMOJI.repeat(2000)],
      ['text that looks like markup, verbatim (T6.4)', '<script>alert(1)</script> **bold**'],
    ])('accepts %s', async (_label, bio) => {
      expect(profileOf(await patchProfile({ bio })).bio).toBe(bio);
    });

    it.each([
      ['2,001 characters', 'b'.repeat(2001)],
      ['2,001 emoji', EMOJI.repeat(2001)],
      ['a NUL character', `a${String.fromCharCode(0)}b`],
    ])('refuses %s with 422', async (_label, bio) => {
      expect((await patchProfile({ bio })).body).toEqual({ error: 'validation_failed', fields: ['bio'] });
    });
  });

  describe('phones (stored E.164)', () => {
    it.each([
      ['a Rwandan local number', '078 123 4567', '+250781234567'],
      ['a Rwandan number without the plus', '250781234567', '+250781234567'],
      ['with dashes and brackets', '(078) 123-4567', '+250781234567'],
      ['an international number', '+1 (415) 555-0100', '+14155550100'],
      ['E.164 already', '+250731234567', '+250731234567'],
    ])('normalises %s', async (_label, typed, stored) => {
      const res = await patchProfile({ contactPhone: typed, whatsappPhone: typed });
      expect(profileOf(res)).toMatchObject({ contactPhone: stored, whatsappPhone: stored });
    });

    it.each([
      ['letters', 'call me'],
      ['too few digits', '12345'],
      ['a national number of no country we read', '0123456789'],
      ['a country code starting with 0', '+0123456789'],
      ['more than 15 digits', '+1234567890123456'],
      ['past 40 characters', `+250 78 ${'1'.repeat(40)}`],
    ])('refuses %s with 422 naming the field', async (_label, typed) => {
      expect((await patchProfile({ contactPhone: typed })).body).toEqual({ error: 'validation_failed', fields: ['contactPhone'] });
      expect((await patchProfile({ whatsappPhone: typed })).body).toEqual({ error: 'validation_failed', fields: ['whatsappPhone'] });
    });

    it('refuses a number sent as a number with 400', async () => {
      expect((await patchProfile({ contactPhone: 781234567 })).body).toEqual({ error: 'invalid_request' });
    });
  });

  describe('contactEmail', () => {
    it.each(['not-an-email', 'two@@example.com', 'name@', '@example.com'])('refuses the malformed %s with 400', async (contactEmail) => {
      expect((await patchProfile({ contactEmail })).body).toEqual({ error: 'invalid_request' });
    });

    it('refuses an address past 320 characters with 422', async () => {
      expect((await patchProfile({ contactEmail: `${'x'.repeat(320)}@example.com` })).body).toEqual({ error: 'validation_failed', fields: ['contactEmail'] });
    });

    it('is the public contact address, never the login', async () => {
      await patchProfile({ contactEmail: 'bookings@kigali-lens.example' });

      const login = await prisma.appUser.findUniqueOrThrow({ where: { id: a.photographerUserId } });
      expect(login.email).toBe('photographer@bookly.example');
    });
  });

  describe('coverImageUrl (https only: R6.5, `photographer_cover_image_https`)', () => {
    it.each([
      ['an https URL', 'https://img.example/cover.jpg', 'https://img.example/cover.jpg'],
      ['an upper-case scheme, stored canonical', 'HTTPS://IMG.example/Cover.jpg', 'https://img.example/Cover.jpg'],
      ['surrounding spaces', '  https://img.example/cover.jpg  ', 'https://img.example/cover.jpg'],
      ['a space in the path, encoded', 'https://img.example/my cover.jpg', 'https://img.example/my%20cover.jpg'],
    ])('accepts %s', async (_label, coverImageUrl, stored) => {
      expect(profileOf(await patchProfile({ coverImageUrl })).coverImageUrl).toBe(stored);
      await expect(row(a.photographerId)).resolves.toMatchObject({ coverImageUrl: stored });
    });

    it.each(['http://img.example/cover.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'ftp://img.example/cover.jpg', `https://img.example/${'x'.repeat(2000)}`])(
      'refuses %s with 422',
      async (coverImageUrl) => {
        expect((await patchProfile({ coverImageUrl })).body).toEqual({ error: 'validation_failed', fields: ['coverImageUrl'] });
      },
    );

    it.each(['not a url', 'https://', 'img.example/cover.jpg'])('refuses the malformed %s with 400', async (coverImageUrl) => {
      expect((await patchProfile({ coverImageUrl })).body).toEqual({ error: 'invalid_request' });
    });
  });

  describe('districts and categories replace the whole set', () => {
    it('replaces, and an empty list clears', async () => {
      await patchProfile({ districts: ['gasabo', 'huye'], categories: ['wedding', 'event'] });

      let profile = profileOf(await patchProfile({ districts: ['rusizi'], categories: ['family'] }));
      expect([profile.districts.map((d) => d.code), profile.categories.map((c) => c.slug)]).toEqual([['rusizi'], ['family']]);

      profile = profileOf(await patchProfile({ districts: [], categories: [] }));
      expect([profile.districts, profile.categories]).toEqual([[], []]);
      await expect(prisma.photographerDistrict.count({ where: { photographerId: a.photographerId } })).resolves.toBe(0);
    });

    it('accepts all 30 districts', async () => {
      const all = (await prisma.district.findMany({ select: { code: true } })).map((d) => d.code);

      expect(profileOf(await patchProfile({ districts: all })).districts).toHaveLength(30);
    });

    it('keeps a deactivated category assigned and unseen through a replace, and shows it again once reactivated', async () => {
      await patchProfile({ categories: ['wedding', 'event'] });
      await prisma.category.update({ where: { slug: 'event' }, data: { isActive: false } });

      expect(profileOf(await patchProfile({ categories: ['family'] })).categories.map((c) => c.slug)).toEqual(['family']);
      await prisma.category.update({ where: { slug: 'event' }, data: { isActive: true } });
      expect(profileOf(await getProfile()).categories.map((c) => c.slug)).toEqual(['event', 'family']);
    });

    it.each([
      ['an unknown district', { districts: ['gasabo', 'atlantis'] }, ['districts']],
      ['an unknown category', { categories: ['wedding', 'astronauts'] }, ['categories']],
      ['a deactivated category', { categories: ['event'] }, ['categories']],
      ['both at once', { districts: ['atlantis'], categories: ['astronauts'] }, ['districts', 'categories']],
      ['a repeated district', { districts: ['gasabo', 'gasabo'] }, ['districts']],
      ['a repeated category', { categories: ['wedding', 'wedding'] }, ['categories']],
      ['31 districts', { districts: Array.from({ length: 31 }, (_v, n) => `d${'a'.repeat(n + 1)}`) }, ['districts']],
    ])('refuses %s with 422, changing nothing at all', async (_label, body, fields) => {
      await prisma.category.update({ where: { slug: 'event' }, data: { isActive: false } });
      await patchProfile({ districts: ['huye'], categories: ['portrait'] });
      const before = await profileRows(a.photographerId);

      const res = await patchProfile({ ...body, bio: 'Would change too' });

      expect([res.status, res.body]).toEqual([422, { error: 'validation_failed', fields }]);
      expect(await profileRows(a.photographerId)).toEqual(before);
    });

    it.each([
      ['a district code in the wrong form', { districts: ['Gasabo'] }],
      ['a slug in the wrong form', { categories: ['Wedding Photos'] }],
      ['a string, not a list', { districts: 'gasabo' }],
      ['a number in the list', { categories: [1] }],
    ])('refuses %s with 400', async (_label, body) => {
      expect((await patchProfile(body)).body).toEqual({ error: 'invalid_request' });
    });
  });

  it.each([
    ['an unknown key', { bio: 'x', status: 'approved' }],
    ['a forged approval', { approvedAt: '2026-01-01T00:00:00Z' }],
    ['the login email', { email: 'mine@example.com' }],
    ['a photographer id', { photographerId: UNKNOWN_ID }],
  ])('refuses %s with 400, changing nothing', async (_label, body) => {
    const before = await profileRows(a.photographerId);

    expect((await patchProfile(body)).body).toEqual({ error: 'invalid_request' });
    expect(await profileRows(a.photographerId)).toEqual(before);
  });

  describe('the handle (R7.2)', () => {
    it('changes a pending photographer’s handle, lowercased, and the profile moves with it', async () => {
      const res = await patchProfile({ handle: '  Fresh-Start  ' }, tokenP);

      expect(profileOf(res)).toMatchObject({ handle: 'fresh-start', handleEditable: true });
      await expect(row(pendingId)).resolves.toMatchObject({ handle: 'fresh-start' });
    });

    it('lets a photographer suspended before approval change it too', async () => {
      await prisma.photographer.update({ where: { id: pendingId }, data: { status: 'suspended', suspendedAt: START } });

      expect(profileOf(await patchProfile({ handle: 'second-try' }, tokenP))).toMatchObject({ handle: 'second-try' });
    });

    it('refuses a different handle after approval with 409 handle_locked, changing nothing else either', async () => {
      const before = await profileRows(a.photographerId);

      const res = await patchProfile({ handle: 'new-name', bio: 'Would change too' });

      expect([res.status, res.body]).toEqual([409, { error: 'handle_locked' }]);
      await expectMatchesSpec(res, 'updateStudioProfile', 409);
      expect(await profileRows(a.photographerId)).toEqual(before);
    });

    it('keeps it locked through a suspension after approval', async () => {
      await prisma.photographer.update({ where: { id: a.photographerId }, data: { status: 'suspended', suspendedAt: START } });

      expect((await patchProfile({ handle: 'new-name' })).body).toEqual({ error: 'handle_locked' });
    });

    it('accepts the current handle after approval, in any case: a form posting every field back still saves', async () => {
      for (const handle of [PHOTOGRAPHER_HANDLE, PHOTOGRAPHER_HANDLE.toUpperCase()]) {
        const res = await patchProfile({ handle, bio: 'Saved' });
        expect([res.status, profileOf(res).handle, profileOf(res).bio]).toEqual([200, PHOTOGRAPHER_HANDLE, 'Saved']);
      }
    });

    it('refuses another photographer’s handle with 409 handle_taken', async () => {
      const before = await profileRows(pendingId);

      expect((await patchProfile({ handle: PHOTOGRAPHER_HANDLE }, tokenP)).body).toEqual({ error: 'handle_taken' });
      expect((await patchProfile({ handle: SECOND_PHOTOGRAPHER_HANDLE.toUpperCase() }, tokenP)).body).toEqual({ error: 'handle_taken' });
      expect(await profileRows(pendingId)).toEqual(before);
    });

    it.each([...RESERVED_HANDLES].filter((handle) => handle.length >= 3))('refuses the reserved handle %s with 409 handle_taken', async (handle) => {
      expect((await patchProfile({ handle }, tokenP)).body).toEqual({ error: 'handle_taken' });
    });

    it.each([
      ['two characters', 'ab'],
      ['31 characters', 'a'.repeat(31)],
      ['a leading hyphen', '-kigali'],
      ['a trailing hyphen', 'kigali-'],
      ['a space', 'kigali lens'],
      ['an underscore', 'kigali_lens'],
      ['an accent', 'kigalí'],
      ['a reserved one-letter name', 'p'],
    ])('refuses %s with 400 (the CHECK’s format)', async (_label, handle) => {
      expect((await patchProfile({ handle }, tokenP)).body).toEqual({ error: 'invalid_request' });
    });

    it('accepts the bounds of the format: 3 and 30 characters, inner hyphens', async () => {
      for (const handle of ['abc', `a${'-b'.repeat(14)}a`.slice(0, 30), 'k-1']) {
        expect(profileOf(await patchProfile({ handle }, tokenP)).handle).toBe(handle);
      }
    });

    it('lets exactly one of two photographers racing for one free handle have it; the other is handle_taken', async () => {
      const second = await createPhotographer(prisma, { email: 'racer@bookly.example', handle: 'racer-two', displayName: 'Racer', status: 'pending' });
      const secondToken = await tokenOf(second.photographerId);

      const results = await Promise.all([patchProfile({ handle: 'the-prize' }, tokenP), patchProfile({ handle: 'the-prize' }, secondToken)]);

      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(results.find((res) => res.status === 409)?.body).toEqual({ error: 'handle_taken' });
      await expect(prisma.photographer.count({ where: { handle: 'the-prize' } })).resolves.toBe(1);
    });

    it('frees the old handle once changed', async () => {
      await patchProfile({ handle: 'moved-on' }, tokenP);
      const other = await createPhotographer(prisma, { email: 'other@bookly.example', handle: 'other-one', displayName: 'Other', status: 'pending' });

      expect(profileOf(await patchProfile({ handle: PENDING_HANDLE }, await tokenOf(other.photographerId))).handle).toBe(PENDING_HANDLE);
    });
  });

  describe('a handle changed after submitting for review (user decision 2026-10-27)', () => {
    const SUBMITTED_AT = new Date('2026-10-19T07:00:00Z');
    const SECOND_ADMIN_EMAIL = 'second.admin@bookly.example';
    /** A reserved name the format accepts, so the refusal is the reservation's. */
    const RESERVED = [...RESERVED_HANDLES].find((handle) => handle.length >= 3) ?? 'studio';

    beforeEach(async () => {
      // A second platform admin, and a disabled one who must hear nothing.
      await prisma.appUser.create({ data: { email: SECOND_ADMIN_EMAIL, role: 'platform_admin', passwordHash: 'x', emailVerifiedAt: START } });
      await prisma.appUser.create({ data: { email: 'off@bookly.example', role: 'platform_admin', passwordHash: 'x', emailVerifiedAt: START, disabledAt: START } });
    });

    const submit = (id: string) => prisma.photographer.update({ where: { id }, data: { submittedAt: SUBMITTED_AT } });
    const alerts = () =>
      prisma.outbox.findMany({ where: { template: 'photographer_application_received' }, orderBy: [{ createdAt: 'asc' }, { recipient: 'asc' }] });
    const flagOf = async (id: string) => (await row(id)).handleChangedAt;

    it('before submitting: saves, flags nothing and emails no one', async () => {
      const res = await patchProfile({ handle: 'still-setting-up' }, tokenP);

      expect([res.status, profileOf(res).handle]).toEqual([200, 'still-setting-up']);
      expect(await flagOf(pendingId)).toBeNull();
      await expect(prisma.outbox.count()).resolves.toBe(0);
    });

    it('after submitting: saves, flags the row at the save time and emails every active platform admin the old and the new handle, once', async () => {
      await submit(pendingId);
      await prisma.photographer.update({ where: { id: pendingId }, data: { displayName: 'Old Name' } });

      const res = await patchProfile({ handle: '  Fresh-Start  ', displayName: 'New in Town' }, tokenP);

      expect(res.status).toBe(200);
      await expectMatchesSpec(res, 'updateStudioProfile', 200);
      expect(profileOf(res)).toMatchObject({ handle: 'fresh-start', handleEditable: true, status: 'pending', submittedAt: SUBMITTED_AT.toISOString() });
      await expect(row(pendingId)).resolves.toMatchObject({ handle: 'fresh-start', submittedAt: SUBMITTED_AT, handleChangedAt: START, updatedAt: START });

      const sent = await alerts();
      expect(sent.map((message) => message.recipient).sort()).toEqual([PLATFORM_ADMIN_EMAIL, SECOND_ADMIN_EMAIL].sort());
      for (const message of sent) {
        // The name as this same request saved it, and the login's address.
        expect(message.payload).toEqual({
          variant: 'handle_changed',
          displayName: 'New in Town',
          handle: 'fresh-start',
          previousHandle: PENDING_HANDLE,
          email: 'pending@bookly.example',
        });
        // Filed under no studio, like the submission's: a failure to deliver alerts the platform.
        expect([message.photographerId, message.bookingId]).toEqual([null, null]);
      }
      expect(new Set(sent.map((message) => message.dedupeKey)).size).toBe(2);
    });

    it('a later change moves the flag forward and alerts again, naming the handle it replaced', async () => {
      await submit(pendingId);
      await patchProfile({ handle: 'first-change' }, tokenP);
      clock = new Date(START.getTime() + 30 * 60_000);

      expect((await patchProfile({ handle: 'second-change' }, tokenP)).status).toBe(200);

      expect(await flagOf(pendingId)).toEqual(clock);
      const later = (await alerts()).filter((message) => (message.payload as { handle: string }).handle === 'second-change');
      expect(later).toHaveLength(2);
      for (const message of later) expect(message.payload).toMatchObject({ previousHandle: 'first-change' });
      await expect(alerts()).resolves.toHaveLength(4);
    });

    it('the same handle sent again, in any case, is no change: no flag, no email', async () => {
      await submit(pendingId);

      for (const handle of [PENDING_HANDLE, PENDING_HANDLE.toUpperCase()]) {
        const res = await patchProfile({ handle, bio: 'Polishing while I wait' }, tokenP);
        expect([res.status, profileOf(res).handle]).toEqual([200, PENDING_HANDLE]);
      }

      expect(await flagOf(pendingId)).toBeNull();
      await expect(prisma.outbox.count()).resolves.toBe(0);
    });

    it('any other field after submitting stays free: saved, with no flag and no email', async () => {
      await submit(pendingId);

      const res = await patchProfile({ displayName: 'Renamed', bio: 'New bio', contactEmail: 'hello@new-in-town.example', districts: ['gasabo'] }, tokenP);

      expect(res.status).toBe(200);
      expect(await flagOf(pendingId)).toBeNull();
      await expect(prisma.outbox.count()).resolves.toBe(0);
    });

    it('after approval: still 409 handle_locked, with no flag and no email', async () => {
      await submit(a.photographerId);

      const res = await patchProfile({ handle: 'new-name' });

      expect([res.status, res.body]).toEqual([409, { error: 'handle_locked' }]);
      expect(await flagOf(a.photographerId)).toBeNull();
      await expect(prisma.outbox.count()).resolves.toBe(0);
    });

    it('a refused change (handle_taken, reserved, an unknown district) flags nothing and emails no one', async () => {
      await submit(pendingId);

      expect((await patchProfile({ handle: SECOND_PHOTOGRAPHER_HANDLE }, tokenP)).body).toEqual({ error: 'handle_taken' });
      expect((await patchProfile({ handle: RESERVED }, tokenP)).body).toEqual({ error: 'handle_taken' });
      expect((await patchProfile({ handle: 'fresh-start', districts: ['atlantis'] }, tokenP)).status).toBe(422);

      await expect(row(pendingId)).resolves.toMatchObject({ handle: PENDING_HANDLE, handleChangedAt: null });
      await expect(prisma.outbox.count()).resolves.toBe(0);
    });

    it('two racing for one free handle after submitting: only the winner is flagged and announced', async () => {
      const second = await createPhotographer(prisma, { email: 'racer@bookly.example', handle: 'racer-two', displayName: 'Racer', status: 'pending' });
      await submit(pendingId);
      await submit(second.photographerId);
      const secondToken = await tokenOf(second.photographerId);

      const results = await Promise.all([patchProfile({ handle: 'the-prize' }, tokenP), patchProfile({ handle: 'the-prize' }, secondToken)]);

      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      const winner = (await prisma.photographer.findUniqueOrThrow({ where: { handle: 'the-prize' } })).id;
      const loser = winner === pendingId ? second.photographerId : pendingId;
      expect([await flagOf(winner), await flagOf(loser)]).toEqual([START, null]);
      const sent = await alerts();
      expect(sent).toHaveLength(2);
      for (const message of sent) expect(message.payload).toMatchObject({ handle: 'the-prize' });
    });

    it('a photographer suspended before approval is not under review: the change saves, unflagged and unannounced', async () => {
      await submit(pendingId);
      await prisma.photographer.update({ where: { id: pendingId }, data: { status: 'suspended', suspendedAt: START } });

      expect(profileOf(await patchProfile({ handle: 'second-try' }, tokenP))).toMatchObject({ handle: 'second-try' });
      expect(await flagOf(pendingId)).toBeNull();
      await expect(prisma.outbox.count()).resolves.toBe(0);
    });

    it('is never set without a submission (CHECK photographer_handle_changed_after_submission)', async () => {
      const flag = () => raw.query('UPDATE photographer SET handle_changed_at = now() WHERE id = $1', [pendingId]);

      expect(await sqlstateOf(raw, flag)).toBe(SQLSTATE.CHECK_VIOLATION);
      await submit(pendingId);
      expect(await sqlstateOf(raw, flag)).toBeUndefined();
    });
  });

  it('never touches another photographer’s rows', async () => {
    const before = await profileRows(b.photographerId);

    await patchProfile(FULL);

    expect(await profileRows(b.photographerId)).toEqual(before);
  });
});

// --- Portfolio ----------------------------------------------------------------------

type Image = { id: string; url: string; caption: string | null; sortOrder: number; createdAt: string };
const imagesOf = (res: request.Response) => (res.body as { images: Image[] }).images;
const imageOf = (res: request.Response) => (res.body as { image: Image }).image;

describe('GET /api/studio/portfolio', () => {
  it('answers an empty portfolio and the limit', async () => {
    const res = await getPortfolio();

    expect(res.body).toEqual({ images: [], limit: 24 });
    await expectMatchesSpec(res, 'listStudioPortfolio', 200);
  });

  it('lists the photographer’s images only, in order: sort order, then age', async () => {
    const early = await prisma.portfolioImage.create({ data: { photographerId: a.photographerId, url: 'https://img.example/early.jpg', sortOrder: 1, createdAt: new Date('2026-10-01T00:00:00Z') } });
    const late = await prisma.portfolioImage.create({ data: { photographerId: a.photographerId, url: 'https://img.example/late.jpg', sortOrder: 1, createdAt: new Date('2026-10-02T00:00:00Z') } });
    const first = await prisma.portfolioImage.create({ data: { photographerId: a.photographerId, url: 'https://img.example/first.jpg', sortOrder: 0 } });
    await seedImages(b.photographerId, 2);

    expect(imagesOf(await getPortfolio()).map((image) => image.id)).toEqual([first.id, early.id, late.id]);
    expect(imagesOf(await getPortfolio(tokenB))).toHaveLength(2);
  });
});

describe('POST /api/studio/portfolio', () => {
  it('adds an image last, with its caption trimmed', async () => {
    await seedImages(a.photographerId, 2);

    const res = await addImage({ url: 'https://img.example/new.jpg', caption: '  Golden hour  ' });

    expect(res.status).toBe(201);
    await expectMatchesSpec(res, 'addStudioPortfolioImage', 201);
    expect(imageOf(res)).toMatchObject({ url: 'https://img.example/new.jpg', caption: 'Golden hour', sortOrder: 2 });
    expect(imagesOf(await getPortfolio()).at(-1)?.id).toBe(imageOf(res).id);
  });

  it('adds after a gap a delete left, still last', async () => {
    const [, second] = await seedImages(a.photographerId, 3);
    await deleteImage(second!);

    expect(imageOf(await addImage({ url: 'https://img.example/new.jpg' })).sortOrder).toBe(3);
  });

  it.each([
    ['no caption', {}],
    ['a null caption', { caption: null }],
    ['a blank caption', { caption: '   ' }],
  ])('stores %s as null', async (_label, extra) => {
    expect(imageOf(await addImage({ url: 'https://img.example/a.jpg', ...extra })).caption).toBeNull();
  });

  it.each([
    ['200 characters', 'c'.repeat(200)],
    ['200 emoji', EMOJI.repeat(200)],
  ])('accepts a caption of %s', async (_label, caption) => {
    expect(imageOf(await addImage({ url: 'https://img.example/a.jpg', caption })).caption).toBe(caption);
  });

  it.each([
    ['a 201-character caption', { url: 'https://img.example/a.jpg', caption: 'c'.repeat(201) }, ['caption']],
    ['201 emoji', { url: 'https://img.example/a.jpg', caption: EMOJI.repeat(201) }, ['caption']],
    ['an http URL', { url: 'http://img.example/a.jpg' }, ['url']],
    ['a javascript: URL', { url: 'javascript:alert(1)' }, ['url']],
    ['a URL past 2,000 characters', { url: `https://img.example/${'x'.repeat(2000)}` }, ['url']],
  ])('refuses %s with 422, adding nothing', async (_label, body, fields) => {
    expect((await addImage(body)).body).toEqual({ error: 'validation_failed', fields });
    await expect(prisma.portfolioImage.count()).resolves.toBe(0);
  });

  it.each([
    ['no URL', { caption: 'x' }],
    ['a malformed URL', { url: 'not a url' }],
    ['an unknown key', { url: 'https://img.example/a.jpg', sortOrder: 0 }],
    ['a photographer id', { url: 'https://img.example/a.jpg', photographerId: UNKNOWN_ID }],
  ])('refuses %s with 400', async (_label, body) => {
    expect((await addImage(body)).body).toEqual({ error: 'invalid_request' });
  });

  it('stores an upper-case scheme canonical, so the CHECK always holds', async () => {
    expect(imageOf(await addImage({ url: 'HTTPS://img.example/A.jpg' })).url).toBe('https://img.example/A.jpg');
  });

  it('holds at most 24: the 24th is accepted, the 25th is 409 portfolio_full', async () => {
    await seedImages(a.photographerId, 23);

    expect((await addImage({ url: 'https://img.example/24.jpg' })).status).toBe(201);
    const full = await addImage({ url: 'https://img.example/25.jpg' });

    expect([full.status, full.body]).toEqual([409, { error: 'portfolio_full', limit: 24 }]);
    await expectMatchesSpec(full, 'addStudioPortfolioImage', 409);
    await expect(prisma.portfolioImage.count({ where: { photographerId: a.photographerId } })).resolves.toBe(24);
  });

  it('never lets simultaneous adds past 24', async () => {
    await seedImages(a.photographerId, 20);

    const results = await Promise.all(Array.from({ length: 8 }, (_v, n) => addImage({ url: `https://img.example/race-${n}.jpg` })));

    expect(results.filter((res) => res.status === 201)).toHaveLength(4);
    expect(results.filter((res) => res.status === 409)).toHaveLength(4);
    await expect(prisma.portfolioImage.count({ where: { photographerId: a.photographerId } })).resolves.toBe(24);
  });

  it('counts each photographer’s portfolio on its own: B’s full portfolio does not stop A', async () => {
    await seedImages(b.photographerId, 24);

    expect((await addImage({ url: 'https://img.example/a.jpg' })).status).toBe(201);
    expect((await addImage({ url: 'https://img.example/b.jpg' }, tokenB)).status).toBe(409);
  });

  it('room comes back after a delete', async () => {
    const ids = await seedImages(a.photographerId, 24);
    await deleteImage(ids[0]!);

    expect((await addImage({ url: 'https://img.example/again.jpg' })).status).toBe(201);
  });
});

describe('PATCH /api/studio/portfolio/:id', () => {
  it('sets, changes and clears a caption, and nothing else', async () => {
    const [id] = await seedImages(a.photographerId, 1);
    const before = await prisma.portfolioImage.findUniqueOrThrow({ where: { id: id! } });

    const set = await patchImage(id!, { caption: ' Ceremony ' });
    expect(set.status).toBe(200);
    await expectMatchesSpec(set, 'updateStudioPortfolioImage', 200);
    expect(imageOf(set)).toMatchObject({ id, caption: 'Ceremony', url: before.url, sortOrder: before.sortOrder });

    expect(imageOf(await patchImage(id!, { caption: null })).caption).toBeNull();
    expect(imageOf(await patchImage(id!, { caption: 'Again' })).caption).toBe('Again');
    expect(imageOf(await patchImage(id!, { caption: '' })).caption).toBeNull();
    await expect(prisma.portfolioImage.findUniqueOrThrow({ where: { id: id! } })).resolves.toEqual({ ...before, caption: null });
  });

  it('accepts the id in upper case', async () => {
    const [id] = await seedImages(a.photographerId, 1);

    expect((await patchImage(id!.toUpperCase(), { caption: 'Upper' })).status).toBe(200);
  });

  it('answers another photographer’s image exactly as an unknown id: 404, unchanged', async () => {
    const [theirs] = await seedImages(b.photographerId, 1);
    const before = await portfolioRows(b.photographerId);

    const named = await patchImage(theirs!, { caption: 'Mine' });
    const nothing = await patchImage(UNKNOWN_ID, { caption: 'Mine' });

    expect([named.status, named.body]).toEqual([404, { error: 'not_found' }]);
    expect([nothing.status, nothing.body]).toEqual([named.status, named.body]);
    expect(await portfolioRows(b.photographerId)).toEqual(before);
  });

  it.each([
    ['a 201-character caption', { caption: 'c'.repeat(201) }, 422],
    ['no caption key', {}, 400],
    ['a url change', { caption: 'x', url: 'https://img.example/other.jpg' }, 400],
    ['a number', { caption: 7 }, 400],
  ])('refuses %s', async (_label, body, status) => {
    const [id] = await seedImages(a.photographerId, 1);
    const before = await portfolioRows(a.photographerId);

    expect((await patchImage(id!, body)).status).toBe(status);
    expect(await portfolioRows(a.photographerId)).toEqual(before);
  });

  it('refuses an id that is not a uuid with 400', async () => {
    expect((await patchImage('order', { caption: 'x' })).body).toEqual({ error: 'invalid_request' });
  });
});

describe('DELETE /api/studio/portfolio/:id', () => {
  it('removes the image, leaving the rest in order', async () => {
    const [first, second, third] = await seedImages(a.photographerId, 3);

    const res = await deleteImage(second!);

    expect(res.status).toBe(204);
    expect(imagesOf(await getPortfolio()).map((image) => image.id)).toEqual([first, third]);
    expect((await deleteImage(second!)).status).toBe(404);
  });

  it('answers another photographer’s image with 404, leaving it', async () => {
    const [theirs] = await seedImages(b.photographerId, 1);

    expect([(await deleteImage(theirs!)).status, (await deleteImage(theirs!)).body]).toEqual([404, { error: 'not_found' }]);
    await expect(prisma.portfolioImage.count({ where: { id: theirs! } })).resolves.toBe(1);
  });

  it('refuses an id that is not a uuid with 400', async () => {
    expect((await deleteImage('not-a-uuid')).body).toEqual({ error: 'invalid_request' });
  });
});

describe('PUT /api/studio/portfolio/order', () => {
  it('rewrites the order as given, 0..n-1, and the public profile follows it', async () => {
    const [first, second, third] = await seedImages(a.photographerId, 3);
    await prisma.photographerDistrict.create({ data: { photographerId: a.photographerId, districtCode: 'gasabo' } });

    const res = await reorder({ ids: [third, first, second] });

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'reorderStudioPortfolio', 200);
    expect(imagesOf(res).map((image) => [image.id, image.sortOrder])).toEqual([
      [third, 0],
      [first, 1],
      [second, 2],
    ]);
    expect(imagesOf(await getPortfolio()).map((image) => image.id)).toEqual([third, first, second]);
    const profile = await request(app).get(`/api/photographers/${PHOTOGRAPHER_HANDLE}`);
    const urls = (profile.body as { photographer: { portfolio: { url: string }[] } }).photographer.portfolio.map((image) => image.url);
    expect(urls).toEqual([third, first, second].map((id) => imagesOf(res).find((image) => image.id === id)?.url));
  });

  it('accepts ids in upper case, and an empty list for an empty portfolio', async () => {
    const [first, second] = await seedImages(a.photographerId, 2);

    expect(imagesOf(await reorder({ ids: [second!.toUpperCase(), first!.toUpperCase()] })).map((image) => image.id)).toEqual([second, first]);
    // B has no images.
    expect((await reorder({ ids: [] }, tokenB)).body).toEqual({ images: [] });
  });

  it.each([
    ['one missing', (ids: string[]) => ids.slice(0, 2)],
    ['an extra unknown id', (ids: string[]) => [...ids, UNKNOWN_ID]],
    ['a repeat', (ids: string[]) => [ids[0]!, ids[0]!, ids[1]!]],
    ['a repeat in another case', (ids: string[]) => [ids[0]!, ids[0]!.toUpperCase(), ids[1]!, ids[2]!]],
    ['one swapped for an unknown id', (ids: string[]) => [ids[0]!, ids[1]!, UNKNOWN_ID]],
    ['none', () => []],
  ])('refuses %s with 422 naming ids, changing nothing', async (_label, idsFor) => {
    const ids = await seedImages(a.photographerId, 3);
    const before = await portfolioRows(a.photographerId);

    const res = await reorder({ ids: idsFor(ids) });

    expect([res.status, res.body]).toEqual([422, { error: 'validation_failed', fields: ['ids'] }]);
    expect(await portfolioRows(a.photographerId)).toEqual(before);
  });

  it('refuses another photographer’s image among the photographer’s own with 422, changing neither (R1.4)', async () => {
    const mine = await seedImages(a.photographerId, 2);
    const [theirs] = await seedImages(b.photographerId, 1);
    const before = [await portfolioRows(a.photographerId), await portfolioRows(b.photographerId)];

    for (const ids of [[...mine, theirs!], [mine[0]!, theirs!], [theirs!]]) {
      expect((await reorder({ ids })).body).toEqual({ error: 'validation_failed', fields: ['ids'] });
    }

    expect([await portfolioRows(a.photographerId), await portfolioRows(b.photographerId)]).toEqual(before);
  });

  it.each([
    ['a non-uuid', { ids: ['first'] }],
    ['no ids key', {}],
    ['ids not a list', { ids: 'a,b' }],
    ['an unknown key', { ids: [], photographerId: UNKNOWN_ID }],
  ])('refuses %s with 400', async (_label, body) => {
    expect((await reorder(body)).body).toEqual({ error: 'invalid_request' });
  });

  it('refuses more than 24 ids with 422', async () => {
    expect((await reorder({ ids: Array.from({ length: 25 }, (_v, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`) })).status).toBe(422);
  });
});
