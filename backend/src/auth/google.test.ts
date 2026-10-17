import { createHash } from 'node:crypto';
import type { AppUser, PrismaClient } from '@prisma/client';
import { type JWK, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../db/client.js';
import { connect, testDatabaseUrl, truncateAll } from '../test/database.js';
import { attemptLogin } from './account-auth.js';
import {
  GOOGLE_TOKEN_ENDPOINT,
  type GoogleDeps,
  type GoogleIdentityProvider,
  OAUTH_FLOW_TTL_MINUTES,
  completeGoogleSignIn,
  createGoogleProvider,
  startGoogleSignIn,
} from './google.js';
import { hashPassword } from './password.js';
import { verifyToken } from './token.js';

/**
 * Google sign-in for clients (Phase 2 decision 6; marketplace-spec.md R2.4,
 * T2.3) against a FAKE identity provider: the test generates its own RS256 key
 * pair, signs the id_tokens itself, and serves the public half as the key set.
 * Nothing here calls Google. The clock is injected, so `exp` and the flow's
 * 10 minutes are crossed by moving it.
 */

/** The private half of a test RS256 key pair, whatever jose's runtime makes it. */
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let prisma: PrismaClient;
let raw: pg.Client;
let clock: Date;
let googleKey: SigningKey;
let strangerKey: SigningKey;
let publicJwk: JWK;
let fake: FakeGoogle;
let deps: GoogleDeps;

const SECRET = 'google-test-secret-that-is-at-least-32-characters';
const WEB_ORIGIN = 'https://bookly.example';
const CLIENT_ID = 'bookly-test.apps.googleusercontent.com';
const START = new Date('2026-10-17T07:00:00Z');
const EMAIL = 'aline@gmail.example';
const SUB = '109876543210987654321';
const KID = 'fake-google-key-1';

type FakeGoogle = GoogleIdentityProvider & {
  /** What the token endpoint answers next: an id_token, or a refusal. */
  answer: (() => Promise<string>) | null;
  exchanges: { code: string; codeVerifier: string; redirectUri: string }[];
};

function fakeGoogle(): FakeGoogle {
  const provider: FakeGoogle = {
    clientId: CLIENT_ID,
    authorizationEndpoint: 'https://accounts.google.example/o/oauth2/v2/auth',
    jwks: createLocalJWKSet({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] }),
    answer: null,
    exchanges: [],
    async exchangeCode(input) {
      provider.exchanges.push(input);
      if (input.code === 'refused-by-google' || provider.answer === null) throw new Error('invalid_grant');
      return provider.answer();
    },
  };
  return provider;
}

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  raw = connect();
  await raw.connect();
  const pair = await generateKeyPair('RS256', { extractable: true });
  googleKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  strangerKey = (await generateKeyPair('RS256')).privateKey;
});

afterAll(async () => {
  await truncateAll(raw);
  await prisma.$disconnect();
  await raw.end();
});

beforeEach(async () => {
  await truncateAll(raw);
  clock = START;
  fake = fakeGoogle();
  deps = { prisma, sessionSecret: SECRET, webOrigin: WEB_ORIGIN, now: () => clock, google: fake };
});

// --- The fake identity provider ----------------------------------------------------

type Claims = Record<string, unknown>;
type TokenOptions = { key?: SigningKey; iss?: string; aud?: string; exp?: Date; omit?: string[] };

/** An id_token as Google would sign it, with `nonce` from the flow; options break one thing at a time. */
function idToken(nonce: string, claims: Claims = {}, options: TokenOptions = {}): Promise<string> {
  const body: Claims = { nonce, email: EMAIL, email_verified: true, name: 'Aline Uwase', ...claims };
  for (const name of options.omit ?? []) delete body[name];
  const iat = Math.floor(clock.getTime() / 1000);
  const jwt = new SignJWT(body)
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setIssuer(options.iss ?? 'https://accounts.google.com')
    .setAudience(options.aud ?? CLIENT_ID)
    .setSubject(String(claims.sub ?? SUB))
    .setIssuedAt(iat)
    .setExpirationTime(options.exp === undefined ? iat + 3600 : Math.floor(options.exp.getTime() / 1000));
  return jwt.sign(options.key ?? googleKey);
}

type Started = { state: string; nonce: string; url: URL };

async function start(): Promise<Started> {
  const { authorizationUrl, state } = await startGoogleSignIn(deps);
  const url = new URL(authorizationUrl);
  return { state, nonce: url.searchParams.get('nonce') ?? '', url };
}

/** Starts a flow, lets the fake answer with an id_token built from its nonce, and completes it. */
async function signIn(claims: Claims = {}, options: TokenOptions = {}) {
  const flow = await start();
  fake.answer = () => idToken(flow.nonce, claims, options);
  return completeGoogleSignIn(deps, { code: 'code-from-google', state: flow.state });
}

function reload(user: AppUser): Promise<AppUser> {
  return prisma.appUser.findUniqueOrThrow({ where: { id: user.id } });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// --- Start ------------------------------------------------------------------------

describe('startGoogleSignIn', () => {
  it('builds the authorization URL with PKCE S256, state, nonce and the server-built redirect_uri', async () => {
    const { url, state, nonce } = await start();

    expect(url.origin + url.pathname).toBe(fake.authorizationEndpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: `${WEB_ORIGIN}/account/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge_method: 'S256',
    });
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('stores only the hash of the state, with the verifier behind the challenge, for 10 minutes', async () => {
    const { url, state, nonce } = await start();

    const [flow] = await prisma.oauthFlow.findMany();
    expect(flow).toMatchObject({ stateHash: sha256Hex(state), nonce, consumedAt: null });
    expect(flow?.expiresAt.getTime()).toBe(START.getTime() + OAUTH_FLOW_TTL_MINUTES * 60_000);
    expect(createHash('sha256').update(flow?.codeVerifier ?? '').digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(JSON.stringify(flow)).not.toContain(state);
  });

  it('sweeps flows that expired more than a day ago', async () => {
    await start();
    clock = new Date(START.getTime() + 25 * 60 * 60_000);

    await start();

    await expect(prisma.oauthFlow.count()).resolves.toBe(1);
  });
});

// --- Finding the account ----------------------------------------------------------------

describe('completeGoogleSignIn: the account', () => {
  it('creates a verified client with no password, exchanging the code with the flow verifier', async () => {
    const result = await signIn();

    if (result.status !== 'ok') throw new Error(`Expected ok, got ${result.status}`);
    expect(result.created).toBe(true);
    expect(result.user).toMatchObject({ email: EMAIL, role: 'client', googleSub: SUB, passwordHash: null, fullName: 'Aline Uwase', emailVerifiedAt: START, lastLoginAt: START });
    await expect(verifyToken(SECRET, 'account', result.token, START)).resolves.toMatchObject({ userId: result.user.id, role: 'client' });
    const [flow] = await prisma.oauthFlow.findMany();
    expect(fake.exchanges).toEqual([{ code: 'code-from-google', codeVerifier: flow?.codeVerifier, redirectUri: `${WEB_ORIGIN}/account/google/callback` }]);
    expect(flow?.consumedAt).toEqual(START);
  });

  it('finds a returning user by Google subject, even after their address changed at Google', async () => {
    const first = await signIn();
    if (first.status !== 'ok') throw new Error('Expected ok');

    const again = await signIn({ email: 'aline.new@gmail.example' });

    expect(again).toMatchObject({ status: 'ok', created: false, user: { id: first.user.id, email: EMAIL } });
    await expect(prisma.appUser.count()).resolves.toBe(1);
  });

  it('links an existing verified client by email, keeping its password and verification', async () => {
    const verifiedAt = new Date('2026-09-01T06:00:00Z');
    const client = await prisma.appUser.create({
      data: { email: 'Aline@Gmail.example', role: 'client', passwordHash: await hashPassword('her own password'), emailVerifiedAt: verifiedAt },
    });

    const result = await signIn();

    expect(result).toMatchObject({ status: 'ok', created: false, user: { id: client.id } });
    await expect(reload(client)).resolves.toMatchObject({ googleSub: SUB, passwordHash: client.passwordHash, emailVerifiedAt: verifiedAt });
    await expect(attemptLogin(deps, 'account', EMAIL, 'her own password')).resolves.toMatchObject({ status: 'ok' });
  });

  it("links an unverified client, verifying it and discarding the password nobody proved was the owner's", async () => {
    const preRegistered = await prisma.appUser.create({
      data: { email: EMAIL, role: 'client', passwordHash: await hashPassword('chosen by a stranger'), emailVerifyTokenHash: 'h'.repeat(64), emailVerifyExpiresAt: START },
    });

    const result = await signIn();

    expect(result).toMatchObject({ status: 'ok', user: { id: preRegistered.id } });
    await expect(reload(preRegistered)).resolves.toMatchObject({ googleSub: SUB, passwordHash: null, emailVerifiedAt: START, emailVerifyTokenHash: null });
    await expect(attemptLogin(deps, 'account', EMAIL, 'chosen by a stranger')).resolves.toEqual({ status: 'invalid_credentials' });
  });

  it("links the address's guest bookings to the account", async () => {
    const row = await prisma.client.create({ data: { fullName: 'Aline', email: 'ALINE@gmail.example', phone: '+250788000000' } });

    const result = await signIn();

    if (result.status !== 'ok') throw new Error('Expected ok');
    await expect(prisma.client.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({ userId: result.user.id });
  });

  it.each(['photographer', 'platform_admin'] as const)("refuses a %s's address and changes nothing", async (role) => {
    const user = await prisma.appUser.create({ data: { email: EMAIL, role, passwordHash: 'not-a-real-hash', emailVerifiedAt: START } });

    await expect(signIn()).resolves.toEqual({ status: 'account_conflict' });

    await expect(reload(user)).resolves.toEqual(user);
    await expect(prisma.appUser.count()).resolves.toBe(1);
  });

  it('refuses a client already linked to another Google account', async () => {
    await prisma.appUser.create({ data: { email: EMAIL, role: 'client', googleSub: 'another-subject', emailVerifiedAt: START } });

    await expect(signIn()).resolves.toEqual({ status: 'account_conflict' });
  });

  it.each([
    ['disabled', { disabledAt: START }],
    ['erased', { anonymizedAt: START }],
  ])('refuses a %s client, found by subject or by email', async (_label, data) => {
    const bySub = await prisma.appUser.create({ data: { email: 'linked@gmail.example', role: 'client', googleSub: SUB, emailVerifiedAt: START, ...data } });
    await expect(signIn()).resolves.toEqual({ status: 'account_unavailable' });

    await prisma.appUser.delete({ where: { id: bySub.id } });
    await prisma.appUser.create({ data: { email: EMAIL, role: 'client', passwordHash: 'x', emailVerifiedAt: START, ...data } });
    await expect(signIn()).resolves.toEqual({ status: 'account_unavailable' });
  });

  it('accepts the issuer without a scheme, which Google also uses', async () => {
    await expect(signIn({}, { iss: 'accounts.google.com' })).resolves.toMatchObject({ status: 'ok' });
  });

  it('creates one account from two simultaneous first sign-ins', async () => {
    const [a, b] = await Promise.all([start(), start()]);
    fake.answer = null;
    const tokens = new Map([[a.state, a.nonce], [b.state, b.nonce]]);
    const results = await Promise.all(
      [a, b].map(async (flow) => {
        const token = await idToken(tokens.get(flow.state) ?? '');
        return completeGoogleSignIn({ ...deps, google: { ...fake, exchangeCode: async () => token } }, { code: 'c', state: flow.state });
      }),
    );

    expect(results.map((r) => r.status)).toEqual(['ok', 'ok']);
    await expect(prisma.appUser.count()).resolves.toBe(1);
  });
});

// --- Refusals (T2.3) ------------------------------------------------------------------------

describe('completeGoogleSignIn refuses (T2.3)', () => {
  it.each<[string, Claims, TokenOptions]>([
    ['a bad signature', {}, { key: undefined }],
    ['the wrong audience', {}, { aud: 'someone-else.apps.googleusercontent.com' }],
    ['the wrong issuer', {}, { iss: 'https://accounts.evil.example' }],
    ['an expired id_token', {}, { exp: new Date(START.getTime() - 1000) }],
    ['a missing email', {}, { omit: ['email'] }],
    ['a missing nonce', {}, { omit: ['nonce'] }],
  ])('%s', async (label, claims, options) => {
    const result = await signIn(claims, label === 'a bad signature' ? { key: strangerKey } : options);

    expect(result).toEqual({ status: 'invalid_identity' });
    await expect(prisma.appUser.count()).resolves.toBe(0);
  });

  it('the wrong nonce', async () => {
    const flow = await start();
    fake.answer = () => idToken('a-nonce-from-another-flow-entirely-123456');

    await expect(completeGoogleSignIn(deps, { code: 'c', state: flow.state })).resolves.toEqual({ status: 'invalid_identity' });
  });

  it('an HS256 token "signed" with a shared secret, and an unsigned one', async () => {
    const flow = await start();
    fake.answer = () =>
      new SignJWT({ nonce: flow.nonce, email: EMAIL, email_verified: true })
        .setProtectedHeader({ alg: 'HS256', kid: KID })
        .setIssuer('https://accounts.google.com')
        .setAudience(CLIENT_ID)
        .setSubject(SUB)
        .setIssuedAt(Math.floor(START.getTime() / 1000))
        .setExpirationTime(Math.floor(START.getTime() / 1000) + 600)
        .sign(new TextEncoder().encode('x'.repeat(32)));
    await expect(completeGoogleSignIn(deps, { code: 'c', state: flow.state })).resolves.toEqual({ status: 'invalid_identity' });

    const second = await start();
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ nonce: second.nonce, email: EMAIL, email_verified: true, iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: SUB, exp: 9e9, iat: 1 })).toString('base64url');
    fake.answer = () => Promise.resolve(`${header}.${body}.`);
    await expect(completeGoogleSignIn(deps, { code: 'c', state: second.state })).resolves.toEqual({ status: 'invalid_identity' });
  });

  it.each([false, 'true', undefined])('email_verified = %j', async (value) => {
    const claims = value === undefined ? {} : { email_verified: value };
    const result = await signIn(claims, value === undefined ? { omit: ['email_verified'] } : {});

    expect(result).toEqual({ status: 'email_unverified' });
    await expect(prisma.appUser.count()).resolves.toBe(0);
  });

  it('a code Google refuses at the token endpoint', async () => {
    const flow = await start();

    await expect(completeGoogleSignIn(deps, { code: 'refused-by-google', state: flow.state })).resolves.toEqual({ status: 'invalid_identity' });
  });

  it('an unknown state, without calling the token endpoint', async () => {
    await start();

    await expect(completeGoogleSignIn(deps, { code: 'c', state: 'a-state-nobody-issued' })).resolves.toEqual({ status: 'invalid_state' });
    expect(fake.exchanges).toEqual([]);
  });

  it('an expired state: good for 10 minutes, not one more', async () => {
    const flow = await start();
    fake.answer = () => idToken(flow.nonce);
    clock = new Date(START.getTime() + OAUTH_FLOW_TTL_MINUTES * 60_000);

    await expect(completeGoogleSignIn(deps, { code: 'c', state: flow.state })).resolves.toEqual({ status: 'invalid_state' });
    expect(fake.exchanges).toEqual([]);
  });

  it('a reused state, even after a failed first use', async () => {
    const flow = await start();
    fake.answer = () => idToken(flow.nonce);

    await expect(completeGoogleSignIn(deps, { code: 'c', state: flow.state })).resolves.toMatchObject({ status: 'ok' });
    await expect(completeGoogleSignIn(deps, { code: 'c', state: flow.state })).resolves.toEqual({ status: 'invalid_state' });

    const failed = await start();
    await expect(completeGoogleSignIn(deps, { code: 'refused-by-google', state: failed.state })).resolves.toEqual({ status: 'invalid_identity' });
    fake.answer = () => idToken(failed.nonce);
    await expect(completeGoogleSignIn(deps, { code: 'c', state: failed.state })).resolves.toEqual({ status: 'invalid_state' });
  });
});

// --- The production provider's token exchange ------------------------------------------------

describe('createGoogleProvider', () => {
  it('posts the code, the verifier, the redirect URI and the client credentials as a form to Google', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const provider = createGoogleProvider({
      clientId: CLIENT_ID,
      clientSecret: 'the-client-secret',
      jwks: fake.jwks,
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ id_token: 'the.id.token', access_token: 'unused' }), { status: 200 });
      }) as typeof fetch,
    });

    await expect(provider.exchangeCode({ code: 'the-code', codeVerifier: 'v'.repeat(43), redirectUri: `${WEB_ORIGIN}/account/google/callback` })).resolves.toBe('the.id.token');

    expect(calls[0]?.url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.init?.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: 'v'.repeat(43),
      redirect_uri: `${WEB_ORIGIN}/account/google/callback`,
      client_id: CLIENT_ID,
      client_secret: 'the-client-secret',
    });
  });

  it('throws on a refusal without echoing its body', async () => {
    const provider = createGoogleProvider({
      clientId: CLIENT_ID,
      clientSecret: 's',
      jwks: fake.jwks,
      fetch: (async () => new Response('{"error":"invalid_grant","code":"the-code"}', { status: 400 })) as typeof fetch,
    });

    const error = await provider.exchangeCode({ code: 'the-code', codeVerifier: 'v'.repeat(43), redirectUri: 'x' }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('the-code');
  });
});
