import { type Response, Router } from 'express';
import { z } from 'zod';
import type { AuthDeps } from '../auth/account-auth.js';
import { platformAdminLocals } from '../auth/middleware.js';
import { refundAmountRwf } from '../booking/totals.js';
import { recordRefund } from '../payments/refund.js';
import {
  PAYOUT_STATUSES,
  type PayoutActionResult,
  buildPayout,
  cancelPayout,
  findPayout,
  listPayouts,
  listRefundsDue,
  markPayoutPaid,
  payoutsDue,
} from '../payouts/payouts.js';
import { parseOrReject } from './validation.js';

/**
 * The platform's payouts and refunds (marketplace-spec.md R4.4, R4.6, T4.3,
 * T4.4; Phase 4 refund decision), mounted inside `platformRouter` behind
 * `requirePlatformAdmin`: a photographer's or a client's token is a 401 here.
 * The admin acting is the token's user, written on every row they change.
 *
 *   GET  /payouts/due                         200 { due }
 *   GET  /payouts?status=draft|paid|cancelled 200 { payouts }
 *   POST /payouts             { photographerId }
 *        201 { payout } | 404 | 409 no_payout_method | 409 draft_exists | 409 nothing_payable
 *   GET  /payouts/:id                         200 { payout } | 404
 *   POST /payouts/:id/mark-paid { transferReference, note? }
 *        200 { payout } | 404 | 409 not_draft | 409 duplicate_transfer_reference | 400 | 422
 *   POST /payouts/:id/cancel                  200 { payout } | 404 | 409 not_draft
 *   GET  /refunds                             200 { refunds }: full refunds and overpayment refunds
 *   POST /refunds/:paymentId  { reference, refundedAt?, refundKind? }
 *        200 { refund } | 404 | 409 cash_payment | 409 not_refundable | 409 duplicate_refund_reference
 *        | 409 refund_kind_mismatch | 400 | 422
 *        Records whichever refund is pending: a full one when the payment is
 *        `refund_due` (which wins if both could apply), else the overpaid part
 *        of a succeeded one, which stays `succeeded` (Phase 4 overpayment
 *        decision). `refundKind`, when sent, must be what is pending.
 */

const rowId = z.guid();
const NUL = String.fromCharCode(0);
const storableText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !value.includes(NUL), 'Contains a NUL character');

const listQuery = z.strictObject({ status: z.enum(PAYOUT_STATUSES).optional() });
const buildBody = z.strictObject({ photographerId: z.guid() });
/** Required and unique (R4.4, T4.3): a missing one is 400, an empty one 422. CHECKs payout_transfer_reference_length, payout_note_length. */
const markPaidBody = z.strictObject({
  transferReference: storableText(1, 100),
  note: storableText(1, 500)
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});
const refundBody = z.strictObject({
  /** The MoMo or bank reference the refund went out with (spec §6.16). */
  reference: storableText(1, 100),
  refundedAt: z.iso
    .datetime({ offset: true })
    .optional()
    .transform((value) => (value === undefined ? undefined : new Date(value))),
  /** The kind the admin means, from the list they acted on: refused if what is pending has changed since. */
  refundKind: z.enum(['full', 'overpayment']).optional(),
});

export function platformPayoutsRouter(deps: AuthDeps): Router {
  const router = Router();
  const payoutDeps = { prisma: deps.prisma, now: deps.now };

  // Before /payouts/:id, which would read `due` as an id.
  router.get('/payouts/due', async (_req, res) => {
    res.json({ due: await payoutsDue(deps.prisma, deps.now()) });
  });

  router.get('/payouts', async (req, res) => {
    const query = parseOrReject(listQuery, req.query, res);
    if (query === undefined) return;
    res.json({ payouts: await listPayouts(deps.prisma, deps.now(), query.status) });
  });

  router.post('/payouts', async (req, res) => {
    const body = parseOrReject(buildBody, req.body, res);
    if (body === undefined) return;
    const result = await buildPayout(payoutDeps, { photographerId: body.photographerId, adminUserId: platformAdminLocals(res).user.id });
    switch (result.status) {
      case 'created':
        res.status(201).json({ payout: result.payout });
        return;
      case 'not_found':
        res.status(404).json({ error: 'not_found' });
        return;
      case 'no_payout_method':
        res.status(409).json({ error: 'no_payout_method' });
        return;
      case 'draft_exists':
        res.status(409).json({ error: 'draft_exists', payoutId: result.payoutId });
        return;
      case 'nothing_payable':
        // Nothing is created; the balance carries forward to the next build (R4.4).
        res.status(409).json({ error: 'nothing_payable', payableRwf: result.payableRwf });
        return;
    }
  });

  router.get('/payouts/:id', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const payout = await findPayout(deps.prisma, id, deps.now());
    if (payout === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ payout });
  });

  router.post('/payouts/:id/mark-paid', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const body = parseOrReject(markPaidBody, req.body, res);
    if (body === undefined) return;
    sendAction(
      res,
      await markPayoutPaid(payoutDeps, { payoutId: id, adminUserId: platformAdminLocals(res).user.id, transferReference: body.transferReference, note: body.note }),
    );
  });

  router.post('/payouts/:id/cancel', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    sendAction(res, await cancelPayout(payoutDeps, { payoutId: id, adminUserId: platformAdminLocals(res).user.id }));
  });

  router.get('/refunds', async (_req, res) => {
    res.json({ refunds: await listRefundsDue(deps.prisma) });
  });

  router.post('/refunds/:paymentId', async (req, res) => {
    const id = parseOrReject(rowId, req.params.paymentId, res);
    if (id === undefined) return;
    const body = parseOrReject(refundBody, req.body, res);
    if (body === undefined) return;
    const result = await recordRefund(
      { prisma: deps.prisma, now: deps.now, actor: { area: 'platform', userId: platformAdminLocals(res).user.id } },
      id,
      {
        reference: body.reference,
        ...(body.refundedAt === undefined ? {} : { refundedAt: body.refundedAt }),
        ...(body.refundKind === undefined ? {} : { expectedKind: body.refundKind }),
      },
    );
    switch (result.status) {
      case 'not_found':
        res.status(404).json({ error: 'not_found' });
        return;
      case 'duplicate_refund_reference':
        res.status(409).json({ error: 'duplicate_refund_reference' });
        return;
      case 'refund_kind_mismatch':
        // What is pending now, so the console can show the admin the refund as it stands.
        res.status(409).json({ error: 'refund_kind_mismatch', pending: result.pending });
        return;
      case 'cash_payment':
        // Cash is the photographer's to give back and record.
        res.status(409).json({ error: 'cash_payment' });
        return;
      case 'not_refundable':
      case 'refund_with_platform':
        // Nothing owed back. (`refund_with_platform` is the studio's refusal and cannot arise here.)
        res.status(409).json({ error: 'not_refundable' });
        return;
      case 'recorded':
        break;
    }
    const { payment, refundKind } = result;
    const overpayment = refundKind === 'overpayment';
    res.json({
      refund: {
        paymentId: payment.id,
        kind: payment.kind,
        provider: payment.provider,
        amountRwf: payment.amountRwf,
        // `refunded` for a full refund; an overpayment refund leaves it `succeeded`.
        status: payment.status,
        refundKind,
        refundAmountRwf: overpayment ? payment.overpaidRwf : refundAmountRwf(payment),
        overpaidRwf: payment.overpaidRwf,
        refundedAt: (overpayment ? payment.overpaymentRefundedAt : payment.refundedAt)?.toISOString() ?? null,
        refundReference: overpayment ? payment.overpaymentRefundReference : payment.refundReference,
        refundedByUserId: overpayment ? payment.overpaymentRefundedByUserId : payment.refundedByUserId,
      },
    });
  });

  return router;
}

function sendAction(res: Response, result: PayoutActionResult): void {
  switch (result.status) {
    case 'ok':
      res.json({ payout: result.payout });
      return;
    case 'not_found':
      res.status(404).json({ error: 'not_found' });
      return;
    case 'not_draft':
      // The payout as it stands: paid or cancelled by someone else meanwhile.
      res.status(409).json({ error: 'not_draft', payout: result.payout });
      return;
    case 'duplicate_transfer_reference':
      res.status(409).json({ error: 'duplicate_transfer_reference' });
      return;
  }
}
