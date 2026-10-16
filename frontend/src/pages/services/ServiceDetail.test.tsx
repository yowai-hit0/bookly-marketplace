import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { PublicServiceDetail } from '@/catalogue/api'
import type { HeldBooking } from '@/catalogue/bookings'
import { routes } from '@/routes'

/**
 * One service's page (plan.md Task 11; spec §3.1 steps 2, 3 and 7, §6.14),
 * rendered through the real routes with `fetch` stubbed.
 *
 * What is proven: nothing is preselected; choosing a package and ticking or
 * unticking add-ons updates the total, booking fee and session fee live, at the
 * service's own rate; the non-refundable notice is there from the start; an
 * unknown or deactivated slug is the not-found page; a failed load can be
 * retried; and each package reads its photos and duration in words.
 *
 * With the slot picker (plan.md Task 12): no availability is asked for until a
 * package is chosen; then the chosen package's month is, and switching to a
 * longer package asks again for it and shows its fewer starts on the same date.
 * The picker's own behaviour is proven in SlotPicker.test.tsx.
 *
 * With booking creation (plan.md Task 13): Confirm appears only once a start is
 * chosen, after the non-refundable notice; the form's own check marks and
 * focuses what is wrong without a request; the request carries ids, the start
 * and the form -- never an amount; a created booking becomes the held page with
 * the API's amounts; a taken or refused start is the picker's focused "just
 * taken" alert over a refreshed calendar, with what was typed kept; the API's
 * field refusals are marked; a changed catalogue or a failure is an alert that
 * can be retried; and a double press sends one request.
 */

const API = '/api/services'

// --- Fixtures ---------------------------------------------------------------

const PORTRAITS: PublicServiceDetail = {
  id: 's1',
  slug: 'portraits',
  nameEn: 'Portraits',
  descriptionEn: 'Studio portraits.',
  coverImageUrl: 'https://images.example.com/portraits.jpg',
  packages: [
    { id: 'p1', nameEn: 'Mini', descriptionEn: null, priceRwf: 25_000, photoCount: 1, durationMinutes: 45 },
    { id: 'p2', nameEn: 'Standard', descriptionEn: 'One look, one location.', priceRwf: 40_000, photoCount: 20, durationMinutes: 90 },
    { id: 'p3', nameEn: 'Extended', descriptionEn: null, priceRwf: 60_000, photoCount: 2, durationMinutes: 120 },
    { id: 'p4', nameEn: 'Quick', descriptionEn: null, priceRwf: 15_000, photoCount: 0, durationMinutes: 60 },
  ],
  addons: [
    { id: 'a1', nameEn: 'Extra hour', priceRwf: 10_000 },
    { id: 'a2', nameEn: 'Rush edit', priceRwf: 5_000 },
  ],
  bookingFeeRate: 0.4,
}

const WEDDINGS: PublicServiceDetail = {
  id: 's2',
  slug: 'weddings',
  nameEn: 'Weddings',
  descriptionEn: null,
  coverImageUrl: null,
  packages: [{ id: 'p5', nameEn: 'Standard', descriptionEn: null, priceRwf: 40_000, photoCount: 150, durationMinutes: 240 }],
  addons: [{ id: 'a3', nameEn: 'Second shooter', priceRwf: 10_000 }],
  bookingFeeRate: 0.3,
}

const PRODUCTS: PublicServiceDetail = {
  id: 's3',
  slug: 'products',
  nameEn: 'Product shots',
  descriptionEn: null,
  coverImageUrl: null,
  packages: [],
  addons: [{ id: 'a2', nameEn: 'Rush edit', priceRwf: 5_000 }],
  bookingFeeRate: 0.4,
}

const NOTICE = 'The booking fee is non-refundable if you cancel.'
const PROMPT = 'Choose a package to see your total.'

/** Kigali start times per package on Wednesday 7 October 2026: the longer the package, the fewer. */
const WEDNESDAY_STARTS: Record<string, string[]> = {
  p1: ['09:00', '09:30', '10:00', '10:30', '14:00'],
  p2: ['09:00', '09:30', '14:00'],
  p3: ['09:00', '09:30'],
}

/** Every date of `month`, with the package's Wednesday starts on the 7th of October. */
function availabilityFor(packageId: string, month: string) {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number]
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return Array.from({ length }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`
    const times = date === '2026-10-07' ? (WEDNESDAY_STARTS[packageId] ?? []) : []
    return { date, starts: times.map((time) => new Date(`${date}T${time}:00+02:00`).toISOString()) }
  })
}

type Route = (init?: RequestInit) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * A `fetch` for the public API. `routes` answers a URL, and is handed the
 * request's init; otherwise the three services answer as the API would, the
 * list answers all three, availability answers a month for any package, and
 * anything else is the API's 404.
 */
function stubApi(routes: Record<string, Route> = {}) {
  const sent: string[] = []
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    sent.push(url)
    const route = routes[url]
    if (route !== undefined) return route(init)
    if (url.startsWith('/api/availability?')) {
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1))
      return json({ days: availabilityFor(query.get('packageId') ?? '', query.get('month') ?? '') })
    }
    if (url === API) return json({ services: [PORTRAITS, WEDDINGS, PRODUCTS] })
    const service = [PORTRAITS, WEDDINGS, PRODUCTS].find((candidate) => url === `${API}/${candidate.slug}`)
    if (service !== undefined) return json({ service })
    return json({ error: 'not_found' }, 404)
  })
  vi.stubGlobal('fetch', mock)
  return sent
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

async function renderLoaded(service: PublicServiceDetail = PORTRAITS) {
  const router = renderAt(`/services/${service.slug}`)
  await screen.findByRole('heading', { level: 1, name: service.nameEn })
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

function summary(): HTMLElement {
  return screen.getByRole('region', { name: 'Price summary' })
}

/** Every term and its amount in the summary, in the order they render. */
function lines(): [string, string][] {
  return Array.from(summary().querySelectorAll('dt')).map((term) => [
    term.textContent ?? '',
    term.nextElementSibling?.textContent ?? '',
  ])
}

/** Total, booking fee line and session fee, as the visitor reads them. */
function totals(): { total: string; bookingFee: [string, string]; sessionFee: string } {
  const all = lines()
  const find = (predicate: (term: string) => boolean) => all.find(([term]) => predicate(term)) ?? ['', '']
  return {
    total: find((term) => term === 'Total')[1],
    bookingFee: find((term) => term.startsWith('Booking fee')),
    sessionFee: find((term) => term.startsWith('Session fee'))[1],
  }
}

/**
 * A row's accessible name is its whole label, name then price: jsdom reads
 * "Standard40,000 RWF20 photos · …", so match the name followed by the price.
 */
function startsWithName(name: string) {
  return (accessibleName: string) =>
    accessibleName.startsWith(name) && /^\d/.test(accessibleName.slice(name.length).trimStart())
}

function packageRadio(name: string): HTMLElement {
  return screen.getByRole('radio', { name: startsWithName(name) })
}

function addonCheckbox(name: string): HTMLElement {
  return screen.getByRole('checkbox', { name: startsWithName(name) })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// --- Loading ---------------------------------------------------------------------------------

describe('loading a service', () => {
  it('shows a loading status, then the service, fetched from /api/services/<slug>', async () => {
    let answer: (res: Response) => void = () => {}
    const sent = stubApi({ [`${API}/portraits`]: () => new Promise<Response>((resolve) => (answer = resolve)) })
    renderAt('/services/portraits')

    expect(await screen.findByRole('status')).toHaveTextContent('Loading…')
    expect(screen.getByRole('link', { name: 'All services' })).toHaveAttribute('href', '/services')
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()

    answer(json({ service: PORTRAITS }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Portraits' })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(sent).toEqual([`${API}/portraits`])
  })

  it('renders the not-found page for a slug the API answers 404 -- unknown or deactivated', async () => {
    const sent = stubApi()
    renderAt('/services/events')

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByText('That page does not exist.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
    expect(sent).toEqual([`${API}/events`])
  })

  it('encodes the slug into the request path', async () => {
    const sent = stubApi()
    renderAt('/services/a%3Fb')

    await screen.findByRole('heading', { name: 'Page not found' })
    expect(sent).toEqual([`${API}/a%3Fb`])
  })

  it('shows an alert when the API fails, and loads again on "Try again"', async () => {
    let calls = 0
    const sent = stubApi({
      [`${API}/portraits`]: () => (++calls === 1 ? json({ error: 'internal_error' }, 500) : json({ service: PORTRAITS })),
    })
    renderAt('/services/portraits')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load this service. Check your connection and try again.')
    // A failure is not a 404: the page does not claim the service is gone.
    expect(screen.queryByRole('heading', { name: 'Page not found' })).not.toBeInTheDocument()

    await user().click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Portraits' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(sent).toEqual([`${API}/portraits`, `${API}/portraits`])
  })

  it('shows the alert when the network is down', async () => {
    stubApi({ [`${API}/portraits`]: () => Promise.reject(new TypeError('Failed to fetch')) })
    renderAt('/services/portraits')

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this service.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('shows loading, not the previous service, while moving to another service', async () => {
    let answer: (res: Response) => void = () => {}
    stubApi({ [`${API}/weddings`]: () => new Promise<Response>((resolve) => (answer = resolve)) })
    const router = await renderLoaded(PORTRAITS)
    await user().click(packageRadio('Standard'))

    await router.navigate('/services/weddings')

    expect(await screen.findByRole('status')).toHaveTextContent('Loading…')
    expect(screen.queryByRole('heading', { level: 1, name: 'Portraits' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()

    answer(json({ service: WEDDINGS }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Weddings' })).toBeInTheDocument()
    // A fresh page: nothing carried over from Portraits.
    expect(packageRadio('Standard')).not.toBeChecked()
    expect(within(summary()).getByText(PROMPT)).toBeInTheDocument()
  })
})

// --- Rendering ------------------------------------------------------------------------------

describe('the service page', () => {
  it('renders the service, a radio per package and a checkbox per add-on, with nothing chosen', async () => {
    stubApi()
    await renderLoaded()

    expect(screen.getByText('Studio portraits.')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Choose a package' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Add-ons (optional)' })).toBeInTheDocument()

    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(4)
    for (const radio of radios) expect(radio).not.toBeChecked()
    // One group: choosing one package un-chooses the others.
    expect(new Set(radios.map((radio) => radio.getAttribute('name'))).size).toBe(1)

    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes).toHaveLength(2)
    for (const checkbox of checkboxes) expect(checkbox).not.toBeChecked()

    expect(within(summary()).getByText(PROMPT)).toBeInTheDocument()
    expect(summary()).not.toHaveTextContent(/RWF/)
  })

  it('shows the non-refundable notice before anything is chosen, and keeps it after', async () => {
    stubApi()
    await renderLoaded()

    expect(within(summary()).getByText(NOTICE)).toBeVisible()

    await user().click(packageRadio('Standard'))
    await user().click(addonCheckbox('Extra hour'))

    expect(within(summary()).getByText(NOTICE)).toBeVisible()
  })

  it('reads each package’s price, photos and duration in words', async () => {
    stubApi()
    await renderLoaded()

    // The board's card reads name, then meta and price below it (the price is
    // no longer on the name's own row): updated 2026-09-27 for the restyle.
    expect(packageRadio('Mini').closest('label')).toHaveTextContent('Mini1 photo · 45 min25,000 RWF')
    expect(packageRadio('Standard').closest('label')).toHaveTextContent('Standard20 photos · 1 h 30 minOne look, one location.40,000 RWF')
    expect(packageRadio('Extended').closest('label')).toHaveTextContent('Extended2 photos · 2 hours60,000 RWF')
    expect(packageRadio('Quick').closest('label')).toHaveTextContent('Quick0 photos · 1 hour15,000 RWF')
    expect(addonCheckbox('Extra hour').closest('label')).toHaveTextContent('Extra hour10,000 RWF')
    expect(addonCheckbox('Rush edit').closest('label')).toHaveTextContent('Rush edit5,000 RWF')
  })

  it('names each radio and checkbox by its row, so a screen reader hears what is chosen', async () => {
    stubApi()
    await renderLoaded()

    expect(screen.getByRole('radio', { name: /Standard.*40,000 RWF/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Extra hour.*10,000 RWF/ })).toBeInTheDocument()
  })

  it('says so when the service has no packages, and offers nothing to choose or pay', async () => {
    stubApi()
    await renderLoaded(PRODUCTS)

    expect(screen.getByText('No packages are available for this service right now.')).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Price summary' })).not.toBeInTheDocument()
  })

  it('omits the add-on group for a service without add-ons', async () => {
    stubApi({ [`${API}/weddings`]: () => json({ service: { ...WEDDINGS, addons: [] } }) })
    await renderLoaded(WEDDINGS)

    expect(screen.queryByRole('group', { name: 'Add-ons (optional)' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(1)
  })

  it('links back to the list', async () => {
    stubApi()
    const router = await renderLoaded()

    await user().click(screen.getByRole('link', { name: 'All services' }))

    expect(await screen.findByRole('link', { name: 'Weddings' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/services')
  })

  it('never mentions a processing fee, whatever is chosen', async () => {
    stubApi()
    await renderLoaded()
    const u = user()

    expect(document.body).not.toHaveTextContent(/processing/i)
    await u.click(packageRadio('Standard'))
    await u.click(addonCheckbox('Extra hour'))
    await u.click(addonCheckbox('Rush edit'))
    expect(document.body).not.toHaveTextContent(/processing/i)
  })
})

// --- The live total (plan.md Task 11) ------------------------------------------------------------

describe('the price summary', () => {
  it('shows 50,000 total, 20,000 now at 40% and 30,000 after for Standard plus a 10,000 add-on', async () => {
    stubApi()
    await renderLoaded()
    const u = user()

    await u.click(packageRadio('Standard'))

    expect(packageRadio('Standard')).toBeChecked()
    expect(lines()).toEqual([
      ['Standard', '40,000 RWF'],
      ['Total', '40,000 RWF'],
      ['Booking fee (40%), paid now to secure your date', '16,000 RWF'],
      ['Session fee, due after the shoot', '24,000 RWF'],
    ])

    await u.click(addonCheckbox('Extra hour'))

    expect(addonCheckbox('Extra hour')).toBeChecked()
    expect(lines()).toEqual([
      ['Standard', '40,000 RWF'],
      ['Extra hour', '10,000 RWF'],
      ['Total', '50,000 RWF'],
      ['Booking fee (40%), paid now to secure your date', '20,000 RWF'],
      ['Session fee, due after the shoot', '30,000 RWF'],
    ])
  })

  it('updates when an add-on is unticked and when the package is switched', async () => {
    stubApi()
    await renderLoaded()
    const u = user()
    await u.click(packageRadio('Standard'))
    await u.click(addonCheckbox('Extra hour'))
    await u.click(addonCheckbox('Rush edit'))
    expect(totals()).toEqual({
      total: '55,000 RWF',
      bookingFee: ['Booking fee (40%), paid now to secure your date', '22,000 RWF'],
      sessionFee: '33,000 RWF',
    })

    await u.click(addonCheckbox('Rush edit'))

    expect(addonCheckbox('Rush edit')).not.toBeChecked()
    expect(totals()).toMatchObject({ total: '50,000 RWF', sessionFee: '30,000 RWF' })
    expect(within(summary()).queryByText('Rush edit')).not.toBeInTheDocument()

    await u.click(packageRadio('Extended'))

    expect(packageRadio('Extended')).toBeChecked()
    expect(packageRadio('Standard')).not.toBeChecked()
    expect(lines().slice(0, 2)).toEqual([
      ['Extended', '60,000 RWF'],
      ['Extra hour', '10,000 RWF'],
    ])
    expect(totals()).toEqual({
      total: '70,000 RWF',
      bookingFee: ['Booking fee (40%), paid now to secure your date', '28,000 RWF'],
      sessionFee: '42,000 RWF',
    })

    await u.click(addonCheckbox('Extra hour'))

    expect(totals()).toMatchObject({ total: '60,000 RWF', sessionFee: '36,000 RWF' })
    expect(lines()).toHaveLength(4)
  })

  it('shows 15,000 now at 30% and 35,000 after on the same 50,000 basket for a service overriding the rate', async () => {
    stubApi()
    await renderLoaded(WEDDINGS)
    const u = user()

    await u.click(packageRadio('Standard'))
    await u.click(addonCheckbox('Second shooter'))

    expect(totals()).toEqual({
      total: '50,000 RWF',
      bookingFee: ['Booking fee (30%), paid now to secure your date', '15,000 RWF'],
      sessionFee: '35,000 RWF',
    })
  })

  it('does not price add-ons ticked before a package is chosen, then includes them once it is', async () => {
    stubApi()
    await renderLoaded()
    const u = user()

    await u.click(addonCheckbox('Extra hour'))

    expect(addonCheckbox('Extra hour')).toBeChecked()
    expect(within(summary()).getByText(PROMPT)).toBeInTheDocument()
    expect(summary()).not.toHaveTextContent(/RWF/)

    await u.click(packageRadio('Mini'))

    expect(within(summary()).queryByText(PROMPT)).not.toBeInTheDocument()
    expect(totals()).toMatchObject({ total: '35,000 RWF', sessionFee: '21,000 RWF' })
  })

  it('lists the chosen add-ons in catalogue order, whatever order they were ticked in', async () => {
    stubApi()
    await renderLoaded()
    const u = user()

    await u.click(packageRadio('Mini'))
    await u.click(addonCheckbox('Rush edit'))
    await u.click(addonCheckbox('Extra hour'))

    expect(lines().slice(0, 3).map(([term]) => term)).toEqual(['Mini', 'Extra hour', 'Rush edit'])
  })

  it('can be driven by keyboard: arrow keys choose a package, Space ticks an add-on', async () => {
    stubApi()
    await renderLoaded()
    const u = user()

    await u.click(packageRadio('Mini'))
    await u.keyboard('{ArrowDown}')

    expect(packageRadio('Standard')).toBeChecked()
    expect(packageRadio('Standard')).toHaveFocus()

    addonCheckbox('Extra hour').focus()
    await u.keyboard(' ')

    expect(addonCheckbox('Extra hour')).toBeChecked()
    expect(totals()).toMatchObject({ total: '50,000 RWF', sessionFee: '30,000 RWF' })
  })
})

// --- The slot picker (plan.md Task 12) ------------------------------------------------------------

describe('the slot picker on the service page', () => {
  /** 08:00 on Thursday 1 October 2026 in Kigali. */
  const NOW = new Date('2026-10-01T06:00:00Z')
  const WEDNESDAY = 'Wednesday, 7 October 2026'

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function availabilityRequests(sent: string[]): [string | null, string | null][] {
    return sent
      .filter((url) => url.startsWith('/api/availability?'))
      .map((url) => {
        const query = new URLSearchParams(url.slice(url.indexOf('?') + 1))
        return [query.get('packageId'), query.get('month')]
      })
  }

  function listedTimes(): string[] {
    // Scoped to the page: the client shell's footer nav is a list too (2026-09-21).
    return within(within(screen.getByRole('main')).getByRole('list')).getAllByRole('button').map((button) => button.textContent ?? '')
  }

  it('says to choose a package first, and asks for no availability until one is chosen', async () => {
    const sent = stubApi()
    await renderLoaded()

    expect(screen.getByRole('heading', { level: 2, name: 'Choose a date and time' })).toBeInTheDocument()
    expect(screen.getByText('Choose a package to see available times.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next month' })).not.toBeInTheDocument()

    await user().click(addonCheckbox('Extra hour'))

    expect(availabilityRequests(sent)).toEqual([])
  })

  it('requests the chosen package’s month and offers its dates', async () => {
    const sent = stubApi()
    await renderLoaded()

    await user().click(packageRadio('Standard'))

    expect(await screen.findByRole('button', { name: `${WEDNESDAY}, 3 times available` })).toBeEnabled()
    expect(screen.queryByText('Choose a package to see available times.')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Choose a date and time' })).toBeInTheDocument()
    expect(availabilityRequests(sent)).toEqual([['p2', '2026-10']])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('asks again for a longer package, keeps the date, and shows its fewer starts', async () => {
    const sent = stubApi()
    await renderLoaded()
    const u = user()
    await u.click(packageRadio('Mini'))
    await u.click(await screen.findByRole('button', { name: `${WEDNESDAY}, 5 times available` }))
    expect(listedTimes()).toEqual(['09:00', '09:30', '10:00', '10:30', '14:00'])

    await u.click(packageRadio('Extended'))

    expect(await screen.findByRole('button', { name: `${WEDNESDAY}, 2 times available` })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { level: 3, name: `Start times on ${WEDNESDAY}` })).toBeInTheDocument()
    expect(listedTimes()).toEqual(['09:00', '09:30'])
    expect(availabilityRequests(sent)).toEqual([
      ['p1', '2026-10'],
      ['p3', '2026-10'],
    ])
  })

  it('ends the chosen start at the chosen package’s duration, and follows a switch of package', async () => {
    stubApi()
    await renderLoaded()
    const u = user()
    await u.click(packageRadio('Standard'))
    await u.click(await screen.findByRole('button', { name: `${WEDNESDAY}, 3 times available` }))

    await u.click(screen.getByRole('button', { name: '09:30' }))

    expect(await screen.findByText(`Selected: ${WEDNESDAY}, 09:30 to 11:00, Kigali time`)).toBeInTheDocument()

    // Extended still offers 09:30, so the choice stands and runs to 11:30.
    await u.click(packageRadio('Extended'))

    expect(await screen.findByText(`Selected: ${WEDNESDAY}, 09:30 to 11:30, Kigali time`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '09:30' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('drops the chosen start when the new package cannot have it', async () => {
    stubApi()
    await renderLoaded()
    const u = user()
    await u.click(packageRadio('Mini'))
    await u.click(await screen.findByRole('button', { name: `${WEDNESDAY}, 5 times available` }))
    await u.click(screen.getByRole('button', { name: '14:00' }))
    await screen.findByText(/^Selected: /)

    await u.click(packageRadio('Extended'))

    await screen.findByRole('button', { name: `${WEDNESDAY}, 2 times available` })
    await waitFor(() => expect(screen.queryByText(/^Selected: /)).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '14:00' })).not.toBeInTheDocument()
  })
})

// --- Booking creation (plan.md Task 13) ---------------------------------------------------------

describe('booking from the service page', () => {
  /** 08:00 on Thursday 1 October 2026 in Kigali. */
  const NOW = new Date('2026-10-01T06:00:00Z')
  const WEDNESDAY = 'Wednesday, 7 October 2026'
  const HINT = 'Choose a date and time to continue.'
  const JUST_TAKEN = 'Sorry, that time was just taken. The calendar has been refreshed, so please choose another time.'
  const FAILED = 'Your booking did not go through. Check your connection and try again.'
  const CATALOGUE_CHANGED = 'Something you chose is no longer available. Reload the page to see what is on offer now.'
  const CONSENT = 'I agree that Bookly may use these details to arrange and deliver my booking.'
  const BOOKINGS = '/api/bookings'
  /** 09:30 Kigali on Wednesday 7 October. */
  const NINE_THIRTY = '2026-10-07T07:30:00.000Z'
  const TWO_PM = '2026-10-07T12:00:00.000Z'

  /**
   * What the API answers. The amounts are deliberately NOT what this browser
   * would compute for Standard + Extra hour at 40% (50,000 / 20,000 / 30,000):
   * the held page must show these.
   */
  const HELD: HeldBooking = {
    reference: 'BKY-2610-7K3QX',
    status: 'pending_payment',
    startsAt: NINE_THIRTY,
    endsAt: '2026-10-07T09:00:00.000Z',
    holdExpiresAt: '2026-10-01T06:30:00.000Z',
    serviceName: 'Portraits',
    packageName: 'Standard',
    packagePriceRwf: 42_000,
    addons: [{ name: 'Extra hour', priceRwf: 10_000 }],
    totalRwf: 52_000,
    bookingFeeRate: 0.375,
    bookingFeeRwf: 19_500,
    sessionFeeRwf: 32_500,
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  type Reply = () => Response | Promise<Response>

  /**
   * The API with `POST /api/bookings` answering `replies` in turn (repeating
   * the last), and Standard's October availability leaving out any start in
   * `taken` -- which a reply can fill, the way a rival booking would.
   */
  function stubBookingApi(...replies: Reply[]) {
    const posts: { body: Record<string, unknown>; init: RequestInit }[] = []
    const taken = new Set<string>()
    let count = 0
    const sent = stubApi({
      [BOOKINGS]: (init = {}) => {
        posts.push({ body: JSON.parse(String(init.body)) as Record<string, unknown>, init })
        const reply = replies[Math.min(count++, replies.length - 1)]
        if (reply === undefined) throw new Error('No booking reply scripted')
        return reply()
      },
      '/api/availability?packageId=p2&month=2026-10': () =>
        json({
          days: availabilityFor('p2', '2026-10').map((day) => ({ ...day, starts: day.starts.filter((start) => !taken.has(start)) })),
        }),
    })
    return { sent, posts, taken }
  }

  function availabilityLoads(sent: string[]): number {
    return sent.filter((url) => url.startsWith('/api/availability?')).length
  }

  function deferredResponse() {
    let resolve: (res: Response) => void = () => {}
    const promise = new Promise<Response>((res) => (resolve = res))
    return { promise, resolve }
  }

  const LABELS = {
    fullName: 'Full name',
    email: 'Email',
    phone: 'Phone number',
    location: 'Shoot location',
    partySize: 'Number of people',
    specialRequests: 'Special requests',
  } as const

  type TextField = keyof typeof LABELS

  function field(name: TextField): HTMLElement {
    return screen.getByRole('textbox', { name: LABELS[name] })
  }

  function consentBox(): HTMLElement {
    return screen.getByRole('checkbox', { name: CONSENT })
  }

  function confirmButton(): HTMLElement {
    return within(summary()).getByRole('button', { name: /^(Confirm booking|Booking…)$/ })
  }

  async function chooseStart(u: ReturnType<typeof user>, time = '09:30') {
    await u.click(packageRadio('Standard'))
    await u.click(await screen.findByRole('button', { name: /^Wednesday, 7 October 2026, \d+ times? available$/ }))
    await u.click(screen.getByRole('button', { name: time }))
    await screen.findByText(new RegExp(`^Selected: ${WEDNESDAY}, ${time} to`))
  }

  async function fillForm(u: ReturnType<typeof user>, values: Partial<Record<TextField, string>> = {}, consent = true) {
    const all: Record<TextField, string> = {
      fullName: 'Aline Uwase',
      email: 'aline@example.com',
      phone: '078 812 3456',
      location: 'Kigali Heights',
      partySize: '3',
      specialRequests: '',
      ...values,
    }
    for (const name of Object.keys(LABELS) as TextField[]) {
      if (all[name] !== '') await u.type(field(name), all[name])
    }
    if (consent) await u.click(consentBox())
  }

  it('offers no Confirm until a start is chosen, and says so', async () => {
    stubBookingApi(() => json({ booking: HELD }, 201))
    await renderLoaded()
    const u = user()

    expect(screen.queryByRole('form', { name: 'Your details' })).not.toBeInTheDocument()
    expect(within(summary()).queryByText(HINT)).not.toBeInTheDocument()

    await u.click(packageRadio('Standard'))

    expect(screen.getByRole('form', { name: 'Your details' })).toBeInTheDocument()
    expect(within(summary()).getByText(HINT)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm booking' })).not.toBeInTheDocument()

    await u.click(await screen.findByRole('button', { name: `${WEDNESDAY}, 3 times available` }))
    expect(screen.queryByRole('button', { name: 'Confirm booking' })).not.toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: '09:30' }))

    const button = await within(summary()).findByRole('button', { name: 'Confirm booking' })
    expect(button).toHaveAttribute('type', 'submit')
    expect(button).toHaveAttribute('form', screen.getByRole('form', { name: 'Your details' }).id)
    expect(button).toHaveAttribute('aria-disabled', 'false')
    expect(within(summary()).queryByText(HINT)).not.toBeInTheDocument()
  })

  it('puts the non-refundable notice before Confirm in reading order', async () => {
    stubBookingApi(() => json({ booking: HELD }, 201))
    await renderLoaded()
    await chooseStart(user())

    const notice = within(summary()).getByText(NOTICE)
    expect(notice.compareDocumentPosition(confirmButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('marks what is wrong, focuses the first, and sends nothing', async () => {
    const { posts } = stubBookingApi(() => json({ booking: HELD }, 201))
    await renderLoaded()
    const u = user()
    await chooseStart(u)
    await u.type(field('location'), 'Kigali Heights')
    await u.type(field('partySize'), '0')

    await u.click(confirmButton())

    for (const name of ['fullName', 'email', 'phone', 'partySize'] as const) expect(field(name)).toHaveAttribute('aria-invalid', 'true')
    expect(consentBox()).toHaveAttribute('aria-invalid', 'true')
    expect(field('location')).not.toHaveAttribute('aria-invalid')
    expect(field('specialRequests')).not.toHaveAttribute('aria-invalid')
    expect(field('fullName')).toHaveFocus()
    expect(field('fullName')).toHaveAccessibleDescription('Enter your full name.')
    expect(screen.getByText('Tick the box to agree before you book.')).toBeInTheDocument()
    expect(posts).toHaveLength(0)

    // Fix everything but consent: only consent stays marked, and takes focus.
    await u.type(field('fullName'), 'Aline Uwase')
    await u.type(field('email'), 'aline@example.com')
    await u.type(field('phone'), '0788123456')
    await u.clear(field('partySize'))
    await u.click(confirmButton())

    expect(consentBox()).toHaveAttribute('aria-invalid', 'true')
    expect(consentBox()).toHaveFocus()
    for (const name of Object.keys(LABELS) as TextField[]) expect(field(name)).not.toHaveAttribute('aria-invalid')
    expect(posts).toHaveLength(0)
  })

  it('sends ids, the chosen start and the form -- add-ons in catalogue order, no amounts', async () => {
    const { posts } = stubBookingApi(() => json({ booking: HELD }, 201))
    await renderLoaded()
    const u = user()
    await u.click(addonCheckbox('Rush edit'))
    await u.click(addonCheckbox('Extra hour'))
    await chooseStart(u)
    await fillForm(u, { fullName: '  Aline Uwase  ', email: ' aline@example.com ', partySize: '', specialRequests: '   ' })

    await u.click(confirmButton())

    await screen.findByRole('heading', { level: 1, name: 'Your time is held' })
    expect(posts).toHaveLength(1)
    expect(posts[0]?.init.method).toBe('POST')
    expect(posts[0]?.body).toStrictEqual({
      packageId: 'p2',
      addonIds: ['a1', 'a2'],
      startsAt: NINE_THIRTY,
      fullName: 'Aline Uwase',
      email: 'aline@example.com',
      phone: '078 812 3456',
      location: 'Kigali Heights',
      partySize: null,
      specialRequests: null,
      consent: true,
    })
    expect(JSON.stringify(posts[0]?.body)).not.toMatch(/Rwf|total|fee|rate|price/i)
  })

  it('becomes the held booking: reference, Kigali time, the API’s amounts and rate, the hold, focus on the heading', async () => {
    stubBookingApi(() => json({ booking: HELD }, 201))
    await renderLoaded()
    const u = user()
    await u.click(addonCheckbox('Extra hour'))
    await chooseStart(u)
    await fillForm(u)
    // The browser's own quote, which the held page must not repeat.
    expect(totals()).toMatchObject({ total: '50,000 RWF', sessionFee: '30,000 RWF' })

    await u.click(confirmButton())

    const heading = await screen.findByRole('heading', { level: 1, name: 'Your time is held' })
    await waitFor(() => expect(heading).toHaveFocus())
    const held = Array.from(document.querySelectorAll('dt')).map((term) => [term.textContent, term.nextElementSibling?.textContent])
    expect(held).toEqual([
      ['Booking reference', 'BKY-2610-7K3QX'],
      ['Service', 'Portraits, Standard'],
      ['When', `${WEDNESDAY}, 09:30 to 11:00, Kigali time`],
      ['Standard', '42,000 RWF'],
      ['Extra hour', '10,000 RWF'],
      ['Total', '52,000 RWF'],
      ['Booking fee (37.5%), paid now to secure your date', '19,500 RWF'],
      ['Session fee, due after the shoot', '32,500 RWF'],
    ])
    expect(screen.getByText(/^We are holding this time for you until 08:30, Kigali time\. Pay the booking fee of 19,500 RWF/)).toBeInTheDocument()
    expect(screen.getByText(NOTICE)).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('50,000 RWF')
    expect(document.body).not.toHaveTextContent('20,000 RWF')
    // The form, the picker and the browser's quote are gone.
    expect(screen.queryByRole('form', { name: 'Your details' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Choose a date and time' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Price summary' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm booking' })).not.toBeInTheDocument()
  })

  it('on 409 shows the focused "just taken" alert over a refreshed calendar, clears the start, and keeps the form', async () => {
    const api = stubBookingApi(
      () => {
        // Another visitor's booking lands first.
        api.taken.add(NINE_THIRTY)
        return json({ error: 'slot_taken' }, 409)
      },
      () => json({ booking: { ...HELD, startsAt: TWO_PM, endsAt: '2026-10-07T13:30:00.000Z' } }, 201),
    )
    await renderLoaded()
    const u = user()
    await chooseStart(u)
    await fillForm(u, { specialRequests: 'Golden hour' })
    const loadsBefore = availabilityLoads(api.sent)

    await u.click(confirmButton())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(JUST_TAKEN)
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    // Refreshed: asked again after the refusal, and 09:30 is gone.
    await waitFor(() => expect(screen.getByRole('button', { name: `${WEDNESDAY}, 2 times available` })).toHaveAttribute('aria-pressed', 'true'))
    expect(availabilityLoads(api.sent)).toBeGreaterThan(loadsBefore)
    expect(api.sent.lastIndexOf('/api/availability?packageId=p2&month=2026-10')).toBeGreaterThan(api.sent.indexOf(BOOKINGS))
    expect(screen.queryByRole('button', { name: '09:30' })).not.toBeInTheDocument()
    // The start is cleared, so Confirm is gone until another is chosen.
    expect(screen.queryByText(/^Selected: /)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm booking' })).not.toBeInTheDocument()
    expect(within(summary()).getByText(HINT)).toBeInTheDocument()
    // What was typed is still there.
    expect(field('fullName')).toHaveValue('Aline Uwase')
    expect(field('email')).toHaveValue('aline@example.com')
    expect(field('phone')).toHaveValue('078 812 3456')
    expect(field('location')).toHaveValue('Kigali Heights')
    expect(field('partySize')).toHaveValue('3')
    expect(field('specialRequests')).toHaveValue('Golden hour')
    expect(consentBox()).toBeChecked()
    expect(field('fullName')).not.toHaveAttribute('aria-invalid')

    // Another start, and the same form goes through without retyping.
    await u.click(screen.getByRole('button', { name: '14:00' }))
    await u.click(await within(summary()).findByRole('button', { name: 'Confirm booking' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Your time is held' })).toBeInTheDocument()
    expect(api.posts.map(({ body }) => body.startsAt)).toEqual([NINE_THIRTY, TWO_PM])
    expect(api.posts[1]?.body).toMatchObject({ fullName: 'Aline Uwase', specialRequests: 'Golden hour', consent: true })
  })

  it('treats a 422 on startsAt exactly as a taken start', async () => {
    const api = stubBookingApi(() => {
      api.taken.add(NINE_THIRTY)
      return json({ error: 'validation_failed', fields: ['startsAt'] }, 422)
    })
    await renderLoaded()
    const u = user()
    await chooseStart(u)
    await fillForm(u)
    const loadsBefore = availabilityLoads(api.sent)

    await u.click(confirmButton())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(JUST_TAKEN)
    await waitFor(() => expect(alert).toHaveFocus())
    await waitFor(() => expect(screen.getByRole('button', { name: `${WEDNESDAY}, 2 times available` })).toBeInTheDocument())
    expect(availabilityLoads(api.sent)).toBeGreaterThan(loadsBefore)
    expect(screen.queryByText(/^Selected: /)).not.toBeInTheDocument()
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
    expect(field('fullName')).toHaveValue('Aline Uwase')
    expect(consentBox()).toBeChecked()
  })

  it('marks the fields a 422 names, focuses the first in form order, and keeps the start', async () => {
    const { posts } = stubBookingApi(() => json({ error: 'validation_failed', fields: ['consent', 'phone', 'email'] }, 422))
    await renderLoaded()
    const u = user()
    await chooseStart(u)
    await fillForm(u)

    await u.click(confirmButton())

    await waitFor(() => expect(field('email')).toHaveAttribute('aria-invalid', 'true'))
    expect(field('phone')).toHaveAttribute('aria-invalid', 'true')
    expect(consentBox()).toHaveAttribute('aria-invalid', 'true')
    expect(field('fullName')).not.toHaveAttribute('aria-invalid')
    expect(field('email')).toHaveFocus()
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(screen.getByText(/^Selected: /)).toBeInTheDocument()
    expect(confirmButton()).toHaveTextContent('Confirm booking')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(posts).toHaveLength(1)
  })

  it.each(['addonIds', 'packageId'])('says the catalogue changed on a 422 naming %s, and keeps the page as it was', async (name) => {
    stubBookingApi(() => json({ error: 'validation_failed', fields: [name] }, 422))
    await renderLoaded()
    const u = user()
    await u.click(addonCheckbox('Extra hour'))
    await chooseStart(u)
    await fillForm(u)

    await u.click(confirmButton())

    expect(await within(summary()).findByRole('alert')).toHaveTextContent(CATALOGUE_CHANGED)
    expect(screen.queryByText(JUST_TAKEN)).not.toBeInTheDocument()
    expect(screen.getByText(/^Selected: /)).toBeInTheDocument()
    expect(field('fullName')).toHaveValue('Aline Uwase')
  })

  it('still says the catalogue changed when the same 422 also refuses the start, which clears it', async () => {
    stubBookingApi(() => json({ error: 'validation_failed', fields: ['addonIds', 'startsAt'] }, 422))
    await renderLoaded()
    const u = user()
    await u.click(addonCheckbox('Extra hour'))
    await chooseStart(u)
    await fillForm(u)

    await u.click(confirmButton())

    // The start is gone, so the Confirm button is too -- the reason must not go with it.
    expect(await screen.findByText(JUST_TAKEN)).toBeInTheDocument()
    expect(within(summary()).queryByRole('button', { name: 'Confirm booking' })).not.toBeInTheDocument()
    expect(within(summary()).getByRole('alert')).toHaveTextContent(CATALOGUE_CHANGED)
  })

  it('announces the four text fields and consent as required, and nothing optional as required', async () => {
    stubBookingApi()
    await renderLoaded()
    const u = user()
    await u.click(packageRadio('Standard'))

    for (const name of ['fullName', 'email', 'phone', 'location'] as const) expect(field(name)).toBeRequired()
    expect(consentBox()).toBeRequired()
    for (const name of ['partySize', 'specialRequests'] as const) expect(field(name)).not.toBeRequired()
  })

  it.each<[string, Reply]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 422 naming no field the page knows', () => json({ error: 'validation_failed', fields: ['somethingElse'] }, 422)],
    ['a 422 with no fields', () => json({ error: 'validation_failed', fields: [] }, 422)],
    ['a 400', () => json({ error: 'invalid_request' }, 400)],
  ])('says the booking did not go through on %s, and a retry can succeed', async (_label, failure) => {
    const { posts } = stubBookingApi(failure, () => json({ booking: HELD }, 201))
    await renderLoaded()
    const u = user()
    await chooseStart(u)
    await fillForm(u)

    await u.click(confirmButton())

    const alert = await within(summary()).findByRole('alert')
    expect(alert).toHaveTextContent(FAILED)
    expect(screen.getByText(/^Selected: /)).toBeInTheDocument()
    expect(confirmButton()).toHaveTextContent('Confirm booking')
    expect(confirmButton()).toHaveAttribute('aria-disabled', 'false')

    await u.click(confirmButton())

    expect(await screen.findByRole('heading', { level: 1, name: 'Your time is held' })).toBeInTheDocument()
    expect(posts).toHaveLength(2)
    expect(posts[1]?.body).toStrictEqual(posts[0]?.body)
  })

  it('clears a failure alert when the next attempt starts', async () => {
    const pending = deferredResponse()
    stubBookingApi(() => json({ error: 'internal_error' }, 500), () => pending.promise)
    await renderLoaded()
    const u = user()
    await chooseStart(u)
    await fillForm(u)
    await u.click(confirmButton())
    await within(summary()).findByRole('alert')

    await u.click(confirmButton())

    expect(within(summary()).queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => pending.resolve(json({ booking: HELD }, 201)))
    expect(await screen.findByRole('heading', { level: 1, name: 'Your time is held' })).toBeInTheDocument()
  })

  it('sends one request for a double press, and says it is working meanwhile', async () => {
    const pending = deferredResponse()
    const { posts } = stubBookingApi(() => pending.promise)
    await renderLoaded()
    const u = user()
    await chooseStart(u)
    await fillForm(u)

    await u.dblClick(confirmButton())
    await u.click(confirmButton())

    expect(posts).toHaveLength(1)
    const busy = confirmButton()
    expect(busy).toHaveTextContent('Booking…')
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    // Not `disabled`: focus stays on the control that was pressed.
    expect(busy).toBeEnabled()
    expect(busy).toHaveFocus()

    await act(async () => pending.resolve(json({ booking: HELD }, 201)))

    expect(await screen.findByRole('heading', { level: 1, name: 'Your time is held' })).toBeInTheDocument()
    expect(posts).toHaveLength(1)
  })

  it('submits from the keyboard: Enter on Confirm', async () => {
    const { posts } = stubBookingApi(() => json({ booking: HELD }, 201))
    await renderLoaded()
    const u = user()
    await chooseStart(u)
    await fillForm(u)

    confirmButton().focus()
    await u.keyboard('{Enter}')

    expect(await screen.findByRole('heading', { level: 1, name: 'Your time is held' })).toBeInTheDocument()
    expect(posts).toHaveLength(1)
  })

  it('keeps what was typed when the visitor switches package', async () => {
    stubBookingApi(() => json({ booking: HELD }, 201))
    await renderLoaded()
    const u = user()
    await u.click(packageRadio('Standard'))
    await u.type(field('fullName'), 'Aline Uwase')
    await u.click(consentBox())

    await u.click(packageRadio('Extended'))

    expect(field('fullName')).toHaveValue('Aline Uwase')
    expect(consentBox()).toBeChecked()
  })
})
