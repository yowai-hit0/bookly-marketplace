import type { PrismaClient } from '@prisma/client';

/**
 * A client's own details (marketplace-spec.md R8.3; Phase 8 unit B4, decision
 * 1): the name they go by and their phone. The phone prefills the booking
 * form; a booking keeps the contact details it was made with, so editing these
 * never rewrites one (the snapshots are `booking.contact_*`, and the shared
 * `client` row is refreshed only by the next booking, as it always was).
 *
 * The route validates; this writes what was sent and nothing else.
 */

export type AccountProfile = { fullName: string | null; phone: string | null };

export type AccountProfileUpdate = { fullName?: string; phone?: string | null };

export async function accountProfile(prisma: PrismaClient, userId: string): Promise<AccountProfile> {
  return prisma.appUser.findUniqueOrThrow({ where: { id: userId }, select: { fullName: true, phone: true } });
}

export async function updateAccountProfile(prisma: PrismaClient, userId: string, update: AccountProfileUpdate): Promise<AccountProfile> {
  // An absent key is undefined, which Prisma leaves alone: only what was sent changes.
  return prisma.appUser.update({ where: { id: userId }, data: update, select: { fullName: true, phone: true } });
}
