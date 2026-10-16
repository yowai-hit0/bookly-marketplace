import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkoutToken, verifyCheckoutToken } from './checkout-link.js';
import { deriveKey, sign, verifySignature } from './keys.js';

/**
 * The checkout link's token and the keys behind it (plan.md Task 16). No
 * database.
 *
 * What is proven: a key is HMAC-SHA256 of a purpose label under
 * `SESSION_SECRET`, so a signature made for one purpose -- the checkout link, the
 * MTN callback URL -- is worthless for the other and for the admin session
 * tokens signed with the secret itself; a signature is 43 base64url characters;
 * verification is exact, never throws on a malformed or multi-byte candidate,
 * and does not accept a token for another reference or under another secret. The
 * token is deterministic, so a reloaded checkout link still works.
 */

const SECRET = 'checkout-test-secret-that-is-at-least-32-chars';
const REFERENCE = 'BKY-2610-7K3QX';
const OTHER_REFERENCE = 'BKY-2610-7K3QY';

describe('deriveKey', () => {
  it('is HMAC-SHA256 of "bookly:<purpose>:v1" under the secret', () => {
    expect(deriveKey(SECRET, 'checkout-link')).toEqual(createHmac('sha256', SECRET).update('bookly:checkout-link:v1').digest());
    expect(deriveKey(SECRET, 'mtn-momo-callback')).toEqual(createHmac('sha256', SECRET).update('bookly:mtn-momo-callback:v1').digest());
  });

  it('gives each purpose its own 32-byte key, and neither is the secret', () => {
    const checkout = deriveKey(SECRET, 'checkout-link');
    const callback = deriveKey(SECRET, 'mtn-momo-callback');

    expect(checkout).toHaveLength(32);
    expect(callback).toHaveLength(32);
    expect(checkout.equals(callback)).toBe(false);
    expect(checkout.equals(Buffer.from(SECRET).subarray(0, 32))).toBe(false);
  });

  it('changes with the secret', () => {
    expect(deriveKey(SECRET, 'checkout-link').equals(deriveKey(`${SECRET}!`, 'checkout-link'))).toBe(false);
  });
});

describe('sign and verifySignature', () => {
  const key = deriveKey(SECRET, 'checkout-link');

  it('signs to 43 base64url characters (256 bits), deterministically', () => {
    const signature = sign(key, 'message');
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sign(key, 'message')).toBe(signature);
    expect(signature).toBe(createHmac('sha256', key).update('message').digest('base64url'));
  });

  it('verifies its own signature and nothing else', () => {
    const signature = sign(key, 'message');
    expect(verifySignature(key, 'message', signature)).toBe(true);
    expect(verifySignature(key, 'Message', signature)).toBe(false);
    expect(verifySignature(deriveKey(SECRET, 'mtn-momo-callback'), 'message', signature)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['one character short', 'x'.repeat(42)],
    ['one character long', 'x'.repeat(44)],
    ['multi-byte, 43 characters but 44 bytes', `${'x'.repeat(42)}é`],
    ['multi-byte, 43 bytes but fewer characters', `${'x'.repeat(41)}é`],
    ['standard base64 with padding', Buffer.alloc(32).toString('base64')],
  ])('refuses, without throwing, a candidate that is %s', (_case, candidate) => {
    expect(() => verifySignature(key, 'message', candidate)).not.toThrow();
    expect(verifySignature(key, 'message', candidate)).toBe(false);
  });
});

describe('checkoutToken', () => {
  it('is the reference signed under the checkout-link key', () => {
    expect(checkoutToken(SECRET, REFERENCE)).toBe(sign(deriveKey(SECRET, 'checkout-link'), REFERENCE));
    expect(checkoutToken(SECRET, REFERENCE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is the same every time, so a reloaded link still opens the checkout', () => {
    expect(checkoutToken(SECRET, REFERENCE)).toBe(checkoutToken(SECRET, REFERENCE));
  });

  it('verifies for its reference under its secret', () => {
    expect(verifyCheckoutToken(SECRET, REFERENCE, checkoutToken(SECRET, REFERENCE))).toBe(true);
  });

  it('does not open another booking’s checkout, even one reference character away', () => {
    const token = checkoutToken(SECRET, REFERENCE);
    expect(checkoutToken(SECRET, OTHER_REFERENCE)).not.toBe(token);
    expect(verifyCheckoutToken(SECRET, OTHER_REFERENCE, token)).toBe(false);
    expect(verifyCheckoutToken(SECRET, REFERENCE.toLowerCase(), token)).toBe(false);
  });

  it('stops working when the secret is rotated', () => {
    expect(verifyCheckoutToken(`${SECRET}-rotated`, REFERENCE, checkoutToken(SECRET, REFERENCE))).toBe(false);
  });

  it('is not the MTN callback signature for the same text', () => {
    expect(checkoutToken(SECRET, REFERENCE)).not.toBe(sign(deriveKey(SECRET, 'mtn-momo-callback'), REFERENCE));
    expect(verifySignature(deriveKey(SECRET, 'mtn-momo-callback'), REFERENCE, checkoutToken(SECRET, REFERENCE))).toBe(false);
  });

  it('refuses a tampered token', () => {
    const token = checkoutToken(SECRET, REFERENCE);
    const flipped = `${token.slice(0, 20)}${token[20] === 'a' ? 'b' : 'a'}${token.slice(21)}`;
    for (const tampered of [flipped, token.slice(1), `${token}a`, '', token.split('').reverse().join('')]) {
      expect(verifyCheckoutToken(SECRET, REFERENCE, tampered)).toBe(false);
    }
  });
});
