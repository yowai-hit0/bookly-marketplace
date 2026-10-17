import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { AREA_ROLE, type AuthArea, type UserRole } from './roles.js';

/**
 * The bearer access tokens of the three signed-in areas (plan.md Task 7,
 * revision 2.3; marketplace-spec.md R2.1; Phase 2 decision 2).
 *
 * Claims are `{ sub: userId, role }` plus the credential fingerprint. Each area
 * has its own `aud` -- `bookly-studio`, `bookly-platform`, `bookly-account` --
 * so a token issued for one is refused by the others' middleware, even on a
 * route wired to the wrong one. The role is informative: the middleware decides
 * on the role stored in `app_user`, never on the one in the token.
 *
 * A JWT the client sends as `Authorization: Bearer <token>`. No cookie is
 * involved, so there is nothing a browser attaches on its own, and therefore
 * nothing for a cross-site request to borrow: CSRF does not arise, and no CSRF
 * token exists.
 *
 * Stateless: no session table. A token stops working when it expires, when
 * SESSION_SECRET rotates (every signature stops verifying), or when its
 * credential fingerprint stops matching the user's row -- see
 * `credentialFingerprint` for what changes it.
 */

/** HS256: one service both issues and verifies, so a shared secret is right and
 *  an asymmetric key pair would buy nothing. Pinned on verify -- see below. */
export const TOKEN_ALGORITHM = 'HS256';

/** Scope claims. A JWT signed with this secret for any other purpose later (a
 *  reset link, say) cannot be replayed as an access token, and one area's
 *  token cannot be replayed in another's. */
export const TOKEN_ISSUER = 'bookly-api';
export const TOKEN_AUDIENCES = {
  studio: 'bookly-studio',
  platform: 'bookly-platform',
  account: 'bookly-account',
} as const satisfies Record<AuthArea, string>;

const HOUR_SECONDS = 60 * 60;

/** Eight hours for photographers and platform admins, seven days for clients (R2.1). */
export const TOKEN_TTL_SECONDS = {
  studio: 8 * HOUR_SECONDS,
  platform: 8 * HOUR_SECONDS,
  account: 7 * 24 * HOUR_SECONDS,
} as const satisfies Record<AuthArea, number>;

/** Private claim: an HMAC of the user's credentials -- never the credentials. */
const CREDENTIAL_FINGERPRINT_CLAIM = 'cred_fp';

/** Private claim: the `app_user.role` the token was issued to. */
const ROLE_CLAIM = 'role';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IssuedToken = { token: string; expiresAt: Date };

export type VerifiedClaims = { userId: string; role: UserRole; credentialFingerprint: string };

/** What a credential fingerprint is computed from: three `app_user` columns. */
export type CredentialSubject = { passwordHash: string | null; googleSub: string | null; tokenVersion: number };

/** The `app_user` columns a token is built from. */
export type TokenSubject = CredentialSubject & { id: string; role: string };

/**
 * Issues `area`'s token to `user`. Throws for a user of another role -- login
 * and Google sign-in never get here for one, so this is a bug, not a refusal --
 * and for a user with no credential at all, which the
 * `app_user_has_credential` CHECK already makes impossible.
 */
export async function issueToken(secret: string, area: AuthArea, user: TokenSubject, now: Date): Promise<IssuedToken> {
  if (user.role !== AREA_ROLE[area]) throw new Error(`Cannot issue a ${area} token to a ${user.role}`);
  if (user.passwordHash === null && user.googleSub === null) throw new Error('Cannot issue a token to a user without a credential');
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS[area];

  const token = await new SignJWT({
    [ROLE_CLAIM]: user.role,
    [CREDENTIAL_FINGERPRINT_CLAIM]: credentialFingerprint(secret, user),
  })
    .setProtectedHeader({ alg: TOKEN_ALGORITHM, typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCES[area])
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(signingKey(secret));

  return { token, expiresAt: new Date(expiresAt * 1000) };
}

/**
 * Verifies signature, algorithm, issuer, `area`'s audience and expiry, and
 * returns the claims -- or null for any token that fails any of them, and for
 * one whose role claim is not the area's.
 *
 * `algorithms` is pinned. That single option is what closes the algorithm-
 * confusion class of attack: a token declaring `alg: none`, or any algorithm but
 * HS256, is refused before its signature is even considered. The claims list is
 * required too, so a correctly-signed token that somehow lacks `exp` is refused
 * rather than treated as valid forever.
 *
 * This does NOT check the fingerprint or the role against the database: it has
 * no database. The area's middleware does both after loading the user.
 */
export async function verifyToken(secret: string, area: AuthArea, token: string, now: Date): Promise<VerifiedClaims | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(secret), {
      algorithms: [TOKEN_ALGORITHM],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCES[area],
      currentDate: now,
      requiredClaims: ['sub', 'iat', 'exp', ROLE_CLAIM, CREDENTIAL_FINGERPRINT_CLAIM],
    });

    const fingerprint = payload[CREDENTIAL_FINGERPRINT_CLAIM];
    const role = payload[ROLE_CLAIM];
    // A UUID check before the id reaches a `@db.Uuid` lookup: a malformed id
    // raises a database error there, and a bad token must be a 401, never a 500.
    if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) return null;
    if (typeof fingerprint !== 'string') return null;
    const expected = AREA_ROLE[area];
    if (role !== expected) return null;

    return { userId: payload.sub, role: expected, credentialFingerprint: fingerprint };
  } catch {
    // Every jose failure -- malformed, expired, wrong key, wrong alg, wrong
    // audience -- is the same outcome to the caller: not a valid token.
    return null;
  }
}

/**
 * Binds a token to the credentials it was issued under -- the revocation
 * scheme of every role (Phase 2 decision 2, T2.5). It covers three columns of
 * `app_user`, and changing any of them fails every token issued before the
 * change, on the very next request:
 *
 * - `password_hash`: a password change or reset (the scheme of Phase 1);
 * - `google_sub`: linking or unlinking a Google identity;
 * - `token_version`: bumped by `revokeTokens` (auth/account-auth.ts). This is
 *   the revocation a Google-only client gets, having no password to change --
 *   "sign out everywhere", erasure -- and it works for every other role too.
 *
 * Disabling or erasing a login needs none of this: the middleware refuses a
 * disabled or anonymized row outright.
 *
 * An HMAC under the server secret, not a plain hash: a JWT payload is only
 * base64, readable by anyone holding the token, and nothing derived from the
 * Argon2 hash or the Google subject without the secret may appear in it. The
 * input is a JSON array, so no value can impersonate a separator.
 */
export function credentialFingerprint(secret: string, subject: CredentialSubject): string {
  const material = JSON.stringify(['cred_fp.v1', subject.passwordHash, subject.googleSub, subject.tokenVersion]);
  return createHmac('sha256', secret).update(material).digest('base64url');
}

/**
 * The token from an `Authorization: Bearer <token>` header, or null. The scheme
 * is case-insensitive (RFC 7235 §2.1); anything else -- no header, another
 * scheme, an empty token, stray whitespace inside it -- is null.
 */
export function readBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

/** SHA-256, for single-use high-entropy tokens that need no slow hash. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison that tolerates unequal lengths. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * jose does not enforce a minimum HMAC key length -- it will happily sign with a
 * 5-byte key. The 32-character floor on SESSION_SECRET in `env.ts` is therefore
 * the only guard between this and a brute-forceable signature. Do not relax it.
 */
function signingKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}
