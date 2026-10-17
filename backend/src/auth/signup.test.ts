import type { AppUser, Outbox, PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { RESERVED_HANDLES } from '../photographers/handle.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { type AuthDeps, attemptLogin } from './account-auth.js';
import { confirmEmailVerification } from './email-verification.js';
import { hashPassword, verifyPassword } from './password.js';
import { signUpClient, signUpPhotographer } from './signup.js';

/**
 * Signing up (Phase 2 decisions 4 and 5; marketplace-spec.md R2.2, R2.3,
 * R2.1c (c)), against real PostgreSQL: what is created, in one transaction;
 * what a taken address receives instead, and that the caller can never tell;
 * and the handle rules, the one thing a signup may refuse.
 */

let prisma: PrismaClient;
let raw: pg.Client;
let deps: AuthDeps;

const SECRET = 'signup-test-secret-that-is-at-least-32-characters';
const WEB_ORIGIN = 'https://bookly.example';
const EMAIL = 'new.studio@bookly.example';
const PASSWORD = 'a long enough signup password';
const NOW = new Date('2026-10-17T07:00:00Z');

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
  deps = { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => NOW };
});

afterAll(async () => {
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
});

function photographerSignup(overrides: Partial<Parameters<typeof signUpPhotographer>[1]> = {}) {
  return signUpPhotographer(deps, { email: EMAIL, password: PASSWORD, displayName: 'Kigali Lens', handle: 'kigali-lens', ...overrides });
}

function seedAdmin(email: string): Promise<AppUser> {
  return prisma.appUser.create({ data: { email, role: 'platform_admin', passwordHash: 'not-a-real-hash', emailVerifiedAt: NOW } });
}

function outbox(): Promise<Outbox[]> {
  return prisma.outbox.findMany({ orderBy: [{ createdAt: 'asc' }, { recipient: 'asc' }] });
}

function templatesTo(rows: Outbox[]): [string | null, string | null][] {
  return rows.map((row) => [row.template, row.recipient]);
}

async function verifyTokenSentTo(recipient: string): Promise<string> {
  const row = await prisma.outbox.findFirstOrThrow({ where: { template: 'account_verify_email', recipient }, orderBy: { createdAt: 'desc' } });
  return String((row.payload as Record<string, unknown>).token);
}

// --- Photographer signup -------------------------------------------------------

describe('signUpPhotographer', () => {
  it('creates the login, a pending photographer and its settings, sends the link, and tells every platform admin', async () => {
    await seedAdmin('ops.one@bookly.example');
    await seedAdmin('ops.two@bookly.example');
    await prisma.appUser.create({ data: { email: 'off@bookly.example', role: 'platform_admin', passwordHash: 'x', emailVerifiedAt: NOW, disabledAt: NOW } });

    await expect(photographerSignup({ email: '  New.Studio@Bookly.example ', handle: 'Kigali-Lens' })).resolves.toBe('accepted');

    const user = await prisma.appUser.findFirstOrThrow({ where: { email: EMAIL }, include: { photographer: { include: { setting: true } } } });
    expect(user).toMatchObject({ role: 'photographer', emailVerifiedAt: null, fullName: null });
    await expect(verifyPassword(user.passwordHash ?? '', PASSWORD)).resolves.toBe(true);
    expect(user.photographer).toMatchObject({ handle: 'kigali-lens', displayName: 'Kigali Lens', status: 'pending', approvedAt: null });
    expect(user.photographer?.setting).not.toBeNull();

    const rows = await outbox();
    expect(templatesTo(rows).sort()).toEqual([
      ['account_verify_email', EMAIL],
      ['photographer_application_received', 'ops.one@bookly.example'],
      ['photographer_application_received', 'ops.two@bookly.example'],
    ]);
    const application = rows.find((row) => row.template === 'photographer_application_received');
    expect(application?.payload).toEqual({ displayName: 'Kigali Lens', handle: 'kigali-lens', email: EMAIL });
    // Filed under no studio: a failure to deliver it alerts the platform, not the applicant.
    expect(rows.map((row) => row.photographerId)).toEqual([null, null, null]);
    expect(rows.find((row) => row.template === 'account_verify_email')?.payload).toMatchObject({ area: 'studio' });
  });

  it('lets a pending photographer sign in to the studio once verified', async () => {
    await photographerSignup();

    await expect(attemptLogin(deps, 'studio', EMAIL, PASSWORD)).resolves.toEqual({ status: 'invalid_credentials' });
    await expect(confirmEmailVerification(deps, 'studio', await verifyTokenSentTo(EMAIL), PASSWORD)).resolves.toMatchObject({ status: 'ok' });
    await expect(attemptLogin(deps, 'studio', EMAIL, PASSWORD)).resolves.toMatchObject({ status: 'ok' });
  });

  it('refuses a taken handle, whatever the email, and creates nothing', async () => {
    await photographerSignup();
    const before = await prisma.appUser.count();

    await expect(photographerSignup({ email: 'someone.else@bookly.example' })).resolves.toBe('handle_taken');
    await expect(photographerSignup({ email: EMAIL })).resolves.toBe('handle_taken');

    await expect(prisma.appUser.count()).resolves.toBe(before);
  });

  it.each([...RESERVED_HANDLES].filter((handle) => handle.length >= 3))('refuses the reserved handle %s like a taken one', async (handle) => {
    await expect(photographerSignup({ handle })).resolves.toBe('handle_taken');
    await expect(prisma.appUser.count()).resolves.toBe(0);
  });

  it('gives one of two simultaneous signups for one handle the handle, and the other handle_taken, leaving no orphan login', async () => {
    const results = await Promise.all([
      photographerSignup({ email: 'first@bookly.example' }),
      photographerSignup({ email: 'second@bookly.example' }),
    ]);

    expect(results.sort()).toEqual(['accepted', 'handle_taken']);
    await expect(prisma.appUser.count()).resolves.toBe(1);
    await expect(prisma.photographer.count()).resolves.toBe(1);
  });
});

// --- A taken address (R2.1c (c)) ---------------------------------------------------

describe('signing up with an address that already has an account', () => {
  it('resends an unverified photographer their link, without touching their password or their studio', async () => {
    await photographerSignup();
    const first = await prisma.appUser.findFirstOrThrow({ where: { email: EMAIL }, include: { photographer: true } });

    await expect(photographerSignup({ password: 'a different password now', handle: 'another-handle', displayName: 'Other' })).resolves.toBe('accepted');

    const after = await prisma.appUser.findFirstOrThrow({ where: { email: EMAIL }, include: { photographer: true } });
    expect(after.passwordHash).toBe(first.passwordHash);
    expect(after.photographer).toEqual(first.photographer);
    await expect(prisma.photographer.count()).resolves.toBe(1);
    expect(templatesTo(await outbox())).toEqual([
      ['account_verify_email', EMAIL],
      ['account_verify_email', EMAIL],
    ]);
    // The newest link is the one that works, with the FIRST signup's password.
    await expect(confirmEmailVerification(deps, 'studio', await verifyTokenSentTo(EMAIL), 'a different password now')).resolves.toEqual({ status: 'invalid' });
  });

  it('resends an unverified client their link, keeping their password and name', async () => {
    await signUpClient(deps, { email: EMAIL, password: PASSWORD, fullName: 'Aline' });
    const first = await prisma.appUser.findFirstOrThrow({ where: { email: EMAIL } });

    await signUpClient(deps, { email: EMAIL.toUpperCase(), password: 'another password entirely', fullName: 'Someone' });

    await expect(prisma.appUser.findFirstOrThrow({ where: { email: EMAIL } })).resolves.toMatchObject({ passwordHash: first.passwordHash, fullName: 'Aline' });
    expect(templatesTo(await outbox())).toEqual([
      ['account_verify_email', EMAIL],
      ['account_verify_email', EMAIL],
    ]);
  });

  it.each([
    ['photographer', 'studio'],
    ['client', 'account'],
    ['platform_admin', 'platform'],
  ] as const)('sends a verified %s an "account exists" notice for its own area, once an hour', async (role, area) => {
    const user = await prisma.appUser.create({ data: { email: EMAIL, role, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: NOW } });

    await signUpClient(deps, { email: EMAIL, password: 'whatever it is', fullName: 'X' });
    await photographerSignup({ password: 'whatever it is' });

    const rows = await outbox();
    expect(templatesTo(rows)).toEqual([['account_security_alert', EMAIL]]);
    expect(rows[0]?.payload).toEqual({ variant: 'account_exists', area });
    await expect(prisma.appUser.findUniqueOrThrow({ where: { id: user.id } })).resolves.toEqual(user);
  });

  it('sends nothing for an unverified account of another area, or a disabled one', async () => {
    await prisma.appUser.create({ data: { email: EMAIL, role: 'client', passwordHash: 'x' } });
    await prisma.appUser.create({ data: { email: 'off@bookly.example', role: 'client', passwordHash: 'x', emailVerifiedAt: NOW, disabledAt: NOW } });

    await photographerSignup();
    await signUpClient(deps, { email: 'off@bookly.example', password: PASSWORD, fullName: 'X' });

    await expect(prisma.outbox.count()).resolves.toBe(0);
    await expect(prisma.photographer.count()).resolves.toBe(0);
  });
});

// --- Client signup ---------------------------------------------------------------------

describe('signUpClient', () => {
  it('creates an unverified client with its name, sends the account link, and links no bookings yet', async () => {
    const row = await prisma.client.create({ data: { fullName: 'Guest', email: EMAIL, phone: '+250788000000' } });

    await expect(signUpClient(deps, { email: EMAIL, password: PASSWORD, fullName: 'Aline Uwase' })).resolves.toBe('accepted');

    await expect(prisma.appUser.findFirstOrThrow({ where: { email: EMAIL } })).resolves.toMatchObject({ role: 'client', fullName: 'Aline Uwase', emailVerifiedAt: null, googleSub: null });
    await expect(prisma.client.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({ userId: null });
    const [email] = await outbox();
    expect(email?.payload).toMatchObject({ area: 'account' });
  });
});
