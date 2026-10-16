import type { Addon, Package, PrismaClient, Service } from '@prisma/client';
import { type PhotographerSettings, getPhotographerSettings } from '../settings/index.js';
import { BOOKABLE_PACKAGE, CATALOGUE_ORDER, type PublicAddon, effectiveBookingFeeRate, toPublicAddon } from './public.js';
import { type Quote, quoteBasket } from './quote.js';

/**
 * Prices a visitor's selection from the catalogue (plan.md Task 11). The API is
 * authoritative for money: a basket names a package and add-ons by id, and
 * every amount comes from their rows as they stand now -- never from anything
 * the client sent alongside.
 *
 * Only what the public can see can be priced: an active package on an active
 * service of a bookable photographer, and active add-ons that service offers --
 * its own, or those its photographer offers on every service. Anything else is
 * refused by field, not priced. The photographer is the package's: nothing in a
 * basket names one, so nothing a visitor sends can choose whose settings or
 * whose add-ons apply (marketplace-spec.md R1.5).
 */

export type BasketSelection = {
  packageId: string;
  /** Distinct ids; the caller's schema refuses a repeat. */
  addonIds: readonly string[];
};

export type PricedBasket = Quote & {
  service: { id: string; slug: string; nameEn: string };
  package: { id: string; nameEn: string; priceRwf: number };
  /** As the service page lists them -- its own, then shared, each in display
   *  order -- whatever order they were selected in. */
  addons: PublicAddon[];
  bookingFeeRate: number;
};

export type BasketResult =
  | { ok: true; quote: PricedBasket }
  | { ok: false; fields: ('packageId' | 'addonIds')[] };

/**
 * The rows a basket was priced from, with the package's photographer's settings
 * read alongside them.
 * Booking creation snapshots exactly these (plan.md Task 13), so what a booking
 * records is what its quote was computed from -- one read, not two that a
 * price edit could fall between.
 */
export type ResolvedBasket = {
  ok: true;
  package: Package & { service: Service };
  /** In the order `PricedBasket.addons` documents. */
  addons: Addon[];
  settings: PhotographerSettings;
  bookingFeeRate: number;
  quote: Quote;
};

export async function resolveBasket(
  prisma: PrismaClient,
  selection: BasketSelection,
): Promise<ResolvedBasket | { ok: false; fields: ('packageId' | 'addonIds')[] }> {
  const pkg = await prisma.package.findFirst({
    where: { id: selection.packageId, ...BOOKABLE_PACKAGE },
    include: { service: true },
  });
  if (pkg === null) return { ok: false, fields: ['packageId'] };

  const [settings, addons] = await Promise.all([
    getPhotographerSettings(pkg.photographerId, prisma),
    selection.addonIds.length === 0
      ? Promise.resolve<Addon[]>([])
      : prisma.addon.findMany({
          where: {
            id: { in: [...selection.addonIds] },
            // The package's photographer's add-ons and nobody else's: a shared
            // add-on (`service_id` null) is shared across one photographer's
            // services, not across the marketplace (R1.5).
            photographerId: pkg.photographerId,
            isActive: true,
            OR: [{ serviceId: null }, { serviceId: pkg.serviceId }],
          },
          orderBy: [...CATALOGUE_ORDER],
        }),
  ]);
  // Ids are distinct, so a shortfall is an add-on that is unknown, inactive,
  // offered on another service only, or another photographer's.
  if (addons.length !== selection.addonIds.length) return { ok: false, fields: ['addonIds'] };
  // The order the service page lists them in: the service's own add-ons, then
  // those offered on every service. The sort is stable, so each group keeps
  // its display order.
  addons.sort((a, b) => Number(a.serviceId === null) - Number(b.serviceId === null));

  const bookingFeeRate = effectiveBookingFeeRate(pkg.service, settings.bookingFeeRate);
  const quote = quoteBasket({
    packagePriceRwf: pkg.priceRwf,
    addonPricesRwf: addons.map((addon) => addon.priceRwf),
    bookingFeeRate,
  });

  return { ok: true, package: pkg, addons, settings, bookingFeeRate, quote };
}

export async function priceBasket(prisma: PrismaClient, selection: BasketSelection): Promise<BasketResult> {
  const basket = await resolveBasket(prisma, selection);
  if (!basket.ok) return basket;

  const { package: pkg, addons, bookingFeeRate, quote } = basket;
  return {
    ok: true,
    quote: {
      service: { id: pkg.service.id, slug: pkg.service.slug, nameEn: pkg.service.nameEn },
      package: { id: pkg.id, nameEn: pkg.nameEn, priceRwf: pkg.priceRwf },
      addons: addons.map(toPublicAddon),
      bookingFeeRate,
      ...quote,
    },
  };
}
