import { Router } from 'express';
import { z } from 'zod';
import { emailBookingLinks, type LinkLookupDeps } from '../booking/link-lookup.js';
import { RequestLimiter } from '../http/rate-limit.js';
import { parseOrReject } from './validation.js';

/**
 * The "My booking" page's one request (docs/prompts/client-access-and-admin-polish.md, item 4):
 *
 *   POST /api/booking-links   { email }
 *        202 { sent: true }         always: a match, no match, or too many requests
 *        400 invalid_request        not a JSON object with an email string
 *        422 validation_failed      not an email address
 *
 * The answer never says whether the address has bookings, and it is sent
 * before any of the work is done, so neither its body nor its timing can
 * tell. Whatever the work finds happens by email, to the address on the
 * bookings.
 *
 * Two limits. Per address, in the database (`link-lookup.ts`): what protects a
 * client from a stranger resetting their links. Per IP, here, in memory: what
 * protects the email provider's quota. One process serves the API (plan.md,
 * Stack decisions), so memory is enough; a restart forgets it, harmlessly.
 */

// Re-exported: the limiter moved to http/rate-limit.ts when every public write got one.
export { RequestLimiter };

export type BookingLinksDeps = LinkLookupDeps & {
  /** Injectable for tests. Defaults to 20 requests per IP per hour. */
  limiter?: RequestLimiter;
  /** Handed the work behind each accepted request, so a test can wait for it. */
  onWork?: (work: Promise<unknown>) => void;
  log?: (entry: Record<string, unknown>) => void;
};

export const IP_REQUESTS_PER_HOUR = 20;
const EMAIL_MAX_LENGTH = 254;

const emailFormat = z.email();
const body = z.strictObject({
  // A refinement, not z.email(): a mistyped address is a 422 the form can mark
  // (routes/validation.ts; as public-bookings.ts does).
  email: z
    .string()
    .trim()
    .max(EMAIL_MAX_LENGTH)
    .refine((value) => emailFormat.safeParse(value).success, 'Invalid email'),
});

export function bookingLinksRouter(deps: BookingLinksDeps): Router {
  const router = Router();
  const limiter = deps.limiter ?? new RequestLimiter(IP_REQUESTS_PER_HOUR, 60 * 60_000);
  const log = deps.log ?? defaultLog;

  router.post('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const parsed = parseOrReject(body, req.body, res);
    if (parsed === undefined) return;

    const allowed = limiter.allow(req.ip ?? 'unknown', deps.now().getTime());
    res.status(202).json({ sent: true });
    if (!allowed) return;

    const work = emailBookingLinks(deps, parsed.email).catch((error: unknown) => {
      // Never the address: it is personal data, and this line is a log.
      log({ level: 'error', event: 'booking_links_failed', message: error instanceof Error ? error.message : String(error) });
    });
    deps.onWork?.(work);
  });

  return router;
}

function defaultLog(entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') console.error(line);
  else console.log(line);
}
