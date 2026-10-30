import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type BrowserCheckoutRequest,
  type InitiatePaymentRequest,
  type InitiatePaymentResult,
  type InlineCardConfig,
  type PaymentMethod,
  type PaymentProvider,
  PaymentProviderError,
  type ProviderEvent,
  type ReportedStatus,
  type WebhookDelivery,
  reportedCurrency,
} from './provider.js';

/**
 * Cards, through Flutterwave v3 Inline (user decisions, 2026-10-30; provider id
 * `flutterwave_checkout`). The payer types the card into Flutterwave's own modal
 * on our page, so no card number ever reaches this server (v4 direct charge
 * would have had us collect and encrypt it: PCI DSS SAQ D, refused).
 *
 *   initiate                      no call at all: Inline starts in the browser.
 *                                 The payment row is the attempt (payments/initiate.ts).
 *   browserCheckout               the `FlutterwaveCheckout({...})` config, every value
 *                                 the server's: public key, `tx_ref = our_ref`, the
 *                                 row's amount, RWF, cards only, the payer, the
 *                                 return URL on WEB_ORIGIN, the session length.
 *   GET /v3/transactions/verify_by_reference?tx_ref=   the status lookup (reconcile)
 *   GET /v3/transactions/:id/verify                     one transaction by its id
 *   POST /api/webhooks/flutterwave-checkout             `verif-hash` = the dashboard's
 *                                                       secret hash, compared in
 *                                                       constant time
 *
 * What the docs say and this relies on (developer.flutterwave.com/v3.0, read
 * 2026-10-30):
 *  - Inline: `public_key`, `tx_ref`, `amount`, `currency`, `payment_options`,
 *    `redirect_url` ("has higher precedence than the callback"), `customer.email`
 *    required with `name` and `phone_number`, `customizations.title`, and
 *    `configurations.session_duration` (minutes, at most 1440). The redirect
 *    appends `tx_ref`, `transaction_id` and `status`; none of it is proof.
 *  - Verify on the server, always: "status of the transaction is `successful`",
 *    the currency, the amount, the `tx_ref`. We require the amount EXACTLY
 *    (decision 3: we asked for it, and the platform absorbs the card fee), not
 *    the docs' "greater than or equal".
 *  - Webhooks: `verif-hash` carries the secret hash as set in the dashboard -- a
 *    static shared secret, not an HMAC of the body -- so a delivery is only a
 *    claim and is re-verified through the API before anything is applied
 *    (`reverify`). `charge.completed` is sent on success and "for each failed
 *    attempt"; the page "stays open so the customer can try again" under the
 *    same `tx_ref`. So a FAILED transaction is one try (`attemptOnly`), never the
 *    end of the payment.
 *  - A not-found verify answers `status: "error"`, `data: null`, "No transaction
 *    was found for this id". Only that shape is "never heard of it"; any other
 *    error throws, and the payment keeps waiting.
 *
 * Assumptions the docs leave open, each with the safe choice (marketplace-spec.md
 * "Cards as built", T3.6 sandbox run): which transaction `verify_by_reference`
 * answers when one `tx_ref` has several (a lookup failure keeps the payment
 * waiting; a client's `transaction_id` and the webhook verify by id); that
 * `session_duration` really closes the modal (the reconciler closes the payment
 * only `CARD_SESSION_GRACE_SECONDS` after the session we handed out ends); and
 * that a closed modal reopened with the same `tx_ref` is accepted (the in-progress
 * answer reuses it, as the brief asks).
 */

export const FLUTTERWAVE_V3_URL = 'https://api.flutterwave.com';
/** Where Flutterwave v3's webhooks arrive. The router mounts exactly this; the dashboard is given it. */
export const FLUTTERWAVE_CHECKOUT_WEBHOOK_PATH = '/api/webhooks/flutterwave-checkout';
export const VERIF_HASH_HEADER = 'verif-hash';
/** Rwanda only (marketplace-spec.md Product decisions). */
export const CARD_CURRENCY = 'RWF';

/**
 * How long one card payment's checkout may stay open, from its initiation. A
 * developer default, not a spec value: long enough to type a card and pass
 * 3-D Secure, short enough that an abandoned modal stops mattering soon.
 */
export const CARD_SESSION_SECONDS = 15 * 60;
/**
 * The least session worth handing out: Inline counts in whole minutes, and the
 * session it is given never runs past `initiated_at + CARD_SESSION_SECONDS`. Less
 * than this left, and an in-progress card payment is not reopened; a new one starts.
 */
export const CARD_REUSE_MIN_SECONDS = 60;
/**
 * After the session ends, how long a payment that nothing has paid still waits
 * before the reconciler closes it: a 3-D Secure step finishing at the last
 * second, a clock apart from Flutterwave's. A late success still revives it
 * (payments/webhooks.ts `locallyFailed`).
 */
export const CARD_SESSION_GRACE_SECONDS = 5 * 60;
/** The `failure_reason` of a card payment whose session ended unpaid. Ours, so revivable. */
export const CARD_SESSION_EXPIRED = 'card_session_expired';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Flutterwave's transaction ids are integers. */
const TRANSACTION_ID = /^\d{1,20}$/;
/**
 * `provider_ref` is unique across every provider (`payment_provider_ref_unique`),
 * and MTN's `financialTransactionId` is digits too: the prefix keeps a card's
 * transaction id from ever colliding with one. The dashboard finds it by the digits.
 */
export const PROVIDER_REF_PREFIX = 'FLW-';
const SESSION_MAX_MINUTES = 1440;

export type FlutterwaveCheckoutConfig = {
  /** `https://api.flutterwave.com`; test or live is the keys' business. */
  baseUrl: string;
  /** `FLWSECK…`: server only. */
  secretKey?: string | undefined;
  /** `FLWPUBK…`: the one key the browser sees. */
  publicKey?: string | undefined;
  /** The dashboard's secret hash, sent back in `verif-hash`. */
  webhookHash?: string | undefined;
  /** WEB_ORIGIN: where the payer returns. */
  webOrigin: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

export class FlutterwaveCheckoutProvider implements PaymentProvider {
  readonly id = 'flutterwave_checkout' as const;
  readonly methods = ['card'] as const satisfies readonly PaymentMethod[];
  readonly configured: boolean;
  readonly currency = CARD_CURRENCY;
  readonly sessionClosesAfterSeconds = CARD_SESSION_SECONDS + CARD_SESSION_GRACE_SECONDS;

  readonly #config: FlutterwaveCheckoutConfig;

  constructor(config: FlutterwaveCheckoutConfig) {
    this.#config = config;
    this.configured = Boolean(config.secretKey && config.publicKey && config.webhookHash);
  }

  /** No call: the browser opens the checkout. The payment row, already written, is the attempt. */
  async initiate(request: InitiatePaymentRequest): Promise<InitiatePaymentResult> {
    if (request.method !== 'card') return { outcome: 'rejected', reason: 'method_unavailable' };
    if (!this.configured) {
      throw new PaymentProviderError('Flutterwave cards are not configured: set FLUTTERWAVE_V3_SECRET_KEY, FLUTTERWAVE_V3_PUBLIC_KEY and FLUTTERWAVE_V3_WEBHOOK_HASH');
    }
    return { outcome: 'accepted', providerRef: null };
  }

  browserCheckout(request: BrowserCheckoutRequest): InlineCardConfig {
    const { publicKey } = this.#config;
    if (!publicKey) throw new PaymentProviderError('Flutterwave cards are not configured: no public key');
    if (!request.returnPath.startsWith('/') || request.returnPath.startsWith('//') || request.returnPath.includes('\\')) {
      // Built by our routes from validated segments; anything else is a bug, not input.
      throw new Error('A card return path must be a path on WEB_ORIGIN');
    }
    const minutes = Math.min(Math.max(Math.floor(request.sessionSeconds / 60), 1), SESSION_MAX_MINUTES);
    return {
      public_key: publicKey,
      tx_ref: request.ourRef,
      amount: request.amountRwf,
      currency: CARD_CURRENCY,
      payment_options: 'card',
      redirect_url: `${this.#config.webOrigin.replace(/\/+$/, '')}${request.returnPath}`,
      customer: {
        email: request.payer.email,
        name: request.payer.name,
        ...(request.payer.phone === null ? {} : { phone_number: request.payer.phone }),
      },
      customizations: { title: request.title },
      configurations: { session_duration: minutes },
    };
  }

  async lookupStatus(ourRef: string, signal: AbortSignal): Promise<{ event: ProviderEvent; payload: unknown } | null> {
    const data = await this.#get(`/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(ourRef)}`, signal);
    if (data === null) return null;
    const event = readTransaction(data, 'verify_by_reference');
    if (event === null) throw new PaymentProviderError('Flutterwave answered a transaction it did not describe');
    // Asked by reference, answered about another: unusable, never applied.
    if (event.ourRef !== ourRef.toLowerCase()) throw new PaymentProviderError('Flutterwave answered a lookup with another tx_ref');
    return { event, payload: data };
  }

  async lookupTransaction(transactionId: string, signal: AbortSignal): Promise<{ event: ProviderEvent; payload: unknown } | null> {
    const id = transactionId.startsWith(PROVIDER_REF_PREFIX) ? transactionId.slice(PROVIDER_REF_PREFIX.length) : transactionId;
    if (!TRANSACTION_ID.test(id)) return null;
    const data = await this.#get(`/v3/transactions/${id}/verify`, signal);
    if (data === null) return null;
    const event = readTransaction(data, 'verify');
    if (event === null) throw new PaymentProviderError('Flutterwave answered a transaction it did not describe');
    // Asked by id, answered about another: unusable.
    if (event.providerRef !== `${PROVIDER_REF_PREFIX}${id}`) throw new PaymentProviderError('Flutterwave answered a verify with another id');
    return { event, payload: data };
  }

  /** The claim's transaction, from the API: by its id when it names one, else by its `tx_ref`. */
  async reverify(claim: ProviderEvent, signal: AbortSignal): Promise<{ event: ProviderEvent; payload: unknown } | null> {
    if (claim.providerRef !== null) return this.lookupTransaction(claim.providerRef, signal);
    if (claim.ourRef !== null) return this.lookupStatus(claim.ourRef, signal);
    return null;
  }

  verifyWebhook(delivery: WebhookDelivery): boolean {
    const key = this.#config.webhookHash;
    if (!key) return false;
    const header = delivery.headers[VERIF_HASH_HEADER];
    const given = Array.isArray(header) ? header[0] : header;
    if (typeof given !== 'string' || given === '') return false;
    // Digests of both, so the comparison is constant-time whatever the lengths.
    return timingSafeEqual(digest(given), digest(key));
  }

  parseWebhook(delivery: WebhookDelivery): ProviderEvent | null {
    const body = parseJson(delivery.rawBody);
    if (typeof body !== 'object' || body === null) return null;
    const { event, data } = body as { event?: unknown; data?: unknown };
    if (typeof event !== 'string' || !/^charge\.[a-z_.]{1,60}$/.test(event)) return null;
    return readTransaction(data, event);
  }

  async #get(path: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    const { secretKey } = this.#config;
    if (!secretKey) throw new PaymentProviderError('Flutterwave cards are not configured: no secret key');
    const fetchImpl = this.#config.fetch ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(`${this.#config.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${secretKey}`, Accept: 'application/json' },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new PaymentProviderError('Flutterwave did not answer in time');
      throw new PaymentProviderError(`Flutterwave could not be reached: ${error instanceof Error ? error.name : 'error'}`);
    }
    const body = (await res.json().catch(() => undefined)) as { status?: unknown; message?: unknown; data?: unknown } | undefined;
    if (res.status === 200 && body?.status === 'success' && typeof body.data === 'object' && body.data !== null && !Array.isArray(body.data)) {
      return body.data as Record<string, unknown>;
    }
    if (notFound(res.status, body)) return null;
    // Never the message: it is Flutterwave's text, and may quote what we sent.
    throw new PaymentProviderError(`Flutterwave answered ${res.status}`);
  }
}

/** "No transaction was found for this id": the one answer that means never heard of it. */
function notFound(status: number, body: { status?: unknown; message?: unknown; data?: unknown } | undefined): boolean {
  return (
    (status === 400 || status === 404) &&
    body?.status === 'error' &&
    (body.data === null || body.data === undefined) &&
    typeof body.message === 'string' &&
    /no transaction/i.test(body.message)
  );
}

/**
 * A v3 transaction -- a webhook's `data` and a verify's `data` are the same
 * shape -- in our vocabulary. A success counts only with an amount and an RWF-
 * shaped currency stated: one that names neither is no success at all (the
 * strict rule of the card decision), while a wrong amount or currency is read
 * as stated, so the webhook path ignores and logs it (`amount_mismatch`,
 * `currency_mismatch`).
 */
export function readTransaction(transaction: unknown, source: string): ProviderEvent | null {
  if (typeof transaction !== 'object' || transaction === null || Array.isArray(transaction)) return null;
  const record = transaction as Record<string, unknown>;
  if (typeof record.status !== 'string') return null;

  const status = /^[A-Za-z_ ]{1,32}$/.test(record.status) ? record.status.trim().toUpperCase().replace(/ /g, '_') : 'UNRECOGNISED';
  const ourRef = typeof record.tx_ref === 'string' && UUID.test(record.tx_ref) ? record.tx_ref.toLowerCase() : null;
  const transactionId = transactionIdOf(record.id);
  const providerRef = transactionId === null ? null : `${PROVIDER_REF_PREFIX}${transactionId}`;
  if (ourRef === null && providerRef === null) return null;

  const amount = amountOf(record.amount);
  const currency = reportedCurrency(record.currency);
  let reportedStatus = toReportedStatus(status);
  let eventType = `${source}.${status}`;
  if (reportedStatus === 'succeeded' && (amount === null || currency === null)) {
    // Nothing to match against what we asked for: not a success.
    reportedStatus = null;
    eventType = `${eventType}.UNVERIFIABLE`;
  }
  return {
    // The same transaction, however it reached us (webhook verified, lookup), is one event.
    eventId: transactionId === null ? `ref:${ourRef ?? ''}:${status}` : `${transactionId}:${status}`,
    eventType,
    ourRef,
    providerRef,
    reportedStatus,
    method: record.payment_type === 'card' ? 'card' : null,
    failureReason: reportedStatus === 'failed' ? 'card_attempt_failed' : null,
    amount,
    currency,
    ...(reportedStatus === 'failed' ? { attemptOnly: true } : {}),
  };
}

function toReportedStatus(status: string): ReportedStatus | null {
  switch (status) {
    case 'SUCCESSFUL':
      return 'succeeded';
    case 'FAILED':
      return 'failed';
    case 'PENDING':
      return 'pending';
    default:
      return null;
  }
}

function transactionIdOf(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && TRANSACTION_ID.test(value) ? value.replace(/^0+(?=\d)/, '') : null;
}

/** Whole RWF: `1000` or `"1000"` (or `1000.00`); anything fractional or odd is no amount at all. */
function amountOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\d{1,15}(\.0+)?$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
