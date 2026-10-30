import { describe, expect, it } from 'vitest';
import { stubProvider } from '../test/payment-fixtures.js';
import { OFFERABLE_METHODS, requestProvider, routePayments, routedProviderId } from './routing.js';

/**
 * The method routing on its own (marketplace-spec.md R3.1, decided
 * 2026-10-17). No database, no environment.
 *
 * What is proven: MTN MoMo goes where `MOMO_MTN_PROVIDER` says, Airtel Money
 * always to Flutterwave and card always to Flutterwave v3 Inline
 * (`flutterwave_checkout`, 2026-10-30); a route survives only when its provider
 * is configured and collects that method; methods keep the pay page's order
 * (`momo_mtn`, `momo_airtel`, `card`); anything that is not an offered method
 * finds no provider; and a session-fee request is recorded against the first
 * method's provider, or none when nothing is on offer.
 */

/** Enough of a browser checkout for routing: it is never opened here. */
const browserCheckout = (): never => {
  throw new Error('not opened in these tests');
};

describe('routedProviderId', () => {
  it('sends MTN MoMo where MOMO_MTN_PROVIDER says, and Airtel Money always to Flutterwave', () => {
    expect(routedProviderId('momo_mtn', 'mtn_momo_direct')).toBe('mtn_momo_direct');
    expect(routedProviderId('momo_mtn', 'flutterwave')).toBe('flutterwave');
    expect(routedProviderId('momo_airtel', 'mtn_momo_direct')).toBe('flutterwave');
    expect(routedProviderId('momo_airtel', 'flutterwave')).toBe('flutterwave');
  });

  it('sends card to Flutterwave v3 Inline whatever MOMO_MTN_PROVIDER says', () => {
    expect(routedProviderId('card', 'mtn_momo_direct')).toBe('flutterwave_checkout');
    expect(routedProviderId('card', 'flutterwave')).toBe('flutterwave_checkout');
  });

  it('offers card last, after both MoMo networks', () => {
    expect(OFFERABLE_METHODS).toEqual(['momo_mtn', 'momo_airtel', 'card']);
  });
});

describe('routePayments', () => {
  const mtn = stubProvider({ id: 'mtn_momo_direct', methods: ['momo_mtn'] });
  const flutterwave = stubProvider({ id: 'flutterwave', methods: ['momo_mtn', 'momo_airtel'] });
  const cards = stubProvider({ id: 'flutterwave_checkout', methods: ['card'], browserCheckout });

  it('offers each routed method, mapped to its own provider', () => {
    const routing = routePayments({ momo_mtn: mtn, momo_airtel: flutterwave });
    expect(routing.methods).toEqual(['momo_mtn', 'momo_airtel']);
    expect(routing.providerFor('momo_mtn')).toBe(mtn);
    expect(routing.providerFor('momo_airtel')).toBe(flutterwave);
  });

  it('keeps the pay page order whatever order the routes are given in', () => {
    expect(routePayments({ momo_airtel: flutterwave, momo_mtn: mtn }).methods).toEqual(['momo_mtn', 'momo_airtel']);
    expect(routePayments({ card: cards, momo_airtel: flutterwave, momo_mtn: mtn }).methods).toEqual(['momo_mtn', 'momo_airtel', 'card']);
  });

  it('offers card through its own provider, alone or beside MoMo', () => {
    const routing = routePayments({ card: cards, momo_mtn: mtn });
    expect(routing.methods).toEqual(['momo_mtn', 'card']);
    expect(routing.providerFor('card')).toBe(cards);
    expect(routePayments({ card: cards }).methods).toEqual(['card']);
  });

  it('drops card when its provider is not configured (no v3 keys)', () => {
    const routing = routePayments({ card: stubProvider({ id: 'flutterwave_checkout', methods: ['card'], configured: false, browserCheckout }), momo_mtn: mtn });
    expect(routing.methods).toEqual(['momo_mtn']);
    expect(routing.providerFor('card')).toBeUndefined();
  });

  it('drops a route whose provider is not configured: it is never offered', () => {
    const routing = routePayments({ momo_mtn: stubProvider({ methods: ['momo_mtn'], configured: false }), momo_airtel: flutterwave });
    expect(routing.methods).toEqual(['momo_airtel']);
    expect(routing.providerFor('momo_mtn')).toBeUndefined();
  });

  it('offers nothing when no provider is configured', () => {
    const routing = routePayments({
      momo_mtn: stubProvider({ methods: ['momo_mtn'], configured: false }),
      momo_airtel: stubProvider({ id: 'flutterwave', methods: ['momo_airtel'], configured: false }),
    });
    expect(routing.methods).toEqual([]);
    expect(requestProvider(routing)).toBeUndefined();
  });

  it('drops a route to a provider that does not collect that method', () => {
    const routing = routePayments({ momo_airtel: mtn });
    expect(routing.methods).toEqual([]);
    expect(routing.providerFor('momo_airtel')).toBeUndefined();
  });

  it('never offers card through a provider that does not collect it (MoMo providers)', () => {
    const routing = routePayments({ card: flutterwave, momo_mtn: mtn });
    expect(routing.methods).toEqual(['momo_mtn']);
    expect(routing.providerFor('card')).toBeUndefined();
    expect(routePayments({ card: mtn }).methods).toEqual([]);
  });

  it('never offers card through a provider with no browser checkout, even one that lists it', () => {
    const claims = stubProvider({ id: 'flutterwave', methods: ['momo_mtn', 'momo_airtel', 'card'] });
    expect(routePayments({ card: claims, momo_mtn: mtn }).methods).toEqual(['momo_mtn']);
    expect(routePayments({ card: stubProvider({ id: 'flutterwave_checkout', methods: ['card'] }) }).methods).toEqual([]);
  });

  it('finds no provider for anything that is not an offered method', () => {
    const routing = routePayments({ momo_mtn: mtn, momo_airtel: flutterwave });
    for (const method of ['', 'card', 'CARD', 'card ', 'MOMO_MTN', 'momo_mtn ', 'paypal', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect(routing.providerFor(method), method).toBeUndefined();
    }
  });

  it('cannot be changed after it is built', () => {
    const routing = routePayments({ momo_mtn: mtn });
    expect(Object.isFrozen(routing.methods)).toBe(true);
  });
});

describe('requestProvider', () => {
  const mtn = stubProvider({ id: 'mtn_momo_direct', methods: ['momo_mtn'] });
  const flutterwave = stubProvider({ id: 'flutterwave', methods: ['momo_mtn', 'momo_airtel'] });

  it('is the provider of the first method on offer', () => {
    expect(requestProvider(routePayments({ momo_mtn: mtn, momo_airtel: flutterwave }))).toBe(mtn);
    expect(requestProvider(routePayments({ momo_airtel: flutterwave }))).toBe(flutterwave);
    expect(requestProvider(routePayments({ momo_mtn: flutterwave, momo_airtel: flutterwave }))).toBe(flutterwave);
  });

  it('is none when nothing is on offer', () => {
    expect(requestProvider(routePayments({}))).toBeUndefined();
  });

  it('is the card provider only when card is all there is', () => {
    const cards = stubProvider({ id: 'flutterwave_checkout', methods: ['card'], browserCheckout });
    expect(requestProvider(routePayments({ card: cards, momo_airtel: flutterwave }))).toBe(flutterwave);
    expect(requestProvider(routePayments({ card: cards }))).toBe(cards);
  });
});
