import pg from 'pg';

/**
 * Schema tests run against a real PostgreSQL database, because the thing under
 * test IS the database: a per-photographer exclusion constraint, composite
 * foreign keys, partial unique indexes and dozens of CHECKs, none of which
 * Prisma knows about. Mocking here would test nothing.
 *
 * They run against their own database, never the development one. The seed
 * fills dev with the platform admin, the platform settings and the categories;
 * a suite that truncates would wipe them on every run.
 */
export function testDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return explicit;

  const devUrl = process.env.DATABASE_URL;
  if (!devUrl) {
    throw new Error('Neither TEST_DATABASE_URL nor DATABASE_URL is set; cannot run schema tests.');
  }

  const url = new URL(devUrl);
  const name = url.pathname.replace(/^\//, '');
  if (!name) throw new Error(`DATABASE_URL names no database: ${url.host}`);
  url.pathname = `/${name}_test`;
  return url.toString();
}

/** The `postgres` maintenance database on the same server, for CREATE DATABASE. */
export function maintenanceUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

export function databaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}

/**
 * Every application table the tests write, children first, for TRUNCATE ...
 * CASCADE. Photographers sit below everything they own: their catalogue,
 * calendar and bookings all reference them (marketplace-data-model.md §3.10).
 */
export const APPLICATION_TABLES = [
  // The platform's audit trail (Phase 9): references the acting admin and the photographer.
  'platform_audit',
  // Payouts (Phase 4): items reference payments and payouts, payouts their
  // method, and all three their photographer and the admins who acted.
  'payout_item',
  'payout',
  'payout_method',
  // A booking's notes to its client (2026-09-25).
  'booking_note',
  'booking_addon',
  // Subscriptions (Phase 5): a period references its payment and subscription,
  // a payment may reference a subscription, and a subscription its photographer.
  'subscription_period',
  'payment',
  'subscription',
  'webhook_event',
  'outbox',
  'booking',
  'client',
  'package',
  'addon',
  'service',
  'availability_block',
  'working_hours',
  'portfolio_image',
  'photographer_category',
  'photographer_district',
  'category',
  'photographer_setting',
  'photographer',
  'platform_setting',
  'app_user',
  // Google sign-ins in flight (Phase 2 decision 6); references nothing.
  'oauth_flow',
] as const;

/**
 * Reference data the baseline migration inserts and NOTHING truncates: Rwanda's
 * 30 districts (marketplace-data-model.md §3.4). Truncating it would leave every
 * later test without districts, and no fixture re-creates them.
 */
export const REFERENCE_TABLES = ['district'] as const;

export function connect(): pg.Client {
  return new pg.Client({ connectionString: testDatabaseUrl() });
}

export async function truncateAll(client: pg.Client): Promise<void> {
  await client.query(`TRUNCATE ${APPLICATION_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/** The SQLSTATE a failed statement reported, or undefined if it did not fail. */
export async function sqlstateOf(client: pg.Client, run: () => Promise<unknown>) {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** The first row, or a clear failure. `noUncheckedIndexedAccess` is on. */
export function firstRow<T extends pg.QueryResultRow>(result: pg.QueryResult<T>): T {
  const row = result.rows[0];
  if (!row) throw new Error('Expected at least one row, got none');
  return row;
}
