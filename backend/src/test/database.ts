import pg from 'pg';

/**
 * Schema tests run against a real PostgreSQL database, because the thing under
 * test IS the database: an exclusion constraint, four partial unique indexes and
 * 43 CHECKs, none of which Prisma knows about. Mocking here would test nothing.
 *
 * They run against their own database, never the development one. Task 4 seeds
 * dev with the admin user and the working hours; a suite that truncates would
 * wipe them on every run.
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

/** Every application table, children first, for TRUNCATE ... CASCADE. */
export const APPLICATION_TABLES = [
  // A booking's notes to its client (2026-09-25).
  'booking_note',
  'booking_addon',
  'payment',
  'webhook_event',
  'outbox',
  'booking',
  'client',
  'package',
  'addon',
  'service',
  'availability_block',
  'working_hours',
  'setting',
  'admin_user',
] as const;

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
