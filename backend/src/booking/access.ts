import type { Prisma, PrismaClient } from '@prisma/client';
import { hashAccessToken } from './access-token.js';

/**
 * Reaching a booking by its access token (plan.md Task 18; spec §2.2, §3.9,
 * §6.21): the client's whole identity, and the only way in.
 *
 * The token is looked up by the SHA-256 the booking stores, so the plaintext is
 * never compared against anything and never stored. A token that is unknown,
 * expired, or superseded by a resend answers exactly like the other two --
 * nothing found -- because "wrong token" and "no such booking" must be
 * indistinguishable: a 403 would confirm a booking exists (plan.md Task 18).
 *
 * Scope comes from the token alone. Nothing here takes a booking id, a
 * reference, or an email, so no parameter a caller adds can widen it.
 */

/** What `generateAccessToken` produces: base64url, 43 characters. Bounded so a huge string is never hashed. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{16,256}$/;

/** The booking, its add-ons and its payments: everything the client page and a cancellation need. */
export const FULL_BOOKING = {
  addons: true,
  payments: { orderBy: { initiatedAt: 'asc' } },
  // What the notices are built from (2026-09-25). The payloads are read on the
  // server only, field by field (booking/notices.ts); none reaches the page.
  outbox: { select: { id: true, template: true, status: true, payload: true, createdAt: true } },
  notes: { where: { deletedAt: null }, select: { id: true, body: true, createdAt: true, deletedAt: true } },
} satisfies Prisma.BookingInclude;

export type AccessedBooking = Prisma.BookingGetPayload<{ include: typeof FULL_BOOKING }>;

/**
 * The booking a token addresses, or null when there is none to show. Records the
 * use (`access_token_last_used_at`) on the database clock, and only for a token
 * that was accepted.
 */
export async function findBookingByToken(prisma: PrismaClient, token: string): Promise<AccessedBooking | null> {
  if (!TOKEN_FORMAT.test(token)) return null;

  const used = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE booking
       SET access_token_last_used_at = now()
     WHERE access_token_hash = ${hashAccessToken(token)}
       AND access_token_expires_at > now()
    RETURNING id::text AS id`;
  const id = used[0]?.id;
  if (id === undefined) return null;

  return prisma.booking.findUnique({ where: { id }, include: FULL_BOOKING });
}
