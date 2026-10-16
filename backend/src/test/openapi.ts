import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { expect } from 'vitest';

// ajv and ajv-formats are CJS; load them through require so neither the default
// export nor its construct signature is lost to ESM interop under NodeNext.
const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const Ajv2020 = require('ajv/dist/2020.js') as any;
const addFormats = require('ajv-formats') as any;
type ValidateFunction = (data: unknown) => boolean;

/**
 * Loads the OpenAPI spec and holds the backend to it (plan.md Phase 3). Two
 * jobs:
 *
 * 1. `routeParity()` reads every Express route out of `src/routes/` and the
 *    mount prefixes out of a table here, and compares that set with the spec's
 *    operations. A route with no operation, an operation with no route, and a
 *    router whose prefix nobody declared are all failures.
 * 2. `expectMatchesSpec(res, operationId, status)` validates a real response
 *    body against the schema the spec gives that operation's status.
 *
 * The spec is the source of truth for the docs; this is what stops it drifting
 * from the code it documents.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(HERE, '..', 'routes');
export const SPEC_PATH = join(HERE, '..', '..', 'openapi', 'openapi.yaml');
/** The bundled copy the docs site vendors, so it can build without this folder. */
export const VENDORED_SPEC_PATH = join(HERE, '..', '..', '..', 'docs-site', 'openapi.json');

export type SpecOperation = {
  method: string;
  /** The Express-style path, e.g. `/api/admin/bookings/:id`. */
  path: string;
  operationId: string;
};

export type DereferencedSpec = {
  paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
};

let cached: DereferencedSpec | undefined;

/** The fully dereferenced spec, parsed and validated once. */
export async function loadSpec(): Promise<DereferencedSpec> {
  if (cached === undefined) {
    cached = (await SwaggerParser.validate(SPEC_PATH)) as unknown as DereferencedSpec;
  }
  return cached;
}

/** A spec file fully dereferenced, for comparing two specs structurally. A
 *  fresh parse each call (no shared cache), so the source and the vendored copy
 *  are resolved the same way. */
export async function dereferenceSpec(path: string): Promise<unknown> {
  return SwaggerParser.dereference(path);
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Every operation the spec declares, as `{ method, path, operationId }`. */
export function specOperations(spec: DereferencedSpec): SpecOperation[] {
  const operations: SpecOperation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      operations.push({ method, path: specPathToExpress(path), operationId: operation.operationId ?? `${method} ${path}` });
    }
  }
  return operations;
}

/** `/api/bookings/{id}` → `/api/bookings/:id`: the spec's path as Express writes it. */
function specPathToExpress(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

/**
 * Where each router function is mounted, mirroring `app.ts` and
 * `routes/admin.ts`. The key is the exported function name; the value is the
 * full prefix its `router.<method>('<subpath>')` calls hang off.
 *
 * A router found in `src/routes/` whose function is not named here fails the
 * parity test, so a new router cannot be added without being placed on the map.
 */
const MOUNTS: Record<string, string> = {
  healthRouter: '/api',
  publicCatalogueRouter: '/api',
  availabilityRouter: '/api/availability',
  bookingsRouter: '/api/bookings',
  checkoutRouter: '/api',
  bookingLinksRouter: '/api/booking-links',
  emailConfirmationsRouter: '/api/email-confirmations',
  clientBookingRouter: '/api/booking',
  paymentWebhooksRouter: '/api/webhooks',
  adminRouter: '/api/admin',
  // Mounted inside adminRouter (routes/admin.ts).
  workingHoursRouter: '/api/admin/working-hours',
  blocksRouter: '/api/admin/blocks',
  settingsRouter: '/api/admin/settings',
  calendarRouter: '/api/admin/calendar',
  adminBookingsRouter: '/api/admin',
  catalogueRouter: '/api/admin',
};

/**
 * Router functions found in `src/routes/` that are not themselves a mount: they
 * compose other routers. `adminRouter` is NOT here — it both composes the admin
 * sub-routers and defines `/auth/*` and `/me` directly, which must be scanned.
 */
const NOT_A_MOUNT = new Set<string>([]);

export type ScannedRoute = { method: string; path: string; file: string; fn: string };

/**
 * Reads every `router.<method>('<path>')` out of `src/routes/*.ts`, resolves it
 * against the mount table, and returns the full API paths. Throws if a router
 * function has no entry in `MOUNTS`, so the table cannot fall silently behind.
 */
export function scanRoutes(): { routes: ScannedRoute[]; unmapped: string[] } {
  const routes: ScannedRoute[] = [];
  const unmapped = new Set<string>();

  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const source = readFileSync(join(ROUTES_DIR, file), 'utf8');

    for (const segment of splitByRouterFunction(source)) {
      const prefix = MOUNTS[segment.fn];
      for (const route of routerCalls(segment.body, segment.fn)) {
        if (prefix === undefined) {
          unmapped.add(segment.fn);
          continue;
        }
        routes.push({ method: route.method, path: joinPath(prefix, route.subpath), file, fn: segment.fn });
      }
    }
  }
  return { routes, unmapped: [...unmapped] };
}

type Segment = { fn: string; body: string };

/**
 * Splits a route file into one segment per exported router, so a file holding
 * two routers (admin-availability.ts) attributes each route to the right one.
 * Both forms are recognised: `export function <name>Router(` (the factory
 * routers) and `export const <name>Router =` (health.ts). A route defined
 * before any exported router — there are none — would fall outside every
 * segment and simply not be scanned.
 */
function splitByRouterFunction(source: string): Segment[] {
  const pattern = /export (?:function|const) (\w+)/g;
  const marks: { fn: string; index: number }[] = [];
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    if (!NOT_A_MOUNT.has(match[1]!)) marks.push({ fn: match[1]!, index: match.index });
  }
  return marks.map((mark, i) => ({ fn: mark.fn, body: source.slice(mark.index, marks[i + 1]?.index ?? source.length) }));
}

/**
 * Every route call in a segment, whatever the router variable is called. Counts
 * a `<receiver>.<method>('<path>')` when the receiver is the local `router` (the
 * factory routers) or the segment's own export (`healthRouter.get(...)`), so a
 * stray method call on something else is never mistaken for a route.
 */
function routerCalls(body: string, fn: string): { method: string; subpath: string }[] {
  const calls: { method: string; subpath: string }[] = [];
  const pattern = /(\w+)\.(get|post|put|patch|delete)\(\s*'([^']*)'/g;
  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const receiver = match[1]!;
    if (receiver === 'router' || receiver === fn) calls.push({ method: match[2]!, subpath: match[3]! });
  }
  return calls;
}

/** Joins a mount prefix and a router subpath into one API path, without a trailing slash. */
function joinPath(prefix: string, subpath: string): string {
  if (subpath === '/' || subpath === '') return prefix;
  return `${prefix}${subpath.startsWith('/') ? '' : '/'}${subpath}`;
}

// --- Response validation ------------------------------------------------------

const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
const validators = new Map<string, ValidateFunction>();
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Asserts that `res` (a supertest response) matches the schema the spec gives
 * `operationId` at `status`. Fails loudly if the spec has no such operation,
 * status, or JSON schema, so a drifted operationId cannot pass by being
 * silently skipped.
 */
export async function expectMatchesSpec(
  res: { status: number; body: unknown },
  operationId: string,
  status: number,
): Promise<void> {
  const spec = await loadSpec();
  expect(res.status, `expected HTTP ${status} for ${operationId}`).toBe(status);

  const schema = responseSchema(spec, operationId, status);
  const key = `${operationId}:${status}`;
  const cachedValidate = validators.get(key);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const validate: ValidateFunction & { errors?: unknown } = cachedValidate ?? (ajv.compile(schema) as any);
  if (cachedValidate === undefined) validators.set(key, validate);

  if (!validate(res.body)) {
    throw new Error(
      `${operationId} ${status} response does not match the spec:\n${JSON.stringify(validate.errors, null, 2)}`,
    );
  }
}

function responseSchema(spec: DereferencedSpec, operationId: string, status: number): object {
  for (const item of Object.values(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method] as
        | { operationId?: string; responses?: Record<string, { content?: Record<string, { schema?: object }> }> }
        | undefined;
      if (operation?.operationId !== operationId) continue;
      const response = operation.responses?.[String(status)];
      const schema = response?.content?.['application/json']?.schema;
      if (schema === undefined) {
        throw new Error(`${operationId} has no application/json schema for status ${status} in the spec`);
      }
      return schema;
    }
  }
  throw new Error(`No operation with operationId "${operationId}" in the spec`);
}
