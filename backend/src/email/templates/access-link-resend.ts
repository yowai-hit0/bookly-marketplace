import { z } from 'zod';
import { accessToken, bookingBasics, bookingLink, dateOf, defineTemplate, tr } from './shared.js';

/**
 * To the client when the photographer resends their link (spec §6.21, plan.md
 * Task 19). The token is new; the email says plainly that older links are dead.
 */
export const accessLinkResend = defineTemplate({
  payload: z.object({
    ...bookingBasics,
    accessToken,
  }),
  compose(p, ctx) {
    return {
      subject: tr(ctx, 'email:accessLinkResend.subject', { reference: p.reference }),
      preheader: tr(ctx, 'email:accessLinkResend.preheader'),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:accessLinkResend.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.clientName }) },
        {
          type: 'paragraph',
          text: tr(ctx, 'email:accessLinkResend.intro', { service: p.serviceName, date: dateOf(p.startsAt) }),
        },
        { type: 'button', label: tr(ctx, 'email:common.viewBooking'), href: bookingLink(ctx, p.accessToken) },
        { type: 'note', text: tr(ctx, 'email:accessLinkResend.oldLinks') },
        {
          type: 'details',
          rows: [{ label: tr(ctx, 'email:common.labels.reference'), value: p.reference }],
        },
      ],
    };
  },
});
