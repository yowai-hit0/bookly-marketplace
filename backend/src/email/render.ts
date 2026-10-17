import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES, t } from '../i18n/index.js';
import type { SendableEmailTemplate } from '../outbox/enqueue.js';
import { type ComposedEmail, type RenderedEmail, renderLayout } from './layout.js';
import { accessLinkResend } from './templates/access-link-resend.js';
import { accountPasswordReset } from './templates/account-password-reset.js';
import { accountSecurityAlert } from './templates/account-security-alert.js';
import { accountVerifyEmail } from './templates/account-verify-email.js';
import { bookingConfirmation } from './templates/booking-confirmation.js';
import { bookingLinks } from './templates/booking-links.js';
import { emailChangeConfirm } from './templates/email-change-confirm.js';
import { emailChangedNotice } from './templates/email-changed-notice.js';
import { cancellation } from './templates/cancellation.js';
import { clientNote } from './templates/client-note.js';
import { paymentReceipt } from './templates/payment-receipt.js';
import { photoDelivery } from './templates/photo-delivery.js';
import { photographerAlert } from './templates/photographer-alert.js';
import { photographerApplicationReceived } from './templates/photographer-application-received.js';
import { photographerApproved } from './templates/photographer-approved.js';
import { photographerNewBooking } from './templates/photographer-new-booking.js';
import { photographerSuspended } from './templates/photographer-suspended.js';
import { platformAlert } from './templates/platform-alert.js';
import { reschedule } from './templates/reschedule.js';
import { sessionFeeRequest } from './templates/session-fee-request.js';
import { type AnyEmailTemplate, EmailPayloadError } from './templates/shared.js';

/**
 * Renders an outbox row's template and payload to a subject, an HTML body and
 * a text body (plan.md Task 15). Later tasks enqueue a template name and a
 * payload; none composes copy.
 *
 * One entry per value of the `outbox_template_allowed` CHECK but the names
 * reserved for later phases (`RESERVED_EMAIL_TEMPLATES`), each in its own file
 * under `templates/`. The record type makes a missing template a compile error;
 * a test holds the CHECK and the files to each other. A reserved name renders
 * as an unknown template: nothing may enqueue one before it has a file here.
 */

export const TEMPLATES: Record<SendableEmailTemplate, AnyEmailTemplate> = {
  booking_confirmation: bookingConfirmation,
  photographer_new_booking: photographerNewBooking,
  session_fee_request: sessionFeeRequest,
  payment_receipt: paymentReceipt,
  photo_delivery: photoDelivery,
  cancellation,
  reschedule,
  access_link_resend: accessLinkResend,
  photographer_alert: photographerAlert,
  platform_alert: platformAlert,
  booking_links: bookingLinks,
  email_change_confirm: emailChangeConfirm,
  email_changed_notice: emailChangedNotice,
  client_note: clientNote,
  account_password_reset: accountPasswordReset,
  account_security_alert: accountSecurityAlert,
  account_verify_email: accountVerifyEmail,
  photographer_application_received: photographerApplicationReceived,
  photographer_approved: photographerApproved,
  photographer_suspended: photographerSuspended,
};

export type RenderOptions = {
  webOrigin: string;
  /** A booking's own locale; anything unsupported falls back to English. */
  locale?: string | null;
};

export function renderEmail(template: string, payload: unknown, options: RenderOptions): RenderedEmail {
  if (!isEmailTemplate(template)) {
    throw new EmailPayloadError(`Unknown email template: ${template}`);
  }
  const definition = TEMPLATES[template];
  const parsed = definition.payload.safeParse(payload);
  if (!parsed.success) {
    // Paths only, never values: a payload holds personal data and live tokens.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))];
    throw new EmailPayloadError(`The ${template} payload is invalid at: ${fields.join(', ')}`);
  }

  const locale = supportedLocale(options.locale);
  const ctx = { webOrigin: options.webOrigin, locale };
  // The data came out of this template's own schema, so it is its payload type.
  const compose = definition.compose as (payload: unknown, context: typeof ctx) => ComposedEmail;
  return renderLayout(compose(parsed.data, ctx), {
    appName: t('common:appName', { lng: locale }),
    footer: t('email:common.footer', { lng: locale, appName: t('common:appName', { lng: locale }) }),
    linkFallback: t('email:common.linkFallback', { lng: locale }),
  });
}

export function isEmailTemplate(value: string): value is SendableEmailTemplate {
  return Object.hasOwn(TEMPLATES, value);
}

function supportedLocale(locale: string | null | undefined): Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale ?? '') ? (locale as Locale) : DEFAULT_LOCALE;
}
