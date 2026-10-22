import { Router } from 'express';
import { z } from 'zod';
import type { AuthDeps } from '../auth/account-auth.js';
import { signUpPhotographer } from '../auth/signup.js';
import { handleField } from '../photographers/handle.js';
import { photographerLocals, requirePhotographer } from '../auth/middleware.js';
import type { PaymentProviderId } from '../payments/provider.js';
import type { PaymentRouting } from '../payments/routing.js';
import { toPublicUser } from '../auth/public-user.js';
import { MAX_PASSWORD_LENGTH, MIN_NEW_PASSWORD_LENGTH, areaAuthRouter, signupEmail } from './area-auth.js';
import { blocksRouter, workingHoursRouter } from './studio-availability.js';
import { studioBookingsRouter } from './studio-bookings.js';
import { calendarRouter } from './studio-calendar.js';
import { catalogueRouter } from './studio-catalogue.js';
import { studioPayoutsRouter } from './studio-payouts.js';
import { settingsRouter } from './studio-settings.js';
import { studioSubscriptionRouter } from './studio-subscription.js';
import { parseOrReject } from './validation.js';

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
  /** Whom a session-fee request is recorded against, when any method is on offer (plan.md Task 20; R3.1). */
  paymentProviderId?: PaymentProviderId;
  /** How the photographer pays for the subscription: the methods on offer and who collects each (R5.2, R3.1). */
  paymentRouting?: PaymentRouting;
  /** The provider call's deadline; injectable for tests. */
  providerTimeoutMs?: number;
};

/**
 * A photographer's signup (Phase 2 decision 4). The handle is lowercased, then
 * held to the CHECK's format. The 400-versus-422 rule of every write applies
 * (`parseOrReject`): a malformed email or handle is 400 `invalid_request`, a
 * password or name of the wrong length 422 `validation_failed` naming it.
 */
const signupBody = z.strictObject({
  email: signupEmail,
  password: z.string().min(MIN_NEW_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  // `photographer_display_name_length`.
  displayName: z.string().trim().min(1).max(80),
  handle: handleField,
});

export function studioRouter(deps: StudioRouterDeps): Router {
  const router = Router();

  // --- Unauthenticated -------------------------------------------------------

  router.use('/auth', areaAuthRouter(deps, 'studio'));

  // Photographer signup (Phase 2 decision 4; marketplace-spec.md R2.2): 202
  // whether or not the address is taken (auth/signup.ts says what each case
  // sends), and 409 `handle_taken` for a handle someone has or nobody may have.
  router.post('/auth/signup', async (req, res) => {
    const body = parseOrReject(signupBody, req.body, res);
    if (body === undefined) return;
    if ((await signUpPhotographer(deps, body)) === 'handle_taken') {
      res.status(409).json({ error: 'handle_taken' });
      return;
    }
    res.status(202).json({ ok: true });
  });

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

  // Earnings, payouts and the payout method (Phase 4: R4.1, R4.5).
  router.use(studioPayoutsRouter(deps));

  // The subscription: its page, paying for it, and polling a payment (Phase 5: R5.2, R5.3).
  router.use(
    studioSubscriptionRouter({
      ...deps,
      ...(deps.paymentRouting === undefined ? {} : { routing: deps.paymentRouting }),
      ...(deps.providerTimeoutMs === undefined ? {} : { providerTimeoutMs: deps.providerTimeoutMs }),
    }),
  );

  return router;
}
