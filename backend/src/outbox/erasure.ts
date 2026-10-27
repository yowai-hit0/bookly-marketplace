import { Prisma } from '@prisma/client';

/**
 * Erasing personal data from the outbox (data-model_v2.md §10.2; marketplace-spec.md
 * Phase 8 as built, user decision 2026-10-27).
 *
 * The outbox is permanent -- its rows are the history of what was sent -- so
 * erasure never deletes one. It overwrites the two columns that hold personal
 * data, the recipient's address and the payload (names, links, tokens), as the
 * older client-erasure rule does: `recipient` becomes `'[erased]'`, `payload`
 * null. The template, the dedupe key, the status and the timestamps stay, so
 * what was sent and when is still on record.
 */

/** What an erased row's recipient reads (data-model_v2.md §10.2). */
export const ERASED_RECIPIENT = '[erased]';

/**
 * ACCOUNT MAIL: the templates that concern a person's login rather than a
 * booking or a studio. Each is sent to the login's own address (or, for an
 * address change, the address it is moving to), with no booking and no
 * photographer, and its dedupe key names the user's id:
 *
 *   account_verify_email     the signup's verification link, and an address
 *                            change's confirmation link (`email_change`)
 *   account_password_reset   the reset link
 *   account_security_alert   lockout, "you already have an account", password
 *                            changed or added, address changed (to the old
 *                            address), and the deletion notice
 *
 * Booking mail is NOT account mail, even when the account's owner received it:
 * it is filed under its booking and its photographer, it is the photographer's
 * record of what their client was told (the confirmation, the cancellation,
 * the receipts, a contact-email change), and deleting an account keeps every
 * booking and its snapshots (R8.3). The client erasure of data-model_v2.md
 * §10.2 is a separate act.
 */
export const ACCOUNT_MAIL_TEMPLATES = ['account_verify_email', 'account_password_reset', 'account_security_alert'] as const;

type Db = Prisma.TransactionClient;

/**
 * Erases every account-mail row of `user` (Phase 8 decision 1), in the
 * caller's transaction (the account deletion's): the rows addressed to any of
 * `addresses` (the current address and a pending one), and the rows whose
 * dedupe key names the user -- which also catches mail sent to an address the
 * account has since moved away from. A row not yet delivered is cancelled as
 * well: its link is dead with the account, and the worker would otherwise
 * try to deliver a payload that is gone.
 *
 * Returns how many rows it erased.
 */
export async function eraseAccountMail(db: Db, user: { id: string; addresses: string[] }): Promise<number> {
  const addresses = user.addresses.map((address) => address.toLowerCase());
  return db.$executeRaw`
    UPDATE outbox
       SET recipient = ${ERASED_RECIPIENT},
           payload = NULL,
           status = CASE WHEN status IN ('pending', 'processing') THEN 'cancelled' ELSE status END
     WHERE kind = 'email'
       AND template IN (${Prisma.join([...ACCOUNT_MAIL_TEMPLATES])})
       AND booking_id IS NULL
       AND photographer_id IS NULL
       AND (lower(recipient) = ANY(${addresses}::text[])
            OR strpos(dedupe_key, ${`:${user.id}:`}) > 0
            OR right(dedupe_key, ${user.id.length + 1}) = ${`:${user.id}`})`;
}

/**
 * The SET clause a terminal state adds for a row marked `erase_on_completion`:
 * the row erases itself as the worker finishes with it, delivered or given up
 * on -- never on a retry, which needs both.
 */
export const ERASE_IF_MARKED = Prisma.sql`
  recipient = CASE WHEN erase_on_completion THEN ${ERASED_RECIPIENT} ELSE recipient END,
  payload = CASE WHEN erase_on_completion THEN NULL ELSE payload END`;
