import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { PORTFOLIO_LIMIT } from '../catalogue/public.js';
import { createPrismaClient } from '../db/client.js';
import { updatePhotographerSettings } from '../settings/index.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type ListedPhotographer, listedPhotographer, seedStarterCategories } from '../test/directory-fixtures.js';
import { TEST_PLATFORM_SETTING } from '../test/payment-fixtures.js';

/**
 * The profile page's API, `GET /api/photographers/:handle`, against real
 * PostgreSQL (marketplace-spec.md R6.2, R6.5, T6.4; catalogue/public.ts
 * `findPublicPhotographerDetail`).
 *
 *   - The profile, districts, categories, the portfolio (at most 24, in the
 *     photographer's order, `https://` only), the active services each with its
 *     "from" price, the cancellation policy and the contact details set.
 *   - Still an allowlist: never the id, the login email, the status, the
 *     subscription or an operating setting.
 *   - T6.4: a bio holding `<script>` (or any markup) comes back as exactly the
 *     string stored, as JSON text. Nothing is escaped, stripped or rendered
 *     here: the page renders it as plain text (R6.5).
 *   - 404 for an unknown handle and for a pending, suspended or expired
 *     photographer, the same answer for each. A past-due one is served with
 *     `takingBookings: false`.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let app: Express;
let owner: ListedPhotographer;

const NOW = new Date('2026-10-01T06:00:00Z');
const HANDLE = 'kigali-lens';
const PROFILE = `/api/photographers/${HANDLE}`;
const DAY_MS = 24 * 60 * 60_000;

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
  await prisma.platformSetting.create({ data: TEST_PLATFORM_SETTING });
  await seedStarterCategories(prisma);
  owner = await listedPhotographer(prisma, {
    handle: HANDLE,
    displayName: 'Kigali Lens',
    districts: ['huye', 'gasabo'],
    categories: ['family', 'wedding'],
    packages: [],
    coverImageUrl: 'https://images.example.com/cover.jpg',
    bio: 'Weddings and portraits.',
  });
  app = createApp({ publicApi: { prisma, now: () => NOW } });
});

type Detail = {
  handle: string;
  displayName: string;
  bio: string | null;
  coverImageUrl: string | null;
  contactPhone: string | null;
  whatsappPhone: string | null;
  email: string | null;
  takingBookings: boolean;
  cancellationPolicy: { cutoffHours: number; bookingFeeRefundable: boolean };
  districts: { code: string; name: string }[];
  categories: { slug: string; name: string }[];
  portfolio: { url: string; caption: string | null }[];
  services: { slug: string; nameEn: string; descriptionEn: string | null; coverImageUrl: string | null; fromPriceRwf: number | null }[];
};

async function profile(path = PROFILE): Promise<Detail> {
  const res = await request(app).get(path);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { photographer: Detail }).photographer;
}

async function addService(slug: string, data: { sortOrder?: number; isActive?: boolean; coverImageUrl?: string; descriptionEn?: string } = {}) {
  return prisma.service.create({ data: { photographerId: owner.photographerId, slug, nameEn: `Name of ${slug}`, ...data } });
}

async function addPackage(serviceId: string, priceRwf: number, isActive = true) {
  return prisma.package.create({ data: { photographerId: owner.photographerId, serviceId, nameEn: `P ${priceRwf}`, priceRwf, photoCount: 10, durationMinutes: 60, isActive } });
}

describe('GET /api/photographers/:handle, the profile page (R6.2)', () => {
  it('answers the whole page as an allowlist', async () => {
    await prisma.photographer.update({
      where: { id: owner.photographerId },
      data: { contactPhone: '+250788000001', whatsappPhone: '+250788000002', contactEmail: 'hello@kigalilens.example' },
    });
    const portraits = await addService('portraits', { coverImageUrl: 'https://images.example.com/portraits.jpg', descriptionEn: 'Studio portraits.' });
    await addPackage(portraits.id, 40_000);
    await prisma.portfolioImage.create({ data: { photographerId: owner.photographerId, url: 'https://images.example.com/1.jpg', caption: 'One' } });

    const res = await request(app).get(PROFILE);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      photographer: {
        handle: HANDLE,
        displayName: 'Kigali Lens',
        bio: 'Weddings and portraits.',
        coverImageUrl: 'https://images.example.com/cover.jpg',
        contactPhone: '+250788000001',
        whatsappPhone: '+250788000002',
        email: 'hello@kigalilens.example',
        takingBookings: true,
        cancellationPolicy: { cutoffHours: 0, bookingFeeRefundable: false },
        districts: [
          { code: 'gasabo', name: 'Gasabo' },
          { code: 'huye', name: 'Huye' },
        ],
        categories: [
          { slug: 'wedding', name: 'Wedding' },
          { slug: 'family', name: 'Family' },
        ],
        portfolio: [{ url: 'https://images.example.com/1.jpg', caption: 'One' }],
        services: [{ slug: 'portraits', nameEn: 'Name of portraits', descriptionEn: 'Studio portraits.', coverImageUrl: 'https://images.example.com/portraits.jpg', fromPriceRwf: 40_000 }],
      },
    });
    for (const hidden of [owner.photographerId, `${HANDLE}@photographers.example`, 'approved', 'trialing', 'status', 'userId', 'bufferMinutes', 'minLeadTimeMinutes', 'sortOrder', 'isActive', 'nameFr']) {
      expect(res.text, hidden).not.toContain(hidden);
    }
  });

  it('answers only the contact details set, as null otherwise, and never the login email in their place', async () => {
    const page = await profile();

    expect([page.contactPhone, page.whatsappPhone, page.email]).toEqual([null, null, null]);
    expect(JSON.stringify(page)).not.toContain('@photographers.example');
  });

  it('states the cancellation policy as the photographer has it now', async () => {
    await updatePhotographerSettings(owner.photographerId, { clientCancelCutoffHours: 48, bookingFeeRefundableOnClientCancel: true }, prisma);

    expect((await profile()).cancellationPolicy).toStrictEqual({ cutoffHours: 48, bookingFeeRefundable: true });
  });

  it('leaves an inactive category off', async () => {
    await prisma.category.update({ where: { slug: 'wedding' }, data: { isActive: false } });

    expect((await profile()).categories).toEqual([{ slug: 'family', name: 'Family' }]);
  });

  it('answers empty lists for a photographer with no districts, categories, portfolio or services', async () => {
    await prisma.photographerDistrict.deleteMany();
    await prisma.photographerCategory.deleteMany();

    const page = await profile();

    expect([page.districts, page.categories, page.portfolio, page.services]).toEqual([[], [], [], []]);
  });
});

describe('services on the profile', () => {
  it('lists the active services in catalogue order, each with its cheapest active package', async () => {
    const weddings = await addService('weddings', { sortOrder: 1 });
    const portraits = await addService('portraits', { sortOrder: 0 });
    const retired = await addService('retired', { sortOrder: 2, isActive: false });
    const comingSoon = await addService('coming-soon', { sortOrder: 3 });
    await addPackage(weddings.id, 450_000);
    await addPackage(weddings.id, 300_000);
    await addPackage(weddings.id, 1_000, false);
    await addPackage(portraits.id, 40_000);
    await addPackage(retired.id, 5_000);
    await addPackage(comingSoon.id, 2_000, false);

    const page = await profile();

    expect(page.services.map((service) => [service.slug, service.fromPriceRwf])).toEqual([
      ['portraits', 40_000],
      ['weddings', 300_000],
      // Active, but nothing active to book yet.
      ['coming-soon', null],
    ]);
  });
});

describe('the portfolio (R6.2, R6.5)', () => {
  it(`answers at most ${PORTFOLIO_LIMIT} images, in the photographer's order`, async () => {
    // 30 images, inserted in reverse of their sort order.
    for (let i = 29; i >= 0; i -= 1) {
      await prisma.portfolioImage.create({ data: { photographerId: owner.photographerId, url: `https://images.example.com/${i}.jpg`, caption: i % 2 === 0 ? `Image ${i}` : null, sortOrder: i } });
    }

    const page = await profile();

    expect(page.portfolio).toHaveLength(24);
    expect(page.portfolio.map((image) => image.url)).toEqual(Array.from({ length: 24 }, (_, i) => `https://images.example.com/${i}.jpg`));
    expect(page.portfolio[0]).toStrictEqual({ url: 'https://images.example.com/0.jpg', caption: 'Image 0' });
    expect(page.portfolio[1]).toStrictEqual({ url: 'https://images.example.com/1.jpg', caption: null });
  });

  it('breaks a tie of sort order by age, oldest first', async () => {
    // Ages set explicitly: inserts this close together can share a timestamp,
    // which would leave the order to the random id tiebreak.
    for (const [i, name] of ['first', 'second', 'third'].entries()) {
      await prisma.portfolioImage.create({
        data: { photographerId: owner.photographerId, url: `https://images.example.com/${name}.jpg`, sortOrder: 5, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) },
      });
    }
    await prisma.portfolioImage.create({ data: { photographerId: owner.photographerId, url: 'https://images.example.com/lead.jpg', sortOrder: 1 } });

    expect((await profile()).portfolio.map((image) => image.url.split('/').pop())).toEqual(['lead.jpg', 'first.jpg', 'second.jpg', 'third.jpg']);
  });

  it('holds only https URLs: the database refuses any other scheme, so none can be answered', async () => {
    for (const url of ['http://images.example.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//images.example.com/a.jpg', 'HTTPS://images.example.com/a.jpg']) {
      await expect(prisma.portfolioImage.create({ data: { photographerId: owner.photographerId, url } }), url).rejects.toThrow();
    }
    await prisma.portfolioImage.create({ data: { photographerId: owner.photographerId, url: 'https://images.example.com/ok.jpg' } });

    const page = await profile();

    expect(page.portfolio.map((image) => image.url)).toEqual(['https://images.example.com/ok.jpg']);
    expect(page.portfolio.every((image) => image.url.startsWith('https://'))).toBe(true);
  });

  it("never answers another photographer's images", async () => {
    const other = await listedPhotographer(prisma, { handle: 'hills-and-light' });
    await prisma.portfolioImage.create({ data: { photographerId: other.photographerId, url: 'https://images.example.com/theirs.jpg' } });

    expect((await profile()).portfolio).toEqual([]);
  });
});

describe('T6.4: profile text is answered verbatim, never transformed', () => {
  it.each([
    '<script>alert("x")</script>',
    'Before <script src="https://evil.example/x.js"></script> after',
    '<img src=x onerror=alert(1)> & "quotes" \'apostrophes\'',
    '**not markdown** [link](javascript:alert(1))',
    'Line one\nLine two\n\n</script><script>alert(1)</script>',
    '&lt;already escaped&gt; &amp;',
  ])('returns the bio %j exactly as stored, as a JSON string', async (bio) => {
    await prisma.photographer.update({ where: { id: owner.photographerId }, data: { bio, displayName: '<b>Kigali</b> Lens' } });
    const portraits = await addService('portraits', { descriptionEn: bio });
    await addPackage(portraits.id, 40_000);
    await prisma.portfolioImage.create({ data: { photographerId: owner.photographerId, url: 'https://images.example.com/1.jpg', caption: bio.slice(0, 200) } });

    const res = await request(app).get(PROFILE);

    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const page = (res.body as { photographer: Detail }).photographer;
    expect(page.bio).toBe(bio);
    expect(page.displayName).toBe('<b>Kigali</b> Lens');
    expect(page.services[0]?.descriptionEn).toBe(bio);
    expect(page.portfolio[0]?.caption).toBe(bio.slice(0, 200));
    // The body is JSON whose string decodes to exactly the bio: nothing escaped into entities, nothing stripped.
    expect(res.text).toContain(JSON.stringify(bio));
  });

  it('leaves the bio off the directory card entirely', async () => {
    await prisma.photographer.update({ where: { id: owner.photographerId }, data: { bio: '<script>alert(1)</script>' } });
    const portraits = await addService('portraits');
    await addPackage(portraits.id, 40_000);

    const res = await request(app).get('/api/photographers');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('script');
  });
});

describe('who has a profile page (R5.5)', () => {
  it.each([
    ['an unknown handle', 'nobody-here', {}],
    ['a pending photographer', 'pending-one', { status: 'pending' as const }],
    ['a suspended photographer', 'suspended-one', { status: 'suspended' as const }],
    ['an expired photographer, by the job', 'expired-job', { subscription: { status: 'expired', endsAt: new Date(NOW.getTime() - 8 * DAY_MS) } }],
    ['an expired photographer, by the clock', 'expired-clock', { subscription: { status: 'trialing', endsAt: new Date(NOW.getTime() - 8 * DAY_MS) } }],
    ['an approved photographer with no subscription', 'no-subscription', { subscription: null }],
  ])('is a 404 for %s, the same answer every time', async (_label, handle, seed) => {
    if (handle !== 'nobody-here') await listedPhotographer(prisma, { handle, ...seed });

    const res = await request(app).get(`/api/photographers/${handle}`);

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });

  it.each(['Kigali-Lens', 'kigali%25', 'x'.repeat(40), 'a', '..', "kigali-lens'--"])('is a 404 for the malformed handle %j', async (handle) => {
    const res = await request(app).get(`/api/photographers/${encodeURIComponent(handle)}`);

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });

  it('serves a past-due photographer, not taking bookings', async () => {
    await prisma.subscription.update({ where: { photographerId: owner.photographerId }, data: { status: 'past_due', currentPeriodEndsAt: new Date(NOW.getTime() - DAY_MS) } });

    const res = await request(app).get(PROFILE);

    expect(res.status).toBe(200);
    expect((res.body as { photographer: Detail }).photographer.takingBookings).toBe(false);
    expect(res.text).not.toContain('past_due');
  });
});
