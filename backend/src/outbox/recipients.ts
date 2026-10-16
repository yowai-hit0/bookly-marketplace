import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Who an alert goes to (marketplace-spec.md R1.7, brief decision 6). Before the
 * marketplace every alert went to the oldest admin account, who was the
 * photographer. Now:
 *
 * - an alert about a booking goes to that booking's photographer, at their
 *   login's email (`app_user.email`);
 * - an alert that concerns no photographer goes to every platform admin.
 *
 * Never "the first user": with many photographers that would hand one studio's
 * client names and payments to another.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** A photographer alert's address, and the studio the outbox row is filed under. */
export type PhotographerRecipient = { recipient: string; photographerId: string };

/**
 * The booking's photographer. A booking always has one, and a photographer
 * always has a login (both NOT NULL), so this throws only for a booking that
 * does not exist -- which every caller has just read.
 */
export async function bookingPhotographerRecipient(db: Db, bookingId: string): Promise<PhotographerRecipient> {
  const booking = await db.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: { photographerId: true, photographer: { select: { user: { select: { email: true } } } } },
  });
  return { recipient: booking.photographer.user.email, photographerId: booking.photographerId };
}

/** The photographer's login email, or null when no such photographer exists. */
export async function photographerRecipient(db: Db, photographerId: string): Promise<PhotographerRecipient | null> {
  const photographer = await db.photographer.findUnique({
    where: { id: photographerId },
    select: { user: { select: { email: true } } },
  });
  return photographer === null ? null : { recipient: photographer.user.email, photographerId };
}

/**
 * Every platform admin whose login is on, oldest first. Each gets their own
 * outbox row, keyed by their user id, so one bad address does not hold up the
 * others.
 */
export async function platformAdminRecipients(db: Db): Promise<{ userId: string; recipient: string }[]> {
  const admins = await db.appUser.findMany({
    where: { role: 'platform_admin', disabledAt: null, anonymizedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, email: true },
  });
  return admins.map((admin) => ({ userId: admin.id, recipient: admin.email }));
}
