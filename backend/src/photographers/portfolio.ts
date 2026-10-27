import type { Prisma, PrismaClient } from '@prisma/client';
import { PORTFOLIO_LIMIT } from '../catalogue/public.js';

/**
 * The photographer's portfolio (marketplace-spec.md R7.2; marketplace-data-model.md
 * §3.6): pasted `https://` image URLs (no uploads), each with an optional
 * caption, in the photographer's order. The public profile shows the same rows
 * in the same order (catalogue/public.ts, R6.2). Transport-free:
 * `routes/studio-profile.ts` maps these results onto HTTP.
 *
 * Every lookup is `{ id, photographerId }` with the token's photographer
 * (R1.4), so another photographer's image is exactly as absent as an id that
 * names nothing.
 *
 * At most `PORTFOLIO_LIMIT` (24) images: "enforced in the app" (§3.6). Adding,
 * removing and reordering take a per-photographer advisory lock, so two adds
 * racing at 23 cannot both pass the count, and a reorder never interleaves with
 * an add or a delete. An advisory lock rather than the photographer row's: a
 * slot claim holds that row `FOR SHARE`, and a portfolio edit has no business
 * waiting on a booking.
 *
 * Order: `sort_order`, then age, then id (the public read's order). An add goes
 * last. A delete leaves a gap, which the order ignores. A reorder rewrites
 * `sort_order` as 0..n-1.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type StudioPortfolioImage = { id: string; url: string; caption: string | null; sortOrder: number; createdAt: string };

const IMAGE_SELECT = { id: true, url: true, caption: true, sortOrder: true, createdAt: true } satisfies Prisma.PortfolioImageSelect;
const ORDER = [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] satisfies Prisma.PortfolioImageOrderByWithRelationInput[];

function view(image: Prisma.PortfolioImageGetPayload<{ select: typeof IMAGE_SELECT }>): StudioPortfolioImage {
  return { ...image, createdAt: image.createdAt.toISOString() };
}

async function lockPortfolio(tx: Prisma.TransactionClient, photographerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bookly.portfolio:' || ${photographerId}::text))`;
}

/** Every image of the photographer's, in order. */
export async function listPortfolio(db: Db, photographerId: string): Promise<StudioPortfolioImage[]> {
  return (await db.portfolioImage.findMany({ where: { photographerId }, select: IMAGE_SELECT, orderBy: ORDER })).map(view);
}

export type AddPortfolioImageResult = { status: 'ok'; image: StudioPortfolioImage } | { status: 'portfolio_full' };

/** Appends one image, unless the portfolio already holds `PORTFOLIO_LIMIT`. */
export async function addPortfolioImage(
  prisma: PrismaClient,
  photographerId: string,
  input: { url: string; caption: string | null },
): Promise<AddPortfolioImageResult> {
  return prisma.$transaction(async (tx) => {
    await lockPortfolio(tx, photographerId);
    const [count, last] = await Promise.all([
      tx.portfolioImage.count({ where: { photographerId } }),
      tx.portfolioImage.aggregate({ where: { photographerId }, _max: { sortOrder: true } }),
    ]);
    if (count >= PORTFOLIO_LIMIT) return { status: 'portfolio_full' };
    const image = await tx.portfolioImage.create({
      data: { photographerId, url: input.url, caption: input.caption, sortOrder: (last._max.sortOrder ?? -1) + 1 },
      select: IMAGE_SELECT,
    });
    return { status: 'ok', image: view(image) };
  });
}

/** Sets or clears one image's caption; null when the id is not one of the photographer's images. */
export async function updatePortfolioCaption(
  prisma: PrismaClient,
  photographerId: string,
  id: string,
  caption: string | null,
): Promise<StudioPortfolioImage | null> {
  const { count } = await prisma.portfolioImage.updateMany({ where: { id, photographerId }, data: { caption } });
  if (count === 0) return null;
  const image = await prisma.portfolioImage.findFirst({ where: { id, photographerId }, select: IMAGE_SELECT });
  return image === null ? null : view(image);
}

/** Removes one image; false when the id is not one of the photographer's images. */
export async function deletePortfolioImage(prisma: PrismaClient, photographerId: string, id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockPortfolio(tx, photographerId);
    return (await tx.portfolioImage.deleteMany({ where: { id, photographerId } })).count > 0;
  });
}

export type ReorderPortfolioResult = { status: 'ok'; images: StudioPortfolioImage[] } | { status: 'mismatch' };

/**
 * Puts the images in the order `ids` gives. `ids` must be exactly the
 * photographer's set, each once (the route refuses repeats): a missing id, an
 * extra one, or another photographer's is `mismatch`, and nothing changes. The
 * set is compared under the lock, so an image added or removed meanwhile is a
 * mismatch rather than a half-applied order.
 */
export async function reorderPortfolio(prisma: PrismaClient, photographerId: string, ids: string[]): Promise<ReorderPortfolioResult> {
  return prisma.$transaction(async (tx) => {
    await lockPortfolio(tx, photographerId);
    const own = new Set((await tx.portfolioImage.findMany({ where: { photographerId }, select: { id: true } })).map((image) => image.id));
    if (own.size !== ids.length || !ids.every((id) => own.has(id))) return { status: 'mismatch' };
    for (const [index, id] of ids.entries()) {
      await tx.portfolioImage.updateMany({ where: { id, photographerId }, data: { sortOrder: index } });
    }
    return { status: 'ok', images: await listPortfolio(tx, photographerId) };
  });
}
