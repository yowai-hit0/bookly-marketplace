import { type Response, Router } from 'express';
import { z } from 'zod';
import type { AuthDeps } from '../auth/account-auth.js';
import { platformAdminLocals, requirePlatformAdmin } from '../auth/middleware.js';
import { toPublicUser } from '../auth/public-user.js';
import {
  type ModerationDeps,
  type ModerationResult,
  PHOTOGRAPHER_STATUSES,
  REVIEW_FILTERS,
  approvePhotographer,
  listPhotographers,
  reactivatePhotographer,
  suspendPhotographer,
} from '../photographers/moderation.js';
import { PLATFORM_AUDIT_ACTIONS, listAudit } from '../platform/audit.js';
import { platformPhotographerDetail } from '../platform/photographer-detail.js';
import { areaAuthRouter } from './area-auth.js';
import { platformCategoriesRouter } from './platform-categories.js';
import { platformPayoutsRouter } from './platform-payouts.js';
import { platformSettingsRouter } from './platform-settings.js';
import { parseOrReject } from './validation.js';

/**
 * `/api/platform/*`: the platform admin's console (Phase 2 decision 7, the
 * minimum of marketplace-spec.md Phase 9 that signups need), plus Phase 4's
 * payouts and refunds (routes/platform-payouts.ts), and Phase 5's platform
 * settings and subscriptions (routes/platform-settings.ts). Phase 9 adds one
 * photographer's detail page, the audit trail's Activity page (R9.4;
 * platform/audit.ts) and the categories (routes/platform-categories.ts).
 *
 *   GET /photographers/:id                  200 { photographer, profile, setup, subscription,
 *                                           payoutMethod, methodChangedRecently, counts,
 *                                           earnings, activity } | 404 | 400
 *   GET /audit?action&photographerId&page   200 { entries, total, page, pageSize: 50, pageCount }
 *                                           newest first; a page past the end is empty
 *
 * Order is the security model, as in the studio: the unauthenticated
 * `/auth/*` endpoints first, then `requirePlatformAdmin`, behind which every
 * path -- one that does not exist included -- needs a platform admin's token.
 * A photographer's or a client's token is a 401 here (T9.1), even a valid one:
 * it carries another area's audience.
 */

export type PlatformRouterDeps = AuthDeps & Pick<ModerationDeps, 'log'>;

/**
 * `status` is the column's own vocabulary; `review` (Phase 7) narrows pending
 * photographers to those awaiting review (submitted) or still setting up (not
 * submitted). The two combine with AND (photographers/moderation.ts says why
 * `review` is a filter of its own).
 */
const listQuery = z.strictObject({ status: z.enum(PHOTOGRAPHER_STATUSES).optional(), review: z.enum(REVIEW_FILTERS).optional() });

const photographerId = z.guid();

/** The Activity page's filters (Phase 9 P2): each key at most once, a whole page number 1 to 1,000,000. */
const auditQuery = z.strictObject({
  action: z.enum(PLATFORM_AUDIT_ACTIONS).optional(),
  photographerId: z.guid().optional(),
  page: z
    .string()
    .regex(/^[0-9]{1,12}$/)
    .transform(Number)
    .pipe(z.int().min(1).max(1_000_000))
    .optional(),
});

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
    res.json({
      photographers: await listPhotographers(deps.prisma, {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.review === undefined ? {} : { review: query.review }),
      }),
    });
  });

  router.get('/photographers/:id', async (req, res) => {
    const id = parseOrReject(photographerId, req.params.id, res);
    if (id === undefined) return;
    const detail = await platformPhotographerDetail(deps.prisma, id, deps.now());
    if (detail === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(detail);
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

  // The audit trail, newest first (Phase 9: R9.4).
  router.get('/audit', async (req, res) => {
    const query = parseOrReject(auditQuery, req.query, res);
    if (query === undefined) return;
    res.json(
      await listAudit(
        deps.prisma,
        {
          ...(query.action === undefined ? {} : { action: query.action }),
          ...(query.photographerId === undefined ? {} : { photographerId: query.photographerId.toLowerCase() }),
        },
        query.page ?? 1,
      ),
    );
  });

  // Categories: create, rename, reorder, deactivate, delete (Phase 9: R9.2).
  router.use(platformCategoriesRouter(deps));

  return router;
}

/**
 * 200 with the photographer as they now are -- whether this call changed them
 * or an earlier one already had (idempotent) -- 404 for an id that names
 * nobody, 409 for a transition the photographer's status does not allow
 * (approving a suspended photographer: reactivate them instead), and 409
 * `not_submitted` for approving a pending photographer who has not submitted
 * their studio for review (Phase 7 user decision; R7.3). Approve and reactivate
 * read no body.
 */
function send(res: Response, result: ModerationResult): void {
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (result.status === 'invalid_transition' || result.status === 'not_submitted') {
    res.status(409).json({ error: result.status, photographer: result.photographer });
    return;
  }
  res.json({ photographer: result.photographer });
}
