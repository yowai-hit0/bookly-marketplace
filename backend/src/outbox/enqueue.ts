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
 */

/** `outbox_kind_allowed`. */
export const OUTBOX_KINDS = ['email', 'gcal_create', 'gcal_update', 'gcal_delete'] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/** `outbox_template_allowed`: the transactional emails (spec §4.1, plus the four client-access emails of 2026-09-25). */
export const EMAIL_TEMPLATES = [
  'booking_confirmation',
  'admin_new_booking',
  'session_fee_request',
  'payment_receipt',
  'photo_delivery',
  'cancellation',
  'reschedule',
  'access_link_resend',
  'admin_alert',
  'booking_links',
  'email_change_confirm',
  'email_changed_notice',
  'client_note',
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export type OutboxMessage =
  | {
      kind: 'email';
      template: EmailTemplate;
      recipient: string;
      /** e.g. `email:booking_confirmation:<booking_id>`. A resend is a new key. */
      dedupeKey: string;
      payload: Prisma.InputJsonObject;
      /** Null for messages that address no booking, like most admin alerts. */
      bookingId?: string | null;
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
  const { count } = await db.outbox.createMany({
    data: [
      {
        kind: message.kind,
        dedupeKey: message.dedupeKey,
        payload: message.payload,
        bookingId: message.bookingId ?? null,
        template: message.kind === 'email' ? message.template : null,
        recipient: message.kind === 'email' ? message.recipient : null,
      },
    ],
    skipDuplicates: true,
  });
  return count === 1 ? 'enqueued' : 'duplicate';
}
