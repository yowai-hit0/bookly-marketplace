import { z } from 'zod';
import {
  adminCalendarLink,
  amountRwf,
  bookingBasics,
  dateOf,
  defineTemplate,
  money,
  text,
  tr,
  when,
} from './shared.js';

/**
 * To the photographer when a booking confirms (spec §3.1 step 12, plan.md
 * Task 17): who, what, when and where, what they asked for, and the money --
 * with a link to that day in his calendar. It carries the client's contact
 * details, which the photographer is entitled to see (P-13).
 */
export const adminNewBooking = defineTemplate({
  payload: z.object({
    ...bookingBasics,
    clientEmail: z.email(),
    clientPhone: text(40),
    locationText: text(500),
    partySize: z.int().min(1).nullable().default(null),
    specialRequests: text(2000).nullable().default(null),
    addons: z.array(z.object({ name: text(200), priceRwf: amountRwf })).default([]),
    totalRwf: amountRwf,
    paidRwf: amountRwf,
    outstandingRwf: amountRwf,
  }),
  compose(p, ctx) {
    const notGiven = tr(ctx, 'email:common.notGiven');
    const service = tr(ctx, 'email:common.serviceValue', { service: p.serviceName, package: p.packageName });
    return {
      subject: tr(ctx, 'email:adminNewBooking.subject', {
        client: p.clientName,
        service: p.serviceName,
        date: dateOf(p.startsAt),
      }),
      preheader: tr(ctx, 'email:adminNewBooking.preheader', { reference: p.reference, paid: money(p.paidRwf) }),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:adminNewBooking.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:adminNewBooking.intro', { client: p.clientName }) },
        {
          type: 'details',
          rows: [
            { label: tr(ctx, 'email:common.labels.reference'), value: p.reference },
            { label: tr(ctx, 'email:common.labels.client'), value: p.clientName },
            { label: tr(ctx, 'email:common.labels.email'), value: p.clientEmail },
            { label: tr(ctx, 'email:common.labels.phone'), value: p.clientPhone },
            { label: tr(ctx, 'email:common.labels.service'), value: service },
            ...p.addons.map((addon) => ({ label: addon.name, value: money(addon.priceRwf) })),
            { label: tr(ctx, 'email:common.labels.when'), value: when(ctx, p.startsAt, p.endsAt) },
            { label: tr(ctx, 'email:common.labels.location'), value: p.locationText },
            {
              label: tr(ctx, 'email:common.labels.people'),
              value: p.partySize === null ? notGiven : String(p.partySize),
            },
            { label: tr(ctx, 'email:common.labels.requests'), value: p.specialRequests ?? notGiven },
            { label: tr(ctx, 'email:common.labels.total'), value: money(p.totalRwf) },
            { label: tr(ctx, 'email:common.labels.paid'), value: money(p.paidRwf) },
            { label: tr(ctx, 'email:common.labels.outstanding'), value: money(p.outstandingRwf) },
          ],
        },
        { type: 'button', label: tr(ctx, 'email:adminNewBooking.openCalendar'), href: adminCalendarLink(ctx, p.startsAt) },
      ],
    };
  },
});
