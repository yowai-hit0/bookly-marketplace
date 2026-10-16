import { z } from 'zod';
import { bookingBasics, defineTemplate, tr, when } from './shared.js';

/**
 * A note from the photographer, emailed when they tick "Also email it"
 * (docs/prompts/client-access-and-admin-polish.md, item 8). It also shows on
 * the client's booking page. No link: the plaintext of the client's token no
 * longer exists (data-model_v2.md §5.9), and replacing a working link for a
 * note would cost the client the one they have.
 *
 * Signed "your photographer" until a photographer profile exists (user
 * decision, 2026-09-25).
 */
export const clientNote = defineTemplate({
  payload: z.object({
    ...bookingBasics,
    /** Plain text as typed, 1 to 1000 characters; the layout escapes it and keeps its line breaks. */
    body: z.string().min(1).max(1000),
  }),
  compose(p, ctx) {
    return {
      subject: tr(ctx, 'email:clientNote.subject', { reference: p.reference }),
      preheader: tr(ctx, 'email:clientNote.preheader'),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:clientNote.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.clientName }) },
        { type: 'paragraph', text: p.body },
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
        { type: 'note', text: tr(ctx, 'email:clientNote.alsoOnPage') },
      ],
    };
  },
});
