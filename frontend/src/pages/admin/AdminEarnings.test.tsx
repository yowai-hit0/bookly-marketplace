import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { Earnings } from '@/admin/payouts'
import { readSession, saveSession } from '@/auth/session'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'
import { BANK_METHOD, earnings, payoutItem, studioPayout, studioPayoutDetail } from '@/test/payout-fixtures'
import { isStudioLayout, studioLayout } from '@/test/studio-me'

/**
 * `/studio/earnings` (marketplace spec R4.5), through the real routes with
 * `fetch` stubbed: the four totals, every line linked to its booking with its
 * state in words (a reversal negative), the payout history linked to each
 * payout, and the loading, empty and failed states.
 */

const SESSION = { token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

/** The studio API: `/api/studio/me` for the layout, the earnings from `answer`, one payout from `payout`. */
function api(answer: (call: Sent) => Response | Promise<Response> = () => json(earnings())) {
  return stubApi((call) => {
    if (isStudioLayout(call.url)) return studioLayout(call.url)
    if (call.url === '/api/studio/earnings') return answer(call)
    if (call.url.startsWith('/api/studio/payouts/')) return json({ payout: studioPayoutDetail() })
    return undefined
  })
}

/** What the page asked, without the layout's own request. */
function pageCalls(sent: Sent[]) {
  return sent.filter((call) => !isStudioLayout(call.url))
}

function renderAt(path = '/studio/earnings') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

async function loaded() {
  await screen.findByRole('heading', { level: 2, name: 'Lines' })
}

/** A tile's value, found by its label. */
function tile(label: string) {
  const term = screen.getAllByText(label).find((element) => element.tagName === 'DT')
  if (term === undefined) throw new Error(`no tile ${label}`)
  return term.nextElementSibling?.textContent
}

function section(title: string): HTMLElement {
  const element = screen.getByRole('heading', { level: 2, name: title }).closest('section')
  if (element === null) throw new Error(`no section ${title}`)
  return element
}

function user() {
  return userEvent.setup({ delay: null })
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

describe('the earnings page', () => {
  it('asks for the earnings once, with the studio token', async () => {
    const { sent } = api()
    renderAt()
    await loaded()

    expect(pageCalls(sent)).toEqual([expect.objectContaining({ method: 'GET', url: '/api/studio/earnings' })])
    expect(pageCalls(sent)[0]?.headers.get('Authorization')).toBe('Bearer studio.jwt')
  })

  it('has one level-1 heading, the nav marking Earnings, and the breadcrumb Admin > Earnings', async () => {
    api()
    renderAt()
    await loaded()

    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Earnings'])
    expect(within(screen.getByRole('navigation', { name: 'Admin' })).getByRole('link', { name: 'Earnings' })).toHaveAttribute('aria-current', 'page')
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('listitem')
    expect(crumbs.map((item) => item.textContent)).toEqual(['Admin', 'Earnings'])
  })

  it('says the platform pays by hand with no commission, and that cash is never here', async () => {
    api()
    renderAt()
    await loaded()

    expect(screen.getByText(/pays you what you earned by manual transfer, with no commission\. Cash you were handed never appears here\./)).toBeInTheDocument()
  })

  it('links to the payout method', async () => {
    api()
    renderAt()
    await loaded()

    expect(screen.getByRole('link', { name: 'Payout method' })).toHaveAttribute('href', '/studio/payout-method')
  })

  it('shows the four totals in RWF', async () => {
    api(() => json(earnings({ totals: { pendingRwf: 30_000, payableRwf: 20_000, inDraftRwf: 15_000, paidRwf: 45_000 } })))
    renderAt()
    await loaded()

    expect(tile('Pending')).toBe('30,000 RWF')
    expect(tile('Payable now')).toBe('20,000 RWF')
    expect(tile('Being paid out')).toBe('15,000 RWF')
    expect(tile('Paid to you')).toBe('45,000 RWF')
    expect(document.querySelector('[data-notice="payable-negative"]')).toBeNull()
  })

  it('shows a balance of nought as nought, with no warning', async () => {
    api(() => json(earnings({ totals: { pendingRwf: 0, payableRwf: 0, inDraftRwf: 0, paidRwf: 0 } })))
    renderAt()
    await loaded()

    expect(tile('Payable now')).toBe('0 RWF')
    expect(document.querySelector('[data-notice="payable-negative"]')).toBeNull()
  })

  it('explains a negative balance: refunds after a payout, taken off the next one', async () => {
    api(() => json(earnings({ totals: { pendingRwf: 0, payableRwf: -5_000, inDraftRwf: 0, paidRwf: 45_000 } })))
    renderAt()
    await loaded()

    expect(tile('Payable now')).toBe('-5,000 RWF')
    expect(document.querySelector('[data-notice="payable-negative"]')).toHaveTextContent(
      'Refunds made after a payout outweigh your new earnings by 5,000 RWF. The next payout subtracts this first.',
    )
  })

  it('lists every line, each linked to its booking, with its state in words and a reversal negative', async () => {
    const reversal = payoutItem({ id: 'pi-rev', kind: 'reversal', amountRwf: -20_000, state: 'payable', booking: { ...payoutItem().booking, id: 'b-rev', reference: 'BKY-2610-00007' } })
    const pending = payoutItem({ id: 'pi-pend', state: 'pending', payment: { ...payoutItem().payment, kind: 'session_fee', amountRwf: 30_000 }, amountRwf: 30_000, booking: { ...payoutItem().booking, id: 'b-pend', reference: 'BKY-2610-00008' } })
    api(() => json(earnings({ items: [reversal, pending, payoutItem({ state: 'paid' })] })))
    renderAt()
    await loaded()

    const lines = within(section('Lines')).getByRole('table', { name: 'Lines' })
    const rows = within(lines).getAllByRole('row').slice(1)
    expect(rows.map((row) => row.getAttribute('data-item'))).toEqual(['pi-rev', 'pi-pend', payoutItem().id])
    expect(within(lines).getByRole('link', { name: 'BKY-2610-00007' })).toHaveAttribute('href', '/studio/bookings/b-rev')
    expect(within(lines).getByRole('link', { name: 'BKY-2610-00008' })).toHaveAttribute('href', '/studio/bookings/b-pend')
    expect(within(lines).getByRole('link', { name: 'BKY-2610-00042' })).toHaveAttribute('href', `/studio/bookings/${payoutItem().booking.id}`)
    expect(rows[0]).toHaveTextContent('Refunded after payout: booking fee')
    expect(rows[0]).toHaveTextContent('-20,000 RWF')
    expect(rows[1]).toHaveTextContent('Session fee')
    expect(rows[1]).toHaveTextContent('Pending')
    expect(rows[2]).toHaveTextContent('Paid')
  })

  it('opens a booking from its line', async () => {
    api()
    const router = renderAt()
    await loaded()

    await user().click(within(section('Lines')).getByRole('link', { name: 'BKY-2610-00042' }))

    expect(router.state.location.pathname).toBe(`/studio/bookings/${payoutItem().booking.id}`)
  })

  it('lists the payouts, newest first: when, how much, its status, where it went and its reference', async () => {
    const draft = studioPayout({ id: 'po-draft', status: 'draft', amountRwf: 15_000, itemCount: 1, transferReference: null, paidAt: null, createdAt: '2026-10-16T08:00:00.000Z', payoutMethod: BANK_METHOD })
    api(() => json(earnings({ payouts: [draft, studioPayout()] })))
    renderAt()
    await loaded()

    const table = within(section('Payouts')).getByRole('table', { name: 'Payouts' })
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Created', 'Amount', 'Status', 'Sent to', 'Transfer reference'])
    const [first, second] = within(table).getAllByRole('row').slice(1)
    expect(within(first as HTMLElement).getAllByRole('cell').map((td) => td.textContent)).toEqual([
      '16 Oct 2026, 10:00',
      '15,000 RWF1 line',
      'Being prepared',
      'Bank of Kigali00040-0123456-78Name on the account: Kigali Lens Ltd',
      'Not sent yet',
    ])
    expect(within(second as HTMLElement).getAllByRole('cell').map((td) => td.textContent)).toEqual([
      '10 Oct 2026, 10:00',
      '45,000 RWF2 lines',
      'Paid',
      'MTN MoMo+250 788 123 456Name on the account: Aline Uwase',
      'MP261010.1234.A56789',
    ])
    expect(within(table).getByRole('link', { name: '16 Oct 2026, 10:00' })).toHaveAttribute('href', '/studio/payouts/po-draft')
  })

  it('opens a payout from the history', async () => {
    api()
    const router = renderAt()
    await loaded()

    await user().click(within(section('Payouts')).getByRole('link', { name: '10 Oct 2026, 10:00' }))

    expect(router.state.location.pathname).toBe(`/studio/payouts/${studioPayout().id}`)
    expect(await screen.findByRole('heading', { level: 1, name: 'Payout of 45,000 RWF' })).toBeInTheDocument()
  })

  it('says so when there are no lines and no payouts yet', async () => {
    api(() => json({ totals: { pendingRwf: 0, payableRwf: 0, inDraftRwf: 0, paidRwf: 0 }, items: [], payouts: [] } satisfies Earnings))
    renderAt()
    await loaded()

    expect(section('Lines')).toHaveTextContent('No earnings yet. Every booking or session fee a client pays online appears here, one line each.')
    expect(section('Payouts')).toHaveTextContent('No payouts yet.')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('while the earnings load, and when they fail', () => {
  it('draws the page with placeholders and announces the wait', async () => {
    api(() => new Promise<Response>(() => {}))
    renderAt()

    expect(await screen.findByRole('status')).toHaveTextContent('Loading earnings…')
    expect(screen.getByRole('heading', { level: 1, name: 'Earnings' })).toBeInTheDocument()
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('says so on %s, and loads again on retry', async (_label, failure) => {
    let calls = 0
    const { sent } = api(() => (calls++ === 0 ? failure() : json(earnings())))
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your earnings. Check your connection and try again.')
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()

    await user().click(screen.getByRole('button', { name: 'Try again' }))

    await loaded()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(pageCalls(sent)).toHaveLength(2)
  })

  it('sends him to sign in when the API refuses the token', async () => {
    api(() => json({ error: 'invalid_token' }, 401))
    const router = renderAt()

    await waitFor(() => expect(router.state.location.pathname).toBe('/studio/login'))
    expect(readSession('studio')).toBeNull()
  })

  it('does not open without a studio session', () => {
    sessionStorage.clear()
    const { sent } = api()
    const router = renderAt()

    expect(router.state.location.pathname).toBe('/studio/login')
    expect(pageCalls(sent)).toHaveLength(0)
  })
})
