import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { DEFAULT_RATE_LIMITS, RequestLimiter } from './rate-limit.js';

/**
 * Request limits and security headers (security review 2026-10-11, findings
 * 2-4; marketplace spec T0.2-T0.3). The limiters stand in front of the routes,
 * so these run without a database: an app with no routes mounted still counts,
 * and answers 404 until the limit and 429 after it.
 */

const NOW = new Date('2026-10-01T06:00:00Z');
const MINUTE = 60_000;

describe('RequestLimiter', () => {
  it('allows `limit` requests per key per window, then refuses until the window ends', () => {
    const limiter = new RequestLimiter(2, MINUTE);
    const t = NOW.getTime();

    expect([limiter.allow('a', t), limiter.allow('a', t + 1), limiter.allow('a', t + 2)]).toEqual([true, true, false]);
    expect(limiter.allow('b', t + 2)).toBe(true);
    expect(limiter.retryAfterSeconds('a', t + 30_000)).toBe(30);
    expect(limiter.allow('a', t + MINUTE)).toBe(true);
  });
});

describe('limited endpoints', () => {
  const tight = { limit: 1, windowMs: 10 * MINUTE };

  it.each([
    ['/api/studio/auth/login', 'loginPerIp'],
    ['/api/studio/auth/password-reset/request', 'passwordResetPerIp'],
    ['/api/studio/auth/password-reset/confirm', 'passwordResetConfirmPerIp'],
    ['/api/platform/auth/login', 'loginPerIp'],
    ['/api/platform/auth/password-reset/request', 'passwordResetPerIp'],
    ['/api/platform/auth/password-reset/confirm', 'passwordResetConfirmPerIp'],
    ['/api/account/auth/login', 'loginPerIp'],
    ['/api/account/auth/password-reset/request', 'passwordResetPerIp'],
    ['/api/account/auth/password-reset/confirm', 'passwordResetConfirmPerIp'],
    ['/api/checkout/BKY-2610-AAAAA/token/payments', 'paymentsPerIp'],
    ['/api/booking/token/payments', 'paymentsPerIp'],
    ['/api/booking/token/email', 'emailChangePerIp'],
    ['/api/bookings', 'bookingsPerIp'],
  ] as const)('POST %s is refused with 429 past its limit (%s)', async (path, name) => {
    const app = createApp({ publicApi: undefined, rateLimits: { [name]: tight } });

    expect((await request(app).post(path).send({})).status).toBe(404);
    const refused = await request(app).post(path).send({});

    expect([refused.status, refused.body]).toEqual([429, { error: 'rate_limited' }]);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('shares one allowance between the two payment routes', async () => {
    const app = createApp({ rateLimits: { paymentsPerIp: tight } });

    await request(app).post('/api/checkout/BKY-2610-AAAAA/token/payments').send({});

    expect((await request(app).post('/api/booking/token/payments').send({})).status).toBe(429);
  });

  it('counts each area’s sign-in on its own: a burst at the studio login leaves the platform’s open (Phase 2 decision 8)', async () => {
    const app = createApp({ rateLimits: { loginPerIp: tight } });

    await request(app).post('/api/studio/auth/login').send({});
    expect((await request(app).post('/api/studio/auth/login').send({})).status).toBe(429);

    expect((await request(app).post('/api/platform/auth/login').send({})).status).toBe(404);
    expect((await request(app).post('/api/account/auth/login').send({})).status).toBe(404);
  });

  it('counts the address behind the trusted proxies, not the proxy', async () => {
    const app = createApp({ trustProxyHops: 1, rateLimits: { loginPerIp: tight } });
    const from = (ip: string) => request(app).post('/api/studio/auth/login').set('X-Forwarded-For', ip).send({});

    await from('203.0.113.1');

    expect((await from('203.0.113.2')).status).toBe(404);
    expect((await from('203.0.113.1')).status).toBe(429);
  });

  it('ships production limits tighter than a script and looser than a person', () => {
    expect(DEFAULT_RATE_LIMITS.loginPerIp.limit).toBeLessThanOrEqual(10);
    expect(DEFAULT_RATE_LIMITS.bookingsPerEmail.limit).toBeLessThanOrEqual(DEFAULT_RATE_LIMITS.bookingsPerIp.limit);
  });
});

describe('security headers', () => {
  it.each(['/api/health', '/api/nope'])('are on %s', async (path) => {
    const res = await request(createApp()).get(path);

    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['strict-transport-security']).toMatch(/^max-age=\d+/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('refuses a JSON body over the pinned limit as a client error', async () => {
    const res = await request(createApp())
      .post('/api/bookings')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(110 * 1024) }));

    expect(res.status).toBe(413);
  });
});
