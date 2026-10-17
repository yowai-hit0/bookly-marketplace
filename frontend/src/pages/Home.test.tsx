import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { Home } from './Home'

/**
 * The landing page replaced an API-status stub on 2026-09-21, so none of the
 * old assertions survived. What matters now: it sends people to
 * `/photographers` (brief decision 9), it shows the API's own photographers
 * rather than any of its own, it says each photographer sets their own
 * cancellation terms rather than promising one, and a failed fetch leaves a
 * working page.
 */

const PHOTOGRAPHERS = [
  { handle: 'kigali-lens', displayName: 'Kigali Lens', coverImageUrl: 'https://images.example.com/kigali.jpg' },
  { handle: 'nyamirambo-light', displayName: 'Nyamirambo Light', coverImageUrl: null },
  { handle: 'umuganda-studio', displayName: 'Umuganda Studio', coverImageUrl: 'javascript:alert(1)' },
  { handle: 'lake-kivu-frames', displayName: 'Lake Kivu Frames', coverImageUrl: null },
]

function stubPhotographers(photographers: unknown[] = PHOTOGRAPHERS) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ photographers }))),
  )
}

/** The photographers preview; the hero's chips name them too. */
async function previewSection(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: 'Who you can book' })
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
  stubPhotographers()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the landing page', () => {
  it('leads with one h1 and a call to action into the photographers list', async () => {
    renderHome()

    const headings = await screen.findAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveTextContent('Book a photographer, and know the price before you do.')

    // "Book now" is in the hero and the closing band; both go to the same place.
    const bookNow = screen.getAllByRole('link', { name: 'Book now' })
    expect(bookNow).toHaveLength(2)
    for (const link of bookNow) expect(link).toHaveAttribute('href', '/photographers')
  })

  it('previews the first three photographers the API lists, and nothing of its own', async () => {
    renderHome()

    const preview = within(await previewSection())
    expect(await preview.findByRole('link', { name: 'Kigali Lens' })).toHaveAttribute('href', '/p/kigali-lens')
    expect(preview.getByRole('link', { name: 'Nyamirambo Light' })).toBeInTheDocument()
    expect(preview.getByRole('link', { name: 'Umuganda Studio' })).toBeInTheDocument()
    // The fourth is the list page's job, not the preview's.
    expect(preview.queryByRole('link', { name: 'Lake Kivu Frames' })).not.toBeInTheDocument()
    expect(preview.getByRole('link', { name: 'Browse photographers' })).toHaveAttribute('href', '/photographers')
  })

  it('shows only an https cover, never a pasted link of another kind', async () => {
    const { container } = renderHome()

    await within(await previewSection()).findByRole('link', { name: 'Kigali Lens' })
    expect(Array.from(container.querySelectorAll('img')).map((image) => image.getAttribute('src'))).toEqual([
      'https://images.example.com/kigali.jpg',
    ])
  })

  it('offers every photographer the API lists as a chip in the hero, and no chip of its own', async () => {
    renderHome()

    const label = await screen.findByText('Photographers you can book')
    const chips = within(label.parentElement as HTMLElement)
    await waitFor(() => expect(chips.getAllByRole('link')).toHaveLength(4))
    expect(chips.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Kigali Lens', '/p/kigali-lens'],
      ['Nyamirambo Light', '/p/nyamirambo-light'],
      ['Umuganda Studio', '/p/umuganda-studio'],
      ['Lake Kivu Frames', '/p/lake-kivu-frames'],
    ])
  })

  it('reaches the same endpoint the photographers list uses', async () => {
    renderHome()

    await within(await previewSection()).findByRole('link', { name: 'Kigali Lens' })
    expect(fetch).toHaveBeenCalledWith('/api/photographers', expect.anything())
  })

  it('never names a photographer the API did not send', async () => {
    stubPhotographers([])
    renderHome()

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
    // The section shows placeholders while loading, then goes when there is nothing.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Who you can book' })).not.toBeInTheDocument())
    expect(screen.queryByTestId('service-skeletons')).not.toBeInTheDocument()
  })

  it('shows placeholder cards in the preview while the photographers load (2026-09-25)', async () => {
    let answer: (res: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))))
    renderHome()

    expect(screen.getByRole('heading', { name: 'Who you can book' })).toBeInTheDocument()
    const skeletons = screen.getByTestId('service-skeletons')
    expect(skeletons).toHaveAttribute('aria-hidden', 'true')
    expect(skeletons.querySelectorAll('li')).toHaveLength(3)
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')

    answer(new Response(JSON.stringify({ photographers: PHOTOGRAPHERS })))

    expect(await within(await previewSection()).findByRole('link', { name: 'Kigali Lens' })).toBeInTheDocument()
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
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Who you can book' })).not.toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('service-skeletons')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Book now' })).toHaveLength(2)
  })

  it('says each photographer sets their own cancellation terms, and never promises one for all (R1.8)', async () => {
    renderHome()

    const trust = (await screen.findByRole('heading', { name: 'What you can count on' })).closest('section')
    expect(trust).not.toBeNull()
    expect(within(trust as HTMLElement).getByRole('heading', { name: 'Cancellation terms, up front' })).toBeInTheDocument()
    expect(within(trust as HTMLElement).getByText(/Each photographer sets whether the booking fee is refunded/)).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('The booking fee is not refunded')
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
