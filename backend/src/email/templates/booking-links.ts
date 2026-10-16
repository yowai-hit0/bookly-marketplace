import { z } from 'zod';
import { accessToken, bookingLink, defineTemplate, personName, reference, text, tr, when, instant } from './shared.js';

/**
 * To a client who asked for their links on the "My booking" page
 * (docs/prompts/client-access-and-admin-polish.md, item 4): one email listing
 * each of their current bookings with a fresh link. Every token is new, so the
 * email says plainly that older links are dead. It is sent only to the address
 * on the bookings, so asking for someone else's links reaches only them.
 */

/** Far above what one client books at once; a bound, so a payload cannot grow without end. */
const MAX_BOOKINGS = 20;

export const bookingLinks = defineTemplate({
  payload: z.object({
    clientName: personName,
    bookings: z
      .array(
        z.object({
          reference,
          serviceName: text(200),
          packageName: text(200),
          startsAt: instant,
          endsAt: instant,
          accessToken,
        }),
      )
      .min(1)
      .max(MAX_BOOKINGS),
  }),
  compose(p, ctx) {
    return {
      subject: tr(ctx, 'email:bookingLinks.subject'),
      preheader: tr(ctx, 'email:bookingLinks.preheader'),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:bookingLinks.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.clientName }) },
        { type: 'paragraph', text: tr(ctx, 'email:bookingLinks.intro') },
        ...p.bookings.flatMap((booking) => [
          {
            type: 'details' as const,
            rows: [
              {
                label: tr(ctx, 'email:common.labels.service'),
                value: tr(ctx, 'email:common.serviceValue', { service: booking.serviceName, package: booking.packageName }),
              },
              { label: tr(ctx, 'email:common.labels.when'), value: when(ctx, booking.startsAt, booking.endsAt) },
              { label: tr(ctx, 'email:common.labels.reference'), value: booking.reference },
            ],
          },
          {
            type: 'button' as const,
            label: tr(ctx, 'email:bookingLinks.open', { reference: booking.reference }),
            href: bookingLink(ctx, booking.accessToken),
          },
        ]),
        { type: 'note', text: tr(ctx, 'email:bookingLinks.oldLinks') },
        { type: 'note', text: tr(ctx, 'email:bookingLinks.notYou') },
      ],
    };
  },
});
