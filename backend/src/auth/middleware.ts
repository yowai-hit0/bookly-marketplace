import type { AppUser } from '@prisma/client';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthDeps } from './admin-auth.js';
import { canUseStudio } from './roles.js';
import { passwordFingerprint, readBearerToken, safeEqual, verifyAdminToken } from './token.js';

/**
 * Server-side enforcement for every studio route (spec §2.2: no permission is
 * enforced by hiding UI alone). A later task's route is protected by being
 * mounted behind this, not by remembering to check.
 *
 * There is no CSRF middleware, deliberately. Studio auth is a bearer token the
 * client attaches in code; a browser never attaches it on its own, so a forged
 * cross-site request arrives without credentials and is simply a 401 here.
 */

export type PhotographerLocals = {
  /** The signed-in `app_user`, role photographer. */
  user: AppUser;
  /**
   * The photographer every studio query is scoped to (marketplace-spec.md
   * R1.4). It comes from the verified token's user and nothing else: never
   * from a path, a query string or a body.
   */
  photographerId: string;
};

/** Reads what `requirePhotographer` placed on the response. */
export function photographerLocals(res: Response): PhotographerLocals {
  return res.locals as PhotographerLocals;
}

/**
 * Requires a bearer token for a user who may use the studio (`canUseStudio`:
 * role photographer, a photographer row, not disabled), and puts the user and
 * their `photographerId` on `res.locals` (brief decision 3).
 *
 * The role is read from the database row, not trusted from the token. A token
 * whose user has since been disabled, changed role or lost their photographer
 * row stops working on the very next request, exactly as a password change
 * does.
 *
 * 401 with a JSON body and no redirect: the API has no login page to send
 * anyone to, and a redirect would be followed silently by `fetch`. The
 * `WWW-Authenticate` header is RFC 6750's, so a client can tell "sign in" from
 * "your token was refused". Every refusal after the token is read is the same
 * `invalid_token`, so the response never says which check failed.
 */
export function requirePhotographer(deps: AuthDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readBearerToken(req.get('authorization'));
    if (token === null) {
      unauthorized(res, 'Bearer realm="bookly-admin"');
      return;
    }

    const claims = await verifyAdminToken(deps.sessionSecret, token, deps.now());
    const user =
      claims === null || claims.role !== 'photographer'
        ? null
        : await deps.prisma.appUser.findUnique({
            where: { id: claims.userId },
            include: { photographer: { select: { id: true } } },
          });

    // Checked against the CURRENT password hash, so a password change fails every
    // token issued before it, on the very next request.
    if (
      claims === null ||
      user === null ||
      !canUseStudio(user) ||
      !safeEqual(claims.passwordFingerprint, passwordFingerprint(deps.sessionSecret, user.passwordHash))
    ) {
      unauthorized(res, 'Bearer realm="bookly-admin", error="invalid_token"');
      return;
    }

    const { photographer, ...row } = user;
    Object.assign(res.locals, { user: row, photographerId: photographer.id } satisfies PhotographerLocals);
    next();
  };
}

function unauthorized(res: Response, challenge: string): void {
  res.set('WWW-Authenticate', challenge).status(401).json({ error: 'unauthenticated' });
}
