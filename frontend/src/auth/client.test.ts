import { afterEach, describe, expect, it, vi } from 'vitest'
import { json, stubApi } from '@/test/fetch'
import { ApiError } from './api'
import { GOOGLE_FLOW_KEY, externalNavigation, googleStateMatches, startGoogleSignIn, takeGoogleFlow } from './client'

/**
 * Google sign-in's `state` (marketplace spec R2.4): stored in this tab's
 * `sessionStorage` before leaving for Google, read back once, and compared
 * with what Google returns before any code is posted.
 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  localStorage.clear()
})

describe('startGoogleSignIn', () => {
  it('stores the state and the return path in sessionStorage, then goes to Google', async () => {
    const api = stubApi(() => json({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', state: 'st4te' }))
    const assign = vi.spyOn(externalNavigation, 'assign').mockImplementation(() => {})

    await startGoogleSignIn('/account')

    expect(api.sent[0]).toMatchObject({ method: 'POST', url: '/api/account/auth/google/start' })
    expect(JSON.parse(sessionStorage.getItem(GOOGLE_FLOW_KEY) ?? 'null')).toEqual({ state: 'st4te', next: '/account' })
    expect(localStorage.length).toBe(0)
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1')
  })

  it.each(['javascript:alert(1)', 'http://accounts.google.com/o', 'not a url'])('refuses to follow %j, storing nothing', async (authorizationUrl) => {
    stubApi(() => json({ authorizationUrl, state: 'st4te' }))
    const assign = vi.spyOn(externalNavigation, 'assign').mockImplementation(() => {})

    await expect(startGoogleSignIn(null)).rejects.toBeInstanceOf(ApiError)

    expect(assign).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(GOOGLE_FLOW_KEY)).toBeNull()
  })

  it('surfaces a 404 (Google is off) as the API’s refusal', async () => {
    stubApi(() => json({ error: 'not_found' }, 404))
    vi.spyOn(externalNavigation, 'assign').mockImplementation(() => {})

    await expect(startGoogleSignIn(null)).rejects.toMatchObject({ status: 404 })
  })
})

describe('takeGoogleFlow', () => {
  it('reads the stored flow once, removing it', () => {
    sessionStorage.setItem(GOOGLE_FLOW_KEY, JSON.stringify({ state: 'st4te', next: '/account' }))

    expect(takeGoogleFlow()).toEqual({ state: 'st4te', next: '/account' })
    expect(sessionStorage.getItem(GOOGLE_FLOW_KEY)).toBeNull()
    expect(takeGoogleFlow()).toBeNull()
  })

  it.each(['not json', 'null', JSON.stringify({ state: '' }), JSON.stringify({ state: 42 })])('reads %j as no flow', (stored) => {
    sessionStorage.setItem(GOOGLE_FLOW_KEY, stored)

    expect(takeGoogleFlow()).toBeNull()
    expect(sessionStorage.getItem(GOOGLE_FLOW_KEY)).toBeNull()
  })

  it('reads no flow rather than throwing when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })

    expect(takeGoogleFlow()).toBeNull()
  })
})

describe('googleStateMatches', () => {
  const stored = { state: 'st4te', next: null }

  it('matches the very state this tab stored', () => {
    expect(googleStateMatches(stored, 'st4te')).toBe(true)
  })

  it.each<[string, typeof stored | null, string | null]>([
    ['nothing stored', null, 'st4te'],
    ['nothing returned', stored, null],
    ['an empty state returned', stored, ''],
    ['another state', stored, 'other'],
    ['a state differing only in case', stored, 'ST4TE'],
    ['a prefix of it', stored, 'st4t'],
  ])('refuses %s', (_label, theStored, returned) => {
    expect(googleStateMatches(theStored, returned)).toBe(false)
  })
})
