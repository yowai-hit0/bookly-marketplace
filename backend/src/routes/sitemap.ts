import { Prisma, type PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { bookableSqlAt } from '../photographers/bookable.js';

/**
 * `GET /sitemap.xml` (marketplace-spec.md R6.6): the pages a search engine may
 * crawl on the web app, for a client-rendered site whose server rendering is
 * deferred. Served by the API at its root, not under `/api`; the web host
 * rewrites its own `/sitemap.xml` here, and the web app's `robots.txt` points
 * at that address.
 *
 *   ${WEB_ORIGIN}/                the marketplace landing
 *   ${WEB_ORIGIN}/photographers   the directory
 *   ${WEB_ORIGIN}/p/<handle>      each BOOKABLE photographer, with `lastmod`
 *                                 from the profile's `updated_at`
 *
 * Only bookable photographers: a `past_due` profile is still served, but it
 * cannot be booked, so it is not offered to be indexed; pending, suspended and
 * expired ones are a 404 anyway. Bounded at `SITEMAP_MAX_URLS`, the sitemap
 * protocol's own limit per file, so the answer can never grow without end.
 * Every text node is XML-escaped, whatever the origin or handle holds (a handle
 * is `[a-z0-9-]` by CHECK; the escape does not rely on it).
 */

/** The sitemap protocol's limit of URLs in one file (sitemaps.org). */
export const SITEMAP_MAX_URLS = 50_000;
const STATIC_PATHS = ['/', '/photographers'] as const;

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** The five XML special characters as entities. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/** `maxUrls` is the bound, for tests; production keeps the protocol's limit. */
export function sitemapRouter(prisma: PrismaClient, webOrigin: string, now: () => Date = () => new Date(), maxUrls = SITEMAP_MAX_URLS): Router {
  const router = Router();
  const origin = webOrigin.replace(/\/+$/, '');

  router.get('/sitemap.xml', async (_req, res) => {
    const rows = await prisma.$queryRaw<{ handle: string; updated_at: Date }[]>(Prisma.sql`
      SELECT ph.handle, ph.updated_at
        FROM photographer ph
        LEFT JOIN subscription s ON s.photographer_id = ph.id
       WHERE ${bookableSqlAt(now())}
       ORDER BY ph.handle ASC
       LIMIT ${Math.max(0, maxUrls - STATIC_PATHS.length)}::int`);

    const urls = [
      ...STATIC_PATHS.map((path) => `  <url><loc>${escapeXml(origin + path)}</loc></url>`),
      ...rows.map(
        (row) =>
          `  <url><loc>${escapeXml(`${origin}/p/${encodeURIComponent(row.handle)}`)}</loc><lastmod>${escapeXml(row.updated_at.toISOString())}</lastmod></url>`,
      ),
    ];
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  });

  return router;
}
