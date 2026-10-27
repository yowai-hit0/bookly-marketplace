import type { Prisma, PrismaClient } from '@prisma/client';
import type { PublicCategory, PublicDistrict } from '../catalogue/directory.js';
import { SQLSTATE, sqlstateOf } from '../db/errors.js';
import { enqueue } from '../outbox/enqueue.js';
import { platformAdminRecipients } from '../outbox/recipients.js';
import { isReservedHandle } from './handle.js';

/**
 * The photographer's own profile, as the studio's Profile page edits it
 * (marketplace-spec.md R7.2; marketplace-data-model.md §3.3-§3.5): the handle,
 * the name and bio, the public contact details, the cover image, where they
 * work and what they shoot. Transport-free: `routes/studio-profile.ts` validates
 * the request and maps these results onto HTTP. Every read and write is
 * addressed by the token's photographer (R1.4).
 *
 * THE HANDLE is editable only before approval (R7.2): once a photographer has
 * ever been approved (`approved_at` set, so a suspension afterwards changes
 * nothing) their `/p/<handle>` has been public, in the directory, the sitemap
 * and every link a client was sent, and a change is `handle_locked`. Before
 * that, the signup's rules apply: the CHECK's format (the route), the reserved
 * names and someone else's handle are `handle_taken`. Sending the handle one
 * already has is never a change, so a form that posts every field back works
 * after approval too. The photographer row is locked `FOR UPDATE` first, so an
 * approval committing meanwhile is waited for and then seen.
 *
 * A HANDLE CHANGED AFTER SUBMITTING (user decision 2026-10-27): the handle is
 * the one profile detail the platform treats as crucial, being the address
 * approval fixes for good. A change while the studio is pending AND submitted
 * for review (`submitted_at` set) still saves, and in the same transaction
 * sets `handle_changed_at` to the save's time (the console's "changed since
 * submission") and enqueues `photographer_application_received` (variant
 * `handle_changed`, the old and the new handle) to every platform admin, filed
 * under no photographer like the submission's. One email per admin per change:
 * the key names the photographer, the new handle, the moment and the admin, so
 * a retried enqueue is a duplicate while a later change is a new message.
 * Before submission a change sets and sends nothing; a refused change
 * (`handle_taken`, `handle_locked`, an unknown district) rolls everything back.
 * Every other field stays free to edit after submitting, with no alert.
 *
 * DISTRICTS AND CATEGORIES replace the whole set. Districts are codes of the 30
 * the migration inserted. Categories are slugs of ACTIVE categories: the only
 * ones the editor is offered (`GET /api/categories`) and the only ones the
 * public sees. A category the platform has since deactivated stays assigned and
 * untouched by a replace -- the photographer cannot see or choose it, and it
 * comes back if the platform reactivates it -- and is not shown here.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type StudioProfile = {
  handle: string;
  /** False once the photographer has ever been approved (R7.2): the handle is read-only. */
  handleEditable: boolean;
  displayName: string;
  bio: string | null;
  contactPhone: string | null;
  whatsappPhone: string | null;
  /** The public contact address, never the login. */
  contactEmail: string | null;
  coverImageUrl: string | null;
  /** In the migration's order. */
  districts: PublicDistrict[];
  /** Active only, in the platform's order. */
  categories: PublicCategory[];
  status: string;
  /** When the studio was submitted for review (R7.3); null until then. While pending, a handle change then alerts the platform. */
  submittedAt: string | null;
};

/** What a PATCH may change; every key optional, null clearing an optional field. */
export type StudioProfileUpdate = {
  handle?: string;
  displayName?: string;
  bio?: string | null;
  contactPhone?: string | null;
  whatsappPhone?: string | null;
  contactEmail?: string | null;
  coverImageUrl?: string | null;
  districts?: string[];
  categories?: string[];
};

export type StudioProfileUpdateResult =
  | { status: 'ok'; profile: StudioProfile }
  /** Reserved, or another photographer's (409). */
  | { status: 'handle_taken' }
  /** A different handle after approval (409; R7.2). */
  | { status: 'handle_locked' }
  /** A district code or category slug that names nothing (active): 422 naming the field. */
  | { status: 'unknown'; fields: ('districts' | 'categories')[] };

const PROFILE_SELECT = {
  handle: true,
  approvedAt: true,
  displayName: true,
  bio: true,
  contactPhone: true,
  whatsappPhone: true,
  contactEmail: true,
  coverImageUrl: true,
  status: true,
  submittedAt: true,
} satisfies Prisma.PhotographerSelect;

/** The signed-in photographer's profile. */
export async function studioProfile(db: Db, photographerId: string): Promise<StudioProfile> {
  const [photographer, districts, categories] = await Promise.all([
    db.photographer.findUniqueOrThrow({ where: { id: photographerId }, select: PROFILE_SELECT }),
    db.photographerDistrict.findMany({
      where: { photographerId },
      select: { district: { select: { code: true, name: true } } },
      orderBy: [{ district: { sortOrder: 'asc' } }, { districtCode: 'asc' }],
    }),
    db.photographerCategory.findMany({
      where: { photographerId, category: { isActive: true } },
      select: { category: { select: { slug: true, nameEn: true } } },
      orderBy: [{ category: { sortOrder: 'asc' } }, { category: { nameEn: 'asc' } }, { category: { slug: 'asc' } }],
    }),
  ]);
  const { approvedAt, submittedAt, ...fields } = photographer;
  return {
    ...fields,
    submittedAt: submittedAt?.toISOString() ?? null,
    handleEditable: approvedAt === null,
    districts: districts.map((entry) => ({ code: entry.district.code, name: entry.district.name })),
    categories: categories.map((entry) => ({ slug: entry.category.slug, name: entry.category.nameEn })),
  };
}

/**
 * Applies a validated update in one transaction, or changes nothing. The
 * district and category names are checked first (422), then the handle (409).
 * `updated_at` moves on every save, so the sitemap's `lastmod` (R6.6) follows a
 * change of districts or categories too.
 */
export async function updateStudioProfile(
  prisma: PrismaClient,
  photographerId: string,
  update: StudioProfileUpdate,
  now: Date,
): Promise<StudioProfileUpdateResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ handle: string; approved: boolean; under_review: boolean }[]>`
        SELECT handle, approved_at IS NOT NULL AS approved, (status = 'pending' AND submitted_at IS NOT NULL) AS under_review
          FROM photographer WHERE id = ${photographerId}::uuid FOR UPDATE`;
      const current = locked[0];
      if (current === undefined) throw new Error(`photographer ${photographerId} does not exist`);

      const unknown: ('districts' | 'categories')[] = [];
      if (update.districts !== undefined && (await tx.district.count({ where: { code: { in: update.districts } } })) !== update.districts.length) {
        unknown.push('districts');
      }
      let categoryIds: string[] = [];
      if (update.categories !== undefined) {
        const found = await tx.category.findMany({ where: { slug: { in: update.categories }, isActive: true }, select: { id: true } });
        if (found.length !== update.categories.length) unknown.push('categories');
        categoryIds = found.map((category) => category.id);
      }
      if (unknown.length > 0) return { status: 'unknown', fields: unknown };

      const { handle, districts, categories, ...columns } = update;
      const changesHandle = handle !== undefined && handle !== current.handle;
      if (changesHandle) {
        if (current.approved) return { status: 'handle_locked' };
        if (isReservedHandle(handle)) return { status: 'handle_taken' };
        if ((await tx.photographer.findUnique({ where: { handle }, select: { id: true } })) !== null) return { status: 'handle_taken' };
      }

      // Changed while waiting on review: flag the row and tell the platform (module note).
      const alerts = changesHandle && current.under_review;
      const saved = await tx.photographer.update({
        where: { id: photographerId },
        data: { ...columns, ...(changesHandle ? { handle } : {}), ...(alerts ? { handleChangedAt: now } : {}), updatedAt: now },
        select: { handle: true, displayName: true, user: { select: { email: true } } },
      });
      if (alerts) {
        for (const admin of await platformAdminRecipients(tx)) {
          await enqueue(tx, {
            kind: 'email',
            template: 'photographer_application_received',
            recipient: admin.recipient,
            dedupeKey: `email:photographer_application_received:handle_changed:${photographerId}:${saved.handle}:${now.toISOString()}:${admin.userId}`,
            payload: {
              variant: 'handle_changed',
              displayName: saved.displayName,
              handle: saved.handle,
              previousHandle: current.handle,
              email: saved.user.email,
            },
          });
        }
      }
      if (districts !== undefined) {
        await tx.photographerDistrict.deleteMany({ where: { photographerId } });
        await tx.photographerDistrict.createMany({ data: districts.map((districtCode) => ({ photographerId, districtCode })) });
      }
      if (categories !== undefined) {
        // Active ones only: a deactivated assignment is kept (module note).
        await tx.photographerCategory.deleteMany({ where: { photographerId, category: { isActive: true } } });
        await tx.photographerCategory.createMany({ data: categoryIds.map((categoryId) => ({ photographerId, categoryId })) });
      }
      return { status: 'ok', profile: await studioProfile(tx, photographerId) };
    });
  } catch (error) {
    // Two photographers racing for one free handle: the second's UPDATE hits the
    // unique index and its whole transaction rolls back. The join tables cannot
    // raise one (their rows were deleted first, and the route refuses repeats),
    // so a unique violation is the handle -- which by now is taken.
    if (sqlstateOf(error) === SQLSTATE.UNIQUE_VIOLATION) return { status: 'handle_taken' };
    throw error;
  }
}
