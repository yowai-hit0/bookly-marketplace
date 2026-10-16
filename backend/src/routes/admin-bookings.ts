import type { PrismaClient } from '@prisma/client';
import { type Response, Router } from 'express';
import { z } from 'zod';
import {
  type AdminActionResult,
  type RescheduleResult,
  cancelByAdmin,
  markCompleted,
  markNoShow,
  rescheduleBooking,
  resendAccessLink,
} from '../booking/admin-actions.js';
import { ADDON_MAX_QUANTITY, type AddonEditResult, addPostShootAddon, removePostShootAddon } from '../booking/addons.js';
import { type DeliveryResult, saveDelivery, sendDelivery } from '../booking/delivery.js';
import { NOTE_MAX_LENGTH, addNote, deleteNote } from '../booking/notes.js';
import { BOOKINGS_MAX_PAGE_SIZE, findBookings } from '../booking/admin-list.js';
import { type AdminBooking, adminBookingView, findAdminBooking } from '../booking/admin-view.js';
import { BOOKING_STAGES } from '../booking/stage.js';
import { BOOKING_STATUSES } from '../db/statuses.js';
import type { PaymentProviderId } from '../payments/provider.js';
import { recordRefund } from '../payments/refund.js';
import { type CashPaymentResult, recordCashPayment } from '../payments/cash.js';
import { type SessionFeeResult, requestSessionFee } from '../payments/session-fee.js';
import { kigaliDate, parseOrReject } from './validation.js';

/**
 * The bookings list, one booking, and everything the photographer does to it
 * (plan.md Task 19; spec §3.6, §6.11, §6.12, §6.16, §6.21). Mounted behind
 * `requireAdmin`, so every route here is his alone (spec §2.2).
 *
 *   GET  /bookings?stage=&status=&from=&to=&search=&page=&pageSize=   (`stage` since 2026-09-25; `status` still read; numbered pages since 2026-09-27)
 *        200 { bookings, total, page, pageSize, pageCount }
 *   GET  /bookings/:id                      200 { booking } | 404
 *   POST /bookings/:id/reschedule  { startsAt }
 *        200 { booking } | 404 | 409 slot_taken | 409 not_allowed | 422
 *   POST /bookings/:id/cancel      { reason? }        200 | 404 | 409
 *   POST /bookings/:id/complete                      200 | 404 | 409 not_allowed | 409 balance_due (money owed, 2026-09-27)
 *   POST /bookings/:id/no-show                       200 | 404 | 409
 *   POST /bookings/:id/resend-link                   200 | 404 | 409
 *   POST /payments/:id/refund      { reference, refundedAt? }
 *        200 { booking } | 404 | 409 not_refundable | 422
 *
 * And the post-shoot half (plan.md Task 20; spec §3.5 steps 2-3, §6.15):
 *
 *   POST   /bookings/:id/addons    { addonId, quantity? }
 *          200 { booking } | 404 | 409 not_allowed | 422
 *   DELETE /bookings/:id/addons/:addonId
 *          200 { booking } | 404 | 409 not_allowed | 409 already_paid
 *   POST   /bookings/:id/session-fee
 *          200 { booking } | 404 | 409 not_allowed | 409 nothing_to_pay |
 *          409 in_progress -- and 404 where no provider is configured, because
 *          a request nobody could pay is not worth sending.
 *   POST   /bookings/:id/payments/cash  { amountRwf, note? }   (item 7, 2026-09-27)
 *          200 { booking } | 404 | 409 not_allowed | 409 nothing_to_pay |
 *          409 over_outstanding | 409 in_progress | 422
 *
 * And the delivery (plan.md Task 21; spec §3.5 steps 5-7, §6.20):
 *
 *   PUT  /bookings/:id/delivery       { url, expiresOn?, note? }
 *        200 { booking } | 404 | 409 not_allowed | 422
 *   POST /bookings/:id/delivery/send  { recipient? }  200 | 404 | 409 not_allowed | 409 no_link | 422
 *   POST /bookings/:id/notes  { body, email? }  200 | 404 | 409 not_allowed | 422   (2026-09-25)
 *   DELETE /bookings/:id/notes/:noteId          200 | 404
 *
 * A 409 carries the booking as it now stands, so a screen acting on a stale
 * view -- a booking cancelled in another tab, a slot taken while he chose --
 * can show what is true rather than only what failed.
 */

export type AdminBookingsDeps = {
  prisma: PrismaClient;
  now: () => Date;
  /** The provider a session-fee request is opened against (spec §6.18); without
   *  one there is nothing for the client to pay through, so that route is not
   *  mounted at all. */
  paymentProviderId?: PaymentProviderId;
};

const rowId = z.guid();
/** Free text the client is shown when the photographer cancels (spec §3.6). */
const REASON_MAX_LENGTH = 1000;
const REFUND_REFERENCE_MAX_LENGTH = 100;
const NUL = String.fromCharCode(0);

/** Trimmed text PostgreSQL can store: a `text` column refuses a NUL character. */
const storableText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !value.includes(NUL), 'Contains a NUL character');

const listQuery = z.strictObject({
  /** Repeatable: `?status=confirmed&status=completed`. */
  status: z
    .union([z.enum(BOOKING_STATUSES), z.array(z.enum(BOOKING_STATUSES))])
    .optional()
    .transform((value) => (value === undefined ? undefined : [value].flat())),
  /** Repeatable: `?stage=in_progress&stage=needs_review` (booking/stage.ts). */
  stage: z
    .union([z.enum(BOOKING_STAGES), z.array(z.enum(BOOKING_STAGES))])
    .optional()
    .transform((value) => (value === undefined ? undefined : [value].flat())),
  from: kigaliDate.optional(),
  to: kigaliDate.optional(),
  search: z.string().trim().max(200).optional(),
  /** 1-based; past the end answers the last page. */
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(BOOKINGS_MAX_PAGE_SIZE).optional(),
});

const rescheduleBody = z.strictObject({
  startsAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
});

const cancelBody = z.strictObject({
  reason: storableText(1, REASON_MAX_LENGTH)
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});

const addonBody = z.strictObject({
  /** A catalogue add-on; what it costs is read from the catalogue, never sent. */
  addonId: z.guid(),
  quantity: z.int().min(1).max(ADDON_MAX_QUANTITY).default(1),
});

/** Free text under the link in the delivery email (`delivery_note`). */
const DELIVERY_NOTE_MAX_LENGTH = 2000;
const DELIVERY_URL_MAX_LENGTH = 2000;

const deliveryBody = z.strictObject({
  /**
   * The external host's link (spec A-7). A malformed URL is a 400; a
   * well-formed `http:` one is a 422, and the column CHECK refuses it again.
   */
  url: z
    .url()
    .max(DELIVERY_URL_MAX_LENGTH)
    // The parsed scheme, so `HTTPS://` counts as https too.
    .refine((value) => !URL.canParse(value) || new URL(value).protocol === 'https:', 'Must be an https URL'),
  /** Omitted, the API dates it: today plus `delivery_expiry_days` (spec A-8). */
  expiresOn: kigaliDate.optional(),
  note: storableText(1, DELIVERY_NOTE_MAX_LENGTH).nullable().optional(),
});

/**
 * Sending the photos: optionally to another address, for this one email only
 * (decided 2026-09-25). The booking's own contact email is never changed here.
 */
const emailFormat = z.email();
const deliverySendBody = z.strictObject({
  // A refinement, not z.email(): a mistyped address is a 422 the form can mark,
  // not a 400 (routes/validation.ts; as public-bookings.ts does).
  recipient: z
    .string()
    .trim()
    .max(254)
    .refine((value) => emailFormat.safeParse(value).success, 'Invalid email')
    .optional(),
});

/** A note to the client: plain text; emailed unless the photographer unticks it (2026-09-25). */
const noteBody = z.strictObject({
  body: storableText(1, NOTE_MAX_LENGTH),
  email: z.boolean().default(true),
});

/** Cash he was handed (item 7): up to what is owed, which the action checks. */
const CASH_NOTE_MAX_LENGTH = 500;
const cashBody = z.strictObject({
  amountRwf: z.int().min(1).max(2_147_483_647),
  note: storableText(1, CASH_NOTE_MAX_LENGTH)
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});

const refundBody = z.strictObject({
  /** The MoMo or bank reference he is recording (spec §6.16). */
  reference: storableText(1, REFUND_REFERENCE_MAX_LENGTH),
  refundedAt: z.iso
    .datetime({ offset: true })
    .optional()
    .transform((value) => (value === undefined ? undefined : new Date(value))),
});

export function adminBookingsRouter(deps: AdminBookingsDeps): Router {
  const { prisma, now, paymentProviderId } = deps;
  const router = Router();

  router.get('/bookings', async (req, res) => {
    const query = parseOrReject(listQuery, req.query, res);
    if (query === undefined) return;

    res.json(
      await findBookings(prisma, {
        ...(query.status === undefined ? {} : { statuses: query.status }),
        ...(query.stage === undefined ? {} : { stages: query.stage }),
        now: now(),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        ...(query.search === undefined ? {} : { search: query.search }),
        ...(query.page === undefined ? {} : { page: query.page }),
        ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
      }),
    );
  });

  router.get('/bookings/:id', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;

    const booking = await findAdminBooking(prisma, id);
    if (booking === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ booking: adminBookingView(booking, now()) });
  });

  router.post('/bookings/:id/reschedule', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const body = parseOrReject(rescheduleBody, req.body, res);
    if (body === undefined) return;

    await answer(prisma, now, res, await rescheduleBooking({ prisma, now }, id, body.startsAt), id);
  });

  router.post('/bookings/:id/cancel', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const body = parseOrReject(cancelBody, req.body ?? {}, res);
    if (body === undefined) return;

    await answer(prisma, now, res, await cancelByAdmin({ prisma, now }, id, body.reason), id);
  });

  router.post('/bookings/:id/complete', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    await answer(prisma, now, res, await markCompleted({ prisma, now }, id), id);
  });

  router.post('/bookings/:id/no-show', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    await answer(prisma, now, res, await markNoShow({ prisma, now }, id), id);
  });

  router.post('/bookings/:id/resend-link', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    await answer(prisma, now, res, await resendAccessLink({ prisma, now }, id), id);
  });

  // --- Post-shoot (Task 20) --------------------------------------------------

  router.post('/bookings/:id/addons', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const body = parseOrReject(addonBody, req.body, res);
    if (body === undefined) return;

    await answer(prisma, now, res, await addPostShootAddon({ prisma, now }, id, body), id);
  });

  router.delete('/bookings/:id/addons/:addonId', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const addonId = parseOrReject(rowId, req.params.addonId, res);
    if (addonId === undefined) return;

    await answer(prisma, now, res, await removePostShootAddon({ prisma, now }, id, addonId), id);
  });

  if (paymentProviderId !== undefined) {
    router.post('/bookings/:id/session-fee', async (req, res) => {
      const id = parseOrReject(rowId, req.params.id, res);
      if (id === undefined) return;

      await answer(prisma, now, res, await requestSessionFee({ prisma, now, providerId: paymentProviderId }, id), id);
    });
  }

  router.post('/bookings/:id/payments/cash', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const body = parseOrReject(cashBody, req.body, res);
    if (body === undefined) return;

    await answer(prisma, now, res, await recordCashPayment({ prisma, now }, id, body), id);
  });

  // --- Delivery (Task 21) ----------------------------------------------------

  router.put('/bookings/:id/delivery', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const body = parseOrReject(deliveryBody, req.body, res);
    if (body === undefined) return;

    await answer(
      prisma,
      now,
      res,
      await saveDelivery({ prisma, now }, id, {
        url: body.url,
        ...(body.expiresOn === undefined ? {} : { expiresOn: body.expiresOn }),
        ...(body.note === undefined ? {} : { note: body.note }),
      }),
      id,
    );
  });

  router.post('/bookings/:id/delivery/send', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;

    // No body at all is the ordinary send, as it always was.
    const body = parseOrReject(deliverySendBody, req.body ?? {}, res);
    if (body === undefined) return;

    await answer(prisma, now, res, await sendDelivery({ prisma, now }, id, { recipient: body.recipient }), id);
  });

  router.post('/bookings/:id/notes', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const body = parseOrReject(noteBody, req.body ?? {}, res);
    if (body === undefined) return;

    await answer(prisma, now, res, await addNote({ prisma, now }, id, body), id);
  });

  router.delete('/bookings/:id/notes/:noteId', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const noteId = parseOrReject(rowId, req.params.noteId, res);
    if (noteId === undefined) return;

    await answer(prisma, now, res, await deleteNote({ prisma, now }, id, noteId), id);
  });

  router.post('/payments/:id/refund', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const body = parseOrReject(refundBody, req.body, res);
    if (body === undefined) return;

    const result = await recordRefund(
      { prisma, now },
      id,
      { reference: body.reference, ...(body.refundedAt === undefined ? {} : { refundedAt: body.refundedAt }) },
    );
    if (result.status === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (result.status === 'not_refundable') {
      const payment = await prisma.payment.findUnique({ where: { id }, select: { bookingId: true } });
      if (payment === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await answerConflict(prisma, now, res, payment.bookingId, 'not_refundable');
      return;
    }

    const booking = await findAdminBooking(prisma, result.payment.bookingId);
    res.json({ booking: booking === null ? null : adminBookingView(booking, now()) });
  });

  return router;
}

/** Everything an action can answer with: the booking, or the reason it refused. */
type ActionAnswer = AdminActionResult | RescheduleResult | AddonEditResult | SessionFeeResult | CashPaymentResult | DeliveryResult;

/** One shape for every action: the booking as it now stands, or why not. */
async function answer(
  prisma: PrismaClient,
  now: () => Date,
  res: Response,
  result: ActionAnswer,
  bookingId: string,
): Promise<void> {
  if (result.status === 'ok') {
    res.json({ booking: adminBookingView(result.booking satisfies AdminBooking, now()) });
    return;
  }
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // Every other refusal is a 409 carrying the booking it refused.
  await answerConflict(prisma, now, res, bookingId, result.status);
}

/** A refusal, with the booking it refused: the screen that asked was out of date. */
async function answerConflict(
  prisma: PrismaClient,
  now: () => Date,
  res: Response,
  bookingId: string,
  error: string,
): Promise<void> {
  const booking = await findAdminBooking(prisma, bookingId);
  res.status(409).json({ error, booking: booking === null ? null : adminBookingView(booking, now()) });
}
