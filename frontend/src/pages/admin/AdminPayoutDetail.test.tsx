import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { readSession, saveSession } from '@/auth/session'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'
import { BANK_METHOD, earnings, studioPayoutDetail } from '@/test/payout-fixtures'
import { isStudioLayout, studioLayout } from '@/test/studio-me'

/**
 * `/studio/payouts/:id` (marketplace spec R4.5): one payout, its destination
 * and its lines, each linked to its booking. Another photographer's payout, a
 * cancelled draft and an unknown id are one and the same 404; a malformed id
 * is a 400 that reads the same way.
 */

const SESSION = { token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }
const PAYOUT = studioPayoutDetail()
const PATH = `/studio/payouts/${PAYOUT.id}`

function api(answer: (call: Sent) => Response | Promise<Response> = () => json({ payout: PAYOUT })) {
  return stubApi((call) => {
    if (isStudioLayout(call.url)) return studioLayout(call.url)
    if (call.url.startsWith('/api/studio/payouts/')) return answer(call)
    if (call.url === '/api/studio/earnings') return json(earnings())
    return undefined
  })
}

function pageCalls(sent: Sent[]) {
  return sent.filter((call) => !isStudioLayout(call.url))
}

function renderAt(path = PATH) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function section(title: string): HTMLElement {
  const element = screen.getByRole('heading', { level: 2, name: title }).closest('section')
  if (element === null) throw new Error(`no section ${title}`)
  return element
}

function crumbs() {
  return within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent)
}

beforeEach(() => {
  saveSession('studio', SESSION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  delete document.documentElement.dataset.adminTheme
})

describe('a paid payout', () => {
  it('reads that payout by its id, with the studio token', async () => {
    const { sent } = api()
    renderAt()
    await screen.findByRole('heading', { level: 1, name: 'Payout of 45,000 RWF' })

    expect(pageCalls(sent)).toEqual([expect.objectContaining({ method: 'GET', url: `/api/studio/payouts/${PAYOUT.id}` })])
    expect(pageCalls(sent)[0]?.headers.get('Authorization')).toBe('Bearer studio.jwt')
  })

  it('heads the page with the amount and the status, and says when, the reference and how many lines', async () => {
    api()
    renderAt()
    const heading = await screen.findByRole('heading', { level: 1, name: 'Payout of 45,000 RWF' })

    const header = heading.closest('header') as HTMLElement
    expect(within(header).getByText('Paid')).toHaveAttribute('data-status', 'paid')
    expect(header).toHaveTextContent('Created 10 Oct 2026, 10:00')
    expect(header).toHaveTextContent('Paid 10 Oct 2026, 11:30')
    expect(header).toHaveTextContent('Transfer reference MP261010.1234.A56789')
    expect(header).toHaveTextContent('2 lines')
    expect(screen.queryByText(/Bookly is preparing this payout/)).not.toBeInTheDocument()
  })

  it('shows where it was sent', async () => {
    api()
    renderAt()
    await screen.findByRole('heading', { level: 1 })

    expect(section('Sent to')).toHaveTextContent('MTN MoMo+250 788 123 456Name on the account: Aline Uwase')
  })

  it('lists its lines, each linked to its booking', async () => {
    api()
    renderAt()
    await screen.findByRole('heading', { level: 1 })

    const lines = section('Lines')
    expect(within(lines).getAllByRole('row')).toHaveLength(3)
    expect(within(lines).getByRole('link', { name: 'BKY-2610-00042' })).toHaveAttribute('href', `/studio/bookings/${PAYOUT.items[0]?.booking.id}`)
    expect(within(lines).getByRole('link', { name: 'BKY-2610-00043' })).toHaveAttribute('href', '/studio/bookings/b-b')
    expect(lines).toHaveTextContent('Session fee')
  })

  it('never shows the platform’s internal note, even if one were sent', async () => {
    api(() => json({ payout: { ...PAYOUT, note: 'Paid from the ops line, internal.' } }))
    renderAt()
    await screen.findByRole('heading', { level: 1 })

    expect(screen.queryByText(/internal/)).not.toBeInTheDocument()
  })

  it('reads Admin > Earnings > the payout in the breadcrumb, with Earnings current in the nav', async () => {
    api()
    renderAt()
    await screen.findByRole('heading', { level: 1 })

    await waitFor(() => expect(crumbs()).toEqual(['Studio', 'Earnings', 'Payout 10 Oct 2026, 10:00']))
    expect(within(screen.getByRole('navigation', { name: 'Studio' })).getByRole('link', { name: 'Earnings' })).toHaveAttribute('aria-current', 'page')
  })

  it('goes back to the earnings', async () => {
    api()
    const router = renderAt()
    await screen.findByRole('heading', { level: 1 })

    await userEvent.setup({ delay: null }).click(screen.getByRole('link', { name: 'Back to earnings' }))

    expect(router.state.location.pathname).toBe('/studio/earnings')
  })
})

describe('a draft payout', () => {
  const DRAFT = studioPayoutDetail({ status: 'draft', transferReference: null, paidAt: null, payoutMethod: BANK_METHOD, items: [], itemCount: 0 })

  it('says it is being prepared, with no paid time or reference', async () => {
    api(() => json({ payout: DRAFT }))
    renderAt()
    const heading = await screen.findByRole('heading', { level: 1, name: 'Payout of 45,000 RWF' })

    const header = heading.closest('header') as HTMLElement
    expect(within(header).getByText('Being prepared')).toHaveAttribute('data-status', 'draft')
    expect(header).not.toHaveTextContent('Paid ')
    expect(header).not.toHaveTextContent('Transfer reference')
    expect(screen.getByText('Bookly is preparing this payout. It is marked paid once the transfer has been made.')).toBeInTheDocument()
    expect(section('Sent to')).toHaveTextContent('Bank of Kigali')
  })

  it('says so when it has no lines', async () => {
    api(() => json({ payout: DRAFT }))
    renderAt()
    await screen.findByRole('heading', { level: 1 })

    expect(section('Lines')).toHaveTextContent('No earnings yet.')
    expect(within(section('Lines')).queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('a payout that cannot be shown', () => {
  it.each([
    ['another photographer’s, a cancelled one or an unknown id (404)', 404, 'not_found'],
    ['a malformed id (400)', 400, 'invalid_request'],
  ])('reads %s as not existing, and drops the breadcrumb tail', async (_label, status, code) => {
    api(() => json({ error: code }, status))
    renderAt('/studio/payouts/not-a-uuid')

    expect(await screen.findByRole('heading', { level: 1, name: 'This payout does not exist.' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await waitFor(() => expect(crumbs()).toEqual(['Studio', 'Earnings']))
  })

  it('says a failed load failed, not that the payout is missing, and loads again on retry', async () => {
    let calls = 0
    const { sent } = api(() => (calls++ === 0 ? json({ error: 'internal_error' }, 500) : json({ payout: PAYOUT })))
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this payout. Check your connection and try again.')
    expect(screen.queryByText('This payout does not exist.')).not.toBeInTheDocument()

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Payout of 45,000 RWF' })).toBeInTheDocument()
    expect(pageCalls(sent)).toHaveLength(2)
  })

  it('shows a placeholder while it loads, with the breadcrumb tail waiting too', async () => {
    api(() => new Promise<Response>(() => {}))
    renderAt()

    expect(await screen.findByRole('status')).toHaveTextContent('Loading payout…')
    expect(document.querySelector('[data-slot="breadcrumb-skeleton"]')).not.toBeNull()
  })

  it('sends him to sign in on a 401', async () => {
    api(() => json({ error: 'invalid_token' }, 401))
    const router = renderAt()

    await waitFor(() => expect(router.state.location.pathname).toBe('/studio/login'))
    expect(readSession('studio')).toBeNull()
  })
})
