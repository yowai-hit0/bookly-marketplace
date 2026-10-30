import type { AppUser, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { issueToken } from '../auth/token.js';
import { STARTER_CATEGORIES } from '../db/seed.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { listedPhotographer, seedStarterCategories } from '../test/directory-fixtures.js';
import { expectMatchesSpec } from '../test/openapi.js';
import { PLATFORM_ADMIN_EMAIL, TEST_PLATFORM_SETTING, createPhotographer } from '../test/payment-fixtures.js';

/**
 * The platform's categories over HTTP, against real PostgreSQL
 * (marketplace-spec.md R9.2; Phase 9 decision 3; unit P3):
 *
 * - the list: every category, active and inactive, in order, with how many
 *   photographers have each;
 * - create (last in the order, the slug's CHECK form, `409 slug_taken`),
 *   rename and (de)activate (the slug immutable), reorder (exactly the full
 *   set), delete (only while unused, `409 category_in_use` with the count);
 *   each change one audit row in its transaction, each refusal none;
 * - decision 3 end to end: deactivating through the console hides the
 *   category from the filter bar, the directory filter (an inactive slug is
 *   the 422 of an unknown one), the cards, the profile and the studio's
 *   profile and picker, and undoes the checklist item of a studio tagged with
 *   it alone, while every photographer keeps the tag; reactivating restores
 *   all of it.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let clock: Date;
let admin: AppUser;
let token: string;
/** slug -> id of the eight starter categories. */
let ids: Map<string, string>;

const SECRET = 'platform-categories-test-secret-at-least-32-chars';
const WEB_ORIGIN = 'https://bookly.example';
const NOW = new Date('2026-10-28T06:00:00.000Z');
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const STARTER_SLUGS = STARTER_CATEGORIES.map((category) => category.slug);

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
  await prisma.platformSetting.create({ data: TEST_PLATFORM_SETTING });
  admin = await prisma.appUser.create({ data: { email: PLATFORM_ADMIN_EMAIL, role: 'platform_admin', passwordHash: 'x', emailVerifiedAt: NOW } });
  token = (await issueToken(SECRET, 'platform', admin, clock)).token;
  ids = await seedStarterCategories(prisma);
  app = createApp({
    corsOrigin: WEB_ORIGIN,
    auth: { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock },
    publicApi: { prisma, now: () => clock },
  });
});

// --- Helpers ----------------------------------------------------------------------------

const authed = (req: request.Test, bearer = token) => req.set('Authorization', `Bearer ${bearer}`);
const list = () => authed(request(app).get('/api/platform/categories'));
const create = (body: unknown) => authed(request(app).post('/api/platform/categories')).send(body as object);
const update = (id: string, body: unknown) => authed(request(app).patch(`/api/platform/categories/${id}`)).send(body as object);
const reorder = (body: unknown) => authed(request(app).put('/api/platform/categories/order')).send(body as object);
const remove = (id: string) => authed(request(app).delete(`/api/platform/categories/${id}`));

function step(): void {
  clock = new Date(clock.getTime() + 60_000);
}

function idOf(slug: string): string {
  const id = ids.get(slug);
  if (id === undefined) throw new Error(`No category ${slug}`);
  return id;
}

async function categoryRows() {
  return prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }] });
}

async function auditRows() {
  return prisma.platformAudit.findMany({ orderBy: [{ createdAt: 'asc' }, { action: 'asc' }] });
}

type Listed = { slug: string; isActive: boolean; sortOrder: number; photographerCount: number };

async function slugsInOrder(): Promise<string[]> {
  return ((await list()).body.categories as Listed[]).map((category) => category.slug);
}

/** A photographer tagged with `categories`, by status. */
async function tagged(handle: string, categories: string[], status: 'pending' | 'approved' | 'suspended' = 'approved') {
  return listedPhotographer(prisma, { handle, status, categories, districts: ['gasabo'], bio: 'Weddings and portraits around Kigali.' });
}

// --- GET -------------------------------------------------------------------------------

describe('GET /api/platform/categories', () => {
  it('lists every category, active and inactive, in order, with how many photographers of any status have each', async () => {
    await prisma.category.update({ where: { slug: 'event' }, data: { isActive: false } });
    await tagged('lens-one', ['wedding', 'event']);
    await tagged('lens-two', ['wedding'], 'suspended');
    await tagged('lens-three', ['event'], 'pending');

    const res = await list();

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'listPlatformCategories', 200);
    const categories = res.body.categories as (Listed & { id: string; nameEn: string })[];
    expect(categories.map((c) => c.slug)).toEqual(STARTER_SLUGS);
    expect(categories.map((c) => [c.slug, c.isActive, c.sortOrder, c.photographerCount]).slice(0, 4)).toEqual([
      ['wedding', true, 0, 2],
      ['portrait', true, 1, 0],
      ['event', false, 2, 2],
      ['product', true, 3, 0],
    ]);
    expect(categories[0]).toMatchObject({ id: idOf('wedding'), nameEn: 'Wedding' });
  });

  it('refuses a photographer’s token and none (T9.1)', async () => {
    const photographer = await createPhotographer(prisma, { email: 'p@bookly.example', handle: 'p-lens', displayName: 'P' });
    const user = await prisma.appUser.findUniqueOrThrow({ where: { id: photographer.photographerUserId } });
    expect((await authed(request(app).get('/api/platform/categories'), (await issueToken(SECRET, 'studio', user, clock)).token)).status).toBe(401);
    expect((await request(app).get('/api/platform/categories')).status).toBe(401);
  });
});

// --- POST ------------------------------------------------------------------------------

describe('POST /api/platform/categories', () => {
  it('creates an active category, last in the order, with the name trimmed, and writes one audit row', async () => {
    const res = await create({ slug: 'drone', nameEn: '  Drone & aerial  ' });

    expect(res.status).toBe(201);
    await expectMatchesSpec(res, 'createPlatformCategory', 201);
    expect(res.body.category).toMatchObject({ slug: 'drone', nameEn: 'Drone & aerial', isActive: true, sortOrder: 8, photographerCount: 0, createdAt: NOW.toISOString() });
    expect((await slugsInOrder()).at(-1)).toBe('drone');
    expect((await auditRows()).map((row) => [row.action, row.actorUserId, row.targetType, row.targetId, row.photographerId, row.details])).toEqual([
      ['category_created', admin.id, 'category', res.body.category.id, null, { slug: 'drone', nameEn: 'Drone & aerial', sortOrder: 8 }],
    ]);
    // The public filter bar offers it at once.
    expect((await request(app).get('/api/categories')).body.categories.at(-1)).toEqual({ slug: 'drone', name: 'Drone & aerial' });
  });

  it('goes after the highest sort order, even when the order has gaps', async () => {
    await prisma.category.update({ where: { slug: 'real-estate' }, data: { sortOrder: 40 } });
    expect((await create({ slug: 'drone', nameEn: 'Drone' })).body.category.sortOrder).toBe(41);
  });

  it('is first, at 0, when there is no category at all', async () => {
    await prisma.category.deleteMany();
    expect((await create({ slug: 'drone', nameEn: 'Drone' })).body.category.sortOrder).toBe(0);
  });

  it('refuses a slug already used, by an active or an inactive category, with 409 slug_taken, writing nothing', async () => {
    await prisma.category.update({ where: { slug: 'event' }, data: { isActive: false } });
    const before = await categoryRows();

    for (const slug of ['wedding', 'event']) {
      const res = await create({ slug, nameEn: 'Again' });
      expect([res.status, res.body]).toEqual([409, { error: 'slug_taken' }]);
      await expectMatchesSpec(res, 'createPlatformCategory', 409);
    }
    expect(await categoryRows()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it('lets several simultaneous creates each land in its own place, and exactly one of several with the same slug', async () => {
    const distinct = await Promise.all(['a-one', 'a-two', 'a-three', 'a-four'].map((slug) => create({ slug, nameEn: slug })));
    expect(distinct.map((res) => res.status)).toEqual([201, 201, 201, 201]);
    expect(distinct.map((res) => res.body.category.sortOrder as number).sort((x, y) => x - y)).toEqual([8, 9, 10, 11]);

    const same = await Promise.all(Array.from({ length: 4 }, () => create({ slug: 'clash', nameEn: 'Clash' })));
    expect(same.map((res) => res.status).sort()).toEqual([201, 409, 409, 409]);
    await expect(prisma.category.count({ where: { slug: 'clash' } })).resolves.toBe(1);
    await expect(prisma.platformAudit.count({ where: { action: 'category_created' } })).resolves.toBe(5);
  });

  it.each<[string, unknown, number]>([
    ['no slug', { nameEn: 'Drone' }, 400],
    ['no name', { slug: 'drone' }, 400],
    ['a slug with a space', { slug: 'real estate', nameEn: 'x' }, 400],
    ['an uppercase slug', { slug: 'Drone', nameEn: 'x' }, 400],
    ['a slug with a double hyphen', { slug: 'a--b', nameEn: 'x' }, 400],
    ['a slug with a leading hyphen', { slug: '-drone', nameEn: 'x' }, 400],
    ['a slug with an underscore', { slug: 'drone_shots', nameEn: 'x' }, 400],
    ['an empty slug', { slug: '', nameEn: 'x' }, 400],
    ['a numeric name', { slug: 'drone', nameEn: 5 }, 400],
    ['an unknown key', { slug: 'drone', nameEn: 'Drone', isActive: false }, 400],
    ['a slug of 65 characters', { slug: 'a'.repeat(65), nameEn: 'x' }, 422],
    ['a blank name', { slug: 'drone', nameEn: '   ' }, 422],
    ['a name of 81 characters', { slug: 'drone', nameEn: 'n'.repeat(81) }, 422],
    ['a name of 81 code points', { slug: 'drone', nameEn: '📷'.repeat(81) }, 422],
    ['a name with a NUL', { slug: 'drone', nameEn: `Dro${String.fromCharCode(0)}ne` }, 422],
  ])('refuses %s with %i, writing nothing', async (_label, body, status) => {
    const res = await create(body);
    expect(res.status).toBe(status);
    await expect(prisma.category.count()).resolves.toBe(8);
    expect(await auditRows()).toEqual([]);
  });

  it('accepts a 64-character slug and an 80-code-point name (emoji counted as one)', async () => {
    expect((await create({ slug: 'a'.repeat(64), nameEn: '📷'.repeat(80) })).status).toBe(201);
  });
});

// --- PATCH -----------------------------------------------------------------------------

describe('PATCH /api/platform/categories/:id', () => {
  it('renames, keeping the slug, and writes category_updated with the old and the new name', async () => {
    const res = await update(idOf('real-estate'), { nameEn: ' Property ' });

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'updatePlatformCategory', 200);
    expect(res.body.category).toMatchObject({ slug: 'real-estate', nameEn: 'Property', isActive: true, updatedAt: NOW.toISOString() });
    expect((await auditRows()).map((row) => [row.action, row.targetId, row.details])).toEqual([
      ['category_updated', idOf('real-estate'), { slug: 'real-estate', nameEn: { before: 'Real estate', after: 'Property' } }],
    ]);
  });

  it('deactivates and reactivates, each its own audit row with the photographers who keep it', async () => {
    await tagged('lens-one', ['wedding']);

    expect((await update(idOf('wedding'), { isActive: false })).body.category).toMatchObject({ isActive: false, photographerCount: 1 });
    step();
    expect((await update(idOf('wedding'), { isActive: true })).body.category).toMatchObject({ isActive: true, photographerCount: 1 });

    expect((await auditRows()).map((row) => [row.action, row.details])).toEqual([
      ['category_deactivated', { slug: 'wedding', nameEn: 'Wedding', photographerCount: 1 }],
      ['category_reactivated', { slug: 'wedding', nameEn: 'Wedding', photographerCount: 1 }],
    ]);
  });

  it('renames and deactivates at once: two rows, in one transaction', async () => {
    await update(idOf('event'), { nameEn: 'Events', isActive: false });

    const rows = await auditRows();
    expect(rows.map((row) => row.action).sort()).toEqual(['category_deactivated', 'category_updated']);
    // The deactivation names the category as this same save left it.
    expect(rows.find((row) => row.action === 'category_deactivated')?.details).toMatchObject({ nameEn: 'Events' });
    expect(new Set(rows.map((row) => row.createdAt.getTime()))).toEqual(new Set([NOW.getTime()]));
  });

  it('writes nothing for values already stored, or an empty body', async () => {
    const before = await categoryRows();
    for (const body of [{}, { nameEn: 'Wedding' }, { isActive: true }, { nameEn: ' Wedding ', isActive: true }]) {
      const res = await update(idOf('wedding'), body);
      expect(res.status).toBe(200);
      expect(res.body.category).toMatchObject({ slug: 'wedding', nameEn: 'Wedding', isActive: true });
    }
    expect(await categoryRows()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it.each<[string, unknown, number]>([
    ['the slug (immutable: it is in shared directory links)', { slug: 'weddings' }, 400],
    ['the slug alongside a name', { slug: 'weddings', nameEn: 'Weddings' }, 400],
    ['a sort order', { sortOrder: 3 }, 400],
    ['a string for isActive', { isActive: 'false' }, 400],
    ['a null name', { nameEn: null }, 400],
    ['a blank name', { nameEn: '  ' }, 422],
    ['a long name', { nameEn: 'n'.repeat(81) }, 422],
  ])('refuses %s with %i, changing nothing', async (_label, body, status) => {
    const before = await categoryRows();
    expect((await update(idOf('wedding'), body)).status).toBe(status);
    expect(await categoryRows()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it('answers 404 for an id that names nothing, and 400 for one that is not a uuid', async () => {
    const res = await update(UNKNOWN_ID, { nameEn: 'x' });
    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
    expect((await update('wedding', { nameEn: 'x' })).status).toBe(400);
    expect(await auditRows()).toEqual([]);
  });
});

// --- PUT /order ------------------------------------------------------------------------

describe('PUT /api/platform/categories/order', () => {
  it('puts every category in the order given, rewriting sort order 0..n-1, and writes the order before and after', async () => {
    const reversed = [...STARTER_SLUGS].reverse().map(idOf);

    const res = await reorder({ ids: reversed });

    expect(res.status).toBe(200);
    await expectMatchesSpec(res, 'reorderPlatformCategories', 200);
    expect((res.body.categories as Listed[]).map((c) => [c.slug, c.sortOrder])).toEqual([...STARTER_SLUGS].reverse().map((slug, i) => [slug, i]));
    expect((await request(app).get('/api/categories')).body.categories.map((c: { slug: string }) => c.slug)).toEqual([...STARTER_SLUGS].reverse());
    expect((await auditRows()).map((row) => [row.action, row.targetType, row.targetId, row.details])).toEqual([
      ['category_reordered', 'category', null, { before: STARTER_SLUGS.map(idOf), after: reversed }],
    ]);
  });

  it('includes inactive categories in the full set, and takes ids in any case', async () => {
    await prisma.category.update({ where: { slug: 'event' }, data: { isActive: false } });
    const order = ['event', ...STARTER_SLUGS.filter((slug) => slug !== 'event')];
    expect((await reorder({ ids: order.map((slug) => idOf(slug).toUpperCase()) })).status).toBe(200);
    expect(await slugsInOrder()).toEqual(order);
  });

  it('writes nothing for the order already stored', async () => {
    const before = await categoryRows();
    expect((await reorder({ ids: STARTER_SLUGS.map(idOf) })).status).toBe(200);
    expect(await categoryRows()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it.each<[string, () => string[]]>([
    ['one missing', () => STARTER_SLUGS.slice(1).map(idOf)],
    ['an unknown one added', () => [...STARTER_SLUGS.map(idOf), UNKNOWN_ID]],
    ['an unknown one in place of a real one', () => [UNKNOWN_ID, ...STARTER_SLUGS.slice(1).map(idOf)]],
    ['one repeated in place of another', () => [idOf('wedding'), ...STARTER_SLUGS.slice(1, -1).map(idOf), idOf('wedding')]],
    ['one repeated in another case', () => [...STARTER_SLUGS.map(idOf), idOf('wedding').toUpperCase()]],
    ['none at all', () => []],
  ])('refuses %s with 422 naming ids, changing nothing', async (_label, order) => {
    const before = await categoryRows();
    const res = await reorder({ ids: order() });
    expect([res.status, res.body]).toEqual([422, { error: 'validation_failed', fields: ['ids'] }]);
    await expectMatchesSpec(res, 'reorderPlatformCategories', 422);
    expect(await categoryRows()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['a non-uuid', { ids: ['wedding'] }],
    ['no ids key', {}],
    ['an unknown key', { ids: [UNKNOWN_ID], sortOrder: 1 }],
    ['ids that are not a list', { ids: 'all' }],
  ])('refuses %s with 400', async (_label, body) => {
    expect((await reorder(body)).status).toBe(400);
  });
});

// --- DELETE ----------------------------------------------------------------------------

describe('DELETE /api/platform/categories/:id', () => {
  it('deletes a category nobody uses: 204, gone from both lists, one audit row', async () => {
    const res = await remove(idOf('fashion'));

    expect([res.status, res.text]).toEqual([204, '']);
    expect(await slugsInOrder()).not.toContain('fashion');
    expect((await request(app).get('/api/categories')).body.categories.map((c: { slug: string }) => c.slug)).not.toContain('fashion');
    expect((await auditRows()).map((row) => [row.action, row.targetId, row.details])).toEqual([
      ['category_deleted', idOf('fashion'), { slug: 'fashion', nameEn: 'Fashion' }],
    ]);
    // The slug is free again.
    expect((await create({ slug: 'fashion', nameEn: 'Fashion' })).status).toBe(201);
  });

  it.each(['approved', 'pending', 'suspended'] as const)('refuses one a %s photographer has: 409 category_in_use with the count, changing nothing', async (status) => {
    await tagged('lens-one', ['wedding'], status);
    await tagged('lens-two', ['wedding', 'portrait']);
    const before = await categoryRows();

    const res = await remove(idOf('wedding'));

    expect([res.status, res.body]).toEqual([409, { error: 'category_in_use', photographerCount: 2 }]);
    await expectMatchesSpec(res, 'deletePlatformCategory', 409);
    expect(await categoryRows()).toEqual(before);
    await expect(prisma.photographerCategory.count({ where: { categoryId: idOf('wedding') } })).resolves.toBe(2);
    expect(await auditRows()).toEqual([]);
  });

  it('refuses an inactive one that is still tagged too, and deletes it once nobody has it', async () => {
    const listed = await tagged('lens-one', ['event']);
    await update(idOf('event'), { isActive: false });
    expect((await remove(idOf('event'))).status).toBe(409);

    await prisma.photographerCategory.deleteMany({ where: { photographerId: listed.photographerId } });
    expect((await remove(idOf('event'))).status).toBe(204);
  });

  it('answers 404 for an id that names nothing (or was deleted), and 400 for one that is not a uuid', async () => {
    await remove(idOf('fashion'));
    const again = await remove(idOf('fashion'));
    expect([again.status, again.body]).toEqual([404, { error: 'not_found' }]);
    expect((await remove(UNKNOWN_ID)).status).toBe(404);
    expect((await remove('fashion')).status).toBe(400);
    expect((await auditRows()).map((row) => row.action)).toEqual(['category_deleted']);
  });

  it('lets exactly one of several simultaneous deletes through', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => remove(idOf('fashion'))));
    expect(results.map((res) => res.status).sort()).toEqual([204, 404, 404, 404]);
    await expect(prisma.platformAudit.count()).resolves.toBe(1);
  });
});

// --- Decision 3, end to end --------------------------------------------------------------

describe('deactivating hides the category everywhere, while photographers keep it; reactivating restores it (Phase 9 decision 3)', () => {
  async function studioToken(photographerId: string): Promise<string> {
    const row = await prisma.photographer.findUniqueOrThrow({ where: { id: photographerId }, include: { user: true } });
    return (await issueToken(SECRET, 'studio', row.user, clock)).token;
  }

  it('the filter bar, the directory filter and cards, the profile, the studio’s profile and picker, and the checklist', async () => {
    const both = await tagged('lens-both', ['wedding', 'portrait']);
    const only = await tagged('lens-only', ['wedding'], 'pending');
    const studio = await studioToken(both.photographerId);
    const onlyStudio = await studioToken(only.photographerId);
    const setupDone = async (bearer: string) =>
      ((await authed(request(app).get('/api/studio/setup'), bearer)).body.setup.items as { key: string; done: boolean }[]).find((item) => item.key === 'categories')?.done;
    const cardCategories = async () => (await request(app).get('/api/photographers')).body.photographers[0]?.categories.map((c: { slug: string }) => c.slug);

    // Before: everywhere.
    expect((await request(app).get('/api/categories')).body.categories.map((c: { slug: string }) => c.slug)).toContain('wedding');
    expect((await request(app).get('/api/photographers?category=wedding')).body.photographers.map((p: { handle: string }) => p.handle)).toEqual(['lens-both']);
    expect(await cardCategories()).toEqual(['wedding', 'portrait']);
    expect(await setupDone(onlyStudio)).toBe(true);

    expect((await update(idOf('wedding'), { isActive: false })).status).toBe(200);

    // The public filter bar no longer offers it.
    expect((await request(app).get('/api/categories')).body.categories.map((c: { slug: string }) => c.slug)).not.toContain('wedding');
    // Its slug in a directory link is refused exactly as an unknown slug.
    const inactive = await request(app).get('/api/photographers?category=wedding');
    const unknown = await request(app).get('/api/photographers?category=no-such-category');
    expect([inactive.status, inactive.body]).toEqual([422, { error: 'validation_failed', fields: ['category'] }]);
    expect([inactive.status, inactive.body]).toEqual([unknown.status, unknown.body]);
    // The photographer is still listed, under their other category, without it on the card.
    expect((await request(app).get('/api/photographers?category=portrait')).body.photographers.map((p: { handle: string }) => p.handle)).toEqual(['lens-both']);
    expect(await cardCategories()).toEqual(['portrait']);
    // The public profile leaves it off.
    expect((await request(app).get('/api/photographers/lens-both')).body.photographer.categories).toEqual([{ slug: 'portrait', name: 'Portrait' }]);
    // The studio's own profile leaves it off, and its picker cannot add it.
    expect((await authed(request(app).get('/api/studio/profile'), studio)).body.profile.categories).toEqual([{ slug: 'portrait', name: 'Portrait' }]);
    const add = await authed(request(app).patch('/api/studio/profile'), studio).send({ categories: ['portrait', 'wedding'] });
    expect([add.status, add.body]).toEqual([422, { error: 'validation_failed', fields: ['categories'] }]);
    // A studio tagged with it alone has its checklist item undone.
    expect(await setupDone(onlyStudio)).toBe(false);
    // A save of the other categories keeps the hidden tag untouched.
    expect((await authed(request(app).patch('/api/studio/profile'), studio).send({ categories: ['portrait'] })).status).toBe(200);
    // Every photographer keeps the tag all along.
    await expect(prisma.photographerCategory.count({ where: { categoryId: idOf('wedding') } })).resolves.toBe(2);
    expect(((await list()).body.categories as Listed[]).find((c) => c.slug === 'wedding')).toMatchObject({ isActive: false, photographerCount: 2 });

    step();
    expect((await update(idOf('wedding'), { isActive: true })).status).toBe(200);

    // Reactivated: everything is back, nothing had to be re-tagged.
    expect((await request(app).get('/api/categories')).body.categories.map((c: { slug: string }) => c.slug)).toContain('wedding');
    expect((await request(app).get('/api/photographers?category=wedding')).body.photographers.map((p: { handle: string }) => p.handle)).toEqual(['lens-both']);
    expect(await cardCategories()).toEqual(['wedding', 'portrait']);
    expect((await request(app).get('/api/photographers/lens-both')).body.photographer.categories.map((c: { slug: string }) => c.slug)).toEqual(['wedding', 'portrait']);
    expect((await authed(request(app).get('/api/studio/profile'), studio)).body.profile.categories.map((c: { slug: string }) => c.slug)).toEqual(['wedding', 'portrait']);
    expect(await setupDone(onlyStudio)).toBe(true);
    expect((await auditRows()).map((row) => row.action)).toEqual(['category_deactivated', 'category_reactivated']);
  });
});
