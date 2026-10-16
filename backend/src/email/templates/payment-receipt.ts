import { z } from 'zod';
import { formatDateTime } from '../../format.js';
import type { Block } from '../layout.js';
import {
  accessToken,
  amountRwf,
  bookingBasics,
  bookingLink,
  defineTemplate,
  instant,
  money,
  paymentKind,
  text,
  tr,
} from './shared.js';

/**
 * To the client when a payment has arrived (plan.md Task 20). The totals are
 * `bookingTotals()` at enqueue time, carried in the payload -- nothing here
 * recomputes an amount.
 */
export const paymentReceipt = defineTemplate({
  payload: z.object({
    ...bookingBasics,
    kind: paymentKind,
    amountRwf,
    paidAt: instant,
    /** Our reference for the payment, which the provider shows the client too. */
    paymentReference: text(100),
    totalRwf: amountRwf,
    paidRwf: amountRwf,
    outstandingRwf: amountRwf,
    /** Money received over the total, which the photographer refunds by hand (spec §6.16). */
    overpaidRwf: amountRwf.default(0),
    /**
     * Null where the plaintext no longer exists (data-model_v2.md §5.9): the
     * receipt then names the link the client already has, rather than costing
     * them their working one (spec §6.21).
     */
    accessToken: accessToken.nullable().default(null),
  }),
  compose(p, ctx) {
    const amount = money(p.amountRwf);
    const kind = tr(ctx, `email:common.paymentKinds.${p.kind}`);
    return {
      subject: tr(ctx, 'email:paymentReceipt.subject', { amount, reference: p.reference }),
      preheader: tr(ctx, 'email:paymentReceipt.preheader', { amount }),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:paymentReceipt.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.clientName }) },
        { type: 'paragraph', text: tr(ctx, 'email:paymentReceipt.intro', { kind, amount }) },
        {
          type: 'details',
          rows: [
            { label: tr(ctx, 'email:common.labels.reference'), value: p.reference },
            {
              label: tr(ctx, 'email:common.labels.service'),
              value: tr(ctx, 'email:common.serviceValue', { service: p.serviceName, package: p.packageName }),
            },
            { label: tr(ctx, 'email:common.labels.paymentFor'), value: capitalise(kind) },
            { label: tr(ctx, 'email:common.labels.amount'), value: amount },
            {
              label: tr(ctx, 'email:common.labels.paidAt'),
              value: tr(ctx, 'email:common.atValue', { dateTime: formatDateTime(p.paidAt) }),
            },
            { label: tr(ctx, 'email:common.labels.paymentReference'), value: p.paymentReference },
            { label: tr(ctx, 'email:common.labels.total'), value: money(p.totalRwf) },
            { label: tr(ctx, 'email:common.labels.paid'), value: money(p.paidRwf) },
            { label: tr(ctx, 'email:common.labels.outstanding'), value: money(p.outstandingRwf) },
          ],
        },
        ...(p.overpaidRwf > 0
          ? [{ type: 'paragraph' as const, text: tr(ctx, 'email:paymentReceipt.overpaid', { amount: money(p.overpaidRwf) }) }]
          : p.outstandingRwf === 0
            ? [{ type: 'paragraph' as const, text: tr(ctx, 'email:paymentReceipt.paidInFull') }]
            : []),
        ...(p.accessToken === null
          ? [{ type: 'paragraph' as const, text: tr(ctx, 'email:paymentReceipt.sameLink') }]
          : ([{ type: 'button', label: tr(ctx, 'email:common.viewBooking'), href: bookingLink(ctx, p.accessToken) }] satisfies Block[])),
      ],
    };
  },
});

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
