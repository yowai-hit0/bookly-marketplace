import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import { PROFILE } from '@/test/onboarding-fixtures'
import { type ProfileForm, charCount, handleChangeNotifies, invalidProfileFields, isHttpsLink, profileApi, profileForm, profilePatch } from './profile'

/**
 * The profile client (R7.2): the form's values from the API's, only what
 * changed in a save, the checks that stand in for the API's unlabelled 400,
 * and every refusal as a result the page can put on a field.
 */

const SESSION = { token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }


beforeEach(() => saveSession('studio', SESSION))
afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

function edited(changes: Partial<ProfileForm>): ProfileForm {
  return { ...profileForm(PROFILE), ...changes }
}

describe('profileForm', () => {
  it('turns nulls into empty text and the lists into sets of codes and slugs', () => {
    const form = profileForm(PROFILE)
    expect(form.whatsappPhone).toBe('')
    expect(form.contactEmail).toBe('')
    expect([...form.districts]).toEqual(['gasabo'])
    expect([...form.categories]).toEqual(['portrait'])
  })
})

describe('profilePatch', () => {
  const saved = profileForm(PROFILE)

  it('is empty when nothing changed', () => {
    expect(profilePatch(saved, edited({}), true)).toEqual({})
  })

  it('ignores whitespace around text and a handle in another case', () => {
    expect(profilePatch(saved, edited({ displayName: '  Kigali Lens ', bio: 'Portraits in natural light.  ', handle: ' Kigali-LENS ' }), true)).toEqual({})
  })

  it('sends only the fields that changed, trimmed', () => {
    expect(profilePatch(saved, edited({ displayName: ' Kigali Lens Studio ', whatsappPhone: ' 078 123 4567 ' }), true)).toEqual({
      displayName: 'Kigali Lens Studio',
      whatsappPhone: '078 123 4567',
    })
  })

  it('clears an optional field with null when it is emptied', () => {
    expect(profilePatch(saved, edited({ bio: '   ', coverImageUrl: '', contactPhone: '' }), true)).toEqual({ bio: null, coverImageUrl: null, contactPhone: null })
  })

  it('sends a new handle lowercased while it is editable, and never once it is locked', () => {
    expect(profilePatch(saved, edited({ handle: ' New-Handle ' }), true)).toEqual({ handle: 'new-handle' })
    expect(profilePatch(saved, edited({ handle: 'new-handle' }), false)).toEqual({})
  })

  it('compares the lists as sets, and sends the whole set when it changed', () => {
    const both = profileForm({ ...PROFILE, districts: [{ code: 'gasabo', name: 'Gasabo' }, { code: 'kicukiro', name: 'Kicukiro' }] })
    expect(profilePatch(both, { ...both, districts: new Set(['kicukiro', 'gasabo']) }, true)).toEqual({})
    expect(profilePatch(saved, edited({ districts: new Set(['gasabo', 'rubavu']) }), true)).toEqual({ districts: ['gasabo', 'rubavu'] })
    expect(profilePatch(saved, edited({ categories: new Set() }), true)).toEqual({ categories: [] })
  })
})

describe('invalidProfileFields', () => {
  it('accepts a good patch', () => {
    expect(
      invalidProfileFields({
        handle: 'kigali-lens-2',
        displayName: 'K',
        bio: 'x'.repeat(2000),
        contactPhone: '+250 78 123 4567',
        whatsappPhone: '(078) 123-4567',
        contactEmail: 'hello@kigali.example',
        coverImageUrl: 'https://images.example/a.jpg',
        districts: [],
        categories: [],
      }),
    ).toEqual([])
  })

  it('accepts clearing every optional field', () => {
    expect(invalidProfileFields({ bio: null, contactPhone: null, whatsappPhone: null, contactEmail: null, coverImageUrl: null })).toEqual([])
  })

  it.each(['ab', '-abc', 'abc-', 'has space', 'ünï', 'a'.repeat(31)])('refuses the handle %j', (handle) => {
    expect(invalidProfileFields({ handle })).toEqual(['handle'])
  })

  it('counts characters as the API does: 80 emoji are 80, not 160', () => {
    expect(charCount('📷'.repeat(80))).toBe(80)
    expect(invalidProfileFields({ displayName: '📷'.repeat(80) })).toEqual([])
    expect(invalidProfileFields({ displayName: '📷'.repeat(81) })).toEqual(['displayName'])
    expect(invalidProfileFields({ bio: '📷'.repeat(2001) })).toEqual(['bio'])
  })

  it('refuses an empty display name', () => {
    expect(invalidProfileFields({ displayName: '' })).toEqual(['displayName'])
  })

  it.each(['call me', '+', '---', `+${'1'.repeat(40)}`, '07812a4567'])('refuses the phone %j', (phone) => {
    expect(invalidProfileFields({ contactPhone: phone, whatsappPhone: phone })).toEqual(['contactPhone', 'whatsappPhone'])
  })

  it.each(['plain', 'a@b', '@kigali.example', 'two words@kigali.example'])('refuses the email %j', (contactEmail) => {
    expect(invalidProfileFields({ contactEmail })).toEqual(['contactEmail'])
  })

  it.each(['http://images.example/a.jpg', 'images.example/a.jpg', 'javascript:alert(1)', `https://images.example/${'a'.repeat(2000)}`])(
    'refuses the cover %j',
    (coverImageUrl) => {
      expect(invalidProfileFields({ coverImageUrl })).toEqual(['coverImageUrl'])
    },
  )

  it('reads https in any case as https', () => {
    expect(isHttpsLink('HTTPS://images.example/a.jpg')).toBe(true)
  })
})

describe('handleChangeNotifies (Phase 7, 2026-10-27)', () => {
  it('is true only while the studio is pending, submitted and its handle editable', () => {
    const submitted = { ...PROFILE, submittedAt: '2026-10-20T07:00:00.000Z' }

    expect(handleChangeNotifies(submitted)).toBe(true)
    expect(handleChangeNotifies(PROFILE)).toBe(false)
    expect(handleChangeNotifies({ ...submitted, status: 'suspended' })).toBe(false)
    expect(handleChangeNotifies({ ...submitted, status: 'approved', handleEditable: false })).toBe(false)
  })
})

describe('profileApi', () => {
  it('loads the profile with the studio token', async () => {
    const api = stubApi(() => json({ profile: PROFILE }))
    await expect(profileApi.load()).resolves.toEqual(PROFILE)
    expect(api.sent[0]).toMatchObject({ method: 'GET', url: '/api/studio/profile' })
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer studio.jwt')
  })

  it('reads a missing or unreadable submittedAt as not submitted', async () => {
    const { submittedAt: _absent, ...older } = PROFILE
    stubApi(() => json({ profile: older }))
    await expect(profileApi.load()).resolves.toEqual({ ...PROFILE, submittedAt: null })

    stubApi(() => json({ profile: { ...PROFILE, submittedAt: 42 } }))
    await expect(profileApi.save({ bio: 'x' })).resolves.toEqual({ status: 'saved', profile: { ...PROFILE, submittedAt: null } })

    stubApi(() => json({ profile: { ...PROFILE, submittedAt: '2026-10-20T07:00:00.000Z' } }))
    await expect(profileApi.load()).resolves.toMatchObject({ submittedAt: '2026-10-20T07:00:00.000Z' })
  })

  it('refuses a body without a profile', async () => {
    stubApi(() => json({ profile: { handle: 'x' } }))
    await expect(profileApi.load()).rejects.toBeInstanceOf(ApiError)
  })

  it('saves with PATCH and the patch alone', async () => {
    const api = stubApi(() => json({ profile: { ...PROFILE, displayName: 'New' } }))
    await expect(profileApi.save({ displayName: 'New' })).resolves.toEqual({ status: 'saved', profile: { ...PROFILE, displayName: 'New' } })
    expect(api.sent[0]).toMatchObject({ method: 'PATCH', url: '/api/studio/profile', body: { displayName: 'New' } })
  })

  it.each<[string, Response, unknown]>([
    ['409 handle_taken', json({ error: 'handle_taken' }, 409), { status: 'invalid', fields: ['handle'], handle: 'taken' }],
    ['409 handle_locked', json({ error: 'handle_locked' }, 409), { status: 'invalid', fields: ['handle'], handle: 'locked' }],
    ['422 named fields', json({ error: 'validation_failed', fields: ['bio', 'contactPhone'] }, 422), { status: 'invalid', fields: ['bio', 'contactPhone'] }],
    ['422 a list item', json({ error: 'validation_failed', fields: ['districts.3', 'districts.4'] }, 422), { status: 'invalid', fields: ['districts'] }],
    ['422 naming nothing it knows', json({ error: 'validation_failed', fields: ['nonsense'] }, 422), { status: 'failed' }],
    ['400', json({ error: 'invalid_request' }, 400), { status: 'unreadable' }],
    ['409 something else', json({ error: 'conflict' }, 409), { status: 'failed' }],
    ['500', json({ error: 'internal_error' }, 500), { status: 'failed' }],
    ['200 without a profile', json({}), { status: 'failed' }],
  ])('answers %s as a result', async (_label, response, expected) => {
    stubApi(() => response)
    await expect(profileApi.save({ displayName: 'x' })).resolves.toEqual(expected)
  })

  it('throws on a 401', async () => {
    stubApi(() => json({ error: 'invalid_token' }, 401))
    await expect(profileApi.save({ displayName: 'x' })).rejects.toBeInstanceOf(UnauthenticatedError)
  })

  it('throws a network failure as it is', async () => {
    stubApi(() => Promise.reject(new TypeError('Failed to fetch')))
    await expect(profileApi.save({ displayName: 'x' })).rejects.toBeInstanceOf(TypeError)
  })
})
