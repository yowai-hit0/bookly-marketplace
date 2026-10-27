import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { readSession, saveSession } from '@/auth/session'
import type { PlatformPhotographer } from '@/platform/photographers'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'

/**
 * `/platform/photographers` (Phase 2 brief decision 7): the table, filtered by
 * status, and approve, suspend (with a reason) and reactivate, each confirmed
 * first. The row shows what the API answered. Phase 7: the review views
 * (`?review=awaiting`, `?review=setting_up`), the submitted date, and approval
 * held back until a pending studio has submitted.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

function photographer(overrides: Partial<PlatformPhotographer> = {}): PlatformPhotographer {
  return {
    id: 'p1',
    handle: 'kigali-lens',
    displayName: 'Kigali Lens',
    email: 'lens@kigali.example',
    status: 'pending',
    createdAt: '2026-10-15T09:00:00.000Z',
    approvedAt: null,
    approvedByUserId: null,
    suspendedAt: null,
    suspensionReason: null,
    submittedAt: '2026-10-16T08:00:00.000Z',
    handleChangedAt: null,
    ...overrides,
  }
}

const PENDING = photographer()
const APPROVED = photographer({ id: 'p2', handle: 'nyamirambo-studio', displayName: 'Nyamirambo Studio', email: 'hi@nyamirambo.example', status: 'approved', approvedAt: '2026-10-16T09:00:00.000Z' })
const SUSPENDED = photographer({ id: 'p3', handle: 'gisozi-pix', displayName: 'Gisozi Pix', email: 'pix@gisozi.example', status: 'suspended', suspensionReason: 'Fake portfolio.' })
const ALL = [PENDING, APPROVED, SUSPENDED]

/** The platform API over `list`; `onPost` answers a moderation, by default as the API would. */
function platformApi(onPost?: (call: Sent) => Response | Promise<Response>, list: PlatformPhotographer[] = ALL) {
  return stubApi((call) => {
    const url = new URL(call.url, 'http://test')
    if (call.method === 'GET' && url.pathname === '/api/platform/photographers') {
      const status = url.searchParams.get('status')
      const review = url.searchParams.get('review')
      return json({
        photographers: list.filter(
          (row) =>
            (status === null || row.status === status) &&
            (review === null ||
              (review === 'awaiting' && row.status === 'pending' && row.submittedAt !== null) ||
              (review === 'setting_up' && row.status === 'pending' && row.submittedAt === null)),
        ),
      })
    }
    const action = /^\/api\/platform\/photographers\/([^/]+)\/(approve|suspend|reactivate)$/.exec(url.pathname)
    if (call.method === 'POST' && action !== null) {
      if (onPost !== undefined) return onPost(call)
      const row = list.find((each) => each.id === action[1])
      if (row === undefined) return json({ error: 'not_found' }, 404)
      const next =
        action[2] === 'approve'
          ? { ...row, status: 'approved' as const, approvedAt: '2026-10-17T10:00:00.000Z' }
          : action[2] === 'suspend'
            ? { ...row, status: 'suspended' as const, suspensionReason: (call.body as { reason: string }).reason }
            : { ...row, status: 'approved' as const, suspensionReason: null }
      return json({ photographer: next })
    }
    return undefined
  })
}

function renderAt(path = '/platform/photographers') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

/** The rows whose first cell names `name` (the buttons repeat the name for assistive tech). */
function rowsNamed(name: string) {
  // `hidden`: while a modal dialog is open the page behind it is hidden from assistive tech.
  const table = screen.queryByRole('table', { hidden: true })
  if (table === null) return []
  return within(table)
    .getAllByRole('row', { hidden: true })
    .filter((tr) => within(tr).queryAllByRole('cell', { hidden: true })[0]?.textContent?.startsWith(name) === true)
}

function row(name: string) {
  const [tr] = rowsNamed(name)
  if (tr === undefined) throw new Error(`no row for ${name}`)
  return within(tr)
}

async function table() {
  return screen.findByRole('table', { name: 'Photographers' })
}

function posts(api: ReturnType<typeof platformApi>) {
  return api.sent.filter((call) => call.method === 'POST')
}

beforeEach(() => {
  saveSession('platform', SESSION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  delete document.documentElement.dataset.adminTheme
})

describe('the platform console shell', () => {
  it('sends a visitor with no platform session to the platform login, carrying the path', async () => {
    sessionStorage.clear()
    const api = platformApi()
    const router = renderAt('/platform/photographers?status=pending')

    expect(router.state.location.pathname).toBe('/platform/login')
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe('/platform/photographers?status=pending')
    expect(await screen.findByRole('heading', { level: 1, name: 'Platform sign in' })).toBeInTheDocument()
    expect(api.sent).toHaveLength(0)
  })

  it('does not open for a studio session', () => {
    sessionStorage.clear()
    saveSession('studio', SESSION)
    platformApi()
    const router = renderAt()

    expect(router.state.location.pathname).toBe('/platform/login')
  })

  it('opens /platform on the photographers', async () => {
    platformApi()
    const router = renderAt('/platform')

    await table()
    expect(router.state.location.pathname).toBe('/platform/photographers')
  })

  it('has a skip link, a Platform nav with its sections (Payouts and Refunds since Phase 4, Subscriptions and Settings since Phase 5), and sign out', async () => {
    platformApi()
    renderAt()
    await table()

    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#platform-content')
    const nav = screen.getByRole('navigation', { name: 'Platform' })
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Photographers', 'Subscriptions', 'Payouts', 'Refunds', 'Settings'])
    expect(within(nav).getByRole('link', { name: 'Photographers' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('signs out of the platform alone, to its login with no return path', async () => {
    saveSession('studio', SESSION)
    platformApi()
    const router = renderAt()
    await table()

    await user().click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(readSession('platform')).toBeNull())
    expect(router.state.location.pathname).toBe('/platform/login')
    expect(router.state.location.search).toBe('')
    expect(readSession('studio')).not.toBeNull()
  })

  it('sends him to sign in when the API refuses the token', async () => {
    stubApi(() => json({ error: 'invalid_token' }, 401))
    const router = renderAt()

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
    expect(readSession('platform')).toBeNull()
  })
})

describe('the photographers table', () => {
  it('lists every photographer with handle, email, status and application date, newest first as the API sent them', async () => {
    const api = platformApi()
    renderAt()
    await table()

    expect(api.sent[0]).toMatchObject({ method: 'GET', url: '/api/platform/photographers' })
    expect(api.sent[0]?.headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((tr) => within(tr).getAllByRole('cell')[0]?.textContent)).toEqual([
      'Kigali Lens/p/kigali-lens',
      'Nyamirambo Studio/p/nyamirambo-studio',
      'Gisozi Pix/p/gisozi-pix',
    ])
    expect(row('Kigali Lens').getByText('lens@kigali.example')).toBeInTheDocument()
    expect(row('Kigali Lens').getByText('Pending')).toBeInTheDocument()
    expect(row('Kigali Lens').getByText('Thursday, 15 October 2026')).toBeInTheDocument()
    expect(row('Gisozi Pix').getByText('Reason: Fake portfolio.')).toBeInTheDocument()
  })

  it('offers only the moves the API allows from each status', async () => {
    platformApi()
    renderAt()
    await table()

    const names = (name: string) => row(name).getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    expect(names('Kigali Lens')).toEqual(['Approve Kigali Lens', 'Suspend Kigali Lens'])
    expect(names('Nyamirambo Studio')).toEqual(['Suspend Nyamirambo Studio'])
    expect(names('Gisozi Pix')).toEqual(['Reactivate Gisozi Pix'])
  })

  it('filters by status through the URL and the API', async () => {
    const api = platformApi()
    const router = renderAt()
    await table()

    await user().selectOptions(screen.getByLabelText('Status'), 'pending')

    await waitFor(() => expect(router.state.location.search).toBe('?status=pending'))
    await waitFor(() => expect(rowsNamed('Nyamirambo Studio')).toHaveLength(0))
    expect(rowsNamed('Kigali Lens')).toHaveLength(1)
    expect(api.sent.at(-1)?.url).toBe('/api/platform/photographers?status=pending')

    await user().selectOptions(screen.getByLabelText('Status'), 'all')
    await waitFor(() => expect(router.state.location.search).toBe(''))
    await waitFor(() => expect(rowsNamed('Nyamirambo Studio')).toHaveLength(1))
  })

  it('reads the filter from the URL, and ignores one that is not a status', async () => {
    const api = platformApi()
    const { unmount } = render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/platform/photographers?status=suspended'] })} />)
    await table()
    expect(screen.getByLabelText('Status')).toHaveValue('suspended')
    expect(api.sent[0]?.url).toBe('/api/platform/photographers?status=suspended')
    unmount()

    renderAt('/platform/photographers?status=deleted')
    await table()
    expect(api.sent.at(-1)?.url).toBe('/api/platform/photographers')
  })

  it('says when a status has nobody, and when there is nobody at all', async () => {
    stubApi(() => json({ photographers: [] }))
    const { unmount } = render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/platform/photographers?status=suspended'] })} />)
    expect(await screen.findByText('No photographers with this status.')).toBeInTheDocument()
    unmount()

    renderAt()
    expect(await screen.findByText('No photographers yet.')).toBeInTheDocument()
  })

  it('says it is loading, then shows a failure with Try again, which asks again', async () => {
    let fail = true
    stubApi(({ method }) => (method === 'GET' ? (fail ? json({ error: 'internal_error' }, 500) : json({ photographers: ALL })) : undefined))
    renderAt()

    expect(screen.getByRole('status')).toHaveTextContent('Loading photographers…')
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the photographers.')

    fail = false
    await user().click(screen.getByRole('button', { name: 'Try again' }))
    await table()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('moderating', () => {
  it('approves after a confirmation, and shows the row as the API answered', async () => {
    const api = platformApi()
    renderAt()
    await table()

    await user().click(row('Kigali Lens').getByRole('button', { name: 'Approve Kigali Lens' }))
    const dialog = await screen.findByRole('dialog', { name: 'Approve Kigali Lens?' })
    expect(posts(api)).toHaveLength(0)

    await user().click(within(dialog).getByRole('button', { name: 'Approve' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Kigali Lens is approved.')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(posts(api)).toEqual([expect.objectContaining({ url: '/api/platform/photographers/p1/approve', body: undefined })])
    expect(posts(api)[0]?.headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
    expect(row('Kigali Lens').getByText('Approved')).toBeInTheDocument()
    expect(row('Kigali Lens').getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Suspend Kigali Lens'])
  })

  it('changes nothing when the confirmation is cancelled', async () => {
    const api = platformApi()
    renderAt()
    await table()

    await user().click(row('Kigali Lens').getByRole('button', { name: 'Approve Kigali Lens' }))
    await user().click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts(api)).toHaveLength(0)
    expect(row('Kigali Lens').getByText('Pending')).toBeInTheDocument()
  })

  it('asks for a reason to suspend, and sends it trimmed', async () => {
    const api = platformApi()
    renderAt()
    await table()

    await user().click(row('Nyamirambo Studio').getByRole('button', { name: 'Suspend Nyamirambo Studio' }))
    const dialog = await screen.findByRole('dialog', { name: 'Suspend Nyamirambo Studio?' })

    await user().click(within(dialog).getByRole('button', { name: 'Suspend' }))
    const reason = within(dialog).getByLabelText('Reason')
    expect(reason).toHaveAttribute('aria-invalid', 'true')
    expect(reason).toHaveAccessibleDescription(expect.stringContaining('Give a reason, up to 500 characters.'))
    expect(posts(api)).toHaveLength(0)

    await user().type(reason, '  Bookings not honoured.  ')
    await user().click(within(dialog).getByRole('button', { name: 'Suspend' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Nyamirambo Studio is suspended.')
    expect(posts(api)).toEqual([
      expect.objectContaining({ url: '/api/platform/photographers/p2/suspend', body: { reason: 'Bookings not honoured.' } }),
    ])
    expect(posts(api)[0]?.headers.get('Content-Type')).toBe('application/json')
    expect(row('Nyamirambo Studio').getByText('Reason: Bookings not honoured.')).toBeInTheDocument()
  })

  it('reactivates after a confirmation', async () => {
    const api = platformApi()
    renderAt()
    await table()

    await user().click(row('Gisozi Pix').getByRole('button', { name: 'Reactivate Gisozi Pix' }))
    await user().click(within(await screen.findByRole('dialog', { name: 'Reactivate Gisozi Pix?' })).getByRole('button', { name: 'Reactivate' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Gisozi Pix is reactivated.')
    expect(posts(api)[0]?.url).toBe('/api/platform/photographers/p3/reactivate')
    expect(row('Gisozi Pix').getByText('Approved')).toBeInTheDocument()
  })

  it('drops a row the filter no longer covers', async () => {
    platformApi()
    renderAt('/platform/photographers?status=pending')
    await table()

    await user().click(row('Kigali Lens').getByRole('button', { name: 'Approve Kigali Lens' }))
    await user().click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Kigali Lens is approved.')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText('No photographers with this status.')).toBeInTheDocument()
  })

  it('on a 409 shows the row as it now is and says the change no longer applies', async () => {
    platformApi(() => json({ error: 'invalid_transition', photographer: { ...PENDING, status: 'suspended', suspensionReason: 'Spam.' } }, 409))
    renderAt()
    await table()

    await user().click(row('Kigali Lens').getByRole('button', { name: 'Approve Kigali Lens' }))
    await user().click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That change no longer applies: Kigali Lens is now suspended.')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(row('Kigali Lens').getByText('Suspended')).toBeInTheDocument()
    expect(row('Kigali Lens').getByRole('button', { name: 'Reactivate Kigali Lens' })).toBeInTheDocument()
  })

  it('on a 404 drops the row and says it no longer exists', async () => {
    platformApi(() => json({ error: 'not_found' }, 404))
    renderAt()
    await table()

    await user().click(row('Kigali Lens').getByRole('button', { name: 'Approve Kigali Lens' }))
    await user().click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That photographer no longer exists.')
    expect(rowsNamed('Kigali Lens')).toHaveLength(0)
    expect(rowsNamed('Gisozi Pix')).toHaveLength(1)
  })

  it('on a 422 for the reason keeps the dialog open on the field', async () => {
    platformApi(() => json({ error: 'validation_failed', fields: ['reason'] }, 422))
    renderAt()
    await table()

    await user().click(row('Kigali Lens').getByRole('button', { name: 'Suspend Kigali Lens' }))
    const dialog = await screen.findByRole('dialog')
    await user().type(within(dialog).getByLabelText('Reason'), 'x')
    await user().click(within(dialog).getByRole('button', { name: 'Suspend' }))

    await waitFor(() => expect(within(dialog).getByLabelText('Reason')).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('on %s keeps the dialog open with a retryable failure', async (_label, respond) => {
    platformApi(respond)
    renderAt()
    await table()

    await user().click(row('Kigali Lens').getByRole('button', { name: 'Approve Kigali Lens' }))
    const dialog = await screen.findByRole('dialog')
    await user().click(within(dialog).getByRole('button', { name: 'Approve' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not save the change. Check your connection and try again.')
    expect(within(dialog).getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(row('Kigali Lens').getByText('Pending')).toBeInTheDocument()
  })

  it('on a 401 leaves for the platform login', async () => {
    platformApi(() => json({ error: 'invalid_token' }, 401))
    const router = renderAt()
    await table()

    await user().click(row('Kigali Lens').getByRole('button', { name: 'Approve Kigali Lens' }))
    await user().click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
    expect(readSession('platform')).toBeNull()
  })
})

describe('the review queue (Phase 7)', () => {
  const SETTING_UP = photographer({ id: 'p4', handle: 'remera-shots', displayName: 'Remera Shots', email: 'hi@remera.example', submittedAt: null })
  const QUEUE = [PENDING, SETTING_UP, APPROVED]

  it('shows the submitted date, or says a studio has not submitted', async () => {
    platformApi(undefined, QUEUE)
    renderAt()
    await table()

    expect(screen.getByRole('columnheader', { name: 'Submitted' })).toBeInTheDocument()
    expect(row('Kigali Lens').getByText('Friday, 16 October 2026')).toBeInTheDocument()
    expect(row('Remera Shots').getByText('Not submitted')).toBeInTheDocument()
  })

  it('holds approval back for a pending studio that has not submitted, saying why, and still offers suspend', async () => {
    const api = platformApi(undefined, QUEUE)
    renderAt()
    await table()

    const approve = row('Remera Shots').getByRole('button', { name: 'Approve Remera Shots' })
    expect(approve).toBeDisabled()
    expect(approve).toHaveAccessibleDescription('Not submitted for review yet')
    expect(row('Remera Shots').getByRole('button', { name: 'Suspend Remera Shots' })).toBeEnabled()
    expect(row('Kigali Lens').getByRole('button', { name: 'Approve Kigali Lens' })).toBeEnabled()

    await user().click(approve)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(posts(api)).toHaveLength(0)
  })

  it('opens the awaiting-review queue from the URL the admin email links to, asking the API for it', async () => {
    const api = platformApi(undefined, QUEUE)
    renderAt('/platform/photographers?review=awaiting')
    await table()

    expect(api.sent[0]?.url).toBe('/api/platform/photographers?review=awaiting')
    expect(rowsNamed('Kigali Lens')).toHaveLength(1)
    expect(rowsNamed('Remera Shots')).toHaveLength(0)
    expect(rowsNamed('Nyamirambo Studio')).toHaveLength(0)
    const views = screen.getByRole('navigation', { name: 'Review' })
    expect(within(views).getByRole('link', { name: 'Awaiting review' })).toHaveAttribute('aria-current', 'page')
    // Both review views are pending by definition: no status filter beside them.
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument()
  })

  it('switches between the views through the URL', async () => {
    const api = platformApi(undefined, QUEUE)
    const router = renderAt()
    await table()
    const views = () => screen.getByRole('navigation', { name: 'Review' })
    expect(within(views()).getAllByRole('link').map((link) => link.textContent)).toEqual(['All photographers', 'Awaiting review', 'Still setting up'])
    expect(within(views()).getByRole('link', { name: 'All photographers' })).toHaveAttribute('aria-current', 'page')

    await user().click(within(views()).getByRole('link', { name: 'Still setting up' }))
    await waitFor(() => expect(router.state.location.search).toBe('?review=setting_up'))
    await waitFor(() => expect(rowsNamed('Kigali Lens')).toHaveLength(0))
    expect(rowsNamed('Remera Shots')).toHaveLength(1)
    expect(api.sent.at(-1)?.url).toBe('/api/platform/photographers?review=setting_up')

    await user().click(within(views()).getByRole('link', { name: 'All photographers' }))
    await waitFor(() => expect(router.state.location.search).toBe(''))
    await waitFor(() => expect(rowsNamed('Nyamirambo Studio')).toHaveLength(1))
    expect(screen.getByLabelText('Status')).toBeInTheDocument()
  })

  it('ignores a review value it does not know, and lets a review view win over a status', async () => {
    const api = platformApi(undefined, QUEUE)
    const { unmount } = render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/platform/photographers?review=later'] })} />)
    await table()
    expect(api.sent[0]?.url).toBe('/api/platform/photographers')
    unmount()

    renderAt('/platform/photographers?status=approved&review=awaiting')
    await table()
    expect(api.sent.at(-1)?.url).toBe('/api/platform/photographers?review=awaiting')
  })

  it.each([
    ['awaiting', 'No studios are waiting for review.'],
    ['setting_up', 'No studios are still setting up.'],
  ])('says when the %s view is empty', async (review, words) => {
    stubApi(() => json({ photographers: [] }))
    renderAt(`/platform/photographers?review=${review}`)
    expect(await screen.findByText(words)).toBeInTheDocument()
  })

  it('takes an approved studio out of the awaiting queue', async () => {
    platformApi(undefined, QUEUE)
    renderAt('/platform/photographers?review=awaiting')
    await table()

    await user().click(row('Kigali Lens').getByRole('button', { name: 'Approve Kigali Lens' }))
    await user().click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Kigali Lens is approved.')
    expect(screen.getByText('No studios are waiting for review.')).toBeInTheDocument()
  })

  it('on a 409 not_submitted (a race) says the studio has not submitted, and refreshes the row with approval held back', async () => {
    platformApi(() => json({ error: 'not_submitted', photographer: { ...PENDING, submittedAt: null } }, 409), QUEUE)
    renderAt()
    await table()

    await user().click(row('Kigali Lens').getByRole('button', { name: 'Approve Kigali Lens' }))
    await user().click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("Kigali Lens hasn't submitted their studio for review yet, so it can't be approved.")
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(row('Kigali Lens').getByText('Not submitted')).toBeInTheDocument()
    expect(row('Kigali Lens').getByRole('button', { name: 'Approve Kigali Lens' })).toBeDisabled()
  })

  it('on a 409 not_submitted in the awaiting queue drops the row there', async () => {
    platformApi(() => json({ error: 'not_submitted', photographer: { ...PENDING, submittedAt: null } }, 409), QUEUE)
    renderAt('/platform/photographers?review=awaiting')
    await table()

    await user().click(row('Kigali Lens').getByRole('button', { name: 'Approve Kigali Lens' }))
    await user().click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("Kigali Lens hasn't submitted")
    expect(rowsNamed('Kigali Lens')).toHaveLength(0)
  })

  it('flags a studio awaiting review whose handle changed since submission, with the current handle and the date', async () => {
    // 22:30 UTC is already the 19th in Kigali.
    const RENAMED = photographer({ id: 'p5', handle: 'lens-of-kigali', displayName: 'Renamed Studio', handleChangedAt: '2026-10-18T22:30:00.000Z' })
    platformApi(undefined, [PENDING, RENAMED])
    renderAt('/platform/photographers?review=awaiting')
    await table()

    expect(row('Renamed Studio').getByText('Handle changed since submission')).toBeInTheDocument()
    expect(row('Renamed Studio').getByText('Now /p/lens-of-kigali, changed Monday, 19 October 2026')).toBeInTheDocument()
    expect(row('Kigali Lens').queryByText('Handle changed since submission')).not.toBeInTheDocument()
  })

  it('does not flag a handle change once the studio is approved', async () => {
    const LOCKED = photographer({ id: 'p5', displayName: 'Approved Since', status: 'approved', approvedAt: '2026-10-19T09:00:00.000Z', handleChangedAt: '2026-10-18T09:00:00.000Z' })
    platformApi(undefined, [LOCKED])
    renderAt()
    await table()

    expect(row('Approved Since').queryByText('Handle changed since submission')).not.toBeInTheDocument()
  })

  it('treats a row from before Phase 7, with no submittedAt at all, as not submitted', async () => {
    const legacy = { ...SETTING_UP, submittedAt: undefined } as unknown as PlatformPhotographer
    platformApi(undefined, [legacy])
    renderAt()
    await table()

    expect(row('Remera Shots').getByRole('button', { name: 'Approve Remera Shots' })).toBeDisabled()
  })
})
