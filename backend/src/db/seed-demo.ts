import type { PrismaClient } from '@prisma/client';
import { accessTokenExpiry, generateAccessToken } from '../booking/access-token.js';
import { generateReference } from '../booking/reference.js';
import { quoteBasket } from '../catalogue/quote.js';
import { isSlotTaken } from './errors.js';

/**
 * Demo data for a development database: a small catalogue and one confirmed
 * booking whose booking fee is paid, so the site, the admin and the client's
 * own booking page all have something to show.
 *
 * Never in production, and never over real data: the catalogue is created only
 * when there are no services at all, and the booking is recognised by its demo
 * email. The access token's plaintext is never stored (data-model_v2.md §5.9),
 * so every run gives the demo booking a fresh one -- the admin "resend link"
 * behaviour -- and hands it back to be printed. The previous link stops working.
 *
 * No email is queued: the demo address is not anyone's.
 */

export const DEMO_CLIENT_EMAIL = 'demo.client@example.com';

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
/** Kigali is UTC+2 all year. */
const KIGALI_OFFSET_MS = 2 * 60 * MINUTE_MS;
/** 10:00 in Kigali, inside the seeded Mon-Fri 09:00-17:00. */
const START_HOUR_UTC = 8;
const FIRST_DAY_AHEAD = 7;
const MAX_SLOT_ATTEMPTS = 14;

export type DemoSummary = {
  servicesCreated: number;
  packagesCreated: number;
  addonsCreated: number;
  booking: { reference: string; created: boolean; accessToken: string } | null;
};

export async function seedDemoData(prisma: PrismaClient, now: Date = new Date()): Promise<DemoSummary> {
  const catalogue = await seedCatalogue(prisma);
  return { ...catalogue, booking: await seedDemoBooking(prisma, now) };
}

async function seedCatalogue(prisma: PrismaClient): Promise<Omit<DemoSummary, 'booking'>> {
  if ((await prisma.service.count()) > 0) return { servicesCreated: 0, packagesCreated: 0, addonsCreated: 0 };

  await prisma.service.create({
    data: {
      slug: 'portraits',
      nameEn: 'Portraits',
      descriptionEn: 'Individual, couple or family portraits, outdoors in Kigali or at a place you choose.',
      sortOrder: 0,
      packages: {
        create: [
          { nameEn: 'Standard', descriptionEn: 'One location, one outfit.', priceRwf: 40_000, photoCount: 25, durationMinutes: 90, sortOrder: 0 },
          { nameEn: 'Extended', descriptionEn: 'Two locations, up to three outfits.', priceRwf: 70_000, photoCount: 50, durationMinutes: 150, sortOrder: 1 },
        ],
      },
      addons: { create: [{ nameEn: 'Extra outfit', priceRwf: 10_000, sortOrder: 0 }] },
    },
  });
  await prisma.service.create({
    data: {
      slug: 'events',
      nameEn: 'Events',
      descriptionEn: 'Birthdays, graduations and small celebrations, covered from start to finish.',
      sortOrder: 1,
      packages: {
        create: [{ nameEn: 'Half day', descriptionEn: 'Up to four hours of coverage.', priceRwf: 150_000, photoCount: 150, durationMinutes: 240, sortOrder: 0 }],
      },
    },
  });
  // Shared by every service.
  await prisma.addon.create({ data: { serviceId: null, nameEn: 'Rush edit (48 hours)', priceRwf: 15_000, sortOrder: 10 } });

  return { servicesCreated: 2, packagesCreated: 3, addonsCreated: 2 };
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

  // The demo books from the catalogue above; a catalogue of someone else's
  // making is left alone.
  const pkg = await prisma.package.findFirst({ where: { nameEn: 'Standard', service: { slug: 'portraits' } }, include: { service: true } });
  const rush = await prisma.addon.findFirst({ where: { nameEn: 'Rush edit (48 hours)', serviceId: null } });
  const setting = await prisma.setting.findUnique({ where: { id: 1 } });
  if (pkg === null || rush === null || setting === null) return null;

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
            confirmedAt: now,
            accessTokenHash: hash,
            accessTokenExpiresAt: accessTokenExpiry(now),
          },
        });
        await tx.bookingAddon.create({
          data: { bookingId: booking.id, addonId: rush.id, nameSnapshot: rush.nameEn, unitPriceRwf: rush.priceRwf, amountRwf: rush.priceRwf, stage: 'at_booking' },
        });
        await tx.payment.create({
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
