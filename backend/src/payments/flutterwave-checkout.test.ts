import { describe, expect, it } from 'vitest';
import {
  CARD_SESSION_GRACE_SECONDS,
  CARD_SESSION_SECONDS,
  type FlutterwaveCheckoutConfig,
  FlutterwaveCheckoutProvider,
  VERIF_HASH_HEADER,
  readTransaction,
} from './flutterwave-checkout.js';
import { type BrowserCheckoutRequest, type InitiatePaymentRequest, PaymentProviderError, type ProviderEvent, type WebhookDelivery } from './provider.js';

/**
 * Cards through Flutterwave v3 Inline (user decisions, 2026-10-30), against a
 * fake Flutterwave: every request captured, every answer scripted. No database
 * and no network: no test here ever reaches Flutterwave.
 *
 * What is proven:
 *  - Initiation calls nothing (Inline starts in the browser) and accepts only a
 *    card; the provider is configured only with all three keys.
 *  - The Inline config is the server's: public key (never the secret or the
 *    hash), `tx_ref = our_ref`, the amount given, RWF, cards only, the payer
 *    (no phone key when there is none), the title, a return URL on WEB_ORIGIN
 *    built from a path (anything that could leave the origin is refused), and
 *    the session in whole minutes, at least one, at most Inline's 1440.
 *  - The lookups call `verify_by_reference?tx_ref=` and `/:id/verify` with the
 *    secret key as bearer, and read a v3 transaction into our vocabulary: the
 *    transaction id as the event's subject (`FLW-` as provider_ref), a
 *    success only with an amount and a currency stated, a FAILED one a single
 *    try (`attemptOnly`). "No transaction was found" is null; every other
 *    answer that is not a success throws, never quoting Flutterwave or a key; an
 *    answer about another `tx_ref` or id throws.
 *  - A webhook verifies only with the exact secret hash in `verif-hash`, and
 *    its `charge.completed` reads as the same event a lookup of that outcome is.
 */

const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8';
const OTHER_REF = '9d1e3c2b-1111-4a2b-8c3d-4e5f6a7b8c9d';
const BASE_URL = 'https://flutterwave-v3.test';
const SECRET = 'FLWSECK_TEST-placeholder-secret-X';
const PUBLIC = 'FLWPUBK_TEST-placeholder-public-X';
const HASH = 'placeholder-webhook-hash-for-tests';
const WEB_ORIGIN = 'https://bookly.example';

type Captured = { url: string; method: string; headers: Record<string, string> };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFlutterwave(handler: (call: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call = { url: String(input), method: init?.method ?? 'GET', headers };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function provider(overrides: Partial<FlutterwaveCheckoutConfig> = {}): FlutterwaveCheckoutProvider {
  return new FlutterwaveCheckoutProvider({ baseUrl: BASE_URL, secretKey: SECRET, publicKey: PUBLIC, webhookHash: HASH, webOrigin: WEB_ORIGIN, ...overrides });
}

/** A v3 transaction as `verify` and a `charge.completed` webhook both carry it. */
function transaction(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 285959875,
    tx_ref: OUR_REF,
    flw_ref: 'FLW-MOCK-abc123',
    amount: 20_000,
    currency: 'RWF',
    charged_amount: 20_000,
    status: 'successful',
    payment_type: 'card',
    customer: { id: 1, name: 'Aline', email: 'aline@example.com' },
    card: { first_6digits: '553188', last_4digits: '2950', type: 'MASTERCARD' },
    ...extra,
  };
}

const success = (data: unknown = transaction()) => json({ status: 'success', message: 'Transaction fetched successfully', data });
const notFound = () => json({ status: 'error', message: 'No transaction was found for this id', data: null }, 400);

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

function delivery(body: unknown, headers: Record<string, string | string[]> = { [VERIF_HASH_HEADER]: HASH }): WebhookDelivery {
  return { rawBody: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), headers: { 'content-type': 'application/json', ...headers }, params: {} };
}

function initiation(overrides: Partial<InitiatePaymentRequest> = {}): InitiatePaymentRequest {
  return { ourRef: OUR_REF, amountRwf: 20_000, method: 'card', payerPhone: '', kind: 'booking_fee', bookingReference: 'BKY-2610-7K3QX', ...overrides };
}

function checkout(overrides: Partial<BrowserCheckoutRequest> = {}): BrowserCheckoutRequest {
  return {
    ourRef: OUR_REF,
    amountRwf: 20_000,
    sessionSeconds: CARD_SESSION_SECONDS,
    payer: { email: 'aline.private@example.com', name: 'Aline Uwase-Private', phone: '+250788123456' },
    title: 'Bookly booking fee BKY-2610-7K3QX',
    returnPath: `/checkout/BKY-2610-7K3QX/tok/payments/${OUR_REF}`,
    ...overrides,
  };
}

describe('configuration', () => {
  it('is configured only with all three keys', () => {
    expect(provider().configured).toBe(true);
    expect(provider({ secretKey: undefined }).configured).toBe(false);
    expect(provider({ publicKey: undefined }).configured).toBe(false);
    expect(provider({ webhookHash: undefined }).configured).toBe(false);
    expect(provider({ secretKey: '', publicKey: '', webhookHash: '' }).configured).toBe(false);
  });

  it('collects cards only, in RWF, and closes an unpaid session after the session and its grace', () => {
    const cards = provider();
    expect(cards.id).toBe('flutterwave_checkout');
    expect([...cards.methods]).toEqual(['card']);
    expect(cards.currency).toBe('RWF');
    expect(cards.sessionClosesAfterSeconds).toBe(CARD_SESSION_SECONDS + CARD_SESSION_GRACE_SECONDS);
  });
});

describe('initiate', () => {
  it('accepts a card without calling anything: the browser starts Inline', async () => {
    const fake = fakeFlutterwave(() => json({}));
    expect(await provider({ fetch: fake.fetch }).initiate(initiation())).toStrictEqual({ outcome: 'accepted', providerRef: null });
    expect(fake.calls).toEqual([]);
  });

  it.each(['momo_mtn', 'momo_airtel'] as const)('refuses %s before anything else', async (method) => {
    expect(await provider().initiate(initiation({ method, payerPhone: '+250788123456' }))).toStrictEqual({ outcome: 'rejected', reason: 'method_unavailable' });
  });

  it('throws when it is not configured, so the attempt is recorded as unavailable', async () => {
    const error = await rejection(provider({ webhookHash: undefined }).initiate(initiation()));
    expect(error).toBeInstanceOf(PaymentProviderError);
  });
});

describe('browserCheckout: the Inline config', () => {
  it('is built from the server values only', () => {
    expect(provider().browserCheckout(checkout())).toStrictEqual({
      public_key: PUBLIC,
      tx_ref: OUR_REF,
      amount: 20_000,
      currency: 'RWF',
      payment_options: 'card',
      redirect_url: `${WEB_ORIGIN}/checkout/BKY-2610-7K3QX/tok/payments/${OUR_REF}`,
      customer: { email: 'aline.private@example.com', name: 'Aline Uwase-Private', phone_number: '+250788123456' },
      customizations: { title: 'Bookly booking fee BKY-2610-7K3QX' },
      configurations: { session_duration: 15 },
    });
  });

  it('never carries the secret key or the webhook hash', () => {
    const text = JSON.stringify(provider().browserCheckout(checkout()));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(HASH);
  });

  it('leaves the phone out when the payer has none', () => {
    expect(provider().browserCheckout(checkout({ payer: { email: 'a@example.com', name: 'A', phone: null } })).customer).toStrictEqual({ email: 'a@example.com', name: 'A' });
  });

  it.each([
    [900, 15],
    [899, 14],
    [119, 1],
    [60, 1],
    [30, 1],
    [0, 1],
    [-5, 1],
    [999_999, 1440],
  ])('gives a session of %i seconds as %i whole minutes, at least one and at most 1440', (sessionSeconds, minutes) => {
    expect(provider().browserCheckout(checkout({ sessionSeconds })).configurations.session_duration).toBe(minutes);
  });

  it('joins a WEB_ORIGIN with a trailing slash without doubling it', () => {
    expect(provider({ webOrigin: 'https://bookly.example/' }).browserCheckout(checkout({ returnPath: '/payments/x' })).redirect_url).toBe('https://bookly.example/payments/x');
  });

  it.each(['//evil.example/x', 'https://evil.example/x', 'payments/x', '', '/\\evil.example'])('refuses a return path %j that could leave WEB_ORIGIN', (returnPath) => {
    expect(() => provider().browserCheckout(checkout({ returnPath }))).toThrow(/return path/);
  });

  it('throws without a public key', () => {
    expect(() => provider({ publicKey: undefined }).browserCheckout(checkout())).toThrow(PaymentProviderError);
  });
});

describe('lookupStatus: verify_by_reference', () => {
  it('asks by tx_ref with the secret key, and reads a success', async () => {
    const fake = fakeFlutterwave(() => success());
    const found = await provider({ fetch: fake.fetch }).lookupStatus(OUR_REF, signal());
    expect(fake.calls).toEqual([
      { url: `${BASE_URL}/v3/transactions/verify_by_reference?tx_ref=${OUR_REF}`, method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${SECRET}` } },
    ]);
    expect(found?.event).toStrictEqual({
      eventId: '285959875:SUCCESSFUL',
      eventType: 'verify_by_reference.SUCCESSFUL',
      ourRef: OUR_REF,
      providerRef: 'FLW-285959875',
      reportedStatus: 'succeeded',
      method: 'card',
      failureReason: null,
      amount: 20_000,
      currency: 'RWF',
    });
    expect(found?.payload).toMatchObject({ id: 285959875, tx_ref: OUR_REF });
  });

  it('answers null for "No transaction was found", as a 400 or a 404', async () => {
    expect(await provider({ fetch: fakeFlutterwave(notFound).fetch }).lookupStatus(OUR_REF, signal())).toBeNull();
    const as404 = fakeFlutterwave(() => json({ status: 'error', message: 'No transaction was found for this id', data: null }, 404));
    expect(await provider({ fetch: as404.fetch }).lookupStatus(OUR_REF, signal())).toBeNull();
  });

  it.each([
    ['another 400', () => json({ status: 'error', message: 'Invalid tx_ref', data: null }, 400)],
    ['a 401', () => json({ status: 'error', message: 'Invalid authorization key', data: null }, 401)],
    ['a 429', () => json({ status: 'error', message: 'Too many requests' }, 429)],
    ['a 500', () => json({ status: 'error', message: `boom ${SECRET}` }, 500)],
    ['a 200 that says error', () => json({ status: 'error', message: 'No transaction was found for this id', data: null }, 200)],
    ['a 200 without data', () => json({ status: 'success' })],
    ['a 200 with a list', () => json({ status: 'success', data: [transaction()] })],
    ['a body that is not JSON', () => new Response('<html>', { status: 502 })],
  ])('throws on %s, quoting neither Flutterwave nor a key', async (_case, answer) => {
    const error = await rejection(provider({ fetch: fakeFlutterwave(answer).fetch }).lookupStatus(OUR_REF, signal()));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toMatch(/^Flutterwave answered \d{3}$/);
  });

  it('throws on an answer about another tx_ref: it is no answer to the question', async () => {
    const fake = fakeFlutterwave(() => success(transaction({ tx_ref: OTHER_REF })));
    expect(await rejection(provider({ fetch: fake.fetch }).lookupStatus(OUR_REF, signal()))).toBeInstanceOf(PaymentProviderError);
  });

  it('throws on a transaction it cannot read', async () => {
    const fake = fakeFlutterwave(() => success({ id: 1 }));
    expect(await rejection(provider({ fetch: fake.fetch }).lookupStatus(OUR_REF, signal()))).toBeInstanceOf(PaymentProviderError);
  });

  it('throws when Flutterwave cannot be reached, naming no key', async () => {
    const fake = fakeFlutterwave(() => {
      throw new TypeError(`fetch failed for ${SECRET}`);
    });
    const error = await rejection(provider({ fetch: fake.fetch }).lookupStatus(OUR_REF, signal()));
    expect(error.message).toBe('Flutterwave could not be reached: TypeError');
  });

  it('throws a timeout when the signal aborts', async () => {
    const controller = new AbortController();
    const fake = fakeFlutterwave(() => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    expect((await rejection(provider({ fetch: fake.fetch }).lookupStatus(OUR_REF, controller.signal))).message).toBe('Flutterwave did not answer in time');
  });

  it('throws without a secret key, calling nothing', async () => {
    const fake = fakeFlutterwave(() => success());
    expect(await rejection(provider({ fetch: fake.fetch, secretKey: undefined }).lookupStatus(OUR_REF, signal()))).toBeInstanceOf(PaymentProviderError);
    expect(fake.calls).toEqual([]);
  });

  it('lowercases a reference asked in capitals and still matches', async () => {
    const fake = fakeFlutterwave(() => success());
    expect((await provider({ fetch: fake.fetch }).lookupStatus(OUR_REF.toUpperCase(), signal()))?.event.ourRef).toBe(OUR_REF);
  });
});

describe('lookupTransaction: verify by id', () => {
  it('asks /v3/transactions/:id/verify, with or without the FLW- prefix', async () => {
    const fake = fakeFlutterwave(() => success());
    const cards = provider({ fetch: fake.fetch });
    expect((await cards.lookupTransaction('285959875', signal()))?.event.reportedStatus).toBe('succeeded');
    expect((await cards.lookupTransaction('FLW-285959875', signal()))?.event.providerRef).toBe('FLW-285959875');
    expect(fake.calls.map((call) => call.url)).toEqual([`${BASE_URL}/v3/transactions/285959875/verify`, `${BASE_URL}/v3/transactions/285959875/verify`]);
  });

  it.each(['', 'abc', '12a', '../../v3/transfers', '1'.repeat(21), '-1', '1.5'])('answers null for %j without calling', async (id) => {
    const fake = fakeFlutterwave(() => success());
    expect(await provider({ fetch: fake.fetch }).lookupTransaction(id, signal())).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it('answers null when Flutterwave never heard of it', async () => {
    expect(await provider({ fetch: fakeFlutterwave(notFound).fetch }).lookupTransaction('285959875', signal())).toBeNull();
  });

  it('throws on an answer about another id', async () => {
    const fake = fakeFlutterwave(() => success(transaction({ id: 1 })));
    expect(await rejection(provider({ fetch: fake.fetch }).lookupTransaction('285959875', signal()))).toBeInstanceOf(PaymentProviderError);
  });
});

describe('reverify: what a webhook claim is worth', () => {
  const claim = (overrides: Partial<ProviderEvent> = {}): ProviderEvent => ({
    eventId: '285959875:SUCCESSFUL',
    eventType: 'charge.completed.SUCCESSFUL',
    ourRef: OUR_REF,
    providerRef: 'FLW-285959875',
    reportedStatus: 'succeeded',
    method: 'card',
    failureReason: null,
    amount: 20_000,
    currency: 'RWF',
    ...overrides,
  });

  it('asks by the transaction id the claim names', async () => {
    const fake = fakeFlutterwave(() => success());
    await provider({ fetch: fake.fetch }).reverify(claim(), signal());
    expect(fake.calls.map((call) => call.url)).toEqual([`${BASE_URL}/v3/transactions/285959875/verify`]);
  });

  it('asks by tx_ref when the claim names no id', async () => {
    const fake = fakeFlutterwave(() => success());
    await provider({ fetch: fake.fetch }).reverify(claim({ providerRef: null }), signal());
    expect(fake.calls.map((call) => call.url)).toEqual([`${BASE_URL}/v3/transactions/verify_by_reference?tx_ref=${OUR_REF}`]);
  });

  it('answers what the API says, not what the claim said', async () => {
    const fake = fakeFlutterwave(() => success(transaction({ status: 'failed' })));
    expect((await provider({ fetch: fake.fetch }).reverify(claim(), signal()))?.event.reportedStatus).toBe('failed');
  });

  it('answers null for a claim that names nothing to ask about', async () => {
    const fake = fakeFlutterwave(() => success());
    expect(await provider({ fetch: fake.fetch }).reverify(claim({ providerRef: null, ourRef: null }), signal())).toBeNull();
    expect(fake.calls).toEqual([]);
  });
});

describe('readTransaction', () => {
  it('reads a declined card as one try, not the payment', () => {
    expect(readTransaction(transaction({ status: 'failed' }), 'verify')).toMatchObject({
      eventId: '285959875:FAILED',
      reportedStatus: 'failed',
      failureReason: 'card_attempt_failed',
      attemptOnly: true,
    });
  });

  it('reads pending as pending, and anything else as nothing we understand', () => {
    expect(readTransaction(transaction({ status: 'pending' }), 'verify')?.reportedStatus).toBe('pending');
    for (const status of ['cancelled', 'error', 'success-ish', 'SUCCESSFULL', '']) {
      expect(readTransaction(transaction({ status }), 'verify')?.reportedStatus ?? null, status).toBeNull();
    }
  });

  it('reads the status whatever its case', () => {
    expect(readTransaction(transaction({ status: 'SUCCESSFUL' }), 'verify')?.reportedStatus).toBe('succeeded');
  });

  it.each([
    ['no amount', { amount: undefined }],
    ['a null amount', { amount: null }],
    ['a fractional amount', { amount: 20_000.5 }],
    ['an amount in words', { amount: 'twenty thousand' }],
    ['a negative amount', { amount: -20_000 }],
    ['no currency', { currency: undefined }],
    ['a null currency', { currency: null }],
  ])('is no success with %s: there is nothing to match against what we asked', (_case, extra) => {
    const event = readTransaction(transaction(extra), 'verify');
    expect(event?.reportedStatus).toBeNull();
    expect(event?.eventType).toBe('verify.SUCCESSFUL.UNVERIFIABLE');
  });

  it('keeps a stated wrong amount or currency as stated, for the webhook path to refuse and log', () => {
    expect(readTransaction(transaction({ amount: 19_999 }), 'verify')).toMatchObject({ reportedStatus: 'succeeded', amount: 19_999 });
    expect(readTransaction(transaction({ currency: 'ngn' }), 'verify')).toMatchObject({ reportedStatus: 'succeeded', currency: 'NGN' });
    expect(readTransaction(transaction({ currency: 'R W F' }), 'verify')).toMatchObject({ reportedStatus: 'succeeded', currency: 'INVALID' });
  });

  it('reads an amount sent as text', () => {
    expect(readTransaction(transaction({ amount: '20000' }), 'verify')?.amount).toBe(20_000);
    expect(readTransaction(transaction({ amount: '20000.00' }), 'verify')?.amount).toBe(20_000);
  });

  it('leaves the method unstated when the payment was not a card', () => {
    expect(readTransaction(transaction({ payment_type: 'mobilemoneyrw' }), 'verify')?.method).toBeNull();
  });

  it('keeps an event without a tx_ref on the transaction id, and one without an id on the tx_ref', () => {
    expect(readTransaction(transaction({ tx_ref: 'not-a-uuid' }), 'verify')).toMatchObject({ ourRef: null, eventId: '285959875:SUCCESSFUL' });
    expect(readTransaction(transaction({ id: undefined }), 'verify')).toMatchObject({ providerRef: null, eventId: `ref:${OUR_REF}:SUCCESSFUL` });
    expect(readTransaction(transaction({ id: '285959875' }), 'verify')?.providerRef).toBe('FLW-285959875');
  });

  it('reads nothing from a body with neither, or no status, or no object', () => {
    expect(readTransaction(transaction({ id: undefined, tx_ref: undefined }), 'verify')).toBeNull();
    expect(readTransaction(transaction({ status: undefined }), 'verify')).toBeNull();
    for (const body of [null, undefined, 'x', 1, [transaction()]]) expect(readTransaction(body, 'verify')).toBeNull();
  });
});

describe('webhooks', () => {
  const body = { event: 'charge.completed', 'event.type': 'CARD_TRANSACTION', data: transaction() };

  it('verifies the exact secret hash in verif-hash', () => {
    expect(provider().verifyWebhook(delivery(body))).toBe(true);
    expect(provider().verifyWebhook(delivery(body, { [VERIF_HASH_HEADER]: [HASH, 'other'] }))).toBe(true);
  });

  it.each([
    ['a wrong hash', { [VERIF_HASH_HEADER]: 'not-the-hash' }],
    ['the hash with a space', { [VERIF_HASH_HEADER]: ` ${HASH}` }],
    ['the hash in capitals', { [VERIF_HASH_HEADER]: HASH.toUpperCase() }],
    ['a prefix of the hash', { [VERIF_HASH_HEADER]: HASH.slice(0, -1) }],
    ['an empty header', { [VERIF_HASH_HEADER]: '' }],
    ['no header', {}],
    ['the v4 signature header instead', { 'flutterwave-signature': HASH }],
  ])('refuses %s', (_case, headers) => {
    expect(provider().verifyWebhook(delivery(body, headers))).toBe(false);
  });

  it('refuses everything without a configured hash', () => {
    expect(provider({ webhookHash: undefined }).verifyWebhook(delivery(body))).toBe(false);
    expect(provider({ webhookHash: '' }).verifyWebhook(delivery(body, { [VERIF_HASH_HEADER]: '' }))).toBe(false);
  });

  it('reads charge.completed as the same event a lookup of that outcome is', () => {
    const event = provider().parseWebhook(delivery(body));
    expect(event).toMatchObject({ eventId: '285959875:SUCCESSFUL', eventType: 'charge.completed.SUCCESSFUL', ourRef: OUR_REF, providerRef: 'FLW-285959875', reportedStatus: 'succeeded' });
    expect(event?.eventId).toBe(readTransaction(transaction(), 'verify')?.eventId);
  });

  it.each([
    ['a transfer event', { event: 'transfer.completed', data: transaction() }],
    ['no event name', { data: transaction() }],
    ['a legacy body with no envelope', transaction()],
    ['an event name it does not read', { event: 'charge.completed<script>', data: transaction() }],
    ['no data', { event: 'charge.completed' }],
  ])('reads nothing from %s', (_case, payload) => {
    expect(provider().parseWebhook(delivery(payload))).toBeNull();
  });

  it('reads nothing from a body that is not JSON', () => {
    expect(provider().parseWebhook(delivery('{"event":'))).toBeNull();
    expect(provider().parseWebhook({ rawBody: Buffer.alloc(0), headers: {}, params: {} })).toBeNull();
  });
});
