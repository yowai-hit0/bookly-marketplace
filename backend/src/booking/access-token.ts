import { createHash, randomBytes } from 'node:crypto';
import { ACCESS_TOKEN_LIFETIME_DAYS } from '../settings/constants.js';

/**
 * A booking's access token (data-model_v2.md §5.9; spec §3.9, §7): the secret in
 * the client's return link. 256 random bits, base64url so it sits in a URL path
 * unescaped. Only its SHA-256 is stored; the plaintext goes into the confirmation
 * email's outbox payload and nowhere else, so it is recoverable only by
 * replacing it (spec §6.21).
 */

// A constant, not a setting (data-model_v2.md §11.1), and defined once beside
// the other one: two copies of a lifetime are two lifetimes waiting to differ.
export { ACCESS_TOKEN_LIFETIME_DAYS };
const TOKEN_BYTES = 32;
const DAY_MS = 24 * 60 * 60_000;

export type AccessToken = { token: string; hash: string };

export function generateAccessToken(): AccessToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashAccessToken(token) };
}

/** Hex SHA-256: what `access_token_hash` holds and what a page load looks up. */
export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function accessTokenExpiry(confirmedAt: Date): Date {
  return new Date(confirmedAt.getTime() + ACCESS_TOKEN_LIFETIME_DAYS * DAY_MS);
}
