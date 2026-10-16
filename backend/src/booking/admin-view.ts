import type { Prisma, PrismaClient } from '@prisma/client';
import { type BookingStage, bookingStage } from './stage.js';
import { type BookingTotals, bookingTotals } from './totals.js';

/**
 * A booking as the photographer sees it (plan.md Task 19; spec §3.6, P-07,
 * P-13, P-22, P-28): everything about it, including what a client never sees --
 * their contact details, every payment attempt, and every message the system
 * sent about the booking.
 *
 * Money is `bookingTotals()` (data-model_v2.md §6.1) and nothing else, so the
 * admin screen and the client's own page can never disagree about what is
 * owed. The access token is not here in any form: its hash would still be a
 * credential to anyone who could replay it, and the plaintext no longer exists.
 */

export const ADMIN_BOOKING_INCLUDE = {
  client: { select: { id: true, fullName: true, email: true, phone: true, anonymizedAt: true } },
  addons: { orderBy: [{ stage: 'asc' }, { createdAt: 'asc' }] },
  payments: { orderBy: { initiatedAt: 'asc' } },
  outbox: { orderBy: { createdAt: 'asc' } },
  notes: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } },
} satisfies Prisma.BookingInclude;

export type AdminBooking = Prisma.BookingGetPayload<{ include: typeof ADMIN_BOOKING_INCLUDE }>;

export type AdminBookingView = {
  id: string;
  reference: string;
  status: string;
  /** The admin's display stage (`stage.ts`). */
  stage: BookingStage;
  locale: string;
  client: { id: string; fullName: string; email: string; phone: string | null; anonymized: boolean };
  contact: { name: string; email: string; phone: string };
  service: { id: string; name: string };
  package: { id: string; name: string; priceRwf: number; durationMinutes: number; photoCount: number };
  schedule: {
    startsAt: string;
    endsAt: string;
    bufferEndsAt: string;
    holdExpiresAt: string | null;
    originalStartsAt: string | null;
    rescheduledAt: string | null;
  };
  details: { locationText: string; partySize: number | null; specialRequests: string | null; consentAt: string };
  addons: { id: string; name: string; unitPriceRwf: number; quantity: number; amountRwf: number; stage: string; canRemove: boolean }[];
  money: { bookingFeeRate: number; bookingFeeRwf: number; totals: BookingTotals };
  payments: AdminPaymentView[];
  lifecycle: { confirmedAt: string | null; completedAt: string | null; cancelledAt: string | null; cancellationReason: string | null };
  access: { hasLink: boolean; expiresAt: string | null; lastUsedAt: string | null };
  delivery: { url: string | null; expiresOn: string | null; sentAt: string | null; note: string | null };
  /** The per-booking message history (data-model_v2.md §5.13, spec P-28). */
  messages: { id: string; kind: string; template: string | null; recipient: string | null; status: string; attempts: number; lastError: string | null; createdAt: string; completedAt: string | null }[];
  /** The photographer's notes to the client, newest first; deleted ones are gone from here (2026-09-25). */
  notes: { id: string; body: string; emailed: boolean; createdAt: string }[];
  /** What the photographer may do to it now. The API enforces these again. */
  actions: {
    canReschedule: boolean;
    canCancel: boolean;
    canComplete: boolean;
    canMarkNoShow: boolean;
    canResendLink: boolean;
    /** Post-shoot add-ons, once the shoot is done (spec §3.5 step 2). */
    canEditAddons: boolean;
    /** There is money left to ask for, on a booking that can still owe it. */
    canRequestSessionFee: boolean;
    /** The delivery link and its expiry, once the shoot has happened (spec §3.5 step 5). */
    canEditDelivery: boolean;
    /** There is a link to send (spec §3.5 step 6, §6.20). */
    canSendDelivery: boolean;
  };
};

export type AdminPaymentView = {
  id: string;
  kind: string;
  provider: string;
  ourRef: string;
  providerRef: string | null;
  method: string | null;
  amountRwf: number;
  status: string;
  failureReason: string | null;
  initiatedAt: string;
  settledAt: string | null;
  refundedAt: string | null;
  refundReference: string | null;
  /** What the photographer typed with a cash payment (item 7, 2026-09-27). */
  note: string | null;
  /** Refunding is recording what the photographer paid back by hand (spec §6.16). */
  canRecordRefund: boolean;
};

export async function findAdminBooking(prisma: PrismaClient, id: string): Promise<AdminBooking | null> {
  return prisma.booking.findUnique({ where: { id }, include: ADMIN_BOOKING_INCLUDE });
}

export function adminBookingView(booking: AdminBooking, now: Date): AdminBookingView {
  const shootStarted = booking.startsAt <= now;
  const totals = bookingTotals(booking, booking.addons, booking.payments);
  // Add-ons are for the shoot itself: open once it has begun and while the
  // booking is `confirmed`, locked once it is `completed` (2026-09-27). The
  // photos are for after: delivery still needs `completed`.
  const editableAddons = booking.status === 'confirmed' && shootStarted;
  const deliverable = booking.status === 'completed';

  return {
    id: booking.id,
    reference: booking.reference,
    status: booking.status,
    stage: bookingStage(booking, now, 'admin'),
    locale: booking.locale,
    client: {
      id: booking.client.id,
      fullName: booking.client.fullName,
      email: booking.client.email,
      phone: booking.client.phone,
      anonymized: booking.client.anonymizedAt !== null,
    },
    contact: { name: booking.contactName, email: booking.contactEmail, phone: booking.contactPhone },
    service: { id: booking.serviceId, name: booking.serviceNameSnapshot },
    package: {
      id: booking.packageId,
      name: booking.packageNameSnapshot,
      priceRwf: booking.packagePriceRwf,
      durationMinutes: booking.packageDurationMinutes,
      photoCount: booking.packagePhotoCount,
    },
    schedule: {
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      bufferEndsAt: booking.bufferEndsAt.toISOString(),
      holdExpiresAt: booking.holdExpiresAt?.toISOString() ?? null,
      originalStartsAt: booking.originalStartsAt?.toISOString() ?? null,
      rescheduledAt: booking.rescheduledAt?.toISOString() ?? null,
    },
    details: {
      locationText: booking.locationText,
      partySize: booking.partySize,
      specialRequests: booking.specialRequests,
      consentAt: booking.consentAt.toISOString(),
    },
    addons: booking.addons.map((addon) => ({
      id: addon.id,
      name: addon.nameSnapshot,
      unitPriceRwf: addon.unitPriceRwf,
      quantity: addon.quantity,
      amountRwf: addon.amountRwf,
      stage: addon.stage,
      // Only a post-shoot line nobody has paid for yet; the API checks again.
      canRemove: editableAddons && addon.stage === 'post_shoot' && totals.grandTotalRwf - addon.amountRwf >= totals.collectedRwf,
    })),
    money: {
      bookingFeeRate: booking.bookingFeeRate.toNumber(),
      bookingFeeRwf: booking.bookingFeeRwf,
      totals,
    },
    payments: booking.payments.map(adminPaymentView),
    lifecycle: {
      confirmedAt: booking.confirmedAt?.toISOString() ?? null,
      completedAt: booking.completedAt?.toISOString() ?? null,
      cancelledAt: booking.cancelledAt?.toISOString() ?? null,
      cancellationReason: booking.cancellationReason,
    },
    access: {
      hasLink: booking.accessTokenHash !== null,
      expiresAt: booking.accessTokenExpiresAt?.toISOString() ?? null,
      lastUsedAt: booking.accessTokenLastUsedAt?.toISOString() ?? null,
    },
    delivery: {
      url: booking.deliveryUrl,
      expiresOn: booking.deliveryExpiresOn === null ? null : booking.deliveryExpiresOn.toISOString().slice(0, 10),
      sentAt: booking.deliverySentAt?.toISOString() ?? null,
      note: booking.deliveryNote,
    },
    notes: booking.notes.map((note) => ({ id: note.id, body: note.body, emailed: note.emailed, createdAt: note.createdAt.toISOString() })),
    messages: booking.outbox.map((message) => ({
      id: message.id,
      kind: message.kind,
      template: message.template,
      recipient: message.recipient,
      status: message.status,
      attempts: message.attempts,
      lastError: message.lastError,
      createdAt: message.createdAt.toISOString(),
      completedAt: message.completedAt?.toISOString() ?? null,
    })),
    actions: {
      canReschedule: booking.status === 'confirmed',
      canCancel: booking.status === 'confirmed',
      // Only once the shoot has begun (spec §3.5), and only with nothing owed:
      // "completed" means paid (2026-09-27). With money owed the page shows the
      // button disabled and says how much.
      canComplete: booking.status === 'confirmed' && shootStarted && totals.outstandingRwf === 0,
      canMarkNoShow: booking.status === 'confirmed' && shootStarted,
      // A booking that was confirmed once has a client to send a link to.
      canResendLink: booking.confirmedAt !== null,
      canEditAddons: editableAddons,
      // The same rule opens "Record cash payment" (item 7): money is owed on
      // a booking that still stands.
      canRequestSessionFee: totals.outstandingRwf > 0 && (booking.status === 'confirmed' || booking.status === 'completed'),
      canEditDelivery: deliverable,
      canSendDelivery: deliverable && booking.deliveryUrl !== null,
    },
  };
}

function adminPaymentView(payment: AdminBooking['payments'][number]): AdminPaymentView {
  return {
    id: payment.id,
    kind: payment.kind,
    provider: payment.provider,
    ourRef: payment.ourRef,
    providerRef: payment.providerRef,
    method: payment.method,
    amountRwf: payment.amountRwf,
    status: payment.status,
    failureReason: payment.failureReason,
    initiatedAt: payment.initiatedAt.toISOString(),
    settledAt: payment.settledAt?.toISOString() ?? null,
    refundedAt: payment.refundedAt?.toISOString() ?? null,
    refundReference: payment.refundReference,
    note: payment.note,
    canRecordRefund: payment.status === 'refund_due',
  };
}
