import { deriveKey, sign, verifySignature } from './keys.js';
import {
  type InitiatePaymentRequest,
  type InitiatePaymentResult,
  type PaymentProvider,
  PaymentProviderError,
  type ProviderEvent,
  type ReportedStatus,
  type WebhookDelivery,
} from './provider.js';

/**
 * MTN MoMo Collections, called directly (plan.md Task 16; spec §4.3, the
 * development phase). Three calls:
 *
 *   POST /collection/token/                     Basic apiUser:apiKey -> bearer token, cached
 *   POST /collection/v1_0/requesttopay          202: the payer's phone is prompted
 *   GET  /collection/v1_0/requesttopay/{ref}    PENDING | SUCCESSFUL | FAILED, with a reason
 *
 * `our_ref` is the `X-Reference-Id` and the `externalId`: MTN has no id of its
 * own for the request until money moves, when `financialTransactionId`
 * appears, and that becomes `provider_ref`.
 *
 * MTN signs nothing it sends. Its callback is a bare PUT or POST of the status
 * body to the `X-Callback-Url` we supplied, so the URL itself carries the proof:
 * `/api/webhooks/mtn-momo/<our_ref>/<HMAC(our_ref)>`, keyed from
 * `SESSION_SECRET`. Only MTN is ever given that URL, a forger cannot compute it
 * for any other payment, and the body's `externalId` must name the same payment
 * the URL does. A body that fails either check is recorded and never applied.
 *
 * The sandbox answers in EUR and never delivers callbacks; there, a payment
 * settles through the status lookup (`reconcile.ts`).
 */

export const MTN_MOMO_SANDBOX_URL = 'https://sandbox.momodeveloper.mtn.com';
/** Where MTN's callbacks arrive. The router mounts exactly this. */
export const MTN_MOMO_CALLBACK_PATH = '/api/webhooks/mtn-momo';

/** A token is refreshed this long before MTN says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** The token request is shared, so it keeps its own deadline rather than borrowing one caller's. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** MTN's error and reason codes: `PAYER_NOT_FOUND`, `APPROVAL_REJECTED`. */
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type MtnMomoConfig = {
  baseUrl: string;
  /** `sandbox`, or the market's production environment, e.g. `mtnrwanda`. */
  targetEnvironment: string;
  /** `EUR` in the sandbox, which accepts nothing else; `RWF` in production. */
  currency: string;
  subscriptionKey?: string | undefined;
  apiUser?: string | undefined;
  apiKey?: string | undefined;
  /** The API's public origin, which MTN calls back on. */
  callbackOrigin: string;
  /** `SESSION_SECRET`; the callback key is derived from it. */
  secret: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  now?: () => number;
};

type CachedToken = { value: string; refreshAt: number };

export class MtnMomoProvider implements PaymentProvider {
  readonly id = 'mtn_momo_direct' as const;
  /** MTN direct collects MTN MoMo and nothing else (spec §6.19). */
  readonly methods = ['momo_mtn'] as const;
  readonly configured: boolean;

  readonly #config: MtnMomoConfig;
  readonly #callbackKey: Buffer;
  #token: CachedToken | null = null;
  #tokenRequest: Promise<string> | null = null;

  constructor(config: MtnMomoConfig) {
    this.#config = config;
    this.#callbackKey = deriveKey(config.secret, 'mtn-momo-callback');
    this.configured = Boolean(config.subscriptionKey && config.apiUser && config.apiKey);
  }

  /** The URL MTN calls back on for one payment: our reference, signed. */
  callbackUrl(ourRef: string): string {
    const ref = ourRef.toLowerCase();
    return new URL(`${MTN_MOMO_CALLBACK_PATH}/${ref}/${sign(this.#callbackKey, ref)}`, this.#config.callbackOrigin).toString();
  }

  async initiate(request: InitiatePaymentRequest, signal: AbortSignal): Promise<InitiatePaymentResult> {
    if (request.method !== 'momo_mtn') return { outcome: 'rejected', reason: 'method_unavailable' };
    const token = await this.#accessToken(signal);
    const res = await this.#send(`${this.#base()}/collection/v1_0/requesttopay`, {
      method: 'POST',
      headers: {
        ...this.#headers(token),
        'Content-Type': 'application/json',
        'X-Reference-Id': request.ourRef,
        'X-Callback-Url': this.callbackUrl(request.ourRef),
      },
      body: JSON.stringify({
        amount: String(request.amountRwf),
        currency: this.#config.currency,
        externalId: request.ourRef,
        payer: { partyIdType: 'MSISDN', partyId: request.payerPhone.replace(/\D/g, '') },
        payerMessage: `Bookly ${request.bookingReference}`,
        payeeNote: `Bookly ${request.bookingReference}`,
      }),
      signal,
    });

    if (res.status === 202) return { outcome: 'accepted', providerRef: null };
    const code = await errorCode(res);
    if (res.status === 401) this.#token = null;
    // 400 is the request refused as made -- an unknown payer, a malformed number;
    // 409 a reference MTN has seen, which a fresh uuid never is. Neither changes
    // on a retry of the same request. Anything else may.
    if (res.status === 400 || res.status === 409) return { outcome: 'rejected', reason: code ?? `http_${res.status}` };
    throw new PaymentProviderError(`MTN MoMo answered ${res.status}${code === null ? '' : ` (${code})`}`);
  }

  async lookupStatus(ourRef: string, signal: AbortSignal): Promise<{ event: ProviderEvent; payload: unknown } | null> {
    const token = await this.#accessToken(signal);
    const res = await this.#send(`${this.#base()}/collection/v1_0/requesttopay/${encodeURIComponent(ourRef)}`, {
      method: 'GET',
      headers: this.#headers(token),
      signal,
    });
    if (res.status === 404) return null;
    if (res.status === 401) this.#token = null;
    if (res.status !== 200) {
      const code = await errorCode(res);
      throw new PaymentProviderError(`MTN MoMo answered ${res.status}${code === null ? '' : ` (${code})`}`);
    }
    const payload: unknown = await res.json().catch(() => undefined);
    const event = readEvent(ourRef.toLowerCase(), payload, 'requesttopay_status');
    if (event === null) throw new PaymentProviderError('MTN MoMo answered a status it did not describe');
    return { event, payload };
  }

  verifyWebhook(delivery: WebhookDelivery): boolean {
    const ourRef = delivery.params.ourRef;
    const signature = delivery.params.signature;
    if (ourRef === undefined || !UUID.test(ourRef) || signature === undefined) return false;
    if (!verifySignature(this.#callbackKey, ourRef.toLowerCase(), signature)) return false;
    // The URL is the signature; the body must be about the payment it signs.
    const externalId = (parseJson(delivery.rawBody) as { externalId?: unknown } | undefined)?.externalId;
    return typeof externalId === 'string' && externalId.toLowerCase() === ourRef.toLowerCase();
  }

  parseWebhook(delivery: WebhookDelivery): ProviderEvent | null {
    const ourRef = delivery.params.ourRef;
    if (ourRef === undefined || !UUID.test(ourRef)) return null;
    return readEvent(ourRef.toLowerCase(), parseJson(delivery.rawBody), 'requesttopay');
  }

  #base(): string {
    return this.#config.baseUrl.replace(/\/+$/, '');
  }

  #headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'X-Target-Environment': this.#config.targetEnvironment,
      'Ocp-Apim-Subscription-Key': this.#config.subscriptionKey ?? '',
    };
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.#config.fetch ?? fetch;
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      if (init.signal?.aborted) throw new PaymentProviderError('MTN MoMo did not answer in time');
      throw new PaymentProviderError(`MTN MoMo could not be reached: ${error instanceof Error ? error.name : 'error'}`);
    }
  }

  /**
   * A cached bearer token, or a new one. Concurrent callers share one request;
   * a caller that gives up stops waiting for it without cancelling it for the rest.
   */
  async #accessToken(signal: AbortSignal): Promise<string> {
    const { subscriptionKey, apiUser, apiKey } = this.#config;
    if (!subscriptionKey || !apiUser || !apiKey) {
      throw new PaymentProviderError('MTN MoMo is not configured: set MTN_MOMO_SUBSCRIPTION_KEY, MTN_MOMO_API_USER and MTN_MOMO_API_KEY');
    }
    const now = (this.#config.now ?? Date.now)();
    if (this.#token !== null && now < this.#token.refreshAt) return this.#token.value;

    this.#tokenRequest ??= (async () => {
      try {
        const res = await this.#send(`${this.#base()}/collection/token/`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${apiUser}:${apiKey}`).toString('base64')}`,
            'Ocp-Apim-Subscription-Key': subscriptionKey,
          },
          signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new PaymentProviderError(`MTN MoMo refused a token: ${res.status}`);
        const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
        if (typeof body?.access_token !== 'string' || body.access_token === '') {
          throw new PaymentProviderError('MTN MoMo answered a token request without a token');
        }
        const lifetimeMs = (typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600) * 1000;
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
 * MTN's status body -- the callback and the lookup send the same shape -- in our
 * vocabulary. The event id is the reference and the status, so a callback and a
 * lookup reporting the same outcome are one event, delivered twice.
 */
export function readEvent(ourRef: string, body: unknown, source: 'requesttopay' | 'requesttopay_status'): ProviderEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.status !== 'string') return null;

  const status = /^[A-Za-z_]{1,32}$/.test(record.status) ? record.status.toUpperCase() : 'UNRECOGNISED';
  const reportedStatus = toReportedStatus(status);
  return {
    eventId: `${ourRef}:${status}`,
    eventType: `${source}.${status}`,
    ourRef,
    providerRef: providerRefOf(record.financialTransactionId),
    reportedStatus,
    method: 'momo_mtn',
    failureReason: reportedStatus === 'failed' ? (reasonOf(record.reason) ?? status) : null,
    amount: amountOf(record.amount),
  };
}

function toReportedStatus(status: string): ReportedStatus | null {
  switch (status) {
    case 'SUCCESSFUL':
      return 'succeeded';
    case 'FAILED':
    case 'REJECTED':
    case 'TIMEOUT':
    case 'EXPIRED':
    case 'CANCELLED':
      return 'failed';
    case 'PENDING':
    case 'ONGOING':
    case 'CREATED':
      return 'pending';
    default:
      return null;
  }
}

function providerRefOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(trimmed) ? trimmed : null;
}

/** `"APPROVAL_REJECTED"` or `{ "code": "APPROVAL_REJECTED", "message": … }`: the code only. */
function reasonOf(value: unknown): string | null {
  const code = typeof value === 'object' && value !== null ? (value as { code?: unknown }).code : value;
  return typeof code === 'string' && CODE.test(code) ? code : null;
}

/** `"12000"`, `"12000.0"` or `12000`; anything fractional or odd is no amount at all. */
function amountOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\d{1,15}(\.0+)?$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

/** `promise`, or a rejection as soon as `signal` aborts -- leaving `promise` itself running. */
function abandonOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new PaymentProviderError('MTN MoMo did not answer in time'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PaymentProviderError('MTN MoMo did not answer in time'));
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

async function errorCode(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
  return typeof body?.code === 'string' && CODE.test(body.code) ? body.code : null;
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
