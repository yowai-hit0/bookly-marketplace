/**
 * The seam between rendered email and whoever delivers it (plan.md Stack
 * decisions: Resend behind a `MailProvider` interface, swappable in one file).
 */

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Stable across retries of one outbox row, so a provider that honours it
   * delivers a retried message once (the outbox is at-least-once).
   */
  idempotencyKey: string;
};

export type MailSendResult = {
  /** The provider's id, stored on the outbox row for tracing a bounce. */
  providerMessageId: string | null;
};

export interface MailProvider {
  send(message: MailMessage, signal?: AbortSignal): Promise<MailSendResult>;
}

/**
 * The provider refused the message itself -- a malformed address, content it
 * will not accept -- so sending it again cannot succeed.
 */
export class MailRejectedError extends Error {
  override readonly name = 'MailRejectedError';
}
