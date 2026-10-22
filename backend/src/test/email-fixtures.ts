import type { Prisma } from '@prisma/client';
import type { SendableEmailTemplate } from '../outbox/enqueue.js';

/**
 * Fixture payloads for every sendable email template and every variant of the
 * templates that have them (plan.md Task 15). Imported by tests only.
 *
 * Instants are chosen from `docs/fixtures/format.json` where they can be, so a
 * rendered time can be read against the shared fixture. The access token is
 * long and distinctive so that "the token appears nowhere else" is a string
 * search that cannot match by accident.
 */

export const FIXTURE_WEB_ORIGIN = 'https://bookly.example';

/** 32 base64url characters; matches the payload schema's `accessToken`. */
export const FIXTURE_ACCESS_TOKEN = 'Zx9Q2mT7vL4pR8sK1nB6yH3cF5dG0wJe';
export const FIXTURE_RESET_TOKEN = 'rS3tT0k3n_aB9cD8eF7gH6iJ5kL4mN3o';
export const FIXTURE_REFERENCE = 'BKY-2610-7K3MQ';
/** A second booking of the same client, for the email that lists several. */
export const FIXTURE_SECOND_REFERENCE = 'BKY-2610-9P2RT';
export const FIXTURE_SECOND_ACCESS_TOKEN = 'Qw8E1rT5yU2iO9pA3sD7fG4hJ6kL0zXc';
/** An email-verification token: 256 bits of base64url, as `issueVerification` mints it (Phase 2 decision 3). */
export const FIXTURE_VERIFY_TOKEN = 'Vf3rT0k3n_aB9cD8eF7gH6iJ5kL4mN3oP2qR1sT0uVw';
/** A contact-email confirmation token: not an access token, and never in a booking link. */
export const FIXTURE_CONFIRM_TOKEN = 'Cf7mN2bV9cX4zL1kJ8hG5fD3sA6pO0iU';

export type EmailFixture = {
  /** Unique; used as the snapshot name. */
  name: string;
  template: SendableEmailTemplate;
  payload: Prisma.InputJsonObject;
};

const basics = {
  reference: FIXTURE_REFERENCE,
  clientName: 'Aline Uwase',
  serviceName: 'Portrait',
  packageName: 'Standard',
  /** 09:30 Kigali (format.json `formatTime`), Wednesday 7 October 2026. */
  startsAt: '2026-10-07T07:30:00Z',
  endsAt: '2026-10-07T08:30:00Z',
};

export const EMAIL_FIXTURES: readonly EmailFixture[] = [
  {
    name: 'booking_confirmation',
    template: 'booking_confirmation',
    payload: {
      ...basics,
      locationText: 'Kigali Heights, KG 7 Ave',
      paidRwf: 18_000,
      outstandingRwf: 27_000,
      accessToken: FIXTURE_ACCESS_TOKEN,
    },
  },
  {
    name: 'photographer_new_booking',
    template: 'photographer_new_booking',
    payload: {
      ...basics,
      clientEmail: 'aline@example.com',
      clientPhone: '+250788000000',
      locationText: 'Kigali Heights, KG 7 Ave',
      partySize: 3,
      specialRequests: 'Outdoor shots if the weather allows.\nPlease bring a reflector.',
      addons: [{ name: 'Extra 10 photos', priceRwf: 5_000 }],
      totalRwf: 45_000,
      paidRwf: 18_000,
      outstandingRwf: 27_000,
    },
  },
  {
    name: 'session_fee_request',
    template: 'session_fee_request',
    payload: { ...basics, amountRwf: 27_000, accessToken: FIXTURE_ACCESS_TOKEN },
  },
  {
    name: 'payment_receipt',
    template: 'payment_receipt',
    payload: {
      ...basics,
      kind: 'session_fee',
      amountRwf: 27_000,
      /** format.json `formatDateTime`: 15 Jan 2026, 23:30. */
      paidAt: '2026-01-15T21:30:00Z',
      paymentReference: 'PAY-7F3K9Q',
      totalRwf: 45_000,
      paidRwf: 45_000,
      outstandingRwf: 0,
      accessToken: FIXTURE_ACCESS_TOKEN,
    },
  },
  {
    name: 'photo_delivery',
    template: 'photo_delivery',
    payload: {
      reference: FIXTURE_REFERENCE,
      clientName: 'Aline Uwase',
      serviceName: 'Portrait',
      deliveryUrl: 'https://photos.example-host.com/s/abc123',
      /** format.json `formatDate`: Friday, 1 January 2027. */
      expiresOn: '2027-01-01',
      note: 'Thank you for a lovely morning!',
    },
  },
  {
    name: 'cancellation (by client)',
    template: 'cancellation',
    payload: { ...basics, cancelledBy: 'client', reason: null, bookingFeeRwf: 18_000, refundRwf: 0 },
  },
  {
    name: 'cancellation (by admin)',
    template: 'cancellation',
    payload: {
      ...basics,
      cancelledBy: 'admin',
      reason: 'The photographer is unwell.',
      bookingFeeRwf: 18_000,
      refundRwf: 18_000,
    },
  },
  {
    name: 'reschedule',
    template: 'reschedule',
    payload: {
      ...basics,
      startsAt: '2026-10-09T09:00:00Z',
      endsAt: '2026-10-09T10:00:00Z',
      previousStartsAt: basics.startsAt,
      previousEndsAt: basics.endsAt,
      locationText: 'Kigali Heights, KG 7 Ave',
      accessToken: FIXTURE_ACCESS_TOKEN,
    },
  },
  {
    name: 'access_link_resend',
    template: 'access_link_resend',
    payload: { ...basics, accessToken: FIXTURE_ACCESS_TOKEN },
  },
  {
    name: 'client_note',
    template: 'client_note',
    payload: { ...basics, body: 'Please bring a jacket: it gets cold up there.\nSee you at 09:30.' },
  },
  {
    name: 'email_change_confirm',
    template: 'email_change_confirm',
    payload: { ...basics, newEmail: 'aline.new@example.com', confirmToken: FIXTURE_CONFIRM_TOKEN },
  },
  {
    name: 'email_changed_notice',
    template: 'email_changed_notice',
    payload: { ...basics, newEmail: 'aline.new@example.com' },
  },
  {
    name: 'booking_links',
    template: 'booking_links',
    payload: {
      locale: 'en',
      clientName: 'Aline Uwase',
      bookings: [
        { reference: FIXTURE_REFERENCE, serviceName: 'Portrait', packageName: 'Standard', startsAt: basics.startsAt, endsAt: basics.endsAt, accessToken: FIXTURE_ACCESS_TOKEN },
        {
          reference: FIXTURE_SECOND_REFERENCE,
          serviceName: 'Events',
          packageName: 'Half day',
          startsAt: '2026-10-09T09:00:00Z',
          endsAt: '2026-10-09T13:00:00Z',
          accessToken: FIXTURE_SECOND_ACCESS_TOKEN,
        },
      ],
    },
  },
  {
    name: 'photographer_alert payment_received',
    template: 'photographer_alert',
    payload: {
      variant: 'payment_received',
      reference: FIXTURE_REFERENCE,
      clientName: 'Aline Uwase',
      kind: 'booking_fee',
      amountRwf: 18_000,
      /** format.json `formatDateTime`: 1 Jul 2026, 08:00. */
      paidAt: '2026-07-01T06:00:00Z',
      outstandingRwf: 27_000,
      startsAt: basics.startsAt,
    },
  },
  {
    name: 'photographer_alert retries_exhausted',
    template: 'photographer_alert',
    payload: {
      variant: 'retries_exhausted',
      messageKind: 'email',
      template: 'booking_confirmation',
      bookingReference: FIXTURE_REFERENCE,
      attempts: 8,
      lastError: 'Error: Resend answered 503: service unavailable',
    },
  },
  {
    name: 'platform_alert retries_exhausted',
    template: 'platform_alert',
    payload: {
      variant: 'retries_exhausted',
      messageKind: 'email',
      template: 'account_password_reset',
      bookingReference: null,
      attempts: 1,
      lastError: 'PermanentOutboxError: Resend refused the recipient',
    },
  },
  {
    name: 'account_security_alert login_lockout',
    template: 'account_security_alert',
    payload: {
      variant: 'login_lockout',
      area: 'account',
      failedLoginCount: 5,
      /** format.json `formatDateTime`: 14 Mar 2026, 17:00. */
      lockedUntil: '2026-03-14T15:00:00.000Z',
    },
  },
  {
    name: 'account_security_alert payout_method_changed',
    template: 'account_security_alert',
    payload: {
      variant: 'payout_method_changed',
      area: 'studio',
      replaced: true,
      /** format.json `formatDateTime`: 14 Mar 2026, 17:00. */
      changedAt: '2026-03-14T15:00:00.000Z',
      destination: { kind: 'bank', provider: 'Bank of Kigali', last4: '4567' },
    },
  },
  {
    name: 'payout_sent',
    template: 'payout_sent',
    payload: {
      displayName: 'Kigali Lens',
      amountRwf: 125_000,
      transferReference: 'MTN-TX-4471',
      /** format.json `formatDateTime`: 1 Jul 2026, 08:00. */
      paidAt: '2026-07-01T06:00:00Z',
      itemCount: 3,
      destination: { kind: 'momo', provider: 'mtn', last4: '3456' },
    },
  },
  {
    name: 'account_password_reset',
    template: 'account_password_reset',
    payload: {
      resetUrl: `${FIXTURE_WEB_ORIGIN}/studio/reset-password#token=${FIXTURE_RESET_TOKEN}`,
      /** format.json `formatDateTime`: 1 Jan 2027, 00:00. */
      expiresAt: '2026-12-31T22:00:00.000Z',
    },
  },
  {
    name: 'account_security_alert account_exists',
    template: 'account_security_alert',
    payload: { variant: 'account_exists', area: 'studio' },
  },
  {
    name: 'account_verify_email',
    template: 'account_verify_email',
    payload: {
      area: 'account',
      token: FIXTURE_VERIFY_TOKEN,
      /** format.json `formatDateTime`: 1 Jan 2027, 00:00. */
      expiresAt: '2026-12-31T22:00:00.000Z',
    },
  },
  {
    name: 'photographer_application_received',
    template: 'photographer_application_received',
    payload: { displayName: 'Kigali Lens', handle: 'kigali-lens', email: 'studio@kigali-lens.example' },
  },
  {
    name: 'photographer_approved',
    template: 'photographer_approved',
    payload: { displayName: 'Kigali Lens', handle: 'kigali-lens' },
  },
  {
    name: 'photographer_suspended',
    template: 'photographer_suspended',
    payload: { displayName: 'Kigali Lens', reason: 'Several clients reported shoots that did not happen.' },
  },
  {
    name: 'photographer_alert refund_due',
    template: 'photographer_alert',
    payload: {
      variant: 'refund_due',
      reference: FIXTURE_REFERENCE,
      clientName: 'Aline Uwase',
      amountRwf: 18_000,
      reason: 'admin_cancelled',
      paymentReference: 'PAY-7F3K9Q',
      provider: 'mtn_momo_direct',
      startsAt: basics.startsAt,
    },
  },
  {
    name: 'photographer_alert booking_cancelled',
    template: 'photographer_alert',
    payload: {
      variant: 'booking_cancelled',
      reference: FIXTURE_REFERENCE,
      clientName: 'Aline Uwase',
      serviceName: 'Portrait',
      startsAt: basics.startsAt,
      endsAt: basics.endsAt,
      bookingFeeRwf: 18_000,
    },
  },
];

/**
 * Every variant each template with variants accepts. The old `admin_alert`'s six
 * are split among the first three (marketplace-data-model.md §2.14); its
 * `password_reset` is the variant-less `account_password_reset`.
 */
export const TEMPLATE_VARIANTS = {
  photographer_alert: ['payment_received', 'retries_exhausted', 'refund_due', 'booking_cancelled'],
  platform_alert: ['retries_exhausted'],
  account_security_alert: ['login_lockout', 'account_exists', 'payout_method_changed'],
} as const satisfies Partial<Record<SendableEmailTemplate, readonly string[]>>;

export function emailFixture(name: string): EmailFixture {
  const found = EMAIL_FIXTURES.find((fixture) => fixture.name === name);
  if (found === undefined) throw new Error(`No email fixture named ${name}`);
  return { ...found, payload: structuredClone(found.payload) };
}
