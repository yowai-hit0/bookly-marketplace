import { z } from 'zod';
import { formatDateTime } from '../../format.js';
import { OUTBOX_KINDS } from '../../outbox/enqueue.js';
import type { ComposedEmail } from '../layout.js';
import {
  type EmailContext,
  adminCalendarLink,
  amountRwf,
  dateOf,
  defineTemplate,
  instant,
  money,
  paymentKind,
  paymentProvider,
  personName,
  reference,
  text,
  tr,
  when,
} from './shared.js';

/**
 * Everything addressed to a booking's photographer that is not a new booking
 * (data-model_v2.md §5.13, plan.md Task 15, marketplace-spec.md R1.7), one
 * variant per situation:
 *
 *   payment_received    a payment arrived (Tasks 17, 20)
 *   retries_exhausted   the outbox gave up on a message of theirs (Task 14)
 *   refund_due          money is owed back (Tasks 17-19). Cash is theirs to give
 *                       back and record; since Phase 4 money paid online is in
 *                       the platform's account, so the platform refunds it and
 *                       the email says there is nothing for them to send (R4.6).
 *                       An overpayment says the platform will return the
 *                       difference, and nothing comes off a payout: the earning
 *                       was only ever what was due (Phase 4 overpayment decision)
 *   booking_cancelled   a client cancelled (Task 18)
 *
 * This is the photographer's half of the old `admin_alert`
 * (marketplace-data-model.md §2.14). What concerns no photographer is
 * `platform_alert`, and the sign-in lockout and the reset link are now the
 * account emails `account_security_alert` and `account_password_reset`. The
 * copy keys keep their `adminAlert` names: en.json strings may not be edited,
 * and these already speak to the photographer.
 */

const paymentReceived = z.object({
  variant: z.literal('payment_received'),
  reference,
  clientName: personName,
  kind: paymentKind,
  amountRwf,
  paidAt: instant,
  outstandingRwf: amountRwf,
  /** The shoot, for the calendar link. */
  startsAt: instant,
});

/** Shared with `platform_alert`, which tells the platform admins the same thing. */
export const retriesExhausted = z.object({
  variant: z.literal('retries_exhausted'),
  messageKind: z.enum(OUTBOX_KINDS),
  template: z.string().nullable(),
  bookingReference: reference.nullable(),
  attempts: z.int().min(1),
  lastError: z.string().max(2000),
});

const refundDue = z.object({
  variant: z.literal('refund_due'),
  reference,
  clientName: personName,
  amountRwf,
  reason: z.enum([
    'admin_cancelled',
    'late_payment_slot_taken',
    'duplicate_payment',
    'overpayment',
    'session_fee_after_client_cancel',
    // The photographer's own policy refunds the booking fee on a client's cancellation (R1.8).
    'booking_fee_after_client_cancel',
  ]),
  paymentReference: text(100),
  provider: paymentProvider,
  startsAt: instant,
  /**
   * Which fee is owed back, where the reason alone does not say: a
   * `duplicate_payment` session fee arrived after the booking was paid in full
   * (Phase 4 overpayment decision). Absent on older rows, read as a booking fee.
   */
  paymentKind: z.enum(['booking_fee', 'session_fee']).optional(),
});

const bookingCancelled = z.object({
  variant: z.literal('booking_cancelled'),
  reference,
  clientName: personName,
  serviceName: text(200),
  startsAt: instant,
  endsAt: instant,
  bookingFeeRwf: amountRwf,
  /** Their cancellation policy refunds the fee (R1.8); a refund_due alert of its own follows. */
  bookingFeeRefunded: z.boolean().default(false),
});

export const photographerAlert = defineTemplate({
  payload: z.discriminatedUnion('variant', [paymentReceived, retriesExhausted, refundDue, bookingCancelled]),
  compose(p, ctx): ComposedEmail {
    switch (p.variant) {
      case 'payment_received':
        return composePaymentReceived(p, ctx);
      case 'retries_exhausted':
        return composeRetriesExhausted(p, ctx, 'email:adminAlert.retriesExhausted');
      case 'refund_due':
        return composeRefundDue(p, ctx);
      case 'booking_cancelled':
        return composeBookingCancelled(p, ctx);
    }
  },
});

function composePaymentReceived(p: z.infer<typeof paymentReceived>, ctx: EmailContext): ComposedEmail {
  const amount = money(p.amountRwf);
  const kind = tr(ctx, `email:common.paymentKinds.${p.kind}`);
  return {
    subject: tr(ctx, 'email:adminAlert.paymentReceived.subject', { amount, client: p.clientName, reference: p.reference }),
    preheader: tr(ctx, 'email:adminAlert.paymentReceived.preheader', { client: p.clientName, kind }),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:adminAlert.paymentReceived.heading') },
      { type: 'paragraph', text: tr(ctx, 'email:adminAlert.paymentReceived.intro', { client: p.clientName, kind, amount }) },
      {
        type: 'details',
        rows: [
          { label: tr(ctx, 'email:common.labels.reference'), value: p.reference },
          { label: tr(ctx, 'email:common.labels.client'), value: p.clientName },
          { label: tr(ctx, 'email:common.labels.amount'), value: amount },
          {
            label: tr(ctx, 'email:common.labels.paidAt'),
            value: tr(ctx, 'email:common.atValue', { dateTime: formatDateTime(p.paidAt) }),
          },
          { label: tr(ctx, 'email:common.labels.outstanding'), value: money(p.outstandingRwf) },
        ],
      },
      {
        type: 'button',
        label: tr(ctx, 'email:adminAlert.paymentReceived.openCalendar'),
        href: adminCalendarLink(ctx, p.startsAt),
      },
    ],
  };
}

/**
 * "A message could not be sent", in the words under `keys`: the photographer's
 * copy here, the platform admins' in `platform_alert`. Both name the message
 * from a `messages.<template or kind>` table, so every template the CHECK
 * allows needs a line in each.
 */
export function composeRetriesExhausted(
  p: z.infer<typeof retriesExhausted>,
  ctx: EmailContext,
  keys: 'email:adminAlert.retriesExhausted' | 'email:platformAlert.retriesExhausted',
): ComposedEmail {
  const what = p.messageKind === 'email' ? (p.template ?? p.messageKind) : p.messageKind;
  const rows = [
    { label: tr(ctx, `${keys}.message`), value: tr(ctx, `${keys}.messages.${what}`) },
    ...(p.bookingReference === null ? [] : [{ label: tr(ctx, 'email:common.labels.reference'), value: p.bookingReference }]),
    { label: tr(ctx, `${keys}.lastError`), value: p.lastError },
  ];
  return {
    subject: tr(ctx, `${keys}.subject`),
    preheader: tr(ctx, `${keys}.preheader`, { count: p.attempts }),
    blocks: [
      { type: 'heading', text: tr(ctx, `${keys}.heading`) },
      { type: 'paragraph', text: tr(ctx, `${keys}.intro`, { count: p.attempts }) },
      { type: 'details', rows },
      { type: 'paragraph', text: tr(ctx, `${keys}.advice`) },
    ],
  };
}

function composeRefundDue(p: z.infer<typeof refundDue>, ctx: EmailContext): ComposedEmail {
  const amount = money(p.amountRwf);
  const provider = tr(ctx, `email:common.providers.${p.provider}`);
  // Paid online, the money is in the platform's account: the platform refunds it (Phase 4 refund decision).
  const online = p.provider !== 'cash';
  const reasonKey = p.reason === 'duplicate_payment' && p.paymentKind === 'session_fee' ? 'duplicate_session_fee' : p.reason;
  // An overpayment's earning was never more than what was due, so nothing comes off a payout: the platform returns the difference.
  const howToPlatform = p.reason === 'overpayment' ? 'email:adminAlert.refundDue.howToPlatformOverpayment' : 'email:adminAlert.refundDue.howToPlatform';
  return {
    subject: tr(ctx, 'email:adminAlert.refundDue.subject', { amount, client: p.clientName, reference: p.reference }),
    preheader: tr(ctx, online ? 'email:adminAlert.refundDue.preheaderPlatform' : 'email:adminAlert.refundDue.preheader'),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:adminAlert.refundDue.heading') },
      { type: 'paragraph', text: tr(ctx, `email:adminAlert.refundDue.reasons.${reasonKey}`) },
      {
        type: 'details',
        rows: [
          { label: tr(ctx, 'email:common.labels.reference'), value: p.reference },
          { label: tr(ctx, 'email:common.labels.client'), value: p.clientName },
          { label: tr(ctx, 'email:common.labels.amount'), value: amount },
          { label: tr(ctx, 'email:common.labels.paymentReference'), value: p.paymentReference },
          { label: tr(ctx, 'email:common.labels.provider'), value: provider },
        ],
      },
      // Cash goes back as cash, from the photographer; money paid online goes
      // back from the platform's account, which records it (R4.6).
      { type: 'note', text: online ? tr(ctx, howToPlatform) : tr(ctx, 'email:adminAlert.refundDue.howToCash') },
      {
        type: 'button',
        label: tr(ctx, 'email:adminAlert.paymentReceived.openCalendar'),
        href: adminCalendarLink(ctx, p.startsAt),
      },
    ],
  };
}

function composeBookingCancelled(p: z.infer<typeof bookingCancelled>, ctx: EmailContext): ComposedEmail {
  return {
    subject: tr(ctx, 'email:adminAlert.bookingCancelled.subject', {
      client: p.clientName,
      date: dateOf(p.startsAt),
      reference: p.reference,
    }),
    preheader: tr(ctx, 'email:adminAlert.bookingCancelled.preheader'),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:adminAlert.bookingCancelled.heading') },
      {
        type: 'paragraph',
        text: tr(ctx, 'email:adminAlert.bookingCancelled.intro', {
          client: p.clientName,
          service: p.serviceName,
          when: when(ctx, p.startsAt, p.endsAt),
        }),
      },
      {
        type: 'paragraph',
        text: tr(ctx, p.bookingFeeRefunded ? 'email:adminAlert.bookingCancelled.feeRefunded' : 'email:adminAlert.bookingCancelled.feeKept', {
          amount: money(p.bookingFeeRwf),
        }),
      },
      { type: 'details', rows: [{ label: tr(ctx, 'email:common.labels.reference'), value: p.reference }] },
    ],
  };
}
