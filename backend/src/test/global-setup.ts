import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { databaseName, maintenanceUrl, testDatabaseUrl } from './database.js';

/**
 * Creates the test database if it is absent, then brings it to the head of
 * migration history with `migrate deploy` -- the same command production runs.
 *
 * `prisma db push` is never used here or anywhere else: it reconciles the
 * database to schema.prisma and would drop the exclusion constraint, so the
 * suite would then pass against a database missing the thing it is testing.
 */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const name = databaseName(url);

  const admin = new pg.Client({ connectionString: maintenanceUrl(url) });
  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await admin.end();
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // DIRECT_URL too: prisma.config.ts migrates through it when set, and left
    // alone it would point this migration at the development database.
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}
