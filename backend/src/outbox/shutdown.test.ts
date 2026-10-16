import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import { emailFixture } from '../test/email-fixtures.js';

/**
 * The worker starts with the API process and stops cleanly on SIGTERM without
 * abandoning a claimed row in `processing` (plan.md Task 14).
 *
 * This runs the real `src/server.ts` in a child process against the test
 * database, with no RESEND_API_KEY -- so mail goes to the file sink in a temp
 * directory, never to a network. A preload module slows the sink's `.html`
 * write so the signal lands mid-delivery, and reports over IPC when delivery
 * has started.
 *
 * Signals: on POSIX the child gets a real SIGTERM or SIGINT. Windows has no
 * POSIX signals -- `child.kill('SIGTERM')` there is TerminateProcess, which no
 * handler can observe -- so on Windows the preload re-emits the signal inside
 * the child when asked over IPC. That exercises server.ts's own shutdown
 * handler, but not the OS delivering the signal.
 */

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SLOW_MAIL_MS = 2500;
const STARTUP_TIMEOUT_MS = 60_000;

const PRELOAD = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const original = fsp.writeFile;
const dir = process.env.MAIL_OUTPUT_DIR;
const delay = Number(process.env.BOOKLY_TEST_SLOW_MAIL_MS ?? '0');
fsp.writeFile = async function slowWriteFile(file, ...rest) {
  if (String(file).startsWith(dir) && String(file).endsWith('.html')) {
    process.send?.({ event: 'delivery_started' });
    await new Promise((done) => setTimeout(done, delay));
  }
  return original.call(this, file, ...rest);
};
syncBuiltinESMExports();
process.on('message', (message) => {
  if (typeof message === 'string' && message.startsWith('emulate:')) {
    const signal = message.slice('emulate:'.length);
    process.emit(signal, signal);
  }
});
`;

let raw: pg.Client;
let workDir: string;
let child: ChildProcess | undefined;

beforeAll(async () => {
  raw = connect();
  await raw.connect();
});

afterAll(async () => {
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  workDir = await mkdtemp(join(tmpdir(), 'bookly-shutdown-'));
});

afterEach(async () => {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise((done) => child?.once('exit', done));
  }
  child = undefined;
  await rm(workDir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

type Started = { child: ChildProcess; output: () => string; mailDir: string };

async function startServer(): Promise<Started> {
  const mailDir = join(workDir, 'mail');
  const preload = join(workDir, 'slow-mail-preload.mjs');
  await writeFile(preload, PRELOAD, 'utf8');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(await freePort()),
    DATABASE_URL: testDatabaseUrl(),
    WEB_ORIGIN: 'https://bookly.example',
    SESSION_SECRET: 'shutdown-test-secret-that-is-at-least-32-characters',
    MAIL_OUTPUT_DIR: mailDir,
    BOOKLY_TEST_SLOW_MAIL_MS: String(SLOW_MAIL_MS),
    // The child's `dotenv/config` would otherwise read backend/.env and fill in
    // whatever is missing here: a live mail key (real email to test addresses)
    // or the developer's PAYMENT_PROVIDER. Point it at a file that is not there.
    DOTENV_CONFIG_PATH: join(workDir, 'no-such.env'),
  };
  // This process loaded backend/.env too; none of it reaches the child.
  for (const key of ['RESEND_API_KEY', 'BREVO_API_KEY', 'PAYMENT_PROVIDER', 'API_ORIGIN', 'MAIL_FROM', 'MAIL_REPLY_TO', 'DIRECT_URL']) {
    delete env[key];
  }

  const spawned = spawn(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(preload).href, 'src/server.ts'], {
    cwd: BACKEND_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child = spawned;
  let output = '';
  spawned.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  spawned.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return { child: spawned, output: () => output, mailDir };
}

function waitFor<T>(what: string, started: Started, attach: (settle: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`Timed out waiting for ${what}. Child output:\n${started.output()}`)),
      STARTUP_TIMEOUT_MS,
    );
    started.child.once('exit', (code) => {
      if (what !== 'exit') {
        clearTimeout(timer);
        fail(new Error(`Child exited (${code}) while waiting for ${what}. Output:\n${started.output()}`));
      }
    });
    attach((value) => {
      clearTimeout(timer);
      done(value);
    });
  });
}

function exitOf(started: Started): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (started.child.exitCode !== null || started.child.signalCode !== null) {
    return Promise.resolve({ code: started.child.exitCode, signal: started.child.signalCode });
  }
  return waitFor('exit', started, (settle) => started.child.once('exit', (code, signal) => settle({ code, signal })));
}

function sendSignal(started: Started, signal: 'SIGTERM' | 'SIGINT' = 'SIGTERM'): void {
  if (process.platform === 'win32') started.child.send(`emulate:${signal}`);
  else started.child.kill(signal);
}

async function outboxState(): Promise<{ status: string; provider_message_id: string | null; attempts: number }[]> {
  const result = await raw.query<{ status: string; provider_message_id: string | null; attempts: number }>(
    `SELECT status, provider_message_id, attempts FROM outbox ORDER BY created_at`,
  );
  return result.rows;
}

describe('the API process and the outbox worker', () => {
  it('finishes the delivery in hand on SIGTERM and leaves no row in processing', async () => {
    const fixture = emailFixture('booking_confirmation');
    await raw.query(
      `INSERT INTO outbox (kind, dedupe_key, template, recipient, payload)
       VALUES ('email', 'email:booking_confirmation:shutdown-test', $1, 'aline@example.com', $2::jsonb)`,
      [fixture.template, JSON.stringify(fixture.payload)],
    );

    const started = await startServer();
    await waitFor<void>('delivery_started', started, (settle) =>
      started.child.on('message', (message: { event?: string }) => {
        if (message?.event === 'delivery_started') settle();
      }),
    );

    // The worker started with the process and has the row in hand.
    expect((await outboxState()).map((row) => row.status)).toEqual(['processing']);

    const signalledAt = Date.now();
    sendSignal(started);
    // An impatient second signal must not cut the delivery short either.
    await new Promise((done) => setTimeout(done, 200));
    sendSignal(started);
    const exit = await exitOf(started);

    expect(exit.code, started.output()).toBe(0);
    // It waited for the slowed delivery rather than exiting on the signal.
    expect(Date.now() - signalledAt).toBeGreaterThan(SLOW_MAIL_MS / 2);
    expect(started.output()).toContain('"event":"shutdown"');
    const rows = await outboxState();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'done', attempts: 1 });
    expect(rows[0]?.provider_message_id).toMatch(/^file:[0-9a-f]{12}$/);
    const files = await readdir(started.mailDir);
    expect(files.filter((name) => name.endsWith('.html'))).toHaveLength(1);
    expect(files.filter((name) => name.endsWith('.txt'))).toHaveLength(1);
    const count = firstRow(await raw.query<{ n: string }>(`SELECT count(*) AS n FROM outbox WHERE status = 'processing'`));
    expect(Number(count.n)).toBe(0);
  }, 120_000);

  it.each(['SIGTERM', 'SIGINT'] as const)('exits promptly on %s when the worker is idle', async (signal) => {
    const started = await startServer();
    await waitFor<void>('the server to listen', started, (settle) =>
      started.child.stdout?.on('data', () => {
        if (started.output().includes('api listening')) settle();
      }),
    );

    const signalledAt = Date.now();
    sendSignal(started, signal);
    const exit = await exitOf(started);

    expect(exit.code, started.output()).toBe(0);
    expect(started.output()).toContain(`"signal":"${signal}"`);
    expect(Date.now() - signalledAt).toBeLessThan(15_000);
    await expect(outboxState()).resolves.toEqual([]);
  }, 120_000);
});
