import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

/**
 * The admin access token (plan.md Task 7, revision 2.3).
 *
 * A JWT the client sends as `Authorization: Bearer <token>`. No cookie is
 * involved in admin auth, so there is nothing a browser attaches on its own, and
 * therefore nothing for a cross-site request to borrow: CSRF does not arise, and
 * no CSRF token exists.
 *
 * Stateless, like the cookie it replaced: 8 hours, no session table. It is
 * revoked two ways only -- changing the password (the token's fingerprint claim
 * stops matching) or rotating SESSION_SECRET (every signature stops verifying).
 */

/** HS256: one service both issues and verifies, so a shared secret is right and
 *  an asymmetric key pair would buy nothing. Pinned on verify -- see below. */
export const TOKEN_ALGORITHM = 'HS256';

/** Scope claims. A JWT signed with this secret for any other purpose later (a
 *  reset link, a client token) cannot be replayed as an admin token. */
export const TOKEN_ISSUER = 'bookly-api';
export const TOKEN_AUDIENCE = 'bookly-admin';

export const TOKEN_TTL_SECONDS = 8 * 60 * 60;

/** Private claim: an HMAC of the admin's password hash -- never the hash. */
const PASSWORD_FINGERPRINT_CLAIM = 'pwd_fp';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IssuedToken = { token: string; expiresAt: Date };

export type VerifiedClaims = { adminId: string; passwordFingerprint: string };

export async function issueAdminToken(
  secret: string,
  admin: { id: string; passwordHash: string },
  now: Date,
): Promise<IssuedToken> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;

  const token = await new SignJWT({
    [PASSWORD_FINGERPRINT_CLAIM]: passwordFingerprint(secret, admin.passwordHash),
  })
    .setProtectedHeader({ alg: TOKEN_ALGORITHM, typ: 'JWT' })
    .setSubject(admin.id)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(signingKey(secret));

  return { token, expiresAt: new Date(expiresAt * 1000) };
}

/**
 * Verifies signature, algorithm, issuer, audience and expiry, and returns the
 * claims -- or null for any token that fails any of them.
 *
 * `algorithms` is pinned. That single option is what closes the algorithm-
 * confusion class of attack: a token declaring `alg: none`, or any algorithm but
 * HS256, is refused before its signature is even considered. The claims list is
 * required too, so a correctly-signed token that somehow lacks `exp` is refused
 * rather than treated as valid forever.
 *
 * This does NOT check the password fingerprint against the database: it has no
 * database. `requireAdmin` does that after loading the admin.
 */
export async function verifyAdminToken(
  secret: string,
  token: string,
  now: Date,
): Promise<VerifiedClaims | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(secret), {
      algorithms: [TOKEN_ALGORITHM],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      currentDate: now,
      requiredClaims: ['sub', 'iat', 'exp', PASSWORD_FINGERPRINT_CLAIM],
    });

    const fingerprint = payload[PASSWORD_FINGERPRINT_CLAIM];
    // A UUID check before the id reaches a `@db.Uuid` lookup: a malformed id
    // raises a database error there, and a bad token must be a 401, never a 500.
    if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) return null;
    if (typeof fingerprint !== 'string') return null;

    return { adminId: payload.sub, passwordFingerprint: fingerprint };
  } catch {
    // Every jose failure -- malformed, expired, wrong key, wrong alg, wrong
    // audience -- is the same outcome to the caller: not a valid admin token.
    return null;
  }
}

/**
 * Binds a token to the password it was issued under. Changing the password
 * changes this value, so every token issued before the change fails on the next
 * request -- the revocation the cookie design got from signing over the hash.
 *
 * An HMAC under the server secret, not a plain hash: a JWT payload is only
 * base64, readable by anyone holding the token, and nothing derived from the
 * Argon2 hash without the secret may appear in it.
 */
export function passwordFingerprint(secret: string, passwordHash: string): string {
  return createHmac('sha256', secret).update(`pwd_fp.${passwordHash}`).digest('base64url');
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
