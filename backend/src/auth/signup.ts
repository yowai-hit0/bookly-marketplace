import type { Prisma } from '@prisma/client';
import { SQLSTATE, sqlstateOf } from '../db/errors.js';
import { enqueue } from '../outbox/enqueue.js';
import { platformAdminRecipients } from '../outbox/recipients.js';
import { isReservedHandle } from '../photographers/handle.js';
import { type AuthDeps, findUserByEmail } from './account-auth.js';
import { issueVerification } from './email-verification.js';
import { hashPassword } from './password.js';
import { AREA_ROLE, type AuthArea, admitsArea, areaOfRole, isUserRole } from './roles.js';

/**
 * Signing up: a photographer in the studio (Phase 2 decision 4;
 * marketplace-spec.md R2.2) and a client in the account area (decision 5,
 * R2.3). Transport-free, like `account-auth.ts`.
 *
 * **Enumeration-safe** (R2.5, T2.4). Whether or not the address already has an
 * account, of any role, the caller gets the same answer; what differs is only
 * what the address's inbox receives:
 *
 * - a new address: the account, and its verification link;
 * - an address whose account in THIS area is still unverified: a fresh
 *   verification link, and nothing else -- the stored password is NOT replaced
 *   (R2.1c (c)). Replacing it would let anyone reset an unverified account's
 *   password by "signing up" again; keeping it means the link still needs the
 *   first signup's password, and the owner who never chose it uses "Forgot
 *   password" instead;
 * - an address with a verified account, of any area: an "you already have an
 *   account" notice pointing at that account's own sign-in page, at most one
 *   an hour (`account_security_alert`, variant `account_exists`);
 * - anything else (an unverified account of another area, a disabled or erased
 *   login): nothing.
 *
 * Argon2 is spent on the password in every case, before the address is looked
 * at, so the time taken does not tell the cases apart either.
 *
 * A photographer's **handle** is the one thing a signup does disclose: a taken
 * or reserved handle is `handle_taken`, decided before the email is considered
 * and whatever the email is. Handles are public (`/p/<handle>`), so this
 * reveals nothing an address could be matched to.
 */

export type PhotographerSignupInput = { email: string; password: string; displayName: string; handle: string };
export type PhotographerSignupResult = 'accepted' | 'handle_taken';

export async function signUpPhotographer(deps: AuthDeps, input: PhotographerSignupInput): Promise<PhotographerSignupResult> {
  const passwordHash = await hashPassword(input.password);
  const handle = input.handle.toLowerCase();
  if (isReservedHandle(handle)) return 'handle_taken';
  if ((await deps.prisma.photographer.findUnique({ where: { handle }, select: { id: true } })) !== null) return 'handle_taken';

  try {
    await createOrNotify(deps, 'studio', { email: input.email, passwordHash, fullName: null }, async (tx, user) => {
      // One transaction: the login, the photographer (pending until a platform
      // admin approves it) and its settings at the schema defaults
      // (marketplace-data-model.md §3.1: photographer.user_id is a photographer
      // login, which this transaction is what guarantees).
      const photographer = await tx.photographer.create({
        data: { userId: user.id, handle, displayName: input.displayName, status: 'pending', setting: { create: {} } },
        select: { id: true },
      });
      // Every platform admin hears of the application. The row names no
      // photographer: a failure to deliver it must alert the platform, not
      // the applicant (outbox/worker.ts).
      for (const admin of await platformAdminRecipients(tx)) {
        await enqueue(tx, {
          kind: 'email',
          template: 'photographer_application_received',
          recipient: admin.recipient,
          dedupeKey: `email:photographer_application_received:${photographer.id}:${admin.userId}`,
          payload: { displayName: input.displayName, handle, email: user.email },
        });
      }
    });
  } catch (error) {
    // Two signups racing for one handle: the second's photographer insert hits
    // the unique index, its whole transaction rolls back, and it is told the
    // handle is taken -- which by now it is. The app_user insert cannot raise
    // one (it is ON CONFLICT DO NOTHING), so a unique violation is the handle.
    if (sqlstateOf(error) === SQLSTATE.UNIQUE_VIOLATION) return 'handle_taken';
    throw error;
  }
  return 'accepted';
}

export type ClientSignupInput = { email: string; password: string; fullName: string };

/** Always `accepted`: a client signup has nothing it may refuse after validation. */
export async function signUpClient(deps: AuthDeps, input: ClientSignupInput): Promise<'accepted'> {
  const passwordHash = await hashPassword(input.password);
  // No client rows are linked here: linking waits for the address to be
  // verified (marketplace-data-model.md §2.8, T2.2).
  await createOrNotify(deps, 'account', { email: input.email, passwordHash, fullName: input.fullName }, async () => {});
  return 'accepted';
}

type NewLogin = { email: string; passwordHash: string; fullName: string | null };

/**
 * Inserts the login of `area`'s role and runs `create` in the same transaction,
 * then sends the verification link -- or, when the address is taken, does what
 * the module note says instead.
 *
 * The insert is `ON CONFLICT ((lower(email))) DO NOTHING` on the functional
 * unique index: two signups racing for one address cannot both create it, and
 * neither raises the 23505 that would abort the transaction. The address is
 * stored trimmed and lowercased, as booking emails are.
 */
async function createOrNotify(
  deps: AuthDeps,
  area: AuthArea,
  login: NewLogin,
  create: (tx: Prisma.TransactionClient, user: { id: string; email: string }) => Promise<void>,
): Promise<void> {
  const email = login.email.trim().toLowerCase();

  const created = await deps.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO app_user (email, role, full_name, password_hash)
      VALUES (${email}, ${AREA_ROLE[area]}, ${login.fullName}, ${login.passwordHash})
      ON CONFLICT ((lower(email))) DO NOTHING
      RETURNING id::text AS id`;
    const id = rows[0]?.id;
    if (id === undefined) return false;
    const user = { id, email };
    await create(tx, user);
    await issueVerification(tx, deps, area, user);
    return true;
  });

  if (!created) await notifyExistingAccount(deps, area, email);
}

/** The address already has an account: tell its inbox, never the caller (module note). */
async function notifyExistingAccount(deps: AuthDeps, area: AuthArea, email: string): Promise<void> {
  const user = await findUserByEmail(deps.prisma, email);
  if (user === null || user.disabledAt !== null || user.anonymizedAt !== null || !isUserRole(user.role)) return;
  const ownArea = areaOfRole(user.role);

  if (user.emailVerifiedAt === null) {
    // R2.1c (c): the same area's unverified account gets its link again. Its
    // password is untouched; the new link replaces the old one.
    if (ownArea === area && admitsArea(area, user)) {
      await deps.prisma.$transaction((tx) => issueVerification(tx, deps, area, user));
    }
    return;
  }

  // At most one notice an hour per account: the hour is in the dedupe key, so a
  // burst of signups with one address sends one email, not a burst.
  const hour = deps.now().toISOString().slice(0, 13);
  await enqueue(deps.prisma, {
    kind: 'email',
    template: 'account_security_alert',
    recipient: user.email,
    dedupeKey: `email:account_security_alert:account_exists:${user.id}:${hour}`,
    payload: { variant: 'account_exists', area: ownArea },
  });
}
