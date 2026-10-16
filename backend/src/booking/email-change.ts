import type { PrismaClient } from '@prisma/client';
import { enqueue } from '../outbox/enqueue.js';
import type { AccessedBooking } from './access.js';
import { generateAccessToken, hashAccessToken } from './access-token.js';

/**
 * A client changes their booking's contact email (docs/prompts/client-access-and-admin-polish.md,
 * item 6; user decision 2026-09-25: confirmed from the new address, and the old
 * one told).
 *
 * Asking, from the booking page, stores the new address as pending with the
 * hash of a fresh confirmation token, and emails the link to the NEW address.
 * Nothing about the booking changes yet: a link holder who is not the client
 * cannot redirect its emails without also owning the new inbox. Confirming,
 * from that email, swaps the address and tells the OLD one.
 *
 * Only this booking's contact email changes. `client.email` is left alone, and
 * so is the booking's access link: a client should not lose their page for
 * correcting a typo. The confirmation token opens nothing but this change.
 */

export const EMAIL_CHANGE_LIFETIME_MS = 24 * 60 * 60_000;
export const EMAIL_CHANGES_PER_DAY = 3;
const CHANGEABLE_STATUSES = ['confirmed', 'completed'];
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{16,256}$/;

export type EmailChangeDeps = { prisma: PrismaClient; now: () => Date };

export type EmailChangeRequest =
  | { status: 'requested'; pendingEmail: string }
  /** The address it already has: nothing to do. */
  | { status: 'unchanged' }
  /** A booking that no longer stands has no emails left to send. */
  | { status: 'not_allowed' }
  | { status: 'rate_limited' };

export async function requestEmailChange(
  deps: EmailChangeDeps,
  booking: AccessedBooking,
  typedEmail: string,
): Promise<EmailChangeRequest> {
  const email = typedEmail.trim().toLowerCase();
  if (!CHANGEABLE_STATUSES.includes(booking.status)) return { status: 'not_allowed' };
  if (email === booking.contactEmail.toLowerCase()) return { status: 'unchanged' };

  const now = deps.now();
  return deps.prisma.$transaction(async (tx) => {
    // One request per booking at a time, so the count below sees the one before.
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM booking WHERE id = ${booking.id}::uuid FOR UPDATE`;
    const status = rows[0]?.status;
    if (status === undefined || !CHANGEABLE_STATUSES.includes(status)) return { status: 'not_allowed' } as const;

    // On the database's clock, the one `outbox.created_at` is stamped with.
    const asked = await tx.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM outbox
       WHERE booking_id = ${booking.id}::uuid
         AND template = 'email_change_confirm'
         AND created_at > now() - interval '24 hours'`;
    if ((asked[0]?.count ?? 0) >= EMAIL_CHANGES_PER_DAY) return { status: 'rate_limited' } as const;

    // A new request replaces any earlier one: its link stops working.
    const { token, hash } = generateAccessToken();
    await tx.booking.update({
      where: { id: booking.id },
      data: {
        pendingContactEmail: email,
        pendingEmailTokenHash: hash,
        pendingEmailExpiresAt: new Date(now.getTime() + EMAIL_CHANGE_LIFETIME_MS),
      },
    });
    await enqueue(tx, {
      kind: 'email',
      template: 'email_change_confirm',
      // The new address: receiving this is the proof it is theirs.
      recipient: email,
      bookingId: booking.id,
      dedupeKey: `email:email_change_confirm:${booking.id}:${hash.slice(0, 16)}`,
      payload: {
        locale: booking.locale,
        reference: booking.reference,
        clientName: booking.contactName,
        serviceName: booking.serviceNameSnapshot,
        packageName: booking.packageNameSnapshot,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        newEmail: email,
        // The only place this plaintext exists.
        confirmToken: token,
      },
    });
    return { status: 'requested', pendingEmail: email } as const;
  });
}

export type EmailChangeConfirmation = { status: 'confirmed'; reference: string } | { status: 'not_found' };

/**
 * Follows a confirmation link. Unknown, expired, replaced and already-used
 * links all answer `not_found`, as a dead booking link does.
 */
export async function confirmEmailChange(deps: EmailChangeDeps, token: string): Promise<EmailChangeConfirmation> {
  if (!TOKEN_FORMAT.test(token)) return { status: 'not_found' };
  const hash = hashAccessToken(token);
  const now = deps.now();

  return deps.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM booking WHERE pending_email_token_hash = ${hash} FOR UPDATE`;
    const id = rows[0]?.id;
    if (id === undefined) return { status: 'not_found' } as const;
    const booking = await tx.booking.findUniqueOrThrow({ where: { id } });

    const live = booking.pendingEmailExpiresAt !== null && booking.pendingEmailExpiresAt > now;
    if (!live || booking.pendingContactEmail === null || !CHANGEABLE_STATUSES.includes(booking.status)) {
      return { status: 'not_found' } as const;
    }

    const oldEmail = booking.contactEmail;
    const newEmail = booking.pendingContactEmail;
    await tx.booking.update({
      where: { id },
      data: { contactEmail: newEmail, pendingContactEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null },
    });
    await enqueue(tx, {
      kind: 'email',
      template: 'email_changed_notice',
      // The old address: the last it hears of this booking.
      recipient: oldEmail,
      bookingId: id,
      dedupeKey: `email:email_changed_notice:${id}:${hash.slice(0, 16)}`,
      payload: {
        locale: booking.locale,
        reference: booking.reference,
        clientName: booking.contactName,
        serviceName: booking.serviceNameSnapshot,
        packageName: booking.packageNameSnapshot,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        newEmail,
      },
    });
    return { status: 'confirmed', reference: booking.reference } as const;
  });
}

/** The pending address a booking's page may show, masked: none once its link has lapsed. */
export function pendingMaskedEmailOf(
  booking: { pendingContactEmail: string | null; pendingEmailExpiresAt: Date | null },
  now: Date,
): string | null {
  return booking.pendingContactEmail !== null && booking.pendingEmailExpiresAt !== null && booking.pendingEmailExpiresAt > now
    ? maskEmail(booking.pendingContactEmail)
    : null;
}

/**
 * `a•••••@example.com`: enough for a client to recognise their own address,
 * too little for whoever else holds the link to learn it (user decision,
 * 2026-09-25: the booking page never carries a full email). The first
 * character, always five dots whatever the length, and the domain.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '\u2022\u2022\u2022\u2022\u2022';
  return `${email.slice(0, 1)}\u2022\u2022\u2022\u2022\u2022${email.slice(at)}`;
}
