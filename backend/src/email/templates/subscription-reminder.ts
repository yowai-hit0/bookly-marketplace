import { z } from 'zod';
import { formatDateTime } from '../../format.js';
import type { ComposedEmail } from '../layout.js';
import { type EmailContext, dateOf, defineTemplate, instant, personName, siteUrl, tr } from './shared.js';

/**
 * To a photographer, about the end of their subscription period
 * (marketplace-spec.md R5.4; subscriptions/job.ts), one variant per moment:
 *
 *   ending     `subscription_reminder_days` before the period ends (7, 3 and 1 by
 *              default): renew to keep taking bookings. The trial's end is worded
 *              as the trial's.
 *   past_due   the period has ended: the profile stays listed, not taking
 *              bookings, until the grace days are over (R5.5).
 *
 * Each is sent once per period end: the dedupe key names the subscription, the
 * period's end and the days (or `past_due`), so a late or repeated run of the
 * job sends nothing twice, and a payment that moves the end starts afresh.
 * Existing bookings carry on in every status (R5.5), and the email says so once
 * the period has ended.
 */

const ending = z.object({
  variant: z.literal('ending'),
  displayName: personName,
  /** Whether the period ending is the free trial or a paid one. */
  periodKind: z.enum(['trial', 'paid']),
  periodEndsAt: instant,
  /** The reminder's day count: one of `subscription_reminder_days` (CHECK: positive). */
  daysLeft: z.int().min(1).max(3650),
});

const pastDue = z.object({
  variant: z.literal('past_due'),
  displayName: personName,
  periodEndedAt: instant,
  /** When the grace days end and the profile is hidden (`expired`). */
  graceEndsAt: instant,
});

export const subscriptionReminder = defineTemplate({
  payload: z.discriminatedUnion('variant', [ending, pastDue]),
  compose(p, ctx) {
    return p.variant === 'ending' ? composeEnding(p, ctx) : composePastDue(p, ctx);
  },
});

function composeEnding(p: z.infer<typeof ending>, ctx: EmailContext): ComposedEmail {
  const trial = p.periodKind === 'trial';
  const date = dateOf(p.periodEndsAt);
  return {
    subject: tr(ctx, trial ? 'email:subscriptionReminder.trialEndingSubject' : 'email:subscriptionReminder.endingSubject', { count: p.daysLeft }),
    preheader: tr(ctx, 'email:subscriptionReminder.endingPreheader', { date }),
    blocks: [
      { type: 'heading', text: tr(ctx, trial ? 'email:subscriptionReminder.trialEndingHeading' : 'email:subscriptionReminder.endingHeading') },
      { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.displayName }) },
      { type: 'paragraph', text: tr(ctx, 'email:subscriptionReminder.endingIntro', { date }) },
      { type: 'details', rows: [{ label: tr(ctx, 'email:subscriptionReminder.periodEndsLabel'), value: formatDateTime(p.periodEndsAt) }] },
      { type: 'note', text: tr(ctx, 'email:subscriptionReminder.earlyNote') },
      { type: 'button', label: tr(ctx, 'email:subscriptionReminder.button'), href: siteUrl(ctx, '/studio/subscription') },
    ],
  };
}

function composePastDue(p: z.infer<typeof pastDue>, ctx: EmailContext): ComposedEmail {
  const graceEndsOn = dateOf(p.graceEndsAt);
  return {
    subject: tr(ctx, 'email:subscriptionReminder.pastDueSubject'),
    preheader: tr(ctx, 'email:subscriptionReminder.pastDuePreheader', { date: graceEndsOn }),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:subscriptionReminder.pastDueHeading') },
      { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.displayName }) },
      { type: 'paragraph', text: tr(ctx, 'email:subscriptionReminder.pastDueIntro', { endedOn: dateOf(p.periodEndedAt), graceEndsOn }) },
      {
        type: 'details',
        rows: [
          { label: tr(ctx, 'email:subscriptionReminder.periodEndedLabel'), value: formatDateTime(p.periodEndedAt) },
          { label: tr(ctx, 'email:subscriptionReminder.graceEndsLabel'), value: formatDateTime(p.graceEndsAt) },
        ],
      },
      { type: 'paragraph', text: tr(ctx, 'email:subscriptionReminder.existingBookings') },
      { type: 'button', label: tr(ctx, 'email:subscriptionReminder.button'), href: siteUrl(ctx, '/studio/subscription') },
    ],
  };
}
