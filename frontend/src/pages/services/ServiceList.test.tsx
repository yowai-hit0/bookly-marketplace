import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { PublicService, PublicServiceDetail } from '@/catalogue/api'
import { routes } from '@/routes'

/**
 * The public service list (plan.md Task 11; spec §3.1 step 1), rendered through
 * the real routes with `fetch` stubbed.
 *
 * What is proven: it loads anonymously from `/api/services`; each service
 * renders its name as a link to its page and its lowest package price; what the
 * API lists is what renders, in its order; an empty catalogue and a failed load
 * each say so, and a failed load can be retried.
 */

const SERVICES_API = '/api/services'

// --- Fixtures ---------------------------------------------------------------

const PORTRAITS: PublicService = {
  id: 's1',
  slug: 'portraits',
  nameEn: 'Portraits',
  descriptionEn: 'Studio portraits.',
  coverImageUrl: 'https://images.example.com/portraits.jpg',
  // Not in price order, so "From" must find the lowest rather than the first.
  packages: [
    { id: 'p1', nameEn: 'Standard', descriptionEn: null, priceRwf: 45_000, photoCount: 20, durationMinutes: 60 },
    { id: 'p2', nameEn: 'Mini', descriptionEn: null, priceRwf: 25_000, photoCount: 5, durationMinutes: 30 },
    { id: 'p3', nameEn: 'Signature', descriptionEn: null, priceRwf: 1_250_000, photoCount: 80, durationMinutes: 240 },
  ],
  addons: [{ id: 'a1', nameEn: 'Extra hour', priceRwf: 10_000 }],
}

const WEDDINGS: PublicService = {
  id: 's2',
  slug: 'weddings',
  nameEn: 'Weddings',
  descriptionEn: null,
  coverImageUrl: 'https://images.example.com/weddings.jpg',
  packages: [{ id: 'p4', nameEn: 'Full day', descriptionEn: null, priceRwf: 600_000, photoCount: 300, durationMinutes: 480 }],
  addons: [],
}

const NEW_SERVICE: PublicService = {
  id: 's3',
  slug: 'products',
  nameEn: 'Product shots',
  descriptionEn: 'Coming soon.',
  coverImageUrl: null,
  packages: [],
  addons: [],
}

const PORTRAITS_DETAIL: PublicServiceDetail = { ...PORTRAITS, bookingFeeRate: 0.4 }

type Sent = { url: string; init: RequestInit }
type Route = () => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * A `fetch` for the public API. `routes` answers a URL; otherwise the list and
 * Portraits' page answer as the API would, and anything else is a 404.
 */
function stubApi(routes: Record<string, Route> = {}, services: PublicService[] = [PORTRAITS, WEDDINGS, NEW_SERVICE]) {
  const sent: Sent[] = []
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    sent.push({ url, init })
    const route = routes[url]
    if (route !== undefined) return route()
    if (url === SERVICES_API) return json({ services })
    if (url === `${SERVICES_API}/portraits`) return json({ service: PORTRAITS_DETAIL })
    return json({ error: 'not_found' }, 404)
  })
  vi.stubGlobal('fetch', mock)
  return sent
}

function renderAt(path = '/services') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

/**
 * The page itself, without the client shell's header and footer (2026-09-21).
 * Link, list and listitem counts are about the service list, not the chrome
 * that now sits above and below it.
 */
function main() {
  return within(screen.getByRole('main'))
}

/** The card of a listed service, found by its heading link. */
function card(name: string): HTMLElement {
  const article = screen.getByRole('link', { name }).closest('article')
  if (article === null) throw new Error(`No card for ${name}`)
  return article
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// --- Rendering ------------------------------------------------------------------------

describe('the service list', () => {
  it('shows a loading status until the services arrive', async () => {
    let answer: (res: Response) => void = () => {}
    stubApi({ [SERVICES_API]: () => new Promise<Response>((resolve) => (answer = resolve)) })
    renderAt()

    expect(screen.getByRole('heading', { level: 1, name: 'Services' })).toBeInTheDocument()
    expect(await screen.findByRole('status')).toHaveTextContent('Loading…')
    expect(main().queryByRole('link')).not.toBeInTheDocument()

    answer(json({ services: [PORTRAITS] }))

    expect(await screen.findByRole('link', { name: 'Portraits' })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows placeholder cards while loading, hidden from assistive technology, then the real cards (2026-09-25)', async () => {
    let answer: (res: Response) => void = () => {}
    stubApi({ [SERVICES_API]: () => new Promise<Response>((resolve) => (answer = resolve)) })
    renderAt()

    const skeletons = await screen.findByTestId('service-skeletons')
    expect(skeletons).toHaveAttribute('aria-hidden', 'true')
    expect(skeletons.querySelectorAll('li')).toHaveLength(3)
    expect(skeletons.closest('[aria-busy="true"]')).not.toBeNull()
    // Decoration only: nothing in it can be reached or read.
    expect(skeletons.querySelectorAll('a, button, h2')).toHaveLength(0)
    expect(skeletons.textContent).toBe('')

    answer(json({ services: [PORTRAITS] }))

    expect(await screen.findByRole('link', { name: 'Portraits' })).toBeInTheDocument()
    expect(screen.queryByTestId('service-skeletons')).not.toBeInTheDocument()
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('renders each service’s name as a link to its page, with its description and lowest price', async () => {
    stubApi()
    renderAt()

    expect(await screen.findByRole('link', { name: 'Portraits' })).toHaveAttribute('href', '/services/portraits')
    expect(screen.getByRole('link', { name: 'Weddings' })).toHaveAttribute('href', '/services/weddings')
    expect(screen.getByRole('link', { name: 'Product shots' })).toHaveAttribute('href', '/services/products')

    expect(card('Portraits')).toHaveTextContent('Studio portraits.')
    expect(within(card('Portraits')).getByText('From 25,000 RWF')).toBeInTheDocument()
    expect(within(card('Weddings')).getByText('From 600,000 RWF')).toBeInTheDocument()
  })

  it('shows no "From" price for a service without packages', async () => {
    stubApi()
    renderAt()

    await screen.findByRole('link', { name: 'Product shots' })
    expect(card('Product shots')).toHaveTextContent('Coming soon.')
    expect(card('Product shots')).not.toHaveTextContent(/From|RWF|Infinity|NaN/)
  })

  it('renders what the API lists, in its order, one card and one link each', async () => {
    stubApi({}, [WEDDINGS, NEW_SERVICE, PORTRAITS])
    renderAt()

    await screen.findByRole('link', { name: 'Portraits' })
    expect(main().getAllByRole('listitem')).toHaveLength(3)
    expect(main().getAllByRole('link').map((link) => link.textContent)).toEqual(['Weddings', 'Product shots', 'Portraits'])
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Weddings',
      'Product shots',
      'Portraits',
    ])
  })

  it('loads the first cover image eagerly and the rest lazily', async () => {
    stubApi()
    const { container } = render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/services'] })} />)

    await screen.findByRole('link', { name: 'Portraits' })
    const images = Array.from(container.querySelectorAll('img'))
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      'https://images.example.com/portraits.jpg',
      'https://images.example.com/weddings.jpg',
    ])
    expect(images.map((image) => image.getAttribute('loading'))).toEqual(['eager', 'lazy'])
    // Decorative: the link carries the name.
    expect(images.map((image) => image.getAttribute('alt'))).toEqual(['', ''])
  })

  it('says so when no service is available', async () => {
    stubApi({}, [])
    renderAt()

    expect(await screen.findByText('No services are available to book right now.')).toBeInTheDocument()
    expect(main().queryByRole('list')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('never mentions a processing fee', async () => {
    stubApi()
    renderAt()

    await screen.findByRole('link', { name: 'Portraits' })
    expect(document.body).not.toHaveTextContent(/processing/i)
  })
})

// --- The request -----------------------------------------------------------------------------

describe('loading the list', () => {
  it('fetches /api/services once, anonymously, asking for JSON', async () => {
    const sent = stubApi()
    renderAt()

    await screen.findByRole('link', { name: 'Portraits' })
    expect(sent.map((request) => request.url)).toEqual([SERVICES_API])
    const [request] = sent
    const headers = new Headers(request?.init.headers)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.has('Authorization')).toBe(false)
    expect(request?.init.method ?? 'GET').toBe('GET')
    expect(request?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('shows an alert when the API fails, and loads again on "Try again"', async () => {
    let calls = 0
    const sent = stubApi({
      [SERVICES_API]: () => (++calls === 1 ? json({ error: 'internal_error' }, 500) : json({ services: [PORTRAITS] })),
    })
    renderAt()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load services. Check your connection and try again.')
    expect(main().queryByRole('link')).not.toBeInTheDocument()

    await user().click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('link', { name: 'Portraits' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(sent.filter((request) => request.url === SERVICES_API)).toHaveLength(2)
  })

  it('shows the loading status again while a retry is in flight', async () => {
    let answer: (res: Response) => void = () => {}
    let calls = 0
    stubApi({
      [SERVICES_API]: () =>
        ++calls === 1 ? json({}, 503) : new Promise<Response>((resolve) => (answer = resolve)),
    })
    renderAt()

    await user().click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Loading…')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    answer(json({ services: [] }))
    expect(await screen.findByText('No services are available to book right now.')).toBeInTheDocument()
  })

  it('shows the alert when the network is down, not only on an error status', async () => {
    stubApi({ [SERVICES_API]: () => Promise.reject(new TypeError('Failed to fetch')) })
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load services.')
  })
})

// --- Navigation ------------------------------------------------------------------------------

describe('from the list', () => {
  it('opens a service’s page when its link is followed', async () => {
    const sent = stubApi()
    const router = renderAt()

    await user().click(await screen.findByRole('link', { name: 'Portraits' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Portraits' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/services/portraits')
    expect(sent.map((request) => request.url)).toEqual([SERVICES_API, `${SERVICES_API}/portraits`])
    expect(screen.getByRole('radio', { name: /^Mini/ })).toBeInTheDocument()
  })
})
