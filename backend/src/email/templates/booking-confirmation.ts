import { z } from 'zod';
import {
  accessToken,
  amountRwf,
  bookingBasics,
  bookingLink,
  dateOf,
  defineTemplate,
  money,
  text,
  tr,
  when,
} from './shared.js';

/**
 * To the client, once the booking fee has arrived (spec §3.1 step 12, plan.md
 * Task 17): the reference, date and time, location, amount paid, amount
 * outstanding and the access link. The raw token appears only inside that link.
 */
export const bookingConfirmation = defineTemplate({
  payload: z.object({
    ...bookingBasics,
    locationText: text(500),
    paidRwf: amountRwf,
    outstandingRwf: amountRwf,
    accessToken,
  }),
  compose(p, ctx) {
    const link = bookingLink(ctx, p.accessToken);
    return {
      subject: tr(ctx, 'email:bookingConfirmation.subject', {
        service: p.serviceName,
        date: dateOf(p.startsAt),
        reference: p.reference,
      }),
      preheader: tr(ctx, 'email:bookingConfirmation.preheader', { reference: p.reference }),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:bookingConfirmation.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.clientName }) },
        { type: 'paragraph', text: tr(ctx, 'email:bookingConfirmation.intro') },
        {
          type: 'details',
          rows: [
            { label: tr(ctx, 'email:common.labels.reference'), value: p.reference },
            {
              label: tr(ctx, 'email:common.labels.service'),
              value: tr(ctx, 'email:common.serviceValue', { service: p.serviceName, package: p.packageName }),
            },
            { label: tr(ctx, 'email:common.labels.when'), value: when(ctx, p.startsAt, p.endsAt) },
            { label: tr(ctx, 'email:common.labels.location'), value: p.locationText },
            { label: tr(ctx, 'email:common.labels.paid'), value: money(p.paidRwf) },
            { label: tr(ctx, 'email:common.labels.outstanding'), value: money(p.outstandingRwf) },
          ],
        },
        {
          type: 'paragraph',
          text:
            p.outstandingRwf > 0
              ? tr(ctx, 'email:bookingConfirmation.outstanding', { amount: money(p.outstandingRwf) })
              : tr(ctx, 'email:bookingConfirmation.paidInFull'),
        },
        { type: 'button', label: tr(ctx, 'email:common.viewBooking'), href: link },
        { type: 'paragraph', text: tr(ctx, 'email:bookingConfirmation.linkNote') },
        { type: 'note', text: tr(ctx, 'email:common.nonRefundable') },
      ],
    };
  },
});
