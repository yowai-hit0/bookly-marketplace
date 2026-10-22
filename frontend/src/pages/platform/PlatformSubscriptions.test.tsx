import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { readSession, saveSession } from '@/auth/session'
import { formatDateTime } from '@/lib/format'
import { routes } from '@/routes'
import { json, stubApi } from '@/test/fetch'
import { paidPeriod, platformSubscription, trialPeriod } from '@/test/subscription-fixtures'

/**
 * `/platform/subscriptions` (marketplace spec Phase 5: R5.4, R9.3), through the
 * real routes with `fetch` stubbed: every subscription, the soonest to end
 * first, each with its photographer, status, period end, grace end and last
 * paid period; filtered by status through `?status=`.
 */

const URL_ = '/api/platform/subscriptions'
const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

const TRIAL = platformSubscription({
  id: 'sub-trial',
  photographer: { id: 'ph1', handle: 'kigali-lens', displayName: 'Kigali Lens', status: 'approved' },
  status: 'trialing',
  currentPeriodEndsAt: '2026-10-31T08:00:00.000Z',
  graceEndsAt: '2026-11-07T08:00:00.000Z',
})

const PAID = platformSubscription({
  id: 'sub-paid',
  photographer: { id: 'ph2', handle: 'nyamirambo-light', displayName: 'Nyamirambo Light', status: 'approved' },
  status: 'active',
  currentPeriodEndsAt: '2027-10-31T08:00:00.000Z',
  graceEndsAt: '2027-11-07T08:00:00.000Z',
  periods: [
    paidPeriod({ id: 'p-yearly', planInterval: 'yearly', priceRwf: 100_000, startsAt: '2026-10-31T08:00:00.000Z', endsAt: '2027-10-31T08:00:00.000Z', paidAt: '2026-10-20T09:00:00.000Z' }),
    paidPeriod({ id: 'p-monthly', startsAt: '2026-09-30T08:00:00.000Z', endsAt: '2026-10-31T08:00:00.000Z' }),
    trialPeriod(),
  ],
})

const LAPSED = platformSubscription({
  id: 'sub-lapsed',
  photographer: { id: 'ph3', handle: 'umuganda-studio', displayName: 'Umuganda Studio', status: 'suspended' },
  status: 'past_due',
  currentPeriodEndsAt: '2026-10-20T08:00:00.000Z',
  graceEndsAt: '2026-10-27T08:00:00.000Z',
})

function api(answer: (url: string) => Response | Promise<Response> = () => json({ subscriptions: [PAID, TRIAL, LAPSED] })) {
  return stubApi((call) => (call.url.startsWith(URL_) ? answer(call.url) : undefined))
}

function renderAt(path = '/platform/subscriptions') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function rows() {
  return screen.getAllByRole('row').filter((row) => row.hasAttribute('data-subscription'))
}

function row(id: string) {
  const found = rows().find((candidate) => candidate.getAttribute('data-subscription') === id)
  if (found === undefined) throw new Error(`no row ${id}`)
  return found
}

function cells(id: string) {
  return within(row(id)).getAllByRole('cell')
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

describe('the subscriptions list', () => {
  it('announces the wait, then lists every subscription the soonest to end first, asked with the platform token', async () => {
    const { sent } = api()
    renderAt()

    expect(screen.getByRole('heading', { level: 1, name: 'Subscriptions' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading subscriptions…')
    await screen.findByRole('table', { name: 'Subscriptions' })

    expect(rows().map((candidate) => candidate.getAttribute('data-subscription'))).toEqual(['sub-lapsed', 'sub-trial', 'sub-paid'])
    expect(sent).toEqual([expect.objectContaining({ method: 'GET', url: URL_ })])
    expect(sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
  })

  it('heads the columns: photographer, status, period end, grace end, last paid period', async () => {
    api()
    renderAt()
    await screen.findByRole('table', { name: 'Subscriptions' })

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Photographer',
      'Status',
      'Period ends',
      'Hidden after',
      'Last paid period',
    ])
  })

  it('says whose each one is, its status in words, and when the period and the grace end', async () => {
    api()
    renderAt()
    await screen.findByRole('table', { name: 'Subscriptions' })

    const [who, status, end, grace] = cells('sub-trial')
    expect(who).toHaveTextContent('Kigali Lens')
    expect(who).toHaveTextContent('/p/kigali-lens')
    expect(status).toHaveTextContent('Free trial')
    expect(end).toHaveTextContent(formatDateTime('2026-10-31T08:00:00.000Z'))
    expect(grace).toHaveTextContent(formatDateTime('2026-11-07T08:00:00.000Z'))

    expect(cells('sub-paid')[1]).toHaveTextContent('Active')
    expect(cells('sub-lapsed')[1]).toHaveTextContent('Past due')
  })

  it('flags a photographer who is not approved now, and only then', async () => {
    api()
    renderAt()
    await screen.findByRole('table', { name: 'Subscriptions' })

    expect(cells('sub-lapsed')[0]).toHaveTextContent('Suspended')
    expect(cells('sub-trial')[0]).not.toHaveTextContent('Approved')
  })

  it('shows the last period paid for: its plan, price, dates and when it was paid', async () => {
    api()
    renderAt()
    await screen.findByRole('table', { name: 'Subscriptions' })

    const last = cells('sub-paid')[4] as HTMLElement
    expect(last.querySelector('[data-last-paid]')).toHaveAttribute('data-last-paid', 'p-yearly')
    expect(last).toHaveTextContent('Yearly, 100,000 RWF')
    expect(last).toHaveTextContent(`${formatDateTime('2026-10-31T08:00:00.000Z')} to ${formatDateTime('2027-10-31T08:00:00.000Z')}`)
    expect(last).toHaveTextContent(`Paid ${formatDateTime('2026-10-20T09:00:00.000Z')}`)
  })

  it('says "Never paid" for a subscription that has only had its trial', async () => {
    api()
    renderAt()
    await screen.findByRole('table', { name: 'Subscriptions' })

    expect(cells('sub-trial')[4]).toHaveTextContent('Never paid')
  })

  it('says when there are none', async () => {
    api(() => json({ subscriptions: [] }))
    renderAt()

    expect(await screen.findByText('No subscriptions yet.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('says a failed load, and loads again on "Try again"', async () => {
    let call = 0
    const { sent } = api(() => (++call === 1 ? json({ error: 'internal_error' }, 500) : json({ subscriptions: [TRIAL] })))
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the subscriptions. Check your connection and try again.')
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Try again' }))

    await screen.findByRole('table', { name: 'Subscriptions' })
    expect(rows()).toHaveLength(1)
    expect(sent).toHaveLength(2)
  })

  it('on a 401 drops the platform session and goes to its sign in', async () => {
    api(() => json({ error: 'invalid_token' }, 401))
    const router = renderAt()

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
    expect(readSession('platform')).toBeNull()
  })
})

describe('filtering by status', () => {
  it('offers every status, and All', async () => {
    api()
    renderAt()
    await screen.findByRole('table', { name: 'Subscriptions' })

    const select = screen.getByRole('combobox', { name: 'Status' })
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['All', 'Free trial', 'Active', 'Past due', 'Expired'])
    expect(select).toHaveValue('all')
  })

  it('asks for the chosen status and puts it in the address', async () => {
    const { sent } = api((url) => json({ subscriptions: url.endsWith('past_due') ? [LAPSED] : [PAID, TRIAL, LAPSED] }))
    const router = renderAt()
    await screen.findByRole('table', { name: 'Subscriptions' })

    await userEvent.setup({ delay: null }).selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'past_due')

    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(row('sub-lapsed')).toBeInTheDocument()
    expect(sent.map((call) => call.url)).toEqual([URL_, `${URL_}?status=past_due`])
    expect(router.state.location.search).toBe('?status=past_due')
  })

  it('starts from the status in the address', async () => {
    const { sent } = api(() => json({ subscriptions: [] }))
    renderAt('/platform/subscriptions?status=expired')

    expect(await screen.findByText('No subscriptions with this status.')).toBeInTheDocument()
    expect(sent.map((call) => call.url)).toEqual([`${URL_}?status=expired`])
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('expired')
  })

  it('reads an unknown status in the address as All', async () => {
    const { sent } = api()
    renderAt('/platform/subscriptions?status=cancelled')
    await screen.findByRole('table', { name: 'Subscriptions' })

    expect(sent.map((call) => call.url)).toEqual([URL_])
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('all')
  })

  it('goes back to every status on All, clearing the address', async () => {
    const { sent } = api()
    const router = renderAt('/platform/subscriptions?status=active')
    await screen.findByRole('table', { name: 'Subscriptions' })

    await userEvent.setup({ delay: null }).selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'all')

    await waitFor(() => expect(sent.map((call) => call.url)).toEqual([`${URL_}?status=active`, URL_]))
    expect(router.state.location.search).toBe('')
  })
})
