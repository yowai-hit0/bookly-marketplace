import { randomBytes } from 'node:crypto';
import type { AppUser } from '@prisma/client';
import { type AuthDeps, findUserByEmail, spendDummyPasswordCheck, verifyCurrentPassword } from '../auth/account-auth.js';
import { hashPassword } from '../auth/password.js';
import { admitsArea, hasVerifiedEmail } from '../auth/roles.js';
import { type IssuedToken, issueToken, sha256Hex } from '../auth/token.js';
import { linkClientRows } from '../booking/client.js';
import { maskEmail } from '../booking/email-change.js';
import { SQLSTATE, sqlstateOf } from '../db/errors.js';
import { enqueue } from '../outbox/enqueue.js';
import { eraseAccountMail } from '../outbox/erasure.js';

/**
 * What a signed-in client changes about their own login (marketplace-spec.md
 * R8.3; Phase 8 units B5, B6 and B8; user decisions 2026-10-27): the password,
 * the address, and the account itself. Transport-free.
 *
 * **Re-proving who is asking.** A bearer token alone never changes a
 * credential or erases the account. A password account confirms with its
 * password, checked by `verifyCurrentPassword`: the login's own lockout, so a
 * stolen token is no licence to guess (a wrong password counts, the attempt
 * that locks sends the lockout alert). A Google-only account (no password)
 * may add one (decision 2) -- it has no old password to check, and the alert
 * email is how the inbox's owner hears of it -- may NOT change its address
 * (`password_required`: nothing would prove the person at the keyboard is the
 * person at the inbox), and confirms deletion by typing its address.
 *
 * **Tokens.** Changing or adding a password changes `password_hash`, which every
 * token's credential fingerprint covers (auth/token.ts), so every other session
 * stops on its next request; the caller gets a fresh token and carries on.
 * Changing the address leaves the fingerprint alone. Deleting bumps
 * `token_version` as well as clearing both credentials and setting
 * `anonymized_at`, which the middleware refuses outright.
 */

export type SignedIn = { status: 'ok'; user: AppUser } & IssuedToken;

type Owner = Pick<AppUser, 'id' | 'email' | 'passwordHash' | 'emailVerifiedAt' | 'googleSub' | 'tokenVersion'>;

// --- Password (B5) ----------------------------------------------------------------

export type PasswordChangeResult =
  | SignedIn
  /** A Google-only account: add one with `setPassword` (409). */
  | { status: 'no_password' }
  /** Wrong, and counted toward the lockout (403). */
  | { status: 'invalid_password' }
  /** Locked by failed attempts here or at the login (403): nothing was checked. */
  | { status: 'password_locked' }
  /** Someone else changed the credentials between the check and the write (409): nothing changed. */
  | { status: 'credentials_changed' };

/**
 * A password account changes its password: the current one is checked first.
 * A pending reset link dies with the old password, and the lockout is cleared
 * (the right password proves who is asking).
 */
export async function changePassword(deps: AuthDeps, user: Owner, currentPassword: string, newPassword: string): Promise<PasswordChangeResult> {
  if (user.passwordHash === null) return { status: 'no_password' };
  const check = await verifyCurrentPassword(deps, 'account', user, currentPassword);
  if (check === 'invalid_password') return { status: 'invalid_password' };
  if (check === 'locked') return { status: 'password_locked' };
  return writePassword(deps, user, await hashPassword(newPassword), { added: false });
}

export type PasswordSetResult =
  | SignedIn
  /** The account already has a password: change it instead (409). */
  | { status: 'password_exists' };

/**
 * A Google-only account adds its first password (decision 2). Afterwards it
 * signs in either way. There is no old password to check: the session is the
 * proof, the alert to the inbox is the safeguard, and the guard on
 * `password_hash IS NULL` makes a second, racing "add" a `password_exists`.
 */
export async function setPassword(deps: AuthDeps, user: Owner, newPassword: string): Promise<PasswordSetResult> {
  if (user.passwordHash !== null) return { status: 'password_exists' };
  const result = await writePassword(deps, user, await hashPassword(newPassword), { added: true });
  return result.status === 'credentials_changed' ? { status: 'password_exists' } : result;
}

async function writePassword(deps: AuthDeps, user: Owner, passwordHash: string, { added }: { added: boolean }): Promise<SignedIn | { status: 'credentials_changed' }> {
  const now = deps.now();
  const saved = await deps.prisma.$transaction(async (tx) => {
    // Guarded on the credentials that were checked: a change, a reset or an
    // erasure committed meanwhile wins, and this writes nothing.
    const { count } = await tx.appUser.updateMany({
      where: { id: user.id, passwordHash: user.passwordHash, tokenVersion: user.tokenVersion, anonymizedAt: null, disabledAt: null },
      data: { passwordHash, passwordResetTokenHash: null, passwordResetExpiresAt: null, failedLoginCount: 0, lockedUntil: null },
    });
    if (count !== 1) return null;
    // Account mail: to the login, with no photographer_id. One per change: the
    // key names the new hash, which Argon2's salt makes unique.
    await enqueue(tx, {
      kind: 'email',
      template: 'account_security_alert',
      recipient: user.email,
      dedupeKey: `email:account_security_alert:password_changed:${user.id}:${sha256Hex(passwordHash).slice(0, 32)}`,
      payload: { variant: 'password_changed', area: 'account', added, changedAt: now.toISOString() },
    });
    return tx.appUser.findUniqueOrThrow({ where: { id: user.id } });
  });
  if (saved === null) return { status: 'credentials_changed' };
  return { status: 'ok', user: saved, ...(await issueToken(deps.sessionSecret, 'account', saved, now)) };
}

// --- The address (B6) ----------------------------------------------------------------

/** As long as a signup's verification link (Phase 2 decision 3). */
export const ACCOUNT_EMAIL_CHANGE_TTL_HOURS = 24;

export type EmailChangeRequestResult =
  /** Asked: the answer is the same whether or not the new address already has an account. */
  | { status: 'requested' }
  /** A Google-only account cannot change its address (decision 2; 409). */
  | { status: 'password_required' }
  /** It is the account's address already (422). */
  | { status: 'same_email' }
  | { status: 'invalid_password' }
  | { status: 'password_locked' };

/**
 * Asks to move the account to `typedEmail`, confirmed with the password.
 *
 * Stores the new address as pending with the SHA-256 of a fresh 256-bit token
 * (24 hours; a new request replaces an earlier one, whose link stops working)
 * and emails the link to the NEW address: receiving it is the proof the inbox
 * is theirs. Nothing about the login changes yet.
 *
 * **No enumeration** (marketplace-spec.md R2.5, R2.1c). An address that already
 * belongs to any account is answered, stored and shown as pending exactly like
 * a free one -- the only difference is that no link is sent to it, so the
 * change can never complete. The caller cannot tell the two apart from the
 * answer, from `/me`, or from timing beyond the email the worker sends later.
 */
export async function requestAccountEmailChange(deps: AuthDeps, user: Owner, typedEmail: string, password: string): Promise<EmailChangeRequestResult> {
  if (user.passwordHash === null) return { status: 'password_required' };
  const email = typedEmail.trim().toLowerCase();
  if (email === user.email.toLowerCase()) return { status: 'same_email' };

  const check = await verifyCurrentPassword(deps, 'account', user, password);
  if (check === 'invalid_password') return { status: 'invalid_password' };
  if (check === 'locked') return { status: 'password_locked' };

  const now = deps.now();
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(now.getTime() + ACCOUNT_EMAIL_CHANGE_TTL_HOURS * 60 * 60_000);

  await deps.prisma.$transaction(async (tx) => {
    const taken = (await findUserByEmail(tx, email)) !== null;
    const { count } = await tx.appUser.updateMany({
      where: { id: user.id, anonymizedAt: null },
      data: { pendingEmail: email, pendingEmailTokenHash: tokenHash, pendingEmailExpiresAt: expiresAt },
    });
    if (count !== 1 || taken) return;
    // The plaintext lives only in this payload until the worker delivers it; the row keeps its hash.
    await enqueue(tx, {
      kind: 'email',
      template: 'account_verify_email',
      recipient: email,
      dedupeKey: `email:account_verify_email:email_change:${user.id}:${tokenHash}`,
      payload: { variant: 'email_change', area: 'account', token, expiresAt: expiresAt.toISOString() },
    });
  });
  return { status: 'requested' };
}

export type EmailChangeConfirmResult =
  | SignedIn
  /** One answer for an unknown, lapsed, replaced or used token, a wrong password and a locked account (400). */
  | { status: 'invalid' }
  /** The address was taken by another account since the request (409). The pending change is withdrawn. */
  | { status: 'email_taken' };

/**
 * Confirms an address change from the link the new inbox received: the token
 * AND the account's password, as a signup's verification is confirmed
 * (R2.1c (a)) -- the token proves the inbox, the password the person. A POST
 * from the page the link opens, never the GET of opening it, so a mail scanner
 * changes nothing. Unauthenticated: the link opens in a tab without the
 * session, and the two proofs are more than a login asks.
 *
 * On success, in one transaction: the address is re-checked free (`email_taken`
 * if an account took it since -- the request could not say, see above), the
 * login's email becomes the new address with `email_verified_at` now, the
 * pending change and any reset link (emailed to the OLD inbox) are void, the
 * unclaimed bookings under the new address are linked (decision 3; the ones
 * already linked stay linked), and the OLD address is told, with the new one
 * masked. The caller is signed in.
 *
 * Google sign-in keeps working: it finds the account by its Google subject
 * first, whatever the address (auth/google.ts).
 */
export async function confirmAccountEmailChange(deps: AuthDeps, token: string, password: string): Promise<EmailChangeConfirmResult> {
  const now = deps.now();
  const tokenHash = sha256Hex(token);
  const liveToken = { pendingEmailTokenHash: tokenHash, pendingEmailExpiresAt: { gt: now }, role: 'client' };

  const holder = await deps.prisma.appUser.findFirst({ where: liveToken });
  if (holder === null || holder.passwordHash === null || holder.pendingEmail === null || !admitsArea('account', holder) || !hasVerifiedEmail(holder)) {
    await spendDummyPasswordCheck(password);
    return { status: 'invalid' };
  }
  const check = await verifyCurrentPassword(deps, 'account', holder, password);
  if (check === 'locked') {
    // The same cost as a refusal, so the answer's timing says nothing more.
    await spendDummyPasswordCheck(password);
    return { status: 'invalid' };
  }
  if (check === 'invalid_password') return { status: 'invalid' };

  const oldEmail = holder.email;
  const newEmail = holder.pendingEmail;
  let changed: AppUser | 'invalid' | 'email_taken';
  try {
    changed = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM app_user WHERE id = ${holder.id}::uuid FOR UPDATE`;
      // Still the same link and the password that was checked: a newer request,
      // a password change or an erasure committed meanwhile voids this one.
      const current = await tx.appUser.findFirst({ where: { id: holder.id, ...liveToken, passwordHash: holder.passwordHash, anonymizedAt: null, disabledAt: null } });
      if (current === null || current.pendingEmail !== newEmail) return 'invalid' as const;

      const other = await findUserByEmail(tx, newEmail);
      if (other !== null && other.id !== holder.id) {
        await tx.appUser.update({ where: { id: holder.id }, data: { pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null } });
        return 'email_taken' as const;
      }

      const user = await tx.appUser.update({
        where: { id: holder.id },
        data: {
          email: newEmail,
          emailVerifiedAt: now,
          pendingEmail: null,
          pendingEmailTokenHash: null,
          pendingEmailExpiresAt: null,
          // A verification link is moot, and a reset link went to the old inbox.
          emailVerifyTokenHash: null,
          emailVerifyExpiresAt: null,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: now,
        },
      });
      await linkClientRows(tx, holder.id, newEmail);
      await enqueue(tx, {
        kind: 'email',
        template: 'account_security_alert',
        // The old address: the last it hears of this account.
        recipient: oldEmail,
        dedupeKey: `email:account_security_alert:email_changed:${holder.id}:${tokenHash}`,
        payload: { variant: 'email_changed', area: 'account', changedAt: now.toISOString(), newEmail: maskEmail(newEmail) },
      });
      return user;
    });
  } catch (error) {
    // A signup for the address committing between the re-check and the write:
    // the unique index decides, and the transaction rolled back whole.
    if (sqlstateOf(error) === SQLSTATE.UNIQUE_VIOLATION) return { status: 'email_taken' };
    throw error;
  }
  if (changed === 'invalid' || changed === 'email_taken') return { status: changed };
  return { status: 'ok', user: changed, ...(await issueToken(deps.sessionSecret, 'account', changed, now)) };
}

// --- Deletion (B8) -------------------------------------------------------------------

export type DeleteConfirmation = { password?: string | undefined; confirmEmail?: string | undefined };

export type DeleteResult =
  | { status: 'deleted'; unlinkedClients: number; erasedMail: number }
  /** A password account: the password was missing or wrong (403, counted). */
  | { status: 'invalid_password' }
  | { status: 'password_locked' }
  /** A Google-only account: the typed address was missing or not the account's (403). */
  | { status: 'invalid_confirmation' };

/** The address an erased login keeps: unique, and on a domain that can never receive mail (RFC 2606). */
export function deletedEmailOf(userId: string): string {
  return `deleted-${userId}@deleted.invalid`;
}

/**
 * Deletes the account (R8.3, T8.3; decision 4): ANONYMISES the `app_user` and
 * unlinks its client rows, in one transaction. The row stays, because the
 * records the law keeps (Rwanda law 058/2021) point at what it points at; the
 * bookings and their contact snapshots stay for the photographers' records,
 * and so do the `client` rows, now linked to no account. Upcoming bookings
 * carry on through the guest links already emailed to their contact address.
 *
 * What goes: the address (a dead, unique one instead), the name, the phone,
 * both credentials, every token hash and pending change, the lockout state,
 * the verification and the last sign-in. `anonymized_at` is set, which every
 * area refuses (`admitsArea`), and `token_version` moves, which fails every
 * token's fingerprint even without it. `disabled_at` is NOT set: it is a
 * platform admin's switch, reversible and theirs; erasure is neither.
 *
 * A later Google sign-in with the same Google account finds no subject and no
 * address, and creates a fresh account -- which, the inbox being proven again,
 * links the unclaimed bookings under that address again, as any new account
 * would (marketplace-data-model.md §2.8). So does a later signup with the
 * address, once verified (user decision 2026-10-27).
 *
 * **The outbox** (user decisions 2026-10-27, deletion follow-up), in the same
 * transaction, before the address is erased from the login:
 * - every ACCOUNT-MAIL row of the user is erased (`eraseAccountMail`: recipient
 *   `'[erased]'`, payload null, an undelivered one cancelled), as the client
 *   erasure of data-model_v2.md §10.2 erases a client's rows. Booking mail is
 *   left alone: it is each photographer's record of what their client was told,
 *   and the bookings stay.
 * - then ONE notice goes to the address being erased (`account_security_alert`,
 *   variant `account_deleted`), marked `erase_on_completion`: the row keeps the
 *   address only until the worker delivers it or gives up on it, and erases its
 *   own recipient and payload in that same statement (outbox/worker.ts).
 */
export type DeleteDeps = AuthDeps & {
  /** The structured log line (R9.4's "who and when"); injectable for tests. */
  log?: (entry: Record<string, unknown>) => void;
};

export async function deleteAccount(deps: DeleteDeps, user: Owner, confirmation: DeleteConfirmation): Promise<DeleteResult> {
  if (user.passwordHash !== null) {
    if (confirmation.password === undefined) return { status: 'invalid_password' };
    const check = await verifyCurrentPassword(deps, 'account', user, confirmation.password);
    if (check === 'invalid_password') return { status: 'invalid_password' };
    if (check === 'locked') return { status: 'password_locked' };
  } else if (confirmation.confirmEmail === undefined || confirmation.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    return { status: 'invalid_confirmation' };
  }

  const now = deps.now();
  const result = await deps.prisma.$transaction(async (tx) => {
    // Locked, so a racing deletion (or an address change) waits and then finds the row erased.
    const rows = await tx.$queryRaw<{ email: string; pending_email: string | null }[]>`
      SELECT email, pending_email FROM app_user WHERE id = ${user.id}::uuid AND anonymized_at IS NULL FOR UPDATE`;
    const current = rows[0];
    if (current === undefined) return null;

    const erasedMail = await eraseAccountMail(tx, { id: user.id, addresses: current.pending_email === null ? [current.email] : [current.email, current.pending_email] });
    await enqueue(tx, {
      kind: 'email',
      template: 'account_security_alert',
      recipient: current.email,
      dedupeKey: `email:account_security_alert:account_deleted:${user.id}`,
      payload: { variant: 'account_deleted', area: 'account', deletedAt: now.toISOString() },
      eraseOnCompletion: true,
    });

    const { count } = await tx.appUser.updateMany({
      where: { id: user.id, anonymizedAt: null },
      data: {
        email: deletedEmailOf(user.id),
        fullName: null,
        phone: null,
        passwordHash: null,
        googleSub: null,
        emailVerifiedAt: null,
        emailVerifyTokenHash: null,
        emailVerifyExpiresAt: null,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        pendingEmail: null,
        pendingEmailTokenHash: null,
        pendingEmailExpiresAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: null,
        anonymizedAt: now,
        tokenVersion: { increment: 1 },
      },
    });
    if (count !== 1) throw new Error(`app_user ${user.id} was locked unerased, then not updated`);
    const unlinked = await tx.client.updateMany({ where: { userId: user.id }, data: { userId: null } });
    return { unlinkedClients: unlinked.count, erasedMail };
  });
  // Already erased by a racing request: this one has nothing left to do, and the caller's token is dead either way.
  const { unlinkedClients, erasedMail } = result ?? { unlinkedClients: 0, erasedMail: 0 };
  // Who and when, never what: the old address is exactly what was erased.
  (deps.log ?? logLine)({ level: 'info', event: 'account_deleted', userId: user.id, at: now.toISOString(), unlinkedClients, erasedMail });
  return { status: 'deleted', unlinkedClients, erasedMail };
}

function logLine(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}
