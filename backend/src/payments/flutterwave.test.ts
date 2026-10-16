import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type FlutterwaveConfig, FlutterwaveProvider, readCharge } from './flutterwave.js';
import { type InitiatePaymentRequest, PaymentProviderError, type WebhookDelivery } from './provider.js';

/**
 * Flutterwave v4, mobile money in Rwanda (plan.md Task 25; spec §4.3, §6.19;
 * docs/payments-migration.md), against a fake Flutterwave: every request is
 * captured and every answer scripted. No database.
 *
 * What is proven: an attempt is a token (client credentials, form-encoded,
 * cached and shared), a customer, a mobile-money payment method -- country
 * code 250 apart from the national number, `MTN` or `AIRTEL` -- and a charge
 * whose `reference` and idempotency key are `our_ref` and whose amount is whole
 * RWF. A pending `payment_instruction` is accepted with the `chg_` id; a 201
 * whose status is `failed` is a refusal naming the processor code; a
 * `redirect_url` is refused `redirect_required`; a 4xx names Flutterwave's error
 * type; a 401 drops the token; a 5xx, a network failure or an abort throws
 * without leaking a credential. Numbers outside Rwanda and methods it does not
 * offer are refused before any call. The lookup finds the charge by reference
 * and answers null for an empty list. A webhook verifies only with base64
 * HMAC-SHA256 of the exact raw body under the secret hash, and reads into our
 * vocabulary with the same event id a lookup of that outcome gives.
 */

const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8';
const BASE_URL = 'https://flutterwave.test';
const TOKEN_URL = 'https://idp.flutterwave.test/token';
const HASH = 'dashboard-secret-hash-for-tests';

type Captured = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
type Handler = (call: Captured) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const PENDING_CHARGE = {
  id: 'chg_wzRkqRwy6C',
  reference: OUR_REF,
  status: 'pending',
  amount: 19_500,
  currency: 'RWF',
  processor_response: { type: 'pending', code: '02' },
  next_action: { type: 'payment_instruction', payment_instruction: { note: 'Please authorise this payment on your mobile number' } },
};

/** The happy path, per endpoint; `charge` overrides the charge answer. */
function defaultHandler(charge: Handler = () => json({ status: 'success', data: PENDING_CHARGE }, 201)): Handler {
  return (call) => {
    if (call.url.endsWith('/customers')) return json({ status: 'success', data: { id: 'cus_X0yJv3ZMpL' } }, 201);
    if (call.url.endsWith('/payment-methods')) return json({ status: 'success', data: { id: 'pmd_kwU1jeHpBC' } }, 201);
    return charge(call);
  };
}

function fakeFlutterwave(handler: Handler = defaultHandler(), tokenHandler?: Handler) {
  const calls: Captured[] = [];
  let tokens = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Captured = { url: String(input), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(call);
    if (call.url === TOKEN_URL) {
      if (tokenHandler) return tokenHandler(call);
      tokens += 1;
      return json({ access_token: `token-${tokens}`, expires_in: 600, token_type: 'Bearer' });
    }
    return handler(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, tokenCalls: () => calls.filter((c) => c.url === TOKEN_URL), apiCalls: () => calls.filter((c) => c.url !== TOKEN_URL) };
}

function provider(overrides: Partial<FlutterwaveConfig> = {}): FlutterwaveProvider {
  return new FlutterwaveProvider({
    baseUrl: BASE_URL,
    tokenUrl: TOKEN_URL,
    clientId: 'client-id',
    clientSecret: 'client-secret-value',
    webhookHash: HASH,
    currency: 'RWF',
    ...overrides,
  });
}

function request(overrides: Partial<InitiatePaymentRequest> = {}): InitiatePaymentRequest {
  return {
    ourRef: OUR_REF,
    amountRwf: 19_500,
    method: 'momo_mtn',
    payerPhone: '+250788123456',
    kind: 'booking_fee',
    bookingReference: 'BKY-2610-7K3QX',
    ...overrides,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected a rejection, the promise resolved');
}

function signed(body: unknown, key = HASH): WebhookDelivery {
  const rawBody = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    rawBody,
    headers: { 'content-type': 'application/json', 'flutterwave-signature': createHmac('sha256', key).update(rawBody).digest('base64') },
    params: {},
  };
}

function webhook(data: Record<string, unknown>) {
  return { id: 'wbk_W5p6ktwU0jQ8RO4By860', type: 'charge.completed', timestamp: 1735116884019, data };
}

const SUCCEEDED = {
  ...PENDING_CHARGE,
  status: 'succeeded',
  processor_response: { type: 'approved', code: '00' },
  payment_method: { type: 'mobile_money', mobile_money: { country_code: '250', network: 'MTN', phone_number: '788123456' } },
};

// --- Initiate -----------------------------------------------------------------------------

describe('FlutterwaveProvider.initiate', () => {
  it('fetches a token with the client credentials, form-encoded', async () => {
    const fw = fakeFlutterwave();
    await provider({ fetch: fw.fetch }).initiate(request(), signal());

    const [token] = fw.tokenCalls();
    expect(token?.method).toBe('POST');
    expect(token?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(token?.body))).toStrictEqual({
      client_id: 'client-id',
      client_secret: 'client-secret-value',
      grant_type: 'client_credentials',
    });
  });

  it('creates a customer, a mobile money method and a charge keyed by our_ref', async () => {
    const fw = fakeFlutterwave();
    const result = await provider({ fetch: fw.fetch }).initiate(request(), signal());

    expect(result).toStrictEqual({ outcome: 'accepted', providerRef: 'chg_wzRkqRwy6C' });
    const [customer, method, charge] = fw.apiCalls();
    expect(fw.apiCalls().map((call) => `${call.method} ${call.url}`)).toStrictEqual([
      `POST ${BASE_URL}/customers`,
      `POST ${BASE_URL}/payment-methods`,
      `POST ${BASE_URL}/charges`,
    ]);
    for (const call of [customer, method, charge]) {
      expect(call?.headers.authorization).toBe('Bearer token-1');
      expect(call?.headers['content-type']).toBe('application/json');
      expect(call?.headers['x-trace-id']).toBe(OUR_REF);
      expect(call?.headers['x-idempotency-key']).toBeTruthy();
    }

    const customerBody = JSON.parse(customer?.body ?? '');
    expect(customerBody.email).toBe(`payer-${OUR_REF}@example.com`);
    expect(customerBody.name).toStrictEqual({ first: 'Bookly', last: 'Client' });
    expect(JSON.stringify(customerBody)).not.toContain('788123456');

    expect(JSON.parse(method?.body ?? '')).toStrictEqual({
      type: 'mobile_money',
      mobile_money: { country_code: '250', network: 'MTN', phone_number: '788123456' },
    });

    expect(charge?.headers['x-idempotency-key']).toBe(OUR_REF);
    expect(JSON.parse(charge?.body ?? '')).toStrictEqual({
      reference: OUR_REF,
      currency: 'RWF',
      customer_id: 'cus_X0yJv3ZMpL',
      payment_method_id: 'pmd_kwU1jeHpBC',
      amount: 19_500,
      meta: { booking_reference: 'BKY-2610-7K3QX', kind: 'booking_fee' },
    });
  });

  it('sends Airtel Money as network AIRTEL', async () => {
    const fw = fakeFlutterwave();
    await provider({ fetch: fw.fetch }).initiate(request({ method: 'momo_airtel', payerPhone: '+250731234567' }), signal());
    expect(JSON.parse(fw.apiCalls()[1]?.body ?? '').mobile_money).toStrictEqual({ country_code: '250', network: 'AIRTEL', phone_number: '731234567' });
  });

  it('charges the configured currency', async () => {
    const fw = fakeFlutterwave();
    await provider({ fetch: fw.fetch, currency: 'UGX' }).initiate(request(), signal());
    expect(JSON.parse(fw.apiCalls()[2]?.body ?? '').currency).toBe('UGX');
  });

  it('refuses a method it does not offer, and a number outside Rwanda, before calling anyone', async () => {
    const fw = fakeFlutterwave();
    const fwProvider = provider({ fetch: fw.fetch });
    expect(await fwProvider.initiate(request({ method: 'card' }), signal())).toStrictEqual({ outcome: 'rejected', reason: 'method_unavailable' });
    expect(await fwProvider.initiate(request({ payerPhone: '+256772123456' }), signal())).toStrictEqual({ outcome: 'rejected', reason: 'phone_not_rwandan_mobile' });
    expect(await fwProvider.initiate(request({ payerPhone: '12345678' }), signal())).toStrictEqual({ outcome: 'rejected', reason: 'phone_not_rwandan_mobile' });
    expect(fw.calls).toHaveLength(0);
  });

  it('refuses a hard decline, which arrives as a 201 with status failed', async () => {
    const fw = fakeFlutterwave(
      defaultHandler(() => json({ status: 'success', data: { id: 'chg_declined1', reference: OUR_REF, status: 'failed', processor_response: { type: 'failed', code: '06' } } }, 201)),
    );
    expect(await provider({ fetch: fw.fetch }).initiate(request(), signal())).toStrictEqual({ outcome: 'rejected', reason: 'charge_failed_06' });
  });

  it('refuses a charge that needs a redirect: there is no page to send the payer to', async () => {
    const fw = fakeFlutterwave(
      defaultHandler(() =>
        json({ status: 'success', data: { ...PENDING_CHARGE, next_action: { type: 'redirect_url', redirect_url: { url: 'https://checkout.flutterwave.test/x' } } } }, 201),
      ),
    );
    expect(await provider({ fetch: fw.fetch }).initiate(request(), signal())).toStrictEqual({ outcome: 'rejected', reason: 'redirect_required' });
  });

  it('names Flutterwave\'s error type when it refuses the request as made', async () => {
    const fw = fakeFlutterwave((call) =>
      call.url.endsWith('/customers')
        ? json({ status: 'success', data: { id: 'cus_1' } }, 201)
        : json({ status: 'failed', error: { type: 'MOBILE_MONEY_NETWORK_NOT_SUPPORTED', code: '10400', message: 'Network ATL not supported' } }, 400),
    );
    expect(await provider({ fetch: fw.fetch }).initiate(request(), signal())).toStrictEqual({ outcome: 'rejected', reason: 'MOBILE_MONEY_NETWORK_NOT_SUPPORTED' });
    expect(fw.apiCalls()).toHaveLength(2);
  });

  it('throws on a 5xx, naming the status and never a credential', async () => {
    const fw = fakeFlutterwave(defaultHandler(() => json({ status: 'failed', error: { type: 'INTERNAL_ERROR' } }, 503)));
    const error = await rejection(provider({ fetch: fw.fetch }).initiate(request(), signal()));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.message).toBe('Flutterwave answered 503 (INTERNAL_ERROR)');
    expect(error.message).not.toMatch(/client-secret|token-1/);
  });

  it('throws when Flutterwave cannot be reached, or the caller gives up', async () => {
    const unreachable = provider({ fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    expect((await rejection(unreachable.initiate(request(), signal()))).message).toBe('Flutterwave could not be reached: TypeError');

    const controller = new AbortController();
    controller.abort();
    const fw = fakeFlutterwave();
    expect((await rejection(provider({ fetch: fw.fetch }).initiate(request(), controller.signal))).message).toBe('Flutterwave did not answer in time');
  });

  it('caches the token until a minute before it expires, and drops it on a 401', async () => {
    let now = 1_000_000;
    let unauthorised = false;
    const fw = fakeFlutterwave(defaultHandler(() => (unauthorised ? json({ status: 'failed', error: { type: 'UNAUTHORIZED' } }, 401) : json({ data: PENDING_CHARGE }, 201))));
    const fwProvider = provider({ fetch: fw.fetch, now: () => now });

    await fwProvider.initiate(request(), signal());
    await fwProvider.initiate(request(), signal());
    expect(fw.tokenCalls()).toHaveLength(1);

    now += 540_000;
    await fwProvider.initiate(request(), signal());
    expect(fw.tokenCalls()).toHaveLength(2);

    unauthorised = true;
    await rejection(fwProvider.initiate(request(), signal()));
    unauthorised = false;
    await fwProvider.initiate(request(), signal());
    expect(fw.tokenCalls()).toHaveLength(3);
  });

  it('shares one token request between concurrent callers', async () => {
    const fw = fakeFlutterwave();
    const fwProvider = provider({ fetch: fw.fetch });
    await Promise.all([fwProvider.initiate(request(), signal()), fwProvider.initiate(request(), signal())]);
    expect(fw.tokenCalls()).toHaveLength(1);
  });

  it('is unconfigured without both client credentials, and then never calls out', async () => {
    const fw = fakeFlutterwave();
    expect(provider({ clientId: undefined }).configured).toBe(false);
    expect(provider({ clientSecret: undefined }).configured).toBe(false);
    expect(provider().configured).toBe(true);
    const error = await rejection(provider({ fetch: fw.fetch, clientSecret: undefined }).initiate(request(), signal()));
    expect(error.message).toMatch(/Flutterwave is not configured/);
    expect(fw.calls).toHaveLength(0);
  });

  it('refuses a token answer without a token', async () => {
    const fw = fakeFlutterwave(defaultHandler(), () => json({ error: 'invalid_client' }, 401));
    expect((await rejection(provider({ fetch: fw.fetch }).initiate(request(), signal()))).message).toBe('Flutterwave refused a token: 401');
  });
});

// --- Lookup -------------------------------------------------------------------------------

describe('FlutterwaveProvider.lookupStatus', () => {
  it('lists charges by reference and reads the one that is ours', async () => {
    const fw = fakeFlutterwave(() => json({ status: 'success', data: [SUCCEEDED], meta: { page_info: { total: 1 } } }));
    const found = await provider({ fetch: fw.fetch }).lookupStatus(OUR_REF, signal());

    expect(fw.apiCalls()[0]?.url).toBe(`${BASE_URL}/charges?reference=${OUR_REF}`);
    expect(fw.apiCalls()[0]?.method).toBe('GET');
    expect(found?.event).toStrictEqual({
      eventId: `${OUR_REF}:SUCCEEDED`,
      eventType: 'charge_status.SUCCEEDED',
      ourRef: OUR_REF,
      providerRef: 'chg_wzRkqRwy6C',
      reportedStatus: 'succeeded',
      method: 'momo_mtn',
      failureReason: null,
      amount: 19_500,
    });
    expect(found?.payload).toStrictEqual(SUCCEEDED);
  });

  it('answers null when Flutterwave has never heard of the reference', async () => {
    const fw = fakeFlutterwave(() => json({ status: 'success', data: [], meta: { page_info: { total: 0 } } }));
    expect(await provider({ fetch: fw.fetch }).lookupStatus(OUR_REF, signal())).toBeNull();
  });

  it('throws on anything but a 200 with a list', async () => {
    expect(await rejection(provider({ fetch: fakeFlutterwave(() => json({}, 500)).fetch }).lookupStatus(OUR_REF, signal()))).toBeInstanceOf(PaymentProviderError);
    expect((await rejection(provider({ fetch: fakeFlutterwave(() => json({ data: {} })).fetch }).lookupStatus(OUR_REF, signal()))).message).toMatch(/without a list/);
  });
});

// --- Webhooks -----------------------------------------------------------------------------

describe('FlutterwaveProvider.verifyWebhook', () => {
  const body = webhook(SUCCEEDED);

  it('accepts base64 HMAC-SHA256 of the raw body under the secret hash', () => {
    expect(provider().verifyWebhook(signed(body))).toBe(true);
  });

  it('refuses a signature under another key, a body changed by one byte, or no signature', () => {
    expect(provider().verifyWebhook(signed(body, 'another-hash'))).toBe(false);

    const tampered = signed(body);
    tampered.rawBody = Buffer.from(JSON.stringify(webhook({ ...SUCCEEDED, amount: 1 })));
    expect(provider().verifyWebhook(tampered)).toBe(false);

    const unsigned = signed(body);
    delete unsigned.headers['flutterwave-signature'];
    expect(provider().verifyWebhook(unsigned)).toBe(false);
    expect(provider().verifyWebhook({ ...unsigned, headers: { 'flutterwave-signature': 'short' } })).toBe(false);
  });

  it('verifies nothing without a secret hash, however it is signed', () => {
    expect(provider({ webhookHash: undefined }).verifyWebhook(signed(body, ''))).toBe(false);
  });

  it('signs the bytes as sent, not a re-serialisation of them', () => {
    const spaced = `{ "type": "charge.completed",  "data": ${JSON.stringify(SUCCEEDED)} }`;
    expect(provider().verifyWebhook(signed(spaced))).toBe(true);
  });
});

describe('FlutterwaveProvider.parseWebhook', () => {
  it('reads a completed charge with the event id a lookup of the same outcome gives', () => {
    expect(provider().parseWebhook(signed(webhook(SUCCEEDED)))).toStrictEqual({
      eventId: `${OUR_REF}:SUCCEEDED`,
      eventType: 'charge.completed.SUCCEEDED',
      ourRef: OUR_REF,
      providerRef: 'chg_wzRkqRwy6C',
      reportedStatus: 'succeeded',
      method: 'momo_mtn',
      failureReason: null,
      amount: 19_500,
    });
  });

  it('reads a failure with the processor code, and Airtel as momo_airtel', () => {
    const event = provider().parseWebhook(
      signed(webhook({ ...SUCCEEDED, status: 'failed', processor_response: { type: 'failed', code: '06' }, payment_method: { mobile_money: { network: 'AIRTEL' } } })),
    );
    expect(event).toMatchObject({ eventId: `${OUR_REF}:FAILED`, reportedStatus: 'failed', failureReason: 'charge_failed_06', method: 'momo_airtel' });
  });

  it('reads nothing from a body that is not a charge event', () => {
    expect(provider().parseWebhook(signed('not json'))).toBeNull();
    expect(provider().parseWebhook(signed({ type: 'transfer.completed', data: SUCCEEDED }))).toBeNull();
    expect(provider().parseWebhook(signed({ type: 'charge.completed' }))).toBeNull();
  });
});

describe('readCharge', () => {
  it('maps every v4 status into our vocabulary', () => {
    const status = (value: string) => readCharge({ ...PENDING_CHARGE, status: value }, 'x')?.reportedStatus;
    expect(status('succeeded')).toBe('succeeded');
    expect(status('pending')).toBe('pending');
    expect(status('failed')).toBe('failed');
    expect(status('voided')).toBe('failed');
    expect(status('something_new')).toBeNull();
  });

  it('falls back to the charge id when the reference is not ours, and drops an odd amount', () => {
    const event = readCharge({ id: 'chg_abc', reference: 'not-a-uuid', status: 'succeeded', amount: 12.5 }, 'x');
    expect(event).toMatchObject({ eventId: 'chg_abc:SUCCEEDED', ourRef: null, providerRef: 'chg_abc', amount: null });
    expect(readCharge({ status: 'succeeded' }, 'x')).toBeNull();
  });
});
