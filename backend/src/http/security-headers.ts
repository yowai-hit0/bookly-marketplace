import type { RequestHandler } from 'express';

/**
 * Security headers on every API response (security review 2026-10-11,
 * finding 3; marketplace spec R0.2).
 *
 * The API serves JSON only, never a page, so its CSP refuses everything: a
 * response that a browser is somehow tricked into rendering can load nothing
 * and be framed by nobody. The SPA's own CSP is in frontend/vercel.json.
 *
 * Written by hand rather than through a library: five fixed headers do not
 * justify a runtime dependency in a public repository.
 */
export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      // Booking and checkout links carry their tokens in the path.
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    next();
  };
}
