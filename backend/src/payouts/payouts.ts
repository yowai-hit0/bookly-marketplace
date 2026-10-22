import { Prisma, type PayoutMethod, type PrismaClient } from '@prisma/client';
import { refundAmountRwf } from '../booking/totals.js';
import { isUniqueViolation } from '../db/errors.js';
import { enqueue } from '../outbox/enqueue.js';
import { photographerRecipient } from '../outbox/recipients.js';
import { type RefundKind, pendingRefundKind } from '../payments/refund.js';
import { payableItems, payablePredicate, releaseDraftItems } from './ledger.js';
import { type PayoutMethodView, currentPayoutMethod, maskedDestination, payoutMethodView } from './method.js';

/**
 * Payouts (marketplace-spec.md R4.3-R4.5, T4.1-T4.4; marketplace-data-model.md
 * §3.9): what the studio's Earnings page reads, and the platform's flow --
 * payouts due, build a draft, transfer by hand outside the app, mark it paid
 * with the transfer reference, or cancel the draft.
 *
 * Every action takes the platform admin from the verified token and writes them
 * on the row: who built (`created_by_user_id`), who paid (`paid_by_user_id`),
 * who cancelled (`cancelled_by_user_id`) -- Security summary, money out.
 *
 * Concurrency. A build takes a per-photographer advisory lock, so two builds
 * for one photographer queue: the second sees the first's draft and is
 * `draft_exists` (`payout_one_draft` would refuse it anyway, and is mapped to
 * the same answer). The items it takes are locked `FOR UPDATE`, so a refund
 * landing at the same moment (payouts/ledger.ts `recordRefundDue`, which locks
 * the earning) is ordered against it: void before, reversal after. Mark-paid
 * and cancel lock the payout row and act only on a `draft`, so two of either,
 * or one of each, change it once. A transfer reference is unique
 * (`payout_transfer_reference_unique`), checked first and mapped from 23505.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type PayoutDeps = { prisma: PrismaClient; now: () => Date };

/** R4.1: a destination saved this recently is flagged on the platform's payout screen. */
export const METHOD_CHANGE_FLAG_HOURS = 72;
export const PAYOUT_STATUSES = ['draft', 'paid', 'cancelled'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

// --- Items --------------------------------------------------------------------------------

/**
 * Where an item stands, for the Earnings page (R4.5):
 *   pending   succeeded but not payable yet: a session fee whose shoot has not ended
 *   payable   payable now (§3.9), in no payout
 *   in_draft  in a payout being prepared
 *   paid      in a payout marked paid
 *   voided    refunded before any payout: it no longer counts
 */
export type PayoutItemState = 'pending' | 'payable' | 'in_draft' | 'paid' | 'voided';

export type PayoutItemView = {
  id: string;
  kind: 'earning' | 'reversal';
  amountRwf: number;
  state: PayoutItemState;
  payoutId: string | null;
  createdAt: string;
  voidedAt: string | null;
  payment: { id: string; kind: string; provider: string; status: string; amountRwf: number; settledAt: string | null };
  /** Each line is linked to its booking (R4.5). */
  booking: { id: string; reference: string; status: string; startsAt: string; endsAt: string };
};

type ItemRow = {
  id: string;
  kind: 'earning' | 'reversal';
  amount_rwf: number;
  state: PayoutItemState;
  payout_id: string | null;
  created_at: Date;
  voided_at: Date | null;
  payment_id: string;
  payment_kind: string;
  provider: string;
  payment_status: string;
  payment_amount_rwf: number;
  settled_at: Date | null;
  booking_id: string;
  reference: string;
  booking_status: string;
  starts_at: Date;
  ends_at: Date;
};

/** Items matching `where`, newest first, each with its state at `now`. */
async function itemRows(db: Db, where: Prisma.Sql, now: Date): Promise<ItemRow[]> {
  return db.$queryRaw<ItemRow[]>`
    SELECT pi.id::text AS id, pi.kind, pi.amount_rwf, pi.payout_id::text AS payout_id, pi.created_at, pi.voided_at,
           p.id::text AS payment_id, p.kind AS payment_kind, p.provider, p.status AS payment_status,
           p.amount_rwf AS payment_amount_rwf, p.settled_at,
           b.id::text AS booking_id, b.reference, b.status AS booking_status, b.starts_at, b.ends_at,
           CASE WHEN pi.voided_at IS NOT NULL THEN 'voided'
                WHEN po.status = 'paid' THEN 'paid'
                WHEN po.status = 'draft' THEN 'in_draft'
                WHEN ${payablePredicate(now)} THEN 'payable'
                ELSE 'pending' END AS state
      FROM payout_item pi
      JOIN payment p ON p.id = pi.payment_id
      JOIN booking b ON b.id = p.booking_id
      LEFT JOIN payout po ON po.id = pi.payout_id
     WHERE ${where}
     ORDER BY pi.created_at DESC, pi.id DESC`;
}

function itemView(row: ItemRow): PayoutItemView {
  return {
    id: row.id,
    kind: row.kind,
    amountRwf: row.amount_rwf,
    state: row.state,
    payoutId: row.payout_id,
    createdAt: row.created_at.toISOString(),
    voidedAt: row.voided_at?.toISOString() ?? null,
    payment: {
      id: row.payment_id,
      kind: row.payment_kind,
      provider: row.provider,
      status: row.payment_status,
      amountRwf: row.payment_amount_rwf,
      settledAt: row.settled_at?.toISOString() ?? null,
    },
    booking: { id: row.booking_id, reference: row.reference, status: row.booking_status, startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString() },
  };
}

// --- The studio's Earnings page (R4.5) --------------------------------------------------------

export type StudioPayoutSummary = {
  id: string;
  status: 'draft' | 'paid';
  amountRwf: number;
  itemCount: number;
  transferReference: string | null;
  createdAt: string;
  paidAt: string | null;
  payoutMethod: PayoutMethodView;
};

export type StudioEarnings = {
  totals: { pendingRwf: number; payableRwf: number; inDraftRwf: number; paidRwf: number };
  items: PayoutItemView[];
  /** The draft being prepared and every paid payout, newest first. A cancelled draft is the platform's business, not shown. */
  payouts: StudioPayoutSummary[];
};

/** Everything the Earnings page shows, scoped to the photographer the token names (R1.4, T4.4). */
export async function studioEarnings(prisma: PrismaClient, photographerId: string, now: Date): Promise<StudioEarnings> {
  const rows = await itemRows(prisma, Prisma.sql`pi.photographer_id = ${photographerId}::uuid`, now);
  const sum = (state: PayoutItemState) => rows.filter((row) => row.state === state).reduce((total, row) => total + row.amount_rwf, 0);
  const payouts = await prisma.payout.findMany({
    where: { photographerId, status: { in: ['draft', 'paid'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { payoutMethod: true, _count: { select: { items: true } } },
  });
  return {
    totals: { pendingRwf: sum('pending'), payableRwf: sum('payable'), inDraftRwf: sum('in_draft'), paidRwf: sum('paid') },
    items: rows.map(itemView),
    payouts: payouts.map((payout) => ({
      id: payout.id,
      status: payout.status as 'draft' | 'paid',
      amountRwf: payout.amountRwf,
      itemCount: payout._count.items,
      transferReference: payout.transferReference,
      createdAt: payout.createdAt.toISOString(),
      paidAt: payout.paidAt?.toISOString() ?? null,
      payoutMethod: payoutMethodView(payout.payoutMethod),
    })),
  };
}

/** One of the photographer's own payouts with its lines, or null -- for another photographer's too (404, T4.4). */
export async function studioPayout(
  prisma: PrismaClient,
  photographerId: string,
  payoutId: string,
  now: Date,
): Promise<(StudioPayoutSummary & { items: PayoutItemView[] }) | null> {
  const payout = await prisma.payout.findFirst({
    where: { id: payoutId, photographerId, status: { in: ['draft', 'paid'] } },
    include: { payoutMethod: true },
  });
  if (payout === null) return null;
  const items = (await itemRows(prisma, Prisma.sql`pi.payout_id = ${payout.id}::uuid AND pi.photographer_id = ${photographerId}::uuid`, now)).map(itemView);
  return {
    id: payout.id,
    status: payout.status as 'draft' | 'paid',
    amountRwf: payout.amountRwf,
    itemCount: items.length,
    transferReference: payout.transferReference,
    createdAt: payout.createdAt.toISOString(),
    paidAt: payout.paidAt?.toISOString() ?? null,
    payoutMethod: payoutMethodView(payout.payoutMethod),
    items,
  };
}

// --- The platform: payouts due (R4.4 step 1) ---------------------------------------------------

type PhotographerSummary = { id: string; handle: string; displayName: string; email: string; status: string };

export type PlatformPayoutMethodView = PayoutMethodView & { retiredAt: string | null };

export type PayoutDue = {
  photographer: PhotographerSummary;
  /** The §3.9 balance: > 0, or the photographer is not listed. */
  payableRwf: number;
  itemCount: number;
  payoutMethod: PlatformPayoutMethodView | null;
  /** The current method was saved within the last 72 hours (R4.1): check it before sending money. */
  methodChangedRecently: boolean;
  /** A draft already being prepared, which must be paid or cancelled before another is built. */
  draftPayoutId: string | null;
};

function platformMethodView(method: PayoutMethod): PlatformPayoutMethodView {
  return { ...payoutMethodView(method), retiredAt: method.retiredAt?.toISOString() ?? null };
}

function changedRecently(method: PayoutMethod | null, now: Date): boolean {
  return method !== null && now.getTime() - method.createdAt.getTime() < METHOD_CHANGE_FLAG_HOURS * 3_600_000;
}

const photographerSummarySelect = { id: true, handle: true, displayName: true, status: true, user: { select: { email: true } } } as const;

function photographerSummary(row: { id: string; handle: string; displayName: string; status: string; user: { email: string } }): PhotographerSummary {
  return { id: row.id, handle: row.handle, displayName: row.displayName, email: row.user.email, status: row.status };
}

/** Photographers with a payable balance above nought, largest first (R4.4 step 1). */
export async function payoutsDue(prisma: PrismaClient, now: Date): Promise<PayoutDue[]> {
  const balances = await prisma.$queryRaw<{ photographer_id: string; total: number; n: number }[]>`
    SELECT pi.photographer_id::text AS photographer_id, sum(pi.amount_rwf)::int AS total, count(*)::int AS n
      FROM payout_item pi
      JOIN payment p ON p.id = pi.payment_id
      LEFT JOIN booking b ON b.id = p.booking_id
     WHERE pi.payout_id IS NULL AND pi.voided_at IS NULL AND ${payablePredicate(now)}
     GROUP BY pi.photographer_id
    HAVING sum(pi.amount_rwf) > 0
     ORDER BY total DESC, photographer_id`;
  if (balances.length === 0) return [];
  const ids = balances.map((row) => row.photographer_id);
  const [photographers, methods, drafts] = await Promise.all([
    prisma.photographer.findMany({ where: { id: { in: ids } }, select: photographerSummarySelect }),
    prisma.payoutMethod.findMany({ where: { photographerId: { in: ids }, retiredAt: null } }),
    prisma.payout.findMany({ where: { photographerId: { in: ids }, status: 'draft' }, select: { id: true, photographerId: true } }),
  ]);
  return balances.flatMap((balance) => {
    const photographer = photographers.find((row) => row.id === balance.photographer_id);
    if (photographer === undefined) return [];
    const method = methods.find((row) => row.photographerId === balance.photographer_id) ?? null;
    return [
      {
        photographer: photographerSummary(photographer),
        payableRwf: balance.total,
        itemCount: balance.n,
        payoutMethod: method === null ? null : platformMethodView(method),
        methodChangedRecently: changedRecently(method, now),
        draftPayoutId: drafts.find((row) => row.photographerId === balance.photographer_id)?.id ?? null,
      },
    ];
  });
}

// --- The platform: one payout ------------------------------------------------------------------

type UserSummary = { id: string; email: string; fullName: string | null };

export type PlatformPayoutView = {
  id: string;
  status: PayoutStatus;
  amountRwf: number;
  itemCount: number;
  photographer: PhotographerSummary;
  /** The destination the draft was built for, which may since have been replaced. */
  payoutMethod: PlatformPayoutMethodView;
  /** False once the photographer has saved another destination: check before transferring. */
  payoutMethodIsCurrent: boolean;
  /** As of now, for the photographer's current method (R4.1). */
  methodChangedRecently: boolean;
  transferReference: string | null;
  note: string | null;
  createdAt: string;
  createdBy: UserSummary;
  paidAt: string | null;
  paidBy: UserSummary | null;
  cancelledAt: string | null;
  cancelledBy: UserSummary | null;
};

const userSelect = { id: true, email: true, fullName: true } as const;
const payoutInclude = {
  photographer: { select: photographerSummarySelect },
  payoutMethod: true,
  createdBy: { select: userSelect },
  paidBy: { select: userSelect },
  cancelledBy: { select: userSelect },
  _count: { select: { items: true } },
} satisfies Prisma.PayoutInclude;
type PayoutRecord = Prisma.PayoutGetPayload<{ include: typeof payoutInclude }>;

async function platformPayoutViews(db: Db, payouts: PayoutRecord[], now: Date): Promise<PlatformPayoutView[]> {
  const current = await db.payoutMethod.findMany({
    where: { photographerId: { in: [...new Set(payouts.map((payout) => payout.photographerId))] }, retiredAt: null },
  });
  return payouts.map((payout) => {
    const currentMethod = current.find((method) => method.photographerId === payout.photographerId) ?? null;
    return {
      id: payout.id,
      status: payout.status as PayoutStatus,
      amountRwf: payout.amountRwf,
      itemCount: payout._count.items,
      photographer: photographerSummary(payout.photographer),
      payoutMethod: platformMethodView(payout.payoutMethod),
      payoutMethodIsCurrent: payout.payoutMethod.retiredAt === null,
      methodChangedRecently: changedRecently(currentMethod, now),
      transferReference: payout.transferReference,
      note: payout.note,
      createdAt: payout.createdAt.toISOString(),
      createdBy: payout.createdBy,
      paidAt: payout.paidAt?.toISOString() ?? null,
      paidBy: payout.paidBy,
      cancelledAt: payout.cancelledAt?.toISOString() ?? null,
      cancelledBy: payout.cancelledBy,
    };
  });
}

export async function listPayouts(prisma: PrismaClient, now: Date, status?: PayoutStatus): Promise<PlatformPayoutView[]> {
  const payouts = await prisma.payout.findMany({
    where: status === undefined ? {} : { status },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: payoutInclude,
  });
  return platformPayoutViews(prisma, payouts, now);
}

export type PlatformPayoutDetail = PlatformPayoutView & { items: PayoutItemView[] };

/** A payout with its lines. A cancelled draft has none: cancelling released them. */
export async function findPayout(db: Db, payoutId: string, now: Date): Promise<PlatformPayoutDetail | null> {
  const payout = await db.payout.findUnique({ where: { id: payoutId }, include: payoutInclude });
  if (payout === null) return null;
  const [view] = await platformPayoutViews(db, [payout], now);
  if (view === undefined) return null;
  const items = (await itemRows(db, Prisma.sql`pi.payout_id = ${payout.id}::uuid`, now)).map(itemView);
  return { ...view, items };
}

// --- The platform: build a draft (R4.4 step 2) ------------------------------------------------

export type BuildPayoutResult =
  | { status: 'created'; payout: PlatformPayoutDetail }
  | { status: 'not_found' }
  /** No current payout method: nowhere to send it. */
  | { status: 'no_payout_method' }
  /** A draft is already being prepared for this photographer (T4.3). */
  | { status: 'draft_exists'; payoutId: string }
  /** The payable total is nought or less: nothing is created and the balance carries forward (R4.4). */
  | { status: 'nothing_payable'; payableRwf: number };

export async function buildPayout(deps: PayoutDeps, input: { photographerId: string; adminUserId: string }): Promise<BuildPayoutResult> {
  const now = deps.now();
  try {
    const outcome = await deps.prisma.$transaction(async (tx): Promise<Exclude<BuildPayoutResult, { status: 'created' }> | { status: 'created'; payoutId: string }> => {
      // Builds for one photographer queue here; another photographer's never wait.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bookly.payout_build:' || ${input.photographerId}::text))`;
      const photographer = await tx.photographer.findUnique({ where: { id: input.photographerId }, select: { id: true } });
      if (photographer === null) return { status: 'not_found' };

      const draft = await tx.payout.findFirst({ where: { photographerId: input.photographerId, status: 'draft' }, select: { id: true } });
      if (draft !== null) return { status: 'draft_exists', payoutId: draft.id };

      const method = await currentPayoutMethod(tx, input.photographerId);
      if (method === null) return { status: 'no_payout_method' };

      const items = await payableItems(tx, input.photographerId, now, { lock: true });
      const total = items.reduce((sum, item) => sum + item.amount_rwf, 0);
      if (total <= 0) return { status: 'nothing_payable', payableRwf: total };

      const payout = await tx.payout.create({
        data: { photographerId: input.photographerId, amountRwf: total, payoutMethodId: method.id, createdByUserId: input.adminUserId, createdAt: now },
      });
      const { count } = await tx.payoutItem.updateMany({
        where: { id: { in: items.map((item) => item.id) }, payoutId: null, voidedAt: null },
        data: { payoutId: payout.id },
      });
      // The rows are locked, so nothing can have taken one in between.
      if (count !== items.length) throw new Error(`Payout ${payout.id} took ${count} of ${items.length} locked items`);
      return { status: 'created', payoutId: payout.id };
    });
    if (outcome.status !== 'created') return outcome;
    const payout = await findPayout(deps.prisma, outcome.payoutId, now);
    if (payout === null) throw new Error(`Payout ${outcome.payoutId} vanished after it was built`);
    return { status: 'created', payout };
  } catch (error) {
    // payout_one_draft: a draft committed by a path outside the lock.
    if (isUniqueViolation(error)) {
      const draft = await deps.prisma.payout.findFirst({ where: { photographerId: input.photographerId, status: 'draft' }, select: { id: true } });
      if (draft !== null) return { status: 'draft_exists', payoutId: draft.id };
    }
    throw error;
  }
}

// --- The platform: mark paid (R4.4 step 4) ----------------------------------------------------

export type PayoutActionResult =
  | { status: 'ok'; payout: PlatformPayoutDetail }
  | { status: 'not_found' }
  /** Already paid or cancelled: only a draft can be (T4.3). */
  | { status: 'not_draft'; payout: PlatformPayoutDetail }
  /** The transfer reference is already recorded on another payout (T4.3). */
  | { status: 'duplicate_transfer_reference' };

export async function markPayoutPaid(
  deps: PayoutDeps,
  input: { payoutId: string; adminUserId: string; transferReference: string; note: string | null },
): Promise<PayoutActionResult> {
  const now = deps.now();
  let outcome: 'ok' | 'not_found' | 'not_draft' | 'duplicate_transfer_reference';
  try {
    outcome = await deps.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM payout WHERE id = ${input.payoutId}::uuid FOR UPDATE`;
      if (locked[0] === undefined) return 'not_found';
      if (locked[0].status !== 'draft') return 'not_draft';
      // Checked first so the usual case answers cleanly; a race between two
      // payouts is still refused by the unique index, mapped below.
      if ((await tx.payout.count({ where: { transferReference: input.transferReference } })) > 0) return 'duplicate_transfer_reference';

      const payout = await tx.payout.update({
        where: { id: input.payoutId },
        data: { status: 'paid', transferReference: input.transferReference, note: input.note, paidAt: now, paidByUserId: input.adminUserId },
        include: { payoutMethod: true, photographer: { select: { displayName: true } }, _count: { select: { items: true } } },
      });
      const recipient = await photographerRecipient(tx, payout.photographerId);
      if (recipient === null) throw new Error(`Payout ${payout.id} has no photographer to tell`);
      await enqueue(tx, {
        kind: 'email',
        template: 'payout_sent',
        ...recipient,
        dedupeKey: `email:payout_sent:${payout.id}`,
        payload: {
          displayName: payout.photographer.displayName,
          amountRwf: payout.amountRwf,
          transferReference: input.transferReference,
          paidAt: now.toISOString(),
          itemCount: payout._count.items,
          destination: maskedDestination(payout.payoutMethod),
        },
      });
      return 'ok';
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: 'duplicate_transfer_reference' };
    throw error;
  }
  return answerAction(deps, input.payoutId, outcome, now);
}

// --- The platform: cancel a draft --------------------------------------------------------------

export async function cancelPayout(deps: PayoutDeps, input: { payoutId: string; adminUserId: string }): Promise<PayoutActionResult> {
  const now = deps.now();
  const outcome = await deps.prisma.$transaction(async (tx): Promise<'ok' | 'not_found' | 'not_draft'> => {
    const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM payout WHERE id = ${input.payoutId}::uuid FOR UPDATE`;
    if (locked[0] === undefined) return 'not_found';
    if (locked[0].status !== 'draft') return 'not_draft';
    // Its items return to the photographer's balance (§3.9), and carry forward.
    await releaseDraftItems(tx, input.payoutId, now);
    await tx.payout.update({ where: { id: input.payoutId }, data: { status: 'cancelled', cancelledAt: now, cancelledByUserId: input.adminUserId } });
    return 'ok';
  });
  return answerAction(deps, input.payoutId, outcome, now);
}

async function answerAction(
  deps: PayoutDeps,
  payoutId: string,
  outcome: 'ok' | 'not_found' | 'not_draft' | 'duplicate_transfer_reference',
  now: Date,
): Promise<PayoutActionResult> {
  if (outcome === 'not_found' || outcome === 'duplicate_transfer_reference') return { status: outcome };
  const payout = await findPayout(deps.prisma, payoutId, now);
  if (payout === null) return { status: 'not_found' };
  return outcome === 'ok' ? { status: 'ok', payout } : { status: 'not_draft', payout };
}

// --- The platform: refunds of money paid online (R4.6) ---------------------------------------

export type RefundDueView = {
  paymentId: string;
  kind: string;
  provider: string;
  method: string | null;
  amountRwf: number;
  ourRef: string;
  providerRef: string | null;
  settledAt: string | null;
  /** `full`: the payment is `refund_due`. `overpayment`: it succeeded, and its overpaid part goes back (Phase 4 overpayment decision). */
  refundKind: RefundKind;
  /**
   * What to send back. A full refund is the whole amount, less an overpaid part
   * already returned (`refundAmountRwf`, booking/totals.ts); an overpayment is
   * the overpaid part.
   */
  refundAmountRwf: number;
  /** The payment's overpaid part, refunded or not; 0 when it was not overpaid. */
  overpaidRwf: number;
  booking: { id: string; reference: string; status: string; startsAt: string; contactName: string; contactEmail: string; contactPhone: string };
  photographer: { id: string; handle: string; displayName: string };
};

/**
 * Every refund of money paid online the platform has still to send, oldest
 * first: the money is in the platform's account, so the platform refunds it
 * (Phase 4 refund and overpayment decisions). Two kinds:
 *
 *   full         a payment flagged `refund_due`
 *   overpayment  a succeeded session fee with an overpaid part not yet sent back
 *
 * A payment is listed once. A full refund covers its overpaid part, so a
 * payment that became `refund_due` after overpaying is listed only as `full`
 * (`pendingRefundKind`). Cash is the photographer's to give back and is not
 * listed.
 */
export async function listRefundsDue(prisma: PrismaClient): Promise<RefundDueView[]> {
  const payments = await prisma.payment.findMany({
    where: {
      provider: { not: 'cash' },
      OR: [{ status: 'refund_due' }, { status: 'succeeded', overpaidRwf: { gt: 0 }, overpaymentRefundedAt: null }],
    },
    orderBy: [{ settledAt: 'asc' }, { id: 'asc' }],
    include: { booking: { include: { photographer: { select: { id: true, handle: true, displayName: true } } } } },
  });
  return payments.flatMap((payment) => {
    const refundKind = pendingRefundKind(payment);
    if (refundKind === null) return [];
    return [
      {
        paymentId: payment.id,
        kind: payment.kind,
        provider: payment.provider,
        method: payment.method,
        amountRwf: payment.amountRwf,
        ourRef: payment.ourRef,
        providerRef: payment.providerRef,
        settledAt: payment.settledAt?.toISOString() ?? null,
        refundKind,
        refundAmountRwf: refundKind === 'full' ? refundAmountRwf(payment) : payment.overpaidRwf,
        overpaidRwf: payment.overpaidRwf,
        booking: {
          id: payment.booking.id,
          reference: payment.booking.reference,
          status: payment.booking.status,
          startsAt: payment.booking.startsAt.toISOString(),
          contactName: payment.booking.contactName,
          contactEmail: payment.booking.contactEmail,
          contactPhone: payment.booking.contactPhone,
        },
        photographer: payment.booking.photographer,
      },
    ];
  });
}
