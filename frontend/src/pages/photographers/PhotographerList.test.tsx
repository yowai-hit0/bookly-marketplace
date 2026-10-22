import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { PublicPhotographerSummary } from '@/catalogue/api'
import { routes } from '@/routes'

/**
 * The photographers list (brief decision 9), rendered through the real routes
 * with `fetch` stubbed.
 *
 * What is proven: it loads anonymously from `/api/photographers`; each
 * photographer is a card whose name links to `/p/:handle`, in the API's order;
 * a cover reaches an `src` only when it is an `https:` URL; and the loading,
 * empty and failed states each say so, a failure with a retry.
 */

const API = '/api/photographers'

const PHOTOGRAPHERS: PublicPhotographerSummary[] = [
  { handle: 'kigali-lens', displayName: 'Kigali Lens', coverImageUrl: 'https://images.example.com/kigali.jpg', takingBookings: true },
  { handle: 'nyamirambo-light', displayName: 'Nyamirambo Light', coverImageUrl: null, takingBookings: true },
  { handle: 'umuganda-studio', displayName: 'Umuganda Studio', coverImageUrl: 'javascript:alert(1)', takingBookings: true },
  { handle: 'lake-kivu-frames', displayName: 'Lake Kivu Frames', coverImageUrl: 'http://images.example.com/kivu.jpg', takingBookings: true },
]

type Route = () => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubApi(route: Route = () => json({ photographers: PHOTOGRAPHERS })) {
  const sent: { url: string; init: RequestInit }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      sent.push({ url: String(input), init })
      return String(input) === API ? route() : json({ error: 'not_found' }, 404)
    }),
  )
  return sent
}

function renderPage() {
  const router = createMemoryRouter(routes, { initialEntries: ['/photographers'] })
  const view = render(<RouterProvider router={router} />)
  return { router, ...view }
}

function main() {
  return within(screen.getByRole('main'))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the photographers list', () => {
  it('fetches /api/photographers once, anonymously, and links each card to that photographer’s page, in order', async () => {
    const sent = stubApi()
    renderPage()

    expect(await main().findByRole('link', { name: 'Kigali Lens' })).toHaveAttribute('href', '/p/kigali-lens')
    expect(screen.getByRole('heading', { level: 1, name: 'Photographers' })).toBeInTheDocument()
    expect(main().getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Kigali Lens',
      'Nyamirambo Light',
      'Umuganda Studio',
      'Lake Kivu Frames',
    ])
    expect(main().getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/p/kigali-lens',
      '/p/nyamirambo-light',
      '/p/umuganda-studio',
      '/p/lake-kivu-frames',
    ])
    expect(sent.map((request) => request.url)).toEqual([API])
    expect(new Headers(sent[0]?.init.headers).has('Authorization')).toBe(false)
  })

  it('puts only an https cover in an src: another scheme gets the quiet camera block', async () => {
    stubApi()
    const { container } = renderPage()

    await main().findByRole('link', { name: 'Kigali Lens' })
    const images = Array.from(container.querySelectorAll('img'))
    expect(images.map((image) => image.getAttribute('src'))).toEqual(['https://images.example.com/kigali.jpg'])
    expect(images[0]).toHaveAttribute('alt', '')
    expect(container.innerHTML).not.toContain('javascript:')
    expect(container.innerHTML).not.toContain('http://images.example.com')
  })

  it('shows placeholder cards and a status while loading', async () => {
    let answer: (res: Response) => void = () => {}
    stubApi(() => new Promise<Response>((resolve) => (answer = resolve)))
    renderPage()

    expect(await screen.findByRole('status')).toHaveTextContent('Loading…')
    expect(screen.getByTestId('service-skeletons')).toHaveAttribute('aria-hidden', 'true')

    answer(json({ photographers: PHOTOGRAPHERS }))

    expect(await main().findByRole('link', { name: 'Kigali Lens' })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says so when nobody can be booked', async () => {
    stubApi(() => json({ photographers: [] }))
    renderPage()

    expect(await screen.findByText('No photographers are available to book right now.')).toBeInTheDocument()
    expect(main().queryByRole('list')).not.toBeInTheDocument()
  })

  it('shows an alert when the API fails, and loads again on "Try again"', async () => {
    let calls = 0
    const sent = stubApi(() => (++calls === 1 ? json({ error: 'internal_error' }, 500) : json({ photographers: PHOTOGRAPHERS })))
    renderPage()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load photographers. Check your connection and try again.')

    await userEvent.setup({ delay: null }).click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await main().findByRole('link', { name: 'Kigali Lens' })).toBeInTheDocument()
    expect(sent).toHaveLength(2)
  })
})

describe('a photographer not taking bookings (Phase 5, R5.5)', () => {
  const PAST_DUE: PublicPhotographerSummary = { handle: 'past-due', displayName: 'Past Due Studio', coverImageUrl: null, takingBookings: false }

  it('is still listed, says "Not taking bookings right now", and still opens the profile', async () => {
    stubApi(() => json({ photographers: [PHOTOGRAPHERS[0], PAST_DUE] }))
    renderPage()

    const link = await main().findByRole('link', { name: 'Past Due Studio' })
    expect(link).toHaveAttribute('href', '/p/past-due')
    const card = link.closest('article') as HTMLElement
    expect(within(card).getByText('Not taking bookings right now')).toBeInTheDocument()
  })

  it('says nothing on the cards of those who are', async () => {
    stubApi(() => json({ photographers: [PHOTOGRAPHERS[0], PAST_DUE] }))
    renderPage()

    const link = await main().findByRole('link', { name: 'Kigali Lens' })
    const card = link.closest('article') as HTMLElement
    expect(within(card).queryByText('Not taking bookings right now')).not.toBeInTheDocument()
    expect(main().getAllByText('Not taking bookings right now')).toHaveLength(1)
  })
})
