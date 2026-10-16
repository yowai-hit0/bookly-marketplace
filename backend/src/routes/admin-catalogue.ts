import type { Addon, Package, PrismaClient, Service } from '@prisma/client';
import { type Response, Router } from 'express';
import { z } from 'zod';
import { kigaliDateOf } from '../availability/engine.js';
import { SQLSTATE, sqlstateOf } from '../db/errors.js';
import { INT4_MAX, feeRate, parseOrReject } from './validation.js';

/**
 * The catalogue CMS (plan.md Task 10, spec §3.4, §6.8, §6.14, P-17 to P-20).
 * Mounted behind `requireAdmin`.
 *
 *   GET    /catalogue          every service with its packages and add-ons,
 *                              plus the add-ons offered on every service
 *   POST   /services           PATCH /services/:id   DELETE /services/:id
 *   POST   /packages           PATCH /packages/:id   DELETE /packages/:id
 *   POST   /addons             PATCH /addons/:id     DELETE /addons/:id
 *
 * Edits are partial, so activating, deactivating or reordering (`sortOrder`)
 * sends only that field. Nothing here reaches an existing booking: a booking
 * carries its own name, price, duration and photo-count snapshots
 * (data-model_v2.md §5.9), so an edit applies to new bookings only (§6.13).
 *
 * Deactivating is how something stops being sold (§6.14). A hard delete is
 * allowed only for a row nothing references -- a typo, a duplicate -- and the
 * database's `RESTRICT` foreign keys decide that, answered as 409.
 */

const NAME_MAX_LENGTH = 200;
const SLUG_MAX_LENGTH = 100;
/** Bounds storage for free text. A developer default, not a spec value. */
const DESCRIPTION_MAX_LENGTH = 5000;

const rowId = z.guid();
const name = z.string().trim().min(1).max(NAME_MAX_LENGTH);
/** Optional text, trimmed. Blank is stored as null, never `''`, so "no French
 *  name" has one representation for a later fallback to test. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();
const optionalName = optionalText(NAME_MAX_LENGTH);
const optionalDescription = optionalText(DESCRIPTION_MAX_LENGTH);
const sortOrder = z.int().min(0).max(INT4_MAX).optional();
const isActive = z.boolean().optional();
const priceRwf = z.int().min(0).max(INT4_MAX);

/** The URL segment. Lowercase words joined by single hyphens: `corporate-events`. */
const slug = z
  .string()
  .max(SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * A pasted link to an image hosted elsewhere -- no uploads (plan.md Task 10).
 * A malformed URL is a 400; a well-formed `http:` one is a 422, because the
 * site is served over HTTPS and would load it as mixed content.
 */
const coverImageUrl = z
  .url()
  // The parsed scheme, so `HTTPS://` counts as https too. zod runs this even
  // after the format check fails; an unparseable value is left to that 400.
  .refine((value) => !URL.canParse(value) || new URL(value).protocol === 'https:', 'Must be an https URL')
  .nullable()
  .optional();

// `nameFr` and `descriptionFr` are accepted and stored so French stays a
// content task (spec §7, R-2). The v1 admin UI does not render them.
const createServiceBody = z.strictObject({
  slug,
  nameEn: name,
  nameFr: optionalName,
  descriptionEn: optionalDescription,
  descriptionFr: optionalDescription,
  coverImageUrl,
  /** null = the global `setting.booking_fee_rate` (spec A-4). */
  bookingFeeRateOverride: feeRate.nullable().optional(),
  isActive,
  sortOrder,
});
const updateServiceBody = createServiceBody.partial();

const createPackageBody = z.strictObject({
  /** Fixed at creation: a package does not move between services. */
  serviceId: rowId,
  nameEn: name,
  nameFr: optionalName,
  descriptionEn: optionalDescription,
  descriptionFr: optionalDescription,
  priceRwf,
  photoCount: z.int().min(0).max(INT4_MAX),
  durationMinutes: z.int().min(1).max(INT4_MAX),
  isActive,
  sortOrder,
});
const updatePackageBody = createPackageBody.omit({ serviceId: true }).partial();

const createAddonBody = z.strictObject({
  /** Required, and fixed at creation: null means offered on every service. */
  serviceId: rowId.nullable(),
  nameEn: name,
  nameFr: optionalName,
  priceRwf,
  isActive,
  sortOrder,
});
const updateAddonBody = createAddonBody.omit({ serviceId: true }).partial();

/** Display order, then name, then age, so equal sort orders stay stable. */
const ORDER = [{ sortOrder: 'asc' }, { nameEn: 'asc' }, { createdAt: 'asc' }] as const;

export function catalogueRouter(prisma: PrismaClient, now: () => Date): Router {
  const router = Router();

  router.get('/catalogue', async (_req, res) => {
    const [services, sharedAddons] = await Promise.all([
      prisma.service.findMany({
        orderBy: [...ORDER],
        include: { packages: { orderBy: [...ORDER] }, addons: { orderBy: [...ORDER] } },
      }),
      prisma.addon.findMany({ where: { serviceId: null }, orderBy: [...ORDER] }),
    ]);

    res.json({
      services: services.map((service) => ({
        ...toAdminService(service),
        packages: service.packages.map(toAdminPackage),
        addons: service.addons.map(toAdminAddon),
      })),
      sharedAddons: sharedAddons.map(toAdminAddon),
    });
  });

  // --- Services ------------------------------------------------------------------

  router.post('/services', async (req, res) => {
    const body = parseOrReject(createServiceBody, req.body, res);
    if (body === undefined) return;

    try {
      const created = await prisma.service.create({ data: { ...body, ...feeRateData(body) } });
      res.status(201).json({ service: toAdminService(created) });
    } catch (error) {
      if (!rejectTakenSlug(error, res)) throw error;
    }
  });

  router.patch('/services/:id', async (req, res) => {
    const id = rowId.safeParse(req.params.id);
    if (!id.success) return notFound(res);
    const body = parseOrReject(updateServiceBody, req.body, res);
    if (body === undefined) return;

    try {
      const { count } = await prisma.service.updateMany({
        where: { id: id.data },
        data: { ...body, ...feeRateData(body) },
      });
      const updated = count === 0 ? null : await prisma.service.findUnique({ where: { id: id.data } });
      if (updated === null) return notFound(res);
      res.json({ service: toAdminService(updated) });
    } catch (error) {
      if (!rejectTakenSlug(error, res)) throw error;
    }
  });

  router.delete('/services/:id', async (req, res) => {
    await deleteRow(res, req.params.id, (id) => prisma.service.deleteMany({ where: { id } }));
  });

  // --- Packages ------------------------------------------------------------------

  router.post('/packages', async (req, res) => {
    const body = parseOrReject(createPackageBody, req.body, res);
    if (body === undefined) return;

    try {
      const created = await prisma.package.create({ data: body });
      res.status(201).json(await withDurationWarning(prisma, now(), created));
    } catch (error) {
      if (!rejectUnknownService(error, res)) throw error;
    }
  });

  router.patch('/packages/:id', async (req, res) => {
    const id = rowId.safeParse(req.params.id);
    if (!id.success) return notFound(res);
    const body = parseOrReject(updatePackageBody, req.body, res);
    if (body === undefined) return;

    const { count } = await prisma.package.updateMany({ where: { id: id.data }, data: body });
    const updated = count === 0 ? null : await prisma.package.findUnique({ where: { id: id.data } });
    if (updated === null) return notFound(res);
    res.json(await withDurationWarning(prisma, now(), updated));
  });

  router.delete('/packages/:id', async (req, res) => {
    await deleteRow(res, req.params.id, (id) => prisma.package.deleteMany({ where: { id } }));
  });

  // --- Add-ons -------------------------------------------------------------------

  router.post('/addons', async (req, res) => {
    const body = parseOrReject(createAddonBody, req.body, res);
    if (body === undefined) return;

    try {
      const created = await prisma.addon.create({ data: body });
      res.status(201).json({ addon: toAdminAddon(created) });
    } catch (error) {
      if (!rejectUnknownService(error, res)) throw error;
    }
  });

  router.patch('/addons/:id', async (req, res) => {
    const id = rowId.safeParse(req.params.id);
    if (!id.success) return notFound(res);
    const body = parseOrReject(updateAddonBody, req.body, res);
    if (body === undefined) return;

    const { count } = await prisma.addon.updateMany({ where: { id: id.data }, data: body });
    const updated = count === 0 ? null : await prisma.addon.findUnique({ where: { id: id.data } });
    if (updated === null) return notFound(res);
    res.json({ addon: toAdminAddon(updated) });
  });

  router.delete('/addons/:id', async (req, res) => {
    await deleteRow(res, req.params.id, (id) => prisma.addon.deleteMany({ where: { id } }));
  });

  return router;
}

/** numeric(4,3), written as a three-place string so no float reaches it. */
function feeRateData(body: { bookingFeeRateOverride?: number | null }) {
  const rate = body.bookingFeeRateOverride;
  if (rate === undefined) return {};
  return { bookingFeeRateOverride: rate === null ? null : rate.toFixed(3) };
}

/**
 * Deletes one row, or answers why not. `RESTRICT` foreign keys refuse the
 * delete of anything a booking, a booking add-on or a package still references
 * (data-model_v2.md §9.4); that is a 409, and the row survives.
 */
async function deleteRow(
  res: Response,
  rawId: string,
  remove: (id: string) => Promise<{ count: number }>,
): Promise<void> {
  const id = rowId.safeParse(rawId);
  if (!id.success) return notFound(res);

  try {
    const { count } = await remove(id.data);
    if (count === 0) return notFound(res);
    res.status(204).end();
  } catch (error) {
    if (sqlstateOf(error) !== SQLSTATE.FOREIGN_KEY_VIOLATION) throw error;
    res.status(409).json({ error: 'in_use' });
  }
}

function rejectTakenSlug(error: unknown, res: Response): boolean {
  if (sqlstateOf(error) !== SQLSTATE.UNIQUE_VIOLATION) return false;
  res.status(409).json({ error: 'slug_taken' });
  return true;
}

/** A `serviceId` naming no service: a well-formed value outside the rules. */
function rejectUnknownService(error: unknown, res: Response): boolean {
  if (sqlstateOf(error) !== SQLSTATE.FOREIGN_KEY_VIOLATION) return false;
  res.status(422).json({ error: 'validation_failed', fields: ['serviceId'] });
  return true;
}

type OpenWindow = { opensMinute: number; closesMinute: number };

/**
 * Spec §6.8: a package longer than every open day can never be booked. Saving
 * it is allowed -- the warning is not a block -- but the response says so and
 * names the longest window, so he is not left wondering why clients see an
 * empty calendar.
 *
 * "Open days" are the weekly rules plus today's and future dated overrides; an
 * override that has already passed opens nothing any more. With no open day at
 * all, `longestWindow` is null and every package warns.
 */
async function withDurationWarning(prisma: PrismaClient, now: Date, pkg: Package) {
  const rows = await prisma.workingHours.findMany({
    where: {
      isOpen: true,
      OR: [
        { effectiveDate: null },
        { effectiveDate: { gte: new Date(`${kigaliDateOf(now)}T00:00:00Z`) } },
      ],
    },
    select: { opensMinute: true, closesMinute: true },
  });

  let longestWindow: OpenWindow | null = null;
  for (const { opensMinute, closesMinute } of rows) {
    if (opensMinute === null || closesMinute === null) continue;
    const longest = longestWindow === null ? -1 : longestWindow.closesMinute - longestWindow.opensMinute;
    if (closesMinute - opensMinute > longest) longestWindow = { opensMinute, closesMinute };
  }

  const fits =
    longestWindow !== null &&
    pkg.durationMinutes <= longestWindow.closesMinute - longestWindow.opensMinute;

  return {
    package: toAdminPackage(pkg),
    warning: fits ? null : { code: 'duration_exceeds_longest_window' as const, longestWindow },
  };
}

function toAdminService(row: Service) {
  return {
    id: row.id,
    slug: row.slug,
    nameEn: row.nameEn,
    nameFr: row.nameFr,
    descriptionEn: row.descriptionEn,
    descriptionFr: row.descriptionFr,
    coverImageUrl: row.coverImageUrl,
    bookingFeeRateOverride: row.bookingFeeRateOverride?.toNumber() ?? null,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  };
}

function toAdminPackage(row: Package) {
  return {
    id: row.id,
    serviceId: row.serviceId,
    nameEn: row.nameEn,
    nameFr: row.nameFr,
    descriptionEn: row.descriptionEn,
    descriptionFr: row.descriptionFr,
    priceRwf: row.priceRwf,
    photoCount: row.photoCount,
    durationMinutes: row.durationMinutes,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  };
}

function toAdminAddon(row: Addon) {
  return {
    id: row.id,
    serviceId: row.serviceId,
    nameEn: row.nameEn,
    nameFr: row.nameFr,
    priceRwf: row.priceRwf,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  };
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}
