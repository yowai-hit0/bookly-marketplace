import type { Request, RequestHandler } from 'express';

/**
 * Request limits (security review 2026-10-11, finding 2; marketplace spec R0.2).
 *
 * In memory, per process: one process serves the API (plan.md, Stack
 * decisions), so memory is enough, and a restart forgets the counts harmlessly.
 * These limits protect availability and the email and payment providers'
 * quotas. They are not what keeps data safe -- the database constraints, the
 * token checks and the per-address caps in the database are.
 */

/** A fixed window per key: at most `limit` requests every `windowMs`. */
export class RequestLimiter {
  readonly #windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  allow(key: string, nowMs: number): boolean {
    // Forget finished windows now and then, so a stream of new keys cannot grow the map for good.
    if (this.#windows.size > 10_000) {
      for (const [k, window] of this.#windows) if (nowMs - window.startedAt >= this.windowMs) this.#windows.delete(k);
    }
    const window = this.#windows.get(key);
    if (window === undefined || nowMs - window.startedAt >= this.windowMs) {
      this.#windows.set(key, { startedAt: nowMs, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.limit;
  }

  /** Whole seconds until `key`'s window ends: the `Retry-After` of a refusal. */
  retryAfterSeconds(key: string, nowMs: number): number {
    const window = this.#windows.get(key);
    if (window === undefined) return 0;
    return Math.max(1, Math.ceil((window.startedAt + this.windowMs - nowMs) / 1000));
  }
}

export type RateLimitRule = { limit: number; windowMs: number };

/**
 * The limited endpoints. Each gets its own limiter, so one cannot spend another's
 * allowance. The login, reset and verification limits apply in every signed-in
 * area (studio, platform, account; Phase 2 decision 8), the signup limit in the
 * studio and the account, and the Google limits in the account; each area is
 * counted under its own key (`areaIpKey`), so a burst at one area's login does
 * not lock out another's.
 */
export type RateLimitName =
  | 'bookingsPerIp'
  | 'bookingsPerEmail'
  | 'paymentsPerIp'
  | 'loginPerIp'
  | 'passwordResetPerIp'
  | 'passwordResetConfirmPerIp'
  | 'signupPerIp'
  | 'verifyPerIp'
  | 'verifyResendPerIp'
  | 'googleStartPerIp'
  | 'googleCallbackPerIp'
  | 'emailChangePerIp'
  | 'payoutMethodPerIp'
  | 'accountPasswordPerIp'
  | 'accountEmailChangePerIp'
  | 'accountEmailConfirmPerIp'
  | 'accountDeletePerIp'
  | 'accountExportPerIp';

const MINUTE = 60_000;

/**
 * Production limits. Generous for a person, tight for a script: a visitor books
 * once or twice, a payer retries a prompt a few times, an admin mistypes a
 * password a few times (the account lockout is the real guard there).
 */
export const DEFAULT_RATE_LIMITS: Record<RateLimitName, RateLimitRule> = {
  bookingsPerIp: { limit: 20, windowMs: 60 * MINUTE },
  bookingsPerEmail: { limit: 10, windowMs: 60 * MINUTE },
  paymentsPerIp: { limit: 10, windowMs: 10 * MINUTE },
  loginPerIp: { limit: 10, windowMs: 15 * MINUTE },
  passwordResetPerIp: { limit: 5, windowMs: 60 * MINUTE },
  // A link's token is 256 bits, so this guards the Argon2 hash a valid one
  // costs, not the token: room for a few typos of a too-short password.
  passwordResetConfirmPerIp: { limit: 10, windowMs: 60 * MINUTE },
  emailChangePerIp: { limit: 10, windowMs: 60 * MINUTE },
  // Each signup costs an Argon2 hash and sends an email: a household signing
  // up together fits, a script filling inboxes does not (Phase 2 decision 8).
  signupPerIp: { limit: 5, windowMs: 60 * MINUTE },
  // A verification checks a password, so like a reset confirmation it is
  // bounded for the Argon2 it costs; the account lockout guards the password.
  verifyPerIp: { limit: 10, windowMs: 60 * MINUTE },
  // Sends an email, like a reset request.
  verifyResendPerIp: { limit: 5, windowMs: 60 * MINUTE },
  // Each start writes an oauth_flow row; each callback calls Google. Room for
  // a person who changes their mind a few times at the account chooser.
  googleStartPerIp: { limit: 20, windowMs: 15 * MINUTE },
  googleCallbackPerIp: { limit: 20, windowMs: 15 * MINUTE },
  // Changing where payouts go checks a password (Argon2) and sends a security
  // email (marketplace-spec.md R4.1): a person corrects a typo or two, a
  // script holding a stolen token does not get to keep trying. The password
  // check also counts toward the login lockout.
  payoutMethodPerIp: { limit: 10, windowMs: 60 * MINUTE },
  // The client dashboard (Phase 8). Changing or adding a password hashes one
  // (Argon2), checks the current one too, and sends a security email; so does
  // asking to change the address, which also emails the new one. The address's
  // confirmation checks a password like a verification. Deleting checks one.
  // Each check also counts toward the login lockout, which is the real guard.
  accountPasswordPerIp: { limit: 10, windowMs: 60 * MINUTE },
  accountEmailChangePerIp: { limit: 10, windowMs: 60 * MINUTE },
  accountEmailConfirmPerIp: { limit: 10, windowMs: 60 * MINUTE },
  accountDeletePerIp: { limit: 10, windowMs: 60 * MINUTE },
  // The export reads everything the account holds: a person downloads it once
  // or twice, a script holding a stolen token does not get to loop on it.
  accountExportPerIp: { limit: 10, windowMs: 60 * MINUTE },
};

export type RateLimitOverrides = Partial<Record<RateLimitName, RateLimitRule>>;

export function createLimiters(overrides: RateLimitOverrides = {}): Record<RateLimitName, RequestLimiter> {
  const rules = { ...DEFAULT_RATE_LIMITS, ...overrides };
  return Object.fromEntries(
    Object.entries(rules).map(([name, rule]) => [name, new RequestLimiter(rule.limit, rule.windowMs)]),
  ) as Record<RateLimitName, RequestLimiter>;
}

/**
 * Refuses a request over its limit with `429 rate_limited` and a `Retry-After`.
 * `key` names what is counted; a request it returns `undefined` for (no email in
 * the body, say) passes uncounted, leaving the route to reject it as it would.
 */
export function rateLimit(
  limiter: RequestLimiter,
  now: () => Date,
  key: (req: Request) => string | undefined = (req) => `ip:${req.ip ?? 'unknown'}`,
): RequestHandler {
  return (req, res, next) => {
    const k = key(req);
    if (k === undefined) {
      next();
      return;
    }
    const nowMs = now().getTime();
    if (limiter.allow(k, nowMs)) {
      next();
      return;
    }
    res.set('Retry-After', String(limiter.retryAfterSeconds(k, nowMs)));
    res.status(429).json({ error: 'rate_limited' });
  };
}

/** The client's address within one signed-in area: that area's own count. */
export function areaIpKey(area: string): (req: Request) => string {
  return (req) => `${area}:ip:${req.ip ?? 'unknown'}`;
}

/** The body's `email`, normalised as the booking route stores it; undefined when absent. */
export function emailKey(req: Request): string | undefined {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim() !== '' ? `email:${email.trim().toLowerCase()}` : undefined;
}
