import type { Prisma } from '@prisma/client';

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
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO client (full_name, email, phone)
    VALUES (${contact.fullName}, ${contact.email}, ${contact.phone})
    ON CONFLICT ((lower(email))) DO UPDATE
       SET full_name = EXCLUDED.full_name,
           phone = EXCLUDED.phone,
           updated_at = now()
    RETURNING id::text AS id`;
  const row = rows[0];
  if (row === undefined) throw new Error('The client upsert returned no row.');
  return row.id;
}
