import type { PrismaClient } from '@prisma/client';
import { BOOKING_STATUSES, type BookingStatus } from '../db/statuses.js';
import { type PlatformPhotographer, findPlatformPhotographer } from '../photographers/moderation.js';
import { type SetupView, setupChecklist } from '../photographers/setup.js';
import { payableBalance } from '../payouts/ledger.js';
import { maskedDestination } from '../payouts/method.js';
import { METHOD_CHANGE_FLAG_HOURS } from '../payouts/payouts.js';
import { type PlatformSubscriptionView, platformSubscriptionOf } from '../subscriptions/views.js';
import { type AuditView, photographerActivity } from './audit.js';

/**
 * One photographer as the platform console's detail page shows them
 * (`GET /api/platform/photographers/:id`; Phase 9 P4): everything a platform
 * admin weighs before approving, suspending or paying them, in one read.
 * Read-only.
 *
 *   photographer   the list's row (login email, status, submission, handle
 *                  change, approval, suspension) plus who approved them
 *   profile        bio, contact, cover, districts, and EVERY category they are
 *                  tagged with, inactive ones marked (the public sees active
 *                  ones only; Phase 9 decision 3)
 *   setup          the studio's setup checklist as its rows stand now (R7.3)
 *   subscription   with every period, the status at the clock; null until approval
 *   payoutMethod   the current destination MASKED: network or bank, account
 *                  name and the last four digits, never the full number (the
 *                  payouts screen, which transfers the money, shows that), with
 *                  the 72-hour "changed recently" flag (R4.1)
 *   counts         bookings by status (every status, 0 included), services
 *   earnings       payable now (§3.9), in a draft, and paid out
 *   activity       the latest 20 rows of the platform's audit trail about them
 */

export type MaskedPayoutMethod = {
  id: string;
  kind: 'momo' | 'bank';
  /** The MoMo network (`mtn`, `airtel`) or the bank's name. */
  provider: string;
  accountName: string;
  /** The last four digits of the number: the full number stays on the payouts screen. */
  last4: string;
  createdAt: string;
};

export type PlatformPhotographerDetail = {
  photographer: PlatformPhotographer & { approvedBy: { id: string; email: string } | null };
  profile: {
    bio: string | null;
    contactPhone: string | null;
    whatsappPhone: string | null;
    contactEmail: string | null;
    coverImageUrl: string | null;
    districts: { code: string; name: string }[];
    categories: { slug: string; name: string; isActive: boolean }[];
  };
  setup: Pick<SetupView, 'items' | 'missing' | 'canSubmit'>;
  subscription: (PlatformSubscriptionView & { takingBookings: boolean }) | null;
  payoutMethod: MaskedPayoutMethod | null;
  /** The current method was saved within the last 72 hours (R4.1). False with none. */
  methodChangedRecently: boolean;
  counts: { bookings: Record<BookingStatus, number>; services: { total: number; active: number } };
  earnings: { payableRwf: number; inDraftRwf: number; paidOutRwf: number };
  activity: AuditView[];
};

export async function platformPhotographerDetail(prisma: PrismaClient, photographerId: string, now: Date): Promise<PlatformPhotographerDetail | null> {
  const photographer = await findPlatformPhotographer(prisma, photographerId);
  if (photographer === null) return null;

  const [row, districts, categories, setup, subscription, method, bookingCounts, services, activeServices, payableRwf, drafts, paid, activity] =
    await Promise.all([
      prisma.photographer.findUniqueOrThrow({
        where: { id: photographerId },
        select: {
          bio: true,
          contactPhone: true,
          whatsappPhone: true,
          contactEmail: true,
          coverImageUrl: true,
          approvedBy: { select: { id: true, email: true } },
        },
      }),
      prisma.photographerDistrict.findMany({
        where: { photographerId },
        select: { district: { select: { code: true, name: true } } },
        orderBy: [{ district: { sortOrder: 'asc' } }, { districtCode: 'asc' }],
      }),
      prisma.photographerCategory.findMany({
        where: { photographerId },
        select: { category: { select: { slug: true, nameEn: true, isActive: true } } },
        orderBy: [{ category: { sortOrder: 'asc' } }, { category: { nameEn: 'asc' } }, { category: { slug: 'asc' } }],
      }),
      setupChecklist(prisma, photographerId),
      platformSubscriptionOf(prisma, photographerId, now),
      prisma.payoutMethod.findFirst({ where: { photographerId, retiredAt: null } }),
      prisma.booking.groupBy({ by: ['status'], where: { photographerId }, _count: { _all: true } }),
      prisma.service.count({ where: { photographerId } }),
      prisma.service.count({ where: { photographerId, isActive: true } }),
      payableBalance(prisma, photographerId, now),
      prisma.payout.aggregate({ where: { photographerId, status: 'draft' }, _sum: { amountRwf: true } }),
      prisma.payout.aggregate({ where: { photographerId, status: 'paid' }, _sum: { amountRwf: true } }),
      photographerActivity(prisma, photographerId),
    ]);

  const bookings = Object.fromEntries(BOOKING_STATUSES.map((status) => [status, 0])) as Record<BookingStatus, number>;
  for (const group of bookingCounts) {
    if ((BOOKING_STATUSES as readonly string[]).includes(group.status)) bookings[group.status as BookingStatus] = group._count._all;
  }

  const { approvedBy, ...profile } = row;
  return {
    photographer: { ...photographer, approvedBy },
    profile: {
      ...profile,
      districts: districts.map((entry) => entry.district),
      categories: categories.map((entry) => ({ slug: entry.category.slug, name: entry.category.nameEn, isActive: entry.category.isActive })),
    },
    setup: { items: setup.items, missing: setup.missing, canSubmit: setup.canSubmit },
    subscription,
    payoutMethod:
      method === null
        ? null
        : (() => {
            const masked = maskedDestination(method);
            return { id: method.id, kind: masked.kind, provider: masked.provider, accountName: method.accountName, last4: masked.last4, createdAt: method.createdAt.toISOString() };
          })(),
    methodChangedRecently: method !== null && now.getTime() - method.createdAt.getTime() < METHOD_CHANGE_FLAG_HOURS * 3_600_000,
    counts: { bookings, services: { total: services, active: activeServices } },
    earnings: { payableRwf, inDraftRwf: drafts._sum.amountRwf ?? 0, paidOutRwf: paid._sum.amountRwf ?? 0 },
    activity,
  };
}
