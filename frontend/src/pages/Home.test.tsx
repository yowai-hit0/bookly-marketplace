import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { Home } from './Home'

/**
 * The landing page replaced an API-status stub on 2026-09-21, so none of the
 * old assertions survived. What matters now: it sends people to `/services`,
 * it shows the API's own services rather than any of its own, it says the
 * unfavourable term out loud, and a failed fetch leaves a working page.
 */

const SERVICES = [
  { id: 's1', slug: 'portraits', nameEn: 'Portraits', descriptionEn: null, coverImageUrl: null, packages: [{ id: 'p1', nameEn: 'Mini', priceRwf: 25_000, durationMinutes: 60, photoCount: 10 }] },
  { id: 's2', slug: 'weddings', nameEn: 'Weddings', descriptionEn: null, coverImageUrl: null, packages: [{ id: 'p2', nameEn: 'Full', priceRwf: 40_000, durationMinutes: 240, photoCount: 80 }] },
  { id: 's3', slug: 'events', nameEn: 'Events', descriptionEn: null, coverImageUrl: null, packages: [] },
  { id: 's4', slug: 'products', nameEn: 'Products', descriptionEn: null, coverImageUrl: null, packages: [] },
]

function stubServices(services: unknown[] = SERVICES) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ services }))),
  )
}

/** The services preview; the hero's chips name the services too (2026-09-27). */
async function previewSection(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: 'What you can book' })
  return heading.closest('section') as HTMLElement
}

function renderHome() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  stubServices()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the landing page', () => {
  it('leads with one h1 and a call to action into the service list', async () => {
    renderHome()

    const headings = await screen.findAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveTextContent('Book a photographer, and know the price before you do.')

    // "Book now" is in the hero and the closing band; both go to the same place.
    const bookNow = screen.getAllByRole('link', { name: 'Book now' })
    expect(bookNow).toHaveLength(2)
    for (const link of bookNow) expect(link).toHaveAttribute('href', '/services')
  })

  it('previews the first three services the API lists, and nothing of its own', async () => {
    renderHome()

    const preview = within(await previewSection())
    expect(await preview.findByRole('link', { name: 'Portraits' })).toHaveAttribute('href', '/services/portraits')
    expect(preview.getByRole('link', { name: 'Weddings' })).toBeInTheDocument()
    expect(preview.getByRole('link', { name: 'Events' })).toBeInTheDocument()
    // The fourth is the list page's job, not the preview's.
    expect(preview.queryByRole('link', { name: 'Products' })).not.toBeInTheDocument()
    expect(preview.getByText('From 25,000 RWF')).toBeInTheDocument()
  })

  it('offers every service the API lists as a chip in the hero, and no chip of its own (2026-09-27)', async () => {
    renderHome()

    const need = await screen.findByText('What do you need?')
    const chips = within(need.parentElement as HTMLElement)
    await waitFor(() => expect(chips.getAllByRole('link')).toHaveLength(4))
    expect(chips.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Portraits', '/services/portraits'],
      ['Weddings', '/services/weddings'],
      ['Events', '/services/events'],
      ['Products', '/services/products'],
    ])
  })

  it('reaches the same endpoint the service list uses', async () => {
    renderHome()

    await within(await previewSection()).findByRole('link', { name: 'Portraits' })
    expect(fetch).toHaveBeenCalledWith('/api/services', expect.anything())
  })

  it('never names a service the API did not send', async () => {
    stubServices([])
    renderHome()

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
    // The section shows placeholders while loading, then goes when there is nothing.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'What you can book' })).not.toBeInTheDocument())
    expect(screen.queryByTestId('service-skeletons')).not.toBeInTheDocument()
  })

  it('shows placeholder cards in the preview while the services load (2026-09-25)', async () => {
    let answer: (res: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))))
    renderHome()

    expect(screen.getByRole('heading', { name: 'What you can book' })).toBeInTheDocument()
    const skeletons = screen.getByTestId('service-skeletons')
    expect(skeletons).toHaveAttribute('aria-hidden', 'true')
    expect(skeletons.querySelectorAll('li')).toHaveLength(3)
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')

    answer(new Response(JSON.stringify({ services: SERVICES })))

    expect(await within(await previewSection()).findByRole('link', { name: 'Portraits' })).toBeInTheDocument()
    expect(screen.queryByTestId('service-skeletons')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('drops the preview silently when the API fails: no alert, no retry, and the page still works', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    renderHome()

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'What you can book' })).not.toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('service-skeletons')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Book now' })).toHaveLength(2)
  })

  it('explains the booking fee is not refunded, rather than leaving it to checkout', async () => {
    renderHome()

    const trust = (await screen.findByRole('heading', { name: 'What you can count on' })).closest('section')
    expect(trust).not.toBeNull()
    expect(within(trust as HTMLElement).getByRole('heading', { name: 'The booking fee is not refunded' })).toBeInTheDocument()
    expect(within(trust as HTMLElement).getByText(/the booking fee stays with the photographer/i)).toBeInTheDocument()
  })

  it('lays the four booking steps out in order, as a list', async () => {
    renderHome()

    const how = (await screen.findByRole('heading', { name: 'How booking works' })).closest('section')
    const steps = within(how as HTMLElement).getAllByRole('listitem')
    expect(steps.map((step) => step.querySelector('h3')?.textContent)).toEqual([
      'Choose a service',
      'Pick a time',
      'Pay the booking fee',
      'Get your link',
    ])
  })
})

describe('the header’s "How booking works" link (2026-09-27)', () => {
  it('lands on the steps with focus on their heading when the page opens at #how', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(
      <MemoryRouter initialEntries={['/#how']}>
        <Home />
      </MemoryRouter>,
    )

    const heading = await screen.findByRole('heading', { level: 2, name: 'How booking works' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(heading.closest('section')).toHaveAttribute('id', 'how')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  })
})
