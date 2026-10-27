import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { StudioProfile } from '@/admin/profile'
import { saveSession } from '@/admin/session'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'
import { CATEGORIES, PROFILE, PROVINCES } from '@/test/onboarding-fixtures'
import { STUDIO_ME_URL, studioMeBody } from '@/test/studio-me'

/**
 * `/studio/profile` (R7.2) through the real routes: the profile in the form,
 * the handle read-only once approved, the district search and both checkbox
 * groups, the cover preview and its broken state, only changed fields sent,
 * the checks that stand in for the API's unlabelled 400, and every refusal on
 * its field.
 */

const PROFILE_API = '/api/studio/profile'

type Options = {
  profile?: StudioProfile
  onPatch?: (call: Sent) => Response | Promise<Response>
  categories?: () => Response
}

function stubProfile({ profile = PROFILE, onPatch, categories }: Options = {}) {
  let stored = profile
  return stubApi((call) => {
    if (call.url === STUDIO_ME_URL) return json(studioMeBody('pending'))
    if (call.method === 'GET' && call.url === PROFILE_API) return json({ profile: stored })
    if (call.method === 'GET' && call.url === '/api/categories') return categories?.() ?? json({ categories: CATEGORIES })
    if (call.method === 'GET' && call.url === '/api/districts') return json({ provinces: PROVINCES })
    if (call.method === 'PATCH' && call.url === PROFILE_API) {
      if (onPatch !== undefined) return onPatch(call)
      const body = call.body as Record<string, unknown>
      const lookup = <T extends { code?: string; slug?: string }>(all: T[], keys: unknown) =>
        Array.isArray(keys) ? all.filter((each) => keys.includes(each.code ?? each.slug)) : undefined
      stored = {
        ...stored,
        ...(body as Partial<StudioProfile>),
        districts: lookup(PROVINCES.flatMap((p) => p.districts), body.districts) ?? stored.districts,
        categories: lookup(CATEGORIES, body.categories) ?? stored.categories,
      }
      return json({ profile: stored })
    }
    return undefined
  })
}

function renderPage(path = '/studio/profile') {
  saveSession({ token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' })
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

const user = () => userEvent.setup({ delay: null })
const field = (label: string) => screen.getByLabelText(label)
const patches = (api: ReturnType<typeof stubApi>) => api.sent.filter((call) => call.method === 'PATCH')
const save = () => user().click(screen.getByRole('button', { name: 'Save profile' }))

async function loaded() {
  return screen.findByRole('form', { name: 'Profile' })
}

async function retype(label: string, value: string) {
  await user().clear(field(label))
  if (value !== '') await user().type(field(label), value)
}

afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('the profile form', () => {
  it('shows the stored profile', async () => {
    const api = stubProfile()
    renderPage()
    await loaded()

    expect(field('Handle')).toHaveValue('kigali-lens')
    expect(field('Handle')).not.toHaveAttribute('readonly')
    expect(screen.getByText('Your profile address: /p/kigali-lens')).toBeInTheDocument()
    expect(field('Display name')).toHaveValue('Kigali Lens')
    expect(field('Bio')).toHaveValue('Portraits in natural light.')
    expect(field('Phone')).toHaveValue('+250781234567')
    expect(field('WhatsApp')).toHaveValue('')
    expect(field('Contact email')).toHaveValue('')
    expect(field('Cover image link')).toHaveValue('https://images.example/cover.jpg')
    expect(screen.getByRole('checkbox', { name: 'Gasabo' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Kicukiro' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Portrait' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Wedding' })).not.toBeChecked()
    expect(api.sent.find((call) => call.url === PROFILE_API)?.headers.get('Authorization')).toBe('Bearer studio.jwt')
  })

  it('groups the districts by province, each a named group', async () => {
    stubProfile()
    renderPage()
    await loaded()

    const kigali = screen.getByRole('group', { name: 'Kigali City' })
    expect(within(kigali).getAllByRole('checkbox').map((box) => box.getAttribute('value'))).toEqual(['gasabo', 'kicukiro', 'nyarugenge'])
    expect(within(screen.getByRole('group', { name: 'Western Province' })).getAllByRole('checkbox')).toHaveLength(2)
  })

  it('narrows the districts as he searches, keeps a hidden ticked one ticked, and says when nothing matches', async () => {
    const api = stubProfile()
    renderPage()
    await loaded()

    await user().click(screen.getByRole('checkbox', { name: 'Rubavu' }))
    await user().type(field('Find a district'), 'KICU')
    expect(screen.getByRole('checkbox', { name: 'Kicukiro' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Rubavu' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Western Province' })).not.toBeInTheDocument()

    await user().clear(field('Find a district'))
    await user().type(field('Find a district'), 'zzz')
    expect(screen.getByText('No district matches “zzz”.')).toBeInTheDocument()

    // Enter in the search box does not submit the form.
    await user().type(field('Find a district'), '{Enter}')
    expect(patches(api)).toHaveLength(0)

    await save()
    await waitFor(() => expect(patches(api)).toHaveLength(1))
    expect(patches(api)[0]?.body).toEqual({ districts: ['gasabo', 'rubavu'] })
  })

  it('counts the ticked districts and categories', async () => {
    stubProfile()
    renderPage()
    await loaded()

    const districts = document.getElementById('districts') as HTMLElement
    expect(within(districts).getByText('1 selected')).toBeInTheDocument()
    await user().click(screen.getByRole('checkbox', { name: 'Kicukiro' }))
    expect(within(districts).getByText('2 selected')).toBeInTheDocument()
  })

  it('sends only what changed, trimmed, and clears an emptied field with null', async () => {
    const api = stubProfile()
    renderPage()
    await loaded()

    await retype('Display name', '  Kigali Lens Studio ')
    await retype('Phone', '')
    await user().click(screen.getByRole('checkbox', { name: 'Wedding' }))
    await save()

    expect(await screen.findByRole('status')).toHaveTextContent('Your profile is saved.')
    expect(patches(api)).toHaveLength(1)
    expect(patches(api)[0]?.body).toEqual({ displayName: 'Kigali Lens Studio', contactPhone: null, categories: ['portrait', 'wedding'] })
  })

  it('redraws the form from what the API stored', async () => {
    stubProfile({ onPatch: () => json({ profile: { ...PROFILE, whatsappPhone: '+250781234567', handle: 'new-handle' } }) })
    renderPage()
    await loaded()

    await user().type(field('WhatsApp'), '078 123 4567')
    await retype('Handle', 'New-Handle')
    await save()

    await waitFor(() => expect(field('WhatsApp')).toHaveValue('+250781234567'))
    expect(field('Handle')).toHaveValue('new-handle')
  })

  it('sends nothing and says so when nothing changed', async () => {
    const api = stubProfile()
    renderPage()
    await loaded()

    await retype('Display name', 'Kigali Lens  ')
    await save()

    expect(await screen.findByRole('status')).toHaveTextContent('Nothing has changed since the last save.')
    expect(patches(api)).toHaveLength(0)
  })

  it('while submitted and pending, says under the handle that changing it notifies the platform team', async () => {
    stubProfile({ profile: { ...PROFILE, submittedAt: '2026-10-20T07:00:00.000Z' } })
    renderPage()
    await loaded()

    expect(field('Handle')).not.toHaveAttribute('readonly')
    expect(field('Handle')).toHaveAccessibleDescription(expect.stringContaining('If you change your handle now, the platform team is told the old and the new one.'))
  })

  it.each<[string, Partial<StudioProfile>]>([
    ['still setting up', {}],
    ['approved', { handleEditable: false, status: 'approved', submittedAt: '2026-10-20T07:00:00.000Z' }],
    ['suspended before approval', { status: 'suspended', submittedAt: '2026-10-20T07:00:00.000Z' }],
  ])('says nothing of notifying the platform while %s', async (_label, changes) => {
    stubProfile({ profile: { ...PROFILE, ...changes } })
    renderPage()
    await loaded()

    expect(screen.queryByText(/the platform team is told/)).not.toBeInTheDocument()
  })

  it('shows a fixed handle read-only with the reason, and never sends it', async () => {
    const api = stubProfile({ profile: { ...PROFILE, handleEditable: false, status: 'approved' } })
    renderPage()
    await loaded()

    expect(field('Handle')).toHaveAttribute('readonly')
    expect(field('Handle')).toHaveAccessibleDescription(expect.stringContaining('Your handle is fixed now that your studio has been approved'))
    await user().type(field('Handle'), 'x')
    expect(field('Handle')).toHaveValue('kigali-lens')

    await retype('Bio', 'New bio.')
    await save()
    await waitFor(() => expect(patches(api)).toHaveLength(1))
    expect(patches(api)[0]?.body).toEqual({ bio: 'New bio.' })
  })

  it.each<[string, string, string, string]>([
    ['Handle', 'ab', 'Handle', 'Use 3 to 30 lowercase letters, numbers and hyphens'],
    ['Display name', '', 'Display name', 'Enter a name of 1 to 80 characters.'],
    ['Phone', 'call me', 'Phone', 'Enter a phone number'],
    ['Contact email', 'not-an-address', 'Contact email', 'Enter a valid email address.'],
    ['Cover image link', 'http://images.example/a.jpg', 'Cover image link', 'Enter a link starting with https://'],
  ])('refuses %s %j before sending, on the field, which takes focus', async (label, value, invalidLabel, message) => {
    const api = stubProfile()
    renderPage()
    await loaded()

    await retype(label, value)
    await save()

    await waitFor(() => expect(field(invalidLabel)).toHaveAttribute('aria-invalid', 'true'))
    expect(field(invalidLabel)).toHaveAccessibleDescription(expect.stringContaining(message))
    expect(field(invalidLabel)).toHaveFocus()
    expect(patches(api)).toHaveLength(0)
  })

  it('refuses a bio over 2,000 characters before sending', async () => {
    const api = stubProfile()
    renderPage()
    await loaded()

    fireEvent.change(field('Bio'), { target: { value: 'x'.repeat(2001) } })
    await save()

    await waitFor(() => expect(field('Bio')).toHaveAttribute('aria-invalid', 'true'))
    expect(patches(api)).toHaveLength(0)
  })

  it('puts a taken handle on the handle', async () => {
    stubProfile({ onPatch: () => json({ error: 'handle_taken' }, 409) })
    renderPage()
    await loaded()

    await retype('Handle', 'lake-kivu')
    await save()

    await waitFor(() => expect(field('Handle')).toHaveAttribute('aria-invalid', 'true'))
    expect(field('Handle')).toHaveAccessibleDescription(expect.stringContaining('That handle is unavailable. Try another.'))
  })

  it('on handle_locked (approved meanwhile) puts the handle back, makes it read-only and says why', async () => {
    const api = stubProfile({ onPatch: () => json({ error: 'handle_locked' }, 409) })
    renderPage()
    await loaded()

    await retype('Handle', 'other-name')
    await save()

    expect(await screen.findByRole('alert')).toHaveTextContent("Your handle can't change now that your studio has been approved.")
    expect(field('Handle')).toHaveValue('kigali-lens')
    expect(field('Handle')).toHaveAttribute('readonly')
    expect(patches(api)).toHaveLength(1)
  })

  it('puts each field a 422 names on that field, a list item on its list', async () => {
    stubProfile({ onPatch: () => json({ error: 'validation_failed', fields: ['whatsappPhone', 'districts.1', 'categories'] }, 422) })
    renderPage()
    await loaded()

    await user().type(field('WhatsApp'), '+999 1')
    await user().click(screen.getByRole('checkbox', { name: 'Kicukiro' }))
    await save()

    await waitFor(() => expect(field('WhatsApp')).toHaveAttribute('aria-invalid', 'true'))
    expect(within(document.getElementById('districts') as HTMLElement).getByText('Choose districts from the list.')).toBeInTheDocument()
    expect(within(document.getElementById('categories') as HTMLElement).getByText('Choose categories from the list.')).toBeInTheDocument()
  })

  it.each<[string, () => Response | Promise<Response>, string]>([
    ['a 400', () => json({ error: 'invalid_request' }, 400), 'Some details were not accepted. Check the form and try again.'],
    ['a 500', () => json({ error: 'internal_error' }, 500), 'Could not save your profile. Check your connection and try again.'],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch')), 'Could not save your profile. Check your connection and try again.'],
  ])('says so on %s, keeping what he typed', async (_label, respond, words) => {
    stubProfile({ onPatch: respond })
    renderPage()
    await loaded()

    await retype('Display name', 'New name')
    await save()

    expect(await screen.findByRole('alert')).toHaveTextContent(words)
    expect(field('Display name')).toHaveValue('New name')
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled()
  })
})

describe('the cover preview', () => {
  it('draws the stored cover with no referrer', async () => {
    stubProfile()
    renderPage()
    await loaded()

    const image = screen.getByRole('img', { name: 'Cover preview' })
    expect(image).toHaveAttribute('src', 'https://images.example/cover.jpg')
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer')
  })

  it('follows a new link once typing pauses, and shows nothing for a link that is not https', async () => {
    stubProfile()
    renderPage()
    await loaded()

    await retype('Cover image link', 'https://images.example/new.jpg')
    await waitFor(() => expect(screen.getByRole('img', { name: 'Cover preview' })).toHaveAttribute('src', 'https://images.example/new.jpg'))

    await retype('Cover image link', 'http://images.example/new.jpg')
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Cover preview' })).not.toBeInTheDocument())
  })

  it('says an image that will not load could not be loaded, and tries a new link again', async () => {
    stubProfile()
    renderPage()
    await loaded()

    fireEvent.error(screen.getByRole('img', { name: 'Cover preview' }))
    expect(screen.getByText('This image could not be loaded. Check that the link opens the image itself.')).toBeInTheDocument()

    await retype('Cover image link', 'https://images.example/other.jpg')
    await waitFor(() => expect(screen.getByRole('img', { name: 'Cover preview' })).toHaveAttribute('src', 'https://images.example/other.jpg'))
  })

  it('draws no preview for a profile with no cover', async () => {
    stubProfile({ profile: { ...PROFILE, coverImageUrl: null } })
    renderPage()
    await loaded()
    expect(screen.queryByRole('img', { name: 'Cover preview' })).not.toBeInTheDocument()
  })
})

describe('loading', () => {
  it('says it is loading, then a failure with Try again when a list fails, which asks again', async () => {
    let fail = true
    stubProfile({ categories: () => (fail ? json({ error: 'internal_error' }, 500) : json({ categories: CATEGORIES })) })
    renderPage()

    expect(screen.getByText('Loading your profile…')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your profile.')

    fail = false
    await user().click(screen.getByRole('button', { name: 'Try again' }))
    await loaded()
  })

  it('says when there are no categories to choose', async () => {
    stubProfile({ categories: () => json({ categories: [] }) })
    renderPage()
    await loaded()
    expect(screen.getByText('No categories are available yet.')).toBeInTheDocument()
  })

  it.each(['districts', 'categories'])('brings #%s into focus, as the setup checklist links it', async (id) => {
    stubProfile()
    renderPage(`/studio/profile#${id}`)
    await loaded()
    await waitFor(() => expect(document.getElementById(id)).toHaveFocus())
  })

  it('marks Profile current in the nav and names the breadcrumb', async () => {
    stubProfile()
    renderPage()
    await loaded()
    expect(within(screen.getByRole('navigation', { name: 'Studio' })).getByRole('link', { name: 'Profile' })).toHaveAttribute('aria-current', 'page')
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('listitem')
    expect(crumbs.map((item) => item.textContent)).toEqual(['Studio', 'Profile'])
  })
})
