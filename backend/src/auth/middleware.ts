import type { AppUser } from '@prisma/client';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthDeps } from './account-auth.js';
import { type AuthArea, admitsArea, hasVerifiedEmail } from './roles.js';
import { TOKEN_AUDIENCES, credentialFingerprint, readBearerToken, safeEqual, verifyToken } from './token.js';

/**
 * Server-side enforcement for every signed-in route (spec §2.2: no permission
 * is enforced by hiding UI alone; marketplace-spec.md R2.1, Phase 2 decision 2).
 * One guard per area, each mounted ahead of everything in its router, so a
 * later route is protected by being mounted behind it, not by remembering to
 * check:
 *
 *   requirePhotographer    `/api/studio/*`     -> photographerLocals(res)
 *   requirePlatformAdmin   `/api/platform/*`   -> platformAdminLocals(res)
 *   requireClient          `/api/account/*`    -> clientLocals(res)
 *
 * There is no CSRF middleware, deliberately. Auth is a bearer token the client
 * attaches in code; a browser never attaches it on its own, so a forged
 * cross-site request arrives without credentials and is simply a 401 here.
 */

/** What every area's guard places on `res.locals`. */
export type AreaLocals = {
  /** The signed-in `app_user`, of the area's role, as the database holds it now. */
  user: AppUser;
};

export type PhotographerLocals = AreaLocals & {
  /**
   * The photographer every studio query is scoped to (marketplace-spec.md
   * R1.4). It comes from the verified token's user and nothing else: never
   * from a path, a query string or a body.
   */
  photographerId: string;
};

export type PlatformAdminLocals = AreaLocals;
export type ClientLocals = AreaLocals;

/** Reads what `requirePhotographer` placed on the response. */
export function photographerLocals(res: Response): PhotographerLocals {
  return res.locals as PhotographerLocals;
}

/** Reads what `requirePlatformAdmin` placed on the response. */
export function platformAdminLocals(res: Response): PlatformAdminLocals {
  return res.locals as PlatformAdminLocals;
}

/** Reads what `requireClient` placed on the response. */
export function clientLocals(res: Response): ClientLocals {
  return res.locals as ClientLocals;
}

/** The studio: a photographer with a photographer row. Also puts their `photographerId` on `res.locals`. */
export function requirePhotographer(deps: AuthDeps): RequestHandler {
  return requireArea('studio', deps);
}

/** The platform console: a platform admin. */
export function requirePlatformAdmin(deps: AuthDeps): RequestHandler {
  return requireArea('platform', deps);
}

/** A client's own account. */
export function requireClient(deps: AuthDeps): RequestHandler {
  return requireArea('account', deps);
}

/**
 * Requires a bearer token issued for `area` (its own `aud`), for a user the
 * area still admits, and puts the user on `res.locals` -- with their
 * `photographerId` in the studio.
 *
 * Everything is re-read from the database on every request, never trusted
 * from the token: the role, `disabled_at`, `anonymized_at`, the verified
 * address, the studio's photographer row, and the credential fingerprint
 * (password hash, Google subject, token version). A token whose user has since
 * been disabled, erased, changed role or credentials, or been revoked stops
 * working on the very next request.
 *
 * 401 with a JSON body and no redirect: the API has no login page to send
 * anyone to, and a redirect would be followed silently by `fetch`. The
 * `WWW-Authenticate` header is RFC 6750's, with the area's audience as its
 * realm, so a client can tell "sign in" from "your token was refused". Every
 * refusal after the token is read is the same `invalid_token`, so the response
 * never says which check failed -- a wrong-audience token included.
 */
function requireArea(area: AuthArea, deps: AuthDeps): RequestHandler {
  const realm = `Bearer realm="${TOKEN_AUDIENCES[area]}"`;
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readBearerToken(req.get('authorization'));
    if (token === null) {
      unauthorized(res, realm);
      return;
    }

    const claims = await verifyToken(deps.sessionSecret, area, token, deps.now());
    const user =
      claims === null
        ? null
        : await deps.prisma.appUser.findUnique({
            where: { id: claims.userId },
            include: { photographer: { select: { id: true } } },
          });

    // Checked against the CURRENT credentials, so a password change (or any
    // other change the fingerprint covers) fails every token issued before it,
    // on the very next request.
    if (
      claims === null ||
      user === null ||
      !admitsArea(area, user) ||
      !hasVerifiedEmail(user) ||
      !safeEqual(claims.credentialFingerprint, credentialFingerprint(deps.sessionSecret, user))
    ) {
      unauthorized(res, `${realm}, error="invalid_token"`);
      return;
    }

    const { photographer, ...row } = user;
    if (area === 'studio' && photographer !== null) {
      Object.assign(res.locals, { user: row, photographerId: photographer.id } satisfies PhotographerLocals);
    } else {
      Object.assign(res.locals, { user: row } satisfies AreaLocals);
    }
    next();
  };
}

function unauthorized(res: Response, challenge: string): void {
  res.set('WWW-Authenticate', challenge).status(401).json({ error: 'unauthenticated' });
}
