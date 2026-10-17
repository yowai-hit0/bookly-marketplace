import { type Response, Router } from 'express';
import { z } from 'zod';
import { type AuthDeps, attemptLogin, confirmPasswordReset, requestPasswordReset } from '../auth/account-auth.js';
import { confirmEmailVerification, requestVerificationResend } from '../auth/email-verification.js';
import type { AuthArea } from '../auth/roles.js';
import type { IssuedToken } from '../auth/token.js';
import { type PublicUser, toPublicUser } from '../auth/public-user.js';

/**
 * `/api/{studio,platform,account}/auth/*`: login, password reset and email
 * verification, one router mounted once per area (Phase 2 decision 1; marketplace-spec.md R2.5).
 * Every endpoint is unauthenticated, so each area's router mounts this ahead
 * of its guard. The area decides which role may sign in, where the reset link
 * lands and which audience the token carries (`auth/account-auth.ts`).
 *
 * There is no logout endpoint. Auth is a bearer token the client holds, so
 * signing out is the client discarding it; a server endpoint could not revoke a
 * stateless token and would only pretend to. Real revocation is a password
 * change, `revokeTokens`, or rotating SESSION_SECRET.
 */

/** Argon2 cost is proportional to input: cap it so a huge body is not a CPU DoS. */
export const MAX_PASSWORD_LENGTH = 1024;

/** Matches the seed's floor for the initial password (src/db/seed.ts). */
export const MIN_NEW_PASSWORD_LENGTH = 12;

const loginBody = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const resetRequestBody = z.object({
  email: z.string().trim().min(1).max(320),
});

const resetConfirmBody = z.object({
  token: z.string().min(1).max(512),
  newPassword: z.string().min(MIN_NEW_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

/** A signup's address: trimmed, then a real address (the studio's and the account's signups). */
export const signupEmail = z.string().trim().max(320).pipe(z.email());

/** The token from the link, and the password the account was created with (R2.1c (a)). */
const verifyBody = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const resendBody = z.object({
  email: z.string().trim().min(1).max(320),
});

/**
 * A signed-in answer: login, verification and Google sign-in all send this.
 * A response carrying a credential must not be cached by the browser or any
 * proxy between it and here (RFC 6749 §5.1).
 */
export function sendSignedIn(res: Response, user: PublicUser, issued: IssuedToken): void {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ user, token: issued.token, tokenType: 'Bearer', expiresAt: issued.expiresAt.toISOString() });
}

export function areaAuthRouter(deps: AuthDeps, area: AuthArea): Router {
  const router = Router();

  router.post('/login', async (req, res) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const result = await attemptLogin(deps, area, body.data.email, body.data.password);
    if (result.status !== 'ok') {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }

    sendSignedIn(res, toPublicUser(result.user), result);
  });

  router.post('/password-reset/request', async (req, res) => {
    const body = resetRequestBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    await requestPasswordReset(deps, area, body.data.email);
    // Identical whether or not the address has a login in this area.
    res.status(202).json({ ok: true });
  });

  router.post('/password-reset/confirm', async (req, res) => {
    const body = resetConfirmBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const result = await confirmPasswordReset(deps, area, body.data.token, body.data.newPassword);
    if (result !== 'ok') {
      res.status(400).json({ error: 'invalid_or_expired_token' });
      return;
    }
    res.status(204).end();
  });

  // Email verification (Phase 2 decision 3; marketplace-spec.md R2.1c). The
  // page the emailed link opens posts the token with the account's password;
  // one refusal covers a bad, expired or used token and a wrong password. On
  // success the address is verified and the caller is signed in.
  router.post('/verify', async (req, res) => {
    const body = verifyBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const result = await confirmEmailVerification(deps, area, body.data.token, body.data.password);
    if (result.status !== 'ok') {
      res.status(400).json({ error: 'invalid_verification' });
      return;
    }
    sendSignedIn(res, toPublicUser(result.user), result);
  });

  router.post('/verify/resend', async (req, res) => {
    const body = resendBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    await requestVerificationResend(deps, area, body.data.email);
    // Identical whether the address is unknown, verified, another area's, or due a new link.
    res.status(202).json({ ok: true });
  });

  return router;
}
