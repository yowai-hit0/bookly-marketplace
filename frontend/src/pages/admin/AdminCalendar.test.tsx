import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CalendarBlock, CalendarBooking, CalendarData } from '@/admin/calendar-events'
import { readSession, saveSession } from '@/admin/session'
import { routes } from '@/routes'

/**
 * The admin calendar page (plan.md Task 9; spec §3.3 step 1, §6.4, §6.5):
 * FullCalendar in Africa/Kigali, fed by `GET /api/admin/calendar`, rendered
 * through the real routes with `fetch` stubbed.
 *
 * The clock is 2026-10-31 22:30 UTC -- already 00:30 on Sunday 1 November in
 * Kigali -- so "today" differs by date, month and week depending on whether it
 * is taken in Kigali or in UTC. Browser-zone independence itself is proven in
 * Chromium (`e2e/admin-calendar.spec.ts`).
 */

const NOW = new Date('2026-10-31T22:30:00.000Z')
const TOKEN = 'header.payload.signature'
const CALENDAR_API = '/api/admin/calendar'
const CONFLICT = 'Conflicts with a block'

function booking(fields: Pick<CalendarBooking, 'id' | 'reference' | 'startsAt' | 'endsAt'> & Partial<CalendarBooking>): CalendarBooking {
  return {
    status: 'confirmed',
    contactName: 'Aline Uwase',
    serviceName: 'Portrait',
    packageName: 'Standard',
    conflictsWithBlock: false,
    ...fields,
  }
}

function block(fields: Pick<CalendarBlock, 'id' | 'startsAt' | 'endsAt'> & Partial<CalendarBlock>): CalendarBlock {
  return { isAllDay: false, reason: null, ...fields }
}

/** October 2026: three confirmed bookings, one live hold, one block over the first booking. */
const OCTOBER: CalendarData = {
  bookings: [
    booking({
      id: 'b1',
      reference: 'BKY-2610-00001',
      startsAt: '2026-10-07T07:00:00.000Z',
      endsAt: '2026-10-07T08:00:00.000Z',
      contactName: 'Grace Mukamana',
      serviceName: 'Wedding',
      packageName: 'Full day',
      conflictsWithBlock: true,
    }),
    booking({
      id: 'b2',
      reference: 'BKY-2610-00002',
      startsAt: '2026-10-15T12:00:00.000Z',
      endsAt: '2026-10-15T13:00:00.000Z',
      contactName: 'Eric Habimana',
    }),
    booking({
      id: 'b3',
      reference: 'BKY-2610-00003',
      status: 'pending_payment',
      startsAt: '2026-10-20T09:00:00.000Z',
      endsAt: '2026-10-20T10:00:00.000Z',
      contactName: 'Claudine Ingabire',
    }),
    // 23:30 Kigali on Friday 23rd -- 21:30 UTC.
    booking({
      id: 'b4',
      reference: 'BKY-2610-00004',
      startsAt: '2026-10-23T21:30:00.000Z',
      endsAt: '2026-10-23T22:00:00.000Z',
      contactName: 'Divine Uwera',
    }),
  ],
  blocks: [block({ id: 'k1', startsAt: '2026-10-07T07:30:00.000Z', endsAt: '2026-10-07T09:00:00.000Z', reason: 'Clinic' })],
}

type Handler = (url: string) => Response | Promise<Response>

function stubFetch(handler: Handler = () => json(OCTOBER)) {
  const mock = vi.fn((input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve().then(() => handler(String(input))),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function calendarUrl(from: string, to: string): string {
  return `${CALENDAR_API}?from=${from}&to=${to}`
}

function requestedUrls(mock: ReturnType<typeof stubFetch>): string[] {
  return mock.mock.calls.map(([input]) => String(input))
}

function signIn() {
  saveSession({ token: TOKEN, expiresAt: '2026-11-01T06:30:00.000Z' })
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

/** Every rendered booking or block, as [Kigali date of its cell, status, text]. */
function entries(): [string | null, string | null, string][] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-kind]')).map((element) => [
    element.closest('[data-date]')?.getAttribute('data-date') ?? null,
    element.dataset.status ?? null,
    element.textContent ?? '',
  ])
}

async function waitForEntries(count: number) {
  // Generous: the first of these waits also covers the lazy FullCalendar chunk
  // loading, which on a busy machine outlasts the 1 s default on its own.
  await waitFor(() => expect(document.querySelectorAll('[data-kind]')).toHaveLength(count), { timeout: 5000 })
}

function toolbarButton(name: string): HTMLElement {
  return screen.getByRole('button', { name, exact: true } as { name: string })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('month view (plan.md Task 9)', () => {
  it('renders 3 confirmed bookings, 1 live hold and 1 block as 5 entries, each labelled with its status', async () => {
    signIn()
    stubFetch()
    renderAt('/admin/calendar?view=month&date=2026-10-07')

    await waitForEntries(5)

    expect(entries().map(([date, status]) => [date, status])).toEqual([
      ['2026-10-07', 'confirmed'],
      ['2026-10-07', 'block'],
      ['2026-10-15', 'confirmed'],
      ['2026-10-20', 'pending_payment'],
      ['2026-10-23', 'confirmed'],
    ])
    const labels = { confirmed: 'Confirmed', pending_payment: 'Hold', block: 'Blocked' } as const
    for (const element of document.querySelectorAll<HTMLElement>('[data-kind]')) {
      const status = element.dataset.status as keyof typeof labels
      expect(within(element).getByText(labels[status])).toBeInTheDocument()
    }
  })

  it('shows each start as Kigali time, on the Kigali date, including 23:30 on the 23rd', async () => {
    signIn()
    stubFetch()
    renderAt('/admin/calendar?view=month&date=2026-10-07')

    await waitForEntries(5)

    const texts = entries().map(([date, , text]) => `${date} ${text}`)
    expect(texts[0]).toContain('2026-10-07 09:00')
    expect(texts[1]).toContain('2026-10-07 09:30')
    expect(texts[2]).toContain('2026-10-15 14:00')
    expect(texts[3]).toContain('2026-10-20 11:00')
    expect(texts[4]).toContain('2026-10-23 23:30')
  })

  it('marks the booking that overlaps a block with a conflict marker, and no other entry (spec §6.4)', async () => {
    signIn()
    stubFetch()
    renderAt('/admin/calendar?view=month&date=2026-10-07')

    await waitForEntries(5)

    const marked = Array.from(document.querySelectorAll<HTMLElement>('[data-kind]')).filter((element) =>
      element.textContent?.includes(CONFLICT),
    )
    expect(marked).toHaveLength(1)
    expect(marked[0]).toHaveTextContent('Grace Mukamana')
    expect(document.querySelectorAll('.bookly-event--conflict')).toHaveLength(1)
  })

  it('fetches exactly the whole weeks of the month once, with the bearer token', async () => {
    signIn()
    const fetchMock = stubFetch()
    renderAt('/admin/calendar?view=month&date=2026-10-07')

    await waitForEntries(5)

    expect(requestedUrls(fetchMock)).toEqual([calendarUrl('2026-09-28', '2026-11-01')])
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`)
  })
})

describe('the URL', () => {
  it('opens the view and date it names, and records where the calendar landed', async () => {
    signIn()
    const fetchMock = stubFetch()
    const router = renderAt('/admin/calendar?view=week&date=2026-10-07')

    await waitForEntries(2)

    expect(requestedUrls(fetchMock)).toEqual([calendarUrl('2026-10-05', '2026-10-11')])
    await waitFor(() => expect(router.state.location.search).toBe('?view=week&date=2026-10-05'))
  })

  it.each([
    ['no parameters', '/admin/calendar'],
    ['an unknown view and a malformed date', '/admin/calendar?view=year&date=31-10-2026'],
    ['a year the API refuses', '/admin/calendar?view=month&date=0050-06-15'],
  ])('falls back to the month of Kigali today for %s', async (_label, path) => {
    signIn()
    const fetchMock = stubFetch(() => json({ bookings: [], blocks: [] }))
    const router = renderAt(path)

    // 22:30 UTC on 31 October is already 1 November in Kigali.
    await waitFor(() => expect(requestedUrls(fetchMock)).toEqual([calendarUrl('2026-10-26', '2026-12-06')]))
    await waitFor(() => expect(router.state.location.search).toBe('?view=month&date=2026-11-01'))
  })
})

describe('navigation', () => {
  it('fetches the next month on Next, and follows it in the URL', async () => {
    signIn()
    const fetchMock = stubFetch()
    const router = renderAt('/admin/calendar?view=month&date=2026-10-07')
    await waitForEntries(5)

    await user().click(toolbarButton('Next'))

    await waitFor(() =>
      expect(requestedUrls(fetchMock)).toEqual([calendarUrl('2026-09-28', '2026-11-01'), calendarUrl('2026-10-26', '2026-12-06')]),
    )
    await waitFor(() => expect(router.state.location.search).toBe('?view=month&date=2026-11-01'))
  })

  it('switches to the week and day views without refetching dates it already holds', async () => {
    signIn()
    const fetchMock = stubFetch()
    const router = renderAt('/admin/calendar?view=month&date=2026-10-07')
    await waitForEntries(5)
    const u = user()

    await u.click(toolbarButton('Week'))
    await waitFor(() => expect(router.state.location.search).toMatch(/^\?view=week&date=/))
    await u.click(toolbarButton('Day'))
    await waitFor(() => expect(router.state.location.search).toMatch(/^\?view=day&date=/))

    expect(requestedUrls(fetchMock)).toEqual([calendarUrl('2026-09-28', '2026-11-01')])
  })
})

describe('week and day views', () => {
  it('show each booking with its service, package and reference, and a block with its reason', async () => {
    signIn()
    stubFetch()
    renderAt('/admin/calendar?view=week&date=2026-10-07')

    await waitForEntries(2)

    const [bookingEntry, blockEntry] = [
      document.querySelector<HTMLElement>('[data-kind="booking"]'),
      document.querySelector<HTMLElement>('[data-kind="block"]'),
    ]
    expect(bookingEntry).toHaveTextContent('09:00 - 10:00')
    expect(bookingEntry).toHaveTextContent('Wedding · Full day · BKY-2610-00001')
    expect(bookingEntry).toHaveTextContent(CONFLICT)
    expect(blockEntry).toHaveTextContent('09:30 - 11:00')
    expect(blockEntry).toHaveTextContent('Clinic')
  })

  it('labels an all-day block "All day" on the second of the two Kigali dates it covers', async () => {
    signIn()
    stubFetch(() =>
      json({
        bookings: [],
        // Kigali midnight on Monday 12th to Kigali midnight after Tuesday 13th.
        blocks: [block({ id: 'k2', isAllDay: true, startsAt: '2026-10-11T22:00:00.000Z', endsAt: '2026-10-13T22:00:00.000Z', reason: 'Trip' })],
      }),
    )
    renderAt('/admin/calendar?view=day&date=2026-10-13')

    await waitForEntries(1)

    expect(entries()).toEqual([['2026-10-13', 'block', expect.stringContaining('All day')]])
    expect(document.querySelector('[data-kind="block"]')).toHaveTextContent('Trip')
  })
})

describe('when the API does not answer with a calendar', () => {
  it('sends him to sign in on a 401 and forgets the token', async () => {
    signIn()
    stubFetch(() => json({ error: 'unauthenticated' }, 401))
    renderAt('/admin/calendar?view=month&date=2026-10-07')

    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument()
    expect(readSession()).toBeNull()
  })

  it('shows an error with Try again, which refetches and renders the calendar', async () => {
    signIn()
    let calls = 0
    const fetchMock = stubFetch(() => (++calls === 1 ? json({ error: 'internal_error' }, 500) : json(OCTOBER)))
    renderAt('/admin/calendar?view=month&date=2026-10-07')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load the calendar.')
    expect(document.querySelectorAll('[data-kind]')).toHaveLength(0)

    await user().click(within(alert).getByRole('button', { name: 'Try again' }))

    await waitForEntries(5)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(requestedUrls(fetchMock)).toEqual([calendarUrl('2026-09-28', '2026-11-01'), calendarUrl('2026-09-28', '2026-11-01')])
  })

  it('says it is loading until the calendar arrives', async () => {
    signIn()
    let answer: (response: Response) => void = () => {}
    stubFetch(() => new Promise<Response>((resolve) => (answer = resolve)))
    renderAt('/admin/calendar?view=month&date=2026-10-07')

    expect(await screen.findByRole('status')).toHaveTextContent('Loading calendar…')

    answer(json(OCTOBER))

    await waitForEntries(5)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('the admin layout around it', () => {
  it('sends a visitor with no session to sign in without fetching', async () => {
    const fetchMock = stubFetch()
    renderAt('/admin/calendar')

    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('signs out by forgetting the token', async () => {
    signIn()
    stubFetch()
    renderAt('/admin/calendar?view=month&date=2026-10-07')
    await waitForEntries(5)

    await user().click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument()
    expect(readSession()).toBeNull()
  })
})

/** A fetch that records what was written, for the block the calendar creates. */
type Written = { method: string; url: string; body: unknown }

function stubWritableFetch(data: CalendarData = OCTOBER) {
  const written: Written[] = []
  const mock = vi.fn((input: string | URL | Request, init: RequestInit = {}) =>
    Promise.resolve().then(() => {
      const url = String(input)
      const method = init.method ?? 'GET'
      if (method !== 'GET') {
        written.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
        return json({ block: { id: 'new', startsAt: '', endsAt: '', isAllDay: true, reason: null } }, 201)
      }
      if (url.startsWith(CALENDAR_API)) return json(data)
      return json({})
    }),
  )
  vi.stubGlobal('fetch', mock)
  return { written, mock }
}

describe('opening a booking from the calendar (plan.md Task 19)', () => {
  it('opens the booking behind an event that is clicked', async () => {
    signIn()
    stubFetch()
    const router = renderAt('/admin/calendar?view=month&date=2026-10-07')
    await waitForEntries(5)

    const event = document.querySelector<HTMLElement>('[data-kind="booking"]')
    await user().click(event as HTMLElement)

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/bookings/b1'))
  })

  it('opens the page that edits a block when the block is clicked', async () => {
    signIn()
    stubFetch()
    const router = renderAt('/admin/calendar?view=month&date=2026-10-07')
    await waitForEntries(5)

    await user().click(document.querySelector<HTMLElement>('[data-kind="block"]') as HTMLElement)

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/availability'))
  })

  it('puts every event in the tab order, so neither kind needs a mouse', async () => {
    signIn()
    stubFetch()
    renderAt('/admin/calendar?view=month&date=2026-10-07')
    await waitForEntries(5)

    for (const kind of ['booking', 'block']) {
      const event = document.querySelector<HTMLElement>(`[data-kind="${kind}"]`)?.closest('.fc-event')
      expect(event, kind).toHaveAttribute('tabindex', '0')
    }
  })

  it('opens the booking from the keyboard, not by mouse alone', async () => {
    signIn()
    stubFetch()
    const router = renderAt('/admin/calendar?view=month&date=2026-10-07')
    await waitForEntries(5)

    const event = document.querySelector<HTMLElement>('[data-kind="booking"]')?.closest('.fc-event') as HTMLElement
    event.focus()
    expect(event).toHaveFocus()
    await user().keyboard('{Enter}')

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/bookings/b1'))
  })
})

describe('blocking time from the calendar (spec §3.3 step 3)', () => {
  it('opens the block form on the first day shown when today is elsewhere', async () => {
    signIn()
    stubWritableFetch()
    renderAt('/admin/calendar?view=month&date=2026-10-07')
    await waitForEntries(5)

    await user().click(screen.getByRole('button', { name: 'Block time' }))

    // The clock is already 1 November in Kigali, which October does not show.
    expect(screen.getByLabelText('First day')).toHaveValue('2026-10-01')
  })

  it('opens it on today when today is on screen', async () => {
    signIn()
    stubWritableFetch({ bookings: [], blocks: [] })
    renderAt('/admin/calendar')

    await user().click(await screen.findByRole('button', { name: 'Block time' }))

    expect(screen.getByLabelText('First day')).toHaveValue('2026-11-01')
  })

  it('creates the block and refetches the events so it appears', async () => {
    signIn()
    const { written, mock } = stubWritableFetch()
    renderAt('/admin/calendar?view=month&date=2026-10-07')
    await waitForEntries(5)
    const loadsBefore = requestedUrls(mock).filter((url) => url.startsWith(CALENDAR_API)).length

    await user().click(screen.getByRole('button', { name: 'Block time' }))
    fireEvent.change(screen.getByLabelText('First day'), { target: { value: '2026-10-19' } })
    fireEvent.change(screen.getByLabelText('Last day'), { target: { value: '2026-10-19' } })
    await user().click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(written).toHaveLength(1))
    expect(written[0]).toMatchObject({
      method: 'POST',
      url: '/api/admin/blocks',
      body: { isAllDay: true, startDate: '2026-10-19', endDate: '2026-10-19', confirm: false },
    })
    // The form closes and the calendar reloads, so the new block is on screen.
    await waitFor(() => expect(screen.queryByRole('form', { name: 'New block' })).not.toBeInTheDocument())
    await waitFor(() =>
      expect(requestedUrls(mock).filter((url) => url.startsWith(CALENDAR_API)).length).toBeGreaterThan(loadsBefore),
    )
  })

  it('closes the form without writing anything when he changes his mind', async () => {
    signIn()
    const { written } = stubWritableFetch()
    renderAt('/admin/calendar?view=month&date=2026-10-07')
    await waitForEntries(5)

    await user().click(screen.getByRole('button', { name: 'Block time' }))
    await user().click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('form', { name: 'New block' })).not.toBeInTheDocument()
    expect(written).toHaveLength(0)
  })
})
