import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession, readSession, saveSession } from './session'

/**
 * Where the admin UI keeps its bearer token (plan.md Task 7 and Task 9
 * Assumptions): `sessionStorage` under one key, never `localStorage`; an
 * expired or unreadable entry reads as signed out and is forgotten.
 */

const KEY = 'bookly.admin.session'
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

describe('saveSession and readSession', () => {
  it('stores the session as JSON in sessionStorage alone, and reads it back', () => {
    saveSession(SESSION)

    expect(JSON.parse(sessionStorage.getItem(KEY) ?? 'null')).toEqual(SESSION)
    expect(localStorage.length).toBe(0)
    expect(readSession()).toEqual(SESSION)
  })

  it('reads null when nothing is stored', () => {
    expect(readSession()).toBeNull()
  })

  it.each<[string, string, boolean]>([
    ['a millisecond before expiry', '2026-10-07T15:59:59.999Z', true],
    ['exactly at expiry', '2026-10-07T16:00:00.000Z', false],
    ['after expiry', '2026-10-08T00:00:00.000Z', false],
  ])('at %s the session is live = %s', (_label, now, live) => {
    saveSession(SESSION)

    expect(readSession(new Date(now))).toEqual(live ? SESSION : null)
    expect(sessionStorage.getItem(KEY) !== null).toBe(live)
  })

  it('judges expiry by the current clock when no time is given', () => {
    saveSession(SESSION)
    expect(readSession()).toEqual(SESSION)

    vi.setSystemTime(new Date(SESSION.expiresAt))

    expect(readSession()).toBeNull()
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  it('reads text that is not JSON as signed out and forgets it', () => {
    sessionStorage.setItem(KEY, '{"token": "abc", ')

    expect(readSession()).toBeNull()
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  it.each<[string, string]>([
    ['JSON null', 'null'],
    ['an array', '["abc", "2026-10-07T16:00:00.000Z"]'],
    ['a missing token', JSON.stringify({ expiresAt: SESSION.expiresAt })],
    ['an empty token', JSON.stringify({ token: '', expiresAt: SESSION.expiresAt })],
    ['a numeric token', JSON.stringify({ token: 42, expiresAt: SESSION.expiresAt })],
    ['a missing expiry', JSON.stringify({ token: SESSION.token })],
    ['an expiry that is not a datetime', JSON.stringify({ token: SESSION.token, expiresAt: 'tomorrow' })],
    ['an expiry given as epoch milliseconds', JSON.stringify({ token: SESSION.token, expiresAt: Date.parse(SESSION.expiresAt) })],
  ])('reads %s as signed out and forgets it', (_label, stored) => {
    sessionStorage.setItem(KEY, stored)

    expect(readSession()).toBeNull()
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  it('never reads a token left in localStorage', () => {
    localStorage.setItem(KEY, JSON.stringify(SESSION))

    expect(readSession()).toBeNull()
  })

  it('reads null rather than throwing when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })

    expect(readSession()).toBeNull()
  })
})

describe('clearSession', () => {
  it('forgets the session and nothing else', () => {
    saveSession(SESSION)
    sessionStorage.setItem('unrelated', 'kept')

    clearSession()

    expect(sessionStorage.getItem(KEY)).toBeNull()
    expect(sessionStorage.getItem('unrelated')).toBe('kept')
    expect(readSession()).toBeNull()
  })

  it('does not throw when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })

    expect(() => clearSession()).not.toThrow()
  })
})
