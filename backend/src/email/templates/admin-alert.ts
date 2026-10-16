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
  onSite,
  paymentKind,
  paymentProvider,
  personName,
  reference,
  siteUrl,
  text,
  tr,
  when,
} from './shared.js';

/**
 * Everything addressed to the photographer that is not a new booking
 * (data-model_v2.md §5.13, plan.md Task 15), one variant per situation:
 *
 *   payment_received    a payment arrived (Tasks 17, 20)
 *   retries_exhausted   the outbox gave up on a message (Task 14)
 *   login_lockout       sign-in locked after failed attempts (Task 7)
 *   password_reset      the emailed reset link (Task 7)
 *   refund_due          money is owed back, and only he can send it (Tasks 17-19)
 *   booking_cancelled   a client cancelled (Task 18)
 *
 * `login_lockout` and `password_reset` render exactly the payloads Task 7
 * already enqueues.
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

const retriesExhausted = z.object({
  variant: z.literal('retries_exhausted'),
  messageKind: z.enum(OUTBOX_KINDS),
  template: z.string().nullable(),
  bookingReference: reference.nullable(),
  attempts: z.int().min(1),
  lastError: z.string().max(2000),
});

const loginLockout = z.object({
  variant: z.literal('login_lockout'),
  failedLoginCount: z.int().min(1),
  lockedUntil: instant,
});

const passwordReset = z.object({
  variant: z.literal('password_reset'),
  /** Built by Task 7 on WEB_ORIGIN, with the token in the fragment. */
  resetUrl: z.url(),
  expiresAt: instant,
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
  ]),
  paymentReference: text(100),
  provider: paymentProvider,
  startsAt: instant,
});

const bookingCancelled = z.object({
  variant: z.literal('booking_cancelled'),
  reference,
  clientName: personName,
  serviceName: text(200),
  startsAt: instant,
  endsAt: instant,
  bookingFeeRwf: amountRwf,
});

export const adminAlert = defineTemplate({
  payload: z.discriminatedUnion('variant', [
    paymentReceived,
    retriesExhausted,
    loginLockout,
    passwordReset,
    refundDue,
    bookingCancelled,
  ]),
  compose(p, ctx): ComposedEmail {
    switch (p.variant) {
      case 'payment_received':
        return composePaymentReceived(p, ctx);
      case 'retries_exhausted':
        return composeRetriesExhausted(p, ctx);
      case 'login_lockout':
        return composeLoginLockout(p, ctx);
      case 'password_reset':
        return composePasswordReset(p, ctx);
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

function composeRetriesExhausted(p: z.infer<typeof retriesExhausted>, ctx: EmailContext): ComposedEmail {
  const what = p.messageKind === 'email' ? (p.template ?? p.messageKind) : p.messageKind;
  const rows = [
    { label: tr(ctx, 'email:adminAlert.retriesExhausted.message'), value: tr(ctx, `email:adminAlert.retriesExhausted.messages.${what}`) },
    ...(p.bookingReference === null ? [] : [{ label: tr(ctx, 'email:common.labels.reference'), value: p.bookingReference }]),
    { label: tr(ctx, 'email:adminAlert.retriesExhausted.lastError'), value: p.lastError },
  ];
  return {
    subject: tr(ctx, 'email:adminAlert.retriesExhausted.subject'),
    preheader: tr(ctx, 'email:adminAlert.retriesExhausted.preheader', { count: p.attempts }),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:adminAlert.retriesExhausted.heading') },
      { type: 'paragraph', text: tr(ctx, 'email:adminAlert.retriesExhausted.intro', { count: p.attempts }) },
      { type: 'details', rows },
      { type: 'paragraph', text: tr(ctx, 'email:adminAlert.retriesExhausted.advice') },
    ],
  };
}

function composeLoginLockout(p: z.infer<typeof loginLockout>, ctx: EmailContext): ComposedEmail {
  const until = formatDateTime(p.lockedUntil);
  return {
    subject: tr(ctx, 'email:adminAlert.loginLockout.subject', { count: p.failedLoginCount }),
    preheader: tr(ctx, 'email:adminAlert.loginLockout.preheader', { until }),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:adminAlert.loginLockout.heading') },
      { type: 'paragraph', text: tr(ctx, 'email:adminAlert.loginLockout.intro', { count: p.failedLoginCount, until }) },
      { type: 'paragraph', text: tr(ctx, 'email:adminAlert.loginLockout.ifNotYou') },
      { type: 'button', label: tr(ctx, 'email:adminAlert.loginLockout.signIn'), href: siteUrl(ctx, '/admin/login') },
    ],
  };
}

function composePasswordReset(p: z.infer<typeof passwordReset>, ctx: EmailContext): ComposedEmail {
  const until = formatDateTime(p.expiresAt);
  return {
    subject: tr(ctx, 'email:adminAlert.passwordReset.subject'),
    preheader: tr(ctx, 'email:adminAlert.passwordReset.preheader', { until }),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:adminAlert.passwordReset.heading') },
      { type: 'paragraph', text: tr(ctx, 'email:adminAlert.passwordReset.intro', { until }) },
      { type: 'button', label: tr(ctx, 'email:adminAlert.passwordReset.button'), href: onSite(ctx, p.resetUrl) },
      { type: 'paragraph', text: tr(ctx, 'email:adminAlert.passwordReset.ignore') },
    ],
  };
}

function composeRefundDue(p: z.infer<typeof refundDue>, ctx: EmailContext): ComposedEmail {
  const amount = money(p.amountRwf);
  const provider = tr(ctx, `email:common.providers.${p.provider}`);
  return {
    subject: tr(ctx, 'email:adminAlert.refundDue.subject', { amount, client: p.clientName, reference: p.reference }),
    preheader: tr(ctx, 'email:adminAlert.refundDue.preheader'),
    blocks: [
      { type: 'heading', text: tr(ctx, 'email:adminAlert.refundDue.heading') },
      { type: 'paragraph', text: tr(ctx, `email:adminAlert.refundDue.reasons.${p.reason}`) },
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
      // Cash goes back as cash: there is no provider to refund it through.
      {
        type: 'note',
        text: p.provider === 'cash' ? tr(ctx, 'email:adminAlert.refundDue.howToCash') : tr(ctx, 'email:adminAlert.refundDue.howTo', { provider }),
      },
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
      { type: 'paragraph', text: tr(ctx, 'email:adminAlert.bookingCancelled.feeKept', { amount: money(p.bookingFeeRwf) }) },
      { type: 'details', rows: [{ label: tr(ctx, 'email:common.labels.reference'), value: p.reference }] },
    ],
  };
}
