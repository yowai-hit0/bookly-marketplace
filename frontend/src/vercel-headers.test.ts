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

type VercelConfig = { headers?: { source: string; headers: { key: string; value: string }[] }[] };

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
