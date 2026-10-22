import type { PrismaClient } from '@prisma/client';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AuthDeps } from './auth/account-auth.js';
import type { GoogleIdentityProvider } from './auth/google.js';
import { AUTH_AREAS } from './auth/roles.js';
import { areaIpKey, createLimiters, emailKey, type RateLimitOverrides, rateLimit } from './http/rate-limit.js';
import { securityHeaders } from './http/security-headers.js';
import { type PaymentRouting, requestProvider } from './payments/routing.js';
import { accountRouter } from './routes/account.js';
import { healthRouter } from './routes/health.js';
import { clientBookingRouter } from './routes/client-booking.js';
import { emailConfirmationsRouter } from './routes/email-confirmations.js';
import { type PaymentWebhooksDeps, paymentWebhooksRouter } from './routes/payment-webhooks.js';
import { availabilityRouter } from './routes/public-availability.js';
import { type BookingLinksDeps, bookingLinksRouter } from './routes/public-booking-links.js';
import { bookingsRouter } from './routes/public-bookings.js';
import { checkoutRouter } from './routes/public-checkout.js';
import { publicCatalogueRouter } from './routes/public-catalogue.js';
import { platformRouter } from './routes/platform.js';
import { studioRouter } from './routes/studio.js';

// Dev/test default, kept in sync with vite.config.ts's port and .env.example's
// WEB_ORIGIN. server.ts always overrides this with env.WEB_ORIGIN once parsed.
const DEV_WEB_ORIGIN = 'http://localhost:5173';

export type AppOptions = {
  corsOrigin?: string;
  /** Mounts the signed-in areas: `/api/studio/*` (photographers),
   *  `/api/platform/*` (platform admins) and `/api/account/*` (clients), each
   *  with its own `/auth/*` (Phase 2 decision 1). Omitted, those paths 404 --
   *  closed, not open -- which keeps the health checks free of a database. */
  auth?: AuthDeps;
  /** Client sign-in with Google (Phase 2 decision 6), inside the account area.
   *  Omitted, the feature is off: `/api/account/auth/providers` says so and
   *  the Google endpoints answer 404. Tests pass a fake identity provider. */
  google?: GoogleIdentityProvider;
  /** Mounts the anonymous public routes (`/api/services`, `/api/quote`,
   *  `/api/availability`, `/api/bookings`). Omitted, they 404 too, for the same
   *  reason. `now` is the injected clock lead time and consent are measured by. */
  publicApi?: {
    prisma: PrismaClient;
    now?: () => Date;
    /** Mounts the checkout (`/api/payment-methods`, `/api/checkout/*`,
     *  `/api/payments/*`) and puts a checkout token on each created booking
     *  (plan.md Task 16). `routing` is which methods are offered and who
     *  collects each (marketplace-spec.md R3.1); `secret` is `SESSION_SECRET`. */
    payments?: { routing: PaymentRouting; secret: string; providerTimeoutMs?: number };
    /** "Email me my links" (`/api/booking-links`): its limiter and hooks, for tests. */
    bookingLinks?: Pick<BookingLinksDeps, 'limiter' | 'onWork' | 'log'>;
  };
  /** Mounts `/api/webhooks/*` (plan.md Task 17), ahead of the JSON parser. */
  webhooks?: PaymentWebhooksDeps;
  /** Proxies in front of the API whose `X-Forwarded-For` is trusted (env
   *  `TRUST_PROXY_HOPS`). Every per-IP limit counts `req.ip`, so this must match
   *  the real hosting: one hop behind Render alone, two behind Cloudflare too. */
  trustProxyHops?: number;
  /** Tighter or looser request limits, for tests; production uses the defaults. */
  rateLimits?: RateLimitOverrides;
};

/** Pinned rather than left to body-parser's default, so nothing widens it by accident. */
export const JSON_BODY_LIMIT = '100kb';

export function createApp(options: AppOptions = {}): Express {
  const corsOrigin = options.corsOrigin ?? DEV_WEB_ORIGIN;

  const app = express();
  app.disable('x-powered-by');
  // How many proxies stand in front decides whose address `req.ip` is; every
  // per-IP limit below reads it (security review 2026-10-11, finding 4).
  app.set('trust proxy', options.trustProxyHops ?? 1);
  // On every response, errors and 404s included (security review 2026-10-11, finding 3).
  app.use(securityHeaders());
  // Allowlisted to the web app's origin. No `credentials`: auth is a
  // bearer token in the Authorization header, not a cookie, so no request needs
  // the browser to attach credentials on its behalf (plan.md Task 7, rev 2.3).
  app.use(cors({ origin: [corsOrigin] }));
  // Before the JSON parser, which would otherwise consume a callback's body
  // before its signature could be checked against the bytes (plan.md Task 17).
  if (options.webhooks) app.use('/api/webhooks', paymentWebhooksRouter(options.webhooks));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Request limits on the public writes and every area's sign-in and reset
  // (security review 2026-10-11, finding 2; Phase 2 decision 8). Counted before any route does work, so a refused
  // request costs nothing but the count.
  const now = options.publicApi?.now ?? (() => new Date());
  const limiters = createLimiters(options.rateLimits);
  app.post('/api/bookings', rateLimit(limiters.bookingsPerIp, now), rateLimit(limiters.bookingsPerEmail, now, emailKey));
  const payments = rateLimit(limiters.paymentsPerIp, now);
  app.post('/api/checkout/:reference/:token/payments', payments);
  app.post('/api/booking/:token/payments', payments);
  app.post('/api/booking/:token/email', rateLimit(limiters.emailChangePerIp, now));
  for (const area of AUTH_AREAS) {
    const byIp = areaIpKey(area);
    app.post(`/api/${area}/auth/login`, rateLimit(limiters.loginPerIp, now, byIp));
    app.post(`/api/${area}/auth/password-reset/request`, rateLimit(limiters.passwordResetPerIp, now, byIp));
    app.post(`/api/${area}/auth/password-reset/confirm`, rateLimit(limiters.passwordResetConfirmPerIp, now, byIp));
    app.post(`/api/${area}/auth/verify`, rateLimit(limiters.verifyPerIp, now, byIp));
    app.post(`/api/${area}/auth/verify/resend`, rateLimit(limiters.verifyResendPerIp, now, byIp));
  }
  // Signup exists in the two areas anyone may join; the platform's admins are seeded.
  for (const area of ['studio', 'account'] as const) app.post(`/api/${area}/auth/signup`, rateLimit(limiters.signupPerIp, now, areaIpKey(area)));
  app.post('/api/account/auth/google/start', rateLimit(limiters.googleStartPerIp, now, areaIpKey('account')));
  app.post('/api/account/auth/google/callback', rateLimit(limiters.googleCallbackPerIp, now, areaIpKey('account')));
  // Redirecting payouts is what a takeover aims for (R4.1).
  app.put('/api/studio/payout-method', rateLimit(limiters.payoutMethodPerIp, now, areaIpKey('studio')));

  app.use('/api', healthRouter);
  if (options.publicApi) {
    const { prisma } = options.publicApi;
    app.use('/api', publicCatalogueRouter(prisma));
    app.use('/api/availability', availabilityRouter(prisma, now));
    app.use('/api/bookings', bookingsRouter(prisma, now, options.publicApi.payments?.secret));
    if (options.publicApi.payments) {
      app.use('/api', checkoutRouter({ prisma, ...options.publicApi.payments }));
    }
    // "Email me my links", the public side of the resend (2026-09-25).
    app.use('/api/booking-links', bookingLinksRouter({ prisma, now, ...options.publicApi.bookingLinks }));
    // The new address's confirmation of a contact-email change (2026-09-25).
    app.use('/api/email-confirmations', emailConfirmationsRouter({ prisma, now }));
    // The client's own booking, addressed by its access token (plan.md Task 18).
    const clientPayments = options.publicApi.payments;
    app.use(
      '/api/booking',
      clientBookingRouter({
        prisma,
        now,
        ...(clientPayments === undefined
          ? {}
          : {
              payments: {
                routing: clientPayments.routing,
                ...(clientPayments.providerTimeoutMs === undefined ? {} : { providerTimeoutMs: clientPayments.providerTimeoutMs }),
              },
            }),
      }),
    );
  }
  if (options.auth) {
    // A session-fee request is recorded against the provider of the first
    // method on offer, and moves to the client's own method when they pay
    // (payments/initiate.ts). Nothing on offer: the request route is absent.
    const routing = options.publicApi?.payments?.routing;
    const providerId = routing === undefined ? undefined : requestProvider(routing)?.id;
    app.use('/api/studio', studioRouter({ ...options.auth, ...(providerId === undefined ? {} : { paymentProviderId: providerId }) }));
    app.use('/api/platform', platformRouter(options.auth));
    app.use('/api/account', accountRouter({ ...options.auth, ...(options.google === undefined ? {} : { google: options.google }) }));
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Body-parser marks a malformed or oversized body as a client error it is
    // safe to expose, and the router answers a path parameter it cannot
    // percent-decode (`/api/services/%E0%A4%A`) the same way. Either is a 4xx,
    // not a 500 -- and neither echoes the body or the path.
    if (isExposedClientError(err) || isUndecodableParam(err)) {
      res.status(err.status).json({ error: 'invalid_request' });
      return;
    }
    console.error(JSON.stringify({ level: 'error', message: String(err) }));
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

function isExposedClientError(err: unknown): err is { status: number } {
  if (typeof err !== 'object' || err === null) return false;
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  return expose === true && typeof status === 'number' && status >= 400 && status < 500;
}

/** The router's `decodeURIComponent` failure: a URIError it sets to 400 but never marks `expose`. */
function isUndecodableParam(err: unknown): err is URIError & { status: 400 } {
  return err instanceof URIError && (err as { status?: unknown }).status === 400;
}
