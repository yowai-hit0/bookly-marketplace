import { z } from 'zod';
import { formatDate } from '../../format.js';
import { EmailPayloadError, calendarDate, defineTemplate, personName, reference, text, tr } from './shared.js';

/**
 * To the client: the photos are ready (spec §3.5 steps 5-7, §6.20, plan.md
 * Task 21). The download link is the external host's -- the one link in any
 * email that is not on the site -- and the expiry date is stated as text.
 */
export const photoDelivery = defineTemplate({
  payload: z.object({
    reference,
    clientName: personName,
    serviceName: text(200),
    deliveryUrl: z.url(),
    /** A Kigali calendar date, evaluated at end of day (spec §6.5). */
    expiresOn: calendarDate,
    note: text(2000).nullable().default(null),
  }),
  compose(p, ctx) {
    // `booking.delivery_url` is CHECK-constrained to https; a payload is held to the same.
    if (new URL(p.deliveryUrl).protocol !== 'https:') {
      throw new EmailPayloadError('The delivery link is not https');
    }
    const date = formatDate(p.expiresOn);
    return {
      subject: tr(ctx, 'email:photoDelivery.subject', { reference: p.reference }),
      preheader: tr(ctx, 'email:photoDelivery.preheader', { date }),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:photoDelivery.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.clientName }) },
        { type: 'paragraph', text: tr(ctx, 'email:photoDelivery.intro', { service: p.serviceName }) },
        ...(p.note === null ? [] : [{ type: 'paragraph' as const, text: tr(ctx, 'email:photoDelivery.note', { note: p.note }) }]),
        { type: 'button', label: tr(ctx, 'email:photoDelivery.download'), href: p.deliveryUrl },
        { type: 'note', text: tr(ctx, 'email:photoDelivery.expiry', { date }) },
        {
          type: 'details',
          rows: [{ label: tr(ctx, 'email:common.labels.reference'), value: p.reference }],
        },
      ],
    };
  },
});
