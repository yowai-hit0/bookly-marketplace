import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { AdminBlock, AdminWorkingHours } from '@/admin/availability'
import { saveSession } from '@/admin/session'
import { routes } from '@/routes'

/**
 * The availability page (plan.md Task 8; spec §3.3, §6.3, §6.4), rendered
 * through the real routes with `fetch` stubbed.
 *
 * What is proven: working hours and blocks are read and written as the API
 * takes them -- a weekly rule or a dated override, never both keys at once; a
 * closed day keeps no window; whole days travel as Kigali dates and part of a
 * day as instants carrying the +02:00 offset; and spec §6.4 holds, so a block
 * over a confirmed booking is refused, named, and only saved when he says so.
 */

const NOW = new Date('2026-10-07T08:00:00.000Z')
const TOKEN = 'header.payload.signature'
const HOURS_API = '/api/admin/working-hours'
const BLOCKS_API = '/api/admin/blocks'

// --- Fixtures ---------------------------------------------------------------

const MONDAY: AdminWorkingHours = {
  id: 'w1',
  weekday: 1,
  effectiveDate: null,
  opensMinute: 540,
  closesMinute: 1020,
  isOpen: true,
  note: null,
}

const SATURDAY: AdminWorkingHours = {
  id: 'w2',
  weekday: 6,
  effectiveDate: null,
  opensMinute: 600,
  closesMinute: 810,
  isOpen: true,
  note: 'Short Saturdays',
}

const CHRISTMAS: AdminWorkingHours = {
  id: 'w3',
  weekday: null,
  effectiveDate: '2026-12-25',
  opensMinute: null,
  closesMinute: null,
  isOpen: false,
  note: null,
}

/** Kigali midnight on the 7th to Kigali midnight on the 10th: three whole days. */
const AWAY: AdminBlock = {
  id: 'b1',
  startsAt: '2026-10-06T22:00:00.000Z',
  endsAt: '2026-10-09T22:00:00.000Z',
  isAllDay: true,
  reason: 'Away for a wedding',
}

const DENTIST: AdminBlock = {
  id: 'b2',
  startsAt: '2026-10-12T12:00:00.000Z',
  endsAt: '2026-10-12T14:00:00.000Z',
  isAllDay: false,
  reason: null,
}

const OVERLAPPING = {
  error: 'block_overlaps_confirmed_bookings',
  bookings: [
    {
      id: 'bk1',
      reference: 'BKY-2610-7K3QX',
      contactName: 'Aline Uwase',
      startsAt: '2026-10-07T07:30:00.000Z',
      endsAt: '2026-10-07T09:00:00.000Z',
    },
  ],
}

// --- Harness ----------------------------------------------------------------

type Sent = { method: string; url: string; body: unknown }
type Route = (sent: Sent) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubApi(
  overrides: Record<string, Route> = {},
  data: { workingHours?: AdminWorkingHours[]; blocks?: AdminBlock[] } = {},
) {
  const api = {
    workingHours: data.workingHours ?? [MONDAY, SATURDAY, CHRISTMAS],
    blocks: data.blocks ?? [AWAY, DENTIST],
    sent: [] as Sent[],
  }
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const sent: Sent = {
      method: init.method ?? 'GET',
      url: String(input),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    }
    api.sent.push(sent)
    const route = overrides[`${sent.method} ${sent.url}`]
    if (route !== undefined) return route(sent)
    if (sent.method === 'GET' && sent.url === HOURS_API) return json({ workingHours: api.workingHours })
    if (sent.method === 'GET' && sent.url === BLOCKS_API) return json({ blocks: api.blocks })
    if (sent.method === 'DELETE') return new Response(null, { status: 204 })
    if (sent.url === '/api/admin/settings') {
      return json({
        settings: {
          bookingFeeRate: 0.4,
          minLeadTimeMinutes: 120,
          holdMinutes: 30,
          bufferMinutes: 15,
          deliveryExpiryDays: 90,
        },
      })
    }
    if (sent.url.startsWith('/api/admin/calendar')) return json({ bookings: [], blocks: [] })
    if (sent.url.startsWith(HOURS_API)) return json({ workingHours: MONDAY }, sent.method === 'POST' ? 201 : 200)
    if (sent.url.startsWith(BLOCKS_API)) return json({ block: AWAY }, sent.method === 'POST' ? 201 : 200)
    return json({})
  })
  vi.stubGlobal('fetch', mock)
  return api
}

type Api = ReturnType<typeof stubApi>

const writes = (api: Api) => api.sent.filter((sent) => sent.method !== 'GET')
const loads = (api: Api) => api.sent.filter((sent) => sent.method === 'GET' && sent.url === HOURS_API).length

function renderPage() {
  saveSession({ token: TOKEN, expiresAt: '2026-10-07T16:00:00.000Z' })
  const router = createMemoryRouter(routes, { initialEntries: ['/admin/availability'] })
  render(<RouterProvider router={router} />)
  return router
}

const user = () => userEvent.setup({ delay: null })

/** Date and time inputs take a value rather than keystrokes. */
function setField(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

async function openPage() {
  renderPage()
  return await screen.findByRole('heading', { name: 'Availability' })
}

const form = (name: string) => screen.getByRole('form', { name })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('AdminAvailability, reading what is stored', () => {
  it('lists the weekly rules and the dated overrides, marked apart', async () => {
    stubApi()
    await openPage()

    expect(screen.getByText('Every Monday')).toBeInTheDocument()
    expect(screen.getByText('09:00 to 17:00')).toBeInTheDocument()
    expect(screen.getByText('Every Saturday')).toBeInTheDocument()
    expect(screen.getByText('10:00 to 13:30')).toBeInTheDocument()
    // A dated override is named by its date and says it covers one day only.
    expect(screen.getByText('Friday, 25 December 2026')).toBeInTheDocument()
    expect(screen.getAllByText('One date')).toHaveLength(1)
    expect(screen.getAllByText('Weekly')).toHaveLength(2)
  })

  it('shows a closed day as closed rather than as an empty window', async () => {
    stubApi()
    await openPage()

    expect(screen.getByText('Closed')).toBeInTheDocument()
  })

  it('shows the private note beside the hours it belongs to', async () => {
    stubApi()
    await openPage()

    expect(screen.getByText('· Short Saturdays')).toBeInTheDocument()
  })

  it('describes a multi-day block by its first and last days, not its stored boundary', async () => {
    stubApi()
    await openPage()

    // Stored as ending at Kigali midnight on the 10th; the last blocked day is the 9th.
    expect(screen.getByText('Wednesday, 7 October 2026 to Friday, 9 October 2026, all day')).toBeInTheDocument()
    expect(screen.getByText('Away for a wedding')).toBeInTheDocument()
  })

  it('describes a part-day block in Kigali clock time', async () => {
    stubApi()
    await openPage()

    expect(screen.getByText('Monday, 12 October 2026, 14:00 to 16:00')).toBeInTheDocument()
    expect(screen.getByText('No reason given')).toBeInTheDocument()
  })

  it('warns when no hours exist at all, because nothing can then be booked', async () => {
    stubApi({}, { workingHours: [], blocks: [] })
    await openPage()

    expect(screen.getByText(/No working hours yet, so clients can never find a slot/i)).toBeInTheDocument()
    expect(screen.getByText('No blocks. Every open hour is bookable.')).toBeInTheDocument()
  })

  it('offers a retry when it cannot be loaded, and shows the rows once it works', async () => {
    let fail = true
    stubApi({
      'GET /api/admin/working-hours': () =>
        fail ? json({ error: 'internal_error' }, 500) : json({ workingHours: [MONDAY] }),
    })
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load availability.')

    fail = false
    await user().click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Every Monday')).toBeInTheDocument()
  })

  it('sends him to sign in when the token has gone stale', async () => {
    stubApi({ 'GET /api/admin/working-hours': () => json({ error: 'unauthenticated' }, 401) })
    const router = renderPage()

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'))
  })
})

describe('AdminAvailability, working hours', () => {
  it('creates a weekly rule carrying the weekday and no date, then refetches', async () => {
    const api = stubApi()
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Add hours' }))
    const created = form('New working hours')
    fireEvent.change(within(created).getByLabelText('Day of the week'), { target: { value: '3' } })
    setField('Opens', '08:30')
    setField('Closes', '16:00')
    await user().type(within(created).getByLabelText('Note'), 'Market day')
    await user().click(within(created).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(writes(api)).toHaveLength(1))
    expect(writes(api)[0]).toMatchObject({
      method: 'POST',
      url: HOURS_API,
      body: { weekday: 3, opensMinute: 510, closesMinute: 960, isOpen: true, note: 'Market day' },
    })
    expect(writes(api)[0]?.body).not.toHaveProperty('effectiveDate')
    await waitFor(() => expect(loads(api)).toBe(2))
  })

  it('creates a dated override carrying the date and no weekday', async () => {
    const api = stubApi()
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Add hours' }))
    await user().click(screen.getByRole('radio', { name: 'One date' }))
    setField('Date', '2026-12-24')
    setField('Closes', '13:00')
    await user().click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(writes(api)).toHaveLength(1))
    expect(writes(api)[0]).toMatchObject({
      body: { effectiveDate: '2026-12-24', opensMinute: 540, closesMinute: 780, isOpen: true },
    })
    expect(writes(api)[0]?.body).not.toHaveProperty('weekday')
  })

  it('stores no window for a day closed for bookings, and hides the times', async () => {
    const api = stubApi()
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Add hours' }))
    expect(screen.getByLabelText('Opens')).toBeInTheDocument()

    await user().click(screen.getByRole('checkbox', { name: 'Open for bookings on this day' }))

    expect(screen.queryByLabelText('Opens')).not.toBeInTheDocument()
    await user().click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(writes(api)).toHaveLength(1))
    expect(writes(api)[0]).toMatchObject({ body: { isOpen: false, opensMinute: null, closesMinute: null } })
  })

  it('edits an existing rule with a PUT that replaces the whole row', async () => {
    const api = stubApi()
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Edit the hours for Saturday' }))
    const editing = form('Edit working hours')
    expect(within(editing).getByLabelText('Opens')).toHaveValue('10:00')
    setField('Closes', '15:00')
    await user().click(within(editing).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(writes(api)).toHaveLength(1))
    expect(writes(api)[0]).toMatchObject({
      method: 'PUT',
      url: `${HOURS_API}/w2`,
      body: { weekday: 6, opensMinute: 600, closesMinute: 900, isOpen: true, note: 'Short Saturdays' },
    })
  })

  it('refuses a closing time before the opening one without sending it', async () => {
    const api = stubApi()
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Add hours' }))
    setField('Opens', '17:00')
    setField('Closes', '09:00')
    await user().click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('Enter a closing time later than the opening time.')).toBeInTheDocument()
    expect(writes(api)).toHaveLength(0)
  })

  it('says which day already has hours when the API refuses a duplicate', async () => {
    stubApi({ 'POST /api/admin/working-hours': () => json({ error: 'working_hours_exists' }, 409) })
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Add hours' }))
    await user().click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That day already has hours. Edit the existing row instead.')
  })

  it('warns that deleting a weekly rule closes that day, then deletes it', async () => {
    const api = stubApi()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Delete the hours for Monday' }))

    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      'Delete the hours for Monday? That closes it until you add hours again.',
    )
    await waitFor(() => expect(writes(api)).toHaveLength(1))
    expect(writes(api)[0]).toMatchObject({ method: 'DELETE', url: `${HOURS_API}/w1` })
  })

  it('warns that deleting an override restores the weekly hours for that date', async () => {
    stubApi()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Delete the hours for Friday, 25 December 2026' }))

    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      'Delete the override for Friday, 25 December 2026? That date goes back to the usual weekly hours.',
    )
  })

  it('sends nothing when the deletion is cancelled', async () => {
    const api = stubApi()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Delete the hours for Monday' }))

    expect(writes(api)).toHaveLength(0)
  })
})

describe('AdminAvailability, blocks', () => {
  it('creates whole days as inclusive Kigali dates', async () => {
    const api = stubApi()
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Add block' }))
    setField('First day', '2026-11-02')
    setField('Last day', '2026-11-04')
    await user().type(screen.getByLabelText('Reason'), 'Training')
    await user().click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(writes(api)).toHaveLength(1))
    expect(writes(api)[0]).toMatchObject({
      method: 'POST',
      url: BLOCKS_API,
      body: { isAllDay: true, startDate: '2026-11-02', endDate: '2026-11-04', reason: 'Training', confirm: false },
    })
  })

  it('creates part of a day as instants carrying the Kigali offset', async () => {
    const api = stubApi()
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Add block' }))
    await user().click(screen.getByRole('radio', { name: 'Part of a day' }))
    setField('Date', '2026-11-02')
    setField('From', '14:00')
    setField('To', '16:30')
    await user().click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(writes(api)).toHaveLength(1))
    expect(writes(api)[0]).toMatchObject({
      body: {
        isAllDay: false,
        startsAt: '2026-11-02T14:00:00+02:00',
        endsAt: '2026-11-02T16:30:00+02:00',
        reason: null,
        confirm: false,
      },
    })
  })

  it('refuses a last day before the first without sending it', async () => {
    const api = stubApi()
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Add block' }))
    setField('First day', '2026-11-04')
    setField('Last day', '2026-11-02')
    await user().click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('The last day cannot be before the first.')).toBeInTheDocument()
    expect(writes(api)).toHaveLength(0)
  })

  it('edits a block with a PUT, reading a stored multi-day range back correctly', async () => {
    const api = stubApi()
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Edit the block on Wednesday, 7 October 2026' }))
    const editing = form('Edit block')
    expect(within(editing).getByLabelText('First day')).toHaveValue('2026-10-07')
    expect(within(editing).getByLabelText('Last day')).toHaveValue('2026-10-09')

    await user().click(within(editing).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(writes(api)).toHaveLength(1))
    expect(writes(api)[0]).toMatchObject({
      method: 'PUT',
      url: `${BLOCKS_API}/b1`,
      body: { isAllDay: true, startDate: '2026-10-07', endDate: '2026-10-09', reason: 'Away for a wedding' },
    })
  })

  it('deletes a block after confirming', async () => {
    const api = stubApi()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await openPage()

    await user().click(screen.getByRole('button', { name: 'Delete the block on Monday, 12 October 2026' }))

    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      'Delete the block on Monday, 12 October 2026? That time becomes bookable again.',
    )
    await waitFor(() => expect(writes(api)).toHaveLength(1))
    expect(writes(api)[0]).toMatchObject({ method: 'DELETE', url: `${BLOCKS_API}/b2` })
  })
})

describe('AdminAvailability, a block over a confirmed booking (spec §6.4)', () => {
  /** Refuses the first save, accepts the one that carries `confirm`. */
  function stubOverlap() {
    return stubApi({
      'POST /api/admin/blocks': (sent) =>
        (sent.body as { confirm?: boolean }).confirm === true
          ? json({ block: AWAY }, 201)
          : json(OVERLAPPING, 409),
    })
  }

  async function submitOverlappingBlock() {
    await openPage()
    await user().click(screen.getByRole('button', { name: 'Add block' }))
    setField('First day', '2026-10-07')
    setField('Last day', '2026-10-07')
    await user().click(screen.getByRole('button', { name: 'Create' }))
  }

  it('names the booking it would cover rather than saving quietly', async () => {
    const api = stubOverlap()
    await submitOverlappingBlock()

    const warning = await screen.findByRole('alert')
    expect(warning).toHaveTextContent('This block covers a confirmed booking')
    expect(warning).toHaveTextContent('BKY-2610-7K3QX')
    expect(warning).toHaveTextContent('Aline Uwase')
    expect(warning).toHaveTextContent('7 Oct 2026, 09:30 to 11:00')
    expect(warning).toHaveTextContent(/does not cancel them/i)

    // Refused, so nothing is stored and the list is not refetched.
    expect(writes(api)).toHaveLength(1)
    expect(loads(api)).toBe(1)
  })

  it('saves over them only when he says so, resending the same block with his consent', async () => {
    const api = stubOverlap()
    await submitOverlappingBlock()

    await screen.findByRole('alert')
    await user().click(screen.getByRole('button', { name: 'Block anyway' }))

    await waitFor(() => expect(writes(api)).toHaveLength(2))
    const [first, second] = writes(api)
    expect(first?.body).toMatchObject({ confirm: false, startDate: '2026-10-07' })
    expect(second?.body).toMatchObject({ confirm: true, startDate: '2026-10-07', endDate: '2026-10-07' })
    await waitFor(() => expect(loads(api)).toBe(2))
  })

  it('leaves the booking alone and keeps the form open when he backs out', async () => {
    const api = stubOverlap()
    await submitOverlappingBlock()

    await screen.findByRole('alert')
    await user().click(screen.getByRole('button', { name: 'Leave it' }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('First day')).toHaveValue('2026-10-07')
    expect(writes(api)).toHaveLength(1)
  })
})

// --- Admin navigation ------------------------------------------------------------------------------------------------

describe('the admin navigation', () => {
  it('lists the five sections, with availability and settings among them', async () => {
    stubApi()
    await openPage()
    const nav = screen.getByRole('navigation', { name: 'Admin' })

    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Calendar',
      'Bookings',
      'Catalogue',
      'Availability',
      'Settings',
    ])
    expect(within(nav).getByRole('link', { name: 'Availability' })).toHaveAttribute('aria-current', 'page')
  })

  it('reaches the settings page from the nav and marks it as the current one', async () => {
    stubApi()
    const router = renderPage()
    await screen.findByRole('heading', { name: 'Availability' })
    const nav = screen.getByRole('navigation', { name: 'Admin' })

    await user().click(within(nav).getByRole('link', { name: 'Settings' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/admin/settings')
    expect(within(nav).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Availability' })).not.toHaveAttribute('aria-current')
  })
})
