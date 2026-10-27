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
 *   password_changed  the account's password was changed, or -- `added` -- a
 *                   first password was added to a Google-only client account
 *                   (marketplace-spec.md Phase 8, decision 2). Every other
 *                   token was revoked with it; the copy says so, and what to do
 *                   if it was not them. Its button goes to the area's sign-in page.
 *   email_changed   sent to the OLD address once a change of the account's
 *                   address is confirmed from the new inbox (R8.3). Names the
 *                   new address masked (`a•••••@example.com`): whoever reads
 *                   the old inbox learns where the account went only enough to
 *                   recognise it. No button: the old address signs in nowhere now.
 *   account_deleted the client's account was deleted at their request (R8.3;
 *                   user decision 2026-10-27, deletion follow-up), sent to the
 *                   address being erased. Says what was erased, that bookings
 *                   stay with their photographers and upcoming ones go ahead
 *                   through their own links, and what to do if it was not them.
 *                   No button: there is no account left to open. The row erases
 *                   its own recipient and payload once delivered (`erase_on_completion`).
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

const passwordChanged = z.object({
  variant: z.literal('password_changed'),
  area: z.enum(AUTH_AREAS),
  /** A first password added to a Google-only account, rather than one replaced. */
  added: z.boolean(),
  changedAt: instant,
});

/** `maskEmail`'s form: a character, five bullets, the domain. Never a full address. */
const maskedAddress = z
  .string()
  .max(320)
  .regex(/^[^@\s]•{5}@[^@\s]+$/u);

const emailChanged = z.object({
  variant: z.literal('email_changed'),
  area: z.literal('account'),
  changedAt: instant,
  /** The new address, masked. */
  newEmail: maskedAddress,
});

const accountDeleted = z.object({
  variant: z.literal('account_deleted'),
  area: z.literal('account'),
  deletedAt: instant,
});

export const accountSecurityAlert = defineTemplate({
  payload: z.discriminatedUnion('variant', [loginLockout, accountExists, payoutMethodChanged, passwordChanged, emailChanged, accountDeleted]),
  compose(p, ctx): ComposedEmail {
    switch (p.variant) {
      case 'payout_method_changed':
        return composePayoutMethodChanged(p, ctx);
      case 'account_exists':
        return composeAccountExists(p, ctx);
      case 'password_changed':
        return composePasswordChanged(p, ctx);
      case 'email_changed':
        return composeEmailChanged(p, ctx);
      case 'account_deleted':
        return composeAccountDeleted(p, ctx);
      case 'login_lockout':
        return composeLoginLockout(p, ctx);
    }
  },
});

function composePasswordChanged(p: z.infer<typeof passwordChanged>, ctx: EmailContext): ComposedEmail {
  const when = formatDateTime(p.changedAt);
  const key = p.added ? 'added' : 'changed';
  return {
    subject: tr(ctx, `email:accountSecurityAlert.passwordChanged.${key}.subject`),
    preheader: tr(ctx, 'email:accountSecurityAlert.passwordChanged.preheader'),
    blocks: [
      { type: 'heading', text: tr(ctx, `email:accountSecurityAlert.passwordChanged.${key}.heading`) },
      { type: 'paragraph', text: tr(ctx, `email:accountSecurityAlert.passwordChanged.${key}.intro`, { when }) },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.passwordChanged.signedOut') },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.passwordChanged.ifNotYou') },
      { type: 'button', label: tr(ctx, 'email:accountSecurityAlert.passwordChanged.signIn'), href: siteUrl(ctx, AREA_WEB_PATHS[p.area].login) },
    ],
  };
}

function composeAccountDeleted(p: z.infer<typeof accountDeleted>, ctx: EmailContext): ComposedEmail {
  const when = formatDateTime(p.deletedAt);
  return {
    subject: tr(ctx, 'email:accountSecurityAlert.accountDeleted.subject'),
    preheader: tr(ctx, 'email:accountSecurityAlert.accountDeleted.preheader'),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:accountSecurityAlert.accountDeleted.heading') },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.accountDeleted.intro', { when }) },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.accountDeleted.bookings') },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.accountDeleted.ifNotYou') },
    ],
  };
}

function composeEmailChanged(p: z.infer<typeof emailChanged>, ctx: EmailContext): ComposedEmail {
  const when = formatDateTime(p.changedAt);
  return {
    subject: tr(ctx, 'email:accountSecurityAlert.emailChanged.subject'),
    preheader: tr(ctx, 'email:accountSecurityAlert.emailChanged.preheader'),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:accountSecurityAlert.emailChanged.heading') },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.emailChanged.intro', { when, email: p.newEmail }) },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.emailChanged.bookings') },
      { type: 'paragraph', text: tr(ctx, 'email:accountSecurityAlert.emailChanged.ifNotYou') },
    ],
  };
}

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
