import { Router } from 'express';
import { z } from 'zod';
import type { AuthDeps } from '../auth/account-auth.js';
import { type GoogleIdentityProvider, completeGoogleSignIn, startGoogleSignIn } from '../auth/google.js';
import { clientLocals, requireClient } from '../auth/middleware.js';
import { toAccountUser, toPublicUser } from '../auth/public-user.js';
import { signUpClient } from '../auth/signup.js';
import { MAX_PASSWORD_LENGTH, MIN_NEW_PASSWORD_LENGTH, areaAuthRouter, sendSignedIn, signupEmail } from './area-auth.js';
import { parseOrReject } from './validation.js';

/**
 * `/api/account/*`: a client's own account (Phase 2 decisions 1, 5 and 6;
 * marketplace-spec.md R2.3, R2.4). Phase 8 builds the dashboard on it.
 *
 * Order is the security model, as in the studio and the platform: the
 * unauthenticated `/auth/*` endpoints first -- login, reset and verification
 * shared with every area, then the client's signup and Google sign-in -- and
 * then `requireClient`, behind which every path, one that does not exist
 * included, needs a client's account token. A photographer's or a platform
 * admin's token is a 401 here, even a valid one: it carries another audience.
 */

export type AccountRouterDeps = AuthDeps & {
  /** Google sign-in (decision 6). Absent: the feature is off, and its endpoints answer 404. */
  google?: GoogleIdentityProvider;
};

/**
 * A client's signup (decision 5). The same 400-versus-422 rule as the studio's
 * (`parseOrReject`): a malformed address is 400, a password or name of the
 * wrong length 422 naming it.
 */
const signupBody = z.strictObject({
  email: signupEmail,
  password: z.string().min(MIN_NEW_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  fullName: z.string().trim().min(1).max(200),
});

/** What Google sent back to the callback page. Google's codes are well under 512 characters. */
const googleCallbackBody = z.strictObject({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(512),
});

export function accountRouter(deps: AccountRouterDeps): Router {
  const router = Router();

  // --- Unauthenticated -------------------------------------------------------

  router.use('/auth', areaAuthRouter(deps, 'account'));

  // 202 whatever the address: a new one gets its verification link, a taken
  // one whatever auth/signup.ts says, and the caller learns neither.
  router.post('/auth/signup', async (req, res) => {
    const body = parseOrReject(signupBody, req.body, res);
    if (body === undefined) return;
    await signUpClient(deps, body);
    res.status(202).json({ ok: true });
  });

  // Which sign-in buttons the login page shows.
  router.get('/auth/providers', (_req, res) => {
    res.json({ google: deps.google !== undefined });
  });

  router.post('/auth/google/start', async (_req, res) => {
    const google = deps.google;
    if (google === undefined) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const started = await startGoogleSignIn({ ...deps, google });
    // The state is a one-time secret of this browser's sign-in.
    res.set('Cache-Control', 'no-store');
    res.json(started);
  });

  router.post('/auth/google/callback', async (req, res) => {
    const google = deps.google;
    if (google === undefined) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = googleCallbackBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const result = await completeGoogleSignIn({ ...deps, google }, body.data);
    switch (result.status) {
      case 'ok':
        sendSignedIn(res, toPublicUser(result.user), result);
        return;
      case 'invalid_state':
        res.status(400).json({ error: 'invalid_state' });
        return;
      case 'email_unverified':
        res.status(400).json({ error: 'google_email_unverified' });
        return;
      case 'account_conflict':
        // Worded generically by the UI: it says neither which kind of account
        // the address has nor that it has one (decision 6).
        res.status(409).json({ error: 'account_conflict' });
        return;
      case 'invalid_identity':
      case 'account_unavailable':
        res.status(400).json({ error: 'google_sign_in_failed' });
        return;
    }
  });

  // --- Everything below requires a client's valid account token --------------

  router.use(requireClient(deps));

  router.get('/me', (_req, res) => {
    res.json({ user: toAccountUser(clientLocals(res).user) });
  });

  return router;
}
