import { type Response, Router } from 'express';
import { z } from 'zod';
import { BOOKING_SCOPES, accountBookingDetail, findAccountBooking, listAccountBookings } from '../account/bookings.js';
import { changePassword, deleteAccount, requestAccountEmailChange, setPassword } from '../account/credentials.js';
import { exportAccount } from '../account/export.js';
import { accountReceipt, listAccountPayments } from '../account/payments.js';
import { accountProfile, updateAccountProfile } from '../account/profile.js';
import type { AuthDeps } from '../auth/account-auth.js';
import { clientLocals } from '../auth/middleware.js';
import { toPublicUser } from '../auth/public-user.js';
import { kigaliDateOf } from '../availability/engine.js';
import { cancelLoaded } from '../booking/cancel.js';
import { normalizePhone } from '../booking/phone.js';
import { startSessionFeePayment } from '../payments/initiate.js';
import type { PaymentMethod } from '../payments/provider.js';
import type { PaymentRouting } from '../payments/routing.js';
import { MAX_PASSWORD_LENGTH, MIN_NEW_PASSWORD_LENGTH, sendSignedIn, signupEmail } from './area-auth.js';
import { parseOrReject } from './validation.js';

/**
 * The client dashboard (marketplace-spec.md Phase 8, R8.1-R8.4), mounted inside
 * `/api/account` BEHIND `requireClient`: every route here is the signed-in
 * client's own, and nothing in a path, query or body widens that. A booking
 * reference or a payment's `our_ref` that is not the account's is the same
 * `404 not_found` as one that names nothing (T8.1; `routes/account-isolation.test.ts`).
 *
 *   GET    /bookings?scope=upcoming|past&page   200 { scope, bookings, total, page, pageSize, pageCount }
 *   GET    /bookings/:reference                 200 { booking, photographer, checkoutPath } | 404
 *   POST   /bookings/:reference/cancel          200 { booking, photographer, checkoutPath } | 404
 *                                               409 not_cancellable { booking, photographer, checkoutPath }
 *   POST   /bookings/:reference/payments        { method, phone }   (when payments are configured)
 *                                               201 { payment: { ourRef, status } } | 404 | 422
 *                                               409 nothing_to_pay { booking, ... } | 409 payment_in_progress { payment }
 *                                               502 payment_not_started { reason, payment }
 *   GET    /payments?page                       200 { payments, total, page, pageSize, pageCount }
 *   GET    /payments/:ourRef                    200 { receipt } | 404 | 409 no_receipt { payment: { status } }
 *   GET    /profile                             200 { profile: { fullName, phone } }
 *   PATCH  /profile   { fullName?, phone? }     200 { profile } | 400 | 422 { fields }
 *   POST   /password { currentPassword, newPassword }   200 signed in | 403 invalid_password | 403 password_locked
 *                                               409 no_password | 409 credentials_changed | 422
 *   POST   /password/set { newPassword }        200 signed in | 409 password_exists | 422
 *   POST   /email    { newEmail, password }     202 { ok: true } | 400 | 403 | 409 password_required | 422 { fields: ['newEmail'] }
 *   GET    /export                              200 the JSON document, as an attachment
 *   POST   /delete   { password } | { confirmEmail }   204 | 400 | 403 invalid_password | password_locked | invalid_confirmation
 *
 * The address change is confirmed at `POST /api/account/email/confirm`, which
 * is NOT here: the link opens in a tab without the session (routes/account.ts).
 *
 * The cancel and the session-fee payment are the guest booking page's own
 * (booking/cancel.ts, payments/initiate.ts) -- the photographer's cut-off and
 * refund setting, the one-attempt-at-a-time rule, the provider routing --
 * authorised by the session instead of the access token. Changing a booking's
 * contact email stays on the guest page (the booking's emails are the
 * booking's, not the account's).
 *
 * `Cache-Control: no-store` throughout: personal data, and some answers carry
 * a token. Rate limits (app.ts): the session-fee payment shares the guest
 * payment limit; the password, address, deletion and export routes each have
 * their own, per IP in the account area -- each checks a password (Argon2),
 * sends an email, or reads everything the account holds.
 */

export type AccountDashboardDeps = AuthDeps & {
  /** Which methods are offered and who collects each (R3.1). Absent: no payment route. */
  payments?: { routing: PaymentRouting; providerTimeoutMs?: number };
  /** `SESSION_SECRET` when the checkout is mounted: signs a live hold's "finish payment" link. */
  checkoutSecret?: string;
  /** The deletion's structured log line; injectable for tests. */
  log?: (entry: Record<string, unknown>) => void;
};

const NUL = String.fromCharCode(0);
const PHONE_MAX_LENGTH = 40;
/** E.164: what `app_user_phone_e164` allows. */
const E164 = /^\+[1-9]\d{6,14}$/;

/** Characters as PostgreSQL's `char_length` counts them: code points. */
function chars(value: string): number {
  return [...value].length;
}

const listQuery = z.strictObject({
  scope: z.enum(BOOKING_SCOPES).default('upcoming'),
  /** 1-based; past the end answers the last page. */
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
});

const pageQuery = z.strictObject({ page: z.coerce.number().int().min(1).max(1_000_000).optional() });

/** The name the signup takes (1-200), trimmed; NUL refused. Required text: null is a 400. */
const fullName = z
  .string()
  .trim()
  .refine((value) => chars(value) >= 1, 'At least 1 character')
  .refine((value) => chars(value) <= 200, 'At most 200 characters')
  .refine((value) => !value.includes(NUL), 'Contains a NUL character');

/** A phone as people type it, stored E.164 (the studio's rule; booking/phone.ts reads Rwanda's formats). Null or blank clears. */
const phone = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z
    .string()
    .max(PHONE_MAX_LENGTH)
    .transform((typed) => normalizePhone(typed) ?? typed.trim())
    .refine((value) => E164.test(value), 'Must be a phone number in international form')
    .nullable(),
);

const profileBody = z.strictObject({ fullName: fullName.optional(), phone: phone.optional() });

const currentPassword = z.string().min(1).max(MAX_PASSWORD_LENGTH);
const newPassword = z.string().min(MIN_NEW_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

const passwordChangeBody = z.strictObject({ currentPassword, newPassword });
const passwordSetBody = z.strictObject({ newPassword });
const emailChangeBody = z.strictObject({ newEmail: signupEmail, password: currentPassword });

/** One confirmation or the other, never both: a union of strict objects, so either mistake is a 400. */
const deleteBody = z.union([z.strictObject({ password: currentPassword }), z.strictObject({ confirmEmail: z.string().trim().min(1).max(320) })]);

export function accountDashboardRouter(deps: AccountDashboardDeps): Router {
  const { prisma } = deps;
  const router = Router();
  const listDeps = { prisma, ...(deps.checkoutSecret === undefined ? {} : { checkoutSecret: deps.checkoutSecret }) };

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // --- Bookings (B1, B2) -------------------------------------------------------

  router.get('/bookings', async (req, res) => {
    const query = parseOrReject(listQuery, req.query, res);
    if (query === undefined) return;
    const page = await listAccountBookings(listDeps, clientLocals(res).user.id, query, deps.now());
    res.json(page);
  });

  router.get('/bookings/:reference', async (req, res) => {
    const booking = await findAccountBooking(prisma, clientLocals(res).user.id, req.params.reference);
    if (booking === null) {
      notFound(res);
      return;
    }
    res.json(await accountBookingDetail(listDeps, booking, deps.now()));
  });

  router.post('/bookings/:reference/cancel', async (req, res) => {
    const userId = clientLocals(res).user.id;
    const reference = req.params.reference;
    const before = await findAccountBooking(prisma, userId, reference);
    if (before === null) {
      notFound(res);
      return;
    }
    // Re-found through the account each time, so a booking unlinked between the
    // page and the click (an erasure) cancels nothing.
    const result = await cancelLoaded({ prisma, now: deps.now }, () => findAccountBooking(prisma, userId, reference));
    if (result.status === 'not_cancellable') {
      res.status(409).json({ error: 'not_cancellable', ...(await accountBookingDetail(listDeps, before, deps.now())) });
      return;
    }
    const after = await findAccountBooking(prisma, userId, reference);
    if (after === null) {
      notFound(res);
      return;
    }
    res.json(await accountBookingDetail(listDeps, after, deps.now()));
  });

  const payments = deps.payments;
  if (payments !== undefined) {
    const paymentBody = z.object({
      method: z.string().refine((method) => payments.routing.providerFor(method) !== undefined, 'Method not available'),
      phone: z
        .string()
        .max(PHONE_MAX_LENGTH)
        .refine((value) => normalizePhone(value) !== null, 'Invalid phone number')
        .transform((value) => normalizePhone(value) ?? value),
    });

    // The session fee, as the guest booking page pays it (routes/client-booking.ts).
    router.post('/bookings/:reference/payments', async (req, res) => {
      const booking = await findAccountBooking(prisma, clientLocals(res).user.id, req.params.reference);
      if (booking === null) {
        notFound(res);
        return;
      }
      const body = parseOrReject(paymentBody, req.body, res);
      if (body === undefined) return;
      const provider = payments.routing.providerFor(body.method);
      if (provider === undefined) throw new Error('A validated method has no provider');

      const result = await startSessionFeePayment(
        { prisma, provider, ...(payments.providerTimeoutMs === undefined ? {} : { timeoutMs: payments.providerTimeoutMs }) },
        { bookingId: booking.id, reference: booking.reference, method: body.method as PaymentMethod, payerPhone: body.phone },
      );
      switch (result.status) {
        case 'started':
          res.status(201).json({ payment: { ourRef: result.ourRef, status: 'pending' } });
          return;
        case 'in_progress':
          res.status(409).json({ error: 'payment_in_progress', payment: { ourRef: result.ourRef } });
          return;
        case 'provider_failed':
          res.status(502).json({ error: 'payment_not_started', reason: result.outcome, payment: { ourRef: result.ourRef, status: 'failed' } });
          return;
        default:
          // Cancelled, paid, or not yet confirmed: nothing is owed as a session fee.
          res.status(409).json({ error: 'nothing_to_pay', ...(await accountBookingDetail(listDeps, booking, deps.now())) });
          return;
      }
    });
  }

  // --- Payments and receipts (B3) ------------------------------------------------

  router.get('/payments', async (req, res) => {
    const query = parseOrReject(pageQuery, req.query, res);
    if (query === undefined) return;
    res.json(await listAccountPayments(prisma, clientLocals(res).user.id, query));
  });

  router.get('/payments/:ourRef', async (req, res) => {
    const result = await accountReceipt(prisma, clientLocals(res).user.id, req.params.ourRef);
    switch (result.status) {
      case 'ok':
        res.json({ receipt: result.receipt });
        return;
      case 'no_receipt':
        // The account's own payment, which took no money (yet): the page can say so.
        res.status(409).json({ error: 'no_receipt', payment: { status: result.paymentStatus } });
        return;
      case 'not_found':
        notFound(res);
        return;
    }
  });

  // --- Profile (B4) -----------------------------------------------------------------

  router.get('/profile', async (_req, res) => {
    res.json({ profile: await accountProfile(prisma, clientLocals(res).user.id) });
  });

  router.patch('/profile', async (req, res) => {
    const body = parseOrReject(profileBody, req.body, res);
    if (body === undefined) return;
    const update = {
      ...(body.fullName === undefined ? {} : { fullName: body.fullName }),
      ...(body.phone === undefined ? {} : { phone: body.phone }),
    };
    res.json({ profile: await updateAccountProfile(prisma, clientLocals(res).user.id, update) });
  });

  // --- Password (B5) -----------------------------------------------------------------

  router.post('/password', async (req, res) => {
    const body = parseOrReject(passwordChangeBody, req.body, res);
    if (body === undefined) return;
    const result = await changePassword(deps, clientLocals(res).user, body.currentPassword, body.newPassword);
    switch (result.status) {
      case 'ok':
        sendSignedIn(res, toPublicUser(result.user), result);
        return;
      case 'invalid_password':
      case 'password_locked':
        res.status(403).json({ error: result.status });
        return;
      case 'no_password':
      case 'credentials_changed':
        res.status(409).json({ error: result.status });
        return;
    }
  });

  router.post('/password/set', async (req, res) => {
    const body = parseOrReject(passwordSetBody, req.body, res);
    if (body === undefined) return;
    const result = await setPassword(deps, clientLocals(res).user, body.newPassword);
    if (result.status === 'password_exists') {
      res.status(409).json({ error: 'password_exists' });
      return;
    }
    sendSignedIn(res, toPublicUser(result.user), result);
  });

  // --- The address (B6) ----------------------------------------------------------------

  router.post('/email', async (req, res) => {
    const body = parseOrReject(emailChangeBody, req.body, res);
    if (body === undefined) return;
    const result = await requestAccountEmailChange(deps, clientLocals(res).user, body.newEmail, body.password);
    switch (result.status) {
      case 'requested':
        // The same answer whether or not the address has an account; `/me` shows it pending either way.
        res.status(202).json({ ok: true });
        return;
      case 'password_required':
        res.status(409).json({ error: 'password_required' });
        return;
      case 'same_email':
        res.status(422).json({ error: 'validation_failed', fields: ['newEmail'] });
        return;
      case 'invalid_password':
      case 'password_locked':
        res.status(403).json({ error: result.status });
        return;
    }
  });

  // --- Export (B7) -----------------------------------------------------------------------

  router.get('/export', async (_req, res) => {
    const now = deps.now();
    const document = await exportAccount(prisma, clientLocals(res).user, now);
    res.set('Content-Disposition', `attachment; filename="bookly-account-${kigaliDateOf(now)}.json"`);
    res.type('application/json').send(JSON.stringify(document, null, 2));
  });

  // --- Delete (B8) -----------------------------------------------------------------------

  router.post('/delete', async (req, res) => {
    const body = parseOrReject(deleteBody, req.body, res);
    if (body === undefined) return;
    const result = await deleteAccount(deps, clientLocals(res).user, body);
    if (result.status !== 'deleted') {
      res.status(403).json({ error: result.status });
      return;
    }
    res.status(204).end();
  });

  return router;
}

/** The one answer for anything that is not the account's: never 403 (T8.1). */
function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}
