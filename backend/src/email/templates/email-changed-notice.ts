import { z } from 'zod';
import { bookingBasics, defineTemplate, text, tr, when } from './shared.js';

/**
 * To the OLD address, once a contact-email change has been confirmed
 * (docs/prompts/client-access-and-admin-polish.md, item 6): the last email it
 * gets about this booking, so a change nobody asked for does not go unseen.
 */
export const emailChangedNotice = defineTemplate({
  payload: z.object({
    ...bookingBasics,
    newEmail: text(254),
  }),
  compose(p, ctx) {
    return {
      subject: tr(ctx, 'email:emailChangedNotice.subject', { reference: p.reference }),
      preheader: tr(ctx, 'email:emailChangedNotice.preheader'),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:emailChangedNotice.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.clientName }) },
        { type: 'paragraph', text: tr(ctx, 'email:emailChangedNotice.intro', { email: p.newEmail }) },
        {
          type: 'details',
          rows: [
            {
              label: tr(ctx, 'email:common.labels.service'),
              value: tr(ctx, 'email:common.serviceValue', { service: p.serviceName, package: p.packageName }),
            },
            { label: tr(ctx, 'email:common.labels.when'), value: when(ctx, p.startsAt, p.endsAt) },
            { label: tr(ctx, 'email:common.labels.reference'), value: p.reference },
          ],
        },
        { type: 'note', text: tr(ctx, 'email:emailChangedNotice.notYou') },
      ],
    };
  },
});
