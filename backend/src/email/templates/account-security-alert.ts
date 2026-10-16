import { z } from 'zod';
import { formatDateTime } from '../../format.js';
import type { ComposedEmail } from '../layout.js';
import { type EmailContext, defineTemplate, instant, siteUrl, tr } from './shared.js';

/**
 * Something happened to an account that its holder should know about
 * (marketplace-data-model.md §2.14), one variant per event:
 *
 *   login_lockout   sign-in locked after failed attempts (Task 7, spec §6.23)
 *
 * Phase 4 adds a changed payout method (R4.1). `login_lockout` was a variant of
 * `admin_alert` before the marketplace, with the same payload.
 */

const loginLockout = z.object({
  variant: z.literal('login_lockout'),
  failedLoginCount: z.int().min(1),
  lockedUntil: instant,
});

export const accountSecurityAlert = defineTemplate({
  payload: z.discriminatedUnion('variant', [loginLockout]),
  compose(p, ctx): ComposedEmail {
    return composeLoginLockout(p, ctx);
  },
});

function composeLoginLockout(p: z.infer<typeof loginLockout>, ctx: EmailContext): ComposedEmail {
  const until = formatDateTime(p.lockedUntil);
  return {
    subject: tr(ctx, 'email:accountSecurityAlert.loginLockout.subject', { count: p.failedLoginCount }),
    preheader: tr(ctx, 'email:accountSecurityAlert.loginLockout.preheader', { until }),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:accountSecurityAlert.loginLockout.heading') },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.loginLockout.intro', { count: p.failedLoginCount, until }) },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.loginLockout.ifNotYou') },
      // Phase 1 has one sign-in page, the studio's; Phase 2 gives each role its own.
      { type: 'button', label: tr(ctx, 'email:accountSecurityAlert.loginLockout.signIn'), href: siteUrl(ctx, '/admin/login') },
    ],
  };
}
