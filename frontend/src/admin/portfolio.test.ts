import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import { type PortfolioImage, invalidImageFields, moved, portfolioApi } from './portfolio'

/** The portfolio client (R7.2): five calls, each refusal a result, and one move at a time. */

const SESSION = { token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }
const IMAGE: PortfolioImage = { id: 'i1', url: 'https://images.example/1.jpg', caption: null, sortOrder: 0, createdAt: '2026-10-01T00:00:00.000Z' }

beforeEach(() => saveSession('studio', SESSION))
afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('moved', () => {
  it('moves one place up or down', () => {
    expect(moved(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moved(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
  })

  it('leaves the order as it is past either end or for an index that is not there', () => {
    expect(moved(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(moved(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
    expect(moved(['a', 'b'], 5, -1)).toEqual(['a', 'b'])
    expect(moved([], 0, 1)).toEqual([])
  })

  it('never changes the list it was given', () => {
    const list = ['a', 'b']
    moved(list, 0, 1)
    expect(list).toEqual(['a', 'b'])
  })
})

describe('invalidImageFields', () => {
  it('accepts an https link and a caption of 200 characters, emoji counted once', () => {
    expect(invalidImageFields('https://images.example/a.jpg', '📷'.repeat(200))).toEqual([])
  })

  it('refuses a link that is not https, and a caption past 200 after trimming', () => {
    expect(invalidImageFields('http://images.example/a.jpg', 'x'.repeat(201))).toEqual(['url', 'caption'])
    expect(invalidImageFields('', `  ${'x'.repeat(200)}  `)).toEqual(['url'])
  })
})

describe('portfolioApi', () => {
  it('loads the images and the limit', async () => {
    const api = stubApi(() => json({ images: [IMAGE, { nonsense: true }], limit: 24 }))
    await expect(portfolioApi.load()).resolves.toEqual({ images: [IMAGE], limit: 24 })
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer studio.jwt')
  })

  it('falls back to 24 when the limit is missing, and refuses a body without images', async () => {
    stubApi(() => json({ images: [] }))
    await expect(portfolioApi.load()).resolves.toEqual({ images: [], limit: 24 })
    stubApi(() => json({}))
    await expect(portfolioApi.load()).rejects.toBeInstanceOf(ApiError)
  })

  it('adds with the link trimmed and a blank caption as null', async () => {
    const api = stubApi(() => json({ image: IMAGE }, 201))
    await expect(portfolioApi.add(' https://images.example/1.jpg ', '   ')).resolves.toEqual({ status: 'added', image: IMAGE })
    expect(api.sent[0]).toMatchObject({ method: 'POST', url: '/api/studio/portfolio', body: { url: 'https://images.example/1.jpg', caption: null } })
  })

  it.each<[string, Response, unknown]>([
    ['409 portfolio_full', json({ error: 'portfolio_full', limit: 24 }, 409), { status: 'full' }],
    ['422 url', json({ error: 'validation_failed', fields: ['url'] }, 422), { status: 'invalid', fields: ['url'] }],
    ['422 caption', json({ error: 'validation_failed', fields: ['caption'] }, 422), { status: 'invalid', fields: ['caption'] }],
    ['422 nothing known', json({ error: 'validation_failed', fields: ['x'] }, 422), { status: 'failed' }],
    ['400', json({ error: 'invalid_request' }, 400), { status: 'invalid', fields: ['url'] }],
    ['500', json({}, 500), { status: 'failed' }],
  ])('answers an add refused with %s', async (_label, response, expected) => {
    stubApi(() => response)
    await expect(portfolioApi.add('https://images.example/1.jpg', '')).resolves.toEqual(expected)
  })

  it('patches a caption, a blank one as null', async () => {
    const api = stubApi(() => json({ image: IMAGE }))
    await portfolioApi.caption('i/1', ' ')
    expect(api.sent[0]).toMatchObject({ method: 'PATCH', url: '/api/studio/portfolio/i%2F1', body: { caption: null } })
  })

  it.each<[number, unknown]>([
    [404, { status: 'gone' }],
    [422, { status: 'invalid' }],
    [500, { status: 'failed' }],
  ])('answers a caption refused with %i', async (status, expected) => {
    stubApi(() => json({ error: 'x' }, status))
    await expect(portfolioApi.caption('i1', 'x')).resolves.toEqual(expected)
  })

  it('removes with DELETE, a 404 as gone', async () => {
    const api = stubApi(() => new Response(null, { status: 204 }))
    await expect(portfolioApi.remove('i1')).resolves.toEqual({ status: 'removed' })
    expect(api.sent[0]).toMatchObject({ method: 'DELETE', url: '/api/studio/portfolio/i1' })
    stubApi(() => json({ error: 'not_found' }, 404))
    await expect(portfolioApi.remove('i1')).resolves.toEqual({ status: 'gone' })
    stubApi(() => json({}, 500))
    await expect(portfolioApi.remove('i1')).resolves.toEqual({ status: 'failed' })
  })

  it('saves the order with PUT and every id', async () => {
    const api = stubApi(() => json({ images: [IMAGE] }))
    await expect(portfolioApi.order(['i2', 'i1'])).resolves.toEqual({ status: 'saved', images: [IMAGE] })
    expect(api.sent[0]).toMatchObject({ method: 'PUT', url: '/api/studio/portfolio/order', body: { ids: ['i2', 'i1'] } })
  })

  it.each<[number, unknown]>([
    [422, { status: 'changed' }],
    [400, { status: 'changed' }],
    [500, { status: 'failed' }],
  ])('answers an order refused with %i', async (status, expected) => {
    stubApi(() => json({ error: 'validation_failed', fields: ['ids'] }, status))
    await expect(portfolioApi.order(['i1'])).resolves.toEqual(expected)
  })

  it('throws on a 401 from any write', async () => {
    stubApi(() => json({ error: 'invalid_token' }, 401))
    await expect(portfolioApi.add('https://a.example/x.jpg', '')).rejects.toBeInstanceOf(UnauthenticatedError)
    saveSession('studio', SESSION)
    await expect(portfolioApi.order([])).rejects.toBeInstanceOf(UnauthenticatedError)
  })
})
