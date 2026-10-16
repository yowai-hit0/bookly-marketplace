import { enqueue } from '../outbox/enqueue.js';
import type { AdminActionDeps, AdminActionResult } from './admin-actions.js';
import { findAdminBooking } from './admin-view.js';

/**
 * Notes the photographer writes to a client (docs/prompts/client-access-and-admin-polish.md,
 * item 8): shown on the client's booking page, and emailed when asked -- which
 * the form asks by default (user decision, 2026-09-25). A deleted note is
 * hidden from the client and kept, with `deleted_at`.
 *
 * Any booking may carry a note, whatever its status: a cancelled one is
 * exactly where a word to the client may be owed. Only a booking with no
 * confirmed client cannot, because nobody was ever sent its page.
 */

export const NOTE_MAX_LENGTH = 1000;

export async function addNote(
  deps: AdminActionDeps,
  bookingId: string,
  note: { body: string; email: boolean },
): Promise<AdminActionResult> {
  const booking = await findAdminBooking(deps.prisma, bookingId);
  if (booking === null) return { status: 'not_found' };
  // Never confirmed: no client has the page this note would appear on.
  if (booking.confirmedAt === null) return { status: 'not_allowed' };

  await deps.prisma.$transaction(async (tx) => {
    const created = await tx.bookingNote.create({
      data: { bookingId, body: note.body, emailed: note.email, createdAt: deps.now() },
    });
    if (!note.email) return;
    await enqueue(tx, {
      kind: 'email',
      template: 'client_note',
      recipient: booking.contactEmail,
      bookingId,
      dedupeKey: `email:client_note:${created.id}`,
      payload: {
        locale: booking.locale,
        reference: booking.reference,
        clientName: booking.contactName,
        serviceName: booking.serviceNameSnapshot,
        packageName: booking.packageNameSnapshot,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        body: note.body,
      },
    });
  });
  return reload(deps, bookingId);
}

/** Hides a note from the client. An email already sent stays sent. */
export async function deleteNote(deps: AdminActionDeps, bookingId: string, noteId: string): Promise<AdminActionResult> {
  const { count } = await deps.prisma.bookingNote.updateMany({
    where: { id: noteId, bookingId, deletedAt: null },
    data: { deletedAt: deps.now() },
  });
  if (count === 0) {
    // An unknown note, one on another booking, or one already deleted: all "not here".
    return { status: 'not_found' };
  }
  return reload(deps, bookingId);
}

async function reload(deps: AdminActionDeps, bookingId: string): Promise<AdminActionResult> {
  const booking = await findAdminBooking(deps.prisma, bookingId);
  return booking === null ? { status: 'not_found' } : { status: 'ok', booking };
}
