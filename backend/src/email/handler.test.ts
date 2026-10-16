import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LOCKOUT_THRESHOLD, attemptLogin, requestPasswordReset } from '../auth/admin-auth.js';
import { hashPassword } from '../auth/password.js';
import { createPrismaClient } from '../db/client.js';
import { formatDateTime } from '../format.js';
import { enqueue } from '../outbox/enqueue.js';
import { OUTBOX_MAX_ATTEMPTS, type OutboxRow, PermanentOutboxError, drainQueue, processNext } from '../outbox/worker.js';
import { connect, firstRow, testDatabaseUrl, truncateAll } from '../test/database.js';
import { FIXTURE_ACCESS_TOKEN, FIXTURE_WEB_ORIGIN, emailFixture } from '../test/email-fixtures.js';
import { createEmailHandler } from './handler.js';
import { type MailMessage, type MailProvider, MailRejectedError } from './provider.js';
import { renderEmail } from './render.js';

/**
 * The email handler (plan.md Tasks 14 and 15): unit behaviour against a fake
 * provider, then end to end through the real worker and real PostgreSQL --
 * including the admin_alert rows Task 7's login lockout and password reset
 * actually write.
 */

class RecordingProvider implements MailProvider {
  readonly sent: { message: MailMessage; signal: AbortSignal | undefined }[] = [];
  failWith: Error | null = null;

  async send(message: MailMessage, signal?: AbortSignal) {
    if (this.failWith !== null) throw this.failWith;
    this.sent.push({ message, signal });
    return { providerMessageId: `fake-${this.sent.length}` };
  }
}

function rowFor(name: string, overrides: Partial<OutboxRow> = {}): OutboxRow {
  const fixture = emailFixture(name);
  return {
    id: '00000000-0000-0000-0000-00000000000a',
    kind: 'email',
    bookingId: null,
    dedupeKey: `email:${fixture.template}:00000000-0000-0000-0000-0000000000b1`,
    template: fixture.template,
    recipient: 'aline@example.com',
    payload: fixture.payload,
    attempts: 1,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected a rejection');
    },
    (error: unknown) => error,
  );
}

// --- Unit ---------------------------------------------------------------------------

describe('createEmailHandler', () => {
  it('renders the row, sends it with the dedupe key as the idempotency key and the signal, and returns the provider id', async () => {
    const mail = new RecordingProvider();
    const handler = createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN });
    const row = rowFor('booking_confirmation');
    const controller = new AbortController();

    await expect(handler(row, controller.signal)).resolves.toEqual({ providerMessageId: 'fake-1' });

    const expected = renderEmail('booking_confirmation', row.payload, { webOrigin: FIXTURE_WEB_ORIGIN });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.message).toEqual({
      to: 'aline@example.com',
      subject: expected.subject,
      html: expected.html,
      text: expected.text,
      idempotencyKey: row.dedupeKey,
    });
    expect(mail.sent[0]?.signal).toBe(controller.signal);
  });

  it('returns a null provider id when the provider has none', async () => {
    const handler = createEmailHandler({
      mail: { send: async () => ({ providerMessageId: null }) },
      webOrigin: FIXTURE_WEB_ORIGIN,
    });

    await expect(handler(rowFor('reschedule'), new AbortController().signal)).resolves.toEqual({ providerMessageId: null });
  });

  it.each([
    ['no template', { template: null }, /template/],
    ['no recipient', { recipient: null }, /recipient/],
    ['an erased payload', { payload: null }, /erased/],
  ])('fails permanently, sending nothing, for a row with %s', async (_case, overrides, message) => {
    const mail = new RecordingProvider();
    const handler = createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN });

    const error = await rejection(handler(rowFor('booking_confirmation', overrides), new AbortController().signal));

    expect(error).toBeInstanceOf(PermanentOutboxError);
    expect((error as Error).message).toMatch(message);
    expect(mail.sent).toHaveLength(0);
  });

  it('fails permanently on a payload that does not render, naming the field and not the value', async () => {
    const mail = new RecordingProvider();
    const handler = createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN });
    const payload = { ...(emailFixture('booking_confirmation').payload as Record<string, unknown>), accessToken: 'SECRET!!token' };

    const error = await rejection(handler(rowFor('booking_confirmation', { payload }), new AbortController().signal));

    expect(error).toBeInstanceOf(PermanentOutboxError);
    expect((error as Error).message).toBe('The booking_confirmation payload is invalid at: accessToken');
    expect(mail.sent).toHaveLength(0);
  });

  it('fails permanently on an unknown template and on a reset link off WEB_ORIGIN', async () => {
    const handler = createEmailHandler({ mail: new RecordingProvider(), webOrigin: FIXTURE_WEB_ORIGIN });
    const offSite = {
      ...(emailFixture('admin_alert password_reset').payload as Record<string, unknown>),
      resetUrl: 'http://localhost:4000/api/admin/reset-password#token=abc',
    };

    await expect(handler(rowFor('booking_confirmation', { template: 'booking_invite' }), new AbortController().signal)).rejects.toBeInstanceOf(
      PermanentOutboxError,
    );
    await expect(handler(rowFor('admin_alert password_reset', { payload: offSite }), new AbortController().signal)).rejects.toBeInstanceOf(
      PermanentOutboxError,
    );
  });

  it('fails permanently when the provider refuses the message', async () => {
    const mail = new RecordingProvider();
    mail.failWith = new MailRejectedError('Resend answered 422: Invalid `to` field.');
    const handler = createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN });

    const error = await rejection(handler(rowFor('booking_confirmation'), new AbortController().signal));

    expect(error).toBeInstanceOf(PermanentOutboxError);
    expect((error as Error).message).toBe('Resend answered 422: Invalid `to` field.');
  });

  it.each([
    ['a provider outage', new Error('Resend answered 503: unavailable')],
    ['a network failure', new TypeError('fetch failed')],
    ['an abort', new DOMException('This operation was aborted', 'AbortError')],
  ])('rethrows %s unchanged, so the worker retries', async (_case, failure) => {
    const mail = new RecordingProvider();
    mail.failWith = failure;
    const handler = createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN });

    const error = await rejection(handler(rowFor('booking_confirmation'), new AbortController().signal));

    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(PermanentOutboxError);
  });

  it('renders in English whatever locale the payload carries', async () => {
    const mail = new RecordingProvider();
    const handler = createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN });
    const payload = { ...(emailFixture('booking_confirmation').payload as Record<string, unknown>), locale: 'fr' };

    await handler(rowFor('booking_confirmation', { payload }), new AbortController().signal);

    expect(mail.sent[0]?.message.subject).toMatch(/^Booking confirmed: /);
  });
});

// --- End to end ------------------------------------------------------------------------

describe('delivery through the worker, against PostgreSQL', () => {
  let prisma: PrismaClient;
  let raw: pg.Client;
  let passwordHash: string;
  const ADMIN_EMAIL = 'photographer@bookly.example';
  const noLog = () => undefined;

  beforeAll(async () => {
    prisma = createPrismaClient(testDatabaseUrl());
    raw = connect();
    await raw.connect();
    passwordHash = await hashPassword('correct horse battery staple');
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await raw.end();
  });

  beforeEach(async () => {
    await truncateAll(raw);
    await prisma.adminUser.create({ data: { email: ADMIN_EMAIL, passwordHash } });
  });

  async function seedBooking(): Promise<string> {
    const service = await prisma.service.create({ data: { slug: 'portrait', nameEn: 'Portrait' } });
    const pkg = await prisma.package.create({
      data: { serviceId: service.id, nameEn: 'Standard', priceRwf: 45_000, photoCount: 20, durationMinutes: 60 },
    });
    const client = await prisma.client.create({
      data: { fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' },
    });
    const booking = await prisma.booking.create({
      data: {
        reference: 'BKY-2610-7K3MQ',
        clientId: client.id,
        contactName: 'Aline Uwase',
        contactEmail: 'aline@example.com',
        contactPhone: '+250788000000',
        serviceId: service.id,
        packageId: pkg.id,
        serviceNameSnapshot: 'Portrait',
        packageNameSnapshot: 'Standard',
        packagePriceRwf: 45_000,
        packageDurationMinutes: 60,
        packagePhotoCount: 20,
        locationText: 'Kigali Heights, KG 7 Ave',
        consentAt: new Date(),
        bookingFeeRate: '0.400',
        bookingFeeRwf: 18_000,
        status: 'confirmed',
        startsAt: new Date('2026-10-07T07:30:00Z'),
        endsAt: new Date('2026-10-07T08:30:00Z'),
        bufferEndsAt: new Date('2026-10-07T09:00:00Z'),
      },
    });
    return booking.id;
  }

  it('delivers an enqueued booking_confirmation: row done with the provider id, message as rendered', async () => {
    const bookingId = await seedBooking();
    const mail = new RecordingProvider();
    const dedupeKey = `email:booking_confirmation:${bookingId}`;
    await enqueue(prisma, {
      kind: 'email',
      template: 'booking_confirmation',
      recipient: 'aline@example.com',
      dedupeKey,
      bookingId,
      payload: emailFixture('booking_confirmation').payload,
    });
    const deps = { prisma, handlers: { email: createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN }) }, log: noLog };

    await expect(processNext(deps)).resolves.toBe(true);
    await expect(processNext(deps)).resolves.toBe(false);

    const row = await prisma.outbox.findUniqueOrThrow({ where: { dedupeKey } });
    expect(row).toMatchObject({ status: 'done', attempts: 1, providerMessageId: 'fake-1', lastError: null, bookingId });
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(mail.sent).toHaveLength(1);
    const message = mail.sent[0]?.message;
    expect(message?.to).toBe('aline@example.com');
    expect(message?.idempotencyKey).toBe(dedupeKey);
    expect(message?.subject).toBe('Booking confirmed: Portrait on Wednesday, 7 October 2026 (BKY-2610-7K3MQ)');
    expect(message?.html).toContain(`href="${FIXTURE_WEB_ORIGIN}/booking/${FIXTURE_ACCESS_TOKEN}"`);
    expect(message?.text).toContain('Still to pay: 27,000 RWF');
    expect(mail.sent[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails an invalid payload on the first attempt, then delivers the admin alert about it', async () => {
    const bookingId = await seedBooking();
    const mail = new RecordingProvider();
    const { accessToken: _dropped, ...payload } = emailFixture('booking_confirmation').payload;
    await enqueue(prisma, {
      kind: 'email',
      template: 'booking_confirmation',
      recipient: 'aline@example.com',
      dedupeKey: `email:booking_confirmation:${bookingId}`,
      bookingId,
      payload,
    });
    const deps = { prisma, handlers: { email: createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN }) }, log: noLog };

    await expect(drainQueue(deps)).resolves.toBe(2);

    const failed = await prisma.outbox.findUniqueOrThrow({ where: { dedupeKey: `email:booking_confirmation:${bookingId}` } });
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'PermanentOutboxError: The booking_confirmation payload is invalid at: accessToken',
    });
    const alert = await prisma.outbox.findFirstOrThrow({ where: { template: 'admin_alert' } });
    expect(alert).toMatchObject({ status: 'done', recipient: ADMIN_EMAIL, providerMessageId: 'fake-1' });

    // Only the alert went out, to the photographer, saying what failed.
    expect(mail.sent.map((sent) => sent.message.to)).toEqual([ADMIN_EMAIL]);
    const text = mail.sent[0]?.message.text ?? '';
    expect(mail.sent[0]?.message.subject).toBe('A message could not be sent');
    expect(text).toContain('Message: Booking confirmation to the client');
    expect(text).toContain('Booking reference: BKY-2610-7K3MQ');
    expect(text).toContain('Last error: PermanentOutboxError: The booking_confirmation payload is invalid at: accessToken');
  });

  it('fails a message the provider refuses on the first attempt, with an alert', async () => {
    const mail = new RecordingProvider();
    mail.failWith = new MailRejectedError('Resend answered 422: Invalid `to` field.');
    const fixture = emailFixture('access_link_resend');
    await enqueue(prisma, { kind: 'email', template: fixture.template, recipient: 'not-an-address', dedupeKey: 'k1', payload: fixture.payload });

    await processNext({ prisma, handlers: { email: createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN }) }, log: noLog });

    await expect(prisma.outbox.findUniqueOrThrow({ where: { dedupeKey: 'k1' } })).resolves.toMatchObject({ status: 'failed', attempts: 1 });
    await expect(prisma.outbox.count({ where: { template: 'admin_alert' } })).resolves.toBe(1);
  });

  it('retries a provider outage with backoff and the same idempotency key, then delivers', async () => {
    const mail = new RecordingProvider();
    const fixture = emailFixture('payment_receipt');
    await enqueue(prisma, { kind: 'email', template: fixture.template, recipient: 'aline@example.com', dedupeKey: 'k2', payload: fixture.payload });
    const keys: string[] = [];
    const flaky: MailProvider = {
      send: async (message, signal) => {
        keys.push(message.idempotencyKey);
        if (keys.length === 1) throw new Error('Resend answered 503: unavailable');
        return mail.send(message, signal);
      },
    };
    const deps = { prisma, handlers: { email: createEmailHandler({ mail: flaky, webOrigin: FIXTURE_WEB_ORIGIN }) }, log: noLog };

    await processNext(deps);
    await expect(prisma.outbox.findUniqueOrThrow({ where: { dedupeKey: 'k2' } })).resolves.toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'Error: Resend answered 503: unavailable',
    });
    await expect(processNext(deps)).resolves.toBe(false); // backing off

    await raw.query(`UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE dedupe_key = 'k2'`);
    await processNext(deps);

    await expect(prisma.outbox.findUniqueOrThrow({ where: { dedupeKey: 'k2' } })).resolves.toMatchObject({ status: 'done', attempts: 2 });
    expect(keys).toEqual(['k2', 'k2']);
    expect(mail.sent).toHaveLength(1);
  });

  it('sends nothing for a row erased before delivery (data-model_v2.md §10.2)', async () => {
    const mail = new RecordingProvider();
    const fixture = emailFixture('booking_confirmation');
    await enqueue(prisma, { kind: 'email', template: fixture.template, recipient: 'aline@example.com', dedupeKey: 'k3', payload: fixture.payload });
    await raw.query(`UPDATE outbox SET payload = NULL, recipient = '[erased]' WHERE dedupe_key = 'k3'`);

    await processNext({ prisma, handlers: { email: createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN }) }, log: noLog });

    await expect(prisma.outbox.findUniqueOrThrow({ where: { dedupeKey: 'k3' } })).resolves.toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'PermanentOutboxError: The payload was erased',
    });
    expect(mail.sent).toHaveLength(0);
  });

  it('delivers the password_reset admin_alert exactly as requestPasswordReset enqueues it', async () => {
    const mail = new RecordingProvider();
    const now = new Date('2026-10-07T07:00:00Z');
    await requestPasswordReset({ prisma, sessionSecret: 'x'.repeat(40), webOrigin: FIXTURE_WEB_ORIGIN, now: () => now }, ADMIN_EMAIL);
    const row = await prisma.outbox.findFirstOrThrow();
    const payload = row.payload as { resetUrl: string; expiresAt: string };

    await drainQueue({ prisma, handlers: { email: createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN }) }, log: noLog });

    await expect(prisma.outbox.findFirstOrThrow()).resolves.toMatchObject({ status: 'done', providerMessageId: 'fake-1' });
    expect(mail.sent).toHaveLength(1);
    const message = mail.sent[0]?.message;
    expect(message?.to).toBe(ADMIN_EMAIL);
    expect(message?.subject).toBe('Reset your admin password');
    expect(message?.html).toContain(`href="${payload.resetUrl}"`);
    expect(message?.text).toContain(payload.resetUrl);
    // 07:00Z + 30 minutes is 09:30 in Kigali.
    expect(message?.text).toContain(`until ${formatDateTime(payload.expiresAt)} (Kigali time)`);
    expect(message?.text).toContain('7 Oct 2026, 09:30 (Kigali time)');
    const token = new URL(payload.resetUrl).hash.replace('#token=', '');
    expect(message?.subject).not.toContain(token);
    expect(message?.text.replaceAll(payload.resetUrl, '')).not.toContain(token);
  });

  it('refuses a password_reset enqueued against a different WEB_ORIGIN than the worker’s, rather than sending the admin off-site', async () => {
    const mail = new RecordingProvider();
    const now = new Date('2026-10-07T07:00:00Z');
    await requestPasswordReset({ prisma, sessionSecret: 'x'.repeat(40), webOrigin: 'http://localhost:4000', now: () => now }, ADMIN_EMAIL);

    await processNext({ prisma, handlers: { email: createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN }) }, log: noLog });

    expect(mail.sent).toHaveLength(0);
    await expect(prisma.outbox.findFirstOrThrow({ where: { status: 'failed' } })).resolves.toMatchObject({
      lastError: 'PermanentOutboxError: A link in the payload is not on WEB_ORIGIN',
    });
  });

  it('delivers the login_lockout admin_alert exactly as attemptLogin enqueues it', async () => {
    const mail = new RecordingProvider();
    const now = new Date('2026-10-07T07:00:00Z');
    const deps = { prisma, sessionSecret: 'x'.repeat(40), webOrigin: FIXTURE_WEB_ORIGIN, now: () => now };
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) await attemptLogin(deps, ADMIN_EMAIL, 'wrong password');
    const row = await prisma.outbox.findFirstOrThrow();
    const payload = row.payload as { variant: string; lockedUntil: string };
    expect(payload.variant).toBe('login_lockout');

    await drainQueue({ prisma, handlers: { email: createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN }) }, log: noLog });

    await expect(prisma.outbox.findFirstOrThrow()).resolves.toMatchObject({ status: 'done' });
    const message = mail.sent[0]?.message;
    expect(message?.to).toBe(ADMIN_EMAIL);
    expect(message?.subject).toBe(`Admin sign-in locked after ${LOCKOUT_THRESHOLD} failed attempts`);
    // Locked for one minute from 07:00Z: 09:01 in Kigali.
    expect(message?.text).toContain('locked until 7 Oct 2026, 09:01 (Kigali time)');
    expect(message?.html).toContain(`href="${FIXTURE_WEB_ORIGIN}/admin/login"`);
  }, 30_000);

  it('the worker never delivers an alert about an alert it could not send', async () => {
    const mail = new RecordingProvider();
    mail.failWith = new Error('Resend answered 503: unavailable');
    const fixture = emailFixture('admin_alert refund_due');
    await enqueue(prisma, { kind: 'email', template: 'admin_alert', recipient: ADMIN_EMAIL, dedupeKey: 'alert-1', payload: fixture.payload });
    await raw.query(`UPDATE outbox SET attempts = $1 WHERE dedupe_key = 'alert-1'`, [OUTBOX_MAX_ATTEMPTS - 1]);

    await processNext({ prisma, handlers: { email: createEmailHandler({ mail, webOrigin: FIXTURE_WEB_ORIGIN }) }, log: noLog });

    const count = firstRow(await raw.query<{ n: string }>(`SELECT count(*) AS n FROM outbox`));
    expect(Number(count.n)).toBe(1);
    await expect(prisma.outbox.findFirstOrThrow()).resolves.toMatchObject({ status: 'failed' });
  });
});
