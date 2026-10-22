import { type Response, Router } from 'express';
import { z } from 'zod';
import type { AuthDeps } from '../auth/account-auth.js';
import { platformAdminLocals, requirePlatformAdmin } from '../auth/middleware.js';
import { toPublicUser } from '../auth/public-user.js';
import {
  type ModerationDeps,
  type ModerationResult,
  PHOTOGRAPHER_STATUSES,
  approvePhotographer,
  listPhotographers,
  reactivatePhotographer,
  suspendPhotographer,
} from '../photographers/moderation.js';
import { areaAuthRouter } from './area-auth.js';
import { platformPayoutsRouter } from './platform-payouts.js';
import { platformSettingsRouter } from './platform-settings.js';
import { parseOrReject } from './validation.js';

/**
 * `/api/platform/*`: the platform admin's console (Phase 2 decision 7, the
 * minimum of marketplace-spec.md Phase 9 that signups need), plus Phase 4's
 * payouts and refunds (routes/platform-payouts.ts), and Phase 5's platform
 * settings and subscriptions (routes/platform-settings.ts). Phase 9 adds
 * categories and the rest.
 *
 * Order is the security model, as in the studio: the unauthenticated
 * `/auth/*` endpoints first, then `requirePlatformAdmin`, behind which every
 * path -- one that does not exist included -- needs a platform admin's token.
 * A photographer's or a client's token is a 401 here (T9.1), even a valid one:
 * it carries another area's audience.
 */

export type PlatformRouterDeps = AuthDeps & Pick<ModerationDeps, 'log'>;

const listQuery = z.strictObject({ status: z.enum(PHOTOGRAPHER_STATUSES).optional() });

const photographerId = z.guid();

/** What the platform admin typed, shown to the photographer in the email. */
const suspendBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });

export function platformRouter(deps: PlatformRouterDeps): Router {
  const router = Router();
  const moderation: ModerationDeps = { prisma: deps.prisma, now: deps.now, ...(deps.log === undefined ? {} : { log: deps.log }) };

  // --- Unauthenticated -------------------------------------------------------

  router.use('/auth', areaAuthRouter(deps, 'platform'));

  // --- Everything below requires a platform admin's valid bearer token -------

  router.use(requirePlatformAdmin(deps));

  router.get('/me', (_req, res) => {
    res.json({ user: toPublicUser(platformAdminLocals(res).user) });
  });

  router.get('/photographers', async (req, res) => {
    const query = parseOrReject(listQuery, req.query, res);
    if (query === undefined) return;
    res.json({ photographers: await listPhotographers(deps.prisma, query.status) });
  });

  router.post('/photographers/:id/approve', async (req, res) => {
    const id = parseOrReject(photographerId, req.params.id, res);
    if (id === undefined) return;
    send(res, await approvePhotographer(moderation, { photographerId: id, adminUserId: platformAdminLocals(res).user.id }));
  });

  router.post('/photographers/:id/suspend', async (req, res) => {
    const id = parseOrReject(photographerId, req.params.id, res);
    if (id === undefined) return;
    const body = parseOrReject(suspendBody, req.body, res);
    if (body === undefined) return;
    send(res, await suspendPhotographer(moderation, { photographerId: id, adminUserId: platformAdminLocals(res).user.id, reason: body.reason }));
  });

  router.post('/photographers/:id/reactivate', async (req, res) => {
    const id = parseOrReject(photographerId, req.params.id, res);
    if (id === undefined) return;
    send(res, await reactivatePhotographer(moderation, { photographerId: id, adminUserId: platformAdminLocals(res).user.id }));
  });

  // Payouts and refunds of money paid online (Phase 4: R4.4, R4.6).
  router.use(platformPayoutsRouter(deps));

  // The hold, the trial and the subscription plan; the subscriptions list (Phase 5: R5.1, R9.3).
  router.use(platformSettingsRouter(deps));

  return router;
}

/**
 * 200 with the photographer as they now are -- whether this call changed them
 * or an earlier one already had (idempotent) -- 404 for an id that names
 * nobody, 409 for a transition the photographer's status does not allow
 * (approving a suspended photographer: reactivate them instead). Approve and
 * reactivate read no body.
 */
function send(res: Response, result: ModerationResult): void {
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (result.status === 'invalid_transition') {
    res.status(409).json({ error: 'invalid_transition', photographer: result.photographer });
    return;
  }
  res.json({ photographer: result.photographer });
}
