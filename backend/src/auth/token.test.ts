import { SignJWT, decodeProtectedHeader, decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  TOKEN_ALGORITHM,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_TTL_SECONDS,
  issueAdminToken,
  passwordFingerprint,
  readBearerToken,
  safeEqual,
  sha256Hex,
  verifyAdminToken,
} from './token.js';

/**
 * The admin bearer token (plan.md Task 7, revision 2.3). Pure: no database, no
 * HTTP. Forged tokens are signed with jose directly, so each attack is built
 * exactly rather than approximated by string surgery.
 */

const SECRET = 'a-test-secret-that-is-comfortably-over-32-chars';
const OTHER_SECRET = 'a-different-secret-also-comfortably-over-32-chars';
const ADMIN_ID = '3f2b8c1e-5d4a-4e7b-9c6d-1a2b3c4d5e6f';
const PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';
const NOW = new Date('2026-09-14T08:00:00Z');
const NOW_SECONDS = NOW.getTime() / 1000;

const admin = { id: ADMIN_ID, passwordHash: PASSWORD_HASH };

function key(secret = SECRET): Uint8Array {
  return new TextEncoder().encode(secret);
}

type ForgeOptions = {
  alg?: string;
  secret?: string;
  sub?: string | null;
  iss?: string | null;
  aud?: string | null;
  iat?: number | null;
  exp?: number | null;
  fingerprint?: unknown;
};

/** A token with every claim under the test's control; `null` omits a claim. */
async function forge(options: ForgeOptions = {}): Promise<string> {
  const {
    alg = TOKEN_ALGORITHM,
    secret = SECRET,
    sub = ADMIN_ID,
    iss = TOKEN_ISSUER,
    aud = TOKEN_AUDIENCE,
    iat = NOW_SECONDS,
    exp = NOW_SECONDS + TOKEN_TTL_SECONDS,
    fingerprint = passwordFingerprint(SECRET, PASSWORD_HASH),
  } = options;

  const claims: Record<string, unknown> = {};
  if (fingerprint !== null) claims.pwd_fp = fingerprint;
  const jwt = new SignJWT(claims).setProtectedHeader({ alg, typ: 'JWT' });
  if (sub !== null) jwt.setSubject(sub);
  if (iss !== null) jwt.setIssuer(iss);
  if (aud !== null) jwt.setAudience(aud);
  if (iat !== null) jwt.setIssuedAt(iat);
  if (exp !== null) jwt.setExpirationTime(exp);
  return jwt.sign(key(secret));
}

function segments(token: string): [string, string, string] {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error(`Expected a three-segment JWT, got ${parts.length}`);
  return parts as [string, string, string];
}

// --- Issuing ------------------------------------------------------------------

describe('issueAdminToken', () => {
  it('signs HS256 and declares itself a JWT', async () => {
    const { token } = await issueAdminToken(SECRET, admin, NOW);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('names the admin, the issuer and the audience', async () => {
    const { token } = await issueAdminToken(SECRET, admin, NOW);
    expect(decodeJwt(token)).toMatchObject({
      sub: ADMIN_ID,
      iss: 'bookly-api',
      aud: 'bookly-admin',
    });
  });

  it('expires eight hours after the injected clock, in both the claim and the result', async () => {
    const { token, expiresAt } = await issueAdminToken(SECRET, admin, NOW);
    const claims = decodeJwt(token);

    expect(claims.iat).toBe(NOW_SECONDS);
    expect(claims.exp).toBe(NOW_SECONDS + 8 * 60 * 60);
    expect(expiresAt.toISOString()).toBe('2026-09-14T16:00:00.000Z');
  });

  it('floors a sub-second clock to whole seconds, as JWT NumericDate requires', async () => {
    const { token, expiresAt } = await issueAdminToken(
      SECRET,
      admin,
      new Date('2026-09-14T08:00:00.999Z'),
    );
    expect(decodeJwt(token).iat).toBe(NOW_SECONDS);
    expect(expiresAt.getTime() % 1000).toBe(0);
  });

  it('carries a fingerprint of the password hash, never the hash', async () => {
    const { token } = await issueAdminToken(SECRET, admin, NOW);
    const [, payload] = segments(token);
    const decoded = Buffer.from(payload, 'base64url').toString();

    expect(decodeJwt(token).pwd_fp).toBe(passwordFingerprint(SECRET, PASSWORD_HASH));
    expect(decoded).not.toContain(PASSWORD_HASH);
    expect(decoded).not.toContain('argon2');
    expect(decoded).not.toContain(sha256Hex(PASSWORD_HASH));
  });

  it('carries no claim beyond the six it needs', async () => {
    const { token } = await issueAdminToken(SECRET, admin, NOW);
    expect(Object.keys(decodeJwt(token)).sort()).toEqual(
      ['aud', 'exp', 'iat', 'iss', 'pwd_fp', 'sub'].sort(),
    );
  });

  it('round-trips through verifyAdminToken', async () => {
    const { token } = await issueAdminToken(SECRET, admin, NOW);
    await expect(verifyAdminToken(SECRET, token, NOW)).resolves.toEqual({
      adminId: ADMIN_ID,
      passwordFingerprint: passwordFingerprint(SECRET, PASSWORD_HASH),
    });
  });
});

// --- Verifying: expiry ------------------------------------------------------------

describe('verifyAdminToken and time', () => {
  it('accepts a token one second before it expires', async () => {
    const { token } = await issueAdminToken(SECRET, admin, NOW);
    const oneSecondBefore = new Date((NOW_SECONDS + TOKEN_TTL_SECONDS - 1) * 1000);
    await expect(verifyAdminToken(SECRET, token, oneSecondBefore)).resolves.not.toBeNull();
  });

  it('refuses a token at the instant it expires', async () => {
    const { token } = await issueAdminToken(SECRET, admin, NOW);
    const atExpiry = new Date((NOW_SECONDS + TOKEN_TTL_SECONDS) * 1000);
    await expect(verifyAdminToken(SECRET, token, atExpiry)).resolves.toBeNull();
  });

  it('refuses a token long after it expired', async () => {
    const { token } = await issueAdminToken(SECRET, admin, NOW);
    await expect(
      verifyAdminToken(SECRET, token, new Date('2027-01-01T00:00:00Z')),
    ).resolves.toBeNull();
  });

  it('refuses a correctly-signed token with no exp, rather than honouring it forever', async () => {
    await expect(verifyAdminToken(SECRET, await forge({ exp: null }), NOW)).resolves.toBeNull();
  });

  it('refuses a correctly-signed token with no iat', async () => {
    await expect(verifyAdminToken(SECRET, await forge({ iat: null }), NOW)).resolves.toBeNull();
  });
});

// --- Verifying: forgery -------------------------------------------------------------

describe('verifyAdminToken against forgery', () => {
  it('refuses a token signed with a different secret', async () => {
    await expect(
      verifyAdminToken(SECRET, await forge({ secret: OTHER_SECRET }), NOW),
    ).resolves.toBeNull();
  });

  it('refuses a genuine token verified under a different secret', async () => {
    const { token } = await issueAdminToken(SECRET, admin, NOW);
    await expect(verifyAdminToken(OTHER_SECRET, token, NOW)).resolves.toBeNull();
  });

  it('refuses a token whose payload was edited after signing', async () => {
    const [header, , signature] = segments(await forge());
    const extended = Buffer.from(
      JSON.stringify({
        ...decodeJwt(await forge()),
        exp: NOW_SECONDS + 365 * 24 * 60 * 60,
      }),
    ).toString('base64url');

    await expect(
      verifyAdminToken(SECRET, `${header}.${extended}.${signature}`, NOW),
    ).resolves.toBeNull();
  });

  it('refuses a token whose subject was swapped for another admin id after signing', async () => {
    const [header, , signature] = segments(await forge());
    const swapped = Buffer.from(
      JSON.stringify({ ...decodeJwt(await forge()), sub: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
    ).toString('base64url');

    await expect(
      verifyAdminToken(SECRET, `${header}.${swapped}.${signature}`, NOW),
    ).resolves.toBeNull();
  });

  it('refuses a token whose signature was altered', async () => {
    const [header, payload, signature] = segments(await forge());
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    await expect(verifyAdminToken(SECRET, `${header}.${payload}.${flipped}`, NOW)).resolves.toBeNull();
  });

  it('refuses a token with its signature removed', async () => {
    const [header, payload] = segments(await forge());
    await expect(verifyAdminToken(SECRET, `${header}.${payload}.`, NOW)).resolves.toBeNull();
  });
});

// --- Verifying: algorithm confusion ---------------------------------------------------

describe('verifyAdminToken against algorithm confusion', () => {
  it('refuses alg "none" with an empty signature', async () => {
    const [, payload] = segments(await forge());
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    await expect(verifyAdminToken(SECRET, `${none}.${payload}.`, NOW)).resolves.toBeNull();
  });

  it.each(['None', 'NONE', 'nOnE'])('refuses alg "%s" in any casing', async (alg) => {
    const [, payload] = segments(await forge());
    const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
    await expect(verifyAdminToken(SECRET, `${header}.${payload}.`, NOW)).resolves.toBeNull();
  });

  it.each(['HS384', 'HS512'])(
    'refuses a %s token signed with the RIGHT secret, because only HS256 is pinned',
    async (alg) => {
      await expect(verifyAdminToken(SECRET, await forge({ alg }), NOW)).resolves.toBeNull();
    },
  );

  it('refuses an HS256 signature presented under an RS256 header', async () => {
    const [, payload, signature] = segments(await forge());
    const rs = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    await expect(verifyAdminToken(SECRET, `${rs}.${payload}.${signature}`, NOW)).resolves.toBeNull();
  });
});

// --- Verifying: scope -------------------------------------------------------------------

describe('verifyAdminToken scope claims', () => {
  it.each([
    ['another audience', { aud: 'bookly-client' }],
    ['no audience', { aud: null }],
    ['another issuer', { iss: 'someone-else' }],
    ['no issuer', { iss: null }],
  ] as const)('refuses a correctly-signed token with %s', async (_label, override) => {
    await expect(verifyAdminToken(SECRET, await forge(override), NOW)).resolves.toBeNull();
  });
});

// --- Verifying: claim shapes ----------------------------------------------------------------

describe('verifyAdminToken claim shapes', () => {
  it('refuses a token with no subject', async () => {
    await expect(verifyAdminToken(SECRET, await forge({ sub: null }), NOW)).resolves.toBeNull();
  });

  it.each(['not-a-uuid', '', '1', "3f2b8c1e'; DROP TABLE admin_user;--", `${ADMIN_ID}x`])(
    'refuses a correctly-signed subject %j that is not a UUID -- a 401, never a database error',
    async (sub) => {
      await expect(verifyAdminToken(SECRET, await forge({ sub }), NOW)).resolves.toBeNull();
    },
  );

  it('accepts an upper-case UUID subject', async () => {
    const upper = ADMIN_ID.toUpperCase();
    await expect(verifyAdminToken(SECRET, await forge({ sub: upper }), NOW)).resolves.toMatchObject({
      adminId: upper,
    });
  });

  it('refuses a token with no password fingerprint', async () => {
    await expect(
      verifyAdminToken(SECRET, await forge({ fingerprint: null }), NOW),
    ).resolves.toBeNull();
  });

  it.each([42, true, { nested: 'x' }, ['a']])(
    'refuses a fingerprint that is not a string (%j)',
    async (fingerprint) => {
      await expect(verifyAdminToken(SECRET, await forge({ fingerprint }), NOW)).resolves.toBeNull();
    },
  );
});

// --- Verifying: garbage ---------------------------------------------------------------------

describe('verifyAdminToken on garbage', () => {
  it.each([
    ['an empty string', ''],
    ['one segment', 'abc'],
    ['two segments', 'abc.def'],
    ['three nonsense segments', 'abc.def.ghi'],
    ['four segments', 'a.b.c.d'],
    ['a dot only', '.'],
    ['base64 that is not JSON', 'bm90IGpzb24.bm90IGpzb24.c2ln'],
    ['whitespace', '   '],
  ])('returns null for %s rather than throwing', async (_label, token) => {
    await expect(verifyAdminToken(SECRET, token, NOW)).resolves.toBeNull();
  });
});

// --- The password fingerprint ------------------------------------------------------------------

describe('passwordFingerprint', () => {
  it('is deterministic for one secret and one hash', () => {
    expect(passwordFingerprint(SECRET, PASSWORD_HASH)).toBe(
      passwordFingerprint(SECRET, PASSWORD_HASH),
    );
  });

  it('changes when the password hash changes -- which is what revokes old tokens', () => {
    expect(passwordFingerprint(SECRET, PASSWORD_HASH)).not.toBe(
      passwordFingerprint(SECRET, `${PASSWORD_HASH}x`),
    );
  });

  it('changes with the secret, so it reveals nothing to someone without it', () => {
    expect(passwordFingerprint(SECRET, PASSWORD_HASH)).not.toBe(
      passwordFingerprint(OTHER_SECRET, PASSWORD_HASH),
    );
  });

  it('is not a plain hash of the password hash', () => {
    const fingerprint = passwordFingerprint(SECRET, PASSWORD_HASH);
    expect(fingerprint).not.toBe(sha256Hex(PASSWORD_HASH));
    expect(fingerprint).not.toBe(Buffer.from(sha256Hex(PASSWORD_HASH), 'hex').toString('base64url'));
  });

  it('is a 256-bit base64url value', () => {
    const fingerprint = passwordFingerprint(SECRET, PASSWORD_HASH);
    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

// --- Reading the header ------------------------------------------------------------------------

describe('readBearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc.def.ghi', 'abc.def.ghi'],
    ['BEARER abc.def.ghi', 'abc.def.ghi'],
    ['  Bearer abc.def.ghi  ', 'abc.def.ghi'],
    ['Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig-_', 'eyJhbGciOiJIUzI1NiJ9.e30.sig-_'],
  ])('reads %j as %j', (header, expected) => {
    expect(readBearerToken(header)).toBe(expected);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['the scheme alone', 'Bearer'],
    ['the scheme and a space', 'Bearer '],
    ['a different scheme', 'Basic dXNlcjpwYXNz'],
    ['a token with no scheme', 'abc.def.ghi'],
    ['a token with an inner space', 'Bearer abc def'],
    ['two spaces after the scheme', 'Bearer  abc.def.ghi'],
    ['a scheme glued to the token', 'Bearerabc.def.ghi'],
    ['a similar scheme', 'Bearers abc.def.ghi'],
    ['a token with a newline', 'Bearer abc\ndef'],
  ])('returns null for %s', (_label, header) => {
    expect(readBearerToken(header)).toBeNull();
  });
});

// --- Helpers kept for the reset flow -----------------------------------------------------------

describe('sha256Hex', () => {
  it('is the lower-case hex SHA-256', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('safeEqual', () => {
  it.each([
    ['equal strings', 'abc', 'abc', true],
    ['different strings of one length', 'abc', 'abd', false],
    ['different lengths', 'abc', 'abcd', false],
    ['two empty strings', '', '', true],
    ['an empty and a non-empty string', '', 'a', false],
    ['multi-byte characters', 'é', 'é', true],
  ])('compares %s', (_label, a, b, expected) => {
    expect(safeEqual(a, b)).toBe(expected);
  });
});
