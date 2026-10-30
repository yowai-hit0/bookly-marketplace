import type { Booking, PrismaClient } from '@prisma/client';
import { generateAccessToken } from '../booking/access-token.js';
import { MtnMomoProvider } from '../payments/mtn-momo.js';
import { type PaymentRouting, routePayments } from '../payments/routing.js';
import type {
  BrowserCheckoutRequest,
  InitiatePaymentRequest,
  InitiatePaymentResult,
  InlineCardConfig,
  PaymentMethod,
  PaymentProvider,
  PaymentProviderId,
  ProviderEvent,
  WebhookDelivery,
} from '../payments/provider.js';

/**
 * Fixtures for the payment tests (plan.md Tasks 16 and 17), and the world most
 * other suites book in. Imported by tests only.
 *
 * Bookings are written directly, bypassing the claim, in whatever state a test
 * needs. A hold is stamped on the DATABASE clock (`now() + n minutes`), exactly
 * as the claim stamps it, so "live" and "lapsed" mean what they mean to the
 * code under test whatever the test process's own clock says. Each booking gets
 * its own day unless a test names a start, so two fixtures never collide on the
 * exclusion constraint by accident.
 */

export const TEST_SECRET = 'payments-test-secret-that-is-at-least-32-chars';
/**
 * The world photographer's login. The name predates the marketplace, when the
 * one admin WAS the photographer; it is kept so the suites that address mail to
 * the photographer keep reading the same.
 */
export const ADMIN_EMAIL = 'photographer@bookly.example';
export const PHOTOGRAPHER_EMAIL = ADMIN_EMAIL;
export const PHOTOGRAPHER_HANDLE = 'kigali-lens';
export const PHOTOGRAPHER_NAME = 'Kigali Lens';
/** The platform admin seedWorld creates by default: the recipient of alerts that concern no booking. */
export const PLATFORM_ADMIN_EMAIL = 'platform@bookly.example';
/** The second photographer of the isolation tests (seedSecondPhotographer). */
export const SECOND_PHOTOGRAPHER_EMAIL = 'second.photographer@bookly.example';
export const SECOND_PHOTOGRAPHER_HANDLE = 'hills-and-light';
export const API_ORIGIN = 'https://api.bookly.example';
export const MTN_BASE_URL = 'https://mtn.test';
export const MINUTE_MS = 60_000;
export const DAY_MS = 1440 * MINUTE_MS;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The platform settings row every world starts with: the schema defaults, and
 * the seed's placeholder prices, which have no column default
 * (marketplace-data-model.md §3.2).
 */
export const TEST_PLATFORM_SETTING = { id: 1, subscriptionMonthlyPriceRwf: 10_000, subscriptionYearlyPriceRwf: 100_000 } as const;

/**
 * Where a fixture photographer's subscription runs to: far past every clock a
 * suite injects (2026 to 2027), so "approved" keeps meaning "bookable" in the
 * suites that are not about subscriptions (R5.4). The subscription suites set
 * their own ends.
 */
export const FIXTURE_SUBSCRIPTION_ENDS_AT = new Date('2100-01-01T00:00:00Z');

export const CLIENT = {
  name: 'Aline Uwase-Private',
  email: 'aline.private@example.com',
  phone: '+250788123456',
  location: 'Kigali Heights, KG 7 Ave',
  specialRequests: 'Golden hour if possible.',
} as const;

export type PaymentWorld = {
  /** The approved photographer who owns everything below. */
  photographerId: string;
  /** Their `app_user` login, role photographer. */
  photographerUserId: string;
  serviceId: string;
  packageId: string;
  /** Portraits' own, 10,000 RWF, sort order 2. */
  ownAddonId: string;
  /** Shared across this photographer's services, 5,000 RWF, sort order 0. */
  sharedAddonId: string;
  /** Platform-global (marketplace-data-model.md §2.8): every photographer's world shares it. */
  clientId: string;
};

export type WorldOptions = {
  /**
   * Also create a `platform_admin` login (PLATFORM_ADMIN_EMAIL), which receives
   * the alerts that concern no booking (brief decision 6). Default true.
   */
  platformAdmin?: boolean;
  /**
   * @deprecated Before the marketplace this skipped the one admin account. A
   * booking's photographer always has a login now, so it only skips the
   * platform admin, as `platformAdmin: false` does.
   */
  admin?: boolean;
};

/**
 * The platform settings row, one approved photographer with their login and
 * settings row, their catalogue (one service, one package, two add-ons), one
 * client and, by default, a platform admin.
 */
export async function seedWorld(prisma: PrismaClient, options: WorldOptions = {}): Promise<PaymentWorld> {
  await prisma.platformSetting.create({ data: TEST_PLATFORM_SETTING });
  if (options.platformAdmin ?? options.admin ?? true) {
    await prisma.appUser.create({
      data: { email: PLATFORM_ADMIN_EMAIL, role: 'platform_admin', passwordHash: 'not-a-real-hash', emailVerifiedAt: new Date('2026-09-01T06:00:00Z') },
    });
  }
  const photographer = await createPhotographer(prisma, { email: PHOTOGRAPHER_EMAIL, handle: PHOTOGRAPHER_HANDLE, displayName: PHOTOGRAPHER_NAME });
  const client = await prisma.client.create({ data: { fullName: CLIENT.name, email: CLIENT.email, phone: CLIENT.phone } });
  return { ...photographer, ...(await createCatalogue(prisma, photographer.photographerId)), clientId: client.id };
}

/**
 * A second approved photographer with a catalogue of the same shape -- the same
 * `portraits` slug included, which is unique per photographer, not globally --
 * sharing the first world's client. For the isolation tests (T1.2-T1.4):
 * `insertBooking(prisma, second)` books this photographer.
 */
export async function seedSecondPhotographer(
  prisma: PrismaClient,
  world: PaymentWorld,
  options: { email?: string; handle?: string; displayName?: string } = {},
): Promise<PaymentWorld> {
  const photographer = await createPhotographer(prisma, {
    email: options.email ?? SECOND_PHOTOGRAPHER_EMAIL,
    handle: options.handle ?? SECOND_PHOTOGRAPHER_HANDLE,
    displayName: options.displayName ?? 'Hills & Light',
  });
  return { ...photographer, ...(await createCatalogue(prisma, photographer.photographerId)), clientId: world.clientId };
}

/**
 * A `photographer` login, its approved photographer and the photographer's
 * settings row at the schema defaults (fee 40%, lead 120, buffer 30, expiry 90,
 * cancel any time, fee not refundable) -- what approval leaves behind. An
 * approved one also gets what approval creates since Phase 5: a subscription
 * and its trial, running to FIXTURE_SUBSCRIPTION_ENDS_AT (R5.1).
 */
export async function createPhotographer(
  prisma: PrismaClient,
  {
    email,
    handle,
    displayName,
    status = 'approved',
    submittedAt,
  }: {
    email: string;
    handle: string;
    displayName: string;
    status?: 'pending' | 'approved' | 'suspended';
    /** Submitted for review from the setup checklist (R7.3), which approval requires (Phase 7). Default: never. */
    submittedAt?: Date;
  },
): Promise<{ photographerId: string; photographerUserId: string }> {
  const user = await prisma.appUser.create({ data: { email, role: 'photographer', passwordHash: 'not-a-real-hash', emailVerifiedAt: new Date('2026-09-01T06:00:00Z') } });
  const photographer = await prisma.photographer.create({
    data: {
      userId: user.id,
      handle,
      displayName,
      status,
      ...(submittedAt === undefined ? {} : { submittedAt }),
      ...(status === 'approved' ? { approvedAt: new Date('2026-09-02T06:00:00Z') } : {}),
      ...(status === 'suspended' ? { suspendedAt: new Date('2026-09-03T06:00:00Z') } : {}),
      setting: { create: {} },
    },
  });
  if (status === 'approved') await grantSubscription(prisma, photographer.id);
  return { photographerId: photographer.id, photographerUserId: user.id };
}

/**
 * A subscription with its trial, for a photographer made approved by hand (R5.1):
 * `trialing`, its trial from 2 September 2026 (the fixture approval) to `endsAt`.
 * A test that approves a photographer through moderation gets one from there.
 */
export async function grantSubscription(
  prisma: PrismaClient,
  photographerId: string,
  { endsAt = FIXTURE_SUBSCRIPTION_ENDS_AT, status = 'trialing', startsAt = new Date('2026-09-02T06:00:00Z') }: { endsAt?: Date; status?: string; startsAt?: Date } = {},
): Promise<string> {
  const subscription = await prisma.subscription.create({
    data: {
      photographerId,
      status,
      currentPeriodEndsAt: endsAt,
      periods: { create: { kind: 'trial', priceRwf: 0, startsAt, endsAt } },
    },
  });
  return subscription.id;
}

/** One service, one package and two add-ons (one the service's own, one shared), owned by `photographerId`. */
async function createCatalogue(
  prisma: PrismaClient,
  photographerId: string,
): Promise<Pick<PaymentWorld, 'serviceId' | 'packageId' | 'ownAddonId' | 'sharedAddonId'>> {
  const service = await prisma.service.create({ data: { photographerId, slug: 'portraits', nameEn: 'Portraits' } });
  const pkg = await prisma.package.create({
    data: { photographerId, serviceId: service.id, nameEn: 'Standard', priceRwf: 40_000, photoCount: 25, durationMinutes: 90 },
  });
  const ownAddon = await prisma.addon.create({ data: { photographerId, serviceId: service.id, nameEn: 'Extra hour', priceRwf: 10_000, sortOrder: 2 } });
  const sharedAddon = await prisma.addon.create({ data: { photographerId, serviceId: null, nameEn: 'Rush edit', priceRwf: 5_000, sortOrder: 0 } });
  return { serviceId: service.id, packageId: pkg.id, ownAddonId: ownAddon.id, sharedAddonId: sharedAddon.id };
}

let referenceCounter = 0;
let dayCounter = 0;
let transactionCounter = 0;

/** A fresh, well-formed booking reference. */
export function nextReference(): string {
  referenceCounter += 1;
  return `BKY-2610-${String(referenceCounter % 100_000).padStart(5, '0')}`;
}

/** A fresh MTN `financialTransactionId`; `provider_ref` is unique. */
export function nextTransactionId(): string {
  transactionCounter += 1;
  return String(4_100_000_000 + transactionCounter);
}

export type BookingSeed = {
  reference?: string;
  status?: string;
  /**
   * The hold, in minutes from the database's now(): negative has lapsed. Null
   * for none. Defaults to +30 for `pending_payment` and -30 for `expired`.
   */
  holdMinutes?: number | null;
  startsAt?: Date;
  durationMinutes?: number;
  bookingFeeRwf?: number;
  /** At-booking add-ons: `own` 10,000 and `shared` 5,000. Defaults to `own` only. */
  addons?: ('own' | 'shared')[];
  /** The cancellation policy snapshotted on the booking (R1.8). Defaults to 0: any time before the shoot. */
  clientCancelCutoffHours?: number;
  /** Defaults to false: a client's cancellation forfeits the booking fee. */
  bookingFeeRefundableOnClientCancel?: boolean;
};

export const DURATION_MINUTES = 90;
export const BUFFER_MINUTES = 30;

/** Start of the n-th fixture day: 09:00 Kigali on consecutive days from Monday 4 January 2027. */
function nextDay(): Date {
  dayCounter += 1;
  return new Date(Date.UTC(2027, 0, 4, 7) + dayCounter * DAY_MS);
}

export async function insertBooking(prisma: PrismaClient, world: PaymentWorld, seed: BookingSeed = {}): Promise<Booking> {
  const status = seed.status ?? 'pending_payment';
  const startsAt = seed.startsAt ?? nextDay();
  const endsAt = new Date(startsAt.getTime() + (seed.durationMinutes ?? DURATION_MINUTES) * MINUTE_MS);
  const defaultHolds: Record<string, number> = { pending_payment: 30, expired: -30 };
  const holdMinutes = seed.holdMinutes === undefined ? (defaultHolds[status] ?? null) : seed.holdMinutes;
  const addons = seed.addons ?? ['own'];

  const booking = await prisma.booking.create({
    data: {
      reference: seed.reference ?? nextReference(),
      clientId: world.clientId,
      photographerId: world.photographerId,
      contactName: CLIENT.name,
      contactEmail: CLIENT.email,
      contactPhone: CLIENT.phone,
      serviceId: world.serviceId,
      packageId: world.packageId,
      serviceNameSnapshot: 'Portraits',
      packageNameSnapshot: 'Standard',
      packagePriceRwf: 40_000,
      packageDurationMinutes: seed.durationMinutes ?? DURATION_MINUTES,
      packagePhotoCount: 25,
      status,
      startsAt,
      endsAt,
      bufferEndsAt: new Date(endsAt.getTime() + BUFFER_MINUTES * MINUTE_MS),
      // Stamped below on the database clock; a lapsed hold must not trip the
      // exclusion constraint's view of the row in the meantime.
      holdExpiresAt: null,
      locationText: CLIENT.location,
      partySize: 3,
      specialRequests: CLIENT.specialRequests,
      consentAt: new Date('2026-10-01T06:00:00Z'),
      bookingFeeRate: '0.400',
      bookingFeeRwf: seed.bookingFeeRwf ?? 20_000,
      // The policy snapshot booking creation takes (R1.8): the schema
      // defaults' "any time before the shoot, fee not refundable" unless a test
      // names its own terms.
      clientCancelCutoffHours: seed.clientCancelCutoffHours ?? 0,
      bookingFeeRefundableOnClientCancel: seed.bookingFeeRefundableOnClientCancel ?? false,
      ...(status === 'confirmed' ? { confirmedAt: new Date('2026-10-01T06:05:00Z') } : {}),
    },
  });

  for (const which of addons) {
    const own = which === 'own';
    await prisma.bookingAddon.create({
      data: {
        bookingId: booking.id,
        addonId: own ? world.ownAddonId : world.sharedAddonId,
        nameSnapshot: own ? 'Extra hour' : 'Rush edit',
        unitPriceRwf: own ? 10_000 : 5_000,
        amountRwf: own ? 10_000 : 5_000,
        stage: 'at_booking',
      },
    });
  }

  if (holdMinutes !== null) {
    await prisma.$executeRaw`UPDATE booking SET hold_expires_at = now() + make_interval(mins => ${holdMinutes}::integer) WHERE id = ${booking.id}::uuid`;
  }
  return prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
}

/**
 * Gives a booking a live access token and answers the plaintext (plan.md Task
 * 18). The expiry is stamped on the DATABASE clock, like the hold, because
 * `findBookingByToken` compares it against `now()` there.
 */
export async function grantAccessToken(
  prisma: PrismaClient,
  bookingId: string,
  options: { expiresInMinutes?: number } = {},
): Promise<string> {
  const { token, hash } = generateAccessToken();
  await prisma.$executeRaw`
    UPDATE booking
       SET access_token_hash = ${hash},
           access_token_expires_at = now() + make_interval(mins => ${options.expiresInMinutes ?? 365 * 1440}::integer),
           access_token_last_used_at = NULL
     WHERE id = ${bookingId}::uuid`;
  return token;
}

/** A confirmed booking with a live access token: what a client's return link opens. */
export async function insertBookingWithToken(
  prisma: PrismaClient,
  world: PaymentWorld,
  seed: BookingSeed & { expiresInMinutes?: number } = {},
): Promise<{ booking: Booking; token: string }> {
  const { expiresInMinutes, ...bookingSeed } = seed;
  const booking = await insertBooking(prisma, world, { status: 'confirmed', ...bookingSeed });
  const token = await grantAccessToken(prisma, booking.id, {
    ...(expiresInMinutes === undefined ? {} : { expiresInMinutes }),
  });
  return { booking, token };
}

export type PaymentSeed = {
  status?: string;
  kind?: 'booking_fee' | 'session_fee';
  amountRwf?: number;
  /** `cash` is a session fee only (CHECK payment_cash_is_session_fee), and has no method. */
  provider?: PaymentProviderId | 'cash';
  providerRef?: string | null;
  failureReason?: string | null;
  /** How long ago it was initiated, on the database clock. */
  ageSeconds?: number;
  /** The overpaid part of an online session fee (Phase 4 overpayment decision; CHECK payment_overpaid_range). */
  overpaidRwf?: number;
  /** The method on the row; unset, a settled payment is `momo_mtn` and a waiting one has none. */
  method?: PaymentMethod | null;
};

export type SeededPayment = { id: string; ourRef: string };

const SETTLED_AT = new Date('2026-10-01T06:05:00Z');
/** Before the 06:00 the payment suites inject as now. */
const SETTLED_PAYMENT_AGE_MS = 10 * 60_000;

export async function insertPayment(prisma: PrismaClient, bookingId: string, seed: PaymentSeed = {}): Promise<SeededPayment> {
  const status = seed.status ?? 'pending';
  const settled = ['succeeded', 'refund_due', 'refunded'].includes(status);
  // A settled payment lives on the suites' fixed timeline: initiated before it
  // settled, and before the clock the tests inject. On the database clock it
  // would sort after every payment a test records "now" once the real date
  // passes that timeline (admin views list payments by initiated_at). A pending
  // one stays on the database clock, where the reconciler measures its age.
  const initiatedAt = settled ? new Date(SETTLED_AT.getTime() - SETTLED_PAYMENT_AGE_MS - (seed.ageSeconds ?? 0) * 1000) : null;
  const rows = await prisma.$queryRaw<{ id: string; our_ref: string }[]>`
    INSERT INTO payment (booking_id, kind, provider, amount_rwf, overpaid_rwf, status, provider_ref, failure_reason, initiated_at, settled_at, method)
    VALUES (${bookingId}::uuid, ${seed.kind ?? 'booking_fee'}, ${seed.provider ?? 'mtn_momo_direct'}, ${seed.amountRwf ?? 20_000}, ${seed.overpaidRwf ?? 0},
            ${status}, ${seed.providerRef ?? null}, ${seed.failureReason ?? null},
            COALESCE(${initiatedAt}::timestamptz, now() - make_interval(secs => ${seed.ageSeconds ?? 0}::double precision)),
            ${settled ? SETTLED_AT : null}::timestamptz, ${seed.method !== undefined ? seed.method : settled && seed.provider !== 'cash' ? 'momo_mtn' : null})
    RETURNING id::text AS id, our_ref::text AS our_ref`;
  const row = rows[0];
  if (row === undefined) throw new Error('The payment insert returned no row');
  return { id: row.id, ourRef: row.our_ref };
}

// --- Providers ------------------------------------------------------------------------

export type StubProvider = PaymentProvider & {
  initiated: InitiatePaymentRequest[];
  lookedUp: string[];
  deliveries: WebhookDelivery[];
};

export type StubBehaviour = {
  id?: PaymentProviderId;
  methods?: readonly PaymentMethod[];
  configured?: boolean;
  /** Defaults to EUR: the stub is MTN direct in its sandbox, the currency `mtnStatusBody` reports. */
  currency?: string;
  initiate?: (request: InitiatePaymentRequest, signal: AbortSignal) => Promise<InitiatePaymentResult>;
  lookupStatus?: (ourRef: string, signal: AbortSignal) => Promise<{ event: ProviderEvent; payload: unknown } | null>;
  verifyWebhook?: (delivery: WebhookDelivery) => boolean;
  parseWebhook?: (delivery: WebhookDelivery) => ProviderEvent | null;
  /** A browser checkout (cards): without one, `routePayments` never offers `card` through the stub. */
  browserCheckout?: (request: BrowserCheckoutRequest) => InlineCardConfig;
};

/** A provider that records what it is asked and answers what the test scripts: by default, accepted. */
export function stubProvider(behaviour: StubBehaviour = {}): StubProvider {
  const initiated: InitiatePaymentRequest[] = [];
  const lookedUp: string[] = [];
  const deliveries: WebhookDelivery[] = [];
  return {
    id: behaviour.id ?? 'mtn_momo_direct',
    methods: behaviour.methods ?? ['momo_mtn'],
    configured: behaviour.configured ?? true,
    currency: behaviour.currency ?? 'EUR',
    initiated,
    lookedUp,
    deliveries,
    async initiate(request, signal) {
      initiated.push(request);
      return behaviour.initiate ? behaviour.initiate(request, signal) : { outcome: 'accepted', providerRef: null };
    },
    async lookupStatus(ourRef, signal) {
      lookedUp.push(ourRef);
      return behaviour.lookupStatus ? behaviour.lookupStatus(ourRef, signal) : null;
    },
    verifyWebhook(delivery) {
      deliveries.push(delivery);
      return behaviour.verifyWebhook ? behaviour.verifyWebhook(delivery) : true;
    },
    parseWebhook(delivery) {
      return behaviour.parseWebhook ? behaviour.parseWebhook(delivery) : null;
    },
    ...(behaviour.browserCheckout === undefined ? {} : { browserCheckout: behaviour.browserCheckout }),
  };
}

/**
 * The routing a suite pays through (R3.1): every method each provider collects
 * goes to it, the later provider winning a method both collect -- so
 * `routeTo(mtn, flutterwave)` sends MTN MoMo to Flutterwave and
 * `routeTo(flutterwave, mtn)` sends it to MTN direct. `routePayments` still
 * drops an unconfigured provider, as production does.
 */
export function routeTo(...providers: PaymentProvider[]): PaymentRouting {
  const routes: Partial<Record<PaymentMethod, PaymentProvider>> = {};
  for (const provider of providers) for (const method of provider.methods) routes[method] = provider;
  return routePayments(routes);
}

export const MTN_CREDENTIALS = { subscriptionKey: 'sub-key-0123', apiUser: 'b1a7c2d4-0000-4000-8000-000000000001', apiKey: 'api-key-secret-9876' } as const;

/** The real MTN provider, pointed at a fake MTN. */
export function mtnProvider(options: { fetch?: typeof fetch; now?: () => number; credentials?: boolean } = {}): MtnMomoProvider {
  return new MtnMomoProvider({
    baseUrl: MTN_BASE_URL,
    targetEnvironment: 'sandbox',
    currency: 'EUR',
    ...(options.credentials === false ? {} : MTN_CREDENTIALS),
    callbackOrigin: API_ORIGIN,
    secret: TEST_SECRET,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** MTN's status body, as its callback and its status lookup both send it. */
export function mtnStatusBody(ourRef: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    financialTransactionId: nextTransactionId(),
    externalId: ourRef,
    amount: '20000',
    currency: 'EUR',
    payer: { partyIdType: 'MSISDN', partyId: '250788123456' },
    payerMessage: 'Bookly',
    payeeNote: 'Bookly',
    status,
    ...extra,
  };
}

/** The path of the callback URL MTN is handed for a payment: `/api/webhooks/mtn-momo/<ref>/<signature>`. */
export function callbackPath(provider: MtnMomoProvider, ourRef: string): string {
  return new URL(provider.callbackUrl(ourRef)).pathname;
}

/** A delivery MTN would make to the callback URL we gave it for `urlRef`. */
export function mtnDelivery(provider: MtnMomoProvider, urlRef: string, body: unknown): WebhookDelivery {
  const segments = callbackPath(provider, urlRef).split('/');
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return {
    rawBody,
    headers: { 'content-type': 'application/json' },
    params: { ourRef: segments.at(-2), signature: segments.at(-1) },
  };
}

/** Collects log entries instead of printing them. */
export function logSink(): { entries: Record<string, unknown>[]; log: (entry: Record<string, unknown>) => void } {
  const entries: Record<string, unknown>[] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

/** Resolves after `ms`. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
