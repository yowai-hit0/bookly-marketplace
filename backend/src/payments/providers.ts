import type { Env } from '../env.js';
import { FlutterwaveProvider } from './flutterwave.js';
import { FlutterwaveCheckoutProvider } from './flutterwave-checkout.js';
import { MtnMomoProvider } from './mtn-momo.js';
import type { PaymentMethod, PaymentProvider, PaymentProviderId } from './provider.js';
import { OFFERABLE_METHODS, type PaymentRouting, routePayments, routedProviderId } from './routing.js';

/**
 * The providers for this deployment (marketplace-spec.md R3.1; spec §4.3,
 * §6.18), from the parsed environment:
 *
 *  - `routing`: which methods are offered and who collects each. MTN MoMo goes
 *    where `MOMO_MTN_PROVIDER` says, Airtel Money always to Flutterwave, cards
 *    always to Flutterwave v3 Inline (`flutterwave_checkout`, 2026-10-30),
 *    `PAYMENT_METHODS_ENABLED` may narrow the list, and a method whose provider
 *    is unconfigured is not offered (payments/routing.ts).
 *  - `all`: every provider whose callbacks must still be accepted and whose
 *    waiting payments the reconciler must still look up. MTN direct stays
 *    constructed after a cutover to Flutterwave, so its in-flight payments still
 *    settle and `MOMO_MTN_PROVIDER=mtn_momo_direct` is a one-variable rollback.
 *    Flutterwave is constructed whenever it collects a method or is configured,
 *    so its payments still settle after such a rollback too. The card provider
 *    is there whenever its keys are set, whether or not `card` is enabled, so
 *    card payments in flight still settle after card is switched off.
 */
export type PaymentProviders = {
  routing: PaymentRouting;
  all: Partial<Record<PaymentProviderId, PaymentProvider>>;
};

export function createPaymentProviders(
  env: Pick<
    Env,
    | 'NODE_ENV'
    | 'PORT'
    | 'API_ORIGIN'
    | 'SESSION_SECRET'
    | 'MOMO_MTN_PROVIDER'
    | 'PAYMENT_METHODS_ENABLED'
    | 'MTN_MOMO_BASE_URL'
    | 'MTN_MOMO_TARGET_ENVIRONMENT'
    | 'MTN_MOMO_SUBSCRIPTION_KEY'
    | 'MTN_MOMO_API_USER'
    | 'MTN_MOMO_API_KEY'
    | 'MTN_MOMO_CURRENCY'
    | 'FLUTTERWAVE_BASE_URL'
    | 'FLUTTERWAVE_IDP_URL'
    | 'FLUTTERWAVE_CLIENT_ID'
    | 'FLUTTERWAVE_CLIENT_SECRET'
    | 'FLUTTERWAVE_WEBHOOK_HASH'
    | 'FLUTTERWAVE_CURRENCY'
    | 'FLUTTERWAVE_V3_BASE_URL'
    | 'FLUTTERWAVE_V3_SECRET_KEY'
    | 'FLUTTERWAVE_V3_PUBLIC_KEY'
    | 'FLUTTERWAVE_V3_WEBHOOK_HASH'
    | 'WEB_ORIGIN'
  >,
): PaymentProviders {
  const mtn = new MtnMomoProvider({
    baseUrl: env.MTN_MOMO_BASE_URL,
    targetEnvironment: env.MTN_MOMO_TARGET_ENVIRONMENT,
    currency: env.MTN_MOMO_CURRENCY ?? (env.MTN_MOMO_TARGET_ENVIRONMENT === 'sandbox' ? 'EUR' : 'RWF'),
    subscriptionKey: env.MTN_MOMO_SUBSCRIPTION_KEY,
    apiUser: env.MTN_MOMO_API_USER,
    apiKey: env.MTN_MOMO_API_KEY,
    callbackOrigin: env.API_ORIGIN ?? `http://localhost:${env.PORT}`,
    secret: env.SESSION_SECRET,
  });

  const flutterwave = new FlutterwaveProvider({
    baseUrl: env.FLUTTERWAVE_BASE_URL,
    tokenUrl: env.FLUTTERWAVE_IDP_URL,
    clientId: env.FLUTTERWAVE_CLIENT_ID,
    clientSecret: env.FLUTTERWAVE_CLIENT_SECRET,
    webhookHash: env.FLUTTERWAVE_WEBHOOK_HASH,
    currency: env.FLUTTERWAVE_CURRENCY,
  });

  const cards = new FlutterwaveCheckoutProvider({
    baseUrl: env.FLUTTERWAVE_V3_BASE_URL,
    secretKey: env.FLUTTERWAVE_V3_SECRET_KEY,
    publicKey: env.FLUTTERWAVE_V3_PUBLIC_KEY,
    webhookHash: env.FLUTTERWAVE_V3_WEBHOOK_HASH,
    webOrigin: env.WEB_ORIGIN,
  });

  const byId: Record<PaymentProviderId, PaymentProvider> = { mtn_momo_direct: mtn, flutterwave, flutterwave_checkout: cards };
  const enabled = env.PAYMENT_METHODS_ENABLED ?? OFFERABLE_METHODS;
  const routes: Partial<Record<PaymentMethod, PaymentProvider>> = {};
  for (const method of enabled) routes[method] = byId[routedProviderId(method, env.MOMO_MTN_PROVIDER)];

  const flutterwaveRouted = Object.values(routes).includes(flutterwave);
  return {
    routing: routePayments(routes),
    all: {
      mtn_momo_direct: mtn,
      ...(flutterwaveRouted || flutterwave.configured ? { flutterwave } : {}),
      // Without its keys it could neither verify a webhook nor look anything up.
      ...(cards.configured ? { flutterwave_checkout: cards } : {}),
    },
  };
}
