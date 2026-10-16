import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrevoMailProvider, parseSender } from './brevo.js';
import { FileMailProvider } from './file-provider.js';
import { createMailProvider } from './mailer.js';
import { type MailMessage, MailRejectedError } from './provider.js';
import { ResendMailProvider } from './resend.js';

/**
 * The mail providers (plan.md Stack decisions: Resend behind a MailProvider
 * interface). `fetch` is always injected or stubbed: nothing here reaches the
 * network.
 */

const MESSAGE: MailMessage = {
  to: 'aline@example.com',
  subject: 'Booking confirmed: Portrait on Wednesday, 7 October 2026 (BKY-2610-7K3MQ)',
  html: '<p>Hello Aline</p>',
  text: 'Hello Aline',
  idempotencyKey: 'email:booking_confirmation:3f0c2a64-9f3e-4bd4-8a1b-9f1d3e3b8c11',
};

type Captured = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response) {
  const calls: Captured[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function headersOf(call: Captured | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(call?.init.headers).entries());
}

function bodyOf(call: Captured | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body)) as Record<string, unknown>;
}

// --- Resend -----------------------------------------------------------------------

describe('ResendMailProvider', () => {
  it('POSTs the message to the Resend emails endpoint with the key, JSON and the idempotency key', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { id: 're_msg_123' }));
    const provider = new ResendMailProvider({ apiKey: 're_test_key', from: 'Bookly <bookings@bookly.example>', fetch: impl });

    await expect(provider.send(MESSAGE)).resolves.toEqual({ providerMessageId: 're_msg_123' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.resend.com/emails');
    expect(call?.init.method).toBe('POST');
    expect(headersOf(call)).toEqual({
      authorization: 'Bearer re_test_key',
      'content-type': 'application/json',
      'idempotency-key': MESSAGE.idempotencyKey,
    });
    expect(bodyOf(call)).toEqual({
      from: 'Bookly <bookings@bookly.example>',
      to: ['aline@example.com'],
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
    });
    expect(bodyOf(call)).not.toHaveProperty('reply_to');
  });

  it('adds reply_to only when one is configured', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { id: 'x' }));
    const provider = new ResendMailProvider({
      apiKey: 'k',
      from: 'Bookly <bookings@bookly.example>',
      replyTo: 'photographer@bookly.example',
      fetch: impl,
    });

    await provider.send(MESSAGE);

    expect(bodyOf(calls[0])).toMatchObject({ reply_to: 'photographer@bookly.example' });
  });

  it('passes the abort signal through to fetch', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { id: 'x' }));
    const provider = new ResendMailProvider({ apiKey: 'k', from: 'f@bookly.example', fetch: impl });
    const controller = new AbortController();

    await provider.send(MESSAGE, controller.signal);

    expect(calls[0]?.init.signal).toBe(controller.signal);
  });

  it('sends a dedupe key of up to 256 characters as it is, and the SHA-256 of a longer one', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { id: 'x' }));
    const provider = new ResendMailProvider({ apiKey: 'k', from: 'f@bookly.example', fetch: impl });
    const exactly256 = 'k'.repeat(256);
    const tooLong = 'k'.repeat(257);

    await provider.send({ ...MESSAGE, idempotencyKey: exactly256 });
    await provider.send({ ...MESSAGE, idempotencyKey: tooLong });
    await provider.send({ ...MESSAGE, idempotencyKey: tooLong });

    expect(headersOf(calls[0])['idempotency-key']).toBe(exactly256);
    const hashed = createHash('sha256').update(tooLong).digest('hex');
    expect(headersOf(calls[1])['idempotency-key']).toBe(hashed);
    // Stable across retries, which is the point of the key.
    expect(headersOf(calls[2])['idempotency-key']).toBe(hashed);
  });

  it.each([
    ['a body without an id', () => json(200, { ok: true })],
    ['a non-string id', () => json(200, { id: 42 })],
    ['a body that is not JSON', () => new Response('accepted', { status: 200 })],
  ])('returns a null provider id for %s', async (_case, respond) => {
    const { impl } = fakeFetch(respond);
    const provider = new ResendMailProvider({ apiKey: 'k', from: 'f@bookly.example', fetch: impl });

    await expect(provider.send(MESSAGE)).resolves.toEqual({ providerMessageId: null });
  });

  it.each([400, 422])('throws MailRejectedError on %i: the message itself is refused', async (status) => {
    const { impl } = fakeFetch(() => json(status, { name: 'validation_error', message: 'Invalid `to` field.' }));
    const provider = new ResendMailProvider({ apiKey: 're_secret_key', from: 'f@bookly.example', fetch: impl });

    const error = await provider.send(MESSAGE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailRejectedError);
    // The status and Resend's error name, and nothing of its message: that
    // text reaches last_error, the logs and the photographer's alert.
    expect((error as Error).message).toBe(`Resend answered ${status} (validation_error)`);
    expect((error as Error).message).not.toContain('re_secret_key');
    expect((error as Error).message).not.toContain(MESSAGE.html);
  });

  it.each([401, 403, 409, 429, 500, 502, 503])('throws a retryable Error, not MailRejectedError, on %i', async (status) => {
    const { impl } = fakeFetch(() => json(status, { message: 'try later' }));
    const provider = new ResendMailProvider({ apiKey: 'k', from: 'f@bookly.example', fetch: impl });

    const error = await provider.send(MESSAGE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailRejectedError);
    expect((error as Error).message).toContain(`Resend answered ${status}`);
  });

  it('quotes none of what the provider said, so a recipient it echoes never reaches last_error or an alert', async () => {
    const echoed = `Invalid \`to\` field: ${MESSAGE.to} is not allowed`;
    const cases: Response[] = [
      json(422, { name: 'validation_error', message: echoed }),
      json(500, { name: 'internal_server_error', message: echoed }),
      new Response(`${'z'.repeat(5000)} ${MESSAGE.to}`, { status: 500 }),
      // A `name` that is not an error code is not quoted either.
      json(500, { name: `oops ${MESSAGE.to}`, message: echoed }),
    ];
    const messages: string[] = [];
    for (const response of cases) {
      const { impl } = fakeFetch(() => response);
      const provider = new ResendMailProvider({ apiKey: 'k', from: 'f@bookly.example', fetch: impl });
      messages.push(((await provider.send(MESSAGE).catch((e: unknown) => e)) as Error).message);
    }

    expect(messages).toEqual([
      'Resend answered 422 (validation_error)',
      'Resend answered 500 (internal_server_error)',
      'Resend answered 500',
      'Resend answered 500',
    ]);
    for (const message of messages) expect(message).not.toContain(MESSAGE.to);
  });

  it('lets a network failure or an abort propagate as retryable', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const provider = new ResendMailProvider({ apiKey: 'k', from: 'f@bookly.example', fetch: failing });

    const error = await provider.send(MESSAGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(MailRejectedError);
  });
});

// --- Brevo ------------------------------------------------------------------------

describe('BrevoMailProvider', () => {
  it('POSTs the message to the Brevo transactional endpoint with the key and JSON', async () => {
    const { impl, calls } = fakeFetch(() => json(201, { messageId: '<202609251200.123@smtp-relay.mailin.fr>' }));
    const provider = new BrevoMailProvider({ apiKey: 'xkeysib-test', from: 'Bookly <bookings@bookly.example>', fetch: impl });

    await expect(provider.send(MESSAGE)).resolves.toEqual({ providerMessageId: '<202609251200.123@smtp-relay.mailin.fr>' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(call?.init.method).toBe('POST');
    expect(headersOf(call)).toEqual({
      'api-key': 'xkeysib-test',
      'content-type': 'application/json',
      accept: 'application/json',
    });
    expect(bodyOf(call)).toEqual({
      sender: { name: 'Bookly', email: 'bookings@bookly.example' },
      to: [{ email: 'aline@example.com' }],
      subject: MESSAGE.subject,
      htmlContent: MESSAGE.html,
      textContent: MESSAGE.text,
    });
  });

  it('adds replyTo only when one is configured', async () => {
    const { impl, calls } = fakeFetch(() => json(201, { messageId: 'x' }));
    const provider = new BrevoMailProvider({
      apiKey: 'k',
      from: 'bookings@bookly.example',
      replyTo: 'photographer@bookly.example',
      fetch: impl,
    });

    await provider.send(MESSAGE);

    expect(bodyOf(calls[0])).toMatchObject({ replyTo: { email: 'photographer@bookly.example' } });
  });

  it('passes the abort signal through to fetch', async () => {
    const { impl, calls } = fakeFetch(() => json(201, { messageId: 'x' }));
    const provider = new BrevoMailProvider({ apiKey: 'k', from: 'f@bookly.example', fetch: impl });
    const controller = new AbortController();

    await provider.send(MESSAGE, controller.signal);

    expect(calls[0]?.init.signal).toBe(controller.signal);
  });

  it.each([
    ['a body without a messageId', () => json(201, { ok: true })],
    ['a non-string messageId', () => json(201, { messageId: 42 })],
    ['a body that is not JSON', () => new Response('accepted', { status: 201 })],
  ])('returns a null provider id for %s', async (_case, respond) => {
    const { impl } = fakeFetch(respond);
    const provider = new BrevoMailProvider({ apiKey: 'k', from: 'f@bookly.example', fetch: impl });

    await expect(provider.send(MESSAGE)).resolves.toEqual({ providerMessageId: null });
  });

  it('throws MailRejectedError on 400, quoting the code and nothing of the message', async () => {
    const { impl } = fakeFetch(() => json(400, { code: 'invalid_parameter', message: `email is not valid: ${MESSAGE.to}` }));
    const provider = new BrevoMailProvider({ apiKey: 'xkeysib-secret', from: 'f@bookly.example', fetch: impl });

    const error = await provider.send(MESSAGE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailRejectedError);
    expect((error as Error).message).toBe('Brevo answered 400 (invalid_parameter)');
    expect((error as Error).message).not.toContain('xkeysib-secret');
    expect((error as Error).message).not.toContain(MESSAGE.to);
  });

  it.each([401, 402, 403, 429, 500, 502, 503])('throws a retryable Error, not MailRejectedError, on %i', async (status) => {
    const { impl } = fakeFetch(() => json(status, { code: 'unauthorized', message: 'try later' }));
    const provider = new BrevoMailProvider({ apiKey: 'k', from: 'f@bookly.example', fetch: impl });

    const error = await provider.send(MESSAGE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailRejectedError);
    expect((error as Error).message).toContain(`Brevo answered ${status}`);
  });

  it('does not quote a code that is not an error code', async () => {
    const { impl } = fakeFetch(() => json(500, { code: `oops ${MESSAGE.to}` }));
    const provider = new BrevoMailProvider({ apiKey: 'k', from: 'f@bookly.example', fetch: impl });

    expect(((await provider.send(MESSAGE).catch((e: unknown) => e)) as Error).message).toBe('Brevo answered 500');
  });

  it('lets a network failure propagate as retryable', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const provider = new BrevoMailProvider({ apiKey: 'k', from: 'f@bookly.example', fetch: failing });

    const error = await provider.send(MESSAGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
  });
});

describe('parseSender', () => {
  it.each([
    ['Bookly <bookings@bookly.example>', { name: 'Bookly', email: 'bookings@bookly.example' }],
    ['"Bookly Studio" <hello@bookly.example>', { name: 'Bookly Studio', email: 'hello@bookly.example' }],
    ['  bookings@bookly.example ', { email: 'bookings@bookly.example' }],
    ['<bookings@bookly.example>', { email: 'bookings@bookly.example' }],
  ])('reads %s', (from, expected) => {
    expect(parseSender(from)).toEqual(expected);
  });

  it.each(['Bookly', 'Bookly <not an address>', 'Bookly <a@b> trailing'])('refuses %s, naming MAIL_FROM', (from) => {
    expect(() => parseSender(from)).toThrow(/MAIL_FROM/);
  });

  it('refuses a bad sender when the provider is built, not on first send', () => {
    expect(() => new BrevoMailProvider({ apiKey: 'k', from: 'Bookly' })).toThrow(/MAIL_FROM/);
  });
});

// --- File sink -------------------------------------------------------------------

describe('FileMailProvider', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bookly-mail-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes an .html and a .txt file into the directory, creating it, and returns a file: id', async () => {
    const target = join(dir, 'nested', 'mail');
    const provider = new FileMailProvider(target);

    const result = await provider.send(MESSAGE);

    const id = createHash('sha256').update(MESSAGE.idempotencyKey).digest('hex').slice(0, 12);
    expect(result).toEqual({ providerMessageId: `file:${id}` });
    const files = (await readdir(target)).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${id}\\.html$`));
    expect(files[1]).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${id}\\.txt$`));

    const text = await readFile(join(target, files[1] ?? ''), 'utf8');
    expect(text).toBe(`To: ${MESSAGE.to}\nSubject: ${MESSAGE.subject}\n\n${MESSAGE.text}`);
    const html = await readFile(join(target, files[0] ?? ''), 'utf8');
    expect(html.endsWith(`-->\n${MESSAGE.html}`)).toBe(true);
    expect(html).toContain(`Subject: ${MESSAGE.subject}`);
  });

  it('overwrites rather than piles up when one row is retried', async () => {
    const provider = new FileMailProvider(dir);

    await provider.send(MESSAGE);
    await provider.send({ ...MESSAGE, text: 'second attempt' });
    await provider.send({ ...MESSAGE, idempotencyKey: 'email:booking_confirmation:another' });

    expect(await readdir(dir)).toHaveLength(4);
  });

  it.each(['plain -- dashes', 'an arrow -->', 'a long arrow --->', 'a bang --!>', 'many ------>'])(
    'keeps a subject with %s inside the header comment',
    async (subject) => {
      const provider = new FileMailProvider(dir);
      const html = '<p>body</p>';

      await provider.send({ ...MESSAGE, subject: `${subject} <script>alert(1)</script>`, html });

      const file = (await readdir(dir)).find((name) => name.endsWith('.html')) ?? '';
      const content = await readFile(join(dir, file), 'utf8');
      // The comment must end exactly once, right before the body: nothing a
      // visitor typed into a subject may become live markup in the dev file.
      const comment = content.slice(0, content.length - html.length - 1);
      expect(comment.startsWith('<!--')).toBe(true);
      expect(comment.endsWith('-->')).toBe(true);
      const inner = comment.slice(4, -3);
      expect(inner).not.toMatch(/--!?>/);
    },
  );
});

// --- Choice ------------------------------------------------------------------------

describe('createMailProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses Resend when RESEND_API_KEY is set, with the configured sender and reply-to', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { id: 're_from_env' }));
    vi.stubGlobal('fetch', impl);

    const provider = createMailProvider({
      RESEND_API_KEY: 're_env_key',
      MAIL_FROM: 'Bookly <bookings@bookly.example>',
      MAIL_REPLY_TO: 'photographer@bookly.example',
      MAIL_OUTPUT_DIR: '.mail',
    });

    expect(provider).toBeInstanceOf(ResendMailProvider);
    await expect(provider.send(MESSAGE)).resolves.toEqual({ providerMessageId: 're_from_env' });
    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0]).authorization).toBe('Bearer re_env_key');
    expect(bodyOf(calls[0])).toMatchObject({ from: 'Bookly <bookings@bookly.example>', reply_to: 'photographer@bookly.example' });
  });

  it('uses Brevo when BREVO_API_KEY is set, with the configured sender and reply-to', async () => {
    const { impl, calls } = fakeFetch(() => json(201, { messageId: 'brevo_from_env' }));
    vi.stubGlobal('fetch', impl);

    const provider = createMailProvider({
      BREVO_API_KEY: 'xkeysib-env',
      RESEND_API_KEY: undefined,
      MAIL_FROM: 'Bookly <bookings@bookly.example>',
      MAIL_REPLY_TO: 'photographer@bookly.example',
      MAIL_OUTPUT_DIR: '.mail',
    });

    expect(provider).toBeInstanceOf(BrevoMailProvider);
    await expect(provider.send(MESSAGE)).resolves.toEqual({ providerMessageId: 'brevo_from_env' });
    expect(headersOf(calls[0])['api-key']).toBe('xkeysib-env');
    expect(bodyOf(calls[0])).toMatchObject({
      sender: { name: 'Bookly', email: 'bookings@bookly.example' },
      replyTo: { email: 'photographer@bookly.example' },
    });
  });

  it('omits reply_to when MAIL_REPLY_TO is unset', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { id: 'x' }));
    vi.stubGlobal('fetch', impl);

    const provider = createMailProvider({ RESEND_API_KEY: 'k', MAIL_FROM: 'f@bookly.example', MAIL_REPLY_TO: undefined, MAIL_OUTPUT_DIR: '.mail' });
    await provider.send(MESSAGE);

    expect(bodyOf(calls[0])).not.toHaveProperty('reply_to');
  });

  it('uses the file sink in MAIL_OUTPUT_DIR when no key is set, and never calls fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bookly-mailer-'));
    const { impl, calls } = fakeFetch(() => json(200, { id: 'x' }));
    vi.stubGlobal('fetch', impl);
    try {
      const provider = createMailProvider({
        RESEND_API_KEY: undefined,
        MAIL_FROM: 'f@bookly.example',
        MAIL_REPLY_TO: undefined,
        MAIL_OUTPUT_DIR: dir,
      });

      expect(provider).toBeInstanceOf(FileMailProvider);
      await provider.send(MESSAGE);
      expect(await readdir(dir)).toHaveLength(2);
      expect(calls).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
