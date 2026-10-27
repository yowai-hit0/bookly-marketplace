import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import { setupBody } from '@/test/onboarding-fixtures'
import { SETUP_ITEMS, SETUP_LINKS, setupApi } from './setup'

/** The setup client (R7.3, T7.1): the checklist as the page can trust it, and the submission's answers. */

const SESSION = { token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }


beforeEach(() => saveSession('studio', SESSION))
afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('SETUP_LINKS', () => {
  it('sends each item to the page that fixes it', () => {
    expect(SETUP_LINKS).toEqual({
      profile: '/studio/profile',
      categories: '/studio/profile#categories',
      districts: '/studio/profile#districts',
      payoutMethod: '/studio/payout-method',
      services: '/studio/catalogue',
      workingHours: '/studio/availability',
    })
  })
})

describe('setupApi.load', () => {
  it('reads the checklist with the studio token', async () => {
    const api = stubApi(() => json(setupBody({ profile: true })))
    const setup = await setupApi.load()
    expect(setup.items.map((item) => item.key)).toEqual([...SETUP_ITEMS])
    expect(setup.items[0]).toEqual({ key: 'profile', done: true })
    expect(setup.canSubmit).toBe(false)
    expect(api.sent[0]).toMatchObject({ method: 'GET', url: '/api/studio/setup' })
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer studio.jwt')
  })

  it('puts the items in checklist order and drops unknown or repeated ones', async () => {
    const body = setupBody()
    body.setup.items = [
      { key: 'workingHours', done: true },
      { key: 'mystery' as 'profile', done: true },
      { key: 'profile', done: true },
      { key: 'profile', done: false },
    ]
    stubApi(() => json(body))
    expect((await setupApi.load()).items).toEqual([
      { key: 'profile', done: true },
      { key: 'workingHours', done: true },
    ])
  })

  it('reads canSubmit only when it is true, and submittedAt only as text', async () => {
    stubApi(() => json(setupBody({}, { canSubmit: 'yes', submittedAt: 5 })))
    const setup = await setupApi.load()
    expect(setup.canSubmit).toBe(false)
    expect(setup.submittedAt).toBeNull()
  })

  it.each([{}, { setup: null }, { setup: { items: 'x' } }, { setup: { ...setupBody().setup, status: 'mystery' } }])('refuses %j', async (body) => {
    stubApi(() => json(body))
    await expect(setupApi.load()).rejects.toBeInstanceOf(ApiError)
  })
})

describe('setupApi.submit', () => {
  it('posts with no body and answers the submitted setup', async () => {
    const api = stubApi(() => json(setupBody({}, { submittedAt: '2026-10-25T08:00:00.000Z' })))
    const result = await setupApi.submit()
    expect(result.status).toBe('submitted')
    expect(result.status === 'submitted' && result.setup.submittedAt).toBe('2026-10-25T08:00:00.000Z')
    expect(api.sent[0]).toMatchObject({ method: 'POST', url: '/api/studio/setup/submit', body: undefined })
  })

  it('answers the missing items of a 422 in checklist order, unknown ones dropped', async () => {
    stubApi(() => json({ error: 'setup_incomplete', missing: ['workingHours', 'mystery', 'profile'] }, 422))
    await expect(setupApi.submit()).resolves.toEqual({ status: 'incomplete', missing: ['profile', 'workingHours'] })
  })

  it('answers a 422 with no list as incomplete with nothing named', async () => {
    stubApi(() => json({ error: 'setup_incomplete' }, 422))
    await expect(setupApi.submit()).resolves.toEqual({ status: 'incomplete', missing: [] })
  })

  it.each<[Response, unknown]>([
    [json({ error: 'not_pending' }, 409), { status: 'not_pending' }],
    [json({ error: 'conflict' }, 409), { status: 'failed' }],
    [json({ error: 'validation_failed' }, 422), { status: 'failed' }],
    [json({}, 500), { status: 'failed' }],
    [json({ setup: null }), { status: 'failed' }],
  ])('answers %#', async (response, expected) => {
    stubApi(() => response)
    await expect(setupApi.submit()).resolves.toEqual(expected)
  })

  it('throws on a 401', async () => {
    stubApi(() => json({ error: 'invalid_token' }, 401))
    await expect(setupApi.submit()).rejects.toBeInstanceOf(UnauthenticatedError)
  })
})
