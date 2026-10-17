import { describe, expect, it } from 'vitest';
import { stubProvider } from '../test/payment-fixtures.js';
import { OFFERABLE_METHODS, requestProvider, routePayments, routedProviderId } from './routing.js';

/**
 * The method routing on its own (marketplace-spec.md R3.1, decided
 * 2026-10-17). No database, no environment.
 *
 * What is proven: MTN MoMo goes where `MOMO_MTN_PROVIDER` says and Airtel Money
 * always to Flutterwave; a route survives only when its provider is configured
 * and collects that method; card is never offered; methods keep the pay page's
 * order; anything that is not an offered method finds no provider; and a
 * session-fee request is recorded against the first method's provider, or none
 * when nothing is on offer.
 */

describe('routedProviderId', () => {
  it('sends MTN MoMo where MOMO_MTN_PROVIDER says, and Airtel Money always to Flutterwave', () => {
    expect(routedProviderId('momo_mtn', 'mtn_momo_direct')).toBe('mtn_momo_direct');
    expect(routedProviderId('momo_mtn', 'flutterwave')).toBe('flutterwave');
    expect(routedProviderId('momo_airtel', 'mtn_momo_direct')).toBe('flutterwave');
    expect(routedProviderId('momo_airtel', 'flutterwave')).toBe('flutterwave');
  });

  it('knows no card: it is deferred (R3.2)', () => {
    expect(OFFERABLE_METHODS).toEqual(['momo_mtn', 'momo_airtel']);
  });
});

describe('routePayments', () => {
  const mtn = stubProvider({ id: 'mtn_momo_direct', methods: ['momo_mtn'] });
  const flutterwave = stubProvider({ id: 'flutterwave', methods: ['momo_mtn', 'momo_airtel', 'card'] });

  it('offers each routed method, mapped to its own provider', () => {
    const routing = routePayments({ momo_mtn: mtn, momo_airtel: flutterwave });
    expect(routing.methods).toEqual(['momo_mtn', 'momo_airtel']);
    expect(routing.providerFor('momo_mtn')).toBe(mtn);
    expect(routing.providerFor('momo_airtel')).toBe(flutterwave);
  });

  it('keeps the pay page order whatever order the routes are given in', () => {
    expect(routePayments({ momo_airtel: flutterwave, momo_mtn: mtn }).methods).toEqual(['momo_mtn', 'momo_airtel']);
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

  it('never offers card, even routed to a provider that claims it', () => {
    const routing = routePayments({ card: flutterwave, momo_mtn: mtn });
    expect(routing.methods).toEqual(['momo_mtn']);
    expect(routing.providerFor('card')).toBeUndefined();
  });

  it('finds no provider for anything that is not an offered method', () => {
    const routing = routePayments({ momo_mtn: mtn, momo_airtel: flutterwave });
    for (const method of ['', 'card', 'MOMO_MTN', 'momo_mtn ', 'paypal', '__proto__', 'constructor', 'hasOwnProperty']) {
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
});
