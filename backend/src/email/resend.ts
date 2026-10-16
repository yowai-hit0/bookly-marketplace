import { createHash } from 'node:crypto';
import { type MailMessage, type MailProvider, MailRejectedError, type MailSendResult } from './provider.js';

/**
 * Resend over its REST API (`POST /emails`). Plain `fetch` rather than the SDK:
 * one endpoint, and one dependency fewer.
 *
 * The outbox row's dedupe key travels as `Idempotency-Key`, so a retry after a
 * crash that followed a successful send is answered with the original message,
 * not a second one (Resend keeps keys for 24 hours).
 */

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
/** Resend's limit on an idempotency key. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

export type ResendOptions = {
  apiKey: string;
  from: string;
  replyTo?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

export class ResendMailProvider implements MailProvider {
  readonly #options: ResendOptions;

  constructor(options: ResendOptions) {
    this.#options = options;
  }

  async send(message: MailMessage, signal?: AbortSignal): Promise<MailSendResult> {
    const { apiKey, from, replyTo, fetch: fetchImpl = fetch } = this.#options;
    const res = await fetchImpl(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey(message.idempotencyKey),
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(replyTo === undefined ? {} : { reply_to: replyTo }),
      }),
      signal,
    });

    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
      return { providerMessageId: typeof body?.id === 'string' ? body.id : null };
    }

    // The status and Resend's error name only. Its message can quote the
    // recipient's address, and this text lands in `last_error`, the logs and
    // the photographer's alert.
    const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === 'string' && /^[a-z_]{1,64}$/.test(body.name) ? ` (${body.name})` : '';
    const summary = `Resend answered ${res.status}${name}`;
    // 400 and 422 are the message itself being refused. Anything else -- a bad
    // key, a rate limit, an outage, an idempotency clash -- can come right later.
    if (res.status === 400 || res.status === 422) throw new MailRejectedError(summary);
    throw new Error(summary);
  }
}

/** The dedupe key as it is, or its SHA-256 when too long for the header. */
function idempotencyKey(key: string): string {
  return key.length <= IDEMPOTENCY_KEY_MAX_LENGTH ? key : createHash('sha256').update(key).digest('hex');
}
