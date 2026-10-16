import type { Prisma } from '@prisma/client';
import { accessTokenExpiry, generateAccessToken } from './access-token.js';

/**
 * Gives a booking a fresh access token and answers its plaintext, which the
 * caller puts in an email and nowhere else (data-model_v2.md §5.9). Only the
 * hash is stored, so the previous link stops working at once: a new token is
 * the only way to hand a link out again.
 *
 * Shared by the photographer's "Resend link" (admin-actions.ts) and the
 * client's own "Email me my links" (link-lookup.ts). Runs inside the caller's
 * transaction, so the new hash and the email carrying its plaintext commit
 * together, or neither does.
 */
export async function issueAccessToken(tx: Prisma.TransactionClient, bookingId: string, now: Date): Promise<string> {
  const { token, hash } = generateAccessToken();
  await tx.booking.update({
    where: { id: bookingId },
    data: { accessTokenHash: hash, accessTokenExpiresAt: accessTokenExpiry(now), accessTokenLastUsedAt: null },
  });
  return token;
}
