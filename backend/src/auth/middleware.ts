import type { AdminUser } from '@prisma/client';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthDeps } from './admin-auth.js';
import { passwordFingerprint, readBearerToken, safeEqual, verifyAdminToken } from './token.js';

/**
 * Server-side enforcement for every admin route (spec §2.2: no permission is
 * enforced by hiding UI alone). A later task's route is protected by being
 * mounted behind this, not by remembering to check.
 *
 * There is no CSRF middleware, deliberately. Admin auth is a bearer token the
 * client attaches in code; a browser never attaches it on its own, so a forged
 * cross-site request arrives without credentials and is simply a 401 here.
 */

export type AdminLocals = { admin: AdminUser };

/** Reads the verified admin placed by `requireAdmin`. */
export function adminLocals(res: Response): AdminLocals {
  return res.locals as AdminLocals;
}

/**
 * 401 with a JSON body and no redirect: the API has no login page to send
 * anyone to, and a redirect would be followed silently by `fetch`. The
 * `WWW-Authenticate` header is RFC 6750's, so a client can tell "sign in" from
 * "your token was refused".
 */
export function requireAdmin(deps: AuthDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readBearerToken(req.get('authorization'));
    if (token === null) {
      unauthorized(res, 'Bearer realm="bookly-admin"');
      return;
    }

    const claims = await verifyAdminToken(deps.sessionSecret, token, deps.now());
    const admin =
      claims === null
        ? null
        : await deps.prisma.adminUser.findUnique({ where: { id: claims.adminId } });

    // Checked against the CURRENT password hash, so a password change fails every
    // token issued before it, on the very next request.
    const stillValid =
      claims !== null &&
      admin !== null &&
      safeEqual(claims.passwordFingerprint, passwordFingerprint(deps.sessionSecret, admin.passwordHash));

    if (!stillValid) {
      unauthorized(res, 'Bearer realm="bookly-admin", error="invalid_token"');
      return;
    }

    Object.assign(res.locals, { admin } satisfies AdminLocals);
    next();
  };
}

function unauthorized(res: Response, challenge: string): void {
  res.set('WWW-Authenticate', challenge).status(401).json({ error: 'unauthenticated' });
}
