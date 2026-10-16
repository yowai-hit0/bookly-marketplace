import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { findBookingByToken } from '../booking/access.js';
import { resendAccessLink } from '../booking/admin-actions.js';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { CLIENT, type PaymentWorld, insertBookingWithToken, seedWorld } from '../test/payment-fixtures.js';

/**
 * A client changes their booking's contact email, confirmed from the new
 * address (docs/prompts/client-access-and-admin-polish.md, item 6), over HTTP
 * against real PostgreSQL.
 *
 * What is proven: asking emails a confirmation link to the NEW address only,
 * and changes nothing yet but the pending state the page shows. A second ask
 * replaces the first, whose link then fails. Three asks a day, then 429. The
 * same address is a 200 that sends nothing; a cancelled booking is a 409; a bad
 * address is a 422. Confirming swaps the email, emails the OLD address and
 * clears the pending state; the booking's own link keeps working, and later
 * emails go to the new address. Unknown, expired and used links are the same
 * 404, changing nothing. A confirmation token is not an access token, and an
 * access token is not a confirmation token.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let world: PaymentWorld;
let app: Express;
let clock: Date;

const NEW_EMAIL = 'aline.new@example.com';

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
});

afterAll(async () => {
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  world = await seedWorld(prisma);
  clock = new Date();
  app = createApp({ publicApi: { prisma, now: () => clock } });
});

type Row = { template: string; recipient: string; payload: Record<string, unknown> };

async function emails(template: string): Promise<Row[]> {
  return (await raw.query<Row>('SELECT template, recipient, payload FROM outbox WHERE template = $1 ORDER BY created_at', [template])).rows;
}

async function contactOf(bookingId: string) {
  return prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: { contactEmail: true, pendingContactEmail: true, pendingEmailTokenHash: true, pendingEmailExpiresAt: true },
  });
}

function ask(token: string, email: unknown = NEW_EMAIL) {
  return request(app).post(`/api/booking/${token}/email`).send({ email });
}

function confirm(confirmToken: string) {
  return request(app).post(`/api/email-confirmations/${confirmToken}`);
}

async function lastConfirmToken(): Promise<string> {
  const rows = await emails('email_change_confirm');
  return String(rows.at(-1)?.payload.confirmToken ?? '');
}

describe('asking to change the contact email', () => {
  it('emails a confirmation link to the new address only, and changes nothing else yet', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);

    const res = await ask(token, '  Aline.New@Example.com ');

    expect(res.status, res.text).toBe(202);
    // Masked, both of them: the page never carries a full address (2026-09-25).
    expect(res.body.booking).toMatchObject({ maskedEmail: 'a•••••@example.com', pendingMaskedEmail: 'a•••••@example.com' });
    expect(res.text).not.toContain(NEW_EMAIL);
    expect(res.text).not.toContain(CLIENT.email);
    const sent = await emails('email_change_confirm');
    expect(sent.map((row) => row.recipient)).toEqual([NEW_EMAIL]);
    expect(sent[0]?.payload).toMatchObject({ newEmail: NEW_EMAIL, reference: booking.reference });
    expect(await raw.query('SELECT 1 FROM outbox WHERE recipient = $1', [CLIENT.email]).then((r) => r.rowCount)).toBe(0);
    expect(await contactOf(booking.id)).toMatchObject({ contactEmail: CLIENT.email, pendingContactEmail: NEW_EMAIL });
    // Only the hash is stored.
    const stored = await contactOf(booking.id);
    expect(stored.pendingEmailTokenHash).not.toBe(await lastConfirmToken());
    expect(stored.pendingEmailTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('shows the pending change on the booking page until its link lapses', async () => {
    const { token } = await insertBookingWithToken(prisma, world);
    await ask(token);

    expect((await request(app).get(`/api/booking/${token}`)).body.booking.pendingMaskedEmail).toBe('a•••••@example.com');

    clock = new Date(clock.getTime() + 24 * 60 * 60_000 + 1000);
    expect((await request(app).get(`/api/booking/${token}`)).body.booking.pendingMaskedEmail).toBeNull();
  });

  it('replaces an earlier request: the first link then fails', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await ask(token, 'first@example.com');
    const first = await lastConfirmToken();
    await ask(token, 'second@example.com');

    expect((await confirm(first)).status).toBe(404);
    expect((await confirm(await lastConfirmToken())).status).toBe(200);
    expect((await contactOf(booking.id)).contactEmail).toBe('second@example.com');
  });

  it('allows three requests a day, then answers 429', async () => {
    const { token } = await insertBookingWithToken(prisma, world);

    const answers = [];
    for (const n of [1, 2, 3, 4]) answers.push((await ask(token, `try${n}@example.com`)).status);

    expect(answers).toEqual([202, 202, 202, 429]);
    expect(await emails('email_change_confirm')).toHaveLength(3);
  });

  it('answers 200 and sends nothing for the address it already has', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);

    const res = await ask(token, CLIENT.email.toUpperCase());

    expect(res.status).toBe(200);
    expect(await emails('email_change_confirm')).toHaveLength(0);
    expect((await contactOf(booking.id)).pendingContactEmail).toBeNull();
  });

  it('answers 409 for a booking that no longer stands', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'cancelled_by_client', cancelledAt: clock } });

    const res = await ask(token);

    expect([res.status, res.body.error]).toEqual([409, 'not_allowed']);
    expect(await emails('email_change_confirm')).toHaveLength(0);
  });

  it.each([
    ['not an email', { email: 'nope' }, 422],
    ['missing', {}, 400],
    ['with another field', { email: NEW_EMAIL, bookingId: 'x' }, 400],
  ])('refuses a body that is %s', async (_label, body, status) => {
    const { token } = await insertBookingWithToken(prisma, world);

    const res = await request(app).post(`/api/booking/${token}/email`).send(body);

    expect(res.status).toBe(status);
    expect(await emails('email_change_confirm')).toHaveLength(0);
  });

  it('answers 404 for a token that opens no booking', async () => {
    expect((await ask('no-such-token-0123456789abcdef')).status).toBe(404);
  });
});

describe('confirming the new address', () => {
  it('swaps the email, tells the old address, and keeps the booking link working', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await ask(token);

    const res = await confirm(await lastConfirmToken());

    expect([res.status, res.body]).toEqual([200, { confirmed: true }]);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await contactOf(booking.id)).toEqual({
      contactEmail: NEW_EMAIL,
      pendingContactEmail: null,
      pendingEmailTokenHash: null,
      pendingEmailExpiresAt: null,
    });
    const notices = await emails('email_changed_notice');
    expect(notices.map((row) => row.recipient)).toEqual([CLIENT.email]);
    expect(notices[0]?.payload).toMatchObject({ newEmail: NEW_EMAIL });
    expect((await findBookingByToken(prisma, token))?.id).toBe(booking.id);
    // client.email is not this booking's to change.
    expect((await prisma.client.findUniqueOrThrow({ where: { id: world.clientId } })).email).toBe(CLIENT.email);
  });

  it('sends later emails to the new address', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await ask(token);
    await confirm(await lastConfirmToken());

    await resendAccessLink({ prisma, now: () => clock }, booking.id);

    expect((await emails('access_link_resend')).map((row) => row.recipient)).toEqual([NEW_EMAIL]);
  });

  it('works once: the same link a second time is the same 404, and sends nothing more', async () => {
    const { token } = await insertBookingWithToken(prisma, world);
    await ask(token);
    const confirmToken = await lastConfirmToken();

    await confirm(confirmToken);
    const again = await confirm(confirmToken);

    expect([again.status, again.body]).toEqual([404, { error: 'not_found' }]);
    expect(await emails('email_changed_notice')).toHaveLength(1);
  });

  it('refuses a link past its 24 hours, changing nothing', async () => {
    const { booking, token } = await insertBookingWithToken(prisma, world);
    await ask(token);
    clock = new Date(clock.getTime() + 24 * 60 * 60_000 + 1000);

    const res = await confirm(await lastConfirmToken());

    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
    expect((await contactOf(booking.id)).contactEmail).toBe(CLIENT.email);
    expect(await emails('email_changed_notice')).toHaveLength(0);
  });

  it('refuses an unknown or malformed link alike', async () => {
    for (const bad of ['Cf7mN2bV9cX4zL1kJ8hG5fD3sA6pO0iU', 'short', '%20']) {
      const res = await confirm(bad);
      expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
    }
  });

  it('keeps the two kinds of token apart', async () => {
    const { token } = await insertBookingWithToken(prisma, world);
    await ask(token);
    const confirmToken = await lastConfirmToken();

    expect((await request(app).get(`/api/booking/${confirmToken}`)).status).toBe(404);
    expect((await confirm(token)).status).toBe(404);
  });
});
