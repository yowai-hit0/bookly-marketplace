import { describe, expect, it } from 'vitest'
import { landingPath, loginPathFor, safeReturnPath } from './areas'

/**
 * The return path a login carries (`?next=`) is the one way a link could
 * steer where signing in lands, so only a path inside the area's own pages is
 * accepted: no open redirect (Phase 2 brief decision 10).
 */

describe('safeReturnPath', () => {
  it.each<[string, string]>([
    ['/studio/bookings', '/studio/bookings'],
    ['/studio/bookings/b1?tab=money', '/studio/bookings/b1?tab=money'],
    ['/studio', '/studio'],
    ['/studio/calendar?view=week&date=2026-10-07', '/studio/calendar?view=week&date=2026-10-07'],
  ])('accepts %s inside the studio', (raw, expected) => {
    expect(safeReturnPath(raw, 'studio')).toBe(expected)
  })

  it('accepts the account and platform pages for their own area', () => {
    expect(safeReturnPath('/account', 'account')).toBe('/account')
    expect(safeReturnPath('/platform/photographers?status=pending', 'platform')).toBe('/platform/photographers?status=pending')
  })

  it.each<[string, string]>([
    ['an absolute URL to another site', 'https://evil.example/studio/bookings'],
    ['an absolute URL to this very path', 'http://localhost/studio/bookings'],
    ['a protocol-relative URL', '//evil.example/studio'],
    ['a protocol-relative URL with a backslash', '/\\evil.example/studio'],
    ['a backslash later in the path', '/studio\\..\\..\\evil'],
    ['a javascript: URL', 'javascript:alert(document.cookie)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a relative path without a slash', 'studio/bookings'],
    ['a tab hidden in the scheme', '/\t/evil.example'],
    ['a newline', '/studio/bookings\n//evil.example'],
    ['a path that climbs out of the area', '/studio/../platform/photographers'],
    ['a look-alike prefix', '/studio-evil/bookings'],
    ['another area', '/platform/photographers'],
    ['the client site', '/my-booking'],
    ['the login itself', '/studio/login'],
    ['the signup', '/studio/signup'],
    ['a verify link', '/studio/verify/abc'],
    ['the reset page', '/studio/reset-password'],
    ['an empty string', ''],
  ])('refuses %s', (_label, raw) => {
    expect(safeReturnPath(raw, 'studio')).toBeNull()
  })

  it('refuses null and a path too long to be real', () => {
    expect(safeReturnPath(null, 'studio')).toBeNull()
    expect(safeReturnPath(`/studio/${'a'.repeat(3000)}`, 'studio')).toBeNull()
  })

  it('refuses the account’s Google callback as a place to return to', () => {
    expect(safeReturnPath('/account/google/callback?code=x', 'account')).toBeNull()
  })
})

describe('loginPathFor', () => {
  it('carries where the visitor was going, query included, and never the fragment', () => {
    expect(loginPathFor('studio', { pathname: '/studio/bookings', search: '?stage=confirmed' })).toBe(
      '/studio/login?next=%2Fstudio%2Fbookings%3Fstage%3Dconfirmed',
    )
  })

  it('carries nothing when the visitor was going to the area’s home', () => {
    expect(loginPathFor('account', { pathname: '/account', search: '' })).toBe('/account/login')
    expect(loginPathFor('platform', { pathname: '/platform/photographers', search: '' })).toBe('/platform/login')
    expect(loginPathFor('studio', { pathname: '/studio', search: '' })).toBe('/studio/login')
  })
})

describe('landingPath', () => {
  it('lands on a safe return path', () => {
    expect(landingPath('platform', '?next=%2Fplatform%2Fphotographers%3Fstatus%3Dpending')).toBe('/platform/photographers?status=pending')
  })

  it.each<[string, string]>([
    ['no return path', ''],
    ['an unsafe one', '?next=https%3A%2F%2Fevil.example'],
    ['another area’s', '?next=%2Fstudio%2Fbookings'],
  ])('lands on the area’s home with %s', (_label, search) => {
    expect(landingPath('account', search)).toBe('/account')
  })
})
