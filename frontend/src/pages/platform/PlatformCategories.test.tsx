import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { saveSession } from '@/auth/session'
import type { PlatformCategory } from '@/platform/categories'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'

/**
 * `/platform/categories` (Phase 9, R9.2, decision 3): the list in the
 * platform's order with each category's state and count; create (slug checked
 * before sending), rename (slug read-only), deactivate (confirmed when in use,
 * saying photographers keep the tag) and reactivate, delete only while unused
 * (a 409 race offers to deactivate), and Move up / Move down saved at once.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

function category(id: string, slug: string, nameEn: string, overrides: Partial<PlatformCategory> = {}): PlatformCategory {
  return { id, slug, nameEn, isActive: true, sortOrder: 0, photographerCount: 0, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...overrides }
}

const PORTRAIT = category('c1', 'portrait', 'Portrait', { photographerCount: 4, sortOrder: 0 })
const WEDDING = category('c2', 'wedding', 'Wedding', { photographerCount: 3, sortOrder: 1 })
const DRONE = category('c3', 'drone', 'Drone', { sortOrder: 2 })
const EVENTS = category('c4', 'events', 'Events', { isActive: false, photographerCount: 1, sortOrder: 3 })

type Store = { list: PlatformCategory[] }

/** The API over a list, behaving like the real one unless `override` answers first. */
function api(initial: PlatformCategory[] = [PORTRAIT, WEDDING, DRONE, EVENTS], override?: (call: Sent, store: Store) => Response | undefined) {
  const store: Store = { list: initial.map((each) => ({ ...each })) }
  const calls = stubApi((call) => {
    const answered = override?.(call, store)
    if (answered !== undefined) return answered
    const url = new URL(call.url, 'http://test')
    if (call.method === 'GET' && url.pathname === '/api/platform/categories') return json({ categories: store.list })
    if (call.method === 'POST' && url.pathname === '/api/platform/categories') {
      const body = call.body as { slug: string; nameEn: string }
      if (store.list.some((each) => each.slug === body.slug)) return json({ error: 'slug_taken' }, 409)
      const created = category(`c${store.list.length + 10}`, body.slug, body.nameEn, { sortOrder: store.list.length })
      store.list = [...store.list, created]
      return json({ category: created }, 201)
    }
    if (call.method === 'PUT' && url.pathname === '/api/platform/categories/order') {
      const ids = (call.body as { ids: string[] }).ids
      if (ids.length !== store.list.length) return json({ error: 'validation_failed', fields: ['ids'] }, 422)
      store.list = ids.map((id, index) => ({ ...(store.list.find((each) => each.id === id) as PlatformCategory), sortOrder: index }))
      return json({ categories: store.list })
    }
    const one = /^\/api\/platform\/categories\/([^/]+)$/.exec(url.pathname)
    if (one !== null) {
      const found = store.list.find((each) => each.id === one[1])
      if (found === undefined) return json({ error: 'not_found' }, 404)
      if (call.method === 'PATCH') {
        const next = { ...found, ...(call.body as Partial<PlatformCategory>) }
        store.list = store.list.map((each) => (each.id === found.id ? next : each))
        return json({ category: next })
      }
      if (call.method === 'DELETE') {
        if (found.photographerCount > 0) return json({ error: 'category_in_use', photographerCount: found.photographerCount }, 409)
        store.list = store.list.filter((each) => each.id !== found.id)
        return new Response(null, { status: 204 })
      }
    }
    return undefined
  })
  return { ...calls, store }
}

function renderPage() {
  const router = createMemoryRouter(routes, { initialEntries: ['/platform/categories'] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

async function list() {
  return within(await screen.findByRole('list', { name: 'Categories' }))
}

function row(slug: string) {
  const li = document.querySelector(`[data-category="${slug}"]`)
  if (!(li instanceof HTMLElement)) throw new Error(`no row ${slug}`)
  return within(li)
}

function order() {
  return [...document.querySelectorAll('[data-category]')].map((li) => li.getAttribute('data-category'))
}

function writes(calls: ReturnType<typeof api>) {
  return calls.sent.filter((call) => call.method !== 'GET').map((call) => [call.method, call.url, call.body])
}

beforeEach(() => saveSession('platform', SESSION))
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  delete document.documentElement.dataset.adminTheme
})

describe('the list', () => {
  it('loads, then shows each category with its slug, count and state, in order', async () => {
    const calls = api()
    renderPage()
    expect(screen.getByText('Loading the categories…')).toBeInTheDocument()
    await list()
    expect(order()).toEqual(['portrait', 'wedding', 'drone', 'events'])
    expect(screen.getByText('4 categories')).toBeInTheDocument()
    expect(row('wedding').getByText('3 photographers')).toBeInTheDocument()
    expect(row('drone').getByText('No photographers')).toBeInTheDocument()
    expect(row('events').getByText('1 photographer')).toBeInTheDocument()
    expect(row('portrait').getByText('Active')).toBeInTheDocument()
    expect(row('events').getByText('Inactive')).toBeInTheDocument()
    expect(row('events').getByRole('button', { name: 'Reactivate Events' })).toBeInTheDocument()
    expect(calls.sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
  })

  it('offers Delete only for a category nobody has', async () => {
    api()
    renderPage()
    await list()
    expect(row('drone').getByRole('button', { name: 'Delete Drone' })).toBeInTheDocument()
    for (const slug of ['portrait', 'wedding', 'events']) expect(row(slug).queryByRole('button', { name: /^Delete/ })).toBeNull()
  })

  it('disables Move up at the top and Move down at the bottom', async () => {
    api()
    renderPage()
    await list()
    expect(row('portrait').getByRole('button', { name: 'Move Portrait up' })).toBeDisabled()
    expect(row('portrait').getByRole('button', { name: 'Move Portrait down' })).toBeEnabled()
    expect(row('events').getByRole('button', { name: 'Move Events down' })).toBeDisabled()
  })

  it('says when there are none', async () => {
    api([])
    renderPage()
    expect(await screen.findByText('No categories yet. Create the first one.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New category' })).toBeInTheDocument()
  })

  it('a failure offers a retry', async () => {
    let first = true
    api(undefined, (call) => {
      if (call.method === 'GET' && first) {
        first = false
        return json({ error: 'internal' }, 500)
      }
      return undefined
    })
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the categories.')
    await user().click(screen.getByRole('button', { name: 'Try again' }))
    await list()
  })

  it('renders a name as text, never markup', async () => {
    api([category('x', 'x', '<img src=x onerror=alert(1)>')])
    renderPage()
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('main img')).toBeNull()
  })
})

describe('creating', () => {
  it('suggests the slug from the name, checks it, and appends the new category', async () => {
    const calls = api()
    renderPage()
    await list()
    const u = user()
    await u.click(screen.getByRole('button', { name: 'New category' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New category' }))
    await u.type(dialog.getByRole('textbox', { name: 'Name' }), 'Real estate')
    expect(dialog.getByRole('textbox', { name: 'Slug' })).toHaveValue('real-estate')
    await u.click(dialog.getByRole('button', { name: 'Create category' }))

    expect(await screen.findByText('Real estate is created.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(order()).toEqual(['portrait', 'wedding', 'drone', 'events', 'real-estate'])
    expect(writes(calls)).toEqual([['POST', '/api/platform/categories', { slug: 'real-estate', nameEn: 'Real estate' }]])
  })

  it('stops following the name once the slug is typed by hand', async () => {
    api()
    renderPage()
    await list()
    const u = user()
    await u.click(screen.getByRole('button', { name: 'New category' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New category' }))
    await u.type(dialog.getByRole('textbox', { name: 'Slug' }), 'homes')
    await u.type(dialog.getByRole('textbox', { name: 'Name' }), 'Real estate')
    expect(dialog.getByRole('textbox', { name: 'Slug' })).toHaveValue('homes')
  })

  it.each([
    ['', 'Wedding Two', 'Enter a slug.'],
    ['Wedding Two', 'Wedding Two', 'Use lowercase letters and numbers, with single hyphens between words, such as real-estate.'],
    ['two--words', 'Two words', 'Use lowercase letters and numbers, with single hyphens between words, such as real-estate.'],
    ['a'.repeat(65), 'Long', 'Keep the slug to 64 characters or fewer.'],
  ])('refuses the slug %j before sending', async (slug, name, error) => {
    const calls = api()
    renderPage()
    await list()
    const u = user()
    await u.click(screen.getByRole('button', { name: 'New category' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New category' }))
    await u.type(dialog.getByRole('textbox', { name: 'Name' }), name)
    await u.clear(dialog.getByRole('textbox', { name: 'Slug' }))
    if (slug !== '') await u.type(dialog.getByRole('textbox', { name: 'Slug' }), slug)
    await u.click(dialog.getByRole('button', { name: 'Create category' }))
    expect(dialog.getByText(error)).toBeInTheDocument()
    expect(dialog.getByRole('textbox', { name: 'Slug' })).toHaveAttribute('aria-invalid', 'true')
    expect(writes(calls)).toEqual([])
  })

  it('refuses a blank or long name before sending', async () => {
    const calls = api()
    renderPage()
    await list()
    const u = user()
    await u.click(screen.getByRole('button', { name: 'New category' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New category' }))
    await u.type(dialog.getByRole('textbox', { name: 'Slug' }), 'ok')
    await u.click(dialog.getByRole('button', { name: 'Create category' }))
    expect(dialog.getByText('Enter a name, up to 80 characters.')).toBeInTheDocument()
    await u.type(dialog.getByRole('textbox', { name: 'Name' }), 'x'.repeat(81))
    await u.click(dialog.getByRole('button', { name: 'Create category' }))
    expect(dialog.getByText('Keep the name to 80 characters or fewer.')).toBeInTheDocument()
    expect(writes(calls)).toEqual([])
  })

  it('a slug taken by another category keeps the dialog open and marks the slug', async () => {
    api()
    renderPage()
    await list()
    const u = user()
    await u.click(screen.getByRole('button', { name: 'New category' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New category' }))
    await u.type(dialog.getByRole('textbox', { name: 'Name' }), 'Events')
    await u.click(dialog.getByRole('button', { name: 'Create category' }))
    expect(await dialog.findByText('That slug is already used by another category, active or not.')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it.each([
    [json({ error: 'validation_failed', fields: ['nameEn'] }, 422), 'Keep the name to 80 characters or fewer.'],
    [json({ error: 'invalid_request' }, 400), 'Use lowercase letters and numbers, with single hyphens between words, such as real-estate.'],
    [json({ error: 'internal' }, 500), 'Could not save the change. Check your connection and try again.'],
  ])('a create refused %# shows the refusal in the dialog', async (response, words) => {
    api(undefined, (call) => (call.method === 'POST' ? response : undefined))
    renderPage()
    await list()
    const u = user()
    await u.click(screen.getByRole('button', { name: 'New category' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New category' }))
    await u.type(dialog.getByRole('textbox', { name: 'Name' }), 'Food')
    await u.click(dialog.getByRole('button', { name: 'Create category' }))
    expect(await dialog.findByText(words)).toBeInTheDocument()
  })
})

describe('renaming', () => {
  it('renames, with the slug shown read-only and why', async () => {
    const calls = api()
    renderPage()
    await list()
    const u = user()
    await u.click(row('wedding').getByRole('button', { name: 'Rename Wedding' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Rename Wedding' }))
    expect(dialog.getAllByRole('textbox')).toHaveLength(1)
    expect(dialog.getByText('wedding')).toBeInTheDocument()
    expect(dialog.getByText("The slug can't change: it's in every shared directory link.")).toBeInTheDocument()
    const name = dialog.getByRole('textbox', { name: 'Name' })
    expect(name).toHaveValue('Wedding')
    await u.clear(name)
    await u.type(name, 'Weddings')
    await u.click(dialog.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByText('Renamed to Weddings.')).toBeInTheDocument()
    expect(row('wedding').getByText('Weddings')).toBeInTheDocument()
    expect(writes(calls)).toEqual([['PATCH', '/api/platform/categories/c2', { nameEn: 'Weddings' }]])
  })

  it('a category gone meanwhile closes the dialog and reloads', async () => {
    const calls = api(undefined, (call, store) => {
      if (call.method === 'PATCH') {
        store.list = store.list.filter((each) => each.id !== 'c2')
        return json({ error: 'not_found' }, 404)
      }
      return undefined
    })
    renderPage()
    await list()
    const u = user()
    await u.click(row('wedding').getByRole('button', { name: 'Rename Wedding' }))
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save name' }))
    expect(await screen.findByText('That category no longer exists, so the list has been reloaded.')).toBeInTheDocument()
    await waitFor(() => expect(order()).toEqual(['portrait', 'drone', 'events']))
    expect(calls.sent.filter((call) => call.method === 'GET')).toHaveLength(2)
  })
})

describe('deactivating and reactivating', () => {
  it('confirms a category in use first, saying its photographers keep the tag', async () => {
    const calls = api()
    renderPage()
    await list()
    const u = user()
    await u.click(row('wedding').getByRole('button', { name: 'Deactivate Wedding' }))
    const dialog = screen.getByRole('dialog', { name: 'Deactivate Wedding?' })
    expect(dialog).toHaveAccessibleDescription(
      "It's hidden from the directory and from the studios' category picker. The 3 photographers who have it keep the tag, and reactivating it brings it back for them.",
    )
    expect(writes(calls)).toEqual([])
    await u.click(within(dialog).getByRole('button', { name: 'Deactivate' }))
    expect(await screen.findByText('Wedding is deactivated: hidden from the public, kept by the photographers who have it.')).toBeInTheDocument()
    expect(row('wedding').getByText('Inactive')).toBeInTheDocument()
    expect(row('wedding').getByText('3 photographers')).toBeInTheDocument()
    expect(writes(calls)).toEqual([['PATCH', '/api/platform/categories/c2', { isActive: false }]])
  })

  it('cancelling the confirmation sends nothing', async () => {
    const calls = api()
    renderPage()
    await list()
    const u = user()
    await u.click(row('wedding').getByRole('button', { name: 'Deactivate Wedding' }))
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(writes(calls)).toEqual([])
  })

  it('deactivates an unused one at once and reactivates at once, keeping focus on the button', async () => {
    const calls = api()
    renderPage()
    await list()
    const u = user()
    const button = row('drone').getByRole('button', { name: 'Deactivate Drone' })
    await u.click(button)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await row('drone').findByRole('button', { name: 'Reactivate Drone' })).toBe(button)
    expect(button).toHaveFocus()
    await u.click(row('events').getByRole('button', { name: 'Reactivate Events' }))
    expect(await screen.findByText('Events is active again.')).toBeInTheDocument()
    expect(writes(calls)).toEqual([
      ['PATCH', '/api/platform/categories/c3', { isActive: false }],
      ['PATCH', '/api/platform/categories/c4', { isActive: true }],
    ])
  })

  it('a failed toggle says so and leaves the row', async () => {
    api(undefined, (call) => (call.method === 'PATCH' ? json({ error: 'internal' }, 500) : undefined))
    renderPage()
    await list()
    await user().click(row('events').getByRole('button', { name: 'Reactivate Events' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the change.')
    expect(row('events').getByText('Inactive')).toBeInTheDocument()
  })
})

describe('deleting', () => {
  it('deletes an unused category after confirming, and focus goes to New category', async () => {
    const calls = api()
    renderPage()
    await list()
    const u = user()
    await u.click(row('drone').getByRole('button', { name: 'Delete Drone' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete Drone?' })
    expect(dialog).toHaveAccessibleDescription("It's removed for good. Nobody has it, so no studio changes.")
    await u.click(within(dialog).getByRole('button', { name: 'Delete category' }))
    expect(await screen.findByText('Drone is deleted.')).toBeInTheDocument()
    expect(order()).toEqual(['portrait', 'wedding', 'events'])
    expect(writes(calls)).toEqual([['DELETE', '/api/platform/categories/c3', undefined]])
    await waitFor(() => expect(screen.getByRole('button', { name: 'New category' })).toHaveFocus())
  })

  it('a 409 race says how many have it now, offers to deactivate instead, and the row loses Delete', async () => {
    const calls = api(undefined, (call) => (call.method === 'DELETE' ? json({ error: 'category_in_use', photographerCount: 2 }, 409) : undefined))
    renderPage()
    await list()
    const u = user()
    await u.click(row('drone').getByRole('button', { name: 'Delete Drone' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete Drone?' })
    await u.click(within(dialog).getByRole('button', { name: 'Delete category' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "2 photographers now have this category, so it can't be deleted. Deactivate it instead to hide it.",
    )
    expect(within(dialog).queryByText(/Nobody has it/)).toBeNull()
    expect(row('drone').queryByRole('button', { name: 'Delete Drone', hidden: true })).toBeNull()
    expect(row('drone').getByText('2 photographers', { selector: 'span' })).toBeInTheDocument()

    await u.click(within(dialog).getByRole('button', { name: 'Deactivate instead' }))
    expect(await screen.findByText('Drone is deactivated: hidden from the public, kept by the photographers who have it.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(writes(calls)).toEqual([
      ['DELETE', '/api/platform/categories/c3', undefined],
      ['PATCH', '/api/platform/categories/c3', { isActive: false }],
    ])
  })

  it('a failed delete stays in the dialog', async () => {
    api(undefined, (call) => (call.method === 'DELETE' ? json({ error: 'internal' }, 500) : undefined))
    renderPage()
    await list()
    const u = user()
    await u.click(row('drone').getByRole('button', { name: 'Delete Drone' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete Drone?' })
    await u.click(within(dialog).getByRole('button', { name: 'Delete category' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not save the change.')
    expect(order()).toContain('drone')
  })
})

describe('reordering', () => {
  it('moves one place, saves every id at once, keeps focus and announces the place', async () => {
    const calls = api()
    renderPage()
    await list()
    const u = user()
    await u.click(row('drone').getByRole('button', { name: 'Move Drone up' }))
    await waitFor(() => expect(screen.getByText('Drone moved to position 2 of 4.')).toBeInTheDocument())
    expect(order()).toEqual(['portrait', 'drone', 'wedding', 'events'])
    expect(row('drone').getByRole('button', { name: 'Move Drone up' })).toHaveFocus()
    expect(writes(calls)).toEqual([['PUT', '/api/platform/categories/order', { ids: ['c1', 'c3', 'c2', 'c4'] }]])
  })

  it('at the top, focus goes to the other button', async () => {
    api()
    renderPage()
    await list()
    await user().click(row('wedding').getByRole('button', { name: 'Move Wedding up' }))
    await waitFor(() => expect(screen.getByText('Wedding moved to position 1 of 4.')).toBeInTheDocument())
    expect(row('wedding').getByRole('button', { name: 'Move Wedding down' })).toHaveFocus()
  })

  it('a list changed elsewhere (422) reloads and says so', async () => {
    const calls = api(undefined, (call, store) => {
      if (call.method === 'PUT') {
        store.list = [...store.list, category('c9', 'food', 'Food')]
        return json({ error: 'validation_failed', fields: ['ids'] }, 422)
      }
      return undefined
    })
    renderPage()
    await list()
    await user().click(row('drone').getByRole('button', { name: 'Move Drone up' }))
    expect(await screen.findByText('The categories changed somewhere else, so the list has been reloaded. Check the order and try again.')).toBeInTheDocument()
    await waitFor(() => expect(order()).toEqual(['portrait', 'wedding', 'drone', 'events', 'food']))
    expect(calls.sent.filter((call) => call.method === 'GET')).toHaveLength(2)
  })

  it('any other failure puts the old order back', async () => {
    api(undefined, (call) => (call.method === 'PUT' ? json({ error: 'internal' }, 500) : undefined))
    renderPage()
    await list()
    await user().click(row('drone').getByRole('button', { name: 'Move Drone up' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the new order.')
    expect(order()).toEqual(['portrait', 'wedding', 'drone', 'events'])
  })
})
