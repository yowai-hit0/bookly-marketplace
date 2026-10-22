import { z } from 'zod';
import { dateOf, defineTemplate, instant, personName, siteUrl, tr } from './shared.js';

/**
 * To a photographer, when the grace days after their period are over and the
 * subscription becomes `expired` (marketplace-spec.md R5.4, R5.5;
 * subscriptions/job.ts): the profile is hidden from the directory and no new
 * booking can be made, while every booking they already have carries on.
 * Paying from the studio brings them back at once. Sent once per period end:
 * the dedupe key names the subscription and the end.
 */
export const subscriptionExpired = defineTemplate({
  payload: z.object({
    displayName: personName,
    periodEndedAt: instant,
  }),
  compose(p, ctx) {
    return {
      subject: tr(ctx, 'email:subscriptionExpired.subject'),
      preheader: tr(ctx, 'email:subscriptionExpired.preheader'),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:subscriptionExpired.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.displayName }) },
        { type: 'paragraph', text: tr(ctx, 'email:subscriptionExpired.intro', { endedOn: dateOf(p.periodEndedAt) }) },
        { type: 'paragraph', text: tr(ctx, 'email:subscriptionExpired.existingBookings') },
        { type: 'note', text: tr(ctx, 'email:subscriptionExpired.renewNote') },
        { type: 'button', label: tr(ctx, 'email:subscriptionExpired.button'), href: siteUrl(ctx, '/studio/subscription') },
      ],
    };
  },
});
