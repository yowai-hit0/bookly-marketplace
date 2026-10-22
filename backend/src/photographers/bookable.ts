import { Prisma, type Photographer, type Subscription } from '@prisma/client';

/**
 * Whether a photographer can be booked, and whether they are listed: the rules,
 * in one place (brief decision 2; marketplace-spec.md R1.3, R5.4, R5.5).
 *
 * BOOKABLE (R5.4; marketplace-data-model.md §3.7):
 *
 *   photographer.status = 'approved'
 *   AND subscription.status IN ('trialing', 'active')
 *   AND subscription.current_period_ends_at > now
 *
 * The period's end is compared with the clock DIRECTLY, every time: the
 * subscription job (subscriptions/job.ts) moves `status` to `past_due` when a
 * period ends, but nothing waits for it, so a job that runs late -- or not at
 * all -- can never keep a lapsed photographer bookable. A photographer with no
 * subscription (never approved) is not bookable.
 *
 * LISTED (R5.5): approved, and the subscription not yet `expired` -- `trialing`,
 * `active` or `past_due`, with the period's end plus the grace days still ahead.
 * A `past_due` photographer is listed with `takingBookings: false`; an expired
 * one is hidden, and their profile is the same 404 as a suspended or unknown
 * handle (catalogue/public.ts says why). The grace end is compared with the
 * clock directly too, for the same reason.
 *
 * Every public read and every write into a calendar goes through one of the
 * forms below, so the Prisma filter, the in-memory check and the SQL re-checked
 * inside a transaction can never disagree:
 *
 *   bookablePhotographerWhere(now)   Prisma, the app's clock: the public reads
 *   isBookable(...)                  in memory, the app's clock
 *   bookableSqlAt / listedSqlAt      SQL, the app's clock: the directory and the
 *                                    sitemap (R6.1, R6.6), written in SQL
 *   BOOKABLE_SQL / lockBookablePhotographer   SQL on the DATABASE clock: the slot
 *                                    claim (R1.3) and the booking-fee initiation
 *                                    (R3.4), which already measure the hold there
 *
 * An unbookable photographer is never named as such to the public: their
 * packages answer exactly like an inactive package, so the catalogue does not
 * reveal whether someone is pending, suspended, out of subscription or unknown
 * (R3.4 as built).
 */

/** The subscription statuses a photographer can be booked in, while the period runs (§3.7). */
export const BOOKABLE_SUBSCRIPTION_STATUSES = ['trialing', 'active'] as const;
/** The subscription statuses a photographer is listed in: `past_due` too, not taking bookings (R5.5). */
export const LISTED_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due'] as const;

const DAY_MS = 24 * 60 * 60_000;

/** The Prisma filter for a bookable photographer at `now`, for the public reads. */
export function bookablePhotographerWhere(now: Date): Prisma.PhotographerWhereInput {
  return {
    status: 'approved',
    subscription: { is: { status: { in: [...BOOKABLE_SUBSCRIPTION_STATUSES] }, currentPeriodEndsAt: { gt: now } } },
  };
}

/**
 * The Prisma filter for a listed photographer at `now` (R5.5): bookable, or
 * `past_due` and inside the grace days. Kigali keeps no daylight saving, so a
 * grace day is 24 hours.
 */
export function listedPhotographerWhere(now: Date, graceDays: number): Prisma.PhotographerWhereInput {
  return {
    status: 'approved',
    subscription: {
      is: { status: { in: [...LISTED_SUBSCRIPTION_STATUSES] }, currentPeriodEndsAt: { gt: new Date(now.getTime() - graceDays * DAY_MS) } },
    },
  };
}

/** The same rule over rows already in hand. No subscription is not bookable. */
export function isBookable(
  photographer: Pick<Photographer, 'status'>,
  subscription: Pick<Subscription, 'status' | 'currentPeriodEndsAt'> | null,
  now: Date,
): boolean {
  return (
    photographer.status === 'approved' &&
    subscription !== null &&
    (BOOKABLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status) &&
    subscription.currentPeriodEndsAt.getTime() > now.getTime()
  );
}

/**
 * The rule as a SQL expression over `ph` (photographer) and `s` (its
 * subscription, LEFT JOINed), on the database clock. A missing subscription
 * makes it false, never null.
 */
export const BOOKABLE_SQL = Prisma.sql`(
  ph.status = 'approved'
  AND s.id IS NOT NULL
  AND s.status = ANY(${[...BOOKABLE_SUBSCRIPTION_STATUSES]}::text[])
  AND s.current_period_ends_at > now())`;

/**
 * BOOKABLE as a SQL expression over `ph` and `s` on the APP's clock `now`, for
 * the public reads that are written in SQL (the directory, R6.1; the sitemap,
 * R6.6). The same rule as `bookablePhotographerWhere(now)`: the public reads
 * all measure on the injected clock, so the directory and the profile it links
 * to can never disagree about `takingBookings`. `s` may be LEFT JOINed: a
 * missing subscription makes it false, never null.
 */
export function bookableSqlAt(now: Date): Prisma.Sql {
  return Prisma.sql`(
  ph.status = 'approved'
  AND s.id IS NOT NULL
  AND s.status = ANY(${[...BOOKABLE_SUBSCRIPTION_STATUSES]}::text[])
  AND s.current_period_ends_at > ${now}::timestamptz)`;
}

/** LISTED (R5.5) as SQL over `ph` and `s` on the app's clock: `listedPhotographerWhere(now, graceDays)`. */
export function listedSqlAt(now: Date, graceDays: number): Prisma.Sql {
  return Prisma.sql`(
  ph.status = 'approved'
  AND s.id IS NOT NULL
  AND s.status = ANY(${[...LISTED_SUBSCRIPTION_STATUSES]}::text[])
  AND s.current_period_ends_at > ${new Date(now.getTime() - graceDays * DAY_MS)}::timestamptz)`;
}

/**
 * The rule read inside a transaction that is about to write into the
 * photographer's calendar (the slot claim, R1.3). `FOR SHARE OF ph` holds the
 * photographer row, so a suspension cannot commit between this check and the
 * insert that relies on it: it waits for the claim.
 *
 * The subscription row is read, not locked. Nothing that commits meanwhile can
 * make a bookable photographer unbookable except the clock: a payment only ever
 * moves the period's end later, and the job moves the status only once the end
 * has passed, which this already compares directly. So no subscription lock is
 * needed, and none is taken -- the subscription's own lock order
 * (payments/webhooks.ts) never meets the calendar's. A photographer id that
 * names nobody is not bookable.
 */
export async function lockBookablePhotographer(tx: Prisma.TransactionClient, photographerId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ bookable: boolean }[]>`
    SELECT ${BOOKABLE_SQL} AS bookable
      FROM photographer ph
      LEFT JOIN subscription s ON s.photographer_id = ph.id
     WHERE ph.id = ${photographerId}::uuid
       FOR SHARE OF ph`;
  return rows[0]?.bookable === true;
}
