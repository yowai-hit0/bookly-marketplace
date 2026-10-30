import type { Prisma, PrismaClient } from '@prisma/client';
import { isUniqueViolation, sqlstateOf, SQLSTATE } from '../db/errors.js';
import { type AuditEntry, type AuditLog, type AuditRecord, logAudit, recordAudit } from './audit.js';

/**
 * The platform's categories (marketplace-spec.md R9.2; Phase 9 user decision 3,
 * 2026-10-27; marketplace-data-model.md §3.5): list every one, create, rename,
 * reorder, deactivate and reactivate, and delete one nobody uses.
 *
 * DEACTIVATING HIDES, IT DOES NOT UNTAG. A photographer keeps an inactive
 * category on their `photographer_category` rows, and every public reader
 * filters on `category.is_active` instead: the filter bar (`GET
 * /api/categories`), the directory's `category=` filter (an inactive slug is a
 * `422` exactly like an unknown one), the directory cards, the public profile,
 * and the studio's own profile and category picker, which cannot add it
 * either. The setup checklist counts active categories only, so a studio
 * tagged with inactive ones alone has that item undone (consistent with
 * "hidden"; photographers/setup.ts). Reactivating restores all of it, because
 * nothing was removed.
 *
 * THE SLUG IS IMMUTABLE. It is in every shared directory link
 * (`/photographers?category=<slug>`); renaming changes `name_en` only, and the
 * PATCH body has no `slug` key (an unknown key is a 400).
 *
 * DELETING is allowed only while no photographer has the category, whatever
 * their status: `category_in_use` with the count otherwise. The row is locked
 * `FOR UPDATE` before counting, so a studio save adding the category at the same
 * moment (which takes `FOR KEY SHARE` on the row through the foreign key) is
 * ordered against it: counted if it committed first, refused by the RESTRICT
 * foreign key if it comes after. A `23503` from the delete itself is mapped to
 * the same answer.
 *
 * ORDER. Create, reorder and delete take one advisory lock (`bookly.categories`),
 * so a new category always lands after the current last one and a reorder never
 * interleaves with either. A reorder must name exactly the full set, each once
 * (as the portfolio order does), and rewrites `sort_order` to 0..n-1.
 *
 * Every change writes its `platform_audit` row(s) in its own transaction and a
 * log line once it commits (R9.4; platform/audit.ts); a refusal or a request
 * that changes nothing writes none.
 */

/** CHECK category_slug_format; at most 64 characters, the directory query's own bound (routes/public-catalogue.ts). */
export const CATEGORY_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const CATEGORY_SLUG_MAX = 64;
/** A developer bound: a filter-bar label, counted in code points as PostgreSQL counts them. */
export const CATEGORY_NAME_MAX = 80;

export type CategoryDeps = { prisma: PrismaClient; now: () => Date; log?: AuditLog };

export type PlatformCategory = {
  id: string;
  slug: string;
  nameEn: string;
  isActive: boolean;
  sortOrder: number;
  /** Photographers tagged with it, of every status. Deleting needs this at 0. */
  photographerCount: number;
  createdAt: string;
  updatedAt: string;
};

const SELECT = {
  id: true,
  slug: true,
  nameEn: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { photographers: true } },
} satisfies Prisma.CategorySelect;

type CategoryRow = Prisma.CategoryGetPayload<{ select: typeof SELECT }>;

/** The platform's order, the public one: sort order, then name, then slug. */
const ORDER = [{ sortOrder: 'asc' }, { nameEn: 'asc' }, { slug: 'asc' }] satisfies Prisma.CategoryOrderByWithRelationInput[];

function view(row: CategoryRow): PlatformCategory {
  return {
    id: row.id,
    slug: row.slug,
    nameEn: row.nameEn,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    photographerCount: row._count.photographers,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every category, active and inactive, in the platform's order. */
export async function listPlatformCategories(db: PrismaClient | Prisma.TransactionClient): Promise<PlatformCategory[]> {
  return (await db.category.findMany({ select: SELECT, orderBy: ORDER })).map(view);
}

async function findCategory(db: PrismaClient | Prisma.TransactionClient, id: string): Promise<PlatformCategory | null> {
  const row = await db.category.findUnique({ where: { id }, select: SELECT });
  return row === null ? null : view(row);
}

async function lockCategories(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bookly.categories'))`;
}

/** Locks one category row; false when it names nothing. */
async function lockCategory(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM category WHERE id = ${id}::uuid FOR UPDATE`;
  return rows.length > 0;
}

// --- Create --------------------------------------------------------------------------------

export type CreateCategoryResult = { status: 'created'; category: PlatformCategory } | { status: 'slug_taken' };

/** A new active category, last in the order. A slug already used, by an active or an inactive one, is `slug_taken`. */
export async function createCategory(deps: CategoryDeps, input: { actorUserId: string; slug: string; nameEn: string }): Promise<CreateCategoryResult> {
  const now = deps.now();
  try {
    const outcome = await deps.prisma.$transaction(async (tx): Promise<{ id: string; audit: AuditRecord } | null> => {
      await lockCategories(tx);
      if ((await tx.category.count({ where: { slug: input.slug } })) > 0) return null;
      const last = await tx.category.aggregate({ _max: { sortOrder: true } });
      const sortOrder = last._max.sortOrder === null ? 0 : last._max.sortOrder + 1;
      const created = await tx.category.create({
        data: { slug: input.slug, nameEn: input.nameEn, sortOrder, isActive: true, createdAt: now, updatedAt: now },
        select: { id: true },
      });
      const audit = await recordAudit(tx, entry(input.actorUserId, 'category_created', created.id, { slug: input.slug, nameEn: input.nameEn, sortOrder }), now);
      return { id: created.id, audit };
    });
    if (outcome === null) return { status: 'slug_taken' };
    logAudit(deps.log, [outcome.audit]);
    const category = await findCategory(deps.prisma, outcome.id);
    if (category === null) throw new Error(`Category ${outcome.id} vanished after it was created`);
    return { status: 'created', category };
  } catch (error) {
    // category_slug_key: a create that slipped past the check (the lock rules it out; kept as the backstop).
    if (isUniqueViolation(error)) return { status: 'slug_taken' };
    throw error;
  }
}

// --- Rename, deactivate, reactivate ----------------------------------------------------------

export type UpdateCategoryResult = { status: 'ok'; category: PlatformCategory } | { status: 'not_found' };

/**
 * Renames, deactivates or reactivates (any of them, at once). The slug never
 * changes. A rename writes `category_updated` with the old and the new name; a
 * change of `isActive` writes `category_deactivated` or `category_reactivated`.
 * A field sent with the value already stored is no change and writes nothing.
 */
export async function updateCategory(
  deps: CategoryDeps,
  input: { actorUserId: string; id: string; nameEn?: string; isActive?: boolean },
): Promise<UpdateCategoryResult> {
  const now = deps.now();
  const records = await deps.prisma.$transaction(async (tx): Promise<AuditRecord[] | null> => {
    if (!(await lockCategory(tx, input.id))) return null;
    const before = await tx.category.findUniqueOrThrow({ where: { id: input.id }, select: SELECT });
    const rename = input.nameEn !== undefined && input.nameEn !== before.nameEn;
    const toggle = input.isActive !== undefined && input.isActive !== before.isActive;
    if (!rename && !toggle) return [];

    await tx.category.update({
      where: { id: input.id },
      data: { ...(rename ? { nameEn: input.nameEn } : {}), ...(toggle ? { isActive: input.isActive } : {}), updatedAt: now },
    });
    const written: AuditRecord[] = [];
    if (rename) {
      written.push(
        await recordAudit(tx, entry(input.actorUserId, 'category_updated', input.id, { slug: before.slug, nameEn: { before: before.nameEn, after: input.nameEn ?? null } }), now),
      );
    }
    if (toggle) {
      written.push(
        await recordAudit(
          tx,
          entry(input.actorUserId, input.isActive === true ? 'category_reactivated' : 'category_deactivated', input.id, {
            slug: before.slug,
            // The name as it stands after this save, so the Activity sentence can use it.
            nameEn: input.nameEn ?? before.nameEn,
            photographerCount: before._count.photographers,
          }),
          now,
        ),
      );
    }
    return written;
  });
  if (records === null) return { status: 'not_found' };
  logAudit(deps.log, records);
  const category = await findCategory(deps.prisma, input.id);
  return category === null ? { status: 'not_found' } : { status: 'ok', category };
}

// --- Reorder --------------------------------------------------------------------------------

export type ReorderCategoriesResult = { status: 'ok'; categories: PlatformCategory[] } | { status: 'invalid_ids' };

/**
 * Puts every category in the order given. `ids` must be exactly the full set,
 * each once (case-insensitively): a missing, extra, repeated or unknown id is
 * `invalid_ids` and changes nothing. The order already stored is no change.
 */
export async function reorderCategories(deps: CategoryDeps, input: { actorUserId: string; ids: readonly string[] }): Promise<ReorderCategoriesResult> {
  const now = deps.now();
  const ids = input.ids.map((id) => id.toLowerCase());
  const records = await deps.prisma.$transaction(async (tx): Promise<AuditRecord[] | null> => {
    await lockCategories(tx);
    const current = (await tx.category.findMany({ select: { id: true }, orderBy: ORDER })).map((row) => row.id);
    const distinct = new Set(ids);
    if (distinct.size !== ids.length || ids.length !== current.length || current.some((id) => !distinct.has(id))) return null;
    if (current.every((id, index) => ids[index] === id)) return [];

    await tx.$executeRaw`
      UPDATE category c
         SET sort_order = o.ord - 1, updated_at = ${now}::timestamptz
        FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS o(id, ord)
       WHERE c.id = o.id`;
    return [await recordAudit(tx, entry(input.actorUserId, 'category_reordered', null, { before: current, after: ids }), now)];
  });
  if (records === null) return { status: 'invalid_ids' };
  logAudit(deps.log, records);
  return { status: 'ok', categories: await listPlatformCategories(deps.prisma) };
}

// --- Delete ---------------------------------------------------------------------------------

export type DeleteCategoryResult = { status: 'deleted' } | { status: 'not_found' } | { status: 'in_use'; photographerCount: number };

/** Deletes a category no photographer has; `in_use` with the count otherwise, changing nothing. */
export async function deleteCategory(deps: CategoryDeps, input: { actorUserId: string; id: string }): Promise<DeleteCategoryResult> {
  const now = deps.now();
  let outcome: DeleteCategoryResult | { status: 'deleted'; audit: AuditRecord };
  try {
    outcome = await deps.prisma.$transaction(async (tx): Promise<DeleteCategoryResult | { status: 'deleted'; audit: AuditRecord }> => {
      await lockCategories(tx);
      if (!(await lockCategory(tx, input.id))) return { status: 'not_found' };
      const photographerCount = await tx.photographerCategory.count({ where: { categoryId: input.id } });
      if (photographerCount > 0) return { status: 'in_use', photographerCount };
      const deleted = await tx.category.delete({ where: { id: input.id }, select: { slug: true, nameEn: true } });
      return { status: 'deleted', audit: await recordAudit(tx, entry(input.actorUserId, 'category_deleted', input.id, { slug: deleted.slug, nameEn: deleted.nameEn }), now) };
    });
  } catch (error) {
    if (sqlstateOf(error) === SQLSTATE.FOREIGN_KEY_VIOLATION) {
      return { status: 'in_use', photographerCount: await deps.prisma.photographerCategory.count({ where: { categoryId: input.id } }) };
    }
    throw error;
  }
  if ('audit' in outcome) {
    logAudit(deps.log, [outcome.audit]);
    return { status: 'deleted' };
  }
  return outcome;
}

function entry(actorUserId: string, action: AuditEntry['action'], id: string | null, details: AuditEntry['details']): AuditEntry {
  return { actorUserId, action, target: { type: 'category', id }, photographerId: null, details };
}
