import type { Booking, PrismaClient } from '@prisma/client';
import { kigaliDateOf } from '../availability/engine.js';
import { findAvailability } from '../availability/query.js';
import { type ResolvedBasket, resolveBasket } from '../catalogue/basket.js';
import { SQLSTATE, sqlstateOf } from '../db/errors.js';
import { getPlatformSettings } from '../settings/index.js';
import { claimSlot } from './claim.js';
import { upsertClient } from './client.js';
import { generateReference } from './reference.js';

/**
 * Booking creation (plan.md Task 13; spec §3.1 steps 6-8, §6.13): a chosen
 * slot and a filled form become a `pending_payment` booking holding its slot
 * for `hold_minutes`, with every snapshot written and the booking fee frozen.
 *
 * Nothing the client sent is trusted beyond the ids and the form's text. The
 * basket is priced from the catalogue as it stands (the same read the snapshots
 * come from), the start must be one the availability engine offers this
 * package right now -- out of hours, inside the lead time, off the grid, in a
 * block or already occupied are all refused -- and the claim transaction is the
 * last word on a race the engine could not see (§6.1).
 *
 * Money is computed here and nowhere later: `booking_fee_rate` and
 * `booking_fee_rwf` are written at creation per data-model_v2.md §9.5, and
 * every amount after this is `bookingTotals()` over the snapshots.
 *
 * The photographer is the package's (marketplace-data-model.md §2.9): never a
 * value from the request. Their settings price the basket and size the buffer,
 * their calendar decides the start, and the claim locks and writes their
 * calendar alone. The hold is the platform's (`platform_setting.hold_minutes`):
 * checkout is payment infrastructure, not a photographer's choice. A package
 * whose photographer cannot be booked -- at the first read or inside the claim
 * -- is refused as a package that cannot be booked (brief decision 4).
 */

export type BookingRequest = {
  packageId: string;
  addonIds: readonly string[];
  startsAt: Date;
  fullName: string;
  /** Trimmed and lowercased: the client is matched on it. */
  email: string;
  /** Normalised by `normalizePhone`. */
  phone: string;
  locationText: string;
  /** Null is legitimate for a product shoot. */
  partySize: number | null;
  specialRequests: string | null;
};

export type CreateBookingResult =
  | { status: 'created'; booking: Booking; basket: ResolvedBasket }
  /** Fields that name something the public cannot book, or a start it is not offered. */
  | { status: 'invalid'; fields: ('packageId' | 'addonIds' | 'startsAt')[] }
  /** Lost the race inside the claim transaction (spec §6.1). */
  | { status: 'slot_taken' }
  /** The address already holds `MAX_LIVE_HOLDS_PER_EMAIL` unpaid slots (spec §6.22). */
  | { status: 'too_many_holds' };

export type CreateBookingDeps = {
  prisma: PrismaClient;
  now: () => Date;
  /** Injectable so a test can force a reference collision. */
  newReference?: (createdAt: Date) => string;
};

/** Collisions are one in millions; five in a row means something else is wrong. */
export const MAX_REFERENCE_ATTEMPTS = 5;

/**
 * Live `pending_payment` holds one email address may have at once (spec §6.22;
 * security review 2026-10-11, finding 2). Without it one visitor could hold
 * every slot on the calendar and never pay. Counted across the whole platform,
 * not per photographer: one address holding three photographers' afternoons is
 * the same abuse spread wider.
 */
export const MAX_LIVE_HOLDS_PER_EMAIL = 3;

/** Thrown inside the claim to roll it back; never escapes `createBooking`. */
class TooManyHolds extends Error {}

const MS_PER_MINUTE = 60_000;

export async function createBooking(deps: CreateBookingDeps, request: BookingRequest): Promise<CreateBookingResult> {
  const { prisma, newReference = generateReference } = deps;
  const now = deps.now();

  const basket = await resolveBasket(prisma, { packageId: request.packageId, addonIds: request.addonIds });
  if (!basket.ok) return { status: 'invalid', fields: basket.fields };
  const { package: pkg, addons, settings, bookingFeeRate, quote } = basket;
  const { holdMinutes } = await getPlatformSettings(prisma);

  // The engine decides, not the client: the start must be offered for this
  // package, in its photographer's calendar, on its Kigali date, at this moment.
  const date = kigaliDateOf(request.startsAt);
  const [day] = await findAvailability(prisma, {
    photographerId: pkg.photographerId,
    from: date,
    to: date,
    packageDurationMinutes: pkg.durationMinutes,
    now,
  });
  if (day === undefined || !day.starts.includes(request.startsAt.toISOString())) {
    return { status: 'invalid', fields: ['startsAt'] };
  }

  const startsAt = request.startsAt;
  const endsAt = new Date(startsAt.getTime() + pkg.durationMinutes * MS_PER_MINUTE);
  const bufferEndsAt = new Date(endsAt.getTime() + settings.bufferMinutes * MS_PER_MINUTE);

  for (let attempt = 1; ; attempt += 1) {
    const reference = newReference(now);
    try {
      const result = await claimSlot(
        prisma,
        pkg.photographerId,
        async (tx) => {
          // Counted inside the claim, behind a lock of its own: the claim's
          // lock is one photographer's, and the cap spans them all, so two
          // requests at once from one address -- for one photographer or two --
          // cannot both see two holds and take a fourth. Taken after the
          // calendar lock, always in that order, so the two never deadlock.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bookly.holds_per_email:' || lower(${request.email})))`;
          const [held] = await tx.$queryRaw<{ live: number }[]>`
            SELECT count(*)::int AS live
              FROM booking
             WHERE status = 'pending_payment'
               AND hold_expires_at > now()
               AND lower(contact_email) = lower(${request.email})`;
          if ((held?.live ?? 0) >= MAX_LIVE_HOLDS_PER_EMAIL) throw new TooManyHolds();
          return {
            reference,
            // Inside the claim's transaction: a lost race leaves no client row
            // behind, and no stale name or phone written over a real one.
            clientId: await upsertClient(tx, {
              fullName: request.fullName,
              email: request.email,
              phone: request.phone,
            }),
            contactName: request.fullName,
            contactEmail: request.email,
            contactPhone: request.phone,
            locale: 'en',
            serviceId: pkg.service.id,
            packageId: pkg.id,
            serviceNameSnapshot: pkg.service.nameEn,
            packageNameSnapshot: pkg.nameEn,
            packagePriceRwf: pkg.priceRwf,
            packageDurationMinutes: pkg.durationMinutes,
            packagePhotoCount: pkg.photoCount,
            startsAt,
            endsAt,
            bufferEndsAt,
            locationText: request.locationText,
            partySize: request.partySize,
            specialRequests: request.specialRequests,
            consentAt: now,
            // numeric(4,3), written as a three-place string so no float reaches it.
            bookingFeeRate: bookingFeeRate.toFixed(3),
            bookingFeeRwf: quote.bookingFeeRwf,
            addons: {
              create: addons.map((addon) => ({
                addonId: addon.id,
                nameSnapshot: addon.nameEn,
                unitPriceRwf: addon.priceRwf,
                quantity: 1,
                amountRwf: addon.priceRwf,
                stage: 'at_booking',
              })),
            },
          };
        },
        holdMinutes,
      );
      if (result.status === 'slot_taken') return { status: 'slot_taken' };
      if (result.status === 'not_bookable') return { status: 'invalid', fields: ['packageId'] };
      return { status: 'created', booking: result.booking, basket };
    } catch (error) {
      if (error instanceof TooManyHolds) return { status: 'too_many_holds' };
      // Inside this transaction the only unique index a write can hit is
      // `booking.reference`: the client upsert resolves its own conflict, and
      // a new booking's access token is still null. So a 23505 is a collision.
      if (sqlstateOf(error) === SQLSTATE.UNIQUE_VIOLATION && attempt < MAX_REFERENCE_ATTEMPTS) continue;
      throw error;
    }
  }
}
