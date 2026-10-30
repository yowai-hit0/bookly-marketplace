import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { saveSession } from '@/auth/session'
import type { AuditEntry } from '@/platform/audit'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'

/**
 * `/platform/activity` (Phase 9, R9.4): the audit trail, read-only, newest
 * first, 50 a page, its view in the URL. Each entry is one sentence with who
 * and when (Kigali), and a link to the photographer; the action filter is
 * grouped by area; a photographer filter says whose it is and clears.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }
const LENS_ID = '0b7d6f4e-1c2a-4e3b-9a8f-5d6c7b8a9e0f'
const LENS = { id: LENS_ID, handle: 'kigali-lens', displayName: 'Kigali Lens' }

function entry(id: string, action: string, details: Record<string, unknown>, photographer: AuditEntry['photographer'] = LENS): AuditEntry {
  return {
    id,
    action,
    actor: { id: 'u1', email: 'admin@bookly.example' },
    target: { type: 'photographer', id: photographer?.id ?? null },
    photographer,
    details,
    createdAt: '2026-10-27T08:00:00.000Z',
  }
}

const ENTRIES = [
  entry('a1', 'payout_paid', { amountRwf: 45_000, itemCount: 3, transferReference: 'TX-123' }),
  entry('a2', 'settings_updated', { changed: { subscriptionMonthlyPriceRwf: { before: 10_000, after: 12_000 } } }, null),
  entry('a3', 'photographer_suspended', { status: 'suspended', reason: 'Fake portfolio.' }),
  entry('a4', 'category_reordered', { before: ['x'], after: ['x'] }, null),
]

type Page = { entries: unknown[]; total: number; page: number; pageSize: number; pageCount: number }

function page(entries: unknown[], overrides: Partial<Page> = {}): Page {
  return { entries, total: entries.length, page: 1, pageSize: 50, pageCount: entries.length === 0 ? 0 : 1, ...overrides }
}

function api(respond: (url: URL, call: Sent) => Response = () => json(page(ENTRIES))) {
  return stubApi((call) => {
    const url = new URL(call.url, 'http://test')
    if (call.method === 'GET' && url.pathname === '/api/platform/audit') return respond(url, call)
    return undefined
  })
}

function renderAt(path = '/platform/activity', state?: unknown) {
  const router = createMemoryRouter(routes, { initialEntries: [state === undefined ? path : { pathname: path.split('?')[0], search: path.includes('?') ? `?${path.split('?')[1]}` : '', state }] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

async function list() {
  return within(await screen.findByRole('list', { name: 'Activity' }))
}

function audits(calls: ReturnType<typeof api>) {
  return calls.sent.filter((call) => call.url.startsWith('/api/platform/audit')).map((call) => call.url)
}

beforeEach(() => saveSession('platform', SESSION))
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  delete document.documentElement.dataset.adminTheme
})

describe('the activity page', () => {
  it('loads, then lists each entry as a sentence with who, when and whose', async () => {
    const calls = api()
    renderAt()
    expect(screen.getByText('Loading the activity…')).toBeInTheDocument()
    const entries = await list()
    expect(entries.getAllByRole('listitem', { name: undefined }).filter((li) => li.hasAttribute('data-audit-entry'))).toHaveLength(4)
    expect(entries.getByText('Marked a 45,000 RWF payout to Kigali Lens paid (ref TX-123)')).toBeInTheDocument()
    expect(entries.getByText('Changed the monthly price from 10,000 to 12,000 RWF')).toBeInTheDocument()
    expect(entries.getByText('Suspended Kigali Lens')).toBeInTheDocument()
    expect(entries.getByText('Reason: Fake portfolio.')).toBeInTheDocument()
    expect(entries.getByText('Reordered the categories')).toBeInTheDocument()
    expect(entries.getAllByText('By admin@bookly.example')).toHaveLength(4)
    expect(entries.getAllByText('27 Oct 2026, 10:00')).toHaveLength(4)
    const links = entries.getAllByRole('link', { name: 'Kigali Lens' })
    expect(links).toHaveLength(2)
    expect(links[0]).toHaveAttribute('href', `/platform/photographers/${LENS_ID}`)
    expect(screen.getByText('4 entries')).toBeInTheDocument()
    expect(audits(calls)).toEqual(['/api/platform/audit'])
    expect(calls.sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
  })

  it('renders user text as text, never markup', async () => {
    api(() => json(page([entry('x', 'photographer_suspended', { reason: '<img src=x onerror=alert(1)>' }, { ...LENS, displayName: '<b>Lens</b>' })])))
    renderAt()
    const entries = await list()
    expect(entries.getByText('Suspended <b>Lens</b>')).toBeInTheDocument()
    expect(document.querySelector('main b, main img')).toBeNull()
  })

  it('filters by action, grouped by area, back to page 1 and in the URL', async () => {
    const calls = api()
    const router = renderAt('/platform/activity?page=2')
    await list()
    const select = screen.getByRole('combobox', { name: 'Action' })
    const groups = within(select).getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('label'))).toEqual(['Photographers', 'Payouts and refunds', 'Settings', 'Categories'])
    expect(within(groups[1] as HTMLElement).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Payout created',
      'Payout marked paid',
      'Payout cancelled',
      'Refund recorded',
    ])

    await user().selectOptions(select, 'payout_paid')
    expect(router.state.location.search).toBe('?action=payout_paid')
    await waitFor(() => expect(audits(calls)).toEqual(['/api/platform/audit?page=2', '/api/platform/audit?action=payout_paid']))

    await user().selectOptions(screen.getByRole('combobox', { name: 'Action' }), 'all')
    expect(router.state.location.search).toBe('')
  })

  it('arrives filtered to a photographer by name from the detail page, and clears', async () => {
    const calls = api(() => json(page([])))
    const router = renderAt(`/platform/activity?photographerId=${LENS_ID}`, { photographerId: LENS_ID, photographerName: 'Kigali Lens' })
    expect(await screen.findByText('Filtered to Kigali Lens')).toBeInTheDocument()
    expect(await screen.findByText('No entries match this filter.')).toBeInTheDocument()
    expect(audits(calls)).toEqual([`/api/platform/audit?photographerId=${LENS_ID}`])

    await user().click(screen.getByRole('button', { name: 'Clear the photographer filter' }))
    expect(router.state.location.search).toBe('')
    expect(screen.queryByText(/Filtered to/)).toBeNull()
  })

  it('names the photographer from the entries when no name came along, else says "one photographer"', async () => {
    api(() => json(page([ENTRIES[0]])))
    const { unmount } = render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [`/platform/activity?photographerId=${LENS_ID}`] })} />)
    expect(await screen.findByText('Filtered to Kigali Lens')).toBeInTheDocument()
    unmount()

    api(() => json(page([])))
    renderAt(`/platform/activity?photographerId=${LENS_ID}`, { photographerId: 'someone-else', photographerName: 'Not them' })
    expect(await screen.findByText('Filtered to one photographer')).toBeInTheDocument()
  })

  it('drops a filter the API would refuse instead of asking with it', async () => {
    const calls = api()
    renderAt('/platform/activity?action=nope&photographerId=p1&page=0')
    await list()
    expect(audits(calls)).toEqual(['/api/platform/audit'])
    expect(screen.getByRole('combobox', { name: 'Action' })).toHaveValue('all')
    expect(screen.queryByText(/Filtered to/)).toBeNull()
  })

  it('pages with Previous and Next, keeping the filter', async () => {
    const calls = api((url) => {
      const number = Number(url.searchParams.get('page') ?? '1')
      return json(page([entry(`p${number}`, 'category_reordered', {}, null)], { total: 120, page: number, pageCount: 3 }))
    })
    const router = renderAt('/platform/activity?action=category_reordered')
    await list()
    const pages = within(screen.getByRole('navigation', { name: 'Pages' }))
    expect(pages.getByText('Page 1 of 3')).toBeInTheDocument()
    expect(pages.queryByRole('link', { name: 'Previous' })).toBeNull()
    expect(pages.getByText('Previous').closest('[aria-disabled="true"]')).not.toBeNull()

    await user().click(pages.getByRole('link', { name: 'Next' }))
    expect(router.state.location.search).toBe('?action=category_reordered&page=2')
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute('href', '/platform/activity?action=category_reordered')

    await user().click(screen.getByRole('link', { name: 'Next' }))
    expect(await screen.findByText('Page 3 of 3')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull()
    expect(audits(calls)).toEqual([
      '/api/platform/audit?action=category_reordered',
      '/api/platform/audit?action=category_reordered&page=2',
      '/api/platform/audit?action=category_reordered&page=3',
    ])
  })

  it('shows no pager for one page', async () => {
    api()
    renderAt()
    await list()
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull()
  })

  it.each([
    ['', 'Nothing recorded yet.'],
    ['?action=category_deleted', 'No entries match this filter.'],
  ])('an empty trail at %j says %j', async (search, words) => {
    api(() => json(page([])))
    renderAt(`/platform/activity${search}`)
    expect(await screen.findByText(words)).toBeInTheDocument()
    expect(screen.getByText('0 entries')).toBeInTheDocument()
  })

  it('a page past the end says so and links to the first page', async () => {
    api(() => json(page([], { total: 3, page: 9, pageCount: 1 })))
    renderAt('/platform/activity?page=9')
    expect(await screen.findByText('This page is past the end of the list.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute('href', '/platform/activity')
  })

  it.each([400, 422])('a %i says the filter cannot be used, with a way back', async (status) => {
    api(() => json({ error: 'invalid_request' }, status))
    renderAt('/platform/activity?action=payout_paid')
    expect(await screen.findByRole('alert')).toHaveTextContent("That filter can't be used.")
    expect(screen.getByRole('link', { name: 'Show all activity' })).toHaveAttribute('href', '/platform/activity')
  })

  it('a failure offers a retry', async () => {
    let calls = 0
    api(() => {
      calls += 1
      return calls === 1 ? json({ error: 'internal' }, 500) : json(page(ENTRIES))
    })
    renderAt()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the activity.')
    await user().click(screen.getByRole('button', { name: 'Try again' }))
    await list()
  })

  it('an entry it cannot read is left out, and an unknown action still reads as words', async () => {
    api(() => json(page([{ broken: true }, entry('n1', 'booking_cancelled', { anything: 1 })])))
    renderAt()
    const entries = await list()
    expect(entries.getByText('Recorded “booking_cancelled”')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-audit-entry]')).toHaveLength(1)
  })

  it('a 401 leaves the platform for its sign in', async () => {
    api(() => json({ error: 'unauthenticated' }, 401))
    const router = renderAt()
    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
  })
})
