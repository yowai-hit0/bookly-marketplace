import { z } from 'zod';
import { AREA_WEB_PATHS, AUTH_AREAS } from '../../auth/roles.js';
import { formatDateTime } from '../../format.js';
import type { ComposedEmail } from '../layout.js';
import { type EmailContext, defineTemplate, instant, siteUrl, tr } from './shared.js';

/**
 * Something happened to an account that its holder should know about
 * (marketplace-data-model.md §2.14), one variant per event:
 *
 *   login_lockout   sign-in locked after failed attempts (Task 7, spec §6.23),
 *                   in the area named by `area`: its button goes to that
 *                   area's sign-in page (Phase 2 decision 9). A row enqueued
 *                   before areas existed has none, and was the studio's.
 *   account_exists  someone signed up again with the address of an account
 *                   that is already verified (Phase 2 decision 4: "you already
 *                   have an account"). Nothing was changed; the button goes to
 *                   the existing account's own sign-in page, in `area`. The
 *                   signup itself answered exactly as for a new address.
 *
 *   payout_method_changed  the studio's payout destination was saved
 *                   (marketplace-spec.md R4.1, T4.4): `replaced` says whether one
 *                   was replaced or this is the first. Names the network or bank
 *                   and the last four digits only, and says what to do if it
 *                   was not them. Its button goes to the payout-method page.
 *
 * `login_lockout` was a variant of `admin_alert` before the marketplace, with
 * the same payload.
 */

const loginLockout = z.object({
  variant: z.literal('login_lockout'),
  area: z.enum(AUTH_AREAS).default('studio'),
  failedLoginCount: z.int().min(1),
  lockedUntil: instant,
});

const accountExists = z.object({
  variant: z.literal('account_exists'),
  area: z.enum(AUTH_AREAS),
});

/** What payouts/method.ts `maskedDestination` puts in the payload. */
export const maskedDestination = z.object({
  kind: z.enum(['momo', 'bank']),
  /** The MoMo network (`mtn`, `airtel`) or the bank's name. */
  provider: z.string().trim().min(1).max(100),
  last4: z.string().regex(/^[0-9A-Za-z]{1,4}$/),
});

const payoutMethodChanged = z.object({
  variant: z.literal('payout_method_changed'),
  area: z.literal('studio').default('studio'),
  replaced: z.boolean(),
  changedAt: instant,
  destination: maskedDestination,
});

export const accountSecurityAlert = defineTemplate({
  payload: z.discriminatedUnion('variant', [loginLockout, accountExists, payoutMethodChanged]),
  compose(p, ctx): ComposedEmail {
    if (p.variant === 'payout_method_changed') return composePayoutMethodChanged(p, ctx);
    return p.variant === 'account_exists' ? composeAccountExists(p, ctx) : composeLoginLockout(p, ctx);
  },
});

/** `MTN MoMo number ending 4567` or `Bank of Kigali account ending 0012`. */
export function destinationText(ctx: EmailContext, destination: z.infer<typeof maskedDestination>): string {
  if (destination.kind === 'bank') return tr(ctx, 'email:accountSecurityAlert.payoutMethodChanged.destinationBank', { bank: destination.provider, last4: destination.last4 });
  const network = destination.provider === 'airtel' ? 'Airtel' : destination.provider === 'mtn' ? 'MTN' : destination.provider;
  return tr(ctx, 'email:accountSecurityAlert.payoutMethodChanged.destinationMomo', { network, last4: destination.last4 });
}

function composePayoutMethodChanged(p: z.infer<typeof payoutMethodChanged>, ctx: EmailContext): ComposedEmail {
  const when = formatDateTime(p.changedAt);
  const destination = destinationText(ctx, p.destination);
  const key = p.replaced ? 'changed' : 'added';
  return {
    subject: tr(ctx, `email:accountSecurityAlert.payoutMethodChanged.${key}.subject`),
    preheader: tr(ctx, 'email:accountSecurityAlert.payoutMethodChanged.preheader', { destination }),
    blocks: [
      { type: 'heading', text: tr(ctx, `email:accountSecurityAlert.payoutMethodChanged.${key}.heading`) },
      { type: 'paragraph', text: tr(ctx, `email:accountSecurityAlert.payoutMethodChanged.${key}.intro`, { when, destination }) },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.payoutMethodChanged.ifNotYou') },
      { type: 'button', label: tr(ctx, 'email:accountSecurityAlert.payoutMethodChanged.button'), href: siteUrl(ctx, '/studio/payout-method') },
    ],
  };
}

function composeAccountExists(p: z.infer<typeof accountExists>, ctx: EmailContext): ComposedEmail {
  return {
    subject: tr(ctx, 'email:accountSecurityAlert.accountExists.subject'),
    preheader: tr(ctx, 'email:accountSecurityAlert.accountExists.preheader'),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:accountSecurityAlert.accountExists.heading') },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.accountExists.intro') },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.accountExists.forgot') },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.accountExists.ifNotYou') },
      { type: 'button', label: tr(ctx, 'email:accountSecurityAlert.accountExists.signIn'), href: siteUrl(ctx, AREA_WEB_PATHS[p.area].login) },
    ],
  };
}

function composeLoginLockout(p: z.infer<typeof loginLockout>, ctx: EmailContext): ComposedEmail {
  const until = formatDateTime(p.lockedUntil);
  return {
    subject: tr(ctx, 'email:accountSecurityAlert.loginLockout.subject', { count: p.failedLoginCount }),
    preheader: tr(ctx, 'email:accountSecurityAlert.loginLockout.preheader', { until }),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:accountSecurityAlert.loginLockout.heading') },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.loginLockout.intro', { count: p.failedLoginCount, until }) },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.loginLockout.ifNotYou') },
      { type: 'button', label: tr(ctx, 'email:accountSecurityAlert.loginLockout.signIn'), href: siteUrl(ctx, AREA_WEB_PATHS[p.area].login) },
    ],
  };
}
