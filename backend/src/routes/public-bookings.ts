import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { kigaliDateOf } from '../availability/engine.js';
import { createBooking } from '../booking/create.js';
import { normalizePhone } from '../booking/phone.js';
import { checkoutToken } from '../payments/checkout-link.js';
import { addonIds, kigaliDate, parseOrReject } from './validation.js';

/**
 * `POST /api/bookings` -- a visitor's chosen slot and filled form become a
 * `pending_payment` booking with its slot held (plan.md Task 13; spec §3.1
 * steps 6-8, P-04). Anonymous by design.
 *
 *   201 { booking: { reference, status, startsAt, endsAt, holdExpiresAt,
 *                    serviceName, packageName, packagePriceRwf, addons,
 *                    totalRwf, bookingFeeRate, bookingFeeRwf, sessionFeeRwf,
 *                    checkoutToken } }
 *   400 invalid_request      malformed: wrong types, a missing id or start
 *   422 validation_failed    a rule broken, naming the fields: a blank name, an
 *                            unreadable email or phone, no consent, a package
 *                            or add-on the public cannot book, a start the
 *                            calendar does not offer right now
 *   409 slot_taken           the slot was claimed between check and insert
 *   429 too_many_holds       the email already holds three unpaid slots
 *   429 rate_limited         too many requests from this IP or email (app.ts)
 *
 * This schema is the authority; the frontend's copy is a convenience (plan.md,
 * Stack decisions). Unknown keys -- a `totalRwf`, a `status` -- are stripped
 * unread: every column is built from a named field below, never spread from
 * the body.
 *
 * `checkoutToken` opens the booking's checkout, `/checkout/<reference>/<token>`
 * (plan.md Task 16); it is present when the payment routes are mounted.
 *
 * Consent must be `true`. Omitting it is a 422, not a 400, so the form can
 * mark the box (plan.md Task 13); `consent_at` records when it was given,
 * because Law N° 058/2021 requires consent to be demonstrable.
 */

const NAME_MAX_LENGTH = 200;
/** RFC 5321's limit on an address. */
const EMAIL_MAX_LENGTH = 320;
const PHONE_MAX_LENGTH = 40;
/** Developer defaults bounding free text, not spec values. */
const LOCATION_MAX_LENGTH = 500;
const SPECIAL_REQUESTS_MAX_LENGTH = 2000;
const PARTY_SIZE_MAX = 1000;

const emailFormat = z.email();

/**
 * Trimmed free text PostgreSQL can store. A `text` column cannot hold a NUL
 * character -- the insert fails with 22021 and would surface as a 500 -- so one
 * is refused here, by field, like any other rule the value breaks.
 */
const storableText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !value.includes('\u0000'), 'Contains a NUL character');

const bookingBody = z.object({
  packageId: z.guid(),
  addonIds,
  startsAt: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    // A start in a year the engine cannot compute (0000-0099) is a rule break.
    .refine((start) => kigaliDate.safeParse(kigaliDateOf(start)).success, 'Unsupported date'),
  fullName: storableText(1, NAME_MAX_LENGTH),
  email: z
    .string()
    .trim()
    .max(EMAIL_MAX_LENGTH)
    // A refinement, not z.email(): a mistyped address is the visitor's rule
    // break (422, marked on the form), not a malformed request (400).
    .refine((value) => emailFormat.safeParse(value).success, 'Invalid email')
    .transform((value) => value.toLowerCase()),
  phone: z
    .string()
    .max(PHONE_MAX_LENGTH)
    .refine((value) => normalizePhone(value) !== null, 'Invalid phone number')
    .transform((value) => normalizePhone(value) ?? value),
  location: storableText(1, LOCATION_MAX_LENGTH),
  partySize: z.int().min(1).max(PARTY_SIZE_MAX).nullable().default(null),
  specialRequests: storableText(0, SPECIAL_REQUESTS_MAX_LENGTH)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null),
  // `.default(false)` so an omitted box still reaches the refinement: zod skips
  // refinements on an absent optional value.
  consent: z
    .boolean()
    .default(false)
    .refine((given) => given, 'Consent is required'),
});

export function bookingsRouter(prisma: PrismaClient, now: () => Date, checkoutSecret?: string): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const body = parseOrReject(bookingBody, req.body, res);
    if (body === undefined) return;

    const result = await createBooking(
      { prisma, now },
      {
        packageId: body.packageId,
        addonIds: body.addonIds,
        startsAt: body.startsAt,
        fullName: body.fullName,
        email: body.email,
        phone: body.phone,
        locationText: body.location,
        partySize: body.partySize,
        specialRequests: body.specialRequests,
      },
    );

    if (result.status === 'invalid') {
      res.status(422).json({ error: 'validation_failed', fields: result.fields });
      return;
    }
    if (result.status === 'too_many_holds') {
      res.status(429).json({ error: 'too_many_holds' });
      return;
    }
    if (result.status === 'slot_taken') {
      res.status(409).json({ error: 'slot_taken' });
      return;
    }

    const { booking, basket } = result;
    res.status(201).json({
      booking: {
        reference: booking.reference,
        status: booking.status,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        holdExpiresAt: booking.holdExpiresAt?.toISOString() ?? null,
        serviceName: booking.serviceNameSnapshot,
        packageName: booking.packageNameSnapshot,
        packagePriceRwf: booking.packagePriceRwf,
        addons: basket.addons.map((addon) => ({ name: addon.nameEn, priceRwf: addon.priceRwf })),
        totalRwf: basket.quote.totalRwf,
        bookingFeeRate: booking.bookingFeeRate.toNumber(),
        bookingFeeRwf: booking.bookingFeeRwf,
        sessionFeeRwf: basket.quote.sessionFeeRwf,
        ...(checkoutSecret === undefined ? {} : { checkoutToken: checkoutToken(checkoutSecret, booking.reference) }),
      },
    });
  });

  return router;
}
