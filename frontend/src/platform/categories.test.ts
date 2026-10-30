import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnauthenticatedError } from '@/auth/api'
import { readSession, saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import { type PlatformCategory, movedCategory, nameProblem, platformCategoriesApi, slugFromName, slugProblem } from './categories'

/**
 * The platform's categories client (Phase 9, R9.2): the slug and name rules
 * the form checks before sending, the suggested slug, one-place moves, and
 * each call's answers, refusals included.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

function category(overrides: Partial<PlatformCategory> = {}): PlatformCategory {
  return {
    id: 'c1',
    slug: 'wedding',
    nameEn: 'Wedding',
    isActive: true,
    sortOrder: 0,
    photographerCount: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => saveSession('platform', SESSION))
afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('slugProblem', () => {
  it.each([
    ['real-estate', null],
    ['a', null],
    ['drone2', null],
    ['  wedding  ', null],
    ['', 'required'],
    ['   ', 'required'],
    ['Wedding', 'format'],
    ['real estate', 'format'],
    ['real--estate', 'format'],
    ['-wedding', 'format'],
    ['wedding-', 'format'],
    ['mariage_é', 'format'],
    ['a'.repeat(64), null],
    ['a'.repeat(65), 'long'],
  ])('%j is %j', (slug, problem) => {
    expect(slugProblem(slug)).toBe(problem)
  })
})

describe('nameProblem', () => {
  it.each([
    ['Wedding', null],
    ['  Wedding  ', null],
    ['', 'required'],
    ['   ', 'required'],
    ['Wed\u0000ding', 'required'],
    ['x'.repeat(80), null],
    ['x'.repeat(81), 'long'],
    // Code points, as the API counts them: 80 emoji are 80 characters.
    ['📷'.repeat(80), null],
    ['📷'.repeat(81), 'long'],
  ])('%j is %j', (name, problem) => {
    expect(nameProblem(name)).toBe(problem)
  })
})

describe('slugFromName', () => {
  it.each([
    ['Real estate', 'real-estate'],
    ['Événements & fêtes', 'evenements-fetes'],
    ['  Drone / Aerial  ', 'drone-aerial'],
    ['***', ''],
    ['Portraits 2026', 'portraits-2026'],
  ])('%j suggests %j', (name, slug) => {
    expect(slugFromName(name)).toBe(slug)
    if (slug !== '') expect(slugProblem(slug)).toBeNull()
  })

  it('cuts a long name to 64 characters without a trailing hyphen', () => {
    const slug = slugFromName(`${'a'.repeat(63)} b`)
    expect(slug).toBe('a'.repeat(63))
    expect(slugProblem(slug)).toBeNull()
  })
})

describe('movedCategory', () => {
  it('swaps one place either way and leaves the ends alone', () => {
    expect(movedCategory(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(movedCategory(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    expect(movedCategory(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(movedCategory(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
  })
})

describe('platformCategoriesApi', () => {
  it('lists with the platform token, dropping a row it cannot use', async () => {
    const api = stubApi(() => json({ categories: [category(), { id: 'broken' }] }))
    expect(await platformCategoriesApi.list()).toEqual([category()])
    expect(api.sent[0]?.url).toBe('/api/platform/categories')
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
  })

  it('throws on a list answer it cannot read, and on a 401 drops the session', async () => {
    stubApi(() => json({ nope: true }))
    await expect(platformCategoriesApi.list()).rejects.toThrow()
    stubApi(() => json({ error: 'unauthenticated' }, 401))
    await expect(platformCategoriesApi.list()).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(readSession('platform')).toBeNull()
  })

  it('creates with the slug and name trimmed', async () => {
    const api = stubApi(() => json({ category: category({ id: 'c9', slug: 'drone', nameEn: 'Drone' }) }, 201))
    await expect(platformCategoriesApi.create('  drone ', ' Drone ')).resolves.toMatchObject({ status: 'created', category: { id: 'c9' } })
    expect(api.sent[0]).toMatchObject({ url: '/api/platform/categories', method: 'POST', body: { slug: 'drone', nameEn: 'Drone' } })
  })

  it.each([
    [json({ error: 'slug_taken' }, 409), { status: 'slug_taken' }],
    [json({ error: 'invalid_request' }, 400), { status: 'invalid', fields: ['slug'] }],
    [json({ error: 'validation_failed', fields: ['nameEn'] }, 422), { status: 'invalid', fields: ['nameEn'] }],
    [json({ error: 'validation_failed', fields: ['slug', 'nameEn'] }, 422), { status: 'invalid', fields: ['slug', 'nameEn'] }],
    [json({ error: 'validation_failed', fields: ['other'] }, 422), { status: 'failed' }],
    [json({ error: 'internal' }, 500), { status: 'failed' }],
    [json({ nothing: true }, 201), { status: 'failed' }],
  ])('a create answered %#', async (response, result) => {
    stubApi(() => response)
    await expect(platformCategoriesApi.create('drone', 'Drone')).resolves.toEqual(result)
  })

  it('a create that cannot reach the API throws, for the page to say so', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
    await expect(platformCategoriesApi.create('drone', 'Drone')).rejects.toThrow('offline')
  })

  it('patches only what changes, never the slug', async () => {
    const api = stubApi(() => json({ category: category({ isActive: false }) }))
    await platformCategoriesApi.update('c1', { isActive: false })
    await platformCategoriesApi.update('c1', { nameEn: ' Weddings ' })
    expect(api.sent.map((call) => [call.method, call.url, call.body])).toEqual([
      ['PATCH', '/api/platform/categories/c1', { isActive: false }],
      ['PATCH', '/api/platform/categories/c1', { nameEn: 'Weddings' }],
    ])
  })

  it.each([
    [404, { status: 'gone' }],
    [422, { status: 'invalid' }],
    [500, { status: 'failed' }],
  ])('an update refused with %i', async (status, result) => {
    stubApi(() => json({ error: 'x' }, status))
    await expect(platformCategoriesApi.update('c1', { nameEn: 'X' })).resolves.toEqual(result)
  })

  it('reorders with every id, and reads a 422 as a list changed elsewhere', async () => {
    const api = stubApi(() => json({ categories: [category({ id: 'b' }), category({ id: 'a' })] }))
    await expect(platformCategoriesApi.order(['b', 'a'])).resolves.toMatchObject({ status: 'saved', categories: [{ id: 'b' }, { id: 'a' }] })
    expect(api.sent[0]).toMatchObject({ url: '/api/platform/categories/order', method: 'PUT', body: { ids: ['b', 'a'] } })

    stubApi(() => json({ error: 'validation_failed', fields: ['ids'] }, 422))
    await expect(platformCategoriesApi.order(['b'])).resolves.toEqual({ status: 'changed' })
    stubApi(() => json({ error: 'invalid_request' }, 400))
    await expect(platformCategoriesApi.order(['b'])).resolves.toEqual({ status: 'failed' })
  })

  it('deletes, and reads the in-use refusal with its count', async () => {
    const api = stubApi(() => new Response(null, { status: 204 }))
    await expect(platformCategoriesApi.remove('c1')).resolves.toEqual({ status: 'deleted' })
    expect(api.sent[0]).toMatchObject({ url: '/api/platform/categories/c1', method: 'DELETE' })

    stubApi(() => json({ error: 'category_in_use', photographerCount: 2 }, 409))
    await expect(platformCategoriesApi.remove('c1')).resolves.toEqual({ status: 'in_use', photographerCount: 2 })
    // A refusal without a usable count still says someone has it.
    stubApi(() => json({ error: 'category_in_use' }, 409))
    await expect(platformCategoriesApi.remove('c1')).resolves.toEqual({ status: 'in_use', photographerCount: 1 })
    stubApi(() => json({ error: 'not_found' }, 404))
    await expect(platformCategoriesApi.remove('c1')).resolves.toEqual({ status: 'gone' })
    stubApi(() => json({ error: 'conflict' }, 409))
    await expect(platformCategoriesApi.remove('c1')).resolves.toEqual({ status: 'failed' })
  })
})
