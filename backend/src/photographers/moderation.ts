import type { Prisma, PrismaClient } from '@prisma/client';
import { enqueue } from '../outbox/enqueue.js';
import { type AuditDetails, type AuditRecord, type PlatformAuditAction, logAudit, recordAudit } from '../platform/audit.js';
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
 * `suspension_reason`) and, for every action that changed something, in a
 * `platform_audit` row written in the same transaction and a structured log
 * line after it commits (R9.4, Phase 9; platform/audit.ts). A no-op and a
 * refusal (`not_submitted`, `invalid_transition`) write neither.
 *
 * Suspension keeps every existing booking (marketplace-spec.md decisions
 * table): it changes the status only, and `photographers/bookable.ts` stops
 * new bookings and hides the profile.
 *
 * Approval requires a submission (user decision, Phase 7; marketplace-spec.md
 * R7.3): a pending photographer who has not submitted their studio for review
 * from the setup checklist (`submitted_at` null; photographers/setup.ts) is
 * refused as `not_submitted`. The guard is in the approval's own UPDATE, like
 * the status guard, so a submission and an approval racing each other cannot
 * approve a studio that was never submitted.
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
  /** When the studio was submitted for review from the setup checklist (R7.3); null while still setting up. */
  submittedAt: string | null;
  /**
   * The handle's latest change after the studio was submitted and before approval
   * (user decision 2026-10-27; photographers/profile.ts); null if none. Kept after
   * approval, when the handle is locked.
   */
  handleChangedAt: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
};

export type ModerationResult =
  | { status: 'ok'; changed: boolean; photographer: PlatformPhotographer }
  | { status: 'invalid_transition'; photographer: PlatformPhotographer }
  /** Approving a pending photographer who has not submitted for review (user decision, Phase 7). */
  | { status: 'not_submitted'; photographer: PlatformPhotographer }
  | { status: 'not_found' };

export type ModerationDeps = {
  prisma: PrismaClient;
  now: () => Date;
  /** The structured log (R9.4; platform/audit.ts `logAudit`). Defaults to one JSON line on stdout. */
  log?: (entry: Record<string, unknown>) => void;
};

export type ModerationAction = { photographerId: string; adminUserId: string };

const SELECT = {
  id: true,
  handle: true,
  displayName: true,
  status: true,
  createdAt: true,
  submittedAt: true,
  handleChangedAt: true,
  approvedAt: true,
  approvedByUserId: true,
  suspendedAt: true,
  suspensionReason: true,
  user: { select: { email: true } },
} satisfies Prisma.PhotographerSelect;

type SelectedPhotographer = Prisma.PhotographerGetPayload<{ select: typeof SELECT }>;

/**
 * Where a pending photographer is in onboarding (Phase 7 user decision; R7.3):
 *
 *   awaiting     pending AND submitted for review (`submitted_at` set): the
 *                platform's queue, the only pending photographers approval accepts
 *   setting_up   pending AND not submitted yet: still working through the checklist
 *
 * A filter of its own rather than two more values of `status`: `status` is the
 * column's vocabulary (`photographer_status_allowed`), and every row's `status`
 * field is one of those three values; a `status=awaiting` that no row ever
 * carries would make the filter and the field disagree. Both imply `pending`,
 * and filters combine with AND, so `status=approved&review=awaiting` is an
 * honest empty list.
 */
export const REVIEW_FILTERS = ['awaiting', 'setting_up'] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

export type PhotographerListFilters = { status?: PhotographerStatus; review?: ReviewFilter };

/** Every photographer, or those matching the filters; the newest application first. */
export async function listPhotographers(prisma: PrismaClient, filters: PhotographerListFilters = {}): Promise<PlatformPhotographer[]> {
  const review: Prisma.PhotographerWhereInput =
    filters.review === undefined ? {} : { status: 'pending', submittedAt: filters.review === 'awaiting' ? { not: null } : null };
  const rows = await prisma.photographer.findMany({
    where: { AND: [filters.status === undefined ? {} : { status: filters.status }, review] },
    select: SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map(toPlatformPhotographer);
}

/** One photographer as the console lists them, or null for an id that names nobody. */
export async function findPlatformPhotographer(prisma: PrismaClient, photographerId: string): Promise<PlatformPhotographer | null> {
  const row = await prisma.photographer.findUnique({ where: { id: photographerId }, select: SELECT });
  return row === null ? null : toPlatformPhotographer(row);
}

/**
 * pending -> approved, recording who and when; starts the subscription and its
 * trial (R5.1), and emails `photographer_approved` with the trial's end. Only a
 * photographer who has submitted for review (Phase 7 user decision): a pending
 * one who has not is `not_submitted`, changed in nothing.
 */
export function approvePhotographer(deps: ModerationDeps, action: ModerationAction): Promise<ModerationResult> {
  const now = deps.now();
  return transition(deps, action, now, 'approve', 'approved', async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE photographer
         SET status = 'approved', approved_at = ${now}::timestamptz, approved_by_user_id = ${action.adminUserId}::uuid,
             updated_at = ${now}::timestamptz
       WHERE id = ${action.photographerId}::uuid AND status = 'pending' AND submitted_at IS NOT NULL
      RETURNING id`;
    if (rows.length === 0) return null;

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
    return {
      status: 'approved',
      trialStarted: subscription.created,
      trialEndsAt: subscription.created ? subscription.currentPeriodEndsAt.toISOString() : null,
    };
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
    if (rows.length === 0) return null;

    const photographer = await tx.photographer.findUniqueOrThrow({ where: { id: action.photographerId }, select: SELECT });
    await enqueue(tx, {
      kind: 'email',
      template: 'photographer_suspended',
      recipient: photographer.user.email,
      photographerId: photographer.id,
      dedupeKey: `email:photographer_suspended:${photographer.id}:${now.toISOString()}`,
      payload: { displayName: photographer.displayName, reason: action.reason },
    });
    return { status: 'suspended', reason: action.reason };
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
    const rows = await tx.$queryRaw<{ status: string }[]>`
      UPDATE photographer
         SET status = CASE WHEN approved_at IS NULL THEN 'pending' ELSE 'approved' END,
             suspended_at = NULL, suspension_reason = NULL, updated_at = ${now}::timestamptz
       WHERE id = ${action.photographerId}::uuid AND status = 'suspended'
      RETURNING status`;
    const row = rows[0];
    return row === undefined ? null : { status: row.status };
  });
}

const AUDIT_ACTIONS: Record<'approve' | 'suspend' | 'reactivate', PlatformAuditAction> = {
  approve: 'photographer_approved',
  suspend: 'photographer_suspended',
  reactivate: 'photographer_reactivated',
};

/**
 * Runs one guarded transition in a transaction and classifies a no-op.
 * `apply` answers the audit row's details when it changed the photographer, or
 * null when its guarded UPDATE matched nothing; the audit row is written in the
 * same transaction, so a no-op or a refusal writes none.
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
  apply: (tx: Prisma.TransactionClient) => Promise<AuditDetails | null>,
): Promise<ModerationResult> {
  const audit: AuditRecord | null = await deps.prisma.$transaction(async (tx) => {
    const details = await apply(tx);
    if (details === null) return null;
    return recordAudit(
      tx,
      {
        actorUserId: action.adminUserId,
        action: AUDIT_ACTIONS[name],
        target: { type: 'photographer', id: action.photographerId },
        photographerId: action.photographerId,
        details,
      },
      now,
    );
  });
  const row = await deps.prisma.photographer.findUnique({ where: { id: action.photographerId }, select: SELECT });
  if (row === null) return { status: 'not_found' };

  const photographer = toPlatformPhotographer(row);
  if (audit !== null) {
    logAudit(deps.log, [audit]);
    return { status: 'ok', changed: true, photographer };
  }
  const alreadyDone = target === null ? photographer.status !== 'suspended' : photographer.status === target;
  if (alreadyDone) return { status: 'ok', changed: false, photographer };
  // Only approval has a precondition beyond the status: the submission.
  if (name === 'approve' && photographer.status === 'pending' && photographer.submittedAt === null) return { status: 'not_submitted', photographer };
  return { status: 'invalid_transition', photographer };
}

function toPlatformPhotographer(row: SelectedPhotographer): PlatformPhotographer {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    email: row.user.email,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    handleChangedAt: row.handleChangedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByUserId: row.approvedByUserId,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    suspensionReason: row.suspensionReason,
  };
}
