import { type MailMessage, type MailProvider, MailRejectedError, type MailSendResult } from './provider.js';

/**
 * Brevo (formerly Sendinblue) over its transactional REST API
 * (`POST /v3/smtp/email`). Plain `fetch`, like the Resend provider.
 *
 * Brevo documents no idempotency key, so unlike Resend a retry after a crash
 * that followed a successful send can deliver the message twice. The outbox is
 * at-least-once either way; with Brevo that "at least" is visible, rarely.
 */

const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';

export type BrevoOptions = {
  apiKey: string;
  /** `Name <address>` or a bare address, as MAIL_FROM holds it. */
  from: string;
  replyTo?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

type Sender = { email: string; name?: string };

export class BrevoMailProvider implements MailProvider {
  readonly #options: BrevoOptions;
  readonly #sender: Sender;

  constructor(options: BrevoOptions) {
    this.#options = options;
    // Parsed once, at boot: a MAIL_FROM Brevo cannot take fails the start, not
    // every send.
    this.#sender = parseSender(options.from);
  }

  async send(message: MailMessage, signal?: AbortSignal): Promise<MailSendResult> {
    const { apiKey, replyTo, fetch: fetchImpl = fetch } = this.#options;
    const res = await fetchImpl(BREVO_SEND_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: this.#sender,
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
        ...(replyTo === undefined ? {} : { replyTo: { email: replyTo } }),
      }),
      signal,
    });

    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { messageId?: unknown } | null;
      return { providerMessageId: typeof body?.messageId === 'string' ? body.messageId : null };
    }

    // The status and Brevo's error code only. Its message can quote the
    // recipient's address, and this text lands in `last_error`, the logs and
    // the photographer's alert.
    const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof body?.code === 'string' && /^[a-z_]{1,64}$/.test(body.code) ? ` (${body.code})` : '';
    const summary = `Brevo answered ${res.status}${code}`;
    // 400 is the message itself being refused. Anything else -- a bad key, no
    // credits left, a rate limit, an outage -- can come right later.
    if (res.status === 400) throw new MailRejectedError(summary);
    throw new Error(summary);
  }
}

/** `Name <address>`, `"Name" <address>` or a bare address. */
export function parseSender(from: string): Sender {
  const trimmed = from.trim();
  const bare = /^[^\s<>@]+@[^\s<>@]+$/;
  if (bare.test(trimmed)) return { email: trimmed };
  const named = /^"?([^"<>]*?)"?\s*<([^\s<>@]+@[^\s<>@]+)>$/.exec(trimmed);
  if (named?.[2] !== undefined) {
    const name = named[1]?.trim();
    return name ? { email: named[2], name } : { email: named[2] };
  }
  throw new Error('MAIL_FROM must be "Name <address>" or a bare address to send through Brevo');
}
