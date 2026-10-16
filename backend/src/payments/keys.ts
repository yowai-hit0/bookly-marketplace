import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Keys derived from `SESSION_SECRET`, one per purpose, and the signatures made
 * with them. Deriving rather than adding a variable per purpose keeps
 * deployment to one secret; the label makes a signature for one purpose useless
 * for any other, including the admin session tokens signed with the secret
 * itself (HMAC as a key-derivation step, as in HKDF's expand stage).
 *
 * Rotating `SESSION_SECRET` therefore also invalidates open checkout links and
 * the callback URLs of payments still waiting on the payer -- minutes of
 * exposure, stated here so a rotation is planned rather than surprising.
 */

export type KeyPurpose = 'checkout-link' | 'mtn-momo-callback';

export function deriveKey(secret: string, purpose: KeyPurpose): Buffer {
  return createHmac('sha256', secret).update(`bookly:${purpose}:v1`).digest();
}

/** base64url HMAC-SHA256 of `message`: 43 characters, 256 bits. */
export function sign(key: Buffer, message: string): string {
  return createHmac('sha256', key).update(message).digest('base64url');
}

/** Constant-time: a guessed signature learns nothing from how long it took to fail. */
export function verifySignature(key: Buffer, message: string, signature: string): boolean {
  const expected = Buffer.from(sign(key, message));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
