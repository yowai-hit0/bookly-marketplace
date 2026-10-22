import type { Addon, Package, Prisma, PrismaClient, Service } from '@prisma/client';
import { bookablePhotographerWhere, isBookable, listedPhotographerWhere } from '../photographers/bookable.js';
import { getPhotographerSettings, getPlatformSettings } from '../settings/index.js';

/**
 * What the public site may list (plan.md Tasks 10 and 11; brief decision 4):
 * the bookable photographers, and each one's catalogue -- active services, each
 * with its active packages and the active add-ons it offers: its own, then
 * those the same photographer offers on every service (`service_id` null).
 *
 * An allowlist projection. Inactive rows, sort keys, French columns and the
 * raw fee-rate override are left out, and so is everything about a
 * photographer that is not on their public profile: their status, their login,
 * their operating settings. A service's detail adds the booking-fee rate that
 * applies to it, so the page can show a live quote.
 *
 * Every catalogue read is addressed by one photographer, whose id the route
 * resolved from a listed handle. Nothing here joins across photographers: an
 * add-on offered "on every service" is offered on every service of its own
 * photographer, never another's (marketplace-data-model.md §2.7).
 *
 * LISTED is not BOOKABLE (marketplace-spec.md R5.5, photographers/bookable.ts):
 * a photographer whose subscription is `past_due` is still listed, profile and
 * services included, with `takingBookings: false`; their packages, like every
 * unbookable photographer's, still answer the quote, the calendar and the
 * booking form exactly as an inactive package does. An `expired` one is not
 * listed: their profile is the same 404 as a suspended, pending or unknown
 * handle. R5.5 says the profile page "says unavailable": that is the page's
 * wording of the 404, which already cannot tell those cases apart -- R3.4 as
 * built keeps an out-of-subscription photographer indistinguishable from a
 * suspended one to the public, and a distinct answer for `expired` would publish
 * a photographer's billing state.
 */

/** One card of the photographers list. No filters until the Phase 6 directory. */
export type PublicPhotographerSummary = {
  handle: string;
  displayName: string;
  coverImageUrl: string | null;
  /** False while the subscription is `past_due` (R5.5): listed, with a "not taking bookings" notice. */
  takingBookings: boolean;
};

/**
 * The client cancellation terms a photographer offers new bookings (R1.8), so
 * the pages before a booking can state them. A booking snapshots these at
 * creation, so what its own pages say comes from the booking, not from here.
 */
export type PublicCancellationPolicy = {
  /** A client may cancel until starts_at minus this many hours; 0 = any time before the shoot. */
  cutoffHours: number;
  /** Whether a client's own cancellation refunds the booking fee. */
  bookingFeeRefundable: boolean;
};

/**
 * A photographer's public profile. `email` is the public contact address they
 * chose (`contact_email`), never their login: the login is an account
 * identifier, and publishing it would hand out half of a credential.
 *
 * The cancellation policy is the one setting on it: it is a term of sale the
 * client agrees to, not an operating value.
 */
export type PublicPhotographerProfile = PublicPhotographerSummary & {
  bio: string | null;
  contactPhone: string | null;
  whatsappPhone: string | null;
  email: string | null;
  cancellationPolicy: PublicCancellationPolicy;
};

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
  /** The rate this service's booking fee is charged at: its own override, else its photographer's. */
  bookingFeeRate: number;
};

/** Display order, then name, then age, so equal sort orders stay stable. */
export const CATALOGUE_ORDER = [{ sortOrder: 'asc' }, { nameEn: 'asc' }, { createdAt: 'asc' }] as const;

/**
 * A package the public can book at `now`: active, on an active service, sold by
 * a bookable photographer (R5.4). One definition for every public use -- a
 * quote, a calendar and a booking must agree on what exists, and a photographer
 * who cannot be booked makes their packages answer exactly like inactive ones.
 */
export function bookablePackageWhere(now: Date): Prisma.PackageWhereInput {
  return { isActive: true, service: { isActive: true }, photographer: bookablePhotographerWhere(now) };
}

const ACTIVE_CHILDREN = {
  packages: { where: { isActive: true }, orderBy: [...CATALOGUE_ORDER] },
  addons: { where: { isActive: true }, orderBy: [...CATALOGUE_ORDER] },
} satisfies Prisma.ServiceInclude;

/** What `takingBookings` is decided from (photographers/bookable.ts `isBookable`). */
const BOOKABILITY_SELECT = {
  status: true,
  subscription: { select: { status: true, currentPeriodEndsAt: true } },
} satisfies Prisma.PhotographerSelect;

const PROFILE_SELECT = {
  ...BOOKABILITY_SELECT,
  id: true,
  handle: true,
  displayName: true,
  bio: true,
  contactPhone: true,
  whatsappPhone: true,
  contactEmail: true,
  coverImageUrl: true,
  setting: { select: { clientCancelCutoffHours: true, bookingFeeRefundableOnClientCancel: true } },
} satisfies Prisma.PhotographerSelect;

/** The `photographer_handle_format` CHECK: a handle it could not hold names nobody and is not looked up. */
const HANDLE_FORMAT = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/**
 * Every listed photographer at `now`, by name then handle (brief decision 4;
 * R5.5): the bookable ones and those `past_due`, each saying whether they are
 * taking bookings.
 */
export async function listPublicPhotographers(prisma: PrismaClient, now: Date = new Date()): Promise<PublicPhotographerSummary[]> {
  const { subscriptionGraceDays } = await getPlatformSettings(prisma);
  const rows = await prisma.photographer.findMany({
    where: listedPhotographerWhere(now, subscriptionGraceDays),
    orderBy: [{ displayName: 'asc' }, { handle: 'asc' }],
    select: { ...BOOKABILITY_SELECT, handle: true, displayName: true, coverImageUrl: true },
  });
  return rows.map((row) => ({
    handle: row.handle,
    displayName: row.displayName,
    coverImageUrl: row.coverImageUrl,
    takingBookings: isBookable(row, row.subscription, now),
  }));
}

/**
 * A listed photographer by handle at `now` -- their public profile, and their
 * id for the catalogue reads that follow -- or null. Unknown, pending,
 * suspended and expired are all null: the public is never told which.
 */
export async function findPublicPhotographer(
  prisma: PrismaClient,
  handle: string,
  now: Date = new Date(),
): Promise<{ id: string; profile: PublicPhotographerProfile } | null> {
  if (!HANDLE_FORMAT.test(handle)) return null;
  const { subscriptionGraceDays } = await getPlatformSettings(prisma);
  const photographer = await prisma.photographer.findFirst({
    where: { handle, ...listedPhotographerWhere(now, subscriptionGraceDays) },
    select: PROFILE_SELECT,
  });
  if (photographer === null) return null;
  return { id: photographer.id, profile: toPublicProfile(photographer, now) };
}

/** One photographer's public catalogue. */
export async function listPublicCatalogue(prisma: PrismaClient, photographerId: string): Promise<PublicService[]> {
  const [services, sharedAddons] = await Promise.all([
    prisma.service.findMany({
      where: { photographerId, isActive: true },
      orderBy: [...CATALOGUE_ORDER],
      include: ACTIVE_CHILDREN,
    }),
    findSharedAddons(prisma, photographerId),
  ]);

  return services.map((service) => toPublicService(service, sharedAddons));
}

/**
 * One of a photographer's active services by its slug, or null. A deactivated
 * service is null too: to the public it does not exist (spec §6.14). Slugs are
 * unique per photographer, so the same slug under another handle is another
 * service.
 */
export async function findPublicService(prisma: PrismaClient, photographerId: string, slug: string): Promise<PublicServiceDetail | null> {
  const [service, sharedAddons, settings] = await Promise.all([
    prisma.service.findFirst({ where: { photographerId, slug, isActive: true }, include: ACTIVE_CHILDREN }),
    findSharedAddons(prisma, photographerId),
    getPhotographerSettings(photographerId, prisma),
  ]);
  if (service === null) return null;

  return {
    ...toPublicService(service, sharedAddons),
    bookingFeeRate: effectiveBookingFeeRate(service, settings.bookingFeeRate),
  };
}

/** data-model_v2.md §9.5: the service's override if set, else its photographer's rate. */
export function effectiveBookingFeeRate(service: Pick<Service, 'bookingFeeRateOverride'>, photographerRate: number): number {
  return service.bookingFeeRateOverride?.toNumber() ?? photographerRate;
}

/** The add-ons a photographer offers on every one of their services. */
function findSharedAddons(prisma: PrismaClient, photographerId: string): Promise<Addon[]> {
  return prisma.addon.findMany({ where: { photographerId, isActive: true, serviceId: null }, orderBy: [...CATALOGUE_ORDER] });
}

function toPublicProfile(photographer: Prisma.PhotographerGetPayload<{ select: typeof PROFILE_SELECT }>, now: Date): PublicPhotographerProfile {
  // The signup transaction creates the settings row with the photographer, so
  // a missing one is a broken invariant, as getPhotographerSettings() treats it.
  if (photographer.setting === null) throw new Error(`photographer ${photographer.id} has no settings row`);
  return {
    handle: photographer.handle,
    displayName: photographer.displayName,
    coverImageUrl: photographer.coverImageUrl,
    takingBookings: isBookable(photographer, photographer.subscription, now),
    bio: photographer.bio,
    contactPhone: photographer.contactPhone,
    whatsappPhone: photographer.whatsappPhone,
    email: photographer.contactEmail,
    cancellationPolicy: {
      cutoffHours: photographer.setting.clientCancelCutoffHours,
      bookingFeeRefundable: photographer.setting.bookingFeeRefundableOnClientCancel,
    },
  };
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
