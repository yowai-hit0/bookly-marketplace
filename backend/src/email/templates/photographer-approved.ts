import { z } from 'zod';
import { defineTemplate, personName, siteUrl, tr } from './shared.js';

/**
 * To a photographer, when a platform admin approves their studio (Phase 2
 * decision 7; marketplace-spec.md R9.1). From now on they are listed and can
 * be booked (`photographers/bookable.ts`). Sent once per approval: the
 * approval's instant is in the dedupe key (`photographers/moderation.ts`).
 *
 * Phase 5 adds the free trial that starts at approval; its copy belongs there.
 */

/** `photographer_handle_format`: the public profile is `/p/<handle>`. */
const handle = z.string().regex(/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/);

export const photographerApproved = defineTemplate({
  payload: z.object({
    displayName: personName,
    handle,
  }),
  compose(p, ctx) {
    return {
      subject: tr(ctx, 'email:photographerApproved.subject'),
      preheader: tr(ctx, 'email:photographerApproved.preheader'),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:photographerApproved.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.displayName }) },
        { type: 'paragraph', text: tr(ctx, 'email:photographerApproved.intro') },
        {
          type: 'details',
          rows: [{ label: tr(ctx, 'email:photographerApproved.profileLabel'), value: siteUrl(ctx, `/p/${p.handle}`) }],
        },
        { type: 'button', label: tr(ctx, 'email:photographerApproved.button'), href: siteUrl(ctx, '/studio') },
      ],
    };
  },
});
