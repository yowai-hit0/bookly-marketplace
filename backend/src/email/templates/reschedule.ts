import { z } from 'zod';
import { accessToken, bookingBasics, bookingLink, dateOf, defineTemplate, instant, text, tr, when } from './shared.js';
import type { Block } from '../layout.js';

/**
 * To the client when the photographer moves their booking (spec §6.11, plan.md
 * Task 19): the time it was, the time it is now, and the link to the booking,
 * which keeps its reference and token.
 *
 * That last part is why `accessToken` may be null. A reschedule does not issue
 * a new token, and the plaintext of the existing one was never stored -- so the
 * email points the client at the link they already have rather than inventing
 * one, and a resend (spec §6.21) is how a lost link is replaced.
 */
export const reschedule = defineTemplate({
  payload: z.object({
    ...bookingBasics,
    previousStartsAt: instant,
    previousEndsAt: instant,
    locationText: text(500),
    accessToken: accessToken.nullable().default(null),
  }),
  compose(p, ctx) {
    const now = when(ctx, p.startsAt, p.endsAt);
    return {
      subject: tr(ctx, 'email:reschedule.subject', { reference: p.reference, date: dateOf(p.startsAt) }),
      preheader: tr(ctx, 'email:reschedule.preheader', { when: now }),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:reschedule.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.clientName }) },
        { type: 'paragraph', text: tr(ctx, 'email:reschedule.intro', { service: p.serviceName }) },
        {
          type: 'details',
          rows: [
            { label: tr(ctx, 'email:common.labels.reference'), value: p.reference },
            {
              label: tr(ctx, 'email:common.labels.service'),
              value: tr(ctx, 'email:common.serviceValue', { service: p.serviceName, package: p.packageName }),
            },
            { label: tr(ctx, 'email:reschedule.previous'), value: when(ctx, p.previousStartsAt, p.previousEndsAt) },
            { label: tr(ctx, 'email:reschedule.current'), value: now },
            { label: tr(ctx, 'email:common.labels.location'), value: p.locationText },
          ],
        },
        ...(p.accessToken === null
          ? [{ type: 'paragraph' as const, text: tr(ctx, 'email:reschedule.sameLink') }]
          : ([{ type: 'button', label: tr(ctx, 'email:common.viewBooking'), href: bookingLink(ctx, p.accessToken) }] satisfies Block[])),
      ],
    };
  },
});
