import { z } from 'zod';
import { defineTemplate, personName, siteUrl, text, tr } from './shared.js';

/**
 * To every platform admin, when a photographer signs up (Phase 2 decision 4;
 * marketplace-spec.md R2.2): a studio is waiting for review. One row per admin
 * (`outbox/recipients.ts` `platformAdminRecipients`), enqueued in the signup
 * transaction, so a signup that rolls back announces nothing.
 *
 * The applicant's name is what they typed, so it stays out of the subject (a
 * header) and goes into the body, where the layout escapes it. Their address
 * has not been verified yet when this is sent; the console shows whether it
 * has since.
 */

/** `photographer_handle_format`. */
const handle = z.string().regex(/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/);

export const photographerApplicationReceived = defineTemplate({
  payload: z.object({
    displayName: personName,
    handle,
    email: text(320),
  }),
  compose(p, ctx) {
    return {
      subject: tr(ctx, 'email:photographerApplicationReceived.subject'),
      preheader: tr(ctx, 'email:photographerApplicationReceived.preheader'),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:photographerApplicationReceived.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:photographerApplicationReceived.intro', { displayName: p.displayName }) },
        {
          type: 'details',
          rows: [
            { label: tr(ctx, 'email:photographerApplicationReceived.displayNameLabel'), value: p.displayName },
            { label: tr(ctx, 'email:photographerApplicationReceived.handleLabel'), value: p.handle },
            { label: tr(ctx, 'email:photographerApplicationReceived.emailLabel'), value: p.email },
          ],
        },
        {
          type: 'button',
          label: tr(ctx, 'email:photographerApplicationReceived.button'),
          href: siteUrl(ctx, '/platform/photographers?status=pending'),
        },
      ],
    };
  },
});
