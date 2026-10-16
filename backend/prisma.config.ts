import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the connection URL out of schema.prisma and into this file.
 * DATABASE_URL is validated properly at boot by src/env.ts; here it is read raw,
 * because the CLI runs before the app does.
 */

/**
 * The URL the CLI migrates through. Hosted Postgres behind a connection pooler
 * (Neon's `-pooler` host, PgBouncer) must be migrated over a direct connection:
 * `migrate deploy` holds a session-level advisory lock that a transaction-mode
 * pooler can hand to another client mid-migration. DIRECT_URL is that direct
 * connection; the running app keeps using DATABASE_URL, pooled.
 */
const cliUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

/** A scratch database Prisma creates and drops to replay migration history. */
function shadowUrl(): string | undefined {
  if (process.env.SHADOW_DATABASE_URL) return process.env.SHADOW_DATABASE_URL;
  if (!cliUrl) return undefined;
  const url = new URL(cliUrl);
  url.pathname = `${url.pathname}_shadow`;
  return url.toString();
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: cliUrl,
    shadowDatabaseUrl: shadowUrl(),
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
