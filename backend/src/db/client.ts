import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { parseEnv } from '../env.js';

/**
 * Prisma 7 takes its connection through a driver adapter rather than a URL in
 * schema.prisma, so the URL is validated by env.ts before it is ever used.
 *
 * The client speaks only to the tables. Every guarantee that protects the
 * business -- the exclusion constraint, the four partial unique indexes, every
 * CHECK -- lives in migration SQL that Prisma cannot see and cannot report on
 * (data-model_v2.md 2.1). Losing one of them is caught by the schema test, not
 * by this client.
 */

/**
 * Pin the session timezone to UTC. This is not cosmetic and must not be removed.
 *
 * The adapter sends a JS `Date` as a naive timestamp rendered in UTC, with no
 * offset attached. PostgreSQL resolves a naive literal against the SESSION
 * timezone, so on a server set to Africa/Kigali (or Johannesburg, the same +02)
 * every written instant landed two hours early. Reads shifted back by the same
 * amount, so a Prisma round-trip looked correct and only a comparison against
 * the database's own `now()` exposed it -- which is how it survived until a hold
 * that should have lasted 30 minutes was stored 90 minutes in the past, already
 * lapsed at birth.
 *
 * With the session on UTC, what the adapter renders is what PostgreSQL stores.
 * Every instant in this system is UTC (data-model_v2.md §2); Kigali exists only
 * at the presentation boundary, in `format.ts` and `availability/engine.ts`.
 */
const FORCE_UTC_SESSION = '-c timezone=UTC';

export function createPrismaClient(databaseUrl = parseEnv().DATABASE_URL): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    options: FORCE_UTC_SESSION,
  });
  return new PrismaClient({ adapter });
}

export const prisma = createPrismaClient();
