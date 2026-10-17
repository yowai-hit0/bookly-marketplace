import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AREAS, clearSession, readSession, saveSession, sessionKey, useSessionToken } from './session'

/**
 * One session store per area (Phase 2 brief decision 10): `sessionStorage`
 * keys `bookly.studio.session`, `bookly.platform.session` and
 * `bookly.account.session`, never `localStorage`; an expired or unreadable
 * entry reads as signed out and is forgotten; each area's entry is its own.
 */

const NOW = new Date('2026-10-07T08:00:00.000Z')
const SESSION = { token: 'header.payload.signature', expiresAt: '2026-10-07T16:00:00.000Z' }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  sessionStorage.clear()
  localStorage.clear()
})

describe('the per-area keys', () => {
  it('names one key per area', () => {
    expect(AREAS.map(sessionKey)).toEqual(['bookly.studio.session', 'bookly.platform.session', 'bookly.account.session'])
  })

  it.each(AREAS)('stores the %s session as JSON in sessionStorage alone, and reads it back', (area) => {
    saveSession(area, SESSION)

    expect(JSON.parse(sessionStorage.getItem(`bookly.${area}.session`) ?? 'null')).toEqual(SESSION)
    expect(localStorage.length).toBe(0)
    expect(readSession(area)).toEqual(SESSION)
  })

  it('keeps nothing of what it is handed but the token and the expiry', () => {
    saveSession('account', { ...SESSION, user: { email: 'aline@example.com' } } as typeof SESSION)

    expect(JSON.parse(sessionStorage.getItem('bookly.account.session') ?? 'null')).toEqual(SESSION)
  })

  it('keeps the areas apart: one area’s session never reads as another’s', () => {
    saveSession('studio', SESSION)

    expect(readSession('studio')).toEqual(SESSION)
    expect(readSession('platform')).toBeNull()
    expect(readSession('account')).toBeNull()
  })

  it('signs one area out and leaves the others signed in', () => {
    for (const area of AREAS) saveSession(area, { ...SESSION, token: `${area}.token` })

    clearSession('platform')

    expect(readSession('platform')).toBeNull()
    expect(readSession('studio')?.token).toBe('studio.token')
    expect(readSession('account')?.token).toBe('account.token')
  })

  it('ignores the retired admin key', () => {
    sessionStorage.setItem('bookly.admin.session', JSON.stringify(SESSION))

    expect(readSession('studio')).toBeNull()
  })
})

describe('reading a stored session', () => {
  it.each<[string, string, boolean]>([
    ['a millisecond before expiry', '2026-10-07T15:59:59.999Z', true],
    ['exactly at expiry', '2026-10-07T16:00:00.000Z', false],
    ['after expiry', '2026-10-08T00:00:00.000Z', false],
  ])('at %s the account session is live = %s', (_label, now, live) => {
    saveSession('account', SESSION)

    expect(readSession('account', new Date(now))).toEqual(live ? SESSION : null)
    expect(sessionStorage.getItem('bookly.account.session') !== null).toBe(live)
  })

  it.each<[string, string]>([
    ['text that is not JSON', '{"token": "abc", '],
    ['JSON null', 'null'],
    ['an empty token', JSON.stringify({ token: '', expiresAt: SESSION.expiresAt })],
    ['an expiry that is not a datetime', JSON.stringify({ token: SESSION.token, expiresAt: 'tomorrow' })],
  ])('reads %s as signed out and forgets it', (_label, stored) => {
    sessionStorage.setItem('bookly.platform.session', stored)

    expect(readSession('platform')).toBeNull()
    expect(sessionStorage.getItem('bookly.platform.session')).toBeNull()
  })

  it('never reads a token left in localStorage', () => {
    localStorage.setItem('bookly.account.session', JSON.stringify(SESSION))

    expect(readSession('account')).toBeNull()
  })

  it('reads null rather than throwing when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })

    expect(readSession('account')).toBeNull()
    expect(() => clearSession('account')).not.toThrow()
  })
})

describe('useSessionToken', () => {
  it('follows sign-in and sign-out of its own area in this tab', () => {
    const { result } = renderHook(() => useSessionToken('account'))
    expect(result.current).toBeNull()

    act(() => saveSession('account', SESSION))
    expect(result.current).toBe(SESSION.token)

    act(() => clearSession('account'))
    expect(result.current).toBeNull()
  })

  it('does not change for another area’s sign-in', () => {
    const { result } = renderHook(() => useSessionToken('platform'))

    act(() => saveSession('studio', SESSION))

    expect(result.current).toBeNull()
  })

  it('reads an expired session as signed out', () => {
    saveSession('studio', { ...SESSION, expiresAt: NOW.toISOString() })
    const { result } = renderHook(() => useSessionToken('studio'))

    expect(result.current).toBeNull()
  })
})
