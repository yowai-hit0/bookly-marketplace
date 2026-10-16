import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_LIFETIME_DAYS, accessTokenExpiry, generateAccessToken, hashAccessToken } from './access-token.js';

/**
 * A booking's access token (plan.md Task 17; data-model_v2.md §5.9; spec §7,
 * §6.21). No database.
 *
 * What is proven: a token is 256 random bits as 43 base64url characters -- well
 * past the 128 bits the spec asks for, and safe in a URL path unescaped; no two
 * are alike; what is stored is its hex SHA-256, which a page load can recompute
 * from the link and which does not contain the token; and it lasts exactly 365
 * days from confirmation, across a leap year too.
 */

const DAY_MS = 24 * 60 * 60_000;

describe('generateAccessToken', () => {
  it('is 43 base64url characters: 32 random bytes', () => {
    const { token } = generateAccessToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('comes with its own hash', () => {
    const { token, hash } = generateAccessToken();
    expect(hash).toBe(hashAccessToken(token));
  });

  it('is never the same twice in 1,000 draws', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateAccessToken().token));
    expect(tokens.size).toBe(1000);
  });

  it('uses the whole alphabet over many draws, as random bytes would', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateAccessToken().token).join(''));
    expect(seen.size).toBeGreaterThan(60);
  });
});

describe('hashAccessToken', () => {
  it('is the lower-case hex SHA-256 of the token', () => {
    const token = 'Zx9Q2mT7vL4pR8sK1nB6yH3cF5dG0wJeAbCdEfGhIjK';
    expect(hashAccessToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashAccessToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic, and differs for tokens one character apart', () => {
    expect(hashAccessToken('abc')).toBe(hashAccessToken('abc'));
    expect(hashAccessToken('abc')).not.toBe(hashAccessToken('abd'));
  });

  it('does not contain the token', () => {
    const { token, hash } = generateAccessToken();
    expect(hash).not.toContain(token);
    expect(hash).not.toContain(Buffer.from(token, 'base64url').toString('hex'));
  });
});

describe('accessTokenExpiry', () => {
  it('lasts 365 days', () => {
    expect(ACCESS_TOKEN_LIFETIME_DAYS).toBe(365);
  });

  it.each([
    ['2026-10-01T06:05:00.000Z', '2027-10-01T06:05:00.000Z'],
    // 2028 is a leap year: 365 days from 1 October 2027 is 30 September 2028.
    ['2027-10-01T06:05:00.000Z', '2028-09-30T06:05:00.000Z'],
    ['2026-12-31T23:59:59.999Z', '2027-12-31T23:59:59.999Z'],
  ])('from %s is %s', (confirmedAt, expected) => {
    const expiry = accessTokenExpiry(new Date(confirmedAt));
    expect(expiry.toISOString()).toBe(expected);
    expect(expiry.getTime() - Date.parse(confirmedAt)).toBe(365 * DAY_MS);
  });

  it('does not change the date it is given', () => {
    const confirmedAt = new Date('2026-10-01T06:05:00.000Z');
    accessTokenExpiry(confirmedAt);
    expect(confirmedAt.toISOString()).toBe('2026-10-01T06:05:00.000Z');
  });
});
