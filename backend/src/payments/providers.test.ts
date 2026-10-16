import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../env.js';
import { FlutterwaveProvider } from './flutterwave.js';
import { MtnMomoProvider } from './mtn-momo.js';
import { createPaymentProviders } from './providers.js';

/**
 * Which providers a deployment runs (plan.md Tasks 16 and 25; spec §4.3,
 * §6.18, §6.19), from the parsed environment. No database. The global `fetch`
 * is stubbed to watch what the MTN provider would send.
 *
 * What is proven: with `PAYMENT_PROVIDER=mtn_momo_direct` MTN is both the
 * active provider and the only one whose callbacks are accepted, and it offers
 * MTN MoMo alone; it is configured only with all three credentials; callbacks
 * point at `API_ORIGIN`, or localhost on `PORT` without one; the sandbox is
 * charged in EUR and production in RWF unless a currency is set. With
 * `PAYMENT_PROVIDER=flutterwave`, Flutterwave takes new payments -- MTN MoMo and
 * Airtel Money -- while MTN stays mounted for its in-flight payments; after a
 * rollback to MTN, a configured Flutterwave still accepts its callbacks.
 */

const BASE = {
  DATABASE_URL: 'postgresql://bookly:bookly@localhost:5432/bookly',
  WEB_ORIGIN: 'http://localhost:5173',
  SESSION_SECRET: 'providers-test-secret-at-least-32-characters',
};
const CREDENTIALS = { MTN_MOMO_SUBSCRIPTION_KEY: 'sub', MTN_MOMO_API_USER: 'user', MTN_MOMO_API_KEY: 'key' };
const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The requests the provider sends to MTN, through a stubbed global fetch. */
function watchFetch() {
  const sent: { url: string; headers: Headers; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      sent.push({ url: input, headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (input.endsWith('/collection/token/')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      }
      return new Response(null, { status: 202 });
    }),
  );
  return sent;
}

async function initiateWith(env: Record<string, string>) {
  const sent = watchFetch();
  const { active } = createPaymentProviders(parseEnv({ ...BASE, ...CREDENTIALS, ...env }));
  await active.initiate(
    { ourRef: OUR_REF, amountRwf: 16_000, method: 'momo_mtn', payerPhone: '+250788123456', kind: 'booking_fee', bookingReference: 'BKY-2610-7K3QX' },
    new AbortController().signal,
  );
  return sent;
}

describe('createPaymentProviders with PAYMENT_PROVIDER=mtn_momo_direct', () => {
  it('makes MTN the active provider and the only one accepting callbacks', () => {
    const providers = createPaymentProviders(parseEnv(BASE));

    expect(providers.active).toBeInstanceOf(MtnMomoProvider);
    expect(providers.active.id).toBe('mtn_momo_direct');
    expect(Object.keys(providers.all)).toEqual(['mtn_momo_direct']);
    expect(providers.all.mtn_momo_direct).toBe(providers.active);
  });

  it('offers MTN MoMo and nothing else', () => {
    expect([...createPaymentProviders(parseEnv(BASE)).active.methods]).toEqual(['momo_mtn']);
  });

  it('is configured only with all three credentials', () => {
    expect(createPaymentProviders(parseEnv(BASE)).active.configured).toBe(false);
    expect(createPaymentProviders(parseEnv({ ...BASE, MTN_MOMO_SUBSCRIPTION_KEY: 's', MTN_MOMO_API_USER: 'u' })).active.configured).toBe(false);
    expect(createPaymentProviders(parseEnv({ ...BASE, ...CREDENTIALS })).active.configured).toBe(true);
  });

  it('points callbacks at API_ORIGIN', () => {
    const provider = createPaymentProviders(parseEnv({ ...BASE, API_ORIGIN: 'https://api.bookly.example' })).active as MtnMomoProvider;
    expect(provider.callbackUrl(OUR_REF)).toMatch(new RegExp(`^https://api\\.bookly\\.example/api/webhooks/mtn-momo/${OUR_REF}/[A-Za-z0-9_-]{43}$`));
  });

  it('points callbacks at localhost on PORT without API_ORIGIN', () => {
    const provider = createPaymentProviders(parseEnv({ ...BASE, PORT: '4123' })).active as MtnMomoProvider;
    expect(provider.callbackUrl(OUR_REF)).toMatch(new RegExp(`^http://localhost:4123/api/webhooks/mtn-momo/${OUR_REF}/`));
  });

  it('signs callbacks with a key derived from SESSION_SECRET', () => {
    const a = createPaymentProviders(parseEnv(BASE)).active as MtnMomoProvider;
    const b = createPaymentProviders(parseEnv({ ...BASE, SESSION_SECRET: `${BASE.SESSION_SECRET}-rotated` })).active as MtnMomoProvider;
    expect(a.callbackUrl(OUR_REF)).not.toBe(b.callbackUrl(OUR_REF));
  });

  it('calls the sandbox by default, charging EUR in the sandbox environment', async () => {
    const sent = await initiateWith({});
    expect(sent.map((request) => request.url)).toEqual([
      'https://sandbox.momodeveloper.mtn.com/collection/token/',
      'https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay',
    ]);
    expect(sent[1]?.headers.get('x-target-environment')).toBe('sandbox');
    expect(sent[1]?.body).toMatchObject({ currency: 'EUR', amount: '16000' });
  });

  it('charges RWF outside the sandbox, at the configured base URL and environment', async () => {
    const sent = await initiateWith({ MTN_MOMO_BASE_URL: 'https://proxy.momoapi.mtn.co.rw', MTN_MOMO_TARGET_ENVIRONMENT: 'mtnrwanda' });
    expect(sent[1]?.url).toBe('https://proxy.momoapi.mtn.co.rw/collection/v1_0/requesttopay');
    expect(sent[1]?.headers.get('x-target-environment')).toBe('mtnrwanda');
    expect(sent[1]?.body).toMatchObject({ currency: 'RWF' });
  });

  it('charges MTN_MOMO_CURRENCY when it is set', async () => {
    const sent = await initiateWith({ MTN_MOMO_CURRENCY: 'XAF' });
    expect(sent[1]?.body).toMatchObject({ currency: 'XAF' });
  });

  it('sends the configured credentials', async () => {
    const sent = await initiateWith({});
    expect(sent[0]?.headers.get('authorization')).toBe(`Basic ${Buffer.from('user:key').toString('base64')}`);
    expect(sent[0]?.headers.get('ocp-apim-subscription-key')).toBe('sub');
    expect(sent[1]?.headers.get('ocp-apim-subscription-key')).toBe('sub');
  });
});

const FLUTTERWAVE = {
  FLUTTERWAVE_CLIENT_ID: 'fw-client',
  FLUTTERWAVE_CLIENT_SECRET: 'fw-secret',
  FLUTTERWAVE_WEBHOOK_HASH: 'fw-hash',
  FLUTTERWAVE_BASE_URL: 'https://flutterwave.test',
  FLUTTERWAVE_IDP_URL: 'https://idp.flutterwave.test/token',
};

describe('createPaymentProviders with PAYMENT_PROVIDER=flutterwave', () => {
  it('makes Flutterwave the active provider, keeping MTN for its in-flight callbacks', () => {
    const providers = createPaymentProviders(parseEnv({ ...BASE, ...FLUTTERWAVE, PAYMENT_PROVIDER: 'flutterwave' }));

    expect(providers.active).toBeInstanceOf(FlutterwaveProvider);
    expect(providers.active.id).toBe('flutterwave');
    expect(providers.all.flutterwave).toBe(providers.active);
    expect(providers.all.mtn_momo_direct).toBeInstanceOf(MtnMomoProvider);
  });

  it('offers MTN MoMo and Airtel Money, and no card', () => {
    const { active } = createPaymentProviders(parseEnv({ ...BASE, ...FLUTTERWAVE, PAYMENT_PROVIDER: 'flutterwave' }));
    expect([...active.methods]).toEqual(['momo_mtn', 'momo_airtel']);
  });

  it('is configured only with both client credentials', () => {
    expect(createPaymentProviders(parseEnv({ ...BASE, PAYMENT_PROVIDER: 'flutterwave' })).active.configured).toBe(false);
    expect(createPaymentProviders(parseEnv({ ...BASE, PAYMENT_PROVIDER: 'flutterwave', FLUTTERWAVE_CLIENT_ID: 'id' })).active.configured).toBe(false);
    expect(createPaymentProviders(parseEnv({ ...BASE, ...FLUTTERWAVE, PAYMENT_PROVIDER: 'flutterwave' })).active.configured).toBe(true);
  });

  it('calls the configured token endpoint and base URL, in the configured currency', async () => {
    const sent: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        sent.push({ url: input, body: init?.body });
        if (input === FLUTTERWAVE.FLUTTERWAVE_IDP_URL) return new Response(JSON.stringify({ access_token: 't', expires_in: 600 }));
        if (input.endsWith('/charges')) return new Response(JSON.stringify({ data: { id: 'chg_1', status: 'pending' } }), { status: 201 });
        return new Response(JSON.stringify({ data: { id: 'x_1' } }), { status: 201 });
      }),
    );
    const { active } = createPaymentProviders(parseEnv({ ...BASE, ...FLUTTERWAVE, PAYMENT_PROVIDER: 'flutterwave', FLUTTERWAVE_CURRENCY: 'RWF' }));
    const result = await active.initiate(
      { ourRef: OUR_REF, amountRwf: 16_000, method: 'momo_airtel', payerPhone: '+250731234567', kind: 'booking_fee', bookingReference: 'BKY-2610-7K3QX' },
      new AbortController().signal,
    );

    expect(result).toStrictEqual({ outcome: 'accepted', providerRef: 'chg_1' });
    expect(sent.map((request) => request.url)).toEqual([
      'https://idp.flutterwave.test/token',
      'https://flutterwave.test/customers',
      'https://flutterwave.test/payment-methods',
      'https://flutterwave.test/charges',
    ]);
    expect(String(sent[0]?.body)).toContain('client_id=fw-client');
    expect(JSON.parse(String(sent[3]?.body))).toMatchObject({ currency: 'RWF', amount: 16_000, reference: OUR_REF });
  });
});

describe('createPaymentProviders after a rollback to PAYMENT_PROVIDER=mtn_momo_direct', () => {
  it('keeps a configured Flutterwave accepting callbacks for the payments it still has in flight', () => {
    const providers = createPaymentProviders(parseEnv({ ...BASE, ...FLUTTERWAVE }));
    expect(providers.active).toBeInstanceOf(MtnMomoProvider);
    expect(providers.all.flutterwave).toBeInstanceOf(FlutterwaveProvider);
  });
});
