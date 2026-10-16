import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { BookingListRow } from '@/admin/bookings'
import { readSession, saveSession } from '@/admin/session'
import { routes } from '@/routes'

/**
 * The bookings list (plan.md Task 19; spec §3.6), rendered through the real
 * routes with `fetch` stubbed.
 *
 * What is proven: every row shows its shoot in Kigali wall time whatever the
 * browser's own zone, the client's name (not their email), one link into the
 * booking named by its reference, and the money the API derived -- what is
 * still owed, and what is owed back. The filter lives in the URL, so a stage
 * chosen in the status dropdown, a date or a search is bookmarkable and
 * survives a reload, and each change re-asks the API with exactly that filter
 * and goes back to page 1. Pages are numbered (2026-09-27): the pager says
 * which rows of how many are shown, moves by number or by arrow, keeps the
 * filter, and is there with its arrows disabled on a single page. A 401 sends
 * him to sign in.
 */

const SESSION = { token: 'header.payload.signature', expiresAt: '2999-01-01T00:00:00.000Z' }
const BOOKINGS_API = '/api/admin/bookings'

const CONFIRMED: BookingListRow = {
  id: 'b1',
  reference: 'BKY-2701-00042',
  status: 'confirmed',
  stage: 'confirmed',
  // 09:00 to 10:30 Kigali on Wednesday 6 January 2027.
  startsAt: '2027-01-06T07:00:00.000Z',
  endsAt: '2027-01-06T08:30:00.000Z',
  contactName: 'Aline Uwase',
  contactEmail: 'aline@example.com',
  contactPhone: '+250788000000',
  serviceName: 'Portraits',
  packageName: 'Standard',
  grandTotalRwf: 50_000,
  collectedRwf: 20_000,
  outstandingRwf: 30_000,
  refundDueRwf: 0,
  hasRefundDue: false,
}

const CANCELLED: BookingListRow = {
  ...CONFIRMED,
  id: 'b2',
  reference: 'BKY-2701-00043',
  status: 'cancelled_by_admin',
  stage: 'cancelled_by_admin',
  startsAt: '2027-01-05T12:00:00.000Z',
  endsAt: '2027-01-05T13:30:00.000Z',
  contactName: 'Eric Habimana',
  contactEmail: 'eric@example.com',
  grandTotalRwf: 40_000,
  collectedRwf: 0,
  outstandingRwf: 0,
  refundDueRwf: 16_000,
  hasRefundDue: true,
}

const NO_SHOW: BookingListRow = {
  ...CONFIRMED,
  id: 'b3',
  reference: 'BKY-2701-00044',
  status: 'no_show',
  stage: 'no_show',
  startsAt: '2027-01-04T06:00:00.000Z',
  endsAt: '2027-01-04T07:30:00.000Z',
  contactName: 'Grace Mukamana',
  contactEmail: 'grace@example.com',
  outstandingRwf: 0,
  collectedRwf: 20_000,
  hasRefundDue: false,
}

const PAGE = { bookings: [CONFIRMED, CANCELLED, NO_SHOW], total: 3, page: 1, pageSize: 25, pageCount: 1 }

type Handler = (url: string) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubFetch(handler: Handler = () => json(PAGE)) {
  const mock = vi.fn((input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve().then(() => handler(String(input))),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

function listCalls(mock: ReturnType<typeof stubFetch>): string[] {
  return mock.mock.calls.map(([input]) => String(input)).filter((url) => url.startsWith(BOOKINGS_API))
}

function signIn() {
  saveSession(SESSION)
}

function renderAt(path = '/admin/bookings') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

/** Every body row of the table, once it has rendered. */
async function rows(): Promise<HTMLElement[]> {
  const table = await screen.findByRole('table')
  return within(table).getAllByRole('row').slice(1)
}

function references(bodyRows: HTMLElement[]): string[] {
  return bodyRows.map((row) => within(row).getByRole('link').textContent ?? '')
}

/** The status filter is a dropdown of checkboxes (2026-09-27); this opens it. */
async function openStatusFilter(): Promise<HTMLElement> {
  await user().click(screen.getByRole('button', { name: /^Status: / }))
  return screen.findByRole('dialog')
}

function stageBox(name: string): HTMLElement {
  return screen.getByRole('checkbox', { name })
}

beforeEach(() => {
  signIn()
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

// --- Rendering ---------------------------------------------------------------------

describe('the list', () => {
  it('shows each shoot in Kigali wall time, the client’s name, and one link named by its reference', async () => {
    stubFetch()
    renderAt()

    const [first, second, third] = await rows()
    expect(screen.getByRole('heading', { level: 1, name: 'Bookings' })).toBeInTheDocument()
    expect(first).toHaveTextContent('Wednesday, 6 January 2027')
    expect(first).toHaveTextContent('09:00 – 10:30')
    expect(first).toHaveTextContent('Aline Uwase')
    // The client column is the name only since 2026-09-27; the email is on the booking.
    expect(first).not.toHaveTextContent('aline@example.com')
    expect(first).toHaveTextContent('Portraits')
    expect(first).toHaveTextContent('Standard')
    expect(second).toHaveTextContent('Tuesday, 5 January 2027')
    expect(second).toHaveTextContent('14:00 – 15:30')
    expect(third).toHaveTextContent('Monday, 4 January 2027')
    expect(screen.getByRole('link', { name: 'BKY-2701-00042' })).toHaveAttribute('href', '/admin/bookings/b1')
    expect(screen.getByRole('link', { name: 'BKY-2701-00043' })).toHaveAttribute('href', '/admin/bookings/b2')
    // One real link per row, stretched over it; the reference is not a column any more.
    for (const row of [first, second, third]) expect(within(row as HTMLElement).getAllByRole('link')).toHaveLength(1)
    expect(screen.queryByRole('columnheader', { name: 'Reference' })).not.toBeInTheDocument()
  })

  it('names each status in words', async () => {
    stubFetch()
    renderAt()

    const [first, second, third] = await rows()
    expect(first).toHaveTextContent('Confirmed')
    expect(second).toHaveTextContent('Cancelled by you')
    expect(third).toHaveTextContent('No-show')
  })

  it('explains every stage, and what to do about it, beside the status filter, by click or keyboard', async () => {
    stubFetch()
    renderAt()
    await rows()

    const filters = screen.getByRole('region', { name: 'Filters' })
    const trigger = within(filters).getByRole('button', { name: 'What the statuses mean' })
    await user().click(trigger)
    const legend = await screen.findByRole('dialog')
    expect(legend).toHaveTextContent('Needs review')
    expect(legend).toHaveTextContent('The shoot has ended. Mark it completed or no-show.')
    expect(legend).toHaveTextContent('The photos email has been sent.')
    expect(legend).toHaveTextContent('Send the photos.')

    await user().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    trigger.focus()
    await user().keyboard('{Enter}')
    expect(await screen.findByRole('dialog')).toHaveTextContent('Needs review')
  })

  it('shows the total, what is still owed, and what is owed back', async () => {
    stubFetch()
    renderAt()

    const [first, second, third] = await rows()
    expect(first).toHaveTextContent('50,000 RWF')
    expect(first).toHaveTextContent('30,000 RWF still to pay')
    expect(first).not.toHaveTextContent('to refund')
    expect(second).toHaveTextContent('16,000 RWF to refund')
    expect(second).not.toHaveTextContent('still to pay')
    // A no-show owes nothing, which is the bug the v2.0 view would have shown.
    expect(third).not.toHaveTextContent('still to pay')
  })

  it('asks the API once, for the unfiltered list', async () => {
    const mock = stubFetch()
    renderAt()

    await rows()

    expect(listCalls(mock)).toEqual([BOOKINGS_API])
  })

  it('says it is loading until the page arrives', async () => {
    let answer: (response: Response) => void = () => {}
    stubFetch(() => new Promise<Response>((resolve) => (answer = resolve)))
    renderAt()

    expect(await screen.findByRole('status')).toHaveTextContent(/Loading/)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    answer(json(PAGE))

    await rows()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says so when nothing matches', async () => {
    stubFetch(() => json({ bookings: [], total: 0, page: 1, pageSize: 25, pageCount: 1 }))
    renderAt()

    expect(await screen.findByText('No bookings match these filters.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows an error when the API does not answer', async () => {
    stubFetch(() => json({ error: 'internal_error' }, 500))
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load the bookings.')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('sends him to sign in on a 401 and forgets the token', async () => {
    stubFetch(() => json({ error: 'unauthenticated' }, 401))
    renderAt()

    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument()
    expect(readSession()).toBeNull()
  })
})

// --- The filter, which lives in the URL ------------------------------------------------

describe('filtering', () => {
  // The filter is by display stage since 2026-09-25.
  it('ticks a stage into the URL, says how many are chosen, and re-asks with it', async () => {
    const mock = stubFetch()
    const router = renderAt()
    await rows()
    expect(screen.getByRole('button', { name: 'Status: All' })).toBeInTheDocument()

    await openStatusFilter()
    await user().click(stageBox('Needs review'))

    await waitFor(() => expect(listCalls(mock)).toHaveLength(2))
    expect(router.state.location.search).toBe('?stage=needs_review')
    expect(listCalls(mock)[1]).toBe(`${BOOKINGS_API}?stage=needs_review`)
    expect(stageBox('Needs review')).toBeChecked()
    expect(stageBox('Completed')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Status: 1 selected' })).toBeInTheDocument()
  })

  it('toggles a stage back off', async () => {
    const mock = stubFetch()
    const router = renderAt('/admin/bookings?stage=confirmed')
    await rows()
    await openStatusFilter()
    expect(stageBox('Confirmed')).toBeChecked()

    await user().click(stageBox('Confirmed'))

    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(listCalls(mock).at(-1)).toBe(BOOKINGS_API)
    expect(stageBox('Confirmed')).not.toBeChecked()
  })

  it('keeps several stages at once, repeated in the query', async () => {
    const mock = stubFetch()
    const router = renderAt('/admin/bookings?stage=confirmed')
    await rows()

    await openStatusFilter()
    await user().click(stageBox('No-show'))

    await waitFor(() => expect(listCalls(mock)).toHaveLength(2))
    expect(router.state.location.search).toBe('?stage=confirmed&stage=no_show')
    expect(listCalls(mock)[1]).toBe(`${BOOKINGS_API}?stage=confirmed&stage=no_show`)
  })

  it('opens a link made before stages on the stages its statuses now span', async () => {
    const mock = stubFetch()
    renderAt('/admin/bookings?status=confirmed&status=completed')
    await rows()

    expect(listCalls(mock)).toEqual([`${BOOKINGS_API}?stage=confirmed&stage=in_progress&stage=needs_review&stage=completed&stage=closed`])
    await openStatusFilter()
    for (const name of ['Confirmed', 'In progress', 'Needs review', 'Completed', 'Closed']) {
      expect(stageBox(name)).toBeChecked()
    }
    expect(stageBox('No-show')).not.toBeChecked()
  })

  it('reads the whole filter out of the URL on first render', async () => {
    const mock = stubFetch()
    renderAt('/admin/bookings?stage=confirmed&stage=completed&from=2027-01-01&to=2027-01-31&search=Uwase')
    await rows()

    expect(listCalls(mock)).toEqual([
      `${BOOKINGS_API}?stage=confirmed&stage=completed&from=2027-01-01&to=2027-01-31&search=Uwase`,
    ])
    expect(screen.getByRole('button', { name: 'Status: 2 selected' })).toBeInTheDocument()
    expect(screen.getByLabelText('From')).toHaveValue('2027-01-01')
    expect(screen.getByLabelText('To')).toHaveValue('2027-01-31')
    expect(screen.getByLabelText('Search')).toHaveValue('Uwase')
  })

  it('ignores a status in the URL that is not one of ours', async () => {
    const mock = stubFetch()
    renderAt('/admin/bookings?status=declined')
    await rows()

    expect(listCalls(mock)).toEqual([BOOKINGS_API])
  })

  it('writes a from date into the URL and re-asks', async () => {
    const mock = stubFetch()
    const router = renderAt()
    await rows()

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2027-01-01' } })

    await waitFor(() => expect(listCalls(mock)).toHaveLength(2))
    expect(router.state.location.search).toBe('?from=2027-01-01')
    expect(listCalls(mock)[1]).toBe(`${BOOKINGS_API}?from=2027-01-01`)
  })

  it('writes a to date beside it, keeping the from date', async () => {
    const mock = stubFetch()
    const router = renderAt('/admin/bookings?from=2027-01-01')
    await rows()

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2027-01-31' } })

    await waitFor(() => expect(listCalls(mock)).toHaveLength(2))
    expect(router.state.location.search).toBe('?from=2027-01-01&to=2027-01-31')
  })

  it('searches on submit, trimming what was typed, and keeps the stage filter', async () => {
    const mock = stubFetch()
    const router = renderAt('/admin/bookings?stage=confirmed')
    await rows()

    await user().type(screen.getByLabelText('Search'), '  Uwase  ')
    await user().click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => expect(listCalls(mock)).toHaveLength(2))
    expect(router.state.location.search).toBe('?stage=confirmed&search=Uwase')
    expect(listCalls(mock)[1]).toBe(`${BOOKINGS_API}?stage=confirmed&search=Uwase`)
  })

  it('clears every filter at once', async () => {
    const mock = stubFetch()
    const router = renderAt('/admin/bookings?stage=confirmed&from=2027-01-01&search=Uwase')
    await rows()

    await user().click(screen.getByRole('button', { name: 'Clear filters' }))

    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(listCalls(mock).at(-1)).toBe(BOOKINGS_API)
    expect(screen.getByRole('button', { name: 'Status: All' })).toBeInTheDocument()
  })

  it('offers nothing to clear when nothing is filtered', async () => {
    stubFetch()
    renderAt()
    await rows()

    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
  })
})

// --- Paging -------------------------------------------------------------------------

describe('numbered pages', () => {
  const PAGE_2: BookingListRow = { ...CONFIRMED, id: 'b4', reference: 'BKY-2701-00045', startsAt: '2027-01-03T07:00:00.000Z', endsAt: '2027-01-03T08:30:00.000Z' }

  /** 132 bookings, 25 to a page: whatever page is asked for comes back with its number. */
  function paged(): ReturnType<typeof stubFetch> {
    return stubFetch((url) => {
      const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? '1')
      return json({ bookings: page === 1 ? [CONFIRMED, CANCELLED, NO_SHOW] : [PAGE_2], total: 132, page, pageSize: 25, pageCount: 6 })
    })
  }

  function pager(): HTMLElement {
    return screen.getByRole('navigation', { name: 'Pages' })
  }

  it('says which rows of how many are shown, and offers the pages', async () => {
    paged()
    renderAt()
    await rows()

    expect(pager()).toHaveTextContent('Showing 1–25 of 132')
    expect(within(pager()).getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page')
    expect(within(pager()).getByRole('button', { name: 'Page 2' })).toBeInTheDocument()
    expect(within(pager()).getByRole('button', { name: 'Page 6' })).toBeInTheDocument()
    expect(within(pager()).queryByRole('button', { name: 'Page 4' })).not.toBeInTheDocument()
    expect(within(pager()).getByRole('button', { name: 'Previous page' })).toBeDisabled()
    expect(within(pager()).getByRole('button', { name: 'Next page' })).toBeEnabled()
  })

  it('goes to a page by number, into the URL, and asks the API for it', async () => {
    const mock = paged()
    const router = renderAt()
    await rows()

    await user().click(within(pager()).getByRole('button', { name: 'Page 2' }))

    await waitFor(() => expect(references(screen.getAllByRole('row').slice(1))).toEqual(['BKY-2701-00045']))
    expect(router.state.location.search).toBe('?page=2')
    expect(listCalls(mock).at(-1)).toBe(`${BOOKINGS_API}?page=2`)
    expect(pager()).toHaveTextContent('Showing 26–50 of 132')
    expect(within(pager()).getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page')
  })

  it('moves by arrow, and keeps the filter while it pages', async () => {
    const mock = paged()
    const router = renderAt('/admin/bookings?stage=confirmed&search=Uwase')
    await rows()

    await user().click(within(pager()).getByRole('button', { name: 'Next page' }))

    await waitFor(() => expect(router.state.location.search).toBe('?stage=confirmed&search=Uwase&page=2'))
    expect(listCalls(mock).at(-1)).toBe(`${BOOKINGS_API}?stage=confirmed&search=Uwase&page=2`)
  })

  it('goes back to page 1 when the filter changes', async () => {
    const mock = paged()
    const router = renderAt('/admin/bookings?page=3')
    await rows()

    await openStatusFilter()
    await user().click(stageBox('Confirmed'))

    await waitFor(() => expect(router.state.location.search).toBe('?stage=confirmed'))
    expect(listCalls(mock).at(-1)).toBe(`${BOOKINGS_API}?stage=confirmed`)
  })

  it('corrects the URL to the last real page when it names one past the end', async () => {
    const mock = stubFetch((url) => {
      const asked = Number(new URL(url, 'http://x').searchParams.get('page') ?? '1')
      return json({ bookings: [CONFIRMED], total: 26, page: Math.min(asked, 2), pageSize: 25, pageCount: 2 })
    })
    const router = renderAt('/admin/bookings?page=9')

    await waitFor(() => expect(router.state.location.search).toBe('?page=2'))
    expect(await screen.findByRole('navigation', { name: 'Pages' })).toHaveTextContent('Showing 26–26 of 26')
    expect(listCalls(mock)).toEqual([`${BOOKINGS_API}?page=9`, `${BOOKINGS_API}?page=2`])
  })

  it('is there on a single page, with both arrows disabled', async () => {
    stubFetch()
    renderAt()
    await rows()

    expect(pager()).toHaveTextContent('Showing 1–3 of 3')
    expect(within(pager()).getByRole('button', { name: 'Previous page' })).toBeDisabled()
    expect(within(pager()).getByRole('button', { name: 'Next page' })).toBeDisabled()
  })

  it('sends him to sign in when a later page answers 401', async () => {
    let first = true
    stubFetch(() => {
      if (first) {
        first = false
        return json({ bookings: [CONFIRMED], total: 30, page: 1, pageSize: 25, pageCount: 2 })
      }
      return json({ error: 'unauthenticated' }, 401)
    })
    renderAt()
    await rows()

    await user().click(within(pager()).getByRole('button', { name: 'Next page' }))

    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument()
    expect(readSession()).toBeNull()
  })
})
