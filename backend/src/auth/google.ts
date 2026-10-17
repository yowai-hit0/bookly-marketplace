import { createHash, randomBytes } from 'node:crypto';
import type { AppUser, Prisma } from '@prisma/client';
import { type JWTPayload, type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';
import { linkClientRows } from '../booking/client.js';
import { SQLSTATE, sqlstateOf } from '../db/errors.js';
import { type AuthDeps, findUserByEmail } from './account-auth.js';
import { type IssuedToken, issueToken, safeEqual, sha256Hex } from './token.js';

/**
 * "Continue with Google", for clients only (Phase 2 decision 6;
 * marketplace-spec.md R2.4, T2.3). The OpenID Connect authorization code flow
 * with PKCE (RFC 7636, S256), `state` and `nonce`; the code is exchanged on the
 * server, never in the browser, and the client secret never leaves it.
 *
 *   1. `startGoogleSignIn` mints a state, a code verifier and a nonce, stores
 *      them as one `oauth_flow` row (the state only as its SHA-256), and
 *      returns Google's authorization URL. Its `redirect_uri` is built here,
 *      from WEB_ORIGIN, so it cannot be pointed anywhere else.
 *   2. Google sends the browser back to `/account/google/callback?code&state`.
 *      The SPA checks the state against the one it kept in `sessionStorage`
 *      (login CSRF) and posts `{ code, state }`.
 *   3. `completeGoogleSignIn` consumes the flow -- one UPDATE, so a state works
 *      once and only for 10 minutes -- exchanges the code with the verifier,
 *      verifies the id_token against Google's keys (signature, RS256 only,
 *      `iss`, `aud`, `exp`, and the flow's `nonce`), requires
 *      `email_verified = true`, finds or creates the client account, links its
 *      bookings, and issues an account token.
 *
 * The identity provider is injected (`GoogleIdentityProvider`): the token
 * endpoint and the key set are the only two things Google provides, and the
 * tests replace both with a fake that signs with its own RS256 key. The clock
 * is `AuthDeps.now`, which also decides `exp`.
 *
 * **Which account** (R2.4):
 * - the one already linked to this Google subject;
 * - else a CLIENT account with this address, which is linked now. If that
 *   account's address was never verified, its password is DISCARDED as it is
 *   linked: nobody proved that password belongs to the inbox's owner, and
 *   Google just proved the inbox is this person's. Keeping it would hand a
 *   verified account to whoever pre-registered the address (R2.1c);
 * - else a new client account with no password;
 * - an address that belongs to a photographer or a platform admin is refused
 *   (`account_conflict`): one role per login, and Google sign-in is for
 *   clients. So is a client account already linked to another Google subject.
 */

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

/** Where Google returns the browser: the SPA's page, on WEB_ORIGIN (decision 6). */
export const GOOGLE_CALLBACK_PATH = '/account/google/callback';

/** Phase 2 decision 6. */
export const OAUTH_FLOW_TTL_MINUTES = 10;

/** Flows are kept a day past their expiry, then swept by the next start. */
const OAUTH_FLOW_RETENTION_MS = 24 * 60 * 60_000;

const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

/** What the identity provider must do for us; Google in production, a fake in tests. */
export type GoogleIdentityProvider = {
  clientId: string;
  authorizationEndpoint: string;
  /** Exchanges an authorization code at the token endpoint and returns the id_token; throws if refused. */
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<string>;
  /** The keys an id_token's signature is checked against. */
  jwks: JWTVerifyGetKey;
};

export type GoogleDeps = AuthDeps & { google: GoogleIdentityProvider };

/** Google itself: its token endpoint over `fetch`, and its published key set, cached by jose. */
export function createGoogleProvider(config: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  tokenEndpoint?: string;
  jwks?: JWTVerifyGetKey;
}): GoogleIdentityProvider {
  const doFetch = config.fetch ?? fetch;
  const tokenEndpoint = config.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
  return {
    clientId: config.clientId,
    authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
    jwks: config.jwks ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URI)),
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const response = await doFetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }).toString(),
        signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
      });
      // The body of a refusal is not logged or returned: it may echo the code.
      if (!response.ok) throw new Error(`Google's token endpoint answered ${response.status}`);
      const body = (await response.json()) as { id_token?: unknown };
      if (typeof body.id_token !== 'string') throw new Error("Google's token response has no id_token");
      return body.id_token;
    },
  };
}

/** The `redirect_uri` of every flow: on the web app, never the API (R2.4). */
export function googleRedirectUri(webOrigin: string): string {
  return `${webOrigin}${GOOGLE_CALLBACK_PATH}`;
}

/**
 * Starts a sign-in: one `oauth_flow` row, and the URL to send the browser to.
 * The state comes back too, for the SPA to keep in `sessionStorage` and compare
 * on return; it is also the URL's own `state` parameter.
 */
export async function startGoogleSignIn(deps: GoogleDeps): Promise<{ authorizationUrl: string; state: string }> {
  const now = deps.now();
  const state = randomBytes(32).toString('base64url');
  // 32 random bytes are 43 base64url characters: RFC 7636's minimum verifier.
  const codeVerifier = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  await deps.prisma.oauthFlow.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - OAUTH_FLOW_RETENTION_MS) } } });
  await deps.prisma.oauthFlow.create({
    data: {
      stateHash: sha256Hex(state),
      codeVerifier,
      nonce,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OAUTH_FLOW_TTL_MINUTES * 60_000),
    },
  });

  const url = new URL(deps.google.authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: deps.google.clientId,
    redirect_uri: googleRedirectUri(deps.webOrigin),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { authorizationUrl: url.toString(), state };
}

export type GoogleSignInResult =
  | ({ status: 'ok'; user: AppUser; created: boolean } & IssuedToken)
  /** Unknown, expired or already used state. */
  | { status: 'invalid_state' }
  /** The code exchange failed, or the id_token did not verify: signature, alg, iss, aud, exp, nonce, claims. */
  | { status: 'invalid_identity' }
  /** Google has not verified the address. */
  | { status: 'email_unverified' }
  /** The address is a photographer's or a platform admin's, or a client linked to another Google subject. */
  | { status: 'account_conflict' }
  /** The matching client login is disabled or erased. */
  | { status: 'account_unavailable' };

/** The verified id_token's claims this module reads. */
type GoogleIdentity = { sub: string; email: string; name: string | null };

export async function completeGoogleSignIn(deps: GoogleDeps, input: { code: string; state: string }): Promise<GoogleSignInResult> {
  const now = deps.now();

  // Consumed first and in one statement: from here on the state is spent,
  // whatever happens next, and a second callback with it finds nothing.
  const flows = await deps.prisma.$queryRaw<{ code_verifier: string; nonce: string }[]>`
    UPDATE oauth_flow
       SET consumed_at = ${now}::timestamptz
     WHERE state_hash = ${sha256Hex(input.state)}
       AND consumed_at IS NULL
       AND expires_at > ${now}::timestamptz
    RETURNING code_verifier, nonce`;
  const flow = flows[0];
  if (flow === undefined) return { status: 'invalid_state' };

  let payload: JWTPayload;
  try {
    const idToken = await deps.google.exchangeCode({ code: input.code, codeVerifier: flow.code_verifier, redirectUri: googleRedirectUri(deps.webOrigin) });
    ({ payload } = await jwtVerify(idToken, deps.google.jwks, {
      // Google signs id_tokens with RS256. Pinned, so `alg: none` or an HMAC
      // "signed" with the public key is refused before any key is consulted.
      algorithms: ['RS256'],
      issuer: [...GOOGLE_ISSUERS],
      audience: deps.google.clientId,
      currentDate: now,
      requiredClaims: ['sub', 'iat', 'exp', 'nonce', 'email'],
    }));
  } catch {
    return { status: 'invalid_identity' };
  }

  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, flow.nonce)) return { status: 'invalid_identity' };
  const identity = identityOf(payload);
  if (identity === null) return { status: 'invalid_identity' };
  // Strictly the boolean: Google proves the address, or this proves nothing.
  if (payload.email_verified !== true) return { status: 'email_unverified' };

  // Two first sign-ins of one new Google user can race to create the account;
  // the loser sees the winner's row on its second pass.
  for (let attempt = 1; ; attempt++) {
    try {
      const found = await deps.prisma.$transaction((tx) => findOrCreateClient(tx, identity, now));
      if (found.status !== 'ok') return found;
      const issued = await issueToken(deps.sessionSecret, 'account', found.user, now);
      return { status: 'ok', user: found.user, created: found.created, ...issued };
    } catch (error) {
      if (attempt < 2 && sqlstateOf(error) === SQLSTATE.UNIQUE_VIOLATION) continue;
      throw error;
    }
  }
}

function identityOf(payload: JWTPayload): GoogleIdentity | null {
  const { sub, email, name } = payload;
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > 255) return null;
  if (typeof email !== 'string' || email.length > 320 || !email.includes('@')) return null;
  const fullName = typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 200) : null;
  return { sub, email, name: fullName };
}

type FindResult = { status: 'ok'; user: AppUser; created: boolean } | { status: 'account_conflict' } | { status: 'account_unavailable' };

async function findOrCreateClient(tx: Prisma.TransactionClient, identity: GoogleIdentity, now: Date): Promise<FindResult> {
  let user: AppUser;
  let created = false;

  // 1. Already linked. `app_user_google_client_only` makes it a client.
  const linked = await tx.appUser.findFirst({ where: { googleSub: identity.sub } });
  if (linked !== null) {
    if (linked.role !== 'client') return { status: 'account_conflict' };
    if (linked.disabledAt !== null || linked.anonymizedAt !== null) return { status: 'account_unavailable' };
    user = linked;
  } else {
    const existing = await findUserByEmail(tx, identity.email);
    if (existing !== null) {
      // 2. A client with this address: link it.
      if (existing.role !== 'client' || existing.googleSub !== null) return { status: 'account_conflict' };
      if (existing.disabledAt !== null || existing.anonymizedAt !== null) return { status: 'account_unavailable' };
      const unverified = existing.emailVerifiedAt === null;
      user = await tx.appUser.update({
        where: { id: existing.id },
        data: {
          // Linking a Google subject changes the credential fingerprint, so
          // every token issued before it stops working (R2.1a).
          googleSub: identity.sub,
          ...(unverified
            ? {
                // Google verified the inbox; nobody verified the password that
                // was on the account. It goes, and so do the links it could use.
                emailVerifiedAt: now,
                emailVerifyTokenHash: null,
                emailVerifyExpiresAt: null,
                passwordHash: null,
                passwordResetTokenHash: null,
                passwordResetExpiresAt: null,
                failedLoginCount: 0,
                lockedUntil: null,
              }
            : {}),
        },
      });
    } else {
      // 3. Nobody: a new client, verified by Google, with no password.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO app_user (email, role, full_name, google_sub, email_verified_at)
        VALUES (${identity.email.trim().toLowerCase()}, 'client', ${identity.name}, ${identity.sub}, ${now}::timestamptz)
        RETURNING id::text AS id`;
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('The client insert returned no row.');
      user = await tx.appUser.findUniqueOrThrow({ where: { id } });
      created = true;
    }
  }

  // The address is proven: the bookings made under it become the account's
  // (marketplace-data-model.md §2.8).
  await linkClientRows(tx, user.id, user.email);
  const signedIn = await tx.appUser.update({ where: { id: user.id }, data: { lastLoginAt: now } });
  return { status: 'ok', user: signedIn, created };
}
