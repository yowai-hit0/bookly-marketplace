import { SignJWT, decodeProtectedHeader, decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  TOKEN_ALGORITHM,
  TOKEN_AUDIENCES,
  TOKEN_ISSUER,
  TOKEN_TTL_SECONDS,
  credentialFingerprint,
  issueToken,
  readBearerToken,
  safeEqual,
  sha256Hex,
  verifyToken,
} from './token.js';
import { AREA_ROLE, AUTH_AREAS, type AuthArea } from './roles.js';

/**
 * The bearer tokens of the three signed-in areas (plan.md Task 7, revision 2.3;
 * marketplace-spec.md R2.1; Phase 2 decision 2): `{ sub: userId, role }`, one
 * audience and one lifetime per area, and the credential fingerprint. Pure: no
 * database, no HTTP. Forged tokens are signed with jose directly, so each attack is built
 * exactly rather than approximated by string surgery.
 */

const SECRET = 'a-test-secret-that-is-comfortably-over-32-chars';
const OTHER_SECRET = 'a-different-secret-also-comfortably-over-32-chars';
const ADMIN_ID = '3f2b8c1e-5d4a-4e7b-9c6d-1a2b3c4d5e6f';
const PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';
const NOW = new Date('2026-09-14T08:00:00Z');
const NOW_SECONDS = NOW.getTime() / 1000;

const GOOGLE_SUB = '109876543210987654321';

/** A photographer with a password: the studio's token subject. */
const admin = { id: ADMIN_ID, role: 'photographer', passwordHash: PASSWORD_HASH, googleSub: null, tokenVersion: 0 };

/** The subject of each area: a user of the area's own role. */
function subjectFor(area: AuthArea) {
  return { ...admin, role: AREA_ROLE[area] };
}

/** Every role but `role`. */
function otherRoles(role: string): string[] {
  return Object.values(AREA_ROLE).filter((other) => other !== role);
}

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
  role?: unknown;
  fingerprint?: unknown;
};

/** A token with every claim under the test's control; `null` omits a claim. */
async function forge(options: ForgeOptions = {}): Promise<string> {
  const {
    alg = TOKEN_ALGORITHM,
    secret = SECRET,
    sub = ADMIN_ID,
    iss = TOKEN_ISSUER,
    aud = TOKEN_AUDIENCES.studio,
    iat = NOW_SECONDS,
    exp = NOW_SECONDS + TOKEN_TTL_SECONDS.studio,
    role = 'photographer',
    fingerprint = credentialFingerprint(SECRET, admin),
  } = options;

  const claims: Record<string, unknown> = {};
  if (role !== null) claims.role = role;
  if (fingerprint !== null) claims.cred_fp = fingerprint;
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

describe('issueToken', () => {
  it('signs HS256 and declares itself a JWT', async () => {
    const { token } = await issueToken(SECRET, 'studio', admin, NOW);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('names the user, their role, the issuer and the audience', async () => {
    const { token } = await issueToken(SECRET, 'studio', admin, NOW);
    expect(decodeJwt(token)).toMatchObject({
      sub: ADMIN_ID,
      role: 'photographer',
      iss: 'bookly-api',
      aud: 'bookly-studio',
    });
  });

  it('refuses to issue for a user with no credential at all: there is nothing to bind the token to', async () => {
    await expect(issueToken(SECRET, 'studio', { ...admin, passwordHash: null }, NOW)).rejects.toThrow(/without a credential/);
  });

  it('issues an account token to a Google-only client, bound to the Google subject', async () => {
    const google = { ...subjectFor('account'), passwordHash: null, googleSub: GOOGLE_SUB };
    const { token } = await issueToken(SECRET, 'account', google, NOW);

    await expect(verifyToken(SECRET, 'account', token, NOW)).resolves.toEqual({
      userId: ADMIN_ID,
      role: 'client',
      credentialFingerprint: credentialFingerprint(SECRET, google),
    });
    expect(Buffer.from(segments(token)[1], 'base64url').toString()).not.toContain(GOOGLE_SUB);
  });

  it.each(['admin', 'client', 'platform_admin'])('refuses to issue a studio token to the role %s', async (role) => {
    await expect(issueToken(SECRET, 'studio', { ...admin, role }, NOW)).rejects.toThrow(/Cannot issue a studio token/);
  });

  it.each([
    ['platform', 'photographer'],
    ['account', 'photographer'],
    ['account', 'platform_admin'],
  ] as const)('refuses to issue a %s token to a %s', async (area, role) => {
    await expect(issueToken(SECRET, area, { ...admin, role }, NOW)).rejects.toThrow(/Cannot issue/);
  });

  it('expires eight hours after the injected clock, in both the claim and the result', async () => {
    const { token, expiresAt } = await issueToken(SECRET, 'studio', admin, NOW);
    const claims = decodeJwt(token);

    expect(claims.iat).toBe(NOW_SECONDS);
    expect(claims.exp).toBe(NOW_SECONDS + 8 * 60 * 60);
    expect(expiresAt.toISOString()).toBe('2026-09-14T16:00:00.000Z');
  });

  it('floors a sub-second clock to whole seconds, as JWT NumericDate requires', async () => {
    const { token, expiresAt } = await issueToken(
      SECRET,
      'studio',
      admin,
      new Date('2026-09-14T08:00:00.999Z'),
    );
    expect(decodeJwt(token).iat).toBe(NOW_SECONDS);
    expect(expiresAt.getTime() % 1000).toBe(0);
  });

  it('carries a fingerprint of the credentials, never the password hash', async () => {
    const { token } = await issueToken(SECRET, 'studio', admin, NOW);
    const [, payload] = segments(token);
    const decoded = Buffer.from(payload, 'base64url').toString();

    expect(decodeJwt(token).cred_fp).toBe(credentialFingerprint(SECRET, admin));
    expect(decoded).not.toContain(PASSWORD_HASH);
    expect(decoded).not.toContain('argon2');
    expect(decoded).not.toContain(sha256Hex(PASSWORD_HASH));
  });

  it('carries no claim beyond the seven it needs', async () => {
    const { token } = await issueToken(SECRET, 'studio', admin, NOW);
    expect(Object.keys(decodeJwt(token)).sort()).toEqual(
      ['aud', 'exp', 'iat', 'iss', 'cred_fp', 'role', 'sub'].sort(),
    );
  });

  it('round-trips through verifyToken', async () => {
    const { token } = await issueToken(SECRET, 'studio', admin, NOW);
    await expect(verifyToken(SECRET, 'studio', token, NOW)).resolves.toEqual({
      userId: ADMIN_ID,
      role: 'photographer',
      credentialFingerprint: credentialFingerprint(SECRET, admin),
    });
  });
});

// --- One audience and one lifetime per area (Phase 2 decision 2) ---------------------

describe('the areas', () => {
  it('give each area its own audience', () => {
    expect(TOKEN_AUDIENCES).toEqual({ studio: 'bookly-studio', platform: 'bookly-platform', account: 'bookly-account' });
    expect(new Set(Object.values(TOKEN_AUDIENCES)).size).toBe(AUTH_AREAS.length);
  });

  it.each([
    ['studio', 8 * 60 * 60],
    ['platform', 8 * 60 * 60],
    ['account', 7 * 24 * 60 * 60],
  ] as const)('issues %s tokens for %i seconds, in the claim and the result', async (area, seconds) => {
    expect(TOKEN_TTL_SECONDS[area]).toBe(seconds);
    const { token, expiresAt } = await issueToken(SECRET, area, subjectFor(area), NOW);

    expect(decodeJwt(token)).toMatchObject({ aud: TOKEN_AUDIENCES[area], role: AREA_ROLE[area], exp: NOW_SECONDS + seconds });
    expect(expiresAt.getTime()).toBe((NOW_SECONDS + seconds) * 1000);
  });

  it.each(AUTH_AREAS)('round-trips a %s token in its own area', async (area) => {
    const { token } = await issueToken(SECRET, area, subjectFor(area), NOW);
    await expect(verifyToken(SECRET, area, token, NOW)).resolves.toMatchObject({ userId: ADMIN_ID, role: AREA_ROLE[area] });
  });

  // Every (issued for, presented to) pair of two different areas.
  const crossings = AUTH_AREAS.flatMap((issued) => AUTH_AREAS.filter((other) => other !== issued).map((presented) => [issued, presented] as const));

  it.each(crossings)('refuses a %s token presented to the %s area', async (issued, presented) => {
    const { token } = await issueToken(SECRET, issued, subjectFor(issued), NOW);
    await expect(verifyToken(SECRET, presented, token, NOW)).resolves.toBeNull();
  });

  it.each(crossings)('refuses a correctly-signed %s-audience token claiming the role of the %s area', async (issued, presented) => {
    const token = await forge({ aud: TOKEN_AUDIENCES[issued], role: AREA_ROLE[presented] });
    await expect(verifyToken(SECRET, presented, token, NOW)).resolves.toBeNull();
  });

  it.each(AUTH_AREAS.flatMap((area) => otherRoles(AREA_ROLE[area]).map((role) => [area, role] as const)))(
    'refuses a correctly-signed %s-audience token claiming the role %s',
    async (area, role) => {
      await expect(verifyToken(SECRET, area, await forge({ aud: TOKEN_AUDIENCES[area], role }), NOW)).resolves.toBeNull();
    },
  );

  it('refuses a Phase 1 token, issued for the retired bookly-admin audience, in every area', async () => {
    const legacy = await forge({ aud: 'bookly-admin' });
    for (const area of AUTH_AREAS) await expect(verifyToken(SECRET, area, legacy, NOW)).resolves.toBeNull();
  });
});

// --- Verifying: expiry ------------------------------------------------------------

describe('verifyToken and time', () => {
  it('accepts a token one second before it expires', async () => {
    const { token } = await issueToken(SECRET, 'studio', admin, NOW);
    const oneSecondBefore = new Date((NOW_SECONDS + TOKEN_TTL_SECONDS.studio - 1) * 1000);
    await expect(verifyToken(SECRET, 'studio', token, oneSecondBefore)).resolves.not.toBeNull();
  });

  it('refuses a token at the instant it expires', async () => {
    const { token } = await issueToken(SECRET, 'studio', admin, NOW);
    const atExpiry = new Date((NOW_SECONDS + TOKEN_TTL_SECONDS.studio) * 1000);
    await expect(verifyToken(SECRET, 'studio', token, atExpiry)).resolves.toBeNull();
  });

  it('refuses a token long after it expired', async () => {
    const { token } = await issueToken(SECRET, 'studio', admin, NOW);
    await expect(
      verifyToken(SECRET, 'studio', token, new Date('2027-01-01T00:00:00Z')),
    ).resolves.toBeNull();
  });

  it('refuses a correctly-signed token with no exp, rather than honouring it forever', async () => {
    await expect(verifyToken(SECRET, 'studio', await forge({ exp: null }), NOW)).resolves.toBeNull();
  });

  it('refuses a correctly-signed token with no iat', async () => {
    await expect(verifyToken(SECRET, 'studio', await forge({ iat: null }), NOW)).resolves.toBeNull();
  });
});

// --- Verifying: forgery -------------------------------------------------------------

describe('verifyToken against forgery', () => {
  it('refuses a token signed with a different secret', async () => {
    await expect(
      verifyToken(SECRET, 'studio', await forge({ secret: OTHER_SECRET }), NOW),
    ).resolves.toBeNull();
  });

  it('refuses a genuine token verified under a different secret', async () => {
    const { token } = await issueToken(SECRET, 'studio', admin, NOW);
    await expect(verifyToken(OTHER_SECRET, 'studio', token, NOW)).resolves.toBeNull();
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
      verifyToken(SECRET, 'studio', `${header}.${extended}.${signature}`, NOW),
    ).resolves.toBeNull();
  });

  it('refuses a token whose subject was swapped for another admin id after signing', async () => {
    const [header, , signature] = segments(await forge());
    const swapped = Buffer.from(
      JSON.stringify({ ...decodeJwt(await forge()), sub: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
    ).toString('base64url');

    await expect(
      verifyToken(SECRET, 'studio', `${header}.${swapped}.${signature}`, NOW),
    ).resolves.toBeNull();
  });

  it('refuses a token whose signature was altered', async () => {
    const [header, payload, signature] = segments(await forge());
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    await expect(verifyToken(SECRET, 'studio', `${header}.${payload}.${flipped}`, NOW)).resolves.toBeNull();
  });

  it('refuses a token with its signature removed', async () => {
    const [header, payload] = segments(await forge());
    await expect(verifyToken(SECRET, 'studio', `${header}.${payload}.`, NOW)).resolves.toBeNull();
  });
});

// --- Verifying: algorithm confusion ---------------------------------------------------

describe('verifyToken against algorithm confusion', () => {
  it('refuses alg "none" with an empty signature', async () => {
    const [, payload] = segments(await forge());
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    await expect(verifyToken(SECRET, 'studio', `${none}.${payload}.`, NOW)).resolves.toBeNull();
  });

  it.each(['None', 'NONE', 'nOnE'])('refuses alg "%s" in any casing', async (alg) => {
    const [, payload] = segments(await forge());
    const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
    await expect(verifyToken(SECRET, 'studio', `${header}.${payload}.`, NOW)).resolves.toBeNull();
  });

  it.each(['HS384', 'HS512'])(
    'refuses a %s token signed with the RIGHT secret, because only HS256 is pinned',
    async (alg) => {
      await expect(verifyToken(SECRET, 'studio', await forge({ alg }), NOW)).resolves.toBeNull();
    },
  );

  it('refuses an HS256 signature presented under an RS256 header', async () => {
    const [, payload, signature] = segments(await forge());
    const rs = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    await expect(verifyToken(SECRET, 'studio', `${rs}.${payload}.${signature}`, NOW)).resolves.toBeNull();
  });
});

// --- Verifying: scope -------------------------------------------------------------------

describe('verifyToken scope claims', () => {
  it.each([
    ['another audience', { aud: 'bookly-client' }],
    ['the retired Phase 1 audience', { aud: 'bookly-admin' }],
    ['no audience', { aud: null }],
    ['another issuer', { iss: 'someone-else' }],
    ['no issuer', { iss: null }],
  ] as const)('refuses a correctly-signed token with %s', async (_label, override) => {
    await expect(verifyToken(SECRET, 'studio', await forge(override), NOW)).resolves.toBeNull();
  });
});

// --- Verifying: claim shapes ----------------------------------------------------------------

describe('verifyToken claim shapes', () => {
  it('refuses a token with no subject', async () => {
    await expect(verifyToken(SECRET, 'studio', await forge({ sub: null }), NOW)).resolves.toBeNull();
  });

  it.each(['not-a-uuid', '', '1', "3f2b8c1e'; DROP TABLE app_user;--", `${ADMIN_ID}x`])(
    'refuses a correctly-signed subject %j that is not a UUID -- a 401, never a database error',
    async (sub) => {
      await expect(verifyToken(SECRET, 'studio', await forge({ sub }), NOW)).resolves.toBeNull();
    },
  );

  it('accepts an upper-case UUID subject', async () => {
    const upper = ADMIN_ID.toUpperCase();
    await expect(verifyToken(SECRET, 'studio', await forge({ sub: upper }), NOW)).resolves.toMatchObject({
      userId: upper,
    });
  });

  it('refuses a token with no role: one issued before the marketplace', async () => {
    await expect(verifyToken(SECRET, 'studio', await forge({ role: null }), NOW)).resolves.toBeNull();
  });

  it.each(['admin', 'Photographer', '', 42, ['photographer'], { role: 'photographer' }])(
    'refuses a correctly-signed role %j outside app_user_role_allowed',
    async (role) => {
      await expect(verifyToken(SECRET, 'studio', await forge({ role }), NOW)).resolves.toBeNull();
    },
  );

  it('refuses a token carrying the Phase 1 pwd_fp claim instead of cred_fp', async () => {
    const legacy = await new SignJWT({ role: 'photographer', pwd_fp: credentialFingerprint(SECRET, admin) })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(ADMIN_ID)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCES.studio)
      .setIssuedAt(NOW_SECONDS)
      .setExpirationTime(NOW_SECONDS + 60)
      .sign(key());
    await expect(verifyToken(SECRET, 'studio', legacy, NOW)).resolves.toBeNull();
  });

  it('refuses a token with no credential fingerprint', async () => {
    await expect(
      verifyToken(SECRET, 'studio', await forge({ fingerprint: null }), NOW),
    ).resolves.toBeNull();
  });

  it.each([42, true, { nested: 'x' }, ['a']])(
    'refuses a fingerprint that is not a string (%j)',
    async (fingerprint) => {
      await expect(verifyToken(SECRET, 'studio', await forge({ fingerprint }), NOW)).resolves.toBeNull();
    },
  );
});

// --- Verifying: garbage ---------------------------------------------------------------------

describe('verifyToken on garbage', () => {
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
    await expect(verifyToken(SECRET, 'studio', token, NOW)).resolves.toBeNull();
  });
});

// --- The credential fingerprint (Phase 2 decision 2) ----------------------------------------

describe('credentialFingerprint', () => {
  const base = { passwordHash: PASSWORD_HASH as string | null, googleSub: null as string | null, tokenVersion: 0 };

  it('is deterministic for one secret and one set of credentials', () => {
    expect(credentialFingerprint(SECRET, base)).toBe(credentialFingerprint(SECRET, { ...base }));
  });

  it.each<[string, Partial<typeof base>]>([
    ['the password hash changes -- a password change or reset', { passwordHash: `${PASSWORD_HASH}x` }],
    ['a Google identity is linked', { googleSub: GOOGLE_SUB }],
    ['the token version goes up -- revokeTokens', { tokenVersion: 1 }],
  ])('changes when %s, which is what revokes old tokens', (_label, change) => {
    expect(credentialFingerprint(SECRET, { ...base, ...change })).not.toBe(credentialFingerprint(SECRET, base));
  });

  it('gives a Google-only client a fingerprint that moves with the token version and the subject', () => {
    const google = { passwordHash: null, googleSub: GOOGLE_SUB, tokenVersion: 0 };
    expect(credentialFingerprint(SECRET, { ...google, tokenVersion: 1 })).not.toBe(credentialFingerprint(SECRET, google));
    expect(credentialFingerprint(SECRET, { ...google, googleSub: 'another-subject' })).not.toBe(credentialFingerprint(SECRET, google));
    expect(credentialFingerprint(SECRET, { ...google, passwordHash: PASSWORD_HASH })).not.toBe(credentialFingerprint(SECRET, google));
  });

  it('cannot be matched by moving text between fields', () => {
    // With naive concatenation these two would hash the same input.
    const a = { passwordHash: 'ab', googleSub: 'c', tokenVersion: 0 };
    const b = { passwordHash: 'a', googleSub: 'bc', tokenVersion: 0 };
    expect(credentialFingerprint(SECRET, a)).not.toBe(credentialFingerprint(SECRET, b));
  });

  it('changes with the secret, so it reveals nothing to someone without it', () => {
    expect(credentialFingerprint(SECRET, base)).not.toBe(credentialFingerprint(OTHER_SECRET, base));
  });

  it('is not a plain hash of the password hash', () => {
    const fingerprint = credentialFingerprint(SECRET, base);
    expect(fingerprint).not.toBe(sha256Hex(PASSWORD_HASH));
    expect(fingerprint).not.toBe(Buffer.from(sha256Hex(PASSWORD_HASH), 'hex').toString('base64url'));
  });

  it('is a 256-bit base64url value', () => {
    expect(credentialFingerprint(SECRET, base)).toMatch(/^[A-Za-z0-9_-]{43}$/);
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
