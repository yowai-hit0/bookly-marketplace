import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../env.js';
import { FlutterwaveProvider } from './flutterwave.js';
import { FlutterwaveCheckoutProvider } from './flutterwave-checkout.js';
import { MtnMomoProvider } from './mtn-momo.js';
import { createPaymentProviders } from './providers.js';
import {
  RECONCILE_MIN_AGE_SECONDS,
  RECONCILE_SCHEDULE,
  SANDBOX_RECONCILE_MIN_AGE_SECONDS,
  SANDBOX_RECONCILE_SCHEDULE,
  reconcilerPlans,
} from './reconcile.js';

/**
 * Which providers a deployment runs and where each method goes
 * (marketplace-spec.md R3.1, R3.5, decided 2026-10-17; spec §4.3, §6.18), from
 * the parsed environment. No database. The global `fetch` is stubbed to watch
 * what a provider would send.
 *
 * What is proven:
 *  - MTN MoMo goes to MTN direct by default and to Flutterwave with
 *    `MOMO_MTN_PROVIDER=flutterwave`; Airtel Money always goes to Flutterwave;
 *    card always goes to Flutterwave v3 Inline (`flutterwave_checkout`), offered
 *    only with its three keys, constructed (for its webhook and reconciler)
 *    whenever they are set, card enabled or not (2026-10-30).
 *  - A method is offered only when its routed provider is configured (all three
 *    MTN credentials, both Flutterwave client credentials), so no credentials
 *    at all is nothing on offer; `PAYMENT_METHODS_ENABLED` narrows the list and
 *    never widens it past what is configured.
 *  - MTN direct stays constructed whatever the routing, for its in-flight
 *    payments; Flutterwave is constructed while it collects a method or is
 *    configured, so a rollback still settles its payments.
 *  - One reconciler per configured provider, a provider routed away from
 *    included (R3.5); the MTN sandbox's on the fast schedule.
 *  - MTN callbacks point at `API_ORIGIN` (or localhost on `PORT`), signed from
 *    `SESSION_SECRET`; the sandbox charges EUR, production RWF unless set; each
 *    provider reports the currency it charges in.
 */

const BASE = {
  DATABASE_URL: 'postgresql://bookly:bookly@localhost:5432/bookly',
  WEB_ORIGIN: 'http://localhost:5173',
  SESSION_SECRET: 'providers-test-secret-at-least-32-characters',
};
const MTN = { MTN_MOMO_SUBSCRIPTION_KEY: 'sub', MTN_MOMO_API_USER: 'user', MTN_MOMO_API_KEY: 'key' };
const FLUTTERWAVE = {
  FLUTTERWAVE_CLIENT_ID: 'fw-client',
  FLUTTERWAVE_CLIENT_SECRET: 'fw-secret',
  FLUTTERWAVE_WEBHOOK_HASH: 'fw-hash',
  FLUTTERWAVE_BASE_URL: 'https://flutterwave.test',
  FLUTTERWAVE_IDP_URL: 'https://idp.flutterwave.test/token',
};
/** Placeholder sandbox-shaped keys, never real ones. */
const CARDS = {
  FLUTTERWAVE_V3_SECRET_KEY: 'FLWSECK_TEST-placeholder-secret-X',
  FLUTTERWAVE_V3_PUBLIC_KEY: 'FLWPUBK_TEST-placeholder-public-X',
  FLUTTERWAVE_V3_WEBHOOK_HASH: 'placeholder-hash',
  FLUTTERWAVE_V3_BASE_URL: 'https://flutterwave-v3.test',
};
const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8';

afterEach(() => {
  vi.unstubAllGlobals();
});

function providers(env: Record<string, string> = {}) {
  return createPaymentProviders(parseEnv({ ...BASE, ...env }));
}

/** Who collects each method, as ids; absent when the method is not offered. */
function routes(env: Record<string, string>) {
  const { routing } = providers(env);
  return {
    methods: [...routing.methods],
    momo_mtn: routing.providerFor('momo_mtn')?.id,
    momo_airtel: routing.providerFor('momo_airtel')?.id,
    card: routing.providerFor('card')?.id,
  };
}

/** The requests the MTN provider sends, through a stubbed global fetch. */
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

async function initiateMtnWith(env: Record<string, string>) {
  const sent = watchFetch();
  const provider = providers({ ...MTN, ...env }).routing.providerFor('momo_mtn');
  if (provider === undefined) throw new Error('momo_mtn is not on offer');
  await provider.initiate(
    { ourRef: OUR_REF, amountRwf: 16_000, method: 'momo_mtn', payerPhone: '+250788123456', kind: 'booking_fee', bookingReference: 'BKY-2610-7K3QX' },
    new AbortController().signal,
  );
  return sent;
}

function mtnOf(env: Record<string, string> = {}): MtnMomoProvider {
  const mtn = providers(env).all.mtn_momo_direct;
  if (!(mtn instanceof MtnMomoProvider)) throw new Error('MTN direct is not constructed');
  return mtn;
}

// --- Routing (R3.1) ---------------------------------------------------------------------------

describe('where each method goes (R3.1)', () => {
  it('sends MTN MoMo to MTN direct and Airtel Money to Flutterwave by default, offering both when both are configured', () => {
    expect(routes({ ...MTN, ...FLUTTERWAVE })).toStrictEqual({
      methods: ['momo_mtn', 'momo_airtel'],
      momo_mtn: 'mtn_momo_direct',
      momo_airtel: 'flutterwave',
      card: undefined,
    });
  });

  it('routes the method to the provider object that collects it', () => {
    const { routing, all } = providers({ ...MTN, ...FLUTTERWAVE });
    expect(routing.providerFor('momo_mtn')).toBeInstanceOf(MtnMomoProvider);
    expect(routing.providerFor('momo_mtn')).toBe(all.mtn_momo_direct);
    expect(routing.providerFor('momo_airtel')).toBeInstanceOf(FlutterwaveProvider);
    expect(routing.providerFor('momo_airtel')).toBe(all.flutterwave);
  });

  it('sends both MoMo methods to Flutterwave with MOMO_MTN_PROVIDER=flutterwave, needing no MTN credentials', () => {
    expect(routes({ ...FLUTTERWAVE, MOMO_MTN_PROVIDER: 'flutterwave' })).toStrictEqual({
      methods: ['momo_mtn', 'momo_airtel'],
      momo_mtn: 'flutterwave',
      momo_airtel: 'flutterwave',
      card: undefined,
    });
  });

  it('ignores MTN credentials for routing once MTN MoMo goes to Flutterwave', () => {
    expect(routes({ ...MTN, ...FLUTTERWAVE, MOMO_MTN_PROVIDER: 'flutterwave' }).momo_mtn).toBe('flutterwave');
  });

  it('never sends Airtel Money to MTN direct, whatever is configured', () => {
    for (const env of [{ ...MTN }, { ...MTN, MOMO_MTN_PROVIDER: 'mtn_momo_direct' }, { ...MTN, PAYMENT_METHODS_ENABLED: 'momo_airtel' }]) {
      expect(routes(env).momo_airtel).toBeUndefined();
    }
  });

  it('never offers card without the v3 keys, whatever else is configured', () => {
    for (const env of [{}, { ...MTN }, { ...FLUTTERWAVE }, { ...MTN, ...FLUTTERWAVE }, { ...FLUTTERWAVE, MOMO_MTN_PROVIDER: 'flutterwave' }]) {
      const { routing } = providers(env);
      expect(routing.methods).not.toContain('card');
      expect(routing.providerFor('card')).toBeUndefined();
    }
  });

  it('offers card, last, through Flutterwave v3 Inline once its keys are set', () => {
    expect(routes({ ...MTN, ...FLUTTERWAVE, ...CARDS })).toStrictEqual({
      methods: ['momo_mtn', 'momo_airtel', 'card'],
      momo_mtn: 'mtn_momo_direct',
      momo_airtel: 'flutterwave',
      card: 'flutterwave_checkout',
    });
    const { routing, all } = providers({ ...CARDS });
    expect(routing.methods).toEqual(['card']);
    expect(routing.providerFor('card')).toBeInstanceOf(FlutterwaveCheckoutProvider);
    expect(routing.providerFor('card')).toBe(all.flutterwave_checkout);
  });

  it('lets PAYMENT_METHODS_ENABLED keep card off, or offer it alone', () => {
    expect(routes({ ...MTN, ...CARDS, PAYMENT_METHODS_ENABLED: 'momo_mtn' }).methods).toEqual(['momo_mtn']);
    expect(routes({ ...MTN, ...CARDS, PAYMENT_METHODS_ENABLED: 'card' }).methods).toEqual(['card']);
  });

  it('answers no provider for a string that is no offered method', () => {
    const { routing } = providers({ ...MTN, ...FLUTTERWAVE });
    for (const method of ['', 'MOMO_MTN', 'momo', 'paypal', '__proto__', 'toString', 'momo_mtn ']) {
      expect(routing.providerFor(method)).toBeUndefined();
    }
  });
});

describe('only a configured provider is offered (R3.1)', () => {
  it('offers nothing with no credentials at all', () => {
    expect(routes({})).toStrictEqual({ methods: [], momo_mtn: undefined, momo_airtel: undefined, card: undefined });
  });

  it('offers MTN MoMo alone with only the MTN credentials', () => {
    expect(routes({ ...MTN })).toMatchObject({ methods: ['momo_mtn'], momo_mtn: 'mtn_momo_direct', momo_airtel: undefined });
  });

  it('offers Airtel Money alone with only the Flutterwave credentials and MTN MoMo left on MTN direct', () => {
    expect(routes({ ...FLUTTERWAVE })).toMatchObject({ methods: ['momo_airtel'], momo_mtn: undefined, momo_airtel: 'flutterwave' });
  });

  it('offers nothing when MTN MoMo goes to an unconfigured Flutterwave, even with MTN direct configured', () => {
    expect(routes({ ...MTN, MOMO_MTN_PROVIDER: 'flutterwave' }).methods).toEqual([]);
  });

  it.each([
    ['the subscription key alone', { MTN_MOMO_SUBSCRIPTION_KEY: 's' }],
    ['two of the three', { MTN_MOMO_SUBSCRIPTION_KEY: 's', MTN_MOMO_API_USER: 'u' }],
    ['the user and key without the subscription key', { MTN_MOMO_API_USER: 'u', MTN_MOMO_API_KEY: 'k' }],
  ])('does not offer MTN direct with %s', (_case, env) => {
    expect(routes(env).methods).toEqual([]);
    expect(providers(env).all.mtn_momo_direct?.configured).toBe(false);
  });

  it.each([
    ['the client id alone', { FLUTTERWAVE_CLIENT_ID: 'id' }],
    ['the client secret alone', { FLUTTERWAVE_CLIENT_SECRET: 'secret' }],
    ['only the webhook hash', { FLUTTERWAVE_WEBHOOK_HASH: 'hash' }],
  ])('does not offer Flutterwave with %s', (_case, env) => {
    expect(routes({ ...env, MOMO_MTN_PROVIDER: 'flutterwave' }).methods).toEqual([]);
  });

  it('offers Flutterwave on its client credentials alone, outside production', () => {
    expect(routes({ FLUTTERWAVE_CLIENT_ID: 'id', FLUTTERWAVE_CLIENT_SECRET: 'secret' }).methods).toEqual(['momo_airtel']);
  });
});

describe('PAYMENT_METHODS_ENABLED narrows the offer (R3.1)', () => {
  it('offers Airtel Money alone when it lists only momo_airtel', () => {
    expect(routes({ ...MTN, ...FLUTTERWAVE, PAYMENT_METHODS_ENABLED: 'momo_airtel' })).toMatchObject({
      methods: ['momo_airtel'],
      momo_mtn: undefined,
      momo_airtel: 'flutterwave',
    });
  });

  it('offers MTN MoMo alone when it lists only momo_mtn', () => {
    expect(routes({ ...MTN, ...FLUTTERWAVE, PAYMENT_METHODS_ENABLED: 'momo_mtn' })).toMatchObject({
      methods: ['momo_mtn'],
      momo_mtn: 'mtn_momo_direct',
      momo_airtel: undefined,
    });
  });

  it('keeps the pay page order whatever order it is written in, and drops repeats', () => {
    expect(routes({ ...MTN, ...FLUTTERWAVE, PAYMENT_METHODS_ENABLED: ' momo_airtel , momo_mtn,momo_airtel ' }).methods).toEqual(['momo_mtn', 'momo_airtel']);
  });

  it('never widens the offer past what is configured', () => {
    expect(routes({ ...MTN, PAYMENT_METHODS_ENABLED: 'momo_mtn,momo_airtel' }).methods).toEqual(['momo_mtn']);
    expect(routes({ PAYMENT_METHODS_ENABLED: 'momo_mtn,momo_airtel' }).methods).toEqual([]);
  });
});

// --- Who stays constructed (spec §6.18) -------------------------------------------------------

describe('providers kept for their in-flight payments (spec §6.18)', () => {
  it('always constructs MTN direct, even when no method goes to it', () => {
    for (const env of [{}, { ...FLUTTERWAVE, MOMO_MTN_PROVIDER: 'flutterwave' }, { ...MTN, ...FLUTTERWAVE, PAYMENT_METHODS_ENABLED: 'momo_airtel' }]) {
      expect(providers(env).all.mtn_momo_direct).toBeInstanceOf(MtnMomoProvider);
    }
  });

  it('constructs Flutterwave while it collects an enabled method, configured or not', () => {
    expect(providers({}).all.flutterwave).toBeInstanceOf(FlutterwaveProvider);
    expect(providers({ MOMO_MTN_PROVIDER: 'flutterwave', PAYMENT_METHODS_ENABLED: 'momo_mtn' }).all.flutterwave).toBeInstanceOf(FlutterwaveProvider);
  });

  it('keeps a configured Flutterwave after a rollback that routes nothing to it', () => {
    const { all, routing } = providers({ ...MTN, ...FLUTTERWAVE, PAYMENT_METHODS_ENABLED: 'momo_mtn' });
    expect(routing.methods).toEqual(['momo_mtn']);
    expect(all.flutterwave).toBeInstanceOf(FlutterwaveProvider);
  });

  it('constructs no Flutterwave that neither collects a method nor is configured', () => {
    expect(Object.keys(providers({ ...MTN, PAYMENT_METHODS_ENABLED: 'momo_mtn' }).all)).toEqual(['mtn_momo_direct']);
  });

  it('keeps the card provider while its keys are set, card enabled or not, and has none without them', () => {
    expect(providers({ ...MTN, ...CARDS, PAYMENT_METHODS_ENABLED: 'momo_mtn' }).all.flutterwave_checkout).toBeInstanceOf(FlutterwaveCheckoutProvider);
    expect(providers({ ...MTN }).all.flutterwave_checkout).toBeUndefined();
  });
});

describe('reconcilers (R3.5)', () => {
  const plans = (env: Record<string, string>, mtnSandbox = true) =>
    reconcilerPlans(providers(env).all, { mtnSandbox }).map((plan) => ({ id: plan.provider.id, schedule: plan.schedule, minAgeSeconds: plan.minAgeSeconds }));

  it('runs one per configured provider, MTN in the sandbox on the fast schedule', () => {
    expect(plans({ ...MTN, ...FLUTTERWAVE })).toStrictEqual([
      { id: 'mtn_momo_direct', schedule: SANDBOX_RECONCILE_SCHEDULE, minAgeSeconds: SANDBOX_RECONCILE_MIN_AGE_SECONDS },
      { id: 'flutterwave', schedule: RECONCILE_SCHEDULE, minAgeSeconds: RECONCILE_MIN_AGE_SECONDS },
    ]);
  });

  it('runs MTN on the minute outside the sandbox', () => {
    expect(plans({ ...MTN }, false)).toStrictEqual([{ id: 'mtn_momo_direct', schedule: RECONCILE_SCHEDULE, minAgeSeconds: RECONCILE_MIN_AGE_SECONDS }]);
  });

  it('keeps reconciling MTN direct after MTN MoMo moves to Flutterwave, so its waiting payments still settle', () => {
    expect(plans({ ...MTN, ...FLUTTERWAVE, MOMO_MTN_PROVIDER: 'flutterwave' }).map((plan) => plan.id)).toEqual(['mtn_momo_direct', 'flutterwave']);
  });

  it('keeps reconciling a configured Flutterwave that no method goes to', () => {
    expect(plans({ ...MTN, ...FLUTTERWAVE, PAYMENT_METHODS_ENABLED: 'momo_mtn' }).map((plan) => plan.id)).toEqual(['mtn_momo_direct', 'flutterwave']);
  });

  it('runs one on the minute for cards, enabled or not, while the keys are set', () => {
    expect(plans({ ...MTN, ...CARDS, PAYMENT_METHODS_ENABLED: 'momo_mtn' })).toContainEqual({
      id: 'flutterwave_checkout',
      schedule: RECONCILE_SCHEDULE,
      minAgeSeconds: RECONCILE_MIN_AGE_SECONDS,
    });
    expect(plans({ ...MTN }).map((plan) => plan.id)).not.toContain('flutterwave_checkout');
  });

  it('runs none for an unconfigured provider: there is nothing to ask with', () => {
    expect(plans({})).toEqual([]);
    expect(plans({ ...FLUTTERWAVE }).map((plan) => plan.id)).toEqual(['flutterwave']);
  });
});

// --- MTN direct -------------------------------------------------------------------------------

describe('MTN direct', () => {
  it('collects MTN MoMo and nothing else', () => {
    expect([...mtnOf().methods]).toEqual(['momo_mtn']);
  });

  it('is configured only with all three credentials', () => {
    expect(mtnOf().configured).toBe(false);
    expect(mtnOf({ MTN_MOMO_SUBSCRIPTION_KEY: 's', MTN_MOMO_API_USER: 'u' }).configured).toBe(false);
    expect(mtnOf(MTN).configured).toBe(true);
  });

  it('points callbacks at API_ORIGIN', () => {
    expect(mtnOf({ API_ORIGIN: 'https://api.bookly.example' }).callbackUrl(OUR_REF)).toMatch(
      new RegExp(`^https://api\\.bookly\\.example/api/webhooks/mtn-momo/${OUR_REF}/[A-Za-z0-9_-]{43}$`),
    );
  });

  it('points callbacks at localhost on PORT without API_ORIGIN', () => {
    expect(mtnOf({ PORT: '4123' }).callbackUrl(OUR_REF)).toMatch(new RegExp(`^http://localhost:4123/api/webhooks/mtn-momo/${OUR_REF}/`));
  });

  it('signs callbacks with a key derived from SESSION_SECRET', () => {
    expect(mtnOf().callbackUrl(OUR_REF)).not.toBe(mtnOf({ SESSION_SECRET: `${BASE.SESSION_SECRET}-rotated` }).callbackUrl(OUR_REF));
  });

  it('calls the sandbox by default, charging EUR in the sandbox environment', async () => {
    const sent = await initiateMtnWith({});
    expect(sent.map((request) => request.url)).toEqual([
      'https://sandbox.momodeveloper.mtn.com/collection/token/',
      'https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay',
    ]);
    expect(sent[1]?.headers.get('x-target-environment')).toBe('sandbox');
    expect(sent[1]?.body).toMatchObject({ currency: 'EUR', amount: '16000' });
  });

  it('charges RWF outside the sandbox, at the configured base URL and environment', async () => {
    const sent = await initiateMtnWith({ MTN_MOMO_BASE_URL: 'https://proxy.momoapi.mtn.co.rw', MTN_MOMO_TARGET_ENVIRONMENT: 'mtnrwanda' });
    expect(sent[1]?.url).toBe('https://proxy.momoapi.mtn.co.rw/collection/v1_0/requesttopay');
    expect(sent[1]?.headers.get('x-target-environment')).toBe('mtnrwanda');
    expect(sent[1]?.body).toMatchObject({ currency: 'RWF' });
  });

  it('charges MTN_MOMO_CURRENCY when it is set', async () => {
    const sent = await initiateMtnWith({ MTN_MOMO_CURRENCY: 'XAF' });
    expect(sent[1]?.body).toMatchObject({ currency: 'XAF' });
  });

  it('sends the configured credentials', async () => {
    const sent = await initiateMtnWith({});
    expect(sent[0]?.headers.get('authorization')).toBe(`Basic ${Buffer.from('user:key').toString('base64')}`);
    expect(sent[0]?.headers.get('ocp-apim-subscription-key')).toBe('sub');
    expect(sent[1]?.headers.get('ocp-apim-subscription-key')).toBe('sub');
  });

  it('reports the currency it charges in, which a webhook must match (T3.3)', () => {
    expect(mtnOf().currency).toBe('EUR');
    expect(mtnOf({ MTN_MOMO_TARGET_ENVIRONMENT: 'mtnrwanda' }).currency).toBe('RWF');
    expect(mtnOf({ MTN_MOMO_CURRENCY: 'XAF' }).currency).toBe('XAF');
  });
});

// --- Flutterwave v3 Inline (cards) -------------------------------------------------------------

describe('Flutterwave v3 Inline (cards, 2026-10-30)', () => {
  it('collects card and nothing else, in RWF', () => {
    const cards = providers(CARDS).all.flutterwave_checkout;
    expect([...(cards?.methods ?? [])]).toEqual(['card']);
    expect(cards?.currency).toBe('RWF');
    expect(cards?.configured).toBe(true);
  });

  it('builds its return URL on WEB_ORIGIN and hands the browser the public key only', () => {
    const cards = providers(CARDS).routing.providerFor('card');
    const config = cards?.browserCheckout?.({
      ourRef: OUR_REF,
      amountRwf: 20_000,
      sessionSeconds: 900,
      payer: { email: 'a@example.com', name: 'A', phone: null },
      title: 'Bookly booking fee BKY-2610-7K3QX',
      returnPath: `/payments/${OUR_REF}`,
    });
    expect(config?.redirect_url).toBe(`${BASE.WEB_ORIGIN}/payments/${OUR_REF}`);
    expect(config?.public_key).toBe(CARDS.FLUTTERWAVE_V3_PUBLIC_KEY);
    expect(JSON.stringify(config)).not.toContain(CARDS.FLUTTERWAVE_V3_SECRET_KEY);
    expect(JSON.stringify(config)).not.toContain(CARDS.FLUTTERWAVE_V3_WEBHOOK_HASH);
  });

  it('looks up at the configured v3 base URL with the secret key as its bearer', async () => {
    const sent: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        sent.push({ url: input, headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({ status: 'error', message: 'No transaction was found for this id', data: null }), { status: 400 });
      }),
    );
    const cards = providers(CARDS).all.flutterwave_checkout;
    expect(await cards?.lookupStatus(OUR_REF, new AbortController().signal)).toBeNull();
    expect(sent.map((request) => request.url)).toEqual([`https://flutterwave-v3.test/v3/transactions/verify_by_reference?tx_ref=${OUR_REF}`]);
    expect(sent[0]?.headers.get('authorization')).toBe(`Bearer ${CARDS.FLUTTERWAVE_V3_SECRET_KEY}`);
  });
});

// --- Flutterwave ------------------------------------------------------------------------------

describe('Flutterwave', () => {
  it('collects MTN MoMo and Airtel Money, and no card', () => {
    expect([...(providers(FLUTTERWAVE).all.flutterwave?.methods ?? [])]).toEqual(['momo_mtn', 'momo_airtel']);
  });

  it('is configured only with both client credentials', () => {
    expect(providers({}).all.flutterwave?.configured).toBe(false);
    expect(providers({ FLUTTERWAVE_CLIENT_ID: 'id' }).all.flutterwave?.configured).toBe(false);
    expect(providers(FLUTTERWAVE).all.flutterwave?.configured).toBe(true);
  });

  it('reports the currency it charges in', () => {
    expect(providers(FLUTTERWAVE).all.flutterwave?.currency).toBe('RWF');
  });

  it('collects Airtel Money at the configured token endpoint and base URL, in the configured currency', async () => {
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
    const provider = providers({ ...FLUTTERWAVE, FLUTTERWAVE_CURRENCY: 'RWF' }).routing.providerFor('momo_airtel');
    if (provider === undefined) throw new Error('momo_airtel is not on offer');
    const result = await provider.initiate(
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
    expect(JSON.parse(String(sent[2]?.body))).toMatchObject({ mobile_money: { network: 'AIRTEL', phone_number: '731234567' } });
    expect(JSON.parse(String(sent[3]?.body))).toMatchObject({ currency: 'RWF', amount: 16_000, reference: OUR_REF });
  });
});
