import { describe, expect, it } from 'vitest';
import { API_ORIGIN, MTN_BASE_URL, MTN_CREDENTIALS, TEST_SECRET, mtnProvider } from '../test/payment-fixtures.js';
import { deriveKey, sign } from './keys.js';
import { MTN_MOMO_CALLBACK_PATH, MtnMomoProvider } from './mtn-momo.js';
import { type InitiatePaymentRequest, PaymentProviderError, type WebhookDelivery } from './provider.js';

/**
 * MTN MoMo Collections, called directly (plan.md Task 16; spec §4.3, §6.19),
 * against a fake MTN: every request the provider makes is captured, and every
 * answer is scripted. No database.
 *
 * What is proven: a request to pay is exactly what MTN documents -- `our_ref`
 * as the `X-Reference-Id` header, byte for byte, and as the `externalId`; the
 * bearer token, target environment and subscription key; the amount as a string;
 * the payer as MSISDN digits -- and carries a callback URL that the provider's
 * own `verifyWebhook` accepts. The token is fetched with Basic credentials,
 * cached until a minute before it expires, shared by concurrent callers, and
 * dropped on a 401. 202 is accepted; 400 and 409 are refusals naming MTN's code;
 * anything else, a network failure or an abort throws `PaymentProviderError`
 * without leaking a credential. The status lookup maps 200, 404 and the rest;
 * every MTN status reads into our vocabulary, with its transaction id, reason
 * code and amount. A webhook verifies only with the URL's signature for that
 * very reference AND a body naming the same payment. Without credentials the
 * provider reports itself unconfigured and never calls MTN.
 */

const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8';
const OTHER_REF = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const TOKEN_URL = `${MTN_BASE_URL}/collection/token/`;
const REQUEST_URL = `${MTN_BASE_URL}/collection/v1_0/requesttopay`;

type Captured = { url: string; method: string; headers: Record<string, string>; body: string | undefined; signal: AbortSignal | undefined };
type Handler = (call: Captured) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function empty(status: number): Response {
  return new Response(null, { status });
}

/**
 * A fake MTN. Token requests answer a token (numbered, so a refresh is
 * visible); everything else goes to `handler`, which defaults to 202.
 */
function fakeMtn(handler: Handler = () => empty(202), tokenHandler?: Handler) {
  const calls: Captured[] = [];
  let tokens = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    if (call.url === TOKEN_URL) {
      if (tokenHandler) return tokenHandler(call);
      tokens += 1;
      return json({ access_token: `token-${tokens}`, token_type: 'access_token', expires_in: 3600 });
    }
    return handler(call);
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    calls,
    tokenCalls: () => calls.filter((call) => call.url === TOKEN_URL),
    apiCalls: () => calls.filter((call) => call.url !== TOKEN_URL),
  };
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

/** The error a promise rejects with, or a failure if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected a rejection, the promise resolved');
}

/** The route params of a callback URL: `/api/webhooks/mtn-momo/:ourRef/:signature`. */
function paramsOf(callbackUrl: string): { ourRef: string | undefined; signature: string | undefined } {
  const segments = new URL(callbackUrl).pathname.split('/');
  return { ourRef: segments.at(-2), signature: segments.at(-1) };
}

function delivery(params: Record<string, string | undefined>, body: unknown): WebhookDelivery {
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { rawBody, headers: { 'content-type': 'application/json' }, params };
}

function signedParams(provider: MtnMomoProvider, ourRef = OUR_REF) {
  return paramsOf(provider.callbackUrl(ourRef));
}

// --- Request to pay ----------------------------------------------------------------------

describe('initiate: the request to pay MTN receives', () => {
  it('POSTs to /collection/v1_0/requesttopay with our_ref as X-Reference-Id, exactly', async () => {
    const mtn = fakeMtn();
    const provider = mtnProvider({ fetch: mtn.fetch });

    await expect(provider.initiate(request(), signal())).resolves.toStrictEqual({ outcome: 'accepted', providerRef: null });

    const [call] = mtn.apiCalls();
    expect(mtn.apiCalls()).toHaveLength(1);
    expect(call?.url).toBe(REQUEST_URL);
    expect(call?.method).toBe('POST');
    expect(call?.headers['x-reference-id']).toBe(OUR_REF);
  });

  it('sends the bearer token, target environment, subscription key, JSON content type and a callback URL', async () => {
    const mtn = fakeMtn();
    const provider = mtnProvider({ fetch: mtn.fetch });

    await provider.initiate(request(), signal());

    expect(mtn.apiCalls()[0]?.headers).toStrictEqual({
      authorization: 'Bearer token-1',
      'x-target-environment': 'sandbox',
      'ocp-apim-subscription-key': MTN_CREDENTIALS.subscriptionKey,
      'content-type': 'application/json',
      'x-reference-id': OUR_REF,
      'x-callback-url': provider.callbackUrl(OUR_REF),
    });
  });

  it('sends the amount as a string, the currency, our_ref as externalId, the payer as MSISDN digits and the reference in both notes', async () => {
    const mtn = fakeMtn();
    await mtnProvider({ fetch: mtn.fetch }).initiate(request({ payerPhone: '+250 (788) 123-456' }), signal());

    expect(JSON.parse(mtn.apiCalls()[0]?.body ?? 'null')).toStrictEqual({
      amount: '19500',
      currency: 'EUR',
      externalId: OUR_REF,
      payer: { partyIdType: 'MSISDN', partyId: '250788123456' },
      payerMessage: 'Bookly BKY-2610-7K3QX',
      payeeNote: 'Bookly BKY-2610-7K3QX',
    });
  });

  it('passes the caller’s abort signal to the request to pay, but not to the shared token request', async () => {
    const mtn = fakeMtn();
    const controller = new AbortController();
    await mtnProvider({ fetch: mtn.fetch }).initiate(request(), controller.signal);

    expect(mtn.apiCalls()[0]?.signal).toBe(controller.signal);
    // The token request serves every concurrent caller, so it carries a deadline of its own.
    expect(mtn.tokenCalls()[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(mtn.tokenCalls()[0]?.signal).not.toBe(controller.signal);
  });

  it('lets one caller give up on a shared token request without failing the others', async () => {
    let releaseToken: (response: Response) => void = () => {};
    const mtn = fakeMtn(undefined, () => new Promise<Response>((resolve) => (releaseToken = resolve)));
    const provider = mtnProvider({ fetch: mtn.fetch });
    const impatient = new AbortController();

    const first = provider.initiate(request(), impatient.signal);
    const second = provider.initiate(request({ ourRef: OTHER_REF }), signal());
    await new Promise((resolve) => setImmediate(resolve));
    impatient.abort();
    const firstError = await rejection(first);
    releaseToken(json({ access_token: 'shared-token', expires_in: 3600 }));

    expect(firstError).toBeInstanceOf(PaymentProviderError);
    expect(firstError.message).toBe('MTN MoMo did not answer in time');
    await expect(second).resolves.toStrictEqual({ outcome: 'accepted', providerRef: null });
    expect(mtn.tokenCalls()).toHaveLength(1);
    expect(mtn.apiCalls().map((call) => [call.headers['x-reference-id'], call.headers.authorization])).toEqual([[OTHER_REF, 'Bearer shared-token']]);
  });

  it('strips trailing slashes from the base URL', async () => {
    const mtn = fakeMtn();
    const provider = new MtnMomoProvider({
      baseUrl: `${MTN_BASE_URL}///`,
      targetEnvironment: 'mtnrwanda',
      currency: 'RWF',
      ...MTN_CREDENTIALS,
      callbackOrigin: API_ORIGIN,
      secret: TEST_SECRET,
      fetch: mtn.fetch,
    });
    await provider.initiate(request(), signal());

    expect(mtn.calls.map((call) => call.url)).toEqual([TOKEN_URL, REQUEST_URL]);
    expect(mtn.apiCalls()[0]?.headers['x-target-environment']).toBe('mtnrwanda');
    expect(JSON.parse(mtn.apiCalls()[0]?.body ?? 'null')).toMatchObject({ currency: 'RWF' });
  });

  it('refuses a method MTN direct does not collect, without calling MTN', async () => {
    const mtn = fakeMtn();
    const provider = mtnProvider({ fetch: mtn.fetch });

    for (const method of ['momo_airtel', 'card'] as const) {
      await expect(provider.initiate(request({ method }), signal())).resolves.toStrictEqual({ outcome: 'rejected', reason: 'method_unavailable' });
    }
    expect(mtn.calls).toEqual([]);
  });

  it('offers MTN MoMo and nothing else', () => {
    const provider = mtnProvider();
    expect(provider.id).toBe('mtn_momo_direct');
    expect([...provider.methods]).toEqual(['momo_mtn']);
  });
});

describe('initiate: the callback URL', () => {
  it('is {API origin}/api/webhooks/mtn-momo/{our_ref}/{HMAC of our_ref under the callback key}', () => {
    const provider = mtnProvider();
    const expected = sign(deriveKey(TEST_SECRET, 'mtn-momo-callback'), OUR_REF);

    expect(provider.callbackUrl(OUR_REF)).toBe(`${API_ORIGIN}${MTN_MOMO_CALLBACK_PATH}/${OUR_REF}/${expected}`);
    expect(expected).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is signed on the lower-cased reference, so an upper-case our_ref gets the same URL', () => {
    const provider = mtnProvider();
    expect(provider.callbackUrl(OUR_REF.toUpperCase())).toBe(provider.callbackUrl(OUR_REF));
  });

  it('verifies with the provider’s own verifyWebhook when MTN calls it with the status body', async () => {
    const mtn = fakeMtn();
    const provider = mtnProvider({ fetch: mtn.fetch });
    await provider.initiate(request(), signal());

    const url = mtn.apiCalls()[0]?.headers['x-callback-url'] ?? '';
    expect(provider.verifyWebhook(delivery(paramsOf(url), { externalId: OUR_REF, status: 'SUCCESSFUL' }))).toBe(true);
  });

  it('differs per payment and per secret', () => {
    const provider = mtnProvider();
    const other = new MtnMomoProvider({ baseUrl: MTN_BASE_URL, targetEnvironment: 'sandbox', currency: 'EUR', callbackOrigin: API_ORIGIN, secret: `${TEST_SECRET}-rotated` });

    expect(provider.callbackUrl(OUR_REF)).not.toBe(provider.callbackUrl(OTHER_REF));
    expect(other.callbackUrl(OUR_REF)).not.toBe(provider.callbackUrl(OUR_REF));
    expect(other.verifyWebhook(delivery(signedParams(provider), { externalId: OUR_REF, status: 'SUCCESSFUL' }))).toBe(false);
  });

  it('is not the checkout link’s signature: the keys are derived per purpose', () => {
    const callbackSignature = signedParams(mtnProvider()).signature;
    expect(callbackSignature).not.toBe(sign(deriveKey(TEST_SECRET, 'checkout-link'), OUR_REF));
  });
});

// --- Answers ----------------------------------------------------------------------------

describe('initiate: what MTN answers', () => {
  it.each([
    [400, { code: 'PAYER_NOT_FOUND', message: 'Payer not found' }, 'PAYER_NOT_FOUND'],
    [400, { code: 'INVALID_CALLBACK_URL_HOST' }, 'INVALID_CALLBACK_URL_HOST'],
    [409, { code: 'RESOURCE_ALREADY_EXIST', message: 'Duplicated reference id' }, 'RESOURCE_ALREADY_EXIST'],
  ])('reads %s with %j as a refusal naming MTN’s code', async (status, body, reason) => {
    const mtn = fakeMtn(() => json(body, status));
    await expect(mtnProvider({ fetch: mtn.fetch }).initiate(request(), signal())).resolves.toStrictEqual({ outcome: 'rejected', reason });
  });

  it.each([
    [400, 'no body', () => empty(400), 'http_400'],
    [409, 'no body', () => empty(409), 'http_409'],
    [400, 'a non-JSON body', () => new Response('<html>Bad Request</html>', { status: 400 }), 'http_400'],
    [400, 'a code that is not a code', () => json({ code: 'not a code; DROP TABLE' }, 400), 'http_400'],
    [400, 'a numeric code', () => json({ code: 42 }, 400), 'http_400'],
    [400, 'an over-long code', () => json({ code: `A${'B'.repeat(64)}` }, 400), 'http_400'],
  ])('reads %s with %s as a refusal coded by its status', async (_status, _case, answer, reason) => {
    const mtn = fakeMtn(answer);
    await expect(mtnProvider({ fetch: mtn.fetch }).initiate(request(), signal())).resolves.toStrictEqual({ outcome: 'rejected', reason });
  });

  it.each([200, 201, 204, 401, 403, 404, 429, 500, 502, 503])('throws PaymentProviderError on %s, which a retry might change', async (status) => {
    const mtn = fakeMtn(() => (status === 204 ? empty(204) : json({ code: 'INTERNAL_PROCESSING_ERROR' }, status)));
    const error = await rejection(mtnProvider({ fetch: mtn.fetch }).initiate(request(), signal()));

    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.message).toContain(String(status));
  });

  it('names MTN’s code in the error when there is one, and only a code', async () => {
    const mtn = fakeMtn(() => json({ code: 'NOT_ENOUGH_FUNDS', message: 'secret internals' }, 500));
    const error = await rejection(mtnProvider({ fetch: mtn.fetch }).initiate(request(), signal()));

    expect(error.message).toBe('MTN MoMo answered 500 (NOT_ENOUGH_FUNDS)');
  });

  it('throws PaymentProviderError when MTN cannot be reached, naming the error but never quoting it', async () => {
    const mtn = fakeMtn(() => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${MTN_CREDENTIALS.apiKey}`);
    });
    const error = await rejection(mtnProvider({ fetch: mtn.fetch }).initiate(request(), signal()));

    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.message).toBe('MTN MoMo could not be reached: TypeError');
  });

  it('throws PaymentProviderError saying MTN did not answer in time when the call is aborted', async () => {
    const controller = new AbortController();
    const mtn = fakeMtn(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
          controller.abort();
        }),
    );
    const error = await rejection(mtnProvider({ fetch: mtn.fetch }).initiate(request(), controller.signal));

    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.message).toBe('MTN MoMo did not answer in time');
  });

  it('never puts a credential in any error it throws', async () => {
    const answers: Handler[] = [
      () => json({ code: 'X' }, 500),
      () => {
        throw new Error(MTN_CREDENTIALS.apiKey);
      },
    ];
    for (const answer of answers) {
      const error = await rejection(mtnProvider({ fetch: fakeMtn(answer).fetch }).initiate(request(), signal()));
      for (const secret of Object.values(MTN_CREDENTIALS)) expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(Buffer.from(`${MTN_CREDENTIALS.apiUser}:${MTN_CREDENTIALS.apiKey}`).toString('base64'));
    }
  });
});

// --- Token ----------------------------------------------------------------------------------

describe('the access token', () => {
  it('is fetched with a Basic apiUser:apiKey header and the subscription key, by POST', async () => {
    const mtn = fakeMtn();
    await mtnProvider({ fetch: mtn.fetch }).initiate(request(), signal());

    const [tokenCall] = mtn.tokenCalls();
    expect(tokenCall?.method).toBe('POST');
    expect(tokenCall?.headers).toStrictEqual({
      authorization: `Basic ${Buffer.from(`${MTN_CREDENTIALS.apiUser}:${MTN_CREDENTIALS.apiKey}`).toString('base64')}`,
      'ocp-apim-subscription-key': MTN_CREDENTIALS.subscriptionKey,
    });
  });

  it('is cached until 60 seconds before MTN says it expires, then refreshed', async () => {
    let clock = 1_000_000;
    const mtn = fakeMtn();
    const provider = mtnProvider({ fetch: mtn.fetch, now: () => clock });

    await provider.initiate(request(), signal());
    clock += 3_540_000 - 1;
    await provider.initiate(request(), signal());
    expect(mtn.tokenCalls()).toHaveLength(1);
    expect(mtn.apiCalls().map((call) => call.headers.authorization)).toEqual(['Bearer token-1', 'Bearer token-1']);

    clock += 1;
    await provider.initiate(request(), signal());
    expect(mtn.tokenCalls()).toHaveLength(2);
    expect(mtn.apiCalls()[2]?.headers.authorization).toBe('Bearer token-2');
  });

  it('assumes an hour when MTN gives no usable expires_in', async () => {
    for (const expiresIn of [undefined, 0, -5, '3600']) {
      let clock = 0;
      const mtn = fakeMtn(undefined, () => json({ access_token: 'token-x', expires_in: expiresIn }));
      const provider = mtnProvider({ fetch: mtn.fetch, now: () => clock });

      await provider.initiate(request(), signal());
      clock = 3_540_000 - 1;
      await provider.initiate(request(), signal());
      expect(mtn.tokenCalls()).toHaveLength(1);
      clock = 3_540_000;
      await provider.initiate(request(), signal());
      expect(mtn.tokenCalls()).toHaveLength(2);
    }
  });

  it('is fetched afresh every time when it lives less than the margin', async () => {
    const mtn = fakeMtn(undefined, () => json({ access_token: 'short-lived', expires_in: 30 }));
    const provider = mtnProvider({ fetch: mtn.fetch, now: () => 5 });

    await provider.initiate(request(), signal());
    await provider.initiate(request(), signal());
    expect(mtn.tokenCalls()).toHaveLength(2);
  });

  it('is one request shared by concurrent callers', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const mtn = fakeMtn(
      (call) => (call.method === 'GET' ? json({ externalId: OUR_REF, status: 'PENDING' }) : empty(202)),
      async () => {
        await gate;
        return json({ access_token: 'shared', expires_in: 3600 });
      },
    );
    const provider = mtnProvider({ fetch: mtn.fetch });

    const all = Promise.all([
      provider.initiate(request(), signal()),
      provider.initiate(request({ ourRef: OTHER_REF }), signal()),
      provider.lookupStatus(OUR_REF, signal()),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await all;

    expect(mtn.tokenCalls()).toHaveLength(1);
    expect(mtn.apiCalls().map((call) => call.headers.authorization)).toEqual(['Bearer shared', 'Bearer shared', 'Bearer shared']);
  });

  it('is dropped when MTN answers 401 to a request to pay, so the next call fetches a new one', async () => {
    let first = true;
    const mtn = fakeMtn(() => {
      if (first) {
        first = false;
        return json({ code: 'UNAUTHORIZED' }, 401);
      }
      return empty(202);
    });
    const provider = mtnProvider({ fetch: mtn.fetch });

    await expect(provider.initiate(request(), signal())).rejects.toBeInstanceOf(PaymentProviderError);
    await expect(provider.initiate(request(), signal())).resolves.toMatchObject({ outcome: 'accepted' });

    expect(mtn.tokenCalls()).toHaveLength(2);
    expect(mtn.apiCalls().map((call) => call.headers.authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('is dropped when MTN answers 401 to a status lookup', async () => {
    let first = true;
    const mtn = fakeMtn(() => {
      if (first) {
        first = false;
        return empty(401);
      }
      return json({ externalId: OUR_REF, status: 'PENDING' });
    });
    const provider = mtnProvider({ fetch: mtn.fetch });

    await expect(provider.lookupStatus(OUR_REF, signal())).rejects.toBeInstanceOf(PaymentProviderError);
    await expect(provider.lookupStatus(OUR_REF, signal())).resolves.not.toBeNull();
    expect(mtn.tokenCalls()).toHaveLength(2);
  });

  it('is kept when MTN refuses a request for another reason', async () => {
    const mtn = fakeMtn(() => json({ code: 'PAYER_NOT_FOUND' }, 400));
    const provider = mtnProvider({ fetch: mtn.fetch });

    await provider.initiate(request(), signal());
    await provider.initiate(request(), signal());
    expect(mtn.tokenCalls()).toHaveLength(1);
  });

  it.each([
    ['a refusal', () => json({ error: 'invalid_client' }, 401)],
    ['a server error', () => json({}, 500)],
    ['no access_token', () => json({ token_type: 'access_token', expires_in: 3600 })],
    ['an empty access_token', () => json({ access_token: '', expires_in: 3600 })],
    ['a non-string access_token', () => json({ access_token: 12345, expires_in: 3600 })],
    ['a non-JSON body', () => new Response('ok', { status: 200 })],
  ])('throws PaymentProviderError on %s, never calls requesttopay, and asks again next time', async (_case, answer) => {
    let failing = true;
    const mtn = fakeMtn(undefined, () => (failing ? answer() : json({ access_token: 'recovered', expires_in: 3600 })));
    const provider = mtnProvider({ fetch: mtn.fetch });

    await expect(provider.initiate(request(), signal())).rejects.toBeInstanceOf(PaymentProviderError);
    expect(mtn.apiCalls()).toEqual([]);

    failing = false;
    await expect(provider.initiate(request(), signal())).resolves.toMatchObject({ outcome: 'accepted' });
    expect(mtn.apiCalls()[0]?.headers.authorization).toBe('Bearer recovered');
  });

  it('fails every concurrent caller when the shared token request fails', async () => {
    const mtn = fakeMtn(undefined, () => json({}, 500));
    const provider = mtnProvider({ fetch: mtn.fetch });

    const results = await Promise.allSettled([provider.initiate(request(), signal()), provider.initiate(request({ ourRef: OTHER_REF }), signal())]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(mtn.tokenCalls()).toHaveLength(1);
  });
});

// --- Configuration ----------------------------------------------------------------------

describe('without credentials', () => {
  it.each([
    ['none', {}],
    ['no subscription key', { apiUser: 'u', apiKey: 'k' }],
    ['no API user', { subscriptionKey: 's', apiKey: 'k' }],
    ['no API key', { subscriptionKey: 's', apiUser: 'u' }],
    ['empty strings', { subscriptionKey: '', apiUser: '', apiKey: '' }],
  ])('with %s, reports itself unconfigured and never calls MTN', async (_case, credentials) => {
    const mtn = fakeMtn();
    const provider = new MtnMomoProvider({
      baseUrl: MTN_BASE_URL,
      targetEnvironment: 'sandbox',
      currency: 'EUR',
      ...credentials,
      callbackOrigin: API_ORIGIN,
      secret: TEST_SECRET,
      fetch: mtn.fetch,
    });

    expect(provider.configured).toBe(false);
    const initiated = await rejection(provider.initiate(request(), signal()));
    expect(initiated).toBeInstanceOf(PaymentProviderError);
    expect(initiated.message).toMatch(/not configured/);
    await expect(provider.lookupStatus(OUR_REF, signal())).rejects.toBeInstanceOf(PaymentProviderError);
    expect(mtn.calls).toEqual([]);
  });

  it('still verifies and reads callbacks, which need only the secret', () => {
    const provider = mtnProvider({ credentials: false });
    const body = { externalId: OUR_REF, status: 'SUCCESSFUL' };

    expect(provider.verifyWebhook(delivery(signedParams(provider), body))).toBe(true);
    expect(provider.parseWebhook(delivery(signedParams(provider), body))?.reportedStatus).toBe('succeeded');
  });

  it('is configured with all three', () => {
    expect(mtnProvider().configured).toBe(true);
  });
});

// --- Status lookup ----------------------------------------------------------------------

describe('lookupStatus', () => {
  it('GETs /collection/v1_0/requesttopay/{ref} with the token, environment and subscription key', async () => {
    const mtn = fakeMtn(() => json({ externalId: OUR_REF, status: 'PENDING' }));
    await mtnProvider({ fetch: mtn.fetch }).lookupStatus(OUR_REF, signal());

    const [call] = mtn.apiCalls();
    expect(call?.url).toBe(`${REQUEST_URL}/${OUR_REF}`);
    expect(call?.method).toBe('GET');
    expect(call?.body).toBeUndefined();
    expect(call?.headers).toStrictEqual({
      authorization: 'Bearer token-1',
      'x-target-environment': 'sandbox',
      'ocp-apim-subscription-key': MTN_CREDENTIALS.subscriptionKey,
    });
  });

  it('reads a 200 into an event, returning the body verbatim as the payload', async () => {
    const body = {
      amount: '19500',
      currency: 'EUR',
      financialTransactionId: '1234567890',
      externalId: OUR_REF,
      payer: { partyIdType: 'MSISDN', partyId: '250788123456' },
      status: 'SUCCESSFUL',
    };
    const mtn = fakeMtn(() => json(body));

    await expect(mtnProvider({ fetch: mtn.fetch }).lookupStatus(OUR_REF, signal())).resolves.toStrictEqual({
      event: {
        eventId: `${OUR_REF}:SUCCESSFUL`,
        eventType: 'requesttopay_status.SUCCESSFUL',
        ourRef: OUR_REF,
        providerRef: '1234567890',
        reportedStatus: 'succeeded',
        method: 'momo_mtn',
        failureReason: null,
        amount: 19_500,
      },
      payload: body,
    });
  });

  it('reports the same event id a callback for the same outcome carries', async () => {
    const body = { externalId: OUR_REF, status: 'SUCCESSFUL', financialTransactionId: '77' };
    const provider = mtnProvider({ fetch: fakeMtn(() => json(body)).fetch });

    const looked = await provider.lookupStatus(OUR_REF, signal());
    const called = provider.parseWebhook(delivery(signedParams(provider), body));
    expect(looked?.event.eventId).toBe(called?.eventId);
  });

  it('lower-cases an upper-case reference in the event, and escapes it in the path', async () => {
    const mtn = fakeMtn(() => json({ externalId: OUR_REF, status: 'FAILED', reason: 'APPROVAL_REJECTED' }));
    const found = await mtnProvider({ fetch: mtn.fetch }).lookupStatus(OUR_REF.toUpperCase(), signal());

    expect(found?.event.ourRef).toBe(OUR_REF);
    expect(found?.event.eventId).toBe(`${OUR_REF}:FAILED`);
    expect(mtn.apiCalls()[0]?.url).toBe(`${REQUEST_URL}/${OUR_REF.toUpperCase()}`);

    await mtnProvider({ fetch: mtn.fetch }).lookupStatus('a/b?c', signal());
    expect(mtn.apiCalls()[1]?.url).toBe(`${REQUEST_URL}/a%2Fb%3Fc`);
  });

  it('answers null on 404: MTN has never heard of the payment', async () => {
    const mtn = fakeMtn(() => json({ code: 'RESOURCE_NOT_FOUND' }, 404));
    await expect(mtnProvider({ fetch: mtn.fetch }).lookupStatus(OUR_REF, signal())).resolves.toBeNull();
  });

  it.each([400, 401, 403, 409, 500, 503, 202])('throws PaymentProviderError on %s', async (status) => {
    const mtn = fakeMtn(() => json({ code: 'SOMETHING' }, status));
    const error = await rejection(mtnProvider({ fetch: mtn.fetch }).lookupStatus(OUR_REF, signal()));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.message).toBe(`MTN MoMo answered ${status} (SOMETHING)`);
  });

  it.each([
    ['a non-JSON body', () => new Response('<html/>', { status: 200 })],
    ['an empty body', () => empty(200)],
    ['JSON without a status', () => json({ externalId: OUR_REF })],
    ['a numeric status', () => json({ externalId: OUR_REF, status: 1 })],
    ['a JSON array', () => json([{ status: 'SUCCESSFUL' }])],
    ['JSON null', () => json(null)],
  ])('throws PaymentProviderError on a 200 with %s', async (_case, answer) => {
    const error = await rejection(mtnProvider({ fetch: fakeMtn(answer).fetch }).lookupStatus(OUR_REF, signal()));
    expect(error).toBeInstanceOf(PaymentProviderError);
  });

  it('throws PaymentProviderError when MTN cannot be reached', async () => {
    const mtn = fakeMtn(() => Promise.reject(new TypeError('fetch failed')));
    await expect(mtnProvider({ fetch: mtn.fetch }).lookupStatus(OUR_REF, signal())).rejects.toThrow('MTN MoMo could not be reached: TypeError');
  });
});

// --- Webhooks -------------------------------------------------------------------------------

describe('verifyWebhook', () => {
  const body = { externalId: OUR_REF, status: 'SUCCESSFUL', financialTransactionId: '99' };

  it('accepts the signed URL for a payment with a body naming that payment', () => {
    const provider = mtnProvider();
    expect(provider.verifyWebhook(delivery(signedParams(provider), body))).toBe(true);
  });

  it('accepts an upper-case reference in the URL and in the body', () => {
    const provider = mtnProvider();
    const { signature } = signedParams(provider);

    expect(provider.verifyWebhook(delivery({ ourRef: OUR_REF.toUpperCase(), signature }, body))).toBe(true);
    expect(provider.verifyWebhook(delivery({ ourRef: OUR_REF, signature }, { ...body, externalId: OUR_REF.toUpperCase() }))).toBe(true);
  });

  it('refuses a tampered signature: one character changed, truncated, extended, or empty', () => {
    const provider = mtnProvider();
    const { signature = '' } = signedParams(provider);
    const flipped = `${signature.slice(0, 10)}${signature[10] === 'A' ? 'B' : 'A'}${signature.slice(11)}`;

    for (const tampered of [flipped, signature.slice(0, -1), `${signature}A`, '', signature.toUpperCase(), `${signature.slice(0, 42)}é`]) {
      expect(provider.verifyWebhook(delivery({ ourRef: OUR_REF, signature: tampered }, body))).toBe(false);
    }
  });

  it('refuses a genuine signature for another payment', () => {
    const provider = mtnProvider();
    const { signature } = signedParams(provider, OTHER_REF);

    expect(provider.verifyWebhook(delivery({ ourRef: OUR_REF, signature }, body))).toBe(false);
    expect(provider.verifyWebhook(delivery({ ourRef: OUR_REF, signature }, { ...body, externalId: OTHER_REF }))).toBe(false);
  });

  it('refuses the signed URL of one payment carrying a body about another', () => {
    const provider = mtnProvider();
    expect(provider.verifyWebhook(delivery(signedParams(provider), { ...body, externalId: OTHER_REF }))).toBe(false);
  });

  it.each([
    ['no externalId', { status: 'SUCCESSFUL' }],
    ['a numeric externalId', { status: 'SUCCESSFUL', externalId: 12345 }],
    ['a null externalId', { status: 'SUCCESSFUL', externalId: null }],
    ['an externalId with whitespace', { status: 'SUCCESSFUL', externalId: ` ${OUR_REF}` }],
    ['a JSON array', [{ externalId: OUR_REF }]],
    ['JSON null', null],
    ['a non-JSON body', `externalId=${OUR_REF}&status=SUCCESSFUL`],
    ['an empty body', ''],
    ['the externalId nested one level down', { data: { externalId: OUR_REF } }],
  ])('refuses the signed URL with %s', (_case, payload) => {
    const provider = mtnProvider();
    expect(provider.verifyWebhook(delivery(signedParams(provider), payload))).toBe(false);
  });

  it.each([
    ['a reference that is not a uuid', 'not-a-uuid'],
    ['an empty reference', ''],
    ['a uuid with a suffix', `${OUR_REF}x`],
    ['a uuid without dashes', OUR_REF.replaceAll('-', '')],
  ])('refuses %s, even signed', (_case, ourRef) => {
    const provider = mtnProvider();
    const signature = sign(deriveKey(TEST_SECRET, 'mtn-momo-callback'), ourRef.toLowerCase());
    expect(provider.verifyWebhook(delivery({ ourRef, signature }, { externalId: ourRef, status: 'SUCCESSFUL' }))).toBe(false);
  });

  it('refuses missing route parameters', () => {
    const provider = mtnProvider();
    const { signature } = signedParams(provider);

    expect(provider.verifyWebhook(delivery({ signature }, body))).toBe(false);
    expect(provider.verifyWebhook(delivery({ ourRef: OUR_REF }, body))).toBe(false);
    expect(provider.verifyWebhook(delivery({}, body))).toBe(false);
  });

  it('never throws, whatever the body bytes', () => {
    const provider = mtnProvider();
    const params = signedParams(provider);
    for (const raw of [Buffer.from([0xff, 0xfe, 0x00, 0x7b]), Buffer.from('{"externalId":"\\ud800"}'), Buffer.alloc(0), Buffer.from('{'.repeat(10_000))]) {
      expect(() => provider.verifyWebhook(delivery(params, raw))).not.toThrow();
      expect(provider.verifyWebhook(delivery(params, raw))).toBe(false);
    }
  });
});

describe('parseWebhook: MTN’s status in our vocabulary', () => {
  function parse(body: unknown, params?: Record<string, string | undefined>) {
    const provider = mtnProvider();
    return provider.parseWebhook(delivery(params ?? signedParams(provider), body));
  }

  it.each([
    ['SUCCESSFUL', 'succeeded'],
    ['FAILED', 'failed'],
    ['REJECTED', 'failed'],
    ['TIMEOUT', 'failed'],
    ['EXPIRED', 'failed'],
    ['CANCELLED', 'failed'],
    ['PENDING', 'pending'],
    ['ONGOING', 'pending'],
    ['CREATED', 'pending'],
  ])('reads %s as %s', (status, reportedStatus) => {
    expect(parse({ externalId: OUR_REF, status })).toMatchObject({
      eventId: `${OUR_REF}:${status}`,
      eventType: `requesttopay.${status}`,
      ourRef: OUR_REF,
      reportedStatus,
      method: 'momo_mtn',
    });
  });

  it('reads the status case-insensitively, keying the event on the upper-cased status', () => {
    expect(parse({ externalId: OUR_REF, status: 'successful' })).toMatchObject({ eventId: `${OUR_REF}:SUCCESSFUL`, reportedStatus: 'succeeded' });
  });

  it('reads an unknown status as an event asserting nothing', () => {
    expect(parse({ externalId: OUR_REF, status: 'AUTHORIZED' })).toMatchObject({ eventId: `${OUR_REF}:AUTHORIZED`, reportedStatus: null, failureReason: null });
  });

  it('keys a status it cannot use in an id as UNRECOGNISED, never echoing it', () => {
    for (const status of ['SUCC ESS', 'x'.repeat(33), 'DROP;TABLE', '', 'ÉCHEC', 'A:B']) {
      expect(parse({ externalId: OUR_REF, status })).toMatchObject({ eventId: `${OUR_REF}:UNRECOGNISED`, eventType: 'requesttopay.UNRECOGNISED', reportedStatus: null });
    }
  });

  it('keys the event on the URL’s reference, lower-cased, not the body’s', () => {
    const provider = mtnProvider();
    const { signature } = signedParams(provider);
    const event = provider.parseWebhook(delivery({ ourRef: OUR_REF.toUpperCase(), signature }, { externalId: OTHER_REF, status: 'SUCCESSFUL' }));
    expect(event?.ourRef).toBe(OUR_REF);
    expect(event?.eventId).toBe(`${OUR_REF}:SUCCESSFUL`);
  });

  it.each([
    ['a reference that is not a uuid', { ourRef: 'abc', signature: 'x' }, { status: 'SUCCESSFUL' }],
    ['no reference', { signature: 'x' }, { status: 'SUCCESSFUL' }],
    ['no status', undefined, { externalId: OUR_REF }],
    ['a numeric status', undefined, { externalId: OUR_REF, status: 200 }],
    ['a non-JSON body', undefined, 'status=SUCCESSFUL'],
    ['JSON null', undefined, null],
    ['a JSON string', undefined, 'SUCCESSFUL'],
  ])('reads nothing from %s', (_case, params, body) => {
    const provider = mtnProvider();
    const raw = typeof body === 'string' && body === 'SUCCESSFUL' ? JSON.stringify(body) : body;
    expect(provider.parseWebhook(delivery(params ?? signedParams(provider), raw))).toBeNull();
  });

  it.each([
    ['a string', '1234567890', '1234567890'],
    ['a number', 1234567890, '1234567890'],
    ['a string with surrounding whitespace', '  98765  ', '98765'],
    ['a string with separators', 'MP-2026.10:01_x', 'MP-2026.10:01_x'],
    ['an unsafe integer', 2 ** 60, null],
    ['a fractional number', 12.5, null],
    ['a string with spaces inside', '123 456', null],
    ['an over-long string', '9'.repeat(101), null],
    ['the longest string allowed', '9'.repeat(100), '9'.repeat(100)],
    ['markup', '<b>1</b>', null],
    ['nothing', undefined, null],
    ['null', null, null],
  ])('reads financialTransactionId as %s -> %s', (_case, financialTransactionId, providerRef) => {
    expect(parse({ externalId: OUR_REF, status: 'SUCCESSFUL', financialTransactionId })?.providerRef).toBe(providerRef);
  });

  it.each([
    ['a code string', 'APPROVAL_REJECTED', 'APPROVAL_REJECTED'],
    ['an object with a code', { code: 'PAYER_LIMIT_REACHED', message: 'The payer has reached the limit' }, 'PAYER_LIMIT_REACHED'],
    ['free text', 'The payer said no, rudely', 'FAILED'],
    ['an object without a code', { message: 'nope' }, 'FAILED'],
    ['a numeric code', { code: 7 }, 'FAILED'],
    ['nothing', undefined, 'FAILED'],
  ])('reads a failure reason given as %s as %s', (_case, reason, failureReason) => {
    expect(parse({ externalId: OUR_REF, status: 'FAILED', reason })?.failureReason).toBe(failureReason);
  });

  it('names the status as the reason for a failure MTN gave no reason for', () => {
    expect(parse({ externalId: OUR_REF, status: 'TIMEOUT' })?.failureReason).toBe('TIMEOUT');
  });

  it('carries no failure reason on a success or a pending event, even if MTN sends one', () => {
    expect(parse({ externalId: OUR_REF, status: 'SUCCESSFUL', reason: 'APPROVAL_REJECTED' })?.failureReason).toBeNull();
    expect(parse({ externalId: OUR_REF, status: 'PENDING', reason: 'APPROVAL_REJECTED' })?.failureReason).toBeNull();
  });

  it.each([
    ['"12000"', '12000', 12_000],
    ['"12000.0"', '12000.0', 12_000],
    ['"12000.00"', '12000.00', 12_000],
    ['12000', 12_000, 12_000],
    ['"0"', '0', 0],
    ['"12000.5"', '12000.5', null],
    ['12000.5', 12_000.5, null],
    ['"-5"', '-5', null],
    ['-5', -5, null],
    ['""', '', null],
    ['"1e4"', '1e4', null],
    ['" 12000"', ' 12000', null],
    ['"12,000"', '12,000', null],
    ['a 16-digit string', '1234567890123456', null],
    ['nothing', undefined, null],
    ['an object', { value: 12_000 }, null],
  ])('reads the amount %s as %s', (_case, amount, expected) => {
    expect(parse({ externalId: OUR_REF, status: 'SUCCESSFUL', amount })?.amount).toBe(expected);
  });

  it('never throws, whatever the body bytes', () => {
    const provider = mtnProvider();
    const params = signedParams(provider);
    for (const raw of [Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('{"status":"\\u0000"}'), Buffer.alloc(0), Buffer.from('[[[[[[')]) {
      expect(() => provider.parseWebhook(delivery(params, raw))).not.toThrow();
    }
  });
});
