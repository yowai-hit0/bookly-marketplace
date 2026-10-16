import { z } from 'zod';
import { formatDateTime } from '../../format.js';
import { defineTemplate, instant, onSite, tr } from './shared.js';

/**
 * The emailed password-reset link (plan.md Task 7, spec §6.23), for any
 * `app_user` (marketplace-spec.md R2.5). Was the `password_reset` variant of
 * `admin_alert` before the marketplace (marketplace-data-model.md §2.14).
 *
 * The link is checked to be on WEB_ORIGIN before it is rendered: an email never
 * sends anyone to the API host, or anywhere else.
 */
export const accountPasswordReset = defineTemplate({
  payload: z.object({
    /** Built by `requestPasswordReset` on WEB_ORIGIN, with the token in the fragment. */
    resetUrl: z.url(),
    expiresAt: instant,
  }),
  compose(p, ctx) {
    const until = formatDateTime(p.expiresAt);
    return {
      subject: tr(ctx, 'email:accountPasswordReset.subject'),
      preheader: tr(ctx, 'email:accountPasswordReset.preheader', { until }),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:accountPasswordReset.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:accountPasswordReset.intro', { until }) },
        { type: 'button', label: tr(ctx, 'email:accountPasswordReset.button'), href: onSite(ctx, p.resetUrl) },
        { type: 'paragraph', text: tr(ctx, 'email:accountPasswordReset.ignore') },
      ],
    };
  },
});
