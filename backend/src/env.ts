import 'dotenv/config';
import { z } from 'zod';
import type { PaymentProviderId } from './payments/provider.js';
import { MOMO_MTN_PROVIDERS, OFFERABLE_METHODS, type OfferableMethod, routedProviderId } from './payments/routing.js';

/** Thrown when required configuration is missing or malformed. */
export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  }
}

/**
 * A scheme, host and optional port -- `https://bookly.example` -- stored with no
 * trailing slash. Browsers send `Origin` without one and CORS compares strings
 * exactly, so `https://bookly.example/` would refuse every request from the
 * site; links built from it would get a double slash. A pasted slash is
 * forgiven; a real path is refused rather than silently dropped.
 */
const origin = z
  .url()
  .refine((value) => {
    // Not a URL at all: z.url() has already said so.
    if (!URL.canParse(value)) return true;
    const url = new URL(value);
    return url.pathname === '/' && url.search === '' && url.hash === '';
  }, 'must be an origin like https://example.com, with no path')
  .transform((value) => new URL(value).origin);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  DATABASE_URL: z.url(),
  /** Public origin the site is served from. Emails link here, never at the API host. */
  WEB_ORIGIN: origin,
  /** Public origin of this API. Payment providers call back on it. Defaults to
   *  localhost on PORT outside production, where no provider can reach it anyway. */
  API_ORIGIN: origin.optional(),
  /** Proxies in front of the API whose X-Forwarded-For is trusted: 1 behind
   *  Render alone, 2 behind Cloudflare and Render. Every per-IP limit counts the
   *  address this resolves to, so a wrong value lets a client choose its own. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  /** Retired by marketplace-spec.md R3.1 (2026-10-17): the provider now follows
   *  the client's method. `mtn_momo_direct` is tolerated and ignored -- it is
   *  what `MOMO_MTN_PROVIDER` defaults to, so an old `.env` keeps working.
   *  Anything else is refused rather than ignored, so a deployment still
   *  carrying `PAYMENT_PROVIDER=flutterwave` cannot quietly start sending MTN
   *  MoMo to MTN direct instead. */
  PAYMENT_PROVIDER: z
    .string()
    .optional()
    .refine(
      (value) => value === undefined || value === 'mtn_momo_direct',
      'PAYMENT_PROVIDER is retired (marketplace-spec.md R3.1): remove it, and set MOMO_MTN_PROVIDER=mtn_momo_direct|flutterwave and optionally PAYMENT_METHODS_ENABLED instead',
    ),
  /** Who collects MTN MoMo (R3.1): MTN direct, the default, or Flutterwave.
   *  Airtel Money always goes through Flutterwave. Deploy configuration, never a
   *  database row (data-model_v2.md §5.2). */
  MOMO_MTN_PROVIDER: z.enum(MOMO_MTN_PROVIDERS).default('mtn_momo_direct'),
  /** Narrows what is offered (R3.1): a comma list from `momo_mtn,momo_airtel`.
   *  Unset, every method whose provider is configured is offered. `card` is
   *  reserved for the hosted checkout, deferred with it (R3.2), and refused. */
  PAYMENT_METHODS_ENABLED: z.string().transform(parseMethodList).optional(),
  /** MTN MoMo Collections (plan.md Task 16). Sandbox by default; production
   *  access depends on R-3. Without the three credentials, payment attempts are
   *  recorded and fail at once. */
  MTN_MOMO_BASE_URL: z.url().default('https://sandbox.momodeveloper.mtn.com'),
  MTN_MOMO_TARGET_ENVIRONMENT: z.string().min(1).default('sandbox'),
  MTN_MOMO_SUBSCRIPTION_KEY: z.string().min(1).optional(),
  MTN_MOMO_API_USER: z.string().min(1).optional(),
  MTN_MOMO_API_KEY: z.string().min(1).optional(),
  /** The sandbox accepts only EUR; defaults to EUR there and RWF elsewhere. */
  MTN_MOMO_CURRENCY: z.string().regex(/^[A-Z]{3}$/).optional(),
  /** Flutterwave v4 (plan.md Task 25), mobile money only. Sandbox by default;
   *  live is https://f4bexperience.flutterwave.com. Without the client
   *  credentials, payment attempts are recorded and fail at once. */
  FLUTTERWAVE_BASE_URL: z.url().default('https://developersandbox-api.flutterwave.com'),
  FLUTTERWAVE_IDP_URL: z.url().default('https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token'),
  FLUTTERWAVE_CLIENT_ID: z.string().min(1).optional(),
  FLUTTERWAVE_CLIENT_SECRET: z.string().min(1).optional(),
  /** The dashboard's "Secret hash": the HMAC key of `flutterwave-signature`.
   *  Without it every webhook is stored unverified and applies nothing; payments
   *  then settle only through the status lookup. */
  FLUTTERWAVE_WEBHOOK_HASH: z.string().min(1).optional(),
  FLUTTERWAVE_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('RWF'),
  /** HS256 key that signs admin bearer tokens (plan.md Task 7). jose enforces no
   *  minimum key length, so this floor is the only one. Rotating it invalidates
   *  every issued token -- the only "revoke everything" there is. */
  SESSION_SECRET: z.string().min(32),
  /** Resend API key (plan.md Stack decisions). This or BREVO_API_KEY is
   *  required in production; with neither in development, emails are written
   *  to MAIL_OUTPUT_DIR instead of sent. */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** Brevo API key (`xkeysib-...`), the alternative to Resend. Set one, never both. */
  BREVO_API_KEY: z.string().min(1).optional(),
  /** The sender, on a domain verified with the provider. */
  MAIL_FROM: z.string().min(3).default('Bookly <bookings@localhost>'),
  /** Where replies go, if not to MAIL_FROM. */
  MAIL_REPLY_TO: z.email().optional(),
  /** Development only: rendered emails land here when no mail key is set. */
  MAIL_OUTPUT_DIR: z.string().min(1).default('.mail'),
  /** "Continue with Google" for clients (Phase 2 decision 6): an OAuth client
   *  of type "Web application" whose authorised redirect URI is
   *  `<WEB_ORIGIN>/account/google/callback`. Both or neither: without them the
   *  feature is off and `/api/account/auth/providers` says so. */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
}).refine((env) => (env.GOOGLE_CLIENT_ID === undefined) === (env.GOOGLE_CLIENT_SECRET === undefined), {
  message: 'set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET together, or neither: one alone cannot complete a sign-in',
  path: ['GOOGLE_CLIENT_SECRET'],
}).refine((env) => env.NODE_ENV !== 'production' || env.RESEND_API_KEY !== undefined || env.BREVO_API_KEY !== undefined, {
  message: 'RESEND_API_KEY or BREVO_API_KEY is required in production: without one no email would ever be sent',
  path: ['RESEND_API_KEY'],
}).refine((env) => env.RESEND_API_KEY === undefined || env.BREVO_API_KEY === undefined, {
  message: 'set RESEND_API_KEY or BREVO_API_KEY, not both: which one sends would be a guess',
  path: ['BREVO_API_KEY'],
}).refine((env) => env.NODE_ENV !== 'production' || env.API_ORIGIN !== undefined, {
  message: 'API_ORIGIN is required in production: payment providers call back on it',
  path: ['API_ORIGIN'],
}).superRefine((env, ctx) => {
  for (const issue of paymentIssues(env)) ctx.addIssue({ code: 'custom', message: issue.message, path: [issue.path] });
});
export type Env = z.infer<typeof schema>;

/** `PAYMENT_METHODS_ENABLED`, trimmed, deduplicated and in the pay page's order. */
function parseMethodList(value: string, ctx: z.RefinementCtx): OfferableMethod[] {
  const items = value.split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (items.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'lists no method: name at least one of momo_mtn, momo_airtel, or leave it unset to offer every configured one' });
    return z.NEVER;
  }
  for (const item of items) {
    if (item === 'card') {
      ctx.addIssue({ code: 'custom', message: 'card is reserved for the hosted card checkout, which is deferred (marketplace-spec.md R3.2): it cannot be enabled yet' });
    } else if (!(OFFERABLE_METHODS as readonly string[]).includes(item)) {
      ctx.addIssue({ code: 'custom', message: `unknown method "${item.slice(0, 40)}": use momo_mtn, momo_airtel` });
    }
  }
  return OFFERABLE_METHODS.filter((method) => items.includes(method));
}

type PaymentEnv = Pick<
  z.infer<typeof schema>,
  | 'NODE_ENV'
  | 'MOMO_MTN_PROVIDER'
  | 'PAYMENT_METHODS_ENABLED'
  | 'MTN_MOMO_SUBSCRIPTION_KEY'
  | 'MTN_MOMO_API_USER'
  | 'MTN_MOMO_API_KEY'
  | 'FLUTTERWAVE_CLIENT_ID'
  | 'FLUTTERWAVE_CLIENT_SECRET'
  | 'FLUTTERWAVE_WEBHOOK_HASH'
>;

const MTN_CREDENTIALS = ['MTN_MOMO_SUBSCRIPTION_KEY', 'MTN_MOMO_API_USER', 'MTN_MOMO_API_KEY'] as const;
const FLUTTERWAVE_CREDENTIALS = ['FLUTTERWAVE_CLIENT_ID', 'FLUTTERWAVE_CLIENT_SECRET'] as const;

/** What a provider needs before it can be offered; the same test `MtnMomoProvider` and `FlutterwaveProvider` apply. */
function credentialsOf(providerId: PaymentProviderId): readonly (keyof PaymentEnv)[] {
  return providerId === 'mtn_momo_direct' ? MTN_CREDENTIALS : FLUTTERWAVE_CREDENTIALS;
}

function configured(env: PaymentEnv, providerId: PaymentProviderId): boolean {
  return credentialsOf(providerId).every((key) => env[key] !== undefined);
}

/** `a, b and c`. */
function listed(keys: readonly string[]): string {
  return keys.length === 1 ? (keys[0] ?? '') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1) ?? ''}`;
}

/**
 * The methods this environment offers (R3.1): those enabled whose provider is
 * configured. `providers.ts` arrives at the same list from the constructed
 * providers; this is the startup check's view of it.
 */
export function offeredMethods(env: PaymentEnv): OfferableMethod[] {
  const enabled = env.PAYMENT_METHODS_ENABLED ?? OFFERABLE_METHODS;
  return enabled.filter((method) => configured(env, routedProviderId(method, env.MOMO_MTN_PROVIDER)));
}

/**
 * Production must be able to take money the way it says it does (R3.1). In
 * development and test an unconfigured provider is simply not offered.
 *
 *  - Half a set of credentials is a typo, not a choice: it would silently drop
 *    the method, so it is named.
 *  - A method listed in `PAYMENT_METHODS_ENABLED` must be collectable.
 *  - Unset, at least one method must be on offer, or nobody could pay.
 *  - Flutterwave collecting anything needs its webhook hash, or no webhook of
 *    its could ever be verified.
 */
function paymentIssues(env: PaymentEnv): { message: string; path: string }[] {
  if (env.NODE_ENV !== 'production') return [];
  const issues: { message: string; path: string }[] = [];

  for (const providerId of ['mtn_momo_direct', 'flutterwave'] as const) {
    const keys = credentialsOf(providerId);
    const missing = keys.filter((key) => env[key] === undefined);
    if (missing.length > 0 && missing.length < keys.length) {
      issues.push({ message: `set ${listed(keys)} together in production, or none: ${listed(missing)} missing`, path: missing[0] ?? providerId });
    }
  }

  const offered = offeredMethods(env);
  const wanted = env.PAYMENT_METHODS_ENABLED ?? (offered.length === 0 ? OFFERABLE_METHODS : []);
  for (const method of wanted) {
    const providerId = routedProviderId(method, env.MOMO_MTN_PROVIDER);
    if (configured(env, providerId)) continue;
    const keys = credentialsOf(providerId);
    const why = env.PAYMENT_METHODS_ENABLED === undefined ? 'no payment method can be offered: ' : '';
    issues.push({
      message: `${why}${listed(keys)} are required in production to offer ${method} through ${providerId}`,
      path: keys.at(-1) ?? 'PAYMENT_METHODS_ENABLED',
    });
  }

  const flutterwaveCollects = offered.some((method) => routedProviderId(method, env.MOMO_MTN_PROVIDER) === 'flutterwave');
  if (flutterwaveCollects && env.FLUTTERWAVE_WEBHOOK_HASH === undefined) {
    issues.push({
      message: `FLUTTERWAVE_WEBHOOK_HASH is required in production while Flutterwave collects ${listed(offered.filter((m) => routedProviderId(m, env.MOMO_MTN_PROVIDER) === 'flutterwave'))}: without it no webhook can be verified`,
      path: 'FLUTTERWAVE_WEBHOOK_HASH',
    });
  }
  return issues;
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}
