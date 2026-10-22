import { z } from 'zod';
import { dateOf, defineTemplate, instant, personName, siteUrl, tr } from './shared.js';

/**
 * To a photographer, when a platform admin approves their studio (Phase 2
 * decision 7; marketplace-spec.md R9.1). From now on they are listed and can
 * be booked (`photographers/bookable.ts`). Sent once per approval: the
 * approval's instant is in the dedupe key (`photographers/moderation.ts`).
 *
 * The approval starts the free trial (marketplace-spec.md R5.1;
 * subscriptions/lifecycle.ts), and the email says until when. `trialEndsAt` is
 * optional: a photographer who already had a subscription gets no new trial,
 * and no trial is promised.
 */

/** `photographer_handle_format`: the public profile is `/p/<handle>`. */
const handle = z.string().regex(/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/);

export const photographerApproved = defineTemplate({
  payload: z.object({
    displayName: personName,
    handle,
    trialEndsAt: instant.optional(),
  }),
  compose(p, ctx) {
    return {
      subject: tr(ctx, 'email:photographerApproved.subject'),
      preheader: tr(ctx, 'email:photographerApproved.preheader'),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:photographerApproved.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.displayName }) },
        { type: 'paragraph', text: tr(ctx, 'email:photographerApproved.intro') },
        ...(p.trialEndsAt === undefined ? [] : [{ type: 'paragraph' as const, text: tr(ctx, 'email:photographerApproved.trial', { date: dateOf(p.trialEndsAt) }) }]),
        {
          type: 'details',
          rows: [{ label: tr(ctx, 'email:photographerApproved.profileLabel'), value: siteUrl(ctx, `/p/${p.handle}`) }],
        },
        { type: 'button', label: tr(ctx, 'email:photographerApproved.button'), href: siteUrl(ctx, '/studio') },
      ],
    };
  },
});
