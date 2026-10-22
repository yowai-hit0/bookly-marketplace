import { z } from 'zod';
import { formatDateTime } from '../../format.js';
import { dateOf, defineTemplate, instant, money, personName, siteUrl, text, tr } from './shared.js';

/**
 * To a photographer, when a subscription payment succeeds (marketplace-spec.md
 * R5.3; subscriptions/payments.ts `addPaidPeriod`): what was paid, for which
 * plan, and the period it bought -- which starts where the time already paid
 * for ends, so paying early never loses a day. Sent once per payment: the
 * payment's id is the dedupe key.
 */
export const subscriptionReceipt = defineTemplate({
  payload: z.object({
    displayName: personName,
    planInterval: z.enum(['monthly', 'yearly']),
    /** CHECK subscription_period_shape: a paid period costs something. */
    amountRwf: z.int().min(1),
    paidAt: instant,
    /** The provider's reference when it gave one, else ours. */
    paymentReference: text(200),
    periodStartsAt: instant,
    periodEndsAt: instant,
  }),
  compose(p, ctx) {
    const amount = money(p.amountRwf);
    const plan = tr(ctx, p.planInterval === 'monthly' ? 'email:subscriptionReceipt.planMonthly' : 'email:subscriptionReceipt.planYearly');
    const date = dateOf(p.periodEndsAt);
    return {
      subject: tr(ctx, 'email:subscriptionReceipt.subject', { amount }),
      preheader: tr(ctx, 'email:subscriptionReceipt.preheader', { date }),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:subscriptionReceipt.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.displayName }) },
        { type: 'paragraph', text: tr(ctx, 'email:subscriptionReceipt.intro', { amount, plan, date }) },
        {
          type: 'details',
          rows: [
            { label: tr(ctx, 'email:subscriptionReceipt.planLabel'), value: plan },
            { label: tr(ctx, 'email:subscriptionReceipt.amountLabel'), value: amount },
            { label: tr(ctx, 'email:subscriptionReceipt.paidAtLabel'), value: formatDateTime(p.paidAt) },
            { label: tr(ctx, 'email:subscriptionReceipt.referenceLabel'), value: p.paymentReference },
            {
              label: tr(ctx, 'email:subscriptionReceipt.periodLabel'),
              value: tr(ctx, 'email:subscriptionReceipt.periodValue', { start: formatDateTime(p.periodStartsAt), end: formatDateTime(p.periodEndsAt) }),
            },
          ],
        },
        { type: 'note', text: tr(ctx, 'email:subscriptionReceipt.stackNote') },
        { type: 'button', label: tr(ctx, 'email:subscriptionReceipt.button'), href: siteUrl(ctx, '/studio/subscription') },
      ],
    };
  },
});
