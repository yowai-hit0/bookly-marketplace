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

/** The limited endpoints. Each gets its own limiter, so one cannot spend another's allowance. */
export type RateLimitName =
  | 'bookingsPerIp'
  | 'bookingsPerEmail'
  | 'paymentsPerIp'
  | 'loginPerIp'
  | 'passwordResetPerIp'
  | 'emailChangePerIp';

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
  emailChangePerIp: { limit: 10, windowMs: 60 * MINUTE },
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

/** The body's `email`, normalised as the booking route stores it; undefined when absent. */
export function emailKey(req: Request): string | undefined {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim() !== '' ? `email:${email.trim().toLowerCase()}` : undefined;
}
