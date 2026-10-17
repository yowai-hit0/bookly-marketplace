import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The client a booking belongs to (data-model_v2.md §5.8): one row per email,
 * matched case-insensitively, holding the latest known name and phone. It is a
 * dedupe and linking record, not an account -- it grants nothing.
 *
 * One statement, because the uniqueness is `lower(email)`, a functional index
 * Prisma's upsert cannot target. `ON CONFLICT` makes it atomic: two first
 * bookings from one new address at once both land on the same row, and neither
 * raises the 23505 that would abort the claim transaction around it.
 *
 * A booking snapshots its own contact details, so refreshing the name or phone
 * here never rewrites an earlier booking (fix #9).
 */

export type ClientContact = {
  fullName: string;
  /** Already trimmed and lowercased. */
  email: string;
  phone: string;
};

export async function upsertClient(tx: Prisma.TransactionClient, contact: ClientContact): Promise<string> {
  // The account a new booking links to (marketplace-spec.md R2.3, R8.4;
  // marketplace-data-model.md §2.8): a client login with this address, and only
  // once that address is VERIFIED. An unverified signup proves nothing about
  // who owns the inbox, so linking it would show a stranger the bookings of
  // whoever really owns the address (T2.2). On conflict the row keeps the
  // account it already has: COALESCE never moves a client row to another user.
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO client (full_name, email, phone, user_id)
    VALUES (
      ${contact.fullName}, ${contact.email}, ${contact.phone},
      (SELECT id FROM app_user
        WHERE lower(email) = lower(${contact.email})
          AND role = 'client'
          AND email_verified_at IS NOT NULL
          AND anonymized_at IS NULL
        LIMIT 1)
    )
    ON CONFLICT ((lower(email))) DO UPDATE
       SET full_name = EXCLUDED.full_name,
           phone = EXCLUDED.phone,
           user_id = COALESCE(client.user_id, EXCLUDED.user_id),
           updated_at = now()
    RETURNING id::text AS id`;
  const row = rows[0];
  if (row === undefined) throw new Error('The client upsert returned no row.');
  return row.id;
}

/**
 * Links every unclaimed client row with `email` to the client account `userId`
 * (marketplace-data-model.md §2.8): the bookings made under the address become
 * the account's. Run ONLY once the address is proven -- on email verification,
 * on a password reset that verifies, and on Google sign-in -- never at signup.
 *
 * Exact, case-insensitive equality on the functional index, never a pattern.
 * A row already linked keeps its account, and an erased row is left alone.
 * Returns how many rows it linked. Works on the root client or in a transaction.
 */
export async function linkClientRows(db: PrismaClient | Prisma.TransactionClient, userId: string, email: string): Promise<number> {
  return db.$executeRaw`
    UPDATE client
       SET user_id = ${userId}::uuid,
           updated_at = now()
     WHERE lower(email) = lower(${email})
       AND user_id IS NULL
       AND anonymized_at IS NULL`;
}
