import type { Prisma, PrismaClient } from '@prisma/client';
import { PAYMENT_ATTEMPT_WINDOW_SECONDS } from '../payments/initiate.js';
import { isBookable } from '../photographers/bookable.js';
import { getPlatformSettings } from '../settings/index.js';
import { type SubscriptionStatus, graceEndsAt, statusAt } from './plan.js';

/**
 * What the studio's subscription page and the platform's subscriptions list
 * show (marketplace-spec.md R5.2, R7.2, R9.3). Read-only.
 *
 * `status` is the status AT THE CLOCK (subscriptions/plan.ts `statusAt`), not the
 * job's last record, so the page is right even when the job is late -- the same
 * reason bookability compares the period's end directly (R5.4). `takingBookings`
 * is the bookability rule itself (photographers/bookable.ts), which also needs
 * the photographer approved.
 */

export type PeriodView = {
  id: string;
  kind: 'trial' | 'paid';
  /** Null for the trial. */
  planInterval: 'monthly' | 'yearly' | null;
  /** 0 for the trial. */
  priceRwf: number;
  startsAt: string;
  endsAt: string;
  /** When its payment succeeded; null for the trial. */
  paidAt: string | null;
};

/** A subscription payment as the photographer may see it. Failure reasons stay internal. */
export type SubscriptionPaymentView = {
  ourRef: string;
  status: string;
  planInterval: 'monthly' | 'yearly';
  amountRwf: number;
  method: string | null;
  /** declined | unavailable, for a failed payment; null otherwise. */
  failure: 'declined' | 'unavailable' | null;
  initiatedAt: string;
  settledAt: string | null;
};

export type StudioSubscriptionView = {
  subscription: {
    id: string;
    status: SubscriptionStatus;
    currentPeriodEndsAt: string;
    /** When `past_due` becomes `expired` for the current end. */
    graceEndsAt: string;
    takingBookings: boolean;
    /** The period `now` falls in; null once the last one has ended. */
    currentPeriod: PeriodView | null;
    /** Every period, newest first. */
    periods: PeriodView[];
    /** A payment still waiting on the payer, which blocks another (R5.2). */
    paymentInProgress: SubscriptionPaymentView | null;
  } | null;
  /** The plan's prices, whole RWF, from `platform_setting` (R5.1). */
  prices: { monthly: number; yearly: number };
  /** The methods on offer (payments/routing.ts, R3.1): MoMo only while cards are deferred. */
  methods: readonly string[];
  graceDays: number;
};

const PERIOD_SELECT = {
  id: true,
  kind: true,
  planInterval: true,
  priceRwf: true,
  startsAt: true,
  endsAt: true,
  voidedAt: true,
  payment: { select: { settledAt: true } },
} satisfies Prisma.SubscriptionPeriodSelect;

type PeriodRow = Prisma.SubscriptionPeriodGetPayload<{ select: typeof PERIOD_SELECT }>;

const PAYMENT_SELECT = {
  ourRef: true,
  status: true,
  planInterval: true,
  amountRwf: true,
  method: true,
  failureReason: true,
  initiatedAt: true,
  settledAt: true,
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

/** The signed-in photographer's subscription page (R5.2, R7.2). */
export async function studioSubscription(
  prisma: PrismaClient,
  photographerId: string,
  now: Date,
  methods: readonly string[],
): Promise<StudioSubscriptionView> {
  const [settings, photographer] = await Promise.all([
    getPlatformSettings(prisma),
    prisma.photographer.findUniqueOrThrow({
      where: { id: photographerId },
      select: {
        status: true,
        subscription: { select: { id: true, status: true, currentPeriodEndsAt: true, periods: { select: PERIOD_SELECT, orderBy: { startsAt: 'desc' } } } },
      },
    }),
  ]);
  const base = {
    prices: { monthly: settings.subscriptionMonthlyPriceRwf, yearly: settings.subscriptionYearlyPriceRwf },
    methods,
    graceDays: settings.subscriptionGraceDays,
  };
  const subscription = photographer.subscription;
  if (subscription === null) return { subscription: null, ...base };

  const periods = subscription.periods.filter((period) => period.voidedAt === null);
  const current = periods.find((period) => period.startsAt.getTime() <= now.getTime() && now.getTime() < period.endsAt.getTime());
  return {
    subscription: {
      id: subscription.id,
      status: statusAt(subscription.status, subscription.currentPeriodEndsAt, now, settings.subscriptionGraceDays),
      currentPeriodEndsAt: subscription.currentPeriodEndsAt.toISOString(),
      graceEndsAt: graceEndsAt(subscription.currentPeriodEndsAt, settings.subscriptionGraceDays).toISOString(),
      takingBookings: isBookable(photographer, subscription, now),
      currentPeriod: current === undefined ? null : periodView(current),
      periods: periods.map(periodView),
      paymentInProgress: await paymentInProgress(prisma, subscription.id),
    },
    ...base,
  };
}

/**
 * The newest payment still in progress -- `initiated` or `pending`, inside the
 * attempt window on the database clock -- exactly what blocks a new one
 * (subscriptions/payments.ts).
 */
async function paymentInProgress(prisma: PrismaClient, subscriptionId: string): Promise<SubscriptionPaymentView | null> {
  const waiting = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM payment
     WHERE subscription_id = ${subscriptionId}::uuid
       AND status IN ('initiated', 'pending')
       AND initiated_at > now() - make_interval(secs => ${PAYMENT_ATTEMPT_WINDOW_SECONDS}::double precision)
     ORDER BY initiated_at DESC
     LIMIT 1`;
  const id = waiting[0]?.id;
  if (id === undefined) return null;
  return paymentView(await prisma.payment.findUniqueOrThrow({ where: { id }, select: PAYMENT_SELECT }));
}

export type StudioSubscriptionPayment = {
  payment: SubscriptionPaymentView;
  subscription: { status: SubscriptionStatus; currentPeriodEndsAt: string; takingBookings: boolean };
};

/**
 * One of the signed-in photographer's subscription payments, by `our_ref`, for
 * the page to poll after a prompt. Another photographer's, a booking's, and an
 * unknown reference are all null (404): scoped through the subscription's
 * photographer, from the token (R1.4).
 */
export async function studioSubscriptionPayment(
  prisma: PrismaClient,
  photographerId: string,
  ourRef: string,
  now: Date,
): Promise<StudioSubscriptionPayment | null> {
  const payment = await prisma.payment.findFirst({
    where: { ourRef, kind: 'subscription', subscription: { photographerId } },
    select: {
      ...PAYMENT_SELECT,
      subscription: { select: { status: true, currentPeriodEndsAt: true, photographer: { select: { status: true } } } },
    },
  });
  if (payment === null || payment.subscription === null) return null;
  const { subscriptionGraceDays } = await getPlatformSettings(prisma);
  const { subscription } = payment;
  return {
    payment: paymentView(payment),
    subscription: {
      status: statusAt(subscription.status, subscription.currentPeriodEndsAt, now, subscriptionGraceDays),
      currentPeriodEndsAt: subscription.currentPeriodEndsAt.toISOString(),
      takingBookings: isBookable(subscription.photographer, subscription, now),
    },
  };
}

export type PlatformSubscriptionView = {
  id: string;
  photographer: { id: string; handle: string; displayName: string; status: string };
  status: SubscriptionStatus;
  currentPeriodEndsAt: string;
  graceEndsAt: string;
  createdAt: string;
  /** Every period, newest first: the subscription's history (R9.3). */
  periods: PeriodView[];
};

/**
 * Every subscription, or those in one status AT THE CLOCK (R9.3), the soonest
 * to end first. One per photographer, so the list is as long as the
 * photographers who were ever approved.
 */
export async function listPlatformSubscriptions(prisma: PrismaClient, now: Date, status?: SubscriptionStatus): Promise<PlatformSubscriptionView[]> {
  const [{ subscriptionGraceDays }, rows] = await Promise.all([
    getPlatformSettings(prisma),
    prisma.subscription.findMany({
      orderBy: [{ currentPeriodEndsAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        status: true,
        currentPeriodEndsAt: true,
        createdAt: true,
        photographer: { select: { id: true, handle: true, displayName: true, status: true } },
        periods: { select: PERIOD_SELECT, orderBy: { startsAt: 'desc' } },
      },
    }),
  ]);
  return rows
    .map((row) => ({
      id: row.id,
      photographer: row.photographer,
      status: statusAt(row.status, row.currentPeriodEndsAt, now, subscriptionGraceDays),
      currentPeriodEndsAt: row.currentPeriodEndsAt.toISOString(),
      graceEndsAt: graceEndsAt(row.currentPeriodEndsAt, subscriptionGraceDays).toISOString(),
      createdAt: row.createdAt.toISOString(),
      periods: row.periods.filter((period) => period.voidedAt === null).map(periodView),
    }))
    .filter((row) => status === undefined || row.status === status);
}

function periodView(period: PeriodRow): PeriodView {
  return {
    id: period.id,
    kind: period.kind === 'trial' ? 'trial' : 'paid',
    planInterval: period.planInterval === 'monthly' || period.planInterval === 'yearly' ? period.planInterval : null,
    priceRwf: period.priceRwf,
    startsAt: period.startsAt.toISOString(),
    endsAt: period.endsAt.toISOString(),
    paidAt: period.payment?.settledAt?.toISOString() ?? null,
  };
}

function paymentView(payment: PaymentRow): SubscriptionPaymentView {
  return {
    ourRef: payment.ourRef,
    status: payment.status,
    planInterval: payment.planInterval === 'yearly' ? 'yearly' : 'monthly',
    amountRwf: payment.amountRwf,
    method: payment.method,
    failure: failureOf(payment.status, payment.failureReason),
    initiatedAt: payment.initiatedAt.toISOString(),
    settledAt: payment.settledAt?.toISOString() ?? null,
  };
}

/** The checkout's rule (routes/public-checkout.ts `failureOf`): turned down, or never started. */
function failureOf(status: string, reason: string | null): 'declined' | 'unavailable' | null {
  if (status !== 'failed') return null;
  return reason !== null && /^provider_(unavailable|timeout)/.test(reason) ? 'unavailable' : 'declined';
}
