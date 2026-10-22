import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, RouterProvider, createMemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { type Sent, json, stubApi } from '@/test/fetch'
import { CATEGORIES, PROVINCES, directoryPage, summary } from '@/test/marketplace-fixtures'
import { Home } from './Home'

/**
 * The marketplace landing page (Phase 6, R6.3, R6.4; `pages/home.md`,
 * "Marketplace landing"). What matters: it is Bookly, many photographers
 * across Rwanda, never one studio; the quick search goes to the directory
 * with only what was chosen; the featured strip is the directory's own first
 * page, nothing of the page's own; covers are https only; the trust points
 * say each photographer sets their terms and that the fee is paid by MoMo;
 * photographers are invited to list their studio; and a failed fetch leaves a
 * working page.
 */

const PHOTOGRAPHERS = [
  summary(),
  summary({ handle: 'nyamirambo-light', displayName: 'Nyamirambo Light', coverImageUrl: null }),
  summary({ handle: 'umuganda-studio', displayName: 'Umuganda Studio', coverImageUrl: 'javascript:alert(1)', takingBookings: false }),
  summary({ handle: 'lake-kivu-frames', displayName: 'Lake Kivu Frames', coverImageUrl: null }),
]

type Answers = { photographers?: (sent: Sent) => Response | Promise<Response>; lists?: 'ok' | 'fail' }

function api({ photographers = () => json(directoryPage(PHOTOGRAPHERS)), lists = 'ok' }: Answers = {}) {
  return stubApi((sent) => {
    if (sent.url === '/api/photographers') return photographers(sent)
    if (sent.url === '/api/categories') return lists === 'ok' ? json({ categories: CATEGORIES }) : json({ error: 'x' }, 500)
    if (sent.url === '/api/districts') return lists === 'ok' ? json({ provinces: PROVINCES }) : json({ error: 'x' }, 500)
    return undefined
  })
}

/** Where the quick search went. */
function Landed() {
  const location = useLocation()
  return <p data-testid="landed">{`${location.pathname}${location.search}`}</p>
}

function renderHome() {
  const router = createMemoryRouter(
    [
      { path: '/', element: <Home /> },
      { path: '/photographers', element: <Landed /> },
    ],
    { initialEntries: ['/'] },
  )
  return { router, ...render(<RouterProvider router={router} />) }
}

async function featured(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: 'Who you can book' })
  return heading.closest('section') as HTMLElement
}

function search() {
  return within(screen.getByRole('search', { name: 'Find a photographer' }))
}

beforeEach(() => {
  api()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the landing page', () => {
  it('leads with one h1, the marketplace’s tagline', async () => {
    renderHome()

    const headings = await screen.findAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveTextContent('Find and book photographers across Rwanda')
    expect(screen.getByText('Photographers across Rwanda')).toBeInTheDocument()
  })

  it('has no single-studio framing left', async () => {
    renderHome()
    await featured()

    expect(document.body).not.toHaveTextContent('Photographer · Kigali, Rwanda')
    expect(document.body).not.toHaveTextContent('Book a photographer, and know the price before you do.')
    expect(document.body).not.toHaveTextContent(/demo studio name|\+250 700 000 000|hello@example\.com/i)
  })

  it('reaches the directory, the categories and the districts, anonymously', async () => {
    const { sent } = api()
    renderHome()
    await featured()

    await waitFor(() => expect(new Set(sent.map(({ url }) => url))).toEqual(new Set(['/api/photographers', '/api/categories', '/api/districts'])))
    expect(sent.every(({ headers }) => !headers.has('Authorization'))).toBe(true)
  })

  it('titles the page for search and link previews (R6.6)', async () => {
    renderHome()

    await waitFor(() => expect(document.title).toBe('Bookly: find and book photographers across Rwanda'))
    expect(document.head.querySelector('meta[property="og:type"]')).toHaveAttribute('content', 'website')
  })
})

describe('the quick search', () => {
  it('offers the API’s categories and its districts grouped by province', async () => {
    renderHome()

    const category = search().getByRole('combobox', { name: 'Category' })
    await waitFor(() => expect(within(category).getAllByRole('option')).toHaveLength(5))
    expect(within(category).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Any category',
      'Wedding',
      'Portrait',
      'Event',
      'Product',
    ])
    const district = search().getByRole('combobox', { name: 'District' })
    await waitFor(() => expect(district.querySelectorAll('optgroup')).toHaveLength(2))
    expect(Array.from(district.querySelectorAll('optgroup')).map((group) => group.label)).toEqual(['Kigali City', 'Western Province'])
  })

  it('goes to the directory with what was chosen', async () => {
    renderHome()
    await waitFor(() => expect(search().getAllByRole('option', { name: 'Wedding' })).toHaveLength(1))

    await userEvent.selectOptions(search().getByRole('combobox', { name: 'Category' }), 'Wedding')
    await userEvent.selectOptions(search().getByRole('combobox', { name: 'District' }), 'Gasabo')
    await userEvent.click(search().getByRole('button', { name: 'Find photographers' }))

    expect(await screen.findByTestId('landed')).toHaveTextContent('/photographers?category=wedding&district=gasabo')
  })

  it('sends no empty value when only one is chosen, or none', async () => {
    const { router } = renderHome()
    await waitFor(() => expect(search().getAllByRole('option', { name: 'Gasabo' })).toHaveLength(1))

    await userEvent.selectOptions(search().getByRole('combobox', { name: 'District' }), 'Gasabo')
    await userEvent.click(search().getByRole('button', { name: 'Find photographers' }))
    expect(await screen.findByTestId('landed')).toHaveTextContent(/^\/photographers\?district=gasabo$/)

    await router.navigate('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Find photographers' }))
    expect(await screen.findByTestId('landed')).toHaveTextContent(/^\/photographers$/)
  })

  it('still works, to the whole directory, when the lists cannot be loaded', async () => {
    api({ lists: 'fail' })
    renderHome()
    await featured()

    expect(within(search().getByRole('combobox', { name: 'Category' })).getAllByRole('option')).toHaveLength(1)
    await userEvent.click(search().getByRole('button', { name: 'Find photographers' }))
    expect(await screen.findByTestId('landed')).toHaveTextContent(/^\/photographers$/)
  })

  it('submits from the keyboard', async () => {
    renderHome()
    await waitFor(() => expect(search().getAllByRole('option', { name: 'Event' })).toHaveLength(1))

    search().getByRole('combobox', { name: 'Category' }).focus()
    await userEvent.selectOptions(search().getByRole('combobox', { name: 'Category' }), 'Event')
    await userEvent.tab()
    await userEvent.tab()
    expect(search().getByRole('button', { name: 'Find photographers' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')

    expect(await screen.findByTestId('landed')).toHaveTextContent('/photographers?category=event')
  })
})

describe('the featured strip', () => {
  it('shows the directory’s first three photographers, in its order, and nothing of its own', async () => {
    renderHome()

    const strip = within(await featured())
    expect(await strip.findByRole('link', { name: 'Kigali Lens' })).toHaveAttribute('href', '/p/kigali-lens')
    expect(strip.getByRole('link', { name: 'Nyamirambo Light' })).toBeInTheDocument()
    expect(strip.getByRole('link', { name: 'Umuganda Studio' })).toBeInTheDocument()
    expect(strip.queryByRole('link', { name: 'Lake Kivu Frames' })).not.toBeInTheDocument()
    expect(strip.getByRole('link', { name: 'Browse photographers' })).toHaveAttribute('href', '/photographers')
    expect(strip.getAllByRole('heading', { level: 3 })).toHaveLength(3)
  })

  it('shows each card’s districts, categories, price and the “Not taking bookings” badge', async () => {
    const { container } = renderHome()
    const strip = within(await featured())
    await strip.findByRole('link', { name: 'Kigali Lens' })

    expect(strip.getAllByText('From 35,000 RWF')).toHaveLength(3)
    expect(strip.getAllByText('Gasabo')).toHaveLength(3)
    const badges = container.querySelectorAll('[data-not-taking-bookings]')
    expect(badges).toHaveLength(1)
    expect(badges[0]?.closest('article')).toHaveAttribute('data-photographer', 'umuganda-studio')
  })

  it('shows only an https cover, never a pasted link of another kind, and sends no Referer', async () => {
    const { container } = renderHome()
    await within(await featured()).findByRole('link', { name: 'Kigali Lens' })

    const images = Array.from(container.querySelectorAll('#photographers img'))
    expect(images.map((image) => image.getAttribute('src'))).toEqual(['https://images.example.com/kigali.jpg'])
    expect(images[0]).toHaveAttribute('referrerpolicy', 'no-referrer')
  })

  it('shows placeholder cards while the photographers load', async () => {
    let answer: (res: Response) => void = () => {}
    api({ photographers: () => new Promise<Response>((resolve) => (answer = resolve)) })
    renderHome()

    expect(screen.getByRole('heading', { name: 'Who you can book' })).toBeInTheDocument()
    const skeletons = screen.getByTestId('photographer-skeletons')
    expect(skeletons).toHaveAttribute('aria-hidden', 'true')
    expect(skeletons.querySelectorAll('li')).toHaveLength(3)
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')

    answer(json(directoryPage(PHOTOGRAPHERS)))

    expect(await within(await featured()).findByRole('link', { name: 'Kigali Lens' })).toBeInTheDocument()
    expect(screen.queryByTestId('photographer-skeletons')).not.toBeInTheDocument()
  })

  it('goes quietly when nobody is listed', async () => {
    api({ photographers: () => json(directoryPage([])) })
    renderHome()

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Who you can book' })).not.toBeInTheDocument())
    expect(screen.queryByTestId('photographer-skeletons')).not.toBeInTheDocument()
  })

  it('drops silently when the API fails: no alert, no retry, and the page still works', async () => {
    api({ photographers: () => json({ error: 'internal_error' }, 500) })
    renderHome()

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Who you can book' })).not.toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Find photographers' })).toBeInTheDocument()
  })
})

describe('how it works and the trust points', () => {
  it('lays the four booking steps out in order, for a client of many photographers', async () => {
    renderHome()

    const how = (await screen.findByRole('heading', { name: 'How booking works' })).closest('section')
    const steps = within(how as HTMLElement).getAllByRole('listitem')
    expect(steps.map((step) => step.querySelector('h3')?.textContent)).toEqual([
      'Find a photographer',
      'Choose a service and a time',
      'Pay the booking fee by MoMo',
      'Get your link',
    ])
  })

  it('says each photographer sets their own cancellation terms, and that the fee is paid by MoMo (R1.8)', async () => {
    renderHome()

    const trust = within((await screen.findByRole('heading', { name: 'What you can count on' })).closest('section') as HTMLElement)
    expect(trust.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'Cancellation terms, up front',
      'Pay by MTN MoMo',
      'The price is the price',
      'One private link, yours',
    ])
    expect(trust.getByText(/Each photographer sets whether the booking fee is refunded/)).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('The booking fee is not refunded')
  })
})

describe('for photographers, and for clients who already booked', () => {
  it('invites a photographer to list their studio, or sign in to it', async () => {
    renderHome()

    const band = within((await screen.findByRole('heading', { name: 'List your studio on Bookly' })).closest('section') as HTMLElement)
    expect(band.getByRole('link', { name: 'List your studio' })).toHaveAttribute('href', '/studio/signup')
    expect(band.getByRole('link', { name: 'Studio sign in' })).toHaveAttribute('href', '/studio/login')
  })

  it('sends a client who lost their link to the page that emails a new one', async () => {
    renderHome()

    const booked = within((await screen.findByRole('heading', { name: 'Find your booking any time.' })).closest('section') as HTMLElement)
    expect(booked.getByRole('link', { name: 'Find my booking' })).toHaveAttribute('href', '/my-booking')
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
