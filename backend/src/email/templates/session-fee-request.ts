import { z } from 'zod';
import { accessToken, amountRwf, bookingBasics, bookingLink, dateOf, defineTemplate, money, tr } from './shared.js';

/**
 * To the client after the shoot: the session fee is due, and the button leads
 * to their booking page to pay it (spec §3.5, plan.md Task 20). `amountRwf` is
 * the amount the request was made for, frozen when it was enqueued.
 */
export const sessionFeeRequest = defineTemplate({
  payload: z.object({
    ...bookingBasics,
    amountRwf,
    accessToken,
  }),
  compose(p, ctx) {
    const amount = money(p.amountRwf);
    return {
      subject: tr(ctx, 'email:sessionFeeRequest.subject', { reference: p.reference }),
      preheader: tr(ctx, 'email:sessionFeeRequest.preheader', { amount }),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:sessionFeeRequest.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.clientName }) },
        { type: 'paragraph', text: tr(ctx, 'email:sessionFeeRequest.intro', { date: dateOf(p.startsAt) }) },
        {
          type: 'details',
          rows: [
            { label: tr(ctx, 'email:common.labels.reference'), value: p.reference },
            {
              label: tr(ctx, 'email:common.labels.service'),
              value: tr(ctx, 'email:common.serviceValue', { service: p.serviceName, package: p.packageName }),
            },
            { label: tr(ctx, 'email:sessionFeeRequest.amountDue'), value: amount },
          ],
        },
        { type: 'button', label: tr(ctx, 'email:sessionFeeRequest.pay'), href: bookingLink(ctx, p.accessToken) },
        { type: 'paragraph', text: tr(ctx, 'email:sessionFeeRequest.afterPaying') },
      ],
    };
  },
});
