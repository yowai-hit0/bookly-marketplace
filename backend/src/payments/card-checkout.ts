import type { PlanInterval } from '../subscriptions/plan.js';
import type { CardSession, InlineCardConfig, PaymentProvider } from './provider.js';

/**
 * The card answer of a pay route (2026-10-30): `{ payment, card }`, where
 * `card` is the Flutterwave Inline config the page hands to
 * `FlutterwaveCheckout(...)` unchanged, built here from what the server knows.
 * Nothing in it comes from the request: the amount is the payment row's, the
 * payer the booking's snapshot (or the photographer's login), the reference
 * our own, and the return URL a path on WEB_ORIGIN built from segments the
 * route has already validated -- never one the page could choose, so it is no
 * open redirect.
 *
 * Where each payer lands after the modal, a 3-D Secure redirect included:
 *
 *   booking fee                /checkout/:reference/:token/payments/:ourRef  (R3.2: the existing
 *                              progress page; the checkout token pays this fee and nothing else)
 *   session fee, guest page    /payments/:ourRef  (a NEW, token-free page: the booking's access
 *                              token reads and cancels the booking, and the return URL is stored
 *                              by Flutterwave, so it is never put in one)
 *   session fee, account       /account/bookings/:reference/payments/:ourRef  (behind the session)
 *   subscription               /studio/subscription/payments/:ourRef  (a NEW studio page)
 *
 * Each page polls its status route, which also asks Flutterwave now and then
 * (payments/card-check.ts); what the redirect appends (`status=successful`) is
 * never read as a result (R3.3, T3.2).
 */

export const cardReturnPaths = {
  bookingFee: (reference: string, token: string, ourRef: string) =>
    `/checkout/${encodeURIComponent(reference)}/${encodeURIComponent(token)}/payments/${encodeURIComponent(ourRef)}`,
  guestSessionFee: (ourRef: string) => `/payments/${encodeURIComponent(ourRef)}`,
  accountSessionFee: (reference: string, ourRef: string) =>
    `/account/bookings/${encodeURIComponent(reference)}/payments/${encodeURIComponent(ourRef)}`,
  subscription: (ourRef: string) => `/studio/subscription/payments/${encodeURIComponent(ourRef)}`,
};

/** The modal's heading. English only, like every page (Product decisions, Scope). */
export const cardTitles = {
  bookingFee: (reference: string) => `Bookly booking fee ${reference}`,
  sessionFee: (reference: string) => `Bookly session fee ${reference}`,
  subscription: (planInterval: PlanInterval) => `Bookly ${planInterval} subscription`,
};

/** The Inline config for a card attempt the provider has just accepted or is still holding open. */
export function cardConfig(provider: PaymentProvider, ourRef: string, card: CardSession, title: string, returnPath: string): InlineCardConfig {
  if (provider.browserCheckout === undefined) throw new Error(`${provider.id} has no browser checkout, yet it was routed a card`);
  return provider.browserCheckout({ ...card, ourRef, title, returnPath });
}
