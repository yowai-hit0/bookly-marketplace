import { randomBytes } from 'node:crypto';
import type { AdminUser, PrismaClient } from '@prisma/client';
import { SQLSTATE, sqlstateOf } from '../db/errors.js';
import { hashPassword, verifyPassword } from './password.js';
import { type IssuedToken, issueAdminToken, sha256Hex } from './token.js';

/**
 * Admin login, lockout and password reset (plan.md Task 7, spec §6.23, A-11).
 * Transport-free: the router maps these results onto HTTP.
 */

export type AuthDeps = {
  prisma: PrismaClient;
  sessionSecret: string;
  /** The admin UI's origin. Reset links point here, never at the API host. */
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
  | ({ status: 'ok'; admin: AdminUser } & IssuedToken)
  /** Deliberately one result for unknown email, wrong password AND locked
   *  account: none of the three is disclosed to the caller. The lockout email
   *  is how the photographer learns he is locked out. */
  | { status: 'invalid_credentials' };

export async function attemptLogin(
  deps: AuthDeps,
  email: string,
  password: string,
): Promise<LoginResult> {
  const now = deps.now();
  const admin = await findAdminByEmail(deps.prisma, email);

  // Claim the attempt BEFORE spending Argon2 on it. The claim is one atomic
  // UPDATE that refuses a locked account and, when this attempt is the Nth, sets
  // the lock in the same statement. Checking "is it locked?" in one query and
  // recording the failure in another let a burst of concurrent guesses all read
  // "unlocked" and all be verified -- 10 at once got 8 checked, not 5.
  const attemptNumber = admin === null ? null : await claimLoginAttempt(deps, admin.id, now);

  if (admin === null || attemptNumber === null) {
    // Spend the same Argon2 cost as a real check, so response time does not
    // reveal whether the email exists or the account is locked. A locked
    // attempt is not counted: it proves nothing new.
    await verifyPassword(await dummyHash(), password);
    return { status: 'invalid_credentials' };
  }

  if (!(await verifyPassword(admin.passwordHash, password))) {
    await alertIfLocked(deps, admin, attemptNumber, now);
    return { status: 'invalid_credentials' };
  }

  // Success also clears a lock this very attempt may have set pessimistically:
  // the right password proves who is asking.
  const signedIn = await deps.prisma.adminUser.update({
    where: { id: admin.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
  });

  const issued = await issueAdminToken(deps.sessionSecret, signedIn, now);
  return { status: 'ok', admin: signedIn, ...issued };
}

/** Minutes to lock for this failure count, or null if it does not lock. */
export function lockoutMinutesFor(failedLoginCount: number): number | null {
  if (failedLoginCount <= 0 || failedLoginCount % LOCKOUT_THRESHOLD !== 0) return null;
  const lockNumber = failedLoginCount / LOCKOUT_THRESHOLD;
  return LOCKOUT_MINUTES[Math.min(lockNumber, LOCKOUT_MINUTES.length) - 1] ?? null;
}

/**
 * Always resolves, whether or not the email belongs to the admin: the response
 * must not confirm which address is the admin's. A second request replaces the
 * first token, so only the newest link works.
 */
export async function requestPasswordReset(deps: AuthDeps, email: string): Promise<void> {
  const admin = await findAdminByEmail(deps.prisma, email);
  if (admin === null) return;

  // 256 bits. High entropy is what makes a fast hash acceptable for storage.
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(deps.now().getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000);

  await deps.prisma.$transaction([
    deps.prisma.adminUser.update({
      where: { id: admin.id },
      data: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: expiresAt },
    }),
    // Everything the photographer receives is `admin_alert` (data-model_v2.md
    // §5.13); there is no dedicated reset template. The plaintext token lives
    // only in this payload until the worker (Task 14) delivers it -- never in an
    // admin_user column.
    deps.prisma.outbox.create({
      data: {
        kind: 'email',
        template: 'admin_alert',
        recipient: admin.email,
        dedupeKey: `email:admin_alert:password_reset:${admin.id}:${tokenHash}`,
        payload: {
          variant: 'password_reset',
          // A fragment, not a query string: it never reaches a server log, a
          // proxy, or a Referer header on the static host.
          resetUrl: `${deps.webOrigin}/admin/reset-password#token=${token}`,
          expiresAt: expiresAt.toISOString(),
        },
      },
    }),
  ]);
}

export type PasswordResetResult = 'ok' | 'invalid_or_expired_token';

/**
 * Consumes a reset token and sets the new password. Single-use is enforced by
 * the database, not by a read-then-write: the UPDATE's own WHERE clause requires
 * the token hash, and the same statement clears it, so two concurrent uses of
 * one token cannot both succeed.
 *
 * Changing `password_hash` invalidates every admin token already issued,
 * because each carries a fingerprint of the old hash. It also clears any lockout: the
 * person holding the emailed token has proved control of the admin mailbox.
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
  const holder = await deps.prisma.adminUser.findFirst({ where: liveToken, select: { id: true } });
  if (holder === null) return 'invalid_or_expired_token';

  const passwordHash = await hashPassword(newPassword);

  const { count } = await deps.prisma.adminUser.updateMany({
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
  adminId: string,
  now: Date,
): Promise<number | null> {
  // The minutes table is passed in, not repeated, so LOCKOUT_MINUTES stays the
  // single source of truth for SQL and for `lockoutMinutesFor` alike.
  const [first, second, third] = LOCKOUT_MINUTES;
  const rows = await deps.prisma.$queryRaw<{ failed_login_count: number }[]>`
    UPDATE admin_user
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
     WHERE id = ${adminId}::uuid
       AND (locked_until IS NULL OR locked_until <= ${now}::timestamptz)
    RETURNING failed_login_count`;

  return rows[0]?.failed_login_count ?? null;
}

/**
 * Emails the photographer when a failed attempt was the one that locked the
 * account (spec §6.23). The lock itself is already in place.
 */
async function alertIfLocked(
  deps: AuthDeps,
  admin: AdminUser,
  attemptNumber: number,
  now: Date,
): Promise<void> {
  const minutes = lockoutMinutesFor(attemptNumber);
  if (minutes === null) return;

  // Recomputed rather than read back from `$queryRaw`: same clock, same table,
  // same formula as the claim, and no timestamp crosses the raw-query boundary.
  const lockedUntil = new Date(now.getTime() + minutes * 60_000);

  try {
    await deps.prisma.outbox.create({
      data: {
        kind: 'email',
        template: 'admin_alert',
        recipient: admin.email,
        // The attempt number makes each lock event its own key, even when two
        // capped 15-minute locks would compute the same `lockedUntil`.
        dedupeKey: `email:admin_alert:login_lockout:${admin.id}:${attemptNumber}:${lockedUntil.toISOString()}`,
        payload: {
          variant: 'login_lockout',
          failedLoginCount: attemptNumber,
          lockedUntil: lockedUntil.toISOString(),
        },
      },
    });
  } catch (error) {
    // Already enqueued: a duplicate is success, not a failed login (plan.md
    // Task 14's rule for every enqueue). Anything else is a real fault.
    if (sqlstateOf(error) !== SQLSTATE.UNIQUE_VIOLATION && !isPrismaUniqueViolation(error)) {
      throw error;
    }
  }
}

/**
 * Exact, case-insensitive match, served by the functional unique index on
 * `lower(email)`.
 *
 * NOT Prisma's `{ equals, mode: 'insensitive' }`: on PostgreSQL that compiles to
 * `ILIKE`, a PATTERN match. `%` matched every address -- a login with email `%`
 * and the right password was issued a session -- and a lone `\` raised SQLSTATE
 * 22025 as a 500. The admin's address stopped being a factor at all: anyone
 * could guess passwords, lock the account, or trigger reset emails against it.
 */
async function findAdminByEmail(prisma: PrismaClient, email: string): Promise<AdminUser | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM admin_user WHERE lower(email) = lower(${email}) LIMIT 1`;
  const id = rows[0]?.id;
  return id === undefined ? null : prisma.adminUser.findUnique({ where: { id } });
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

let dummyHashPromise: Promise<string> | undefined;

/** A real Argon2id hash of nothing anyone knows, computed once. */
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHashPromise;
}
