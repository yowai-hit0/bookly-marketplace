import { Router } from 'express';
import { z } from 'zod';
import type { AuthDeps } from '../auth/account-auth.js';
import { photographerLocals } from '../auth/middleware.js';
import { normalizePhone } from '../booking/phone.js';
import { MOMO_NETWORKS, MOMO_PREFIXES, type PayoutMethodInput, RWANDA_MOBILE_E164, changePayoutMethod, currentPayoutMethod, payoutMethodView } from '../payouts/method.js';
import { studioEarnings, studioPayout } from '../payouts/payouts.js';
import { MAX_PASSWORD_LENGTH } from './area-auth.js';
import { parseOrReject } from './validation.js';

/**
 * The studio's money pages (marketplace-spec.md R4.1, R4.5, T4.4), behind
 * `requirePhotographer`. Everything is the signed-in photographer's own: the
 * scope is `photographerLocals(res).photographerId`, so another photographer's
 * earnings and payout method cannot even be named, and another photographer's
 * payout id is the same 404 as one that names nothing.
 *
 *   GET /earnings          200 { totals, items, payouts }
 *   GET /payouts/:id       200 { payout } | 404
 *   GET /payout-method     200 { payoutMethod | null }
 *   PUT /payout-method     { kind, momoNetwork?, momoNumber?, bankName?, bankAccountNumber?, accountName, currentPassword }
 *        200 { payoutMethod } | 400 | 403 invalid_password | 403 password_locked | 422 | 429
 *
 * The PUT is rate-limited per address (app.ts, `payoutMethodPerIp`), and its
 * password check shares the login lockout (auth/account-auth.ts
 * `verifyCurrentPassword`).
 */

const rowId = z.guid();
const NUL = String.fromCharCode(0);

/** Trimmed text PostgreSQL can store. */
const storableText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !value.includes(NUL), 'Contains a NUL character');

/** `payout_method_account_name_length`. */
const accountName = storableText(1, 120);
/**
 * Optional in the shape on purpose: a change without the password is the 403
 * of T4.4, not a 400. An absent or empty password is refused without being
 * counted toward the lockout -- there is nothing to have guessed.
 */
const currentPassword = z.string().max(MAX_PASSWORD_LENGTH).optional();

/** A Rwandan mobile number as people type it (`078 123 4567`, `+250 78...`), stored as E.164. */
const momoNumber = z
  .string()
  .max(32)
  .transform((typed) => normalizePhone(typed) ?? typed.trim())
  .refine((value) => RWANDA_MOBILE_E164.test(value), 'Must be a Rwandan mobile number');

/** A bank account number: letters, digits, spaces and dashes, with at least one digit. CHECK payout_method_bank_fields_length. */
const bankAccountNumber = storableText(5, 40).refine((value) => /^[0-9A-Za-z -]+$/.test(value) && /\d/.test(value), 'Not an account number');

const methodBody = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('momo'), momoNetwork: z.enum(MOMO_NETWORKS), momoNumber, accountName, currentPassword }),
    z.strictObject({ kind: z.literal('bank'), bankName: storableText(1, 100), bankAccountNumber, accountName, currentPassword }),
  ])
  .superRefine((body, ctx) => {
    // A number on the other network's prefix is a typo the transfer would fail on.
    if (body.kind === 'momo' && RWANDA_MOBILE_E164.test(body.momoNumber) && !MOMO_PREFIXES[body.momoNetwork].some((prefix) => body.momoNumber.startsWith(prefix))) {
      ctx.addIssue({ code: 'custom', path: ['momoNumber'], message: `Not a ${body.momoNetwork} number` });
    }
  });

export function studioPayoutsRouter(deps: AuthDeps): Router {
  const router = Router();

  router.get('/earnings', async (_req, res) => {
    res.json(await studioEarnings(deps.prisma, photographerLocals(res).photographerId, deps.now()));
  });

  router.get('/payouts/:id', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const payout = await studioPayout(deps.prisma, photographerLocals(res).photographerId, id, deps.now());
    if (payout === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ payout });
  });

  router.get('/payout-method', async (_req, res) => {
    const method = await currentPayoutMethod(deps.prisma, photographerLocals(res).photographerId);
    res.json({ payoutMethod: method === null ? null : payoutMethodView(method) });
  });

  router.put('/payout-method', async (req, res) => {
    const body = parseOrReject(methodBody, req.body, res);
    if (body === undefined) return;
    const { currentPassword: password, ...fields } = body;
    if (password === undefined || password === '') {
      res.status(403).json({ error: 'invalid_password' });
      return;
    }

    const { user, photographerId } = photographerLocals(res);
    const result = await changePayoutMethod(deps, { photographerId, user }, fields satisfies PayoutMethodInput, password);
    if (result.status !== 'ok') {
      res.status(403).json({ error: result.status });
      return;
    }
    res.json({ payoutMethod: payoutMethodView(result.method) });
  });

  return router;
}
