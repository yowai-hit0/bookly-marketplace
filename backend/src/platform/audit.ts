import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The platform's audit trail (marketplace-spec.md R9.4; Phase 9 user decision 1,
 * 2026-10-27; marketplace-data-model.md §3.15): one `platform_audit` row for
 * every platform admin action that CHANGED something, plus one structured log
 * line.
 *
 * The row is written by `recordAudit` inside the transaction that makes the
 * change, so the two commit or roll back together: a refused action (approve
 * as `409 not_submitted`, a duplicate transfer reference, a category in use)
 * and a failed one leave no row, and a committed one always has its row. An
 * idempotent repeat that changes nothing (approving an approved photographer,
 * a settings save of the values already stored) writes none either: the
 * trail records changes, not requests.
 *
 * The log line is written by `logAudit` AFTER the transaction commits, so it
 * never reports an action that rolled back. It names the actor's id, the
 * action, the target and the photographer: never an email address or a secret.
 *
 * `details` holds ids, statuses, amounts, references and reasons only. Never a
 * password, a token or its hash, a full payout account number, or a client's
 * personal data (name, address, phone): each caller builds its details from an
 * allowlist of fields, and the tests read the rows back to hold them to it.
 */

/** CHECK platform_audit_action_allowed. */
export const PLATFORM_AUDIT_ACTIONS = [
  'photographer_approved',
  'photographer_suspended',
  'photographer_reactivated',
  'payout_created',
  'payout_paid',
  'payout_cancelled',
  'refund_recorded',
  'settings_updated',
  'category_created',
  'category_updated',
  'category_reordered',
  'category_deactivated',
  'category_reactivated',
  'category_deleted',
] as const;
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

/** CHECK platform_audit_target_type_allowed. */
export const PLATFORM_AUDIT_TARGET_TYPES = ['photographer', 'payout', 'payment', 'platform_setting', 'category'] as const;
export type PlatformAuditTargetType = (typeof PLATFORM_AUDIT_TARGET_TYPES)[number];

/** A JSON object of ids, statuses, amounts, references and reasons. */
export type AuditDetails = Record<string, Prisma.InputJsonValue | null>;

export type AuditEntry = {
  actorUserId: string;
  action: PlatformAuditAction;
  target: { type: PlatformAuditTargetType; id: string | null };
  /** The photographer the action concerns, if any. */
  photographerId: string | null;
  details: AuditDetails;
};

export type AuditRecord = AuditEntry & { id: string; createdAt: Date };

export type AuditLog = (entry: Record<string, unknown>) => void;

/** Writes the row, in the caller's transaction, at the action's own instant. */
export async function recordAudit(tx: Prisma.TransactionClient, entry: AuditEntry, at: Date): Promise<AuditRecord> {
  const row = await tx.platformAudit.create({
    data: {
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.target.type,
      targetId: entry.target.id,
      photographerId: entry.photographerId,
      details: entry.details as Prisma.InputJsonObject,
      createdAt: at,
    },
    select: { id: true, createdAt: true },
  });
  return { ...entry, id: row.id, createdAt: row.createdAt };
}

/** The structured log line of a committed action: ids only, never an address or a secret. */
export function logAudit(log: AuditLog | undefined, records: readonly AuditRecord[]): void {
  for (const record of records) {
    (log ?? logLine)({
      level: 'info',
      event: 'platform_action',
      action: record.action,
      auditId: record.id,
      actorUserId: record.actorUserId,
      targetType: record.target.type,
      targetId: record.target.id,
      photographerId: record.photographerId,
      at: record.createdAt.toISOString(),
    });
  }
}

function logLine(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

// --- Reading it back: the Activity page and the photographer detail -------------------------

/** A fixed page size (Phase 9 P2): the Activity page pages through the trail 50 at a time. */
export const AUDIT_PAGE_SIZE = 50;
/** How many of a photographer's rows their detail page shows. */
export const PHOTOGRAPHER_ACTIVITY_LIMIT = 20;

export type AuditView = {
  id: string;
  action: string;
  /** The platform admin who acted: their id and login address, shown to other platform admins only. */
  actor: { id: string; email: string };
  target: { type: string | null; id: string | null };
  photographer: { id: string; handle: string; displayName: string } | null;
  details: Prisma.JsonValue;
  createdAt: string;
};

const AUDIT_SELECT = {
  id: true,
  action: true,
  targetType: true,
  targetId: true,
  details: true,
  createdAt: true,
  actor: { select: { id: true, email: true } },
  photographer: { select: { id: true, handle: true, displayName: true } },
} satisfies Prisma.PlatformAuditSelect;

type AuditRow = Prisma.PlatformAuditGetPayload<{ select: typeof AUDIT_SELECT }>;

function auditView(row: AuditRow): AuditView {
  return {
    id: row.id,
    action: row.action,
    actor: row.actor,
    target: { type: row.targetType, id: row.targetId },
    photographer: row.photographer,
    details: row.details,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Newest first; the id breaks a tie between rows written in one transaction, so a page boundary never moves. */
const NEWEST_FIRST = [{ createdAt: 'desc' }, { id: 'desc' }] satisfies Prisma.PlatformAuditOrderByWithRelationInput[];

export type AuditFilters = { action?: PlatformAuditAction; photographerId?: string };

export type AuditPage = { entries: AuditView[]; total: number; page: number; pageSize: number; pageCount: number };

/** One page of the trail, newest first. A page past the end is empty. */
export async function listAudit(prisma: PrismaClient, filters: AuditFilters, page: number): Promise<AuditPage> {
  const where: Prisma.PlatformAuditWhereInput = {
    ...(filters.action === undefined ? {} : { action: filters.action }),
    ...(filters.photographerId === undefined ? {} : { photographerId: filters.photographerId }),
  };
  const [total, rows] = await Promise.all([
    prisma.platformAudit.count({ where }),
    prisma.platformAudit.findMany({ where, select: AUDIT_SELECT, orderBy: NEWEST_FIRST, skip: (page - 1) * AUDIT_PAGE_SIZE, take: AUDIT_PAGE_SIZE }),
  ]);
  return { entries: rows.map(auditView), total, page, pageSize: AUDIT_PAGE_SIZE, pageCount: Math.ceil(total / AUDIT_PAGE_SIZE) };
}

/** A photographer's latest rows, newest first, for their detail page. */
export async function photographerActivity(prisma: PrismaClient, photographerId: string): Promise<AuditView[]> {
  const rows = await prisma.platformAudit.findMany({
    where: { photographerId },
    select: AUDIT_SELECT,
    orderBy: NEWEST_FIRST,
    take: PHOTOGRAPHER_ACTIVITY_LIMIT,
  });
  return rows.map(auditView);
}

