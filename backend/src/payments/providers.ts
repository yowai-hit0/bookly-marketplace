import type { Env } from '../env.js';
import { FlutterwaveProvider } from './flutterwave.js';
import { MtnMomoProvider } from './mtn-momo.js';
import type { PaymentProvider, PaymentProviderId } from './provider.js';

/**
 * The providers for this deployment (spec §4.3, §6.18): every one whose
 * callbacks must still be accepted, and the one `PAYMENT_PROVIDER` names for
 * new payments. MTN stays constructed after a cutover so its in-flight payments
 * still settle, and `PAYMENT_PROVIDER=mtn_momo_direct` is a one-variable
 * rollback. Flutterwave is constructed whenever it is active or configured, so
 * its payments still settle after such a rollback too.
 */
export type PaymentProviders = {
  active: PaymentProvider;
  all: Partial<Record<PaymentProviderId, PaymentProvider>>;
};

export function createPaymentProviders(
  env: Pick<
    Env,
    | 'NODE_ENV'
    | 'PORT'
    | 'API_ORIGIN'
    | 'SESSION_SECRET'
    | 'PAYMENT_PROVIDER'
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

  if (env.PAYMENT_PROVIDER === 'flutterwave') {
    return { active: flutterwave, all: { mtn_momo_direct: mtn, flutterwave } };
  }
  return { active: mtn, all: flutterwave.configured ? { mtn_momo_direct: mtn, flutterwave } : { mtn_momo_direct: mtn } };
}
