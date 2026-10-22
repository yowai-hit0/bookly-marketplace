import type { Prisma, PrismaClient } from '@prisma/client';
import { enqueue } from '../outbox/enqueue.js';
import { getPlatformSettings } from '../settings/index.js';
import { createTrialSubscription } from '../subscriptions/lifecycle.js';

/**
 * A platform admin's decisions about a photographer (Phase 2 decision 7,
 * pulled forward from marketplace-spec.md R9.1): list them, approve, suspend
 * with a reason, reactivate. Transport-free: `routes/platform.ts` maps these
 * results onto HTTP.
 *
 *   pending --approve--> approved --suspend--> suspended --reactivate--> approved
 *   pending --suspend--> suspended --reactivate--> pending (never approved)
 *
 * Every transition is ONE `UPDATE ... WHERE status IN (<from>)`. The status
 * guard is in the statement, not in a read before it, so two racing calls
 * cannot both make the change: PostgreSQL re-checks the WHERE clause against
 * the row the first one committed, and the second matches nothing. The loser
 * then reads the row and reports what it found -- the state it wanted already
 * (`changed: false`, idempotent, no second email) or a state it cannot move
 * from (`invalid_transition`).
 *
 * Who did it and when is recorded on the row where the data model has a
 * column for it (`approved_by_user_id`, `approved_at`, `suspended_at`,
 * `suspension_reason`) and, for every action, in the structured log (R9.4).
 *
 * Suspension keeps every existing booking (marketplace-spec.md decisions
 * table): it changes the status only, and `photographers/bookable.ts` stops
 * new bookings and hides the profile.
 *
 * Approval also starts the subscription and its free trial, in the same
 * transaction as the status change (marketplace-spec.md R5.1;
 * subscriptions/lifecycle.ts). A photographer who already has a subscription
 * keeps it and gets no second trial. Suspension and reactivation leave the
 * subscription alone: its clock keeps running, and reactivating restores
 * bookability only while the period still does.
 */

/** `photographer_status_allowed`. */
export const PHOTOGRAPHER_STATUSES = ['pending', 'approved', 'suspended'] as const;
export type PhotographerStatus = (typeof PHOTOGRAPHER_STATUSES)[number];

/** A photographer as the platform console lists them. Their login's email, never its credentials. */
export type PlatformPhotographer = {
  id: string;
  handle: string;
  displayName: string;
  email: string;
  status: string;
  createdAt: string;
  approvedAt: string | null;
  approvedByUserId: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
};

export type ModerationResult =
  | { status: 'ok'; changed: boolean; photographer: PlatformPhotographer }
  | { status: 'invalid_transition'; photographer: PlatformPhotographer }
  | { status: 'not_found' };

export type ModerationDeps = {
  prisma: PrismaClient;
  now: () => Date;
  /** The structured log (R9.4). Defaults to one JSON line on stdout. */
  log?: (entry: Record<string, unknown>) => void;
};

export type ModerationAction = { photographerId: string; adminUserId: string };

const SELECT = {
  id: true,
  handle: true,
  displayName: true,
  status: true,
  createdAt: true,
  approvedAt: true,
  approvedByUserId: true,
  suspendedAt: true,
  suspensionReason: true,
  user: { select: { email: true } },
} satisfies Prisma.PhotographerSelect;

type SelectedPhotographer = Prisma.PhotographerGetPayload<{ select: typeof SELECT }>;

/** Every photographer, or those in one status; the newest application first. */
export async function listPhotographers(prisma: PrismaClient, status?: PhotographerStatus): Promise<PlatformPhotographer[]> {
  const rows = await prisma.photographer.findMany({
    where: status === undefined ? {} : { status },
    select: SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map(toPlatformPhotographer);
}

/**
 * pending -> approved, recording who and when; starts the subscription and its
 * trial (R5.1), and emails `photographer_approved` with the trial's end.
 */
export function approvePhotographer(deps: ModerationDeps, action: ModerationAction): Promise<ModerationResult> {
  const now = deps.now();
  return transition(deps, action, now, 'approve', 'approved', async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE photographer
         SET status = 'approved', approved_at = ${now}::timestamptz, approved_by_user_id = ${action.adminUserId}::uuid,
             updated_at = ${now}::timestamptz
       WHERE id = ${action.photographerId}::uuid AND status = 'pending'
      RETURNING id`;
    if (rows.length === 0) return false;

    // After the photographer row (held by the UPDATE above): the lock order of
    // every subscription writer is photographer, then subscription (payments/webhooks.ts).
    const { trialDays } = await getPlatformSettings(tx);
    const subscription = await createTrialSubscription(tx, action.photographerId, now, trialDays);

    const photographer = await tx.photographer.findUniqueOrThrow({ where: { id: action.photographerId }, select: SELECT });
    await enqueue(tx, {
      kind: 'email',
      template: 'photographer_approved',
      recipient: photographer.user.email,
      photographerId: photographer.id,
      dedupeKey: `email:photographer_approved:${photographer.id}:${now.toISOString()}`,
      payload: {
        displayName: photographer.displayName,
        handle: photographer.handle,
        // The trial this approval started; none is promised to a photographer who already had one.
        ...(subscription.created ? { trialEndsAt: subscription.currentPeriodEndsAt.toISOString() } : {}),
      },
    });
    return true;
  });
}

/** pending or approved -> suspended with the admin's reason, and emails `photographer_suspended`. */
export function suspendPhotographer(deps: ModerationDeps, action: ModerationAction & { reason: string }): Promise<ModerationResult> {
  const now = deps.now();
  return transition(deps, action, now, 'suspend', 'suspended', async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE photographer
         SET status = 'suspended', suspended_at = ${now}::timestamptz, suspension_reason = ${action.reason},
             updated_at = ${now}::timestamptz
       WHERE id = ${action.photographerId}::uuid AND status IN ('pending', 'approved')
      RETURNING id`;
    if (rows.length === 0) return false;

    const photographer = await tx.photographer.findUniqueOrThrow({ where: { id: action.photographerId }, select: SELECT });
    await enqueue(tx, {
      kind: 'email',
      template: 'photographer_suspended',
      recipient: photographer.user.email,
      photographerId: photographer.id,
      dedupeKey: `email:photographer_suspended:${photographer.id}:${now.toISOString()}`,
      payload: { displayName: photographer.displayName, reason: action.reason },
    });
    return true;
  });
}

/**
 * suspended -> approved, or back to pending for a photographer who was
 * suspended before ever being approved: reactivating restores what the
 * suspension interrupted and approves nobody. The suspension's date and reason
 * are cleared from the row; the structured log keeps the history. No email:
 * no template exists for it yet.
 */
export function reactivatePhotographer(deps: ModerationDeps, action: ModerationAction): Promise<ModerationResult> {
  const now = deps.now();
  return transition(deps, action, now, 'reactivate', null, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE photographer
         SET status = CASE WHEN approved_at IS NULL THEN 'pending' ELSE 'approved' END,
             suspended_at = NULL, suspension_reason = NULL, updated_at = ${now}::timestamptz
       WHERE id = ${action.photographerId}::uuid AND status = 'suspended'
      RETURNING id`;
    return rows.length > 0;
  });
}

/**
 * Runs one guarded transition in a transaction and classifies a no-op.
 * `target` is the status a no-op counts as already done for; null means any
 * status but `suspended` (reactivating a photographer who is not suspended
 * changes nothing and is not an error).
 */
async function transition(
  deps: ModerationDeps,
  action: ModerationAction,
  now: Date,
  name: 'approve' | 'suspend' | 'reactivate',
  target: PhotographerStatus | null,
  apply: (tx: Prisma.TransactionClient) => Promise<boolean>,
): Promise<ModerationResult> {
  const changed = await deps.prisma.$transaction(apply);
  const row = await deps.prisma.photographer.findUnique({ where: { id: action.photographerId }, select: SELECT });
  if (row === null) return { status: 'not_found' };

  const photographer = toPlatformPhotographer(row);
  if (changed) {
    (deps.log ?? logLine)({
      level: 'info',
      event: `photographer_${name}`,
      photographerId: action.photographerId,
      byUserId: action.adminUserId,
      at: now.toISOString(),
      status: photographer.status,
    });
    return { status: 'ok', changed: true, photographer };
  }
  const alreadyDone = target === null ? photographer.status !== 'suspended' : photographer.status === target;
  return alreadyDone ? { status: 'ok', changed: false, photographer } : { status: 'invalid_transition', photographer };
}

function toPlatformPhotographer(row: SelectedPhotographer): PlatformPhotographer {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    email: row.user.email,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByUserId: row.approvedByUserId,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    suspensionReason: row.suspensionReason,
  };
}

function logLine(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}
