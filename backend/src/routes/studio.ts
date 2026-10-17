import { Router } from 'express';
import type { AuthDeps } from '../auth/account-auth.js';
import { photographerLocals, requirePhotographer } from '../auth/middleware.js';
import type { PaymentProviderId } from '../payments/provider.js';
import { toPublicUser } from '../auth/public-user.js';
import { areaAuthRouter } from './area-auth.js';
import { blocksRouter, workingHoursRouter } from './studio-availability.js';
import { studioBookingsRouter } from './studio-bookings.js';
import { calendarRouter } from './studio-calendar.js';
import { catalogueRouter } from './studio-catalogue.js';
import { settingsRouter } from './studio-settings.js';

/**
 * `/api/studio/*` (plan.md Task 7, revision 2.3; Phase 2 decision 1): the
 * photographer's studio. It was the admin prefix until Phase 2, which renamed it
 * with no alias.
 *
 * Order is the security model. The unauthenticated `/auth/*` endpoints come
 * first; everything registered after `requirePhotographer` is protected by
 * construction -- including paths that do not exist, which answer 401 rather
 * than revealing whether a route is there. Every router below it reads the
 * photographer to scope to from `photographerLocals(res).photographerId`.
 */

export type StudioRouterDeps = AuthDeps & {
  /** The active payment provider, when one is configured (plan.md Task 20). */
  paymentProviderId?: PaymentProviderId;
};

export function studioRouter(deps: StudioRouterDeps): Router {
  const router = Router();

  // --- Unauthenticated -------------------------------------------------------

  router.use('/auth', areaAuthRouter(deps, 'studio'));

  // --- Everything below requires a photographer's valid bearer token ---------

  router.use(requirePhotographer(deps));

  // The signed-in login and the photographer it owns: what the studio layout
  // needs, the pending or suspended banner included (marketplace-spec.md R2.2).
  router.get('/me', async (_req, res) => {
    const { user, photographerId } = photographerLocals(res);
    const photographer = await deps.prisma.photographer.findUniqueOrThrow({
      where: { id: photographerId },
      select: { id: true, handle: true, displayName: true, status: true },
    });
    res.json({ user: toPublicUser(user), photographer });
  });

  // Availability and settings (Task 8).
  router.use('/working-hours', workingHoursRouter(deps.prisma));
  router.use('/blocks', blocksRouter(deps.prisma));
  router.use('/settings', settingsRouter(deps.prisma));

  // Calendar views (Task 9).
  router.use('/calendar', calendarRouter(deps.prisma, deps.now));

  // Bookings: the list, one booking, and its lifecycle (Tasks 19, 20).
  router.use(
    studioBookingsRouter({
      prisma: deps.prisma,
      now: deps.now,
      ...(deps.paymentProviderId === undefined ? {} : { paymentProviderId: deps.paymentProviderId }),
    }),
  );

  // Catalogue CMS (Task 10).
  router.use(catalogueRouter(deps.prisma, deps.now));

  return router;
}
