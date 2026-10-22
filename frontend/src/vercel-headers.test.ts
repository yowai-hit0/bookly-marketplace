import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The SPA's security headers (security review 2026-10-11, finding 3). The admin
 * and client sessions are bearer tokens in sessionStorage, so the CSP is what
 * stands between an injected script and those tokens: it must never allow
 * inline or eval'd script, nor framing.
 *
 * Read from the working directory: vitest runs from frontend/, and jsdom
 * gives import.meta.url a non-file scheme.
 */

type VercelConfig = {
  rewrites?: { source: string; destination: string }[];
  headers?: { source: string; headers: { key: string; value: string }[] }[];
};

const config = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as VercelConfig;
const all = config.headers?.find((rule) => rule.source === '/(.*)')?.headers ?? [];
const header = (key: string) => all.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

describe('vercel.json security headers', () => {
  it('sends a CSP whose script-src allows only same-origin files', () => {
    const csp = header('Content-Security-Policy') ?? '';
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
    expect(scriptSrc).toBe("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('sends nosniff and a no-referrer policy, so token-bearing paths never leak in Referer', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('Referrer-Policy')).toBe('no-referrer');
  });
});

/**
 * The sitemap (marketplace spec R6.6) is the API's, at its root; the web host
 * proxies its own `/sitemap.xml` there, so `robots.txt` can name one origin.
 * PLACEHOLDER: `api.bookly.example` stands for the API's deployed origin and
 * is replaced before launch (frontend/README.md, "Sitemap and robots.txt").
 */
describe('vercel.json rewrites', () => {
  const rewrites = config.rewrites ?? [];

  it('sends /sitemap.xml to the API before the SPA catch-all can claim it', () => {
    const sitemap = rewrites.findIndex((rule) => rule.source === '/sitemap.xml');
    const spa = rewrites.findIndex((rule) => rule.source === '/(.*)');
    expect(sitemap).toBeGreaterThanOrEqual(0);
    expect(spa).toBeGreaterThan(sitemap);
    expect(rewrites[spa]?.destination).toBe('/index.html');
  });

  it('proxies the sitemap to an https origin, at the API root rather than under /api', () => {
    const destination = new URL(rewrites.find((rule) => rule.source === '/sitemap.xml')?.destination ?? '');
    expect(destination.protocol).toBe('https:');
    expect(destination.pathname).toBe('/sitemap.xml');
  });
});

describe('robots.txt', () => {
  const robots = readFileSync(resolve(process.cwd(), 'public/robots.txt'), 'utf8');

  it('names the sitemap on the web origin, where the rewrite above serves it', () => {
    expect(robots).toMatch(/^Sitemap: https:\/\/[^/\s]+\/sitemap\.xml$/m);
  });

  it('keeps the token-bearing and signed-in pages out of crawls', () => {
    for (const path of ['/checkout/', '/booking/', '/email-confirm/', '/account', '/studio', '/platform']) {
      expect(robots).toContain(`Disallow: ${path}`);
    }
    expect(robots).not.toMatch(/^Disallow: \/$/m);
  });
});
