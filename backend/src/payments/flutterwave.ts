import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type InitiatePaymentRequest,
  type InitiatePaymentResult,
  type PaymentMethod,
  type PaymentProvider,
  PaymentProviderError,
  type ProviderEvent,
  type ReportedStatus,
  type WebhookDelivery,
} from './provider.js';

/**
 * Flutterwave v4, mobile money in Rwanda (plan.md Task 25; spec §4.3, §6.19;
 * docs/payments-migration.md). Four calls, the first cached:
 *
 *   POST {idp}/token          client_credentials -> bearer token, ten minutes
 *   POST /customers           one per attempt; a placeholder email, never the booker's
 *   POST /payment-methods     mobile_money { country_code 250, network, national number }
 *   POST /charges             our_ref as `reference` and as the idempotency key
 *   GET  /charges?reference=  the status lookup; an empty list is "never heard of it"
 *
 * A Rwanda charge answers `pending` with a `payment_instruction`: the payer's
 * phone is prompted, exactly as MTN direct does, so the pay page is unchanged.
 * A `redirect_url` next action would need a page we do not have, so it is
 * refused as `redirect_required` rather than left waiting on nothing. A hard
 * decline is an HTTP 201 whose `data.status` is `failed` -- the status, not the
 * HTTP code, decides.
 *
 * Webhooks arrive at one static URL, `/api/webhooks/flutterwave`, signed:
 * `flutterwave-signature` is base64 HMAC-SHA256 of the raw body, keyed by the
 * dashboard's secret hash. The body's `data.reference` is our `our_ref`. The
 * event id is the reference and the status, as MTN's is, so a webhook and a
 * lookup reporting the same outcome are one event, delivered twice.
 */

export const FLUTTERWAVE_SANDBOX_URL = 'https://developersandbox-api.flutterwave.com';
export const FLUTTERWAVE_TOKEN_URL = 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
/** Where Flutterwave's webhooks arrive. The router mounts exactly this; the dashboard is given it. */
export const FLUTTERWAVE_WEBHOOK_PATH = '/api/webhooks/flutterwave';
export const FLUTTERWAVE_SIGNATURE_HEADER = 'flutterwave-signature';

/** Rwanda. The payer's number is sent without it, the code separately. */
const COUNTRY_CODE = '250';
const RWANDA_MOBILE = /^\+?2507\d{8}$/;
/** Flutterwave's network codes for Rwanda: the API names these two and refuses `ATL`. */
const NETWORKS: Partial<Record<PaymentMethod, string>> = { momo_mtn: 'MTN', momo_airtel: 'AIRTEL' };
const METHOD_OF_NETWORK: Record<string, PaymentMethod> = { MTN: 'momo_mtn', AIRTEL: 'momo_airtel' };

/** A token is refreshed this long before Flutterwave says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** The token request is shared, so it keeps its own deadline rather than borrowing one caller's. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Flutterwave's error types and processor codes: `MOBILE_MONEY_NETWORK_NOT_SUPPORTED`, `06`. */
const CODE = /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/;
/** `chg_…`, `cus_…`, `pmd_…`. */
const FLUTTERWAVE_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

export type FlutterwaveConfig = {
  baseUrl: string;
  tokenUrl: string;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  /** The dashboard's "Secret hash": the HMAC key webhooks are signed with. */
  webhookHash?: string | undefined;
  currency: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  now?: () => number;
};

type CachedToken = { value: string; refreshAt: number };

export class FlutterwaveProvider implements PaymentProvider {
  readonly id = 'flutterwave' as const;
  /** Mobile money only; cards are out of scope (docs/payments-migration.md). */
  readonly methods = ['momo_mtn', 'momo_airtel'] as const;
  readonly configured: boolean;

  readonly #config: FlutterwaveConfig;
  #token: CachedToken | null = null;
  #tokenRequest: Promise<string> | null = null;

  constructor(config: FlutterwaveConfig) {
    this.#config = config;
    this.configured = Boolean(config.clientId && config.clientSecret);
  }

  async initiate(request: InitiatePaymentRequest, signal: AbortSignal): Promise<InitiatePaymentResult> {
    const network = NETWORKS[request.method];
    if (network === undefined) return { outcome: 'rejected', reason: 'method_unavailable' };
    const digits = request.payerPhone.replace(/[^\d+]/g, '');
    if (!RWANDA_MOBILE.test(digits)) return { outcome: 'rejected', reason: 'phone_not_rwandan_mobile' };
    const nationalNumber = digits.replace(/^\+?250/, '');

    const token = await this.#accessToken(signal);

    const customer = await this.#create(token, '/customers', randomUUID(), request.ourRef, signal, {
      // Flutterwave requires an email; the booker's is not theirs to have.
      email: `payer-${request.ourRef}@example.com`,
      name: { first: 'Bookly', last: 'Client' },
    });
    if (customer.outcome === 'rejected') return customer;

    const method = await this.#create(token, '/payment-methods', randomUUID(), request.ourRef, signal, {
      type: 'mobile_money',
      mobile_money: { country_code: COUNTRY_CODE, network, phone_number: nationalNumber },
    });
    if (method.outcome === 'rejected') return method;

    const charge = await this.#post(token, '/charges', request.ourRef, request.ourRef, signal, {
      reference: request.ourRef,
      currency: this.#config.currency,
      customer_id: customer.id,
      payment_method_id: method.id,
      amount: request.amountRwf,
      meta: { booking_reference: request.bookingReference, kind: request.kind },
    });
    if (charge.res.status !== 200 && charge.res.status !== 201) return this.#refusal(charge.res, charge.body);

    const data = dataOf(charge.body);
    const status = typeof data?.status === 'string' ? data.status.toLowerCase() : null;
    const providerRef = idOf(data?.id);
    if (status === 'failed' || status === 'voided') {
      return { outcome: 'rejected', reason: failureCode(status, data?.processor_response) };
    }
    const nextAction = data?.next_action as { type?: unknown } | undefined;
    if (status === 'pending' && nextAction?.type === 'redirect_url') {
      return { outcome: 'rejected', reason: 'redirect_required' };
    }
    if (providerRef === null && status === null) {
      throw new PaymentProviderError(`Flutterwave answered ${charge.res.status} without a charge`);
    }
    // Pending, or already succeeded: either way the webhook or the lookup settles it.
    return { outcome: 'accepted', providerRef };
  }

  async lookupStatus(ourRef: string, signal: AbortSignal): Promise<{ event: ProviderEvent; payload: unknown } | null> {
    const token = await this.#accessToken(signal);
    const res = await this.#send(`${this.#base()}/charges?reference=${encodeURIComponent(ourRef)}`, {
      method: 'GET',
      headers: this.#headers(token, ourRef),
      signal,
    });
    if (res.status === 401) this.#token = null;
    const payload: unknown = await res.json().catch(() => undefined);
    if (res.status !== 200) throw new PaymentProviderError(`Flutterwave answered ${res.status}${describeError(payload)}`);

    const list = (payload as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(list)) throw new PaymentProviderError('Flutterwave answered a lookup without a list');
    const charge: unknown = list.find(
      (entry: unknown) => typeof (entry as { reference?: unknown } | null)?.reference === 'string' &&
        (entry as { reference: string }).reference.toLowerCase() === ourRef.toLowerCase(),
    );
    if (charge === undefined) return null;
    const event = readCharge(charge, 'charge_status');
    if (event === null) throw new PaymentProviderError('Flutterwave answered a charge it did not describe');
    return { event, payload: charge };
  }

  verifyWebhook(delivery: WebhookDelivery): boolean {
    const key = this.#config.webhookHash;
    if (!key) return false;
    const header = delivery.headers[FLUTTERWAVE_SIGNATURE_HEADER];
    const signature = Array.isArray(header) ? header[0] : header;
    if (typeof signature !== 'string' || signature === '') return false;
    const expected = Buffer.from(createHmac('sha256', key).update(delivery.rawBody).digest('base64'));
    const given = Buffer.from(signature.trim());
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  parseWebhook(delivery: WebhookDelivery): ProviderEvent | null {
    const body = parseJson(delivery.rawBody);
    if (typeof body !== 'object' || body === null) return null;
    const { type, data } = body as { type?: unknown; data?: unknown };
    if (typeof type !== 'string' || !/^charge\.[a-z_.]{1,60}$/.test(type)) return null;
    return readCharge(data, type);
  }

  #base(): string {
    return this.#config.baseUrl.replace(/\/+$/, '');
  }

  #headers(token: string, traceId: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'X-Trace-Id': traceId };
  }

  async #post(
    token: string,
    path: string,
    idempotencyKey: string,
    traceId: string,
    signal: AbortSignal,
    body: unknown,
  ): Promise<{ res: Response; body: unknown }> {
    const res = await this.#send(`${this.#base()}${path}`, {
      method: 'POST',
      headers: { ...this.#headers(token, traceId), 'Content-Type': 'application/json', 'X-Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
      signal,
    });
    return { res, body: await res.json().catch(() => undefined) };
  }

  /** A customer or a payment method: its id, or the refusal that ends the attempt. */
  async #create(
    token: string,
    path: string,
    idempotencyKey: string,
    traceId: string,
    signal: AbortSignal,
    body: unknown,
  ): Promise<{ outcome: 'created'; id: string } | Extract<InitiatePaymentResult, { outcome: 'rejected' }>> {
    const answer = await this.#post(token, path, idempotencyKey, traceId, signal, body);
    if (answer.res.status !== 200 && answer.res.status !== 201) return this.#refusal(answer.res, answer.body);
    const id = idOf(dataOf(answer.body)?.id);
    if (id === null) throw new PaymentProviderError(`Flutterwave answered ${path} without an id`);
    return { outcome: 'created', id };
  }

  /**
   * A non-2xx answer: a refusal when the request as made will never be
   * accepted, else a throw -- the attempt is then recorded as unavailable.
   */
  #refusal(res: Response, body: unknown): Extract<InitiatePaymentResult, { outcome: 'rejected' }> {
    if (res.status === 401) this.#token = null;
    // 400 and 422 are the request refused as made -- an unsupported network, a
    // malformed number; 409 an idempotency key reused with a different body.
    // None changes on a retry. Anything else may.
    if (res.status === 400 || res.status === 409 || res.status === 422) {
      return { outcome: 'rejected', reason: errorType(body) ?? `http_${res.status}` };
    }
    throw new PaymentProviderError(`Flutterwave answered ${res.status}${describeError(body)}`);
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.#config.fetch ?? fetch;
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      if (init.signal?.aborted) throw new PaymentProviderError('Flutterwave did not answer in time');
      throw new PaymentProviderError(`Flutterwave could not be reached: ${error instanceof Error ? error.name : 'error'}`);
    }
  }

  /**
   * A cached bearer token, or a new one. Concurrent callers share one request;
   * a caller that gives up stops waiting for it without cancelling it for the rest.
   */
  async #accessToken(signal: AbortSignal): Promise<string> {
    const { clientId, clientSecret } = this.#config;
    if (!clientId || !clientSecret) {
      throw new PaymentProviderError('Flutterwave is not configured: set FLUTTERWAVE_CLIENT_ID and FLUTTERWAVE_CLIENT_SECRET');
    }
    const now = (this.#config.now ?? Date.now)();
    if (this.#token !== null && now < this.#token.refreshAt) return this.#token.value;

    this.#tokenRequest ??= (async () => {
      try {
        const res = await this.#send(this.#config.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }).toString(),
          signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new PaymentProviderError(`Flutterwave refused a token: ${res.status}`);
        const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
        if (typeof body?.access_token !== 'string' || body.access_token === '') {
          throw new PaymentProviderError('Flutterwave answered a token request without a token');
        }
        const lifetimeMs = (typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 600) * 1000;
        const issuedAt = (this.#config.now ?? Date.now)();
        this.#token = { value: body.access_token, refreshAt: issuedAt + Math.max(lifetimeMs - TOKEN_REFRESH_MARGIN_MS, 0) };
        return body.access_token;
      } finally {
        this.#tokenRequest = null;
      }
    })();
    return abandonOnAbort(this.#tokenRequest, signal);
  }
}

/**
 * A v4 charge -- the webhook's `data` and a lookup's list entry are the same
 * shape -- in our vocabulary.
 */
export function readCharge(charge: unknown, source: string): ProviderEvent | null {
  if (typeof charge !== 'object' || charge === null) return null;
  const record = charge as Record<string, unknown>;
  if (typeof record.status !== 'string') return null;

  const status = /^[A-Za-z_]{1,32}$/.test(record.status) ? record.status.toUpperCase() : 'UNRECOGNISED';
  const reportedStatus = toReportedStatus(status);
  const ourRef = typeof record.reference === 'string' && UUID.test(record.reference) ? record.reference.toLowerCase() : null;
  const providerRef = idOf(record.id);
  // Without our reference the charge's own id keeps the event unique; matching then falls back to it.
  const subject = ourRef ?? providerRef;
  if (subject === null) return null;
  return {
    eventId: `${subject}:${status}`,
    eventType: `${source}.${status}`,
    ourRef,
    providerRef,
    reportedStatus,
    method: methodOf(record.payment_method),
    failureReason: reportedStatus === 'failed' ? failureCode(status.toLowerCase(), record.processor_response) : null,
    amount: amountOf(record.amount),
  };
}

function toReportedStatus(status: string): ReportedStatus | null {
  switch (status) {
    case 'SUCCEEDED':
    case 'SUCCESSFUL':
      return 'succeeded';
    case 'FAILED':
    case 'VOIDED':
    case 'CANCELLED':
      return 'failed';
    case 'PENDING':
      return 'pending';
    default:
      return null;
  }
}

/** `charge_failed_06`, `charge_voided`: the status and the processor's code, never its text. */
function failureCode(status: string, processorResponse: unknown): string {
  const code = (processorResponse as { code?: unknown } | null | undefined)?.code;
  const base = status === 'voided' ? 'charge_voided' : 'charge_failed';
  return typeof code === 'string' && CODE.test(code) ? `${base}_${code}` : base;
}

function methodOf(paymentMethod: unknown): PaymentMethod | null {
  const network = (paymentMethod as { mobile_money?: { network?: unknown } } | null | undefined)?.mobile_money?.network;
  return typeof network === 'string' ? (METHOD_OF_NETWORK[network.toUpperCase()] ?? null) : null;
}

function dataOf(body: unknown): Record<string, unknown> | undefined {
  const data = (body as { data?: unknown } | null | undefined)?.data;
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
}

function idOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return FLUTTERWAVE_ID.test(trimmed) ? trimmed : null;
}

/** Whole RWF: `1000` or `"1000"`; anything fractional or odd is no amount at all. */
function amountOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\d{1,15}(\.0+)?$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

/** `{ error: { type: "MOBILE_MONEY_NETWORK_NOT_SUPPORTED", … } }`: the type only. */
function errorType(body: unknown): string | null {
  const type = (body as { error?: { type?: unknown } } | null | undefined)?.error?.type;
  return typeof type === 'string' && CODE.test(type) ? type : null;
}

function describeError(body: unknown): string {
  const type = errorType(body);
  return type === null ? '' : ` (${type})`;
}

/** `promise`, or a rejection as soon as `signal` aborts -- leaving `promise` itself running. */
function abandonOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new PaymentProviderError('Flutterwave did not answer in time'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PaymentProviderError('Flutterwave did not answer in time'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
