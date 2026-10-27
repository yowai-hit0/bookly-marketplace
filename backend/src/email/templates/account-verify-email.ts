import { z } from 'zod';
import { AREA_WEB_PATHS, AUTH_AREAS } from '../../auth/roles.js';
import { formatDateTime } from '../../format.js';
import { defineTemplate, instant, siteUrl, tr } from './shared.js';

/**
 * The email-verification link (Phase 2 decision 3; marketplace-spec.md R2.2,
 * R2.3), for an account in any area. Sent at signup, on "resend verification",
 * and when someone signs up again with an address whose account is still
 * unverified (`auth/email-verification.ts`).
 *
 * The link is `/{area}/verify/<token>` on WEB_ORIGIN: the token in the path,
 * as the booking page's is, and the page POSTs it with the account's password.
 * Opening the link changes nothing. The copy says so, and says what to do when
 * the page asks for a password the reader never chose: someone else signed up
 * with their address, and "Forgot password" hands the account to them
 * (marketplace-spec.md R2.1c).
 *
 * Variant `email_change` (marketplace-spec.md Phase 8, R8.3): a client asked to
 * move their account to this address. The link is `/account/email-confirm/<token>`
 * and its page posts the token with the account's password, exactly as the
 * verification page does; nothing changes until then. Absent `variant` is the
 * signup's link, so rows queued before Phase 8 still render.
 */

/** The page an address change is confirmed on (Phase 8): the token in the path, as the verify page's is. */
export const ACCOUNT_EMAIL_CONFIRM_PATH = '/account/email-confirm';

/** 256 bits of base64url, as `issueVerification` mints it. */
const verifyToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const accountVerifyEmail = defineTemplate({
  payload: z
    .object({
      variant: z.enum(['signup', 'email_change']).default('signup'),
      area: z.enum(AUTH_AREAS),
      token: verifyToken,
      expiresAt: instant,
    })
    // Only a client's account changes its address from a link (Phase 8).
    .refine((p) => p.variant !== 'email_change' || p.area === 'account', { message: 'An email change is the account area only', path: ['area'] }),
  compose(p, ctx) {
    const until = formatDateTime(p.expiresAt);
    if (p.variant === 'email_change') {
      return {
        subject: tr(ctx, 'email:accountVerifyEmail.emailChange.subject'),
        preheader: tr(ctx, 'email:accountVerifyEmail.emailChange.preheader', { until }),
        blocks: [
          { type: 'heading', text: tr(ctx, 'email:accountVerifyEmail.emailChange.heading') },
          { type: 'paragraph', text: tr(ctx, 'email:accountVerifyEmail.emailChange.intro', { until }) },
          { type: 'button', label: tr(ctx, 'email:accountVerifyEmail.emailChange.button'), href: siteUrl(ctx, `${ACCOUNT_EMAIL_CONFIRM_PATH}/${p.token}`) },
          { type: 'paragraph', text: tr(ctx, 'email:accountVerifyEmail.emailChange.ignore') },
        ],
      };
    }
    return {
      subject: tr(ctx, 'email:accountVerifyEmail.subject'),
      preheader: tr(ctx, 'email:accountVerifyEmail.preheader', { until }),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:accountVerifyEmail.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:accountVerifyEmail.intro', { until }) },
        { type: 'button', label: tr(ctx, 'email:accountVerifyEmail.button'), href: siteUrl(ctx, `${AREA_WEB_PATHS[p.area].verify}/${p.token}`) },
        { type: 'paragraph', text: tr(ctx, 'email:accountVerifyEmail.notYourPassword') },
        { type: 'paragraph', text: tr(ctx, 'email:accountVerifyEmail.ignore') },
      ],
    };
  },
});
