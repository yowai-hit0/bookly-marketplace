import { z } from 'zod';
import { formatDateTime } from '../../format.js';
import { destinationText, maskedDestination } from './account-security-alert.js';
import { defineTemplate, money, personName, siteUrl, text, tr } from './shared.js';

/**
 * To a photographer, when a platform admin marks their payout paid
 * (marketplace-spec.md R4.4 step 4; payouts/payouts.ts `markPayoutPaid`): how
 * much was sent, where (the network or bank and the last four digits only), and
 * the transfer reference to match it against. Sent once per payout: the
 * payout's id is the dedupe key.
 *
 * No commission is taken (decisions table: money out); the transfer fee is the
 * provider's, deducted from what arrives, which the email says as the studio's
 * banner does.
 */
export const payoutSent = defineTemplate({
  payload: z.object({
    displayName: personName,
    /** A payout is never built for nought or less (CHECK payout_amount_positive). */
    amountRwf: z.int().min(1),
    transferReference: text(100),
    paidAt: z.iso.datetime({ offset: true }),
    /** How many earnings and reversals the payout settles. */
    itemCount: z.int().min(1),
    destination: maskedDestination,
  }),
  compose(p, ctx) {
    const amount = money(p.amountRwf);
    const destination = destinationText(ctx, p.destination);
    return {
      subject: tr(ctx, 'email:payoutSent.subject', { amount }),
      preheader: tr(ctx, 'email:payoutSent.preheader', { destination }),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:payoutSent.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.displayName }) },
        { type: 'paragraph', text: tr(ctx, 'email:payoutSent.intro', { amount, destination }) },
        {
          type: 'details',
          rows: [
            { label: tr(ctx, 'email:payoutSent.amountLabel'), value: amount },
            { label: tr(ctx, 'email:payoutSent.destinationLabel'), value: destination },
            { label: tr(ctx, 'email:payoutSent.referenceLabel'), value: p.transferReference },
            { label: tr(ctx, 'email:payoutSent.paidAtLabel'), value: formatDateTime(p.paidAt) },
            { label: tr(ctx, 'email:payoutSent.linesLabel'), value: String(p.itemCount) },
          ],
        },
        { type: 'note', text: tr(ctx, 'email:payoutSent.feeNote') },
        { type: 'button', label: tr(ctx, 'email:payoutSent.button'), href: siteUrl(ctx, '/studio/earnings') },
      ],
    };
  },
});
