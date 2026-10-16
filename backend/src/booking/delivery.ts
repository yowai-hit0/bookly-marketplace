import type { PrismaClient } from '@prisma/client';
import { kigaliDateOf } from '../availability/engine.js';
import { enqueue } from '../outbox/enqueue.js';
import { getSettings } from '../settings/index.js';
import { type AdminBooking, findAdminBooking } from './admin-view.js';

/**
 * Photo delivery (plan.md Task 21; spec §3.5 steps 5-7, §6.20, A-7, A-8).
 *
 * The files live on the photographer's own host -- Drive, Dropbox, WeTransfer
 * (A-7) -- and the site holds the link, the date it stops working, and the
 * branded email that hands both to the client. Nothing is uploaded here and
 * nothing is counted: under hybrid delivery a download happens entirely between
 * the client and that host, so a download count would be a number we invented
 * (data-model_v2.md §5.9).
 *
 * The expiry is a **Kigali calendar date**, which the client's page reads as
 * end of that day (spec §6.5, booking/client-view.ts): a link is live all
 * through its last day. It defaults to today plus `delivery_expiry_days` (90 by
 * A-8, a developer default the client never answered), and the photographer can
 * type any date he likes over it.
 *
 * Saving and sending are separate, because pasting a link is not the same act
 * as telling the client about it: he can paste, check it opens, and send
 * afterwards. Sending is repeatable -- a replaced link, an email that never
 * arrived (§6.20) -- and each send is its own message with its own dedupe key,
 * leaving every earlier one in the booking's history.
 */

export type DeliveryDeps = { prisma: PrismaClient; now: () => Date };

export type DeliveryResult =
  | { status: 'ok'; booking: AdminBooking }
  | { status: 'not_found' }
  /** Only a shoot that happened has photos to deliver (spec §3.5). */
  | { status: 'not_allowed' }
  /** Nothing to send: no link has been saved yet. */
  | { status: 'no_link' };

export type DeliveryEdit = {
  /** The external host's URL. https only, as the column's CHECK insists. */
  url: string;
  /** A Kigali date; omitted, it is today plus the configured lifetime. */
  expiresOn?: string;
  note?: string | null;
};

const MS_PER_DAY = 86_400_000;

/** Saves, or replaces, the link and the date it stops working. */
export async function saveDelivery(deps: DeliveryDeps, bookingId: string, edit: DeliveryEdit): Promise<DeliveryResult> {
  const booking = await findAdminBooking(deps.prisma, bookingId);
  if (booking === null) return { status: 'not_found' };
  if (booking.status !== 'completed') return { status: 'not_allowed' };

  // `HTTPS://` parses as https, but the column CHECK is the literal regex
  // `^https://`. What gets stored is the URL parser's own spelling, so a link
  // that is https by every reasonable reading is saved rather than rejected --
  // and the CHECK stays a backstop rather than a way to reach a 500.
  if (!URL.canParse(edit.url)) return { status: 'not_allowed' };
  const url = new URL(edit.url).toString();
  if (!url.startsWith('https://')) return { status: 'not_allowed' };

  const expiresOn = edit.expiresOn ?? (await defaultExpiry(deps));
  // Guarded on the status read above: a booking cancelled in the meantime keeps
  // no delivery it could no longer honour.
  const { count } = await deps.prisma.booking.updateMany({
    where: { id: booking.id, status: 'completed' },
    data: {
      deliveryUrl: url,
      // Prisma writes a `@db.Date` from the UTC date part (availability/engine.ts).
      deliveryExpiresOn: new Date(`${expiresOn}T00:00:00.000Z`),
      ...(edit.note === undefined ? {} : { deliveryNote: edit.note }),
    },
  });
  if (count === 0) return { status: 'not_allowed' };

  // `delivery_sent_at` is left exactly as it was: it records when the client
  // was last written to, and replacing a link does not unsend that email. What
  // the client's page then shows is the link that works (spec §6.20).
  return reload(deps, booking.id);
}

/** Sends the branded delivery email, and records that it went (spec §3.5 step 6). */
export async function sendDelivery(
  deps: DeliveryDeps,
  bookingId: string,
  /** Another address for this one email only; the booking's contact email stays (decided 2026-09-25). */
  options: { recipient?: string | undefined } = {},
): Promise<DeliveryResult> {
  const booking = await findAdminBooking(deps.prisma, bookingId);
  if (booking === null) return { status: 'not_found' };
  if (booking.status !== 'completed') return { status: 'not_allowed' };
  if (booking.deliveryUrl === null) return { status: 'no_link' };

  const sentAt = deps.now();
  const expiresOn = booking.deliveryExpiresOn ?? new Date(`${await defaultExpiry(deps)}T00:00:00.000Z`);

  const stamped = await deps.prisma.$transaction(async (tx) => {
    const { count } = await tx.booking.updateMany({
      where: { id: booking.id, status: 'completed' },
      data: { deliverySentAt: sentAt, deliveryExpiresOn: expiresOn },
    });
    // Guarded on the status read above. A booking cancelled while this was
    // waiting on its row must not be told its photos are ready: the message
    // and the stamp commit together, or neither does.
    if (count === 0) return false;

    await enqueue(tx, {
      kind: 'email',
      template: 'photo_delivery',
      recipient: options.recipient ?? booking.contactEmail,
      bookingId: booking.id,
      // Each send is its own message and stays in the history (spec §6.20). Two
      // sends inside one millisecond are the same click twice, and collapse.
      dedupeKey: `email:photo_delivery:${booking.id}:${sentAt.toISOString()}`,
      payload: {
        locale: booking.locale,
        reference: booking.reference,
        clientName: booking.contactName,
        serviceName: booking.serviceNameSnapshot,
        // The one link in any of our emails that does not point at the site.
        deliveryUrl: booking.deliveryUrl,
        // As text, so the client can read the date without following anything.
        expiresOn: expiresOn.toISOString().slice(0, 10),
        note: booking.deliveryNote,
      },
    });
    return true;
  });

  if (!stamped) return { status: 'not_allowed' };
  return reload(deps, booking.id);
}

/** Today plus the configured lifetime, in Kigali (spec A-8: 90 days). */
async function defaultExpiry(deps: DeliveryDeps): Promise<string> {
  const { deliveryExpiryDays } = await getSettings(deps.prisma);
  const today = kigaliDateOf(deps.now());
  return kigaliDateOf(new Date(Date.parse(`${today}T00:00:00.000Z`) + deliveryExpiryDays * MS_PER_DAY));
}

/** The booking as it now stands, which is what every action answers with. */
async function reload(deps: DeliveryDeps, bookingId: string): Promise<DeliveryResult> {
  const booking = await findAdminBooking(deps.prisma, bookingId);
  return booking === null ? { status: 'not_found' } : { status: 'ok', booking };
}
