import { randomBytes } from 'node:crypto';
import type { AppUser, Prisma, PrismaClient } from '@prisma/client';
import { linkClientRows } from '../booking/client.js';
import { enqueue } from '../outbox/enqueue.js';
import { type AuthDeps, claimLoginAttempt, findAreaLogin, spendDummyPasswordCheck } from './account-auth.js';
import { verifyPassword } from './password.js';
import { AREA_ROLE, type AuthArea, admitsArea } from './roles.js';
import { type IssuedToken, issueToken, sha256Hex } from './token.js';

/**
 * Email verification, in every area (Phase 2 decision 3; marketplace-spec.md
 * R2.1c, R2.2, R2.3). An address nobody has verified cannot sign in with a
 * password (`hasVerifiedEmail`), holds no token any middleware accepts, and
 * for a client links no bookings.
 *
 * The link is a 256-bit token, stored only as its SHA-256 on the user's row
 * (`app_user.email_verify_token_hash`, partial unique), good for 24 hours,
 * single-use, and confirmed by a POST from the page it opens -- never by the
 * GET of opening it, so a mail scanner that follows links verifies nothing.
 *
 * **Verification proves two things, not one** (R2.1c (a)). The POST carries
 * the token AND the account's password, and either being wrong is the same
 * refusal. The token proves the inbox; the password proves the person at the
 * inbox is the person who signed up. Without the second, anyone could sign up
 * with someone else's address and a password of their own, wait for the owner
 * to click the link out of curiosity, and then sign in to a verified account
 * with their own password -- seeing, for a client, every booking ever made
 * under that address. With it, the owner's click verifies nothing; their way in
 * is "Forgot password", which verifies the address and replaces the stranger's
 * password (`confirmPasswordReset`, R2.1c (b)).
 *
 * A wrong password here counts toward the account's lockout exactly as at the
 * login (`claimLoginAttempt`), so the endpoint is no side door for guessing.
 */

/** Phase 2 decision 3. */
export const EMAIL_VERIFY_TTL_HOURS = 24;

type Db = PrismaClient | Prisma.TransactionClient;

/** What sending a link needs: the web origin the link lands on, and the clock. */
export type VerificationMailDeps = Pick<AuthDeps, 'webOrigin' | 'now'>;

/**
 * Mints a fresh verification token for `user`, replacing any earlier one --
 * only the newest link works -- and enqueues `account_verify_email` with a link
 * to `area`'s verify page. On the root client or inside the caller's
 * transaction (the signup's), so the link commits with the account or not at all.
 *
 * The plaintext token lives only in the outbox payload until the worker
 * delivers it, as the reset link's does; the row keeps its hash.
 */
export async function issueVerification(db: Db, deps: VerificationMailDeps, area: AuthArea, user: { id: string; email: string }): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(deps.now().getTime() + EMAIL_VERIFY_TTL_HOURS * 60 * 60_000);

  await db.appUser.update({ where: { id: user.id }, data: { emailVerifyTokenHash: tokenHash, emailVerifyExpiresAt: expiresAt } });
  // Account mail concerns a person, not a studio: no photographer_id.
  await enqueue(db, {
    kind: 'email',
    template: 'account_verify_email',
    recipient: user.email,
    dedupeKey: `email:account_verify_email:${user.id}:${tokenHash}`,
    payload: { area, token, expiresAt: expiresAt.toISOString() },
  });
}

/**
 * "Resend verification" (Phase 2 decision 3). Always resolves, so the route can
 * always answer 202: whether the address has an account, of this area, or
 * already verified, is never disclosed. A new link goes out only for a login
 * this area admits whose address is still unverified; anything else sends
 * nothing.
 */
export async function requestVerificationResend(deps: AuthDeps, area: AuthArea, email: string): Promise<void> {
  const login = await findAreaLogin(deps.prisma, area, email);
  if (login === null || login.emailVerifiedAt !== null) return;
  await deps.prisma.$transaction((tx) => issueVerification(tx, deps, area, login));
}

export type VerifyEmailResult =
  | ({ status: 'ok'; user: AppUser } & IssuedToken)
  /** One answer for an unknown, expired, used or other-area token, a wrong
   *  password, a locked account and a login the area no longer admits. */
  | { status: 'invalid' };

/**
 * Confirms a verification link: the token AND the account's password
 * (R2.1c (a)). On success the address is verified, the token is spent, a
 * client's bookings under the address are linked (marketplace-data-model.md
 * §2.8), and the holder is signed in -- they have just proved both the inbox
 * and the password, which is more than a login asks.
 *
 * Every refusal costs one Argon2 check, like a wrong password at the login, so
 * response time does not say whether the token was real.
 *
 * Single-use by the database: the final UPDATE requires the token hash (and the
 * password hash that was checked) in its WHERE clause and clears the token in
 * the same statement, so two concurrent confirmations cannot both succeed, and
 * a password changed in between voids this one.
 */
export async function confirmEmailVerification(deps: AuthDeps, area: AuthArea, token: string, password: string): Promise<VerifyEmailResult> {
  const now = deps.now();
  const tokenHash = sha256Hex(token);
  const liveToken = { emailVerifyTokenHash: tokenHash, emailVerifyExpiresAt: { gt: now }, role: AREA_ROLE[area] };

  const holder = await deps.prisma.appUser.findFirst({ where: liveToken, include: { photographer: { select: { id: true } } } });
  if (holder === null || holder.passwordHash === null || !admitsArea(area, holder)) {
    await spendDummyPasswordCheck(password);
    return { status: 'invalid' };
  }

  // Counted before Argon2 is spent, with the same atomic claim as the login: a
  // locked account cannot be verified, and a burst of guesses here locks it.
  const attempt = await claimLoginAttempt(deps, holder.id, now);
  if (attempt === null) {
    await spendDummyPasswordCheck(password);
    return { status: 'invalid' };
  }
  // No lockout alert from here: the address is unverified, and mail to an
  // unverified address is only ever the verification link (account-auth.ts).
  if (!(await verifyPassword(holder.passwordHash, password))) return { status: 'invalid' };

  const verified = await deps.prisma.$transaction(async (tx) => {
    const { count } = await tx.appUser.updateMany({
      where: { id: holder.id, ...liveToken, passwordHash: holder.passwordHash, disabledAt: null, anonymizedAt: null },
      data: {
        emailVerifiedAt: now,
        emailVerifyTokenHash: null,
        emailVerifyExpiresAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
      },
    });
    if (count !== 1) return null;
    if (holder.role === 'client') await linkClientRows(tx, holder.id, holder.email);
    return tx.appUser.findUniqueOrThrow({ where: { id: holder.id } });
  });
  if (verified === null) return { status: 'invalid' };

  const issued = await issueToken(deps.sessionSecret, area, verified, now);
  return { status: 'ok', user: verified, ...issued };
}
