import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION, USER } from '@/test/account-fixtures'
import { json, stubApi } from '@/test/fetch'
import { accountName, fetchAccountMe, forgetAccountMe, primeAccountMe, refreshAccountMe, useAccount } from './account'
import { saveSession } from './session'

/**
 * The signed-in client's `/me` (R2.1c, R8.3): one request per token, an answer
 * primed by a credential change, and a refresh that keeps the account on
 * screen until the new answer lands.
 */

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  forgetAccountMe()
})

describe('the account', () => {
  it('asks once per token', async () => {
    saveSession('account', SESSION)
    const api = stubApi(() => json({ user: USER }))
    await Promise.all([fetchAccountMe(SESSION.token), fetchAccountMe(SESSION.token)])
    expect(api.sent).toHaveLength(1)
  })

  it('a failure is not kept: the next ask tries again', async () => {
    saveSession('account', SESSION)
    let fail = true
    const api = stubApi(() => (fail ? json({ error: 'internal_error' }, 500) : json({ user: USER })))
    await expect(fetchAccountMe(SESSION.token)).rejects.toMatchObject({ status: 500 })
    fail = false
    await expect(fetchAccountMe(SESSION.token)).resolves.toEqual(USER)
    expect(api.sent).toHaveLength(2)
  })

  it('a primed answer is ready at once, with no request', () => {
    saveSession('account', { ...SESSION, token: 'primed.jwt' })
    const api = stubApi(() => json({ user: USER }))
    primeAccountMe('primed.jwt', { ...USER, hasPassword: false })

    const { result } = renderHook(() => useAccount())
    expect(result.current).toEqual({ state: 'ready', user: { ...USER, hasPassword: false } })
    expect(api.sent).toHaveLength(0)
  })

  it('a refresh asks again and keeps the old account on screen meanwhile', async () => {
    saveSession('account', SESSION)
    let release: (response: Response) => void = () => {}
    let calls = 0
    stubApi(() => {
      calls += 1
      return calls === 1 ? json({ user: USER }) : new Promise<Response>((resolve) => (release = resolve))
    })
    const { result } = renderHook(() => useAccount())
    await waitFor(() => expect(result.current).toEqual({ state: 'ready', user: USER }))

    act(() => refreshAccountMe())
    await waitFor(() => expect(calls).toBe(2))
    expect(result.current).toEqual({ state: 'ready', user: USER })

    await act(async () => release(json({ user: { ...USER, fullName: 'Aline U.' } })))
    await waitFor(() => expect(result.current).toMatchObject({ state: 'ready', user: { fullName: 'Aline U.' } }))
  })

  it('is signed out with no token', () => {
    stubApi(() => json({ user: USER }))
    const { result } = renderHook(() => useAccount())
    expect(result.current).toEqual({ state: 'signedOut' })
  })

  it('is named by its name, else its address', () => {
    expect(accountName(USER)).toBe('Aline Uwase')
    expect(accountName({ ...USER, fullName: '   ' })).toBe('aline@example.com')
    expect(accountName({ ...USER, fullName: null })).toBe('aline@example.com')
  })
})
