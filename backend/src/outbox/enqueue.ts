import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Putting a message on the outbox (plan.md Task 14; data-model_v2.md §5.13):
 * the one queue, and the one audit trail, for everything the system sends.
 *
 * Callers enqueue a template name and a payload resolved at enqueue time; the
 * worker renders and delivers later, retrying with backoff. Nothing sends
 * directly.
 *
 * "Send exactly once" is the `dedupe_key` unique index. A second enqueue with
 * the same key is not an error -- it is the message already being on its way --
 * and is reported as `duplicate`. The insert uses `ON CONFLICT DO NOTHING`
 * rather than catching the unique violation, because a caught 23505 still
 * aborts the surrounding transaction in PostgreSQL, and most enqueues happen
 * inside one (a booking confirming, a cancellation), where the message must
 * commit or roll back with the change it announces.
 *
 * Every row says whose studio it concerns (`outbox.photographer_id`,
 * marketplace-data-model.md §2.14): a booking's row takes its booking's
 * photographer, always, and a row with no booking may name one explicitly.
 * Platform and account mail names none.
 */

/** `outbox_kind_allowed`. */
export const OUTBOX_KINDS = ['email', 'gcal_create', 'gcal_update', 'gcal_delete'] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/**
 * Template names the CHECK already allows for a later phase, so those phases
 * need no template migration (marketplace-data-model.md §5). None has a
 * renderer yet, so none can be enqueued: `SendableEmailTemplate` leaves them
 * out, and the template catalogue test holds the two lists to the CHECK.
 */
export const RESERVED_EMAIL_TEMPLATES = [
  'account_verify_email',
  'photographer_application_received',
  'photographer_approved',
  'photographer_suspended',
  'subscription_reminder',
  'subscription_receipt',
  'subscription_expired',
  'payout_sent',
] as const;
export type ReservedEmailTemplate = (typeof RESERVED_EMAIL_TEMPLATES)[number];

/**
 * `outbox_template_allowed` (marketplace-data-model.md §2.14): the
 * transactional emails of spec §4.1, the four client-access emails of
 * 2026-09-25, the marketplace's split of the old `admin_alert` and
 * `admin_new_booking`, the account emails, and the reserved names above.
 */
export const EMAIL_TEMPLATES = [
  'booking_confirmation',
  'photographer_new_booking',
  'session_fee_request',
  'payment_receipt',
  'photo_delivery',
  'cancellation',
  'reschedule',
  'access_link_resend',
  /** To a booking's photographer: payments, refunds owed, cancellations, failed messages. */
  'photographer_alert',
  /** To every platform admin: what concerns no photographer. */
  'platform_alert',
  'booking_links',
  'email_change_confirm',
  'email_changed_notice',
  'client_note',
  'account_password_reset',
  /** Sign-in lockout today; a changed payout method in Phase 4 (R4.1). */
  'account_security_alert',
  ...RESERVED_EMAIL_TEMPLATES,
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

/** The templates with a renderer: everything the CHECK allows but the reserved names. */
export type SendableEmailTemplate = Exclude<EmailTemplate, ReservedEmailTemplate>;

export const SENDABLE_EMAIL_TEMPLATES = EMAIL_TEMPLATES.filter(
  (template): template is SendableEmailTemplate => !(RESERVED_EMAIL_TEMPLATES as readonly string[]).includes(template),
);

export type OutboxMessage =
  | {
      kind: 'email';
      template: SendableEmailTemplate;
      recipient: string;
      /** e.g. `email:booking_confirmation:<booking_id>`. A resend is a new key. */
      dedupeKey: string;
      payload: Prisma.InputJsonObject;
      /** Null for messages that address no booking, like the photographer and platform alerts. */
      bookingId?: string | null;
      /**
       * The studio a message with no booking concerns, such as a photographer
       * alert. With a booking it may be left out -- the booking's photographer
       * is used -- and naming a different one is refused.
       */
      photographerId?: string | null;
    }
  | {
      kind: 'gcal_create' | 'gcal_update' | 'gcal_delete';
      bookingId: string;
      dedupeKey: string;
      payload: Prisma.InputJsonObject;
    };

export type EnqueueResult = 'enqueued' | 'duplicate';

/** Works on the root client or inside a transaction. */
export async function enqueue(
  db: PrismaClient | Prisma.TransactionClient,
  message: OutboxMessage,
): Promise<EnqueueResult> {
  const bookingId = message.bookingId ?? null;
  const photographerId = await photographerFor(db, message, bookingId);
  const { count } = await db.outbox.createMany({
    data: [
      {
        kind: message.kind,
        dedupeKey: message.dedupeKey,
        payload: message.payload,
        bookingId,
        photographerId,
        template: message.kind === 'email' ? message.template : null,
        recipient: message.kind === 'email' ? message.recipient : null,
      },
    ],
    skipDuplicates: true,
  });
  return count === 1 ? 'enqueued' : 'duplicate';
}

/**
 * The booking's photographer when there is a booking -- read from the booking,
 * never trusted from the caller, so a row can only ever be filed under the
 * studio its booking belongs to (`outbox_booking_has_photographer` makes it
 * required). A caller that names a different photographer has a bug, and
 * enqueuing that message would send one studio's mail under another's name.
 */
async function photographerFor(
  db: PrismaClient | Prisma.TransactionClient,
  message: OutboxMessage,
  bookingId: string | null,
): Promise<string | null> {
  const explicit = message.kind === 'email' ? (message.photographerId ?? null) : null;
  if (bookingId === null) return explicit;

  const booking = await db.booking.findUnique({ where: { id: bookingId }, select: { photographerId: true } });
  // A missing booking is left to the database: the foreign key refuses the insert.
  if (booking === null) return explicit;
  if (explicit !== null && explicit !== booking.photographerId) {
    throw new Error(`Outbox message ${message.dedupeKey} names a photographer other than its booking's`);
  }
  return booking.photographerId;
}
