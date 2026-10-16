import { z } from 'zod';
import { amountRwf, bookingBasics, dateOf, defineTemplate, money, text, tr } from './shared.js';

/**
 * To the client when a booking is cancelled -- by them (spec §6.10) or by the
 * photographer (§6.11).
 *
 * A client's own cancellation repeats that the booking fee is non-refundable,
 * as the spec requires. `refundRwf` is what is owed back: a paid session fee
 * after a client cancellation, everything after the photographer's. The email
 * promises contact about it, never a refund already made -- the system does not
 * move money (§6.16).
 */
export const cancellation = defineTemplate({
  payload: z.object({
    ...bookingBasics,
    cancelledBy: z.enum(['client', 'admin']),
    /** Shown to the client when the photographer cancels. */
    reason: text(1000).nullable().default(null),
    bookingFeeRwf: amountRwf,
    refundRwf: amountRwf,
  }),
  compose(p, ctx) {
    const date = dateOf(p.startsAt);
    const byClient = p.cancelledBy === 'client';
    return {
      subject: tr(ctx, 'email:cancellation.subject', { reference: p.reference }),
      preheader: tr(ctx, 'email:cancellation.preheader', { date }),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:cancellation.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.clientName }) },
        {
          type: 'paragraph',
          text: tr(ctx, byClient ? 'email:cancellation.byClient' : 'email:cancellation.byAdmin', {
            service: p.serviceName,
            date,
          }),
        },
        ...(!byClient && p.reason !== null
          ? [{ type: 'paragraph' as const, text: tr(ctx, 'email:cancellation.reason', { reason: p.reason }) }]
          : []),
        {
          type: 'details',
          rows: [
            { label: tr(ctx, 'email:common.labels.reference'), value: p.reference },
            {
              label: tr(ctx, 'email:common.labels.service'),
              value: tr(ctx, 'email:common.serviceValue', { service: p.serviceName, package: p.packageName }),
            },
          ],
        },
        ...(byClient
          ? [{ type: 'note' as const, text: tr(ctx, 'email:cancellation.feeKept', { amount: money(p.bookingFeeRwf) }) }]
          : []),
        ...(p.refundRwf > 0
          ? [{ type: 'paragraph' as const, text: tr(ctx, 'email:cancellation.refundDue', { amount: money(p.refundRwf) }) }]
          : []),
        { type: 'paragraph', text: tr(ctx, 'email:cancellation.rebook') },
      ],
    };
  },
});
