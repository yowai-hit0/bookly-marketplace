import { z } from 'zod';
import { accessToken, bookingBasics, defineTemplate, emailConfirmLink, text, tr, when } from './shared.js';

/**
 * To the NEW address, when a client asks to change their booking's contact
 * email (docs/prompts/client-access-and-admin-polish.md, item 6). Nothing
 * changes until this link is followed and confirmed: that is what proves the
 * new address is theirs.
 */
export const emailChangeConfirm = defineTemplate({
  payload: z.object({
    ...bookingBasics,
    newEmail: text(254),
    /** The confirmation token, not the booking's access token: it opens nothing but this change. */
    confirmToken: accessToken,
  }),
  compose(p, ctx) {
    return {
      subject: tr(ctx, 'email:emailChangeConfirm.subject', { reference: p.reference }),
      preheader: tr(ctx, 'email:emailChangeConfirm.preheader'),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:emailChangeConfirm.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.clientName }) },
        { type: 'paragraph', text: tr(ctx, 'email:emailChangeConfirm.intro', { email: p.newEmail }) },
        { type: 'button', label: tr(ctx, 'email:emailChangeConfirm.button'), href: emailConfirmLink(ctx, p.confirmToken) },
        { type: 'note', text: tr(ctx, 'email:emailChangeConfirm.expiry') },
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
        { type: 'note', text: tr(ctx, 'email:emailChangeConfirm.notYou') },
      ],
    };
  },
});
