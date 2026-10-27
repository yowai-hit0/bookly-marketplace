import type { Prisma, PrismaClient } from '@prisma/client';
import { enqueue } from '../outbox/enqueue.js';
import { platformAdminRecipients } from '../outbox/recipients.js';

/**
 * The studio's setup checklist and its submission for review (marketplace-spec.md
 * R7.3, T7.1; Phase 7 user decision: approval requires a submission,
 * photographers/moderation.ts). Transport-free: `routes/studio-setup.ts` maps
 * these results onto HTTP.
 *
 * THE ITEMS, each decided from the photographer's rows as they are now:
 *
 *   profile        `display_name` and `bio` each hold a non-blank character.
 *                  The cover image and the contact details are optional: the
 *                  public profile shows each one only when set (R6.2).
 *   categories     at least one ACTIVE category: a deactivated one is shown
 *                  nowhere (catalogue/public.ts).
 *   districts      at least one district.
 *   payoutMethod   a current payout method (not retired; R4.1).
 *   services       at least one active service with at least one active
 *                  package: the directory's own rule for having something to
 *                  book (Phase 6 as built).
 *   workingHours   at least one open WEEKLY rule (`weekday` set, `is_open`). A
 *                  one-date override alone is not working hours: it opens one
 *                  day, and the directory would find the studio free on no other.
 *
 * `canSubmit` is true for a pending photographer who has not submitted yet and
 * whose every item is done: the button's state.
 *
 * SUBMITTING sets `submitted_at` once, in one guarded
 * `UPDATE ... WHERE status = 'pending' AND submitted_at IS NULL`, and in the
 * same transaction enqueues `photographer_application_received` (variant
 * `submitted`) to every platform admin, filed under no photographer like the
 * signup's, so a failure to deliver alerts the platform. Then:
 *
 *   - not pending (approved or suspended)   `not_pending`
 *   - already submitted                     idempotent: `changed: false`, the
 *                                           first `submitted_at` kept, no second
 *                                           email, the checklist not re-judged
 *   - an item not done                      `incomplete` with the missing items
 *                                           in checklist order (T7.1)
 *
 * Racing submissions: the guard lets one through; the other finds it done.
 *
 * EDITS AFTER SUBMITTING keep the submission (the Phase 7 design call): the
 * checklist's items live behind a dozen studio routes (catalogue, hours,
 * payout method, profile), a photographer goes on polishing a studio while it
 * waits, and the admin reviews the live studio at approval, not a snapshot of
 * it. Clearing the submission on every edit would re-queue the studio and
 * email the admins again for a typo. The checklist keeps showing every item's
 * live state, so an item undone after submitting is visible to both.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const SETUP_ITEMS = ['profile', 'categories', 'districts', 'payoutMethod', 'services', 'workingHours'] as const;
export type SetupItem = (typeof SETUP_ITEMS)[number];

export type SetupView = {
  /** Every item, in the order above. */
  items: { key: SetupItem; done: boolean }[];
  /** The items not done, in the same order. */
  missing: SetupItem[];
  status: string;
  /** When the studio was submitted for review; null until then. */
  submittedAt: string | null;
  canSubmit: boolean;
};

/** Holds at least one character that is not whitespace. */
function filled(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

/** The checklist as the photographer's rows stand. */
export async function setupChecklist(db: Db, photographerId: string): Promise<SetupView> {
  const photographer = await db.photographer.findUniqueOrThrow({
    where: { id: photographerId },
    select: {
      status: true,
      submittedAt: true,
      displayName: true,
      bio: true,
      _count: {
        select: {
          categories: { where: { category: { isActive: true } } },
          districts: true,
          payoutMethods: { where: { retiredAt: null } },
          services: { where: { isActive: true, packages: { some: { isActive: true } } } },
          workingHours: { where: { weekday: { not: null }, isOpen: true } },
        },
      },
    },
  });
  const counts = photographer._count;
  const done: Record<SetupItem, boolean> = {
    profile: filled(photographer.displayName) && filled(photographer.bio),
    categories: counts.categories > 0,
    districts: counts.districts > 0,
    payoutMethod: counts.payoutMethods > 0,
    services: counts.services > 0,
    workingHours: counts.workingHours > 0,
  };
  const missing = SETUP_ITEMS.filter((key) => !done[key]);
  return {
    items: SETUP_ITEMS.map((key) => ({ key, done: done[key] })),
    missing,
    status: photographer.status,
    submittedAt: photographer.submittedAt?.toISOString() ?? null,
    canSubmit: photographer.status === 'pending' && photographer.submittedAt === null && missing.length === 0,
  };
}

export type SubmitDeps = {
  prisma: PrismaClient;
  now: () => Date;
  /** The structured log (R9.4's pattern). Defaults to one JSON line on stdout. */
  log?: (entry: Record<string, unknown>) => void;
};

export type SubmitResult =
  | { status: 'ok'; changed: boolean; setup: SetupView }
  | { status: 'not_pending'; setup: SetupView }
  | { status: 'incomplete'; missing: SetupItem[] };

/** Submits the studio for review (module note). */
export async function submitForReview(deps: SubmitDeps, photographerId: string): Promise<SubmitResult> {
  const before = await setupChecklist(deps.prisma, photographerId);
  if (before.status !== 'pending') return { status: 'not_pending', setup: before };
  if (before.submittedAt !== null) return { status: 'ok', changed: false, setup: before };
  if (before.missing.length > 0) return { status: 'incomplete', missing: before.missing };

  const now = deps.now();
  const changed = await deps.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ handle: string; display_name: string; email: string }[]>`
      UPDATE photographer p
         SET submitted_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
        FROM app_user u
       WHERE p.id = ${photographerId}::uuid AND u.id = p.user_id AND p.status = 'pending' AND p.submitted_at IS NULL
      RETURNING p.handle, p.display_name, u.email`;
    const row = rows[0];
    if (row === undefined) return false;
    for (const admin of await platformAdminRecipients(tx)) {
      await enqueue(tx, {
        kind: 'email',
        template: 'photographer_application_received',
        recipient: admin.recipient,
        dedupeKey: `email:photographer_application_received:submitted:${photographerId}:${admin.userId}`,
        payload: { variant: 'submitted', displayName: row.display_name, handle: row.handle, email: row.email },
      });
    }
    return true;
  });

  const after = await setupChecklist(deps.prisma, photographerId);
  if (changed) {
    (deps.log ?? logLine)({ level: 'info', event: 'photographer_submit', photographerId, at: now.toISOString() });
    return { status: 'ok', changed: true, setup: after };
  }
  // Lost a race: to another submission (done, idempotent) or to a status change.
  if (after.status !== 'pending') return { status: 'not_pending', setup: after };
  return { status: 'ok', changed: false, setup: after };
}

function logLine(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}
