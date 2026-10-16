import { Router } from 'express';
import { z } from 'zod';
import {
  type AuthDeps,
  attemptLogin,
  confirmPasswordReset,
  requestPasswordReset,
} from '../auth/admin-auth.js';
import { adminLocals, requireAdmin } from '../auth/middleware.js';
import type { PaymentProviderId } from '../payments/provider.js';
import { toPublicAdmin } from '../auth/public-admin.js';
import { blocksRouter, workingHoursRouter } from './admin-availability.js';
import { adminBookingsRouter } from './admin-bookings.js';
import { calendarRouter } from './admin-calendar.js';
import { catalogueRouter } from './admin-catalogue.js';
import { settingsRouter } from './admin-settings.js';

/**
 * `/api/admin/*` (plan.md Task 7, revision 2.3).
 *
 * Order is the security model. The three unauthenticated endpoints come first;
 * everything registered after `requireAdmin` is protected by construction --
 * including paths that do not exist, which answer 401 rather than revealing
 * whether a route is there.
 *
 * There is no logout endpoint. Admin auth is a bearer token the client holds, so
 * signing out is the client discarding it; a server endpoint could not revoke a
 * stateless token and would only pretend to. Real revocation is a password
 * change or rotating SESSION_SECRET.
 */

/** Argon2 cost is proportional to input: cap it so a huge body is not a CPU DoS. */
const MAX_PASSWORD_LENGTH = 1024;

/** Matches the seed's floor for the initial password (src/db/seed.ts). */
const MIN_NEW_PASSWORD_LENGTH = 12;

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

export type AdminRouterDeps = AuthDeps & {
  /** The active payment provider, when one is configured (plan.md Task 20). */
  paymentProviderId?: PaymentProviderId;
};

export function adminRouter(deps: AdminRouterDeps): Router {
  const router = Router();

  // --- Unauthenticated -------------------------------------------------------

  router.post('/auth/login', async (req, res) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const result = await attemptLogin(deps, body.data.email, body.data.password);
    if (result.status !== 'ok') {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }

    // A response carrying a credential must not be cached by the browser or any
    // proxy between it and here (RFC 6749 §5.1).
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      admin: toPublicAdmin(result.admin),
      token: result.token,
      tokenType: 'Bearer',
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  router.post('/auth/password-reset/request', async (req, res) => {
    const body = resetRequestBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    await requestPasswordReset(deps, body.data.email);
    // Identical whether or not the address is the admin's.
    res.status(202).json({ ok: true });
  });

  router.post('/auth/password-reset/confirm', async (req, res) => {
    const body = resetConfirmBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const result = await confirmPasswordReset(deps, body.data.token, body.data.newPassword);
    if (result !== 'ok') {
      res.status(400).json({ error: 'invalid_or_expired_token' });
      return;
    }
    res.status(204).end();
  });

  // --- Everything below requires a valid admin bearer token ------------------

  router.use(requireAdmin(deps));

  router.get('/me', (_req, res) => {
    res.json({ admin: toPublicAdmin(adminLocals(res).admin) });
  });

  // Availability and settings (Task 8).
  router.use('/working-hours', workingHoursRouter(deps.prisma));
  router.use('/blocks', blocksRouter(deps.prisma));
  router.use('/settings', settingsRouter(deps.prisma));

  // Calendar views (Task 9).
  router.use('/calendar', calendarRouter(deps.prisma, deps.now));

  // Bookings: the list, one booking, and its lifecycle (Tasks 19, 20).
  router.use(
    adminBookingsRouter({
      prisma: deps.prisma,
      now: deps.now,
      ...(deps.paymentProviderId === undefined ? {} : { paymentProviderId: deps.paymentProviderId }),
    }),
  );

  // Catalogue CMS (Task 10).
  router.use(catalogueRouter(deps.prisma, deps.now));

  return router;
}
