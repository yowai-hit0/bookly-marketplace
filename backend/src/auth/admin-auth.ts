import { randomBytes } from 'node:crypto';
import type { AppUser, PrismaClient } from '@prisma/client';
import { enqueue } from '../outbox/enqueue.js';
import { hashPassword, verifyPassword } from './password.js';
import { canUseStudio } from './roles.js';
import { type IssuedToken, issueAdminToken, sha256Hex } from './token.js';

/**
 * Studio login, lockout and password reset (plan.md Task 7, spec §6.23, A-11),
 * per `app_user` (marketplace-spec.md R2.5). Transport-free: the router maps
 * these results onto HTTP.
 *
 * Phase 1 serves only photographers, on the existing `/api/admin/*` paths
 * (brief decision 3). Any other login -- a platform admin, a client, a disabled
 * or erased account -- is treated exactly like an unknown email: the same
 * result, the same Argon2 cost, no attempt counted and no email sent. Phase 2
 * adds the platform and client logins beside this one.
 */

export type AuthDeps = {
  prisma: PrismaClient;
  sessionSecret: string;
  /** The studio UI's origin. Reset links point here, never at the API host. */
  webOrigin: string;
  /** Injected so lockout and expiry are testable without waiting. */
  now: () => Date;
};

/** Every Nth consecutive failure locks the account. */
export const LOCKOUT_THRESHOLD = 5;

/**
 * Minutes locked for the 1st, 2nd and 3rd+ lock. The spec says "a rising
 * interval" without values; these are the plan's developer defaults.
 */
export const LOCKOUT_MINUTES = [1, 5, 15] as const;

/** Developer default: the spec says "time-limited" without a value. */
export const PASSWORD_RESET_TTL_MINUTES = 30;

export type LoginResult =
  | ({ status: 'ok'; user: AppUser; photographerId: string } & IssuedToken)
  /** Deliberately one result for unknown email, wrong password, a locked
   *  account AND a login that is not a photographer's: none of them is
   *  disclosed to the caller. The lockout email is how the account holder
   *  learns they are locked out. */
  | { status: 'invalid_credentials' };

export async function attemptLogin(
  deps: AuthDeps,
  email: string,
  password: string,
): Promise<LoginResult> {
  const now = deps.now();
  const login = await findStudioLogin(deps.prisma, email);

  // Claim the attempt BEFORE spending Argon2 on it. The claim is one atomic
  // UPDATE that refuses a locked account and, when this attempt is the Nth, sets
  // the lock in the same statement. Checking "is it locked?" in one query and
  // recording the failure in another let a burst of concurrent guesses all read
  // "unlocked" and all be verified -- 10 at once got 8 checked, not 5.
  const attemptNumber = login === null ? null : await claimLoginAttempt(deps, login.id, now);

  if (login === null || attemptNumber === null) {
    // Spend the same Argon2 cost as a real check, so response time does not
    // reveal whether the email exists, belongs to another kind of account, or
    // is locked. A refused attempt is not counted: it proves nothing new.
    await verifyPassword(await dummyHash(), password);
    return { status: 'invalid_credentials' };
  }

  if (!(await verifyPassword(login.passwordHash, password))) {
    await alertIfLocked(deps, login, attemptNumber, now);
    return { status: 'invalid_credentials' };
  }

  // Success also clears a lock this very attempt may have set pessimistically:
  // the right password proves who is asking.
  const signedIn = await deps.prisma.appUser.update({
    where: { id: login.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
  });

  const issued = await issueAdminToken(deps.sessionSecret, signedIn, now);
  return { status: 'ok', user: signedIn, photographerId: login.photographerId, ...issued };
}

/** Minutes to lock for this failure count, or null if it does not lock. */
export function lockoutMinutesFor(failedLoginCount: number): number | null {
  if (failedLoginCount <= 0 || failedLoginCount % LOCKOUT_THRESHOLD !== 0) return null;
  const lockNumber = failedLoginCount / LOCKOUT_THRESHOLD;
  return LOCKOUT_MINUTES[Math.min(lockNumber, LOCKOUT_MINUTES.length) - 1] ?? null;
}

/**
 * Always resolves, whether or not the email has a studio login: the response
 * must not confirm which addresses do. A second request replaces that user's
 * first token, so only the newest link works. The token lives on the user's
 * own row, and its hash is unique across users
 * (`app_user_password_reset_token_hash_unique`).
 */
export async function requestPasswordReset(deps: AuthDeps, email: string): Promise<void> {
  const login = await findStudioLogin(deps.prisma, email);
  if (login === null) return;

  // 256 bits. High entropy is what makes a fast hash acceptable for storage.
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(deps.now().getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000);

  await deps.prisma.$transaction(async (tx) => {
    await tx.appUser.update({
      where: { id: login.id },
      data: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: expiresAt },
    });
    // `account_password_reset` (marketplace-data-model.md §2.14), the account
    // email every role will share (R2.5). The plaintext token lives only in this
    // payload until the worker (Task 14) delivers it -- never in an app_user
    // column. Account mail concerns a person rather than a studio, so the row
    // carries no photographer_id.
    await enqueue(tx, {
      kind: 'email',
      template: 'account_password_reset',
      recipient: login.email,
      dedupeKey: `email:account_password_reset:${login.id}:${tokenHash}`,
      payload: {
        // A fragment, not a query string: it never reaches a server log, a
        // proxy, or a Referer header on the static host.
        resetUrl: `${deps.webOrigin}/admin/reset-password#token=${token}`,
        expiresAt: expiresAt.toISOString(),
      },
    });
  });
}

export type PasswordResetResult = 'ok' | 'invalid_or_expired_token';

/**
 * Consumes a reset token and sets the new password. Single-use is enforced by
 * the database, not by a read-then-write: the UPDATE's own WHERE clause requires
 * the token hash, and the same statement clears it, so two concurrent uses of
 * one token cannot both succeed.
 *
 * The token alone names the user: its hash is unique across `app_user`.
 *
 * Changing `password_hash` invalidates every token already issued to that user,
 * because each carries a fingerprint of the old hash. It also clears any lockout: the
 * person holding the emailed token has proved control of the account's mailbox.
 */
export async function confirmPasswordReset(
  deps: AuthDeps,
  token: string,
  newPassword: string,
): Promise<PasswordResetResult> {
  const now = deps.now();
  const tokenHash = sha256Hex(token);
  const liveToken = { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: { gt: now } };

  // Checked first only to avoid spending Argon2 on a garbage token.
  const holder = await deps.prisma.appUser.findFirst({ where: liveToken, select: { id: true } });
  if (holder === null) return 'invalid_or_expired_token';

  const passwordHash = await hashPassword(newPassword);

  const { count } = await deps.prisma.appUser.updateMany({
    where: { id: holder.id, ...liveToken },
    data: {
      passwordHash,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  return count === 1 ? 'ok' : 'invalid_or_expired_token';
}

/**
 * Counts this attempt and, if it is the Nth, locks the account -- in ONE
 * statement. Returns the attempt number, or null if the account is locked.
 *
 * PostgreSQL serialises concurrent UPDATEs of one row and re-checks the WHERE
 * clause against the row the earlier one committed. So once the 5th attempt of
 * a burst sets `locked_until`, the 6th re-evaluates `locked_until <= now`, finds
 * it false, and matches nothing. At most LOCKOUT_THRESHOLD guesses are ever
 * verified per lock window, however many arrive at once.
 *
 * The lock is set pessimistically, before the password is checked. If that Nth
 * attempt turns out to be right, the success path clears it.
 */
async function claimLoginAttempt(
  deps: AuthDeps,
  userId: string,
  now: Date,
): Promise<number | null> {
  // The minutes table is passed in, not repeated, so LOCKOUT_MINUTES stays the
  // single source of truth for SQL and for `lockoutMinutesFor` alike.
  const [first, second, third] = LOCKOUT_MINUTES;
  const rows = await deps.prisma.$queryRaw<{ failed_login_count: number }[]>`
    UPDATE app_user
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN (failed_login_count + 1) % ${LOCKOUT_THRESHOLD}::int = 0
             THEN ${now}::timestamptz + make_interval(mins =>
                    CASE LEAST((failed_login_count + 1) / ${LOCKOUT_THRESHOLD}::int, 3)
                      WHEN 1 THEN ${first}::int
                      WHEN 2 THEN ${second}::int
                      ELSE ${third}::int
                    END)
             ELSE locked_until
           END
     WHERE id = ${userId}::uuid
       AND (locked_until IS NULL OR locked_until <= ${now}::timestamptz)
    RETURNING failed_login_count`;

  return rows[0]?.failed_login_count ?? null;
}

/**
 * Emails the account holder when a failed attempt was the one that locked the
 * account (spec §6.23), as `account_security_alert`. The lock itself is
 * already in place.
 */
async function alertIfLocked(
  deps: AuthDeps,
  login: StudioLogin,
  attemptNumber: number,
  now: Date,
): Promise<void> {
  const minutes = lockoutMinutesFor(attemptNumber);
  if (minutes === null) return;

  // Recomputed rather than read back from `$queryRaw`: same clock, same table,
  // same formula as the claim, and no timestamp crosses the raw-query boundary.
  const lockedUntil = new Date(now.getTime() + minutes * 60_000);

  // Already enqueued is success, not a failed login (plan.md Task 14's rule for
  // every enqueue): `enqueue` reports a duplicate key instead of throwing.
  await enqueue(deps.prisma, {
    kind: 'email',
    template: 'account_security_alert',
    recipient: login.email,
    // The attempt number makes each lock event its own key, even when two
    // capped 15-minute locks would compute the same `lockedUntil`.
    dedupeKey: `email:account_security_alert:login_lockout:${login.id}:${attemptNumber}:${lockedUntil.toISOString()}`,
    payload: {
      variant: 'login_lockout',
      failedLoginCount: attemptNumber,
      lockedUntil: lockedUntil.toISOString(),
    },
  });
}

/** A login `canUseStudio` accepts, with what this module needs of it. */
type StudioLogin = { id: string; email: string; passwordHash: string; photographerId: string };

/**
 * The studio login for this email, or null -- for an unknown email AND for any
 * account `canUseStudio` refuses, so a caller cannot tell the two apart.
 *
 * Exact, case-insensitive match, served by the functional unique index
 * `app_user_lower_email_unique`: one address is one account, whatever its role.
 *
 * NOT Prisma's `{ equals, mode: 'insensitive' }`: on PostgreSQL that compiles to
 * `ILIKE`, a PATTERN match. `%` matched every address -- a login with email `%`
 * and the right password was issued a session -- and a lone `\` raised SQLSTATE
 * 22025 as a 500. The account's address stopped being a factor at all: anyone
 * could guess passwords, lock the account, or trigger reset emails against it.
 */
async function findStudioLogin(prisma: PrismaClient, email: string): Promise<StudioLogin | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM app_user WHERE lower(email) = lower(${email}) LIMIT 1`;
  const id = rows[0]?.id;
  if (id === undefined) return null;
  const user = await prisma.appUser.findUnique({ where: { id }, include: { photographer: { select: { id: true } } } });
  if (user === null || !canUseStudio(user)) return null;
  return { id: user.id, email: user.email, passwordHash: user.passwordHash, photographerId: user.photographer.id };
}

let dummyHashPromise: Promise<string> | undefined;

/** A real Argon2id hash of nothing anyone knows, computed once. */
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHashPromise;
}
