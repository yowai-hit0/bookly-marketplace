import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { kigaliDateOf } from '../availability/engine.js';
import { enqueue } from '../outbox/enqueue.js';
import { issueAccessToken } from './access-link.js';
import { bookingTotals } from './totals.js';

/**
 * "Email me my links" (docs/prompts/client-access-and-admin-polish.md, item 4):
 * a client types their email and gets one email with a fresh link for each
 * booking they can still act on. Reverses the 2026-09-21 decision that there is
 * no public resend (design-system/bookly/pages/client-shell.md).
 *
 * What counts as current (user decisions, 2026-09-25): a confirmed booking whose
 * shoot is still ahead, or a completed one that still owes money or whose photo
 * link has not expired.
 *
 * Nothing here is visible to the caller: the route answers the same whether an
 * address has bookings, has none, or has asked too often, so the page cannot be
 * used to learn who books. The email goes only to the address on the bookings.
 *
 * Every send replaces the links it carries (only a token's hash is stored), so
 * the rate limit is what stops a stranger who knows an address from killing
 * that client's links over and over: one email per address every 10 minutes,
 * five a day, counted from the outbox under a per-address lock so two requests
 * at once cannot both slip through.
 */

export const LINK_EMAIL_COOLDOWN_MINUTES = 10;
export const LINK_EMAILS_PER_DAY = 5;
/** The email template's own bound: more than this and the oldest are left out. */
const MAX_BOOKINGS = 20;

export type LinkLookupDeps = { prisma: PrismaClient; now: () => Date };

/** For tests and logs only. The route never tells the caller which it was. */
export type LinkLookupOutcome = 'sent' | 'no_match' | 'rate_limited';

export async function emailBookingLinks(deps: LinkLookupDeps, typedEmail: string): Promise<LinkLookupOutcome> {
  const email = typedEmail.trim().toLowerCase();
  const now = deps.now();

  return deps.prisma.$transaction(async (tx) => {
    // One request per address at a time: the count below then sees the one before.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bookly.booking_links:${email}`}))`;

    const sent = await tx.$queryRaw<{ recent: number; today: number }[]>`
      SELECT count(*) FILTER (WHERE created_at > now() - make_interval(mins => ${LINK_EMAIL_COOLDOWN_MINUTES}::integer))::int AS recent,
             count(*)::int AS today
        FROM outbox
       WHERE template = 'booking_links'
         AND lower(recipient) = ${email}
         AND created_at > now() - interval '24 hours'`;
    const counts = sent[0] ?? { recent: 0, today: 0 };
    if (counts.recent > 0 || counts.today >= LINK_EMAILS_PER_DAY) return 'rate_limited';

    // Equality on lower(), never Prisma's `{ equals, mode: 'insensitive' }`: on
    // PostgreSQL that is ILIKE, a pattern, so `_____@gmail.com` or `%` would
    // match strangers' bookings and mail their links to the caller (security
    // review 2026-10-11, finding 1; the same rule as admin-auth.ts).
    const matched = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id
        FROM booking
       WHERE lower(contact_email) = ${email}
         AND status IN ('confirmed', 'completed')`;
    const candidates = await tx.booking.findMany({
      where: { id: { in: matched.map((row) => row.id) } },
      include: { addons: true, payments: true },
      orderBy: { startsAt: 'asc' },
    });
    const today = kigaliDateOf(now);
    const current = candidates
      .filter((booking) => {
        if (booking.status === 'confirmed') return booking.startsAt > now;
        const owes = bookingTotals(booking, booking.addons, booking.payments).outstandingRwf > 0;
        const photosLive =
          booking.deliveryUrl !== null &&
          booking.deliveryExpiresOn !== null &&
          booking.deliveryExpiresOn.toISOString().slice(0, 10) >= today;
        return owes || photosLive;
      })
      .slice(-MAX_BOOKINGS);
    const first = current[0];
    if (first === undefined) return 'no_match';

    const bookings = [];
    for (const booking of current) {
      bookings.push({
        reference: booking.reference,
        serviceName: booking.serviceNameSnapshot,
        packageName: booking.packageNameSnapshot,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        // The only place these plaintexts exist (data-model_v2.md §5.9).
        accessToken: await issueAccessToken(tx, booking.id, now),
      });
    }

    await enqueue(tx, {
      kind: 'email',
      template: 'booking_links',
      // The address as the bookings hold it, never the string typed on the page.
      recipient: first.contactEmail,
      // About an address, not one booking: several bookings share this email.
      bookingId: null,
      // Unique per send: the lock and the rate limit above are what stop a
      // repeat, and a key naming the address would copy it into another column.
      dedupeKey: `email:booking_links:${randomUUID()}`,
      payload: { locale: first.locale, clientName: first.contactName, bookings },
    });
    return 'sent';
  });
}
