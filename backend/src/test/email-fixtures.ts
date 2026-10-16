import type { Prisma } from '@prisma/client';
import type { EmailTemplate } from '../outbox/enqueue.js';

/**
 * Fixture payloads for every email template and every `admin_alert` variant
 * (plan.md Task 15). Imported by tests only.
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
/** A contact-email confirmation token: not an access token, and never in a booking link. */
export const FIXTURE_CONFIRM_TOKEN = 'Cf7mN2bV9cX4zL1kJ8hG5fD3sA6pO0iU';

export type EmailFixture = {
  /** Unique; used as the snapshot name. */
  name: string;
  template: EmailTemplate;
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
    name: 'admin_new_booking',
    template: 'admin_new_booking',
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
    name: 'admin_alert payment_received',
    template: 'admin_alert',
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
    name: 'admin_alert retries_exhausted',
    template: 'admin_alert',
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
    name: 'admin_alert login_lockout',
    template: 'admin_alert',
    payload: {
      variant: 'login_lockout',
      failedLoginCount: 5,
      /** format.json `formatDateTime`: 14 Mar 2026, 17:00. */
      lockedUntil: '2026-03-14T15:00:00.000Z',
    },
  },
  {
    name: 'admin_alert password_reset',
    template: 'admin_alert',
    payload: {
      variant: 'password_reset',
      resetUrl: `${FIXTURE_WEB_ORIGIN}/admin/reset-password#token=${FIXTURE_RESET_TOKEN}`,
      /** format.json `formatDateTime`: 1 Jan 2027, 00:00. */
      expiresAt: '2026-12-31T22:00:00.000Z',
    },
  },
  {
    name: 'admin_alert refund_due',
    template: 'admin_alert',
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
    name: 'admin_alert booking_cancelled',
    template: 'admin_alert',
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

/** Every `admin_alert` variant the template accepts. */
export const ADMIN_ALERT_VARIANTS = [
  'payment_received',
  'retries_exhausted',
  'login_lockout',
  'password_reset',
  'refund_due',
  'booking_cancelled',
] as const;

export function emailFixture(name: string): EmailFixture {
  const found = EMAIL_FIXTURES.find((fixture) => fixture.name === name);
  if (found === undefined) throw new Error(`No email fixture named ${name}`);
  return { ...found, payload: structuredClone(found.payload) };
}
