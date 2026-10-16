import type { Prisma } from '@prisma/client';

/**
 * Where a booking is in its life, for display (docs/prompts/client-access-and-admin-polish.md,
 * item 7; user decisions 2026-09-25).
 *
 * A stage is computed, never stored. `booking.status`, its CHECK and every rule
 * that reads it stay exactly as they are -- photo delivery still needs
 * `completed`, and "Mark completed" and "No-show" are still the photographer's.
 * The stage only says, in the words a person would use, what the stored status
 * and the clock together mean:
 *
 *   awaiting_payment   pending_payment
 *   confirmed          confirmed, the shoot still ahead
 *   in_progress        confirmed, the shoot happening now
 *   needs_review       confirmed, the shoot over but not yet marked (admin only;
 *                      the client sees `completed`: from their side it is)
 *   completed          completed, the photos not yet sent -- whatever is still
 *                      owed, which the page shows on its own
 *   closed             completed, and the photos email has gone
 *   no_show, expired, cancelled_by_client, cancelled_by_admin   as stored
 *
 * `bookingStage()` is the one definition; `stageWhere()` is the same rule as a
 * database filter, and a test holds the two to each other.
 */

export const BOOKING_STAGES = [
  'awaiting_payment',
  'confirmed',
  'in_progress',
  'needs_review',
  'completed',
  'closed',
  'no_show',
  'expired',
  'cancelled_by_client',
  'cancelled_by_admin',
] as const;
export type BookingStage = (typeof BOOKING_STAGES)[number];

/** What a client may be shown: never `needs_review`. */
export type ClientStage = Exclude<BookingStage, 'needs_review'>;

export type StageAudience = 'client' | 'admin';

export type StagedBooking = { status: string; startsAt: Date; endsAt: Date; deliverySentAt: Date | null };

export function bookingStage(booking: StagedBooking, now: Date, audience: 'client'): ClientStage;
export function bookingStage(booking: StagedBooking, now: Date, audience: 'admin'): BookingStage;
export function bookingStage(booking: StagedBooking, now: Date, audience: StageAudience): BookingStage {
  switch (booking.status) {
    case 'pending_payment':
      return 'awaiting_payment';
    case 'confirmed':
      if (now < booking.startsAt) return 'confirmed';
      if (now < booking.endsAt) return 'in_progress';
      return audience === 'client' ? 'completed' : 'needs_review';
    case 'completed':
      return booking.deliverySentAt === null ? 'completed' : 'closed';
    case 'no_show':
    case 'expired':
    case 'cancelled_by_client':
    case 'cancelled_by_admin':
      return booking.status;
    default:
      // A status the database adds later: shown as it is stored would be a
      // guess, and `confirmed` is the least surprising one to be wrong with.
      return 'confirmed';
  }
}

/** The admin stage as a database filter, on the same clock as the display. */
export function stageWhere(stage: BookingStage, now: Date): Prisma.BookingWhereInput {
  switch (stage) {
    case 'awaiting_payment':
      return { status: 'pending_payment' };
    case 'confirmed':
      return { status: 'confirmed', startsAt: { gt: now } };
    case 'in_progress':
      return { status: 'confirmed', startsAt: { lte: now }, endsAt: { gt: now } };
    case 'needs_review':
      return { status: 'confirmed', endsAt: { lte: now } };
    case 'completed':
      return { status: 'completed', deliverySentAt: null };
    case 'closed':
      return { status: 'completed', deliverySentAt: { not: null } };
    default:
      return { status: stage };
  }
}
