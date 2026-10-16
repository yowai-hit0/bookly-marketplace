import { type OutboxHandler, PermanentOutboxError } from '../outbox/worker.js';
import { type MailProvider, MailRejectedError } from './provider.js';
import { renderEmail } from './render.js';
import { EmailPayloadError } from './templates/shared.js';

/**
 * The outbox handler for `kind = 'email'` (plan.md Tasks 14 and 15): render the
 * row's template, hand it to the mail provider with the dedupe key as the
 * idempotency key, and record the provider's message id.
 *
 * A payload that cannot render and a message the provider refuses outright are
 * permanent -- the row fails and the photographer is told at once, rather than
 * after hours of retries that could never succeed. Anything else is retried.
 */

export type EmailHandlerDeps = {
  mail: MailProvider;
  webOrigin: string;
};

export function createEmailHandler({ mail, webOrigin }: EmailHandlerDeps): OutboxHandler {
  return async (row, signal) => {
    if (row.template === null || row.recipient === null) {
      throw new PermanentOutboxError('An email row needs a template and a recipient');
    }
    if (row.payload === null) {
      // Erased (data-model_v2.md §10.2): there is nothing left to say, and no one to say it to.
      throw new PermanentOutboxError('The payload was erased');
    }

    let rendered;
    try {
      const locale = (row.payload as { locale?: unknown }).locale;
      rendered = renderEmail(row.template, row.payload, {
        webOrigin,
        locale: typeof locale === 'string' ? locale : null,
      });
    } catch (error) {
      if (error instanceof EmailPayloadError) throw new PermanentOutboxError(error.message);
      throw error;
    }

    try {
      const { providerMessageId } = await mail.send(
        { to: row.recipient, subject: rendered.subject, html: rendered.html, text: rendered.text, idempotencyKey: row.dedupeKey },
        signal,
      );
      return { providerMessageId };
    } catch (error) {
      if (error instanceof MailRejectedError) throw new PermanentOutboxError(error.message);
      throw error;
    }
  };
}
