import { deriveKey, sign, verifySignature } from './keys.js';

/**
 * The checkout link: `/checkout/<reference>/<token>` on the site (plan.md
 * Task 16). A visitor whose booking holds its slot pays through it.
 *
 * The booking's id never reaches a URL (data-model_v2.md §5.9), and its
 * reference alone is not enough -- 32^5 references a month can be walked, and
 * each would let a stranger trigger payment prompts on phones of their choosing.
 * The token is an HMAC of the reference, so nothing new is stored, it survives a
 * page reload, and it is only good for what the checkout allows: paying a fee
 * while the hold lasts. The client's access token (Task 17) is a different
 * secret that does not exist until the booking is paid.
 */

export function checkoutToken(secret: string, reference: string): string {
  return sign(deriveKey(secret, 'checkout-link'), reference);
}

export function verifyCheckoutToken(secret: string, reference: string, token: string): boolean {
  return verifySignature(deriveKey(secret, 'checkout-link'), reference, token);
}
