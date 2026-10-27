import type { AppUser, PrismaClient } from '@prisma/client';
import { kigaliDateOf } from '../availability/engine.js';
import { cancellationDeadline } from '../booking/client-view.js';
import { bookingTotals } from '../booking/totals.js';
import { type AccountPaymentRow, paymentRow } from './payments.js';

/**
 * "Export my data" (marketplace-spec.md R8.3, T8.4; Phase 8 unit B7): the
 * account, its contact records, its bookings and their payments, as one JSON
 * document. Exactly the signed-in user's own records -- the scope of the
 * dashboard (`client.user_id`), and nothing a photographer keeps for
 * themselves.
 *
 * An explicit allowlist, like every view of a user (auth/public-user.ts): a
 * column added later stays out until someone chooses to export it.
 *
 * Out, on purpose:
 * - every hash, token and token expiry, the Google subject (whether the account
 *   has a Google sign-in is in; which Google account is not), the token version
 *   and the lockout state;
 * - row ids, which name nothing to the client and address everything to the API;
 * - the photographer's private records: a cash payment's note, the provider's
 *   own references and failure text, deleted notes (no longer shown to the
 *   client), and the outbox (the copies of the client's emails hold link tokens);
 * - another client's anything: a booking is in only through the account's own
 *   client rows.
 *
 * In: what the client gave or was shown -- the booking snapshots (name, email,
 * phone, location, requests), the consent moment, the add-on lines, the money
 * from `bookingTotals()`, the cancellation terms, the delivery link while it
 * is live, the photographer's notes to them, and every payment on their
 * bookings (all statuses: it is their record, attempts included).
 */

export const EXPORT_FORMAT_VERSION = 1;

export type AccountExport = {
  format: 'bookly-account-export';
  version: number;
  exportedAt: string;
  account: {
    email: string;
    fullName: string | null;
    phone: string | null;
    emailVerifiedAt: string | null;
    createdAt: string;
    lastLoginAt: string | null;
    hasPassword: boolean;
    hasGoogle: boolean;
    pendingEmail: string | null;
  };
  /** The contact records bookings were made under (one per address), as they now stand. */
  contacts: { fullName: string; email: string; phone: string | null }[];
  bookings: ExportedBooking[];
  payments: AccountPaymentRow[];
};

export type ExportedBooking = {
  reference: string;
  photographer: { handle: string; displayName: string };
  status: string;
  createdAt: string;
  startsAt: string;
  endsAt: string;
  contact: { name: string; email: string; phone: string };
  serviceName: string;
  packageName: string;
  packagePriceRwf: number;
  packagePhotoCount: number;
  packageDurationMinutes: number;
  locationText: string;
  partySize: number | null;
  specialRequests: string | null;
  consentAt: string;
  bookingFeeRwf: number;
  addons: { name: string; quantity: number; unitPriceRwf: number; amountRwf: number; stage: string; addedAt: string }[];
  totals: ReturnType<typeof bookingTotals>;
  cancellation: { deadline: string; bookingFeeRefundable: boolean };
  confirmedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  rescheduledAt: string | null;
  originalStartsAt: string | null;
  delivery: { url: string | null; expiresOn: string | null; expired: boolean; sentAt: string | null; note: string | null } | null;
  notes: { body: string; createdAt: string }[];
};

export async function exportAccount(prisma: PrismaClient, user: AppUser, now: Date): Promise<AccountExport> {
  const [contacts, bookings, payments] = await prisma.$transaction([
    prisma.client.findMany({ where: { userId: user.id }, select: { fullName: true, email: true, phone: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.booking.findMany({
      where: { client: { userId: user.id } },
      include: {
        photographer: { select: { handle: true, displayName: true } },
        addons: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        payments: true,
        notes: { where: { deletedAt: null }, select: { body: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
    }),
    prisma.payment.findMany({
      where: { booking: { client: { userId: user.id } } },
      include: {
        booking: {
          select: { reference: true, startsAt: true, endsAt: true, serviceNameSnapshot: true, packageNameSnapshot: true, photographer: { select: { handle: true, displayName: true } } },
        },
      },
      orderBy: [{ initiatedAt: 'desc' }, { id: 'desc' }],
    }),
  ]);

  const pendingLive = user.pendingEmail !== null && user.pendingEmailExpiresAt !== null && user.pendingEmailExpiresAt > now;
  return {
    format: 'bookly-account-export',
    version: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    account: {
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      hasPassword: user.passwordHash !== null,
      hasGoogle: user.googleSub !== null,
      pendingEmail: pendingLive ? user.pendingEmail : null,
    },
    contacts,
    bookings: bookings.map((booking) => {
      const expiresOn = booking.deliveryExpiresOn === null ? null : booking.deliveryExpiresOn.toISOString().slice(0, 10);
      const expired = expiresOn !== null && kigaliDateOf(now) > expiresOn;
      return {
        reference: booking.reference,
        photographer: booking.photographer,
        status: booking.status,
        createdAt: booking.createdAt.toISOString(),
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        contact: { name: booking.contactName, email: booking.contactEmail, phone: booking.contactPhone },
        serviceName: booking.serviceNameSnapshot,
        packageName: booking.packageNameSnapshot,
        packagePriceRwf: booking.packagePriceRwf,
        packagePhotoCount: booking.packagePhotoCount,
        packageDurationMinutes: booking.packageDurationMinutes,
        locationText: booking.locationText,
        partySize: booking.partySize,
        specialRequests: booking.specialRequests,
        consentAt: booking.consentAt.toISOString(),
        bookingFeeRwf: booking.bookingFeeRwf,
        addons: booking.addons.map((addon) => ({
          name: addon.nameSnapshot,
          quantity: addon.quantity,
          unitPriceRwf: addon.unitPriceRwf,
          amountRwf: addon.amountRwf,
          stage: addon.stage,
          addedAt: addon.createdAt.toISOString(),
        })),
        totals: bookingTotals(booking, booking.addons, booking.payments),
        cancellation: { deadline: cancellationDeadline(booking).toISOString(), bookingFeeRefundable: booking.bookingFeeRefundableOnClientCancel },
        confirmedAt: booking.confirmedAt?.toISOString() ?? null,
        completedAt: booking.completedAt?.toISOString() ?? null,
        cancelledAt: booking.cancelledAt?.toISOString() ?? null,
        cancellationReason: booking.cancellationReason,
        rescheduledAt: booking.rescheduledAt?.toISOString() ?? null,
        originalStartsAt: booking.originalStartsAt?.toISOString() ?? null,
        // The booking page's rule: nothing until the photos are sent (a link the
        // photographer has saved but not sent is theirs still), and the link
        // only while it is live.
        delivery:
          booking.deliverySentAt === null || booking.deliveryUrl === null
            ? null
            : { url: expired ? null : booking.deliveryUrl, expiresOn, expired, sentAt: booking.deliverySentAt.toISOString(), note: booking.deliveryNote },
        notes: booking.notes.map((note) => ({ body: note.body, createdAt: note.createdAt.toISOString() })),
      } satisfies ExportedBooking;
    }),
    payments: payments.flatMap((payment) => (payment.booking === null ? [] : [paymentRow(payment, payment.booking)])),
  };
}
