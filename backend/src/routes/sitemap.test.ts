import type { PrismaClient } from '@prisma/client';
import express from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { listedPhotographer } from '../test/directory-fixtures.js';
import { TEST_PLATFORM_SETTING } from '../test/payment-fixtures.js';
import { SITEMAP_MAX_URLS, escapeXml, sitemapRouter } from './sitemap.js';

/**
 * `GET /sitemap.xml` (marketplace-spec.md R6.6; routes/sitemap.ts): the landing,
 * the directory and every BOOKABLE photographer's profile on the web app's
 * origin, each profile with its `updated_at` as `lastmod`. Past-due, pending,
 * suspended and expired photographers are not listed. Every text node is
 * XML-escaped, and the list is bounded.
 */

let prisma: PrismaClient;
let raw: pg.Client;

const NOW = new Date('2026-10-01T06:00:00Z');
const WEB_ORIGIN = 'https://bookly.example';
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
});

function sitemap(origin = WEB_ORIGIN) {
  return request(createApp({ corsOrigin: origin, publicApi: { prisma, now: () => NOW } })).get('/sitemap.xml');
}

/** Every `<loc>` in document order. */
function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1] ?? '');
}

describe('GET /sitemap.xml (R6.6)', () => {
  it('lists the landing, the directory and each bookable profile, with lastmod from updated_at', async () => {
    await listedPhotographer(prisma, { handle: 'kigali-lens' });
    await listedPhotographer(prisma, { handle: 'amahoro-studio', subscription: { status: 'active', endsAt: new Date('2100-01-01T00:00:00Z') } });
    const updatedAt = new Date('2026-09-20T10:15:00.000Z');
    await raw.query("UPDATE photographer SET updated_at = $1 WHERE handle = 'kigali-lens'", [updatedAt]);

    const res = await sitemap();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
    expect(res.text.trimEnd().endsWith('</urlset>')).toBe(true);
    expect(locs(res.text)).toEqual([
      'https://bookly.example/',
      'https://bookly.example/photographers',
      'https://bookly.example/p/amahoro-studio',
      'https://bookly.example/p/kigali-lens',
    ]);
    expect(res.text).toContain('<url><loc>https://bookly.example/p/kigali-lens</loc><lastmod>2026-09-20T10:15:00.000Z</lastmod></url>');
    // The static pages carry no lastmod.
    expect(res.text).toContain('<url><loc>https://bookly.example/</loc></url>');
  });

  it('lists only bookable photographers: never past-due, pending, suspended, expired or unsubscribed', async () => {
    await listedPhotographer(prisma, { handle: 'bookable-one' });
    await listedPhotographer(prisma, { handle: 'past-due-job', subscription: { status: 'past_due', endsAt: new Date(NOW.getTime() - DAY_MS) } });
    await listedPhotographer(prisma, { handle: 'past-due-clock', subscription: { status: 'trialing', endsAt: new Date(NOW.getTime() - DAY_MS) } });
    await listedPhotographer(prisma, { handle: 'expired-one', subscription: { status: 'expired', endsAt: new Date(NOW.getTime() - 30 * DAY_MS) } });
    await listedPhotographer(prisma, { handle: 'pending-one', status: 'pending' });
    await listedPhotographer(prisma, { handle: 'suspended-one', status: 'suspended' });
    await listedPhotographer(prisma, { handle: 'unsubscribed', subscription: null });

    const res = await sitemap();

    expect(locs(res.text).filter((loc) => loc.includes('/p/'))).toEqual(['https://bookly.example/p/bookable-one']);
  });

  it('lists the two static pages alone when nobody is bookable', async () => {
    expect(locs((await sitemap()).text)).toEqual(['https://bookly.example/', 'https://bookly.example/photographers']);
  });

  it('XML-escapes the origin, and drops a trailing slash so no path doubles it', async () => {
    const res = await sitemap('https://bookly.example/?a=1&b=<2>"\'/');
    await listedPhotographer(prisma, { handle: 'kigali-lens' });
    const withProfile = await sitemap('https://bookly.example/?a=1&b=<2>"\'/');

    expect(res.text).toContain('<loc>https://bookly.example/?a=1&amp;b=&lt;2&gt;&quot;&apos;/</loc>');
    expect(withProfile.text).toContain('<loc>https://bookly.example/?a=1&amp;b=&lt;2&gt;&quot;&apos;/p/kigali-lens</loc>');
    // No raw special character survives inside any text node.
    for (const loc of locs(withProfile.text)) expect(loc).not.toMatch(/[<>"']|&(?!amp;|lt;|gt;|quot;|apos;)/);

    const plain = await sitemap('https://bookly.example/');
    expect(locs(plain.text)[0]).toBe('https://bookly.example/');
    expect(locs(plain.text)).toContain('https://bookly.example/p/kigali-lens');
  });

  it('is bounded: at most maxUrls URLs, the static pages first, then profiles by handle', async () => {
    for (const handle of ['echo-studio', 'alpha-studio', 'delta-studio', 'bravo-studio', 'charlie-studio']) await listedPhotographer(prisma, { handle });
    const bounded = express().use(sitemapRouter(prisma, WEB_ORIGIN, () => NOW, 4));

    const res = await request(bounded).get('/sitemap.xml');

    expect(locs(res.text)).toEqual([
      'https://bookly.example/',
      'https://bookly.example/photographers',
      'https://bookly.example/p/alpha-studio',
      'https://bookly.example/p/bravo-studio',
    ]);
    // Production keeps the protocol's own limit per file (sitemaps.org).
    expect(SITEMAP_MAX_URLS).toBe(50_000);
  });

  it('is served at the root, not under /api, and only when the public API is mounted', async () => {
    const mounted = createApp({ corsOrigin: WEB_ORIGIN, publicApi: { prisma, now: () => NOW } });
    expect((await request(mounted).get('/api/sitemap.xml')).status).toBe(404);
    expect((await request(mounted).post('/sitemap.xml')).status).toBe(404);
    expect((await request(createApp({ corsOrigin: WEB_ORIGIN })).get('/sitemap.xml')).status).toBe(404);
  });
});

describe('escapeXml', () => {
  it('escapes the five XML special characters and nothing else', () => {
    expect(escapeXml(`<a href="x">Tom & Jerry's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;');
    expect(escapeXml('plain-text_123 /p/kigali-lens')).toBe('plain-text_123 /p/kigali-lens');
    expect(escapeXml('&amp;')).toBe('&amp;amp;');
    expect(escapeXml('')).toBe('');
  });
});
