import type { Addon, Package, Prisma, PrismaClient, Service } from '@prisma/client';
import { getSettings } from '../settings/index.js';

/**
 * What the public site may list (plan.md Tasks 10 and 11): active services,
 * each with its active packages and the active add-ons it offers -- its own,
 * then those offered on every service (`service_id` null).
 *
 * An allowlist projection. Inactive rows, sort keys, French columns and the
 * raw fee-rate override are left out. A service's detail adds the booking-fee
 * rate that applies to it, so the page can show a live quote.
 */

export type PublicPackage = {
  id: string;
  nameEn: string;
  descriptionEn: string | null;
  priceRwf: number;
  photoCount: number;
  durationMinutes: number;
};

export type PublicAddon = {
  id: string;
  nameEn: string;
  priceRwf: number;
};

export type PublicService = {
  id: string;
  slug: string;
  nameEn: string;
  descriptionEn: string | null;
  coverImageUrl: string | null;
  packages: PublicPackage[];
  addons: PublicAddon[];
};

export type PublicServiceDetail = PublicService & {
  /** The rate this service's booking fee is charged at: its own override, else the global one. */
  bookingFeeRate: number;
};

/** Display order, then name, then age, so equal sort orders stay stable. */
export const CATALOGUE_ORDER = [{ sortOrder: 'asc' }, { nameEn: 'asc' }, { createdAt: 'asc' }] as const;

/** A package the public can book: active, on an active service. One definition
 *  for every public use -- a quote and a calendar must agree on what exists. */
export const BOOKABLE_PACKAGE = { isActive: true, service: { isActive: true } } satisfies Prisma.PackageWhereInput;

const ACTIVE_CHILDREN = {
  packages: { where: { isActive: true }, orderBy: [...CATALOGUE_ORDER] },
  addons: { where: { isActive: true }, orderBy: [...CATALOGUE_ORDER] },
} satisfies Prisma.ServiceInclude;

export async function listPublicCatalogue(prisma: PrismaClient): Promise<PublicService[]> {
  const [services, sharedAddons] = await Promise.all([
    prisma.service.findMany({
      where: { isActive: true },
      orderBy: [...CATALOGUE_ORDER],
      include: ACTIVE_CHILDREN,
    }),
    findSharedAddons(prisma),
  ]);

  return services.map((service) => toPublicService(service, sharedAddons));
}

/**
 * One active service by its slug, or null. A deactivated service is null too:
 * to the public it does not exist (spec §6.14).
 */
export async function findPublicService(prisma: PrismaClient, slug: string): Promise<PublicServiceDetail | null> {
  const [service, sharedAddons, settings] = await Promise.all([
    prisma.service.findFirst({ where: { slug, isActive: true }, include: ACTIVE_CHILDREN }),
    findSharedAddons(prisma),
    getSettings(prisma),
  ]);
  if (service === null) return null;

  return {
    ...toPublicService(service, sharedAddons),
    bookingFeeRate: effectiveBookingFeeRate(service, settings.bookingFeeRate),
  };
}

/** data-model_v2.md §9.5: the service's override if set, else the global rate. */
export function effectiveBookingFeeRate(service: Pick<Service, 'bookingFeeRateOverride'>, globalRate: number): number {
  return service.bookingFeeRateOverride?.toNumber() ?? globalRate;
}

function findSharedAddons(prisma: PrismaClient): Promise<Addon[]> {
  return prisma.addon.findMany({ where: { isActive: true, serviceId: null }, orderBy: [...CATALOGUE_ORDER] });
}

function toPublicService(
  service: Service & { packages: Package[]; addons: Addon[] },
  sharedAddons: Addon[],
): PublicService {
  return {
    id: service.id,
    slug: service.slug,
    nameEn: service.nameEn,
    descriptionEn: service.descriptionEn,
    coverImageUrl: service.coverImageUrl,
    packages: service.packages.map(toPublicPackage),
    addons: [...service.addons, ...sharedAddons].map(toPublicAddon),
  };
}

function toPublicPackage(pkg: Package): PublicPackage {
  return {
    id: pkg.id,
    nameEn: pkg.nameEn,
    descriptionEn: pkg.descriptionEn,
    priceRwf: pkg.priceRwf,
    photoCount: pkg.photoCount,
    durationMinutes: pkg.durationMinutes,
  };
}

export function toPublicAddon(addon: Addon): PublicAddon {
  return { id: addon.id, nameEn: addon.nameEn, priceRwf: addon.priceRwf };
}
