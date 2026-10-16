import { Prisma, type PrismaClient } from '@prisma/client';
import { type OutboxKind, enqueue } from './enqueue.js';

/**
 * The outbox worker (plan.md Task 14; spec §6.17; data-model_v2.md §5.13): the
 * only retry mechanism in the system. One Node process, one loop.
 *
 * A row is claimed by moving it to `processing` and pushing `next_attempt_at`
 * out by a lease. Delivered, it becomes `done`. A handler that throws puts it
 * back to `pending` with exponential backoff; past the attempt ceiling -- or on
 * an error no retry can fix -- it becomes `failed` and the photographer gets an
 * `admin_alert` carrying the last error, in the same transaction.
 *
 * The lease is the crash recovery. The queue query takes any row whose
 * `next_attempt_at` has passed while `pending` OR `processing`, so a row claimed
 * by a process that then died is picked up again once its lease runs out --
 * which is exactly the predicate of the `outbox_queue_idx` partial index. The
 * attempt is counted at claim time, so a message that crashes the process
 * cannot be retried forever either.
 *
 * Delivery is at-least-once. A crash between the provider accepting a message
 * and the row being marked `done` sends it again after the lease; handlers pass
 * the `dedupe_key` to the provider as an idempotency key to close that gap.
 */

export type OutboxRow = {
  id: string;
  kind: OutboxKind;
  bookingId: string | null;
  dedupeKey: string;
  template: string | null;
  recipient: string | null;
  /** Null only after erasure (data-model_v2.md §10.2). */
  payload: unknown;
  /** Including the attempt now running. */
  attempts: number;
};

export type OutboxHandlerResult = { providerMessageId?: string | null } | void;

/** Delivers one row. Throws to retry; throws `PermanentOutboxError` to give up at once. */
export type OutboxHandler = (row: OutboxRow, signal: AbortSignal) => Promise<OutboxHandlerResult>;

export type OutboxHandlers = Partial<Record<OutboxKind, OutboxHandler>>;

/**
 * A failure retrying cannot fix: a payload that does not render, a recipient
 * the provider refuses outright. The row fails now instead of in hours.
 */
export class PermanentOutboxError extends Error {
  override readonly name = 'PermanentOutboxError';
}

export type OutboxWorkerDeps = {
  prisma: PrismaClient;
  /** Only kinds with a handler are claimed; the rest wait for theirs (e.g. Task 22). */
  handlers: OutboxHandlers;
  /** Structured log line sink. Defaults to stdout/stderr as JSON. */
  log?: (entry: Record<string, unknown>) => void;
};

/** Eight attempts, the last about two hours after the first (1+2+…+64 minutes of backoff). */
export const OUTBOX_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 6 * 60 * 60_000;
/** A claimed row nobody finishes becomes claimable again after this. */
export const OUTBOX_LEASE_MS = 5 * 60_000;
/** Well inside the lease, so a slow handler never overlaps its own retry. */
export const OUTBOX_HANDLER_TIMEOUT_MS = 60_000;
export const OUTBOX_POLL_INTERVAL_MS = 5_000;
const LAST_ERROR_MAX_LENGTH = 1000;

/**
 * The delay before the next attempt, after `attempts` have failed: one minute,
 * doubling each time, capped at six hours.
 */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_CAP_MS);
}

/**
 * The queue query: the next due row for these kinds, oldest due first. Exported
 * so a test can EXPLAIN exactly what the worker runs (plan.md Task 14).
 */
export function dueRowQuery(kinds: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT id
      FROM outbox
     WHERE status IN ('pending', 'processing')
       AND next_attempt_at <= now()
       AND kind = ANY(${[...kinds]}::text[])
       AND attempts < ${OUTBOX_MAX_ATTEMPTS}
     ORDER BY next_attempt_at
     LIMIT 1
     FOR UPDATE SKIP LOCKED`;
}

type ClaimedRowRecord = {
  id: string;
  kind: OutboxKind;
  booking_id: string | null;
  dedupe_key: string;
  template: string | null;
  recipient: string | null;
  payload: unknown;
  attempts: number;
};

/**
 * Claims the next due row, or returns null when nothing is due.
 *
 * A row whose lease ran out after its last allowed attempt was abandoned
 * mid-delivery every time -- the process died on it -- so it is failed and
 * alerted on instead of claimed again. Counting attempts at claim time is only
 * half of "cannot be retried forever"; this is the other half.
 */
export async function claimNext(
  prisma: PrismaClient,
  kinds: readonly string[],
  log: (entry: Record<string, unknown>) => void = defaultLog,
): Promise<OutboxRow | null> {
  if (kinds.length === 0) return null;
  await failAbandoned(prisma, kinds, log);
  const rows = await prisma.$queryRaw<ClaimedRowRecord[]>`
    UPDATE outbox
       SET status = 'processing',
           attempts = attempts + 1,
           next_attempt_at = now() + make_interval(secs => ${OUTBOX_LEASE_MS / 1000}::double precision)
     WHERE id = (${dueRowQuery(kinds)})
    RETURNING id::text AS id, kind, booking_id::text AS booking_id, dedupe_key, template, recipient, payload, attempts`;
  const row = rows[0];
  return row === undefined ? null : toRow(row);
}

function toRow(record: ClaimedRowRecord): OutboxRow {
  return {
    id: record.id,
    kind: record.kind,
    bookingId: record.booking_id,
    dedupeKey: record.dedupe_key,
    template: record.template,
    recipient: record.recipient,
    payload: record.payload,
    attempts: record.attempts,
  };
}

/**
 * Claims and delivers one row. Returns false when nothing was due, so a caller
 * can drain the queue with a loop.
 */
export async function processNext(deps: OutboxWorkerDeps): Promise<boolean> {
  const log = deps.log ?? defaultLog;
  const kinds = Object.keys(deps.handlers) as OutboxKind[];
  const row = await claimNext(deps.prisma, kinds, log);
  if (row === null) return false;

  const handler = deps.handlers[row.kind];
  if (handler === undefined) {
    // Unreachable: only kinds with a handler are claimed.
    throw new Error(`No handler for outbox kind ${row.kind}`);
  }

  let result: OutboxHandlerResult;
  try {
    result = await withTimeout(handler, row);
  } catch (error) {
    await recordFailure(deps, row, error, log);
    return true;
  }

  await deps.prisma.$executeRaw`
    UPDATE outbox
       SET status = 'done',
           completed_at = now(),
           provider_message_id = ${result?.providerMessageId ?? null}
     WHERE id = ${row.id}::uuid
       AND status = 'processing'`;
  return true;
}

/** Delivers everything due, one row at a time, until the queue is empty or `shouldStop`. */
export async function drainQueue(deps: OutboxWorkerDeps, shouldStop: () => boolean = () => false): Promise<number> {
  let processed = 0;
  while (!shouldStop() && (await processNext(deps))) processed += 1;
  return processed;
}

export type OutboxWorker = {
  /**
   * Stops polling and resolves once the row in hand, if any, is finished --
   * never mid-delivery, so SIGTERM leaves no row stranded in `processing`.
   */
  stop: () => Promise<void>;
};

/** Starts the loop: drain what is due, wait, repeat. */
export function startOutboxWorker(
  deps: OutboxWorkerDeps,
  pollIntervalMs: number = OUTBOX_POLL_INTERVAL_MS,
): OutboxWorker {
  const log = deps.log ?? defaultLog;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> = Promise.resolve();

  const tick = () => {
    timer = null;
    running = drainQueue(deps, () => stopping)
      .then(() => undefined)
      .catch((error: unknown) => {
        // A database hiccup must not kill the process that also serves the site;
        // the next tick tries again.
        log({ level: 'error', event: 'outbox_drain_failed', message: errorMessage(error) });
      })
      .finally(() => {
        if (!stopping) timer = setTimeout(tick, pollIntervalMs);
      });
  };
  tick();

  return {
    async stop() {
      stopping = true;
      if (timer !== null) clearTimeout(timer);
      await running;
    },
  };
}

// --- Failure --------------------------------------------------------------------

async function recordFailure(
  deps: OutboxWorkerDeps,
  row: OutboxRow,
  error: unknown,
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const lastError = storableError(error);
  const permanent = error instanceof PermanentOutboxError;
  // No recipient and no payload: both can carry personal data or a live token.
  const logged = { id: row.id, kind: row.kind, template: row.template, attempts: row.attempts, error: lastError };

  if (!permanent && row.attempts < OUTBOX_MAX_ATTEMPTS) {
    await deps.prisma.$executeRaw`
      UPDATE outbox
         SET status = 'pending',
             next_attempt_at = now() + make_interval(secs => ${backoffMs(row.attempts) / 1000}::double precision),
             last_error = ${lastError}
       WHERE id = ${row.id}::uuid
         AND status = 'processing'`;
    log({ level: 'warn', event: 'outbox_attempt_failed', ...logged });
    return;
  }

  const failed = await deps.prisma.$transaction(async (tx) => {
    const { count } = await tx.outbox.updateMany({
      where: { id: row.id, status: 'processing' },
      data: { status: 'failed', lastError },
    });
    if (count === 0) return false;
    await alertAdmin(tx, row, lastError, log);
    return true;
  });
  // Cancelled while in flight: nothing failed, so nothing to report.
  if (failed) log({ level: 'error', event: 'outbox_message_failed', permanent, ...logged });
}

const ABANDONED_ERROR = `Abandoned mid-delivery on all ${OUTBOX_MAX_ATTEMPTS} attempts: the process may be stopping or crashing on this message`;

/** Fails, with an alert each, the rows whose lease ran out after their last allowed attempt. */
async function failAbandoned(
  prisma: PrismaClient,
  kinds: readonly string[],
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const abandoned = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimedRowRecord[]>`
      UPDATE outbox
         SET status = 'failed',
             last_error = ${ABANDONED_ERROR}
       WHERE status = 'processing'
         AND next_attempt_at <= now()
         AND attempts >= ${OUTBOX_MAX_ATTEMPTS}
         AND kind = ANY(${[...kinds]}::text[])
      RETURNING id::text AS id, kind, booking_id::text AS booking_id, dedupe_key, template, recipient, payload, attempts`;
    for (const record of rows) {
      await alertAdmin(tx, toRow(record), ABANDONED_ERROR, log);
    }
    return rows;
  });
  for (const record of abandoned) {
    log({ level: 'error', event: 'outbox_message_abandoned', id: record.id, kind: record.kind, template: record.template, attempts: record.attempts });
  }
}

/**
 * Tells the photographer a message will not arrive (spec §6.17). Not for a
 * failed alert to him: the channel that just failed is the one it would use, and
 * a chain of alerts about alerts helps nobody -- that one is logged only.
 */
async function alertAdmin(
  tx: Prisma.TransactionClient,
  row: OutboxRow,
  lastError: string,
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  if (row.template === 'admin_alert') return;

  const admin = await tx.adminUser.findFirst({ orderBy: { createdAt: 'asc' }, select: { email: true } });
  if (admin === null) {
    log({ level: 'error', event: 'outbox_alert_skipped', reason: 'no_admin_user', id: row.id });
    return;
  }
  const booking =
    row.bookingId === null
      ? null
      : await tx.booking.findUnique({ where: { id: row.bookingId }, select: { reference: true } });

  await enqueue(tx, {
    kind: 'email',
    template: 'admin_alert',
    recipient: admin.email,
    dedupeKey: `email:admin_alert:retries_exhausted:${row.id}`,
    payload: {
      variant: 'retries_exhausted',
      messageKind: row.kind,
      template: row.template,
      bookingReference: booking?.reference ?? null,
      attempts: row.attempts,
      lastError,
    },
  });
}

// --- Helpers --------------------------------------------------------------------

/**
 * Runs the handler with an abort signal and a deadline. A handler that ignores
 * the signal is still abandoned at the deadline; the retry's idempotency key is
 * what stops that becoming a second delivery.
 */
async function withTimeout(handler: OutboxHandler, row: OutboxRow): Promise<OutboxHandlerResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Handler timed out after ${OUTBOX_HANDLER_TIMEOUT_MS} ms`));
    }, OUTBOX_HANDLER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([handler(row, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An error as `last_error` can hold it: bounded, and without the NUL character
 * PostgreSQL text refuses -- one in a provider's message would otherwise make
 * recording the failure itself fail, stranding the row in `processing`.
 */
function storableError(error: unknown): string {
  return errorMessage(error).replaceAll('\u0000', '\uFFFD').slice(0, LAST_ERROR_MAX_LENGTH);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function defaultLog(entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') console.error(line);
  else console.log(line);
}
