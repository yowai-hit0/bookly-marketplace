import { PAYMENT_METHODS, type PaymentMethod, type PaymentProvider, type PaymentProviderId } from './provider.js';

/**
 * Which methods a client may choose, and which provider collects each one
 * (marketplace-spec.md R3.1, decided 2026-10-17). This replaces the single
 * deployment-wide `PAYMENT_PROVIDER`: the provider of a payment now follows the
 * method the client picked, so MTN MoMo can go through MTN direct while Airtel
 * Money goes through Flutterwave on the same deployment.
 *
 *   momo_mtn     MOMO_MTN_PROVIDER: mtn_momo_direct (the default) or flutterwave
 *   momo_airtel  always flutterwave: MTN direct collects MTN MoMo and nothing else
 *   card         deferred with the hosted checkout (R3.2, deferred 2026-10-17)
 *
 * `PAYMENT_METHODS_ENABLED` may narrow the list. A method is offered only when
 * the provider it routes to is configured: an unconfigured provider is never
 * offered, so the pay page never shows a choice that can only fail. Pure: the
 * environment check (`env.ts`) and the provider wiring (`providers.ts`) share
 * it, so they can never disagree about where a method goes.
 */

/** The methods a deployment can offer today, in the order the pay page lists them. `card` is not among them. */
export const OFFERABLE_METHODS = ['momo_mtn', 'momo_airtel'] as const satisfies readonly PaymentMethod[];
export type OfferableMethod = (typeof OFFERABLE_METHODS)[number];

/** `MOMO_MTN_PROVIDER`: who collects MTN MoMo. */
export const MOMO_MTN_PROVIDERS = ['mtn_momo_direct', 'flutterwave'] as const satisfies readonly PaymentProviderId[];
export type MomoMtnProvider = (typeof MOMO_MTN_PROVIDERS)[number];

/** The provider a method goes to (R3.1). */
export function routedProviderId(method: OfferableMethod, momoMtnProvider: MomoMtnProvider): PaymentProviderId {
  return method === 'momo_mtn' ? momoMtnProvider : 'flutterwave';
}

/** The methods on offer and who collects each. Built once at startup; never changes while the process runs. */
export type PaymentRouting = {
  /** What `GET /api/payment-methods` lists and the pay routes accept, in display order. */
  readonly methods: readonly PaymentMethod[];
  /** The provider that collects `method`, or undefined when it is not on offer. */
  providerFor(method: string): PaymentProvider | undefined;
};

/**
 * The routing for a set of routes, keeping only what can really be collected:
 * a route whose provider is unconfigured, or does not collect that method, is
 * dropped, and so is `card` until it has a provider of its own. Methods keep the
 * vocabulary's order (`momo_mtn`, `momo_airtel`) whatever order they are given in.
 */
export function routePayments(routes: Partial<Record<PaymentMethod, PaymentProvider>>): PaymentRouting {
  const offered = new Map<PaymentMethod, PaymentProvider>();
  for (const method of PAYMENT_METHODS) {
    const provider = routes[method];
    if (provider === undefined || !provider.configured || !provider.methods.includes(method)) continue;
    if (!(OFFERABLE_METHODS as readonly PaymentMethod[]).includes(method)) continue;
    offered.set(method, provider);
  }
  const methods = Object.freeze([...offered.keys()]);
  return {
    methods,
    providerFor: (method) => offered.get(method as PaymentMethod),
  };
}

/**
 * The provider a photographer's session-fee request is recorded against
 * (payments/session-fee.ts): the one behind the first method on offer. The
 * request is only an ask -- no provider is called -- and the client's own
 * choice re-routes it when they pay (payments/initiate.ts). Undefined when
 * nothing is on offer: a request nobody could pay is not worth sending.
 */
export function requestProvider(routing: PaymentRouting): PaymentProvider | undefined {
  const first = routing.methods[0];
  return first === undefined ? undefined : routing.providerFor(first);
}
