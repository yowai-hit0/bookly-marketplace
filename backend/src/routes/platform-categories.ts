import { Router } from 'express';
import { z } from 'zod';
import type { AuthDeps } from '../auth/account-auth.js';
import { platformAdminLocals } from '../auth/middleware.js';
import type { AuditLog } from '../platform/audit.js';
import {
  CATEGORY_NAME_MAX,
  CATEGORY_SLUG,
  CATEGORY_SLUG_MAX,
  createCategory,
  deleteCategory,
  listPlatformCategories,
  reorderCategories,
  updateCategory,
} from '../platform/categories.js';
import { parseOrReject } from './validation.js';

/**
 * The platform's categories (marketplace-spec.md R9.2; Phase 9 decision 3;
 * platform/categories.ts), mounted inside `platformRouter` behind
 * `requirePlatformAdmin`.
 *
 *   GET    /categories              200 { categories }: every one, active and
 *                                   inactive, in order, with photographerCount
 *   POST   /categories { slug, nameEn }
 *                                   201 { category } | 409 slug_taken | 400 | 422
 *   PATCH  /categories/:id { nameEn?, isActive? }
 *                                   200 { category } | 404 | 400 | 422
 *                                   The slug is immutable: a `slug` key is a 400.
 *   PUT    /categories/order { ids } 200 { categories } | 422 { fields: ['ids'] } | 400
 *   DELETE /categories/:id          204 | 404 | 409 category_in_use { photographerCount }
 *
 * Validation follows the admin rule (routes/validation.ts): a wrong type, an
 * unknown key, a slug or an id of the wrong form is 400; a blank or long name,
 * a long slug, and a reorder that is not exactly the full set are 422. The name
 * is trimmed and counted in code points, as PostgreSQL counts text; NUL is
 * refused.
 */

const NUL = String.fromCharCode(0);

const categoryName = z
  .string()
  .trim()
  .refine((value) => value.length > 0, 'Required')
  .refine((value) => [...value].length <= CATEGORY_NAME_MAX, `At most ${CATEGORY_NAME_MAX} characters`)
  .refine((value) => !value.includes(NUL), 'Contains a NUL character');

const createBody = z.strictObject({
  slug: z.string().trim().max(CATEGORY_SLUG_MAX).regex(CATEGORY_SLUG),
  nameEn: categoryName,
});

const updateBody = z.strictObject({ nameEn: categoryName.optional(), isActive: z.boolean().optional() });

/** The whole set, as in the portfolio order. A repeat or a gap is the domain's 422; a non-uuid the shape's 400. */
const orderBody = z.strictObject({ ids: z.array(z.guid()).max(1000) });

const rowId = z.guid();

export function platformCategoriesRouter(deps: AuthDeps & { log?: AuditLog }): Router {
  const router = Router();
  const categoryDeps = { prisma: deps.prisma, now: deps.now, ...(deps.log === undefined ? {} : { log: deps.log }) };

  router.get('/categories', async (_req, res) => {
    res.json({ categories: await listPlatformCategories(deps.prisma) });
  });

  router.post('/categories', async (req, res) => {
    const body = parseOrReject(createBody, req.body, res);
    if (body === undefined) return;
    const result = await createCategory(categoryDeps, { actorUserId: platformAdminLocals(res).user.id, slug: body.slug, nameEn: body.nameEn });
    if (result.status === 'slug_taken') {
      res.status(409).json({ error: 'slug_taken' });
      return;
    }
    res.status(201).json({ category: result.category });
  });

  // Before /categories/:id, which would read `order` as an id (another method, but kept apart all the same).
  router.put('/categories/order', async (req, res) => {
    const body = parseOrReject(orderBody, req.body, res);
    if (body === undefined) return;
    const result = await reorderCategories(categoryDeps, { actorUserId: platformAdminLocals(res).user.id, ids: body.ids });
    if (result.status === 'invalid_ids') {
      res.status(422).json({ error: 'validation_failed', fields: ['ids'] });
      return;
    }
    res.json({ categories: result.categories });
  });

  router.patch('/categories/:id', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const body = parseOrReject(updateBody, req.body, res);
    if (body === undefined) return;
    const result = await updateCategory(categoryDeps, {
      actorUserId: platformAdminLocals(res).user.id,
      id,
      ...(body.nameEn === undefined ? {} : { nameEn: body.nameEn }),
      ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
    });
    if (result.status === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ category: result.category });
  });

  router.delete('/categories/:id', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const result = await deleteCategory(categoryDeps, { actorUserId: platformAdminLocals(res).user.id, id });
    switch (result.status) {
      case 'deleted':
        res.status(204).end();
        return;
      case 'not_found':
        res.status(404).json({ error: 'not_found' });
        return;
      case 'in_use':
        res.status(409).json({ error: 'category_in_use', photographerCount: result.photographerCount });
        return;
    }
  });

  return router;
}
