import type { PrismaClient } from '@prisma/client';
import { hashPassword } from '../auth/password.js';
import { accessTokenExpiry, generateAccessToken } from '../booking/access-token.js';
import { generateReference } from '../booking/reference.js';
import { quoteBasket } from '../catalogue/quote.js';
import { recordEarning } from '../payouts/ledger.js';
import { isSlotTaken } from './errors.js';

/**
 * Demo data for a development database (R1.9): three approved photographers
 * whose catalogues, districts and working hours overlap -- two of them even
 * share the `portraits` slug, which is unique per photographer, not globally --
 * and one confirmed booking with the first, whose booking fee is paid. So the
 * directory, the studio and the client's own booking page all have something to
 * show, and per-photographer separation is visible from the first run.
 *
 * Never in production, and never over real data: a demo photographer is
 * created only when both its handle and its email are free, and the booking is
 * recognised by its demo email. The access token's plaintext is never stored
 * (data-model_v2.md §5.9), so every run gives the demo booking a fresh one --
 * the studio "resend link" behaviour -- and hands it back to be printed. The
 * previous link stops working.
 *
 * No email is queued: no demo address is anyone's.
 */

export const DEMO_CLIENT_EMAIL = 'demo.client@example.com';

/**
 * The password of every demo photographer login. DEVELOPMENT ONLY: it is in the
 * source on purpose, so anyone running the demo can sign in to each studio. The
 * demo never runs in production (`seed.ts`), and these logins exist nowhere else.
 */
export const DEMO_PHOTOGRAPHER_PASSWORD = 'demo-photographer-password';

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
/** Kigali is UTC+2 all year. */
const KIGALI_OFFSET_MS = 2 * 60 * MINUTE_MS;
/** 10:00 in Kigali, inside the first photographer's Mon-Fri 09:00-17:00. */
const START_HOUR_UTC = 8;
const FIRST_DAY_AHEAD = 7;
const MAX_SLOT_ATTEMPTS = 14;

type DemoPackage = { nameEn: string; descriptionEn: string; priceRwf: number; photoCount: number; durationMinutes: number };
type DemoAddon = { nameEn: string; priceRwf: number };
type DemoService = { slug: string; nameEn: string; descriptionEn: string; packages: DemoPackage[]; addons?: DemoAddon[] };

type DemoPhotographer = {
  handle: string;
  displayName: string;
  bio: string;
  contactPhone: string;
  /** Kigali wall-clock minutes, every listed weekday (0 = Sunday). */
  hours: { weekdays: number[]; opensMinute: number; closesMinute: number };
  districts: string[];
  categories: string[];
  services: DemoService[];
  /** Offered on every service of this photographer. */
  sharedAddons: DemoAddon[];
};

/**
 * The first is the single-photographer demo catalogue, unchanged, so the demo
 * booking below still books what it always did. All three work Tuesday to
 * Friday from 10:00 to 17:00 and in Gasabo, so a directory search for those
 * finds every one of them.
 */
export const DEMO_PHOTOGRAPHERS: readonly DemoPhotographer[] = [
  {
    handle: 'umucyo-studio',
    displayName: 'Umucyo Studio',
    bio: 'Portraits and small celebrations around Kigali, in natural light.',
    contactPhone: '+250788100001',
    hours: { weekdays: [1, 2, 3, 4, 5], opensMinute: 540, closesMinute: 1020 },
    districts: ['gasabo', 'kicukiro', 'nyarugenge'],
    categories: ['portrait', 'event', 'family'],
    services: [
      {
        slug: 'portraits',
        nameEn: 'Portraits',
        descriptionEn: 'Individual, couple or family portraits, outdoors in Kigali or at a place you choose.',
        packages: [
          { nameEn: 'Standard', descriptionEn: 'One location, one outfit.', priceRwf: 40_000, photoCount: 25, durationMinutes: 90 },
          { nameEn: 'Extended', descriptionEn: 'Two locations, up to three outfits.', priceRwf: 70_000, photoCount: 50, durationMinutes: 150 },
        ],
        addons: [{ nameEn: 'Extra outfit', priceRwf: 10_000 }],
      },
      {
        slug: 'events',
        nameEn: 'Events',
        descriptionEn: 'Birthdays, graduations and small celebrations, covered from start to finish.',
        packages: [{ nameEn: 'Half day', descriptionEn: 'Up to four hours of coverage.', priceRwf: 150_000, photoCount: 150, durationMinutes: 240 }],
      },
    ],
    sharedAddons: [{ nameEn: 'Rush edit (48 hours)', priceRwf: 15_000 }],
  },
  {
    handle: 'kigali-lens',
    displayName: 'Kigali Lens',
    bio: 'Weddings and studio portraits. Two photographers on every wedding.',
    contactPhone: '+250788100002',
    hours: { weekdays: [1, 2, 3, 4, 5, 6], opensMinute: 480, closesMinute: 1080 },
    districts: ['gasabo', 'nyarugenge', 'kicukiro'],
    categories: ['wedding', 'portrait', 'fashion'],
    services: [
      {
        slug: 'portraits',
        nameEn: 'Studio portraits',
        descriptionEn: 'A studio session with lighting and a choice of backdrops.',
        packages: [{ nameEn: 'Studio session', descriptionEn: 'One hour in the studio.', priceRwf: 35_000, photoCount: 20, durationMinutes: 60 }],
      },
      {
        slug: 'weddings',
        nameEn: 'Weddings',
        descriptionEn: 'From the gusaba to the reception.',
        packages: [
          { nameEn: 'Ceremony', descriptionEn: 'The ceremony and the portraits after it.', priceRwf: 450_000, photoCount: 300, durationMinutes: 360 },
          { nameEn: 'Full day', descriptionEn: 'Preparations to the first dance.', priceRwf: 800_000, photoCount: 600, durationMinutes: 600 },
        ],
      },
    ],
    sharedAddons: [{ nameEn: 'Printed album', priceRwf: 60_000 }],
  },
  {
    handle: 'hills-and-light',
    displayName: 'Hills & Light',
    bio: 'Graduations and family sessions, in Musanze, Huye and Kigali.',
    contactPhone: '+250788100003',
    hours: { weekdays: [2, 3, 4, 5, 6], opensMinute: 600, closesMinute: 1080 },
    districts: ['musanze', 'huye', 'gasabo'],
    categories: ['graduation', 'family', 'event'],
    services: [
      {
        slug: 'graduations',
        nameEn: 'Graduations',
        descriptionEn: 'On campus or at home, with your family.',
        packages: [{ nameEn: 'Campus session', descriptionEn: 'Two hours around campus.', priceRwf: 50_000, photoCount: 40, durationMinutes: 120 }],
      },
      {
        slug: 'family',
        nameEn: 'Family',
        descriptionEn: 'An unhurried afternoon with the whole family.',
        packages: [{ nameEn: 'Family afternoon', descriptionEn: 'Two hours, one location.', priceRwf: 60_000, photoCount: 40, durationMinutes: 120 }],
        addons: [{ nameEn: 'Extra location', priceRwf: 15_000 }],
      },
    ],
    sharedAddons: [],
  },
];

export type DemoSummary = {
  photographersCreated: number;
  servicesCreated: number;
  packagesCreated: number;
  addonsCreated: number;
  booking: { reference: string; created: boolean; accessToken: string } | null;
};

/** The demo login of a demo photographer. */
export function demoPhotographerEmail(handle: string): string {
  return `${handle}@photographers.example.com`;
}

export async function seedDemoData(prisma: PrismaClient, now: Date = new Date()): Promise<DemoSummary> {
  const totals = { photographersCreated: 0, servicesCreated: 0, packagesCreated: 0, addonsCreated: 0 };
  // One hash for all three: argon2id is deliberately slow.
  let passwordHash: string | null = null;

  for (const demo of DEMO_PHOTOGRAPHERS) {
    const email = demoPhotographerEmail(demo.handle);
    const taken = await prisma.photographer.count({ where: { handle: demo.handle } });
    const emailTaken = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM app_user WHERE lower(email) = lower(${email})`;
    if (taken > 0 || (emailTaken[0]?.n ?? 0) > 0) continue;

    passwordHash ??= await hashPassword(DEMO_PHOTOGRAPHER_PASSWORD);
    const created = await seedPhotographer(prisma, demo, email, passwordHash, now);
    totals.photographersCreated += 1;
    totals.servicesCreated += created.services;
    totals.packagesCreated += created.packages;
    totals.addonsCreated += created.addons;
  }

  return { ...totals, booking: await seedDemoBooking(prisma, now) };
}

/**
 * One photographer in one transaction: the login, the photographer and their
 * settings row together, as signup and approval leave them (marketplace-data-model.md
 * §2.2), then their hours, districts, categories and catalogue.
 */
async function seedPhotographer(
  prisma: PrismaClient,
  demo: DemoPhotographer,
  email: string,
  passwordHash: string,
  now: Date,
): Promise<{ services: number; packages: number; addons: number }> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.appUser.create({ data: { email, role: 'photographer', fullName: demo.displayName, passwordHash, emailVerifiedAt: now } });
    const photographer = await tx.photographer.create({
      data: {
        userId: user.id,
        handle: demo.handle,
        displayName: demo.displayName,
        bio: demo.bio,
        contactPhone: demo.contactPhone,
        contactEmail: email,
        status: 'approved',
        submittedAt: now,
        approvedAt: now,
        setting: { create: {} },
      },
    });
    const photographerId = photographer.id;

    await tx.workingHours.createMany({
      data: demo.hours.weekdays.map((weekday) => ({ photographerId, weekday, opensMinute: demo.hours.opensMinute, closesMinute: demo.hours.closesMinute, isOpen: true })),
    });
    // The districts come from the migration and always exist.
    await tx.photographerDistrict.createMany({ data: demo.districts.map((districtCode) => ({ photographerId, districtCode })) });
    // The categories come from the seed; one a platform admin removed is skipped.
    const categories = await tx.category.findMany({ where: { slug: { in: demo.categories } }, select: { id: true } });
    await tx.photographerCategory.createMany({ data: categories.map((category) => ({ photographerId, categoryId: category.id })) });

    let packages = 0;
    let addons = 0;
    for (const [index, service] of demo.services.entries()) {
      await tx.service.create({
        data: {
          photographerId,
          slug: service.slug,
          nameEn: service.nameEn,
          descriptionEn: service.descriptionEn,
          sortOrder: index,
          // Nested under the service, a package takes the service's photographer
          // through the composite foreign key.
          packages: { create: service.packages.map((pkg, sortOrder) => ({ ...pkg, sortOrder })) },
          addons: { create: (service.addons ?? []).map((addon, sortOrder) => ({ ...addon, photographerId, sortOrder })) },
        },
      });
      packages += service.packages.length;
      addons += service.addons?.length ?? 0;
    }
    if (demo.sharedAddons.length > 0) {
      await tx.addon.createMany({ data: demo.sharedAddons.map((addon, index) => ({ ...addon, photographerId, serviceId: null, sortOrder: 10 + index })) });
    }

    return { services: demo.services.length, packages, addons: addons + demo.sharedAddons.length };
  });
}

async function seedDemoBooking(prisma: PrismaClient, now: Date): Promise<DemoSummary['booking']> {
  const { token, hash } = generateAccessToken();

  const existing = await prisma.booking.findFirst({ where: { contactEmail: DEMO_CLIENT_EMAIL }, orderBy: { createdAt: 'asc' } });
  if (existing !== null) {
    await prisma.booking.update({
      where: { id: existing.id },
      data: { accessTokenHash: hash, accessTokenExpiresAt: accessTokenExpiry(now), accessTokenLastUsedAt: null },
    });
    return { reference: existing.reference, created: false, accessToken: token };
  }

  // The demo books from the first demo photographer's catalogue above; a
  // photographer of someone else's making under that handle is left alone.
  const handle = DEMO_PHOTOGRAPHERS[0]?.handle ?? '';
  const pkg = await prisma.package.findFirst({
    where: { nameEn: 'Standard', service: { slug: 'portraits' }, photographer: { handle, status: 'approved' } },
    include: { service: true, photographer: { include: { setting: true } } },
  });
  const rush = pkg && (await prisma.addon.findFirst({ where: { photographerId: pkg.photographerId, nameEn: 'Rush edit (48 hours)', serviceId: null } }));
  const setting = pkg?.photographer.setting ?? null;
  if (pkg === null || !rush || setting === null) return null;

  const rate = Number(pkg.service.bookingFeeRateOverride ?? setting.bookingFeeRate);
  const { bookingFeeRwf } = quoteBasket({ packagePriceRwf: pkg.priceRwf, addonPricesRwf: [rush.priceRwf], bookingFeeRate: rate });

  // An upcoming weekday at 10:00; the next one along if something already holds it.
  let day = firstWeekdayFrom(now, FIRST_DAY_AHEAD);
  for (let attempt = 1; ; attempt += 1) {
    const startsAt = new Date(day.getTime() + START_HOUR_UTC * 60 * MINUTE_MS);
    const endsAt = new Date(startsAt.getTime() + pkg.durationMinutes * MINUTE_MS);
    try {
      const reference = await prisma.$transaction(async (tx) => {
        const client = await tx.client.create({ data: { fullName: 'Demo Client', email: DEMO_CLIENT_EMAIL, phone: '+250788123456' } });
        const booking = await tx.booking.create({
          data: {
            reference: generateReference(now),
            clientId: client.id,
            photographerId: pkg.photographerId,
            contactName: client.fullName,
            contactEmail: DEMO_CLIENT_EMAIL,
            contactPhone: '+250788123456',
            serviceId: pkg.serviceId,
            packageId: pkg.id,
            serviceNameSnapshot: pkg.service.nameEn,
            packageNameSnapshot: pkg.nameEn,
            packagePriceRwf: pkg.priceRwf,
            packageDurationMinutes: pkg.durationMinutes,
            packagePhotoCount: pkg.photoCount,
            status: 'confirmed',
            startsAt,
            endsAt,
            bufferEndsAt: new Date(endsAt.getTime() + setting.bufferMinutes * MINUTE_MS),
            locationText: 'Kigali Convention Centre gardens, KG 2 Roundabout',
            partySize: 2,
            specialRequests: 'Demo booking created by the seed.',
            consentAt: now,
            bookingFeeRate: rate.toFixed(3),
            bookingFeeRwf,
            // The photographer's cancellation policy, frozen as booking creation freezes it (R1.8).
            clientCancelCutoffHours: setting.clientCancelCutoffHours,
            bookingFeeRefundableOnClientCancel: setting.bookingFeeRefundableOnClientCancel,
            confirmedAt: now,
            accessTokenHash: hash,
            accessTokenExpiresAt: accessTokenExpiry(now),
          },
        });
        await tx.bookingAddon.create({
          data: { bookingId: booking.id, addonId: rush.id, nameSnapshot: rush.nameEn, unitPriceRwf: rush.priceRwf, amountRwf: rush.priceRwf, stage: 'at_booking' },
        });
        const payment = await tx.payment.create({
          data: {
            bookingId: booking.id,
            kind: 'booking_fee',
            provider: 'flutterwave',
            method: 'momo_mtn',
            providerRef: `chg_demo_${booking.id.slice(0, 8)}`,
            amountRwf: bookingFeeRwf,
            status: 'succeeded',
            initiatedAt: new Date(now.getTime() - 2 * MINUTE_MS),
            settledAt: now,
          },
        });
        // A succeeded online fee earns, as every success does (R4.2), so the demo studio's earnings page has a line.
        await recordEarning(tx, payment.id);
        return booking.reference;
      });
      return { reference, created: true, accessToken: token };
    } catch (error) {
      if (!isSlotTaken(error) || attempt >= MAX_SLOT_ATTEMPTS) throw error;
      day = firstWeekdayFrom(day, 1);
    }
  }
}

/** Midnight UTC of the Kigali date `daysAhead` after `from`, moved on to a Monday-Friday. */
function firstWeekdayFrom(from: Date, daysAhead: number): Date {
  const kigali = new Date(from.getTime() + KIGALI_OFFSET_MS + daysAhead * DAY_MS);
  let day = Date.UTC(kigali.getUTCFullYear(), kigali.getUTCMonth(), kigali.getUTCDate());
  while ([0, 6].includes(new Date(day).getUTCDay())) day += DAY_MS;
  return new Date(day);
}
