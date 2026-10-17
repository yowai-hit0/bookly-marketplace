import { describe, expect, it } from 'vitest';
import { EnvValidationError, offeredMethods, parseEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://bookly:bookly@localhost:5432/bookly',
  WEB_ORIGIN: 'http://localhost:5173',
  SESSION_SECRET: 'a-test-secret-that-is-at-least-32-chars-long',
};

describe('parseEnv', () => {
  it('applies defaults for the optional variables', () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.MOMO_MTN_PROVIDER).toBe('mtn_momo_direct');
    expect(env.PAYMENT_METHODS_ENABLED).toBeUndefined();
  });

  it('throws a named error when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabaseUrl } = valid;
    expect(() => parseEnv(withoutDatabaseUrl)).toThrow(EnvValidationError);
    expect(() => parseEnv(withoutDatabaseUrl)).toThrow(/DATABASE_URL/);
  });

  it('throws a named error when SESSION_SECRET is missing', () => {
    const { SESSION_SECRET: _omitted, ...withoutSecret } = valid;
    expect(() => parseEnv(withoutSecret)).toThrow(EnvValidationError);
    expect(() => parseEnv(withoutSecret)).toThrow(/SESSION_SECRET/);
  });

  it('rejects a SESSION_SECRET shorter than 32 characters', () => {
    expect(() => parseEnv({ ...valid, SESSION_SECRET: 'x'.repeat(31) })).toThrow(/SESSION_SECRET/);
    expect(parseEnv({ ...valid, SESSION_SECRET: 'x'.repeat(32) }).SESSION_SECRET).toHaveLength(32);
  });

  it.each(['WEB_ORIGIN', 'API_ORIGIN'] as const)('drops a trailing slash from %s, so CORS and links match', (key) => {
    expect(parseEnv({ ...valid, [key]: 'https://bookly.example/' })[key]).toBe('https://bookly.example');
    expect(parseEnv({ ...valid, [key]: 'http://localhost:5173' })[key]).toBe('http://localhost:5173');
  });

  it.each(['WEB_ORIGIN', 'API_ORIGIN'] as const)('refuses a %s with a path rather than dropping it', (key) => {
    expect(() => parseEnv({ ...valid, [key]: 'https://bookly.example/app' })).toThrow(new RegExp(`${key}.*no path`));
    expect(() => parseEnv({ ...valid, [key]: 'https://bookly.example/?x=1' })).toThrow(new RegExp(key));
  });

  it('rejects an unknown MOMO_MTN_PROVIDER, naming it', () => {
    for (const MOMO_MTN_PROVIDER of ['stripe', 'mtn', 'MTN_MOMO_DIRECT', 'flutterwave_checkout', 'cash', '']) {
      expect(() => parseEnv({ ...valid, MOMO_MTN_PROVIDER })).toThrow(/MOMO_MTN_PROVIDER/);
    }
  });
});

describe('parseEnv: email (plan.md Task 15)', () => {
  it('defaults the sender and the development mail folder, and leaves the key and reply-to unset', () => {
    const env = parseEnv(valid);
    expect(env.MAIL_FROM).toBe('Bookly <bookings@localhost>');
    expect(env.MAIL_OUTPUT_DIR).toBe('.mail');
    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.MAIL_REPLY_TO).toBeUndefined();
  });

  it.each(['development', 'test'])('does not require RESEND_API_KEY in %s', (NODE_ENV) => {
    expect(parseEnv({ ...valid, NODE_ENV }).RESEND_API_KEY).toBeUndefined();
  });

  it('requires RESEND_API_KEY in production, naming it', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/RESEND_API_KEY/);
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production', RESEND_API_KEY: '' })).toThrow(/RESEND_API_KEY/);
    // Production also needs the payment settings added in plan.md Task 16.
    const payments = { API_ORIGIN: 'https://api.bookly.example', MTN_MOMO_SUBSCRIPTION_KEY: 'k', MTN_MOMO_API_USER: 'u', MTN_MOMO_API_KEY: 'a' };
    expect(parseEnv({ ...valid, ...payments, NODE_ENV: 'production', RESEND_API_KEY: 're_live_key' }).RESEND_API_KEY).toBe('re_live_key');
  });

  it('accepts BREVO_API_KEY in place of RESEND_API_KEY in production', () => {
    const payments = { API_ORIGIN: 'https://api.bookly.example', MTN_MOMO_SUBSCRIPTION_KEY: 'k', MTN_MOMO_API_USER: 'u', MTN_MOMO_API_KEY: 'a' };
    const env = parseEnv({ ...valid, ...payments, NODE_ENV: 'production', BREVO_API_KEY: 'xkeysib-live' });
    expect(env.BREVO_API_KEY).toBe('xkeysib-live');
    expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it('names both keys when production has neither', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/BREVO_API_KEY/);
  });

  it.each(['development', 'production'])('refuses both keys at once in %s, naming BREVO_API_KEY', (NODE_ENV) => {
    expect(() => parseEnv({ ...valid, NODE_ENV, RESEND_API_KEY: 're_k', BREVO_API_KEY: 'xkeysib-k' })).toThrow(/BREVO_API_KEY.*not both/);
  });

  it('reads the configured sender, reply-to and folder', () => {
    const env = parseEnv({
      ...valid,
      MAIL_FROM: 'Bookly Studio <hello@bookly.example>',
      MAIL_REPLY_TO: 'photographer@bookly.example',
      MAIL_OUTPUT_DIR: 'tmp/mail',
    });
    expect(env).toMatchObject({
      MAIL_FROM: 'Bookly Studio <hello@bookly.example>',
      MAIL_REPLY_TO: 'photographer@bookly.example',
      MAIL_OUTPUT_DIR: 'tmp/mail',
    });
  });

  it('rejects a MAIL_REPLY_TO that is not an address, naming it', () => {
    expect(() => parseEnv({ ...valid, MAIL_REPLY_TO: 'not an address' })).toThrow(/MAIL_REPLY_TO/);
  });
});

describe('parseEnv: payments (plan.md Tasks 16 and 17)', () => {
  const production = {
    ...valid,
    NODE_ENV: 'production',
    RESEND_API_KEY: 're_live_key',
    API_ORIGIN: 'https://api.bookly.example',
    MTN_MOMO_SUBSCRIPTION_KEY: 'sub',
    MTN_MOMO_API_USER: 'user',
    MTN_MOMO_API_KEY: 'key',
  };

  it('defaults to the MTN sandbox, with no origin, credentials or currency set', () => {
    const env = parseEnv(valid);
    expect(env).toMatchObject({
      MOMO_MTN_PROVIDER: 'mtn_momo_direct',
      MTN_MOMO_BASE_URL: 'https://sandbox.momodeveloper.mtn.com',
      MTN_MOMO_TARGET_ENVIRONMENT: 'sandbox',
    });
    for (const key of ['API_ORIGIN', 'MTN_MOMO_SUBSCRIPTION_KEY', 'MTN_MOMO_API_USER', 'MTN_MOMO_API_KEY', 'MTN_MOMO_CURRENCY'] as const) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('reads every payment variable when set', () => {
    const env = parseEnv({
      ...valid,
      API_ORIGIN: 'https://api.bookly.example',
      MTN_MOMO_BASE_URL: 'https://proxy.momoapi.mtn.co.rw',
      MTN_MOMO_TARGET_ENVIRONMENT: 'mtnrwanda',
      MTN_MOMO_SUBSCRIPTION_KEY: 'sub',
      MTN_MOMO_API_USER: 'user',
      MTN_MOMO_API_KEY: 'key',
      MTN_MOMO_CURRENCY: 'RWF',
    });
    expect(env).toMatchObject({
      API_ORIGIN: 'https://api.bookly.example',
      MTN_MOMO_BASE_URL: 'https://proxy.momoapi.mtn.co.rw',
      MTN_MOMO_TARGET_ENVIRONMENT: 'mtnrwanda',
      MTN_MOMO_SUBSCRIPTION_KEY: 'sub',
      MTN_MOMO_API_USER: 'user',
      MTN_MOMO_API_KEY: 'key',
      MTN_MOMO_CURRENCY: 'RWF',
    });
  });

  it.each(['development', 'test'])('needs neither API_ORIGIN nor MTN credentials in %s', (NODE_ENV) => {
    expect(() => parseEnv({ ...valid, NODE_ENV })).not.toThrow();
  });

  it('accepts a complete production configuration', () => {
    expect(parseEnv(production).API_ORIGIN).toBe('https://api.bookly.example');
  });

  it('requires API_ORIGIN in production, naming it', () => {
    const { API_ORIGIN: _omitted, ...withoutOrigin } = production;
    expect(() => parseEnv(withoutOrigin)).toThrow(EnvValidationError);
    expect(() => parseEnv(withoutOrigin)).toThrow(/API_ORIGIN/);
  });

  it.each(['MTN_MOMO_SUBSCRIPTION_KEY', 'MTN_MOMO_API_USER', 'MTN_MOMO_API_KEY'] as const)(
    'refuses production with %s missing while MTN direct would collect MTN MoMo, naming the credentials',
    (key) => {
      const without: Record<string, string> = { ...production };
      delete without[key];
      expect(() => parseEnv(without)).toThrow(EnvValidationError);
      expect(() => parseEnv(without)).toThrow(/MTN_MOMO_SUBSCRIPTION_KEY, MTN_MOMO_API_USER and MTN_MOMO_API_KEY/);
      expect(() => parseEnv(without)).toThrow(new RegExp(`${key} missing`));
    },
  );

  const flutterwave = { FLUTTERWAVE_CLIENT_ID: 'id', FLUTTERWAVE_CLIENT_SECRET: 'secret', FLUTTERWAVE_WEBHOOK_HASH: 'hash' };

  it('does not require MTN credentials in production once Flutterwave collects MTN MoMo', () => {
    const { MTN_MOMO_SUBSCRIPTION_KEY: _s, MTN_MOMO_API_USER: _u, MTN_MOMO_API_KEY: _k, ...withoutMtn } = production;
    expect(parseEnv({ ...withoutMtn, ...flutterwave, MOMO_MTN_PROVIDER: 'flutterwave' }).MOMO_MTN_PROVIDER).toBe('flutterwave');
  });

  it.each(['FLUTTERWAVE_CLIENT_ID', 'FLUTTERWAVE_CLIENT_SECRET'] as const)(
    'refuses production with %s missing while Flutterwave collects MTN MoMo, naming the credentials',
    (key) => {
      const { MTN_MOMO_SUBSCRIPTION_KEY: _s, MTN_MOMO_API_USER: _u, MTN_MOMO_API_KEY: _k, ...withoutMtn } = production;
      const without: Record<string, string> = { ...withoutMtn, ...flutterwave, MOMO_MTN_PROVIDER: 'flutterwave' };
      delete without[key];
      expect(() => parseEnv(without)).toThrow(/FLUTTERWAVE_CLIENT_ID and FLUTTERWAVE_CLIENT_SECRET/);
      expect(() => parseEnv(without)).toThrow(new RegExp(`${key} missing`));
    },
  );

  it('refuses production without FLUTTERWAVE_WEBHOOK_HASH while Flutterwave collects anything, naming what it collects', () => {
    const { FLUTTERWAVE_WEBHOOK_HASH: _h, ...noHash } = flutterwave;
    expect(() => parseEnv({ ...production, ...noHash })).toThrow(/FLUTTERWAVE_WEBHOOK_HASH is required in production while Flutterwave collects momo_airtel/);
    expect(() => parseEnv({ ...production, ...noHash, MOMO_MTN_PROVIDER: 'flutterwave' })).toThrow(/collects momo_mtn and momo_airtel/);
  });

  it('does not ask for the webhook hash while Flutterwave collects nothing', () => {
    const { FLUTTERWAVE_WEBHOOK_HASH: _h, ...noHash } = flutterwave;
    expect(() => parseEnv({ ...production, ...noHash, PAYMENT_METHODS_ENABLED: 'momo_mtn' })).not.toThrow();
  });

  it('does not require Flutterwave credentials in production while MTN direct collects MTN MoMo', () => {
    expect(() => parseEnv(production)).not.toThrow();
  });

  it('accepts production with both providers configured, offering both methods', () => {
    expect(offeredMethods(parseEnv({ ...production, ...flutterwave }))).toEqual(['momo_mtn', 'momo_airtel']);
  });

  it('refuses production with no payment method on offer, naming what each method needs', () => {
    const { MTN_MOMO_SUBSCRIPTION_KEY: _s, MTN_MOMO_API_USER: _u, MTN_MOMO_API_KEY: _k, ...withoutMtn } = production;
    let message = '';
    try {
      parseEnv(withoutMtn);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/no payment method can be offered: MTN_MOMO_SUBSCRIPTION_KEY, MTN_MOMO_API_USER and MTN_MOMO_API_KEY are required in production to offer momo_mtn through mtn_momo_direct/);
    expect(message).toMatch(/FLUTTERWAVE_CLIENT_ID and FLUTTERWAVE_CLIENT_SECRET are required in production to offer momo_airtel through flutterwave/);
  });

  it('refuses production when an explicitly enabled method cannot be collected', () => {
    expect(() => parseEnv({ ...production, PAYMENT_METHODS_ENABLED: 'momo_mtn,momo_airtel' })).toThrow(
      /FLUTTERWAVE_CLIENT_ID and FLUTTERWAVE_CLIENT_SECRET are required in production to offer momo_airtel through flutterwave/,
    );
    expect(() => parseEnv({ ...production, PAYMENT_METHODS_ENABLED: 'momo_airtel' })).toThrow(/to offer momo_airtel/);
  });

  it('lets production enable only what it can collect', () => {
    expect(offeredMethods(parseEnv({ ...production, PAYMENT_METHODS_ENABLED: 'momo_mtn' }))).toEqual(['momo_mtn']);
    expect(offeredMethods(parseEnv({ ...production, ...flutterwave, PAYMENT_METHODS_ENABLED: 'momo_airtel' }))).toEqual(['momo_airtel']);
  });

  it.each(['development', 'test'])('in %s, offers only what is configured and refuses nothing for it', (NODE_ENV) => {
    expect(offeredMethods(parseEnv({ ...valid, NODE_ENV }))).toEqual([]);
    expect(offeredMethods(parseEnv({ ...valid, NODE_ENV, PAYMENT_METHODS_ENABLED: 'momo_airtel' }))).toEqual([]);
    expect(offeredMethods(parseEnv({ ...valid, NODE_ENV, MTN_MOMO_SUBSCRIPTION_KEY: 's' }))).toEqual([]);
    expect(offeredMethods(parseEnv({ ...valid, NODE_ENV, MTN_MOMO_SUBSCRIPTION_KEY: 's', MTN_MOMO_API_USER: 'u', MTN_MOMO_API_KEY: 'k' }))).toEqual(['momo_mtn']);
  });

  it('defaults Flutterwave to its sandbox, its token endpoint and RWF', () => {
    const env = parseEnv(valid);
    expect(env).toMatchObject({
      FLUTTERWAVE_BASE_URL: 'https://developersandbox-api.flutterwave.com',
      FLUTTERWAVE_IDP_URL: 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token',
      FLUTTERWAVE_CURRENCY: 'RWF',
    });
    for (const key of ['FLUTTERWAVE_CLIENT_ID', 'FLUTTERWAVE_CLIENT_SECRET', 'FLUTTERWAVE_WEBHOOK_HASH'] as const) {
      expect(env[key]).toBeUndefined();
    }
  });

  it.each(['FLUTTERWAVE_CLIENT_ID', 'FLUTTERWAVE_CLIENT_SECRET', 'FLUTTERWAVE_WEBHOOK_HASH', 'FLUTTERWAVE_BASE_URL', 'FLUTTERWAVE_CURRENCY'])(
    'rejects an empty %s, naming it',
    (key) => {
      expect(() => parseEnv({ ...valid, [key]: '' })).toThrow(new RegExp(key));
    },
  );

  it('names every missing production setting at once', () => {
    const { API_ORIGIN: _o, MTN_MOMO_API_KEY: _k, RESEND_API_KEY: _r, ...bare } = production;
    let message = '';
    try {
      parseEnv(bare);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/RESEND_API_KEY/);
    expect(message).toMatch(/API_ORIGIN/);
    expect(message).toMatch(/MTN_MOMO_API_KEY/);
  });

  it.each(['not a url', 'api.bookly.example', ''])('rejects an API_ORIGIN of "%s", naming it', (API_ORIGIN) => {
    expect(() => parseEnv({ ...valid, API_ORIGIN })).toThrow(/API_ORIGIN/);
  });

  it.each(['not a url', ''])('rejects an MTN_MOMO_BASE_URL of "%s", naming it', (MTN_MOMO_BASE_URL) => {
    expect(() => parseEnv({ ...valid, MTN_MOMO_BASE_URL })).toThrow(/MTN_MOMO_BASE_URL/);
  });

  it.each(['eur', 'EURO', 'EU', '978', ''])('rejects an MTN_MOMO_CURRENCY of "%s", naming it', (MTN_MOMO_CURRENCY) => {
    expect(() => parseEnv({ ...valid, MTN_MOMO_CURRENCY })).toThrow(/MTN_MOMO_CURRENCY/);
  });

  it.each(['MTN_MOMO_SUBSCRIPTION_KEY', 'MTN_MOMO_API_USER', 'MTN_MOMO_API_KEY', 'MTN_MOMO_TARGET_ENVIRONMENT'])('rejects an empty %s, naming it', (key) => {
    expect(() => parseEnv({ ...valid, [key]: '' })).toThrow(new RegExp(key));
  });
});

describe('parseEnv: method routing (marketplace-spec.md R3.1, 2026-10-17)', () => {
  it('tolerates the retired PAYMENT_PROVIDER=mtn_momo_direct, which is the new default, and lets it change nothing', () => {
    const env = parseEnv({ ...valid, PAYMENT_PROVIDER: 'mtn_momo_direct', MOMO_MTN_PROVIDER: 'flutterwave' });
    expect(env.MOMO_MTN_PROVIDER).toBe('flutterwave');
    expect(parseEnv({ ...valid, PAYMENT_PROVIDER: 'mtn_momo_direct' }).MOMO_MTN_PROVIDER).toBe('mtn_momo_direct');
  });

  it('refuses any other PAYMENT_PROVIDER, saying what replaces it, rather than silently routing MTN MoMo elsewhere', () => {
    for (const PAYMENT_PROVIDER of ['flutterwave', 'stripe', 'MTN_MOMO_DIRECT', '']) {
      expect(() => parseEnv({ ...valid, PAYMENT_PROVIDER })).toThrow(EnvValidationError);
      expect(() => parseEnv({ ...valid, PAYMENT_PROVIDER })).toThrow(/PAYMENT_PROVIDER is retired.*MOMO_MTN_PROVIDER.*PAYMENT_METHODS_ENABLED/);
    }
  });

  it('reads MOMO_MTN_PROVIDER', () => {
    expect(parseEnv({ ...valid, MOMO_MTN_PROVIDER: 'flutterwave' }).MOMO_MTN_PROVIDER).toBe('flutterwave');
    expect(parseEnv({ ...valid, MOMO_MTN_PROVIDER: 'mtn_momo_direct' }).MOMO_MTN_PROVIDER).toBe('mtn_momo_direct');
  });

  it.each([
    ['momo_mtn', ['momo_mtn']],
    ['momo_airtel', ['momo_airtel']],
    ['momo_mtn,momo_airtel', ['momo_mtn', 'momo_airtel']],
    ['momo_airtel,momo_mtn', ['momo_mtn', 'momo_airtel']],
    [' momo_mtn , momo_airtel ', ['momo_mtn', 'momo_airtel']],
    ['momo_mtn,momo_mtn', ['momo_mtn']],
    ['momo_mtn,', ['momo_mtn']],
  ])('reads PAYMENT_METHODS_ENABLED=%j as %j', (PAYMENT_METHODS_ENABLED, expected) => {
    expect(parseEnv({ ...valid, PAYMENT_METHODS_ENABLED }).PAYMENT_METHODS_ENABLED).toEqual(expected);
  });

  it.each(['card', 'momo_mtn,card', 'card,momo_airtel'])('refuses card in PAYMENT_METHODS_ENABLED=%j: it is deferred', (PAYMENT_METHODS_ENABLED) => {
    expect(() => parseEnv({ ...valid, PAYMENT_METHODS_ENABLED })).toThrow(/PAYMENT_METHODS_ENABLED: card is reserved for the hosted card checkout, which is deferred/);
  });

  it.each(['paypal', 'momo_mtn,paypal', 'MOMO_MTN', 'momo mtn', 'momo_mtn;momo_airtel'])('refuses an unknown method in PAYMENT_METHODS_ENABLED=%j, naming it', (PAYMENT_METHODS_ENABLED) => {
    expect(() => parseEnv({ ...valid, PAYMENT_METHODS_ENABLED })).toThrow(/PAYMENT_METHODS_ENABLED: unknown method/);
  });

  it.each(['', ' ', ',', ' , , '])('refuses PAYMENT_METHODS_ENABLED=%j, which lists nothing', (PAYMENT_METHODS_ENABLED) => {
    expect(() => parseEnv({ ...valid, PAYMENT_METHODS_ENABLED })).toThrow(/PAYMENT_METHODS_ENABLED: lists no method/);
  });

  it('does not echo a long unknown value back in full', () => {
    expect(() => parseEnv({ ...valid, PAYMENT_METHODS_ENABLED: 'x'.repeat(500) })).toThrow(new RegExp(`unknown method "${'x'.repeat(40)}"`));
  });
});

describe('parseEnv: Google sign-in (Phase 2 decision 6)', () => {
  it('is off by default', () => {
    const env = parseEnv(valid);
    expect([env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET]).toEqual([undefined, undefined]);
  });

  it('accepts the client id and secret together', () => {
    const env = parseEnv({ ...valid, GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret' });
    expect([env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET]).toEqual(['id.apps.googleusercontent.com', 'secret']);
  });

  it.each([{ GOOGLE_CLIENT_ID: 'id' }, { GOOGLE_CLIENT_SECRET: 'secret' }])('refuses one without the other: %j', (google) => {
    expect(() => parseEnv({ ...valid, ...google })).toThrow(/GOOGLE_CLIENT_SECRET.*together/);
  });
});
