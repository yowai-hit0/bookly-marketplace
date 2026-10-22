import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { DirectoryPage, PublicPhotographerSummary } from '@/catalogue/api'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'
import { CATEGORIES, PROVINCES, directoryPage, summary } from '@/test/marketplace-fixtures'

/**
 * The directory at `/photographers` (marketplace spec R6.1, R6.3, R6.5;
 * `design-system/bookly/pages/directory.md`), rendered through the real
 * routes with `fetch` stubbed.
 *
 * What is proven: the URL is the state (it is what the API is asked, empty
 * values and unknown keys never sent, each change a history entry Back
 * undoes); the bar applies selects at once and prices on leave or Enter,
 * digits only; the sheet applies only on "Show photographers"; every 422
 * field is worded by its field, a 400 and a failure each say so; the empty,
 * past-the-end, paged and dated counts; the cards (https-only covers with no
 * Referer, districts, categories, the price, the "Not taking bookings"
 * badge); and the page's title follows its filters.
 *
 * jsdom applies no CSS, so the bar (shown from `lg`) and the sheet's trigger
 * (below `lg`) are both on screen here; tests scope to the one they mean.
 */

const PHOTOGRAPHERS: PublicPhotographerSummary[] = [
  summary(),
  summary({
    handle: 'nyamirambo-light',
    displayName: 'Nyamirambo Light',
    coverImageUrl: null,
    fromPriceRwf: 40_000,
    districts: [
      { code: 'nyarugenge', name: 'Nyarugenge' },
      { code: 'gasabo', name: 'Gasabo' },
      { code: 'kicukiro', name: 'Kicukiro' },
      { code: 'rubavu', name: 'Rubavu' },
    ],
    categories: [
      { slug: 'wedding', name: 'Wedding' },
      { slug: 'portrait', name: 'Portrait' },
      { slug: 'event', name: 'Event' },
      { slug: 'product', name: 'Product' },
      { slug: 'family', name: 'Family' },
    ],
  }),
  summary({ handle: 'umuganda-studio', displayName: 'Umuganda Studio', coverImageUrl: 'javascript:alert(1)', fromPriceRwf: 50_000 }),
  summary({
    handle: 'lake-kivu-frames',
    displayName: 'Lake Kivu Frames',
    coverImageUrl: 'http://images.example.com/kivu.jpg',
    fromPriceRwf: 50_000,
    takingBookings: false,
  }),
]

type Answer = (url: URL) => Response | Promise<Response>

function api(directory: Answer = () => json(directoryPage(PHOTOGRAPHERS))) {
  return stubApi(({ url }) => {
    const parsed = new URL(url, 'http://localhost')
    if (parsed.pathname === '/api/photographers') return directory(parsed)
    if (parsed.pathname === '/api/categories') return json({ categories: CATEGORIES })
    if (parsed.pathname === '/api/districts') return json({ provinces: PROVINCES })
    return undefined
  })
}

/** The directory requests made, as the path and query the API saw. */
function searches(sent: Sent[]): string[] {
  return sent.map(({ url }) => url).filter((url) => url.startsWith('/api/photographers'))
}

function renderAt(path = '/photographers') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const view = render(<RouterProvider router={router} />)
  return { router, ...view }
}

function main() {
  return within(screen.getByRole('main'))
}

function bar() {
  return within(screen.getByRole('form', { name: 'Filters' }))
}

function count() {
  return screen.getByRole('status')
}

async function loaded() {
  await waitFor(() => expect(screen.queryByTestId('photographer-skeletons')).not.toBeInTheDocument())
}

beforeEach(() => {
  // Thursday 22 October 2026, 10:00 in Kigali. Only Date is faked, so user-event's timers are real.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-22T08:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the directory', () => {
  it('loads the page, the categories and the districts anonymously, and lists the cards in the API’s order', async () => {
    const { sent } = api()
    renderAt()

    await loaded()
    const links = main()
      .getAllByRole('link')
      .filter((link) => link.closest('article') !== null)
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Kigali Lens', '/p/kigali-lens'],
      ['Nyamirambo Light', '/p/nyamirambo-light'],
      ['Umuganda Studio', '/p/umuganda-studio'],
      ['Lake Kivu Frames', '/p/lake-kivu-frames'],
    ])
    expect(new Set(sent.map(({ url }) => url))).toEqual(new Set(['/api/photographers', '/api/categories', '/api/districts']))
    expect(sent.every(({ headers }) => !headers.has('Authorization'))).toBe(true)
    expect(screen.getByRole('heading', { level: 1, name: 'Photographers' })).toBeInTheDocument()
  })

  it('counts the matches from the API’s total, in a polite live region', async () => {
    api(() => json(directoryPage(PHOTOGRAPHERS, { total: 4 })))
    renderAt()

    await waitFor(() => expect(count()).toHaveTextContent('4 photographers'))
    expect(count()).toHaveAttribute('aria-live', 'polite')
    expect(count()).not.toHaveClass('sr-only')
  })

  it('says “1 photographer” for one', async () => {
    api(() => json(directoryPage([summary()])))
    renderAt()

    await waitFor(() => expect(count()).toHaveTextContent(/^1 photographer$/))
  })

  it('shows skeleton cards and says it is loading until the page arrives', async () => {
    let answer: (res: Response) => void = () => {}
    api(() => new Promise<Response>((resolve) => (answer = resolve)))
    renderAt()

    expect(await screen.findByTestId('photographer-skeletons')).toHaveAttribute('aria-hidden', 'true')
    expect(count()).toHaveTextContent('Loading…')

    answer(json(directoryPage(PHOTOGRAPHERS)))

    await loaded()
    expect(main().getByRole('link', { name: 'Kigali Lens' })).toBeInTheDocument()
  })

  it('shows an alert when the API fails, and loads again on “Try again”', async () => {
    let calls = 0
    api(() => (++calls === 1 ? json({ error: 'internal_error' }, 500) : json(directoryPage(PHOTOGRAPHERS))))
    renderAt()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load photographers. Check your connection and try again.')

    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await main().findByRole('link', { name: 'Kigali Lens' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the alert when the network is down, not only on an error status', async () => {
    api(() => Promise.reject(new TypeError('Failed to fetch')))
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load photographers.')
  })

  it('says so when nobody can be booked and no filter is on', async () => {
    api(() => json(directoryPage([])))
    renderAt()

    expect(await main().findByText('No photographers are available to book right now.')).toBeInTheDocument()
    expect(count()).toHaveTextContent('0 photographers')
  })
})

describe('the cards (R6.5)', () => {
  it('puts only an https cover in an src, with no Referer, lazy after the first', async () => {
    api()
    const { container } = renderAt()

    await loaded()
    const images = Array.from(container.querySelectorAll('main img'))
    expect(images.map((image) => image.getAttribute('src'))).toEqual(['https://images.example.com/kigali.jpg'])
    expect(images[0]).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(images[0]).toHaveAttribute('loading', 'eager')
    // The other three (none, javascript:, http:) get the camera block, at the same 4:3.
    expect(container.querySelectorAll('main article > div[aria-hidden="true"].aspect-4\\/3')).toHaveLength(3)
  })

  it('loads every cover but the first lazily', async () => {
    api(() =>
      json(
        directoryPage([
          summary(),
          summary({ handle: 'b', displayName: 'B', coverImageUrl: 'https://images.example.com/b.jpg' }),
          summary({ handle: 'c', displayName: 'C', coverImageUrl: 'https://images.example.com/c.jpg' }),
        ]),
      ),
    )
    const { container } = renderAt()

    await loaded()
    expect(Array.from(container.querySelectorAll('main img')).map((image) => image.getAttribute('loading'))).toEqual([
      'eager',
      'lazy',
      'lazy',
    ])
  })

  it('names the districts, the categories and the “from” price', async () => {
    api()
    renderAt()

    await loaded()
    const card = within(main().getByRole('link', { name: 'Kigali Lens' }).closest('article') as HTMLElement)
    expect(card.getByText('Gasabo')).toBeInTheDocument()
    expect(within(card.getByRole('list', { name: 'Shoots' })).getByText('Wedding')).toBeInTheDocument()
    expect(card.getByText('From 35,000 RWF')).toBeInTheDocument()
  })

  it('shortens long district and category lists with “+N”', async () => {
    api()
    renderAt()

    await loaded()
    const card = within(main().getByRole('link', { name: 'Nyamirambo Light' }).closest('article') as HTMLElement)
    expect(card.getByText(/^Nyarugenge, Gasabo/)).toHaveTextContent('Nyarugenge, Gasabo +2 more')
    const shoots = within(card.getByRole('list', { name: 'Shoots' }))
    expect(shoots.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Wedding', 'Portrait', 'Event', '+2'])
  })

  it('badges a past-due photographer “Not taking bookings”, and only them', async () => {
    api()
    const { container } = renderAt()

    await loaded()
    const badges = container.querySelectorAll('main [data-not-taking-bookings]')
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveTextContent('Not taking bookings')
    expect(badges[0]?.closest('article')).toHaveAttribute('data-photographer', 'lake-kivu-frames')
  })

  it('keeps a very long name in one link, wrapping inside the card', async () => {
    const long = 'Studio '.repeat(30).trim()
    api(() => json(directoryPage([summary({ displayName: long })])))
    renderAt()

    const link = await main().findByRole('link', { name: long })
    expect(link.closest('h2')).toHaveClass('wrap-anywhere')
  })

  it('renders names as text, never as markup', async () => {
    api(() => json(directoryPage([summary({ displayName: '<img src=x onerror=alert(1)>' })])))
    const { container } = renderAt()

    expect(await main().findByRole('link', { name: '<img src=x onerror=alert(1)>' })).toBeInTheDocument()
    expect(container.querySelector('img[src="x"]')).toBeNull()
  })
})

describe('the URL is the state (R6.3)', () => {
  it('asks the API for exactly what the URL says: no empty value and no unknown key', async () => {
    const { sent } = api()
    renderAt('/photographers?category=wedding&district=gasabo&min=&utm_source=mail&category=event')

    await loaded()
    expect(searches(sent)).toEqual(['/api/photographers?category=wedding&district=gasabo'])
  })

  it('shows the URL’s filters in the bar', async () => {
    api()
    renderAt('/photographers?category=wedding&district=gasabo&min=20000&max=80000&date=2026-11-07')

    await loaded()
    await waitFor(() => expect(bar().getByRole('combobox', { name: 'Category' })).toHaveValue('wedding'))
    expect(bar().getByRole('combobox', { name: 'District' })).toHaveValue('gasabo')
    expect(bar().getByRole('textbox', { name: 'Lowest' })).toHaveValue('20000')
    expect(bar().getByRole('textbox', { name: 'Highest' })).toHaveValue('80000')
    expect(bar().getByLabelText('Available on')).toHaveValue('2026-11-07')
  })

  it('applies a category at once, as a new history entry, from page 1', async () => {
    const { sent } = api()
    const { router } = renderAt('/photographers?district=gasabo&page=3')
    await loaded()

    await userEvent.selectOptions(bar().getByRole('combobox', { name: 'Category' }), 'Wedding')

    await waitFor(() => expect(router.state.location.search).toBe('?category=wedding&district=gasabo'))
    expect(router.state.historyAction).toBe('PUSH')
    await waitFor(() => expect(searches(sent)).toContain('/api/photographers?category=wedding&district=gasabo'))
  })

  it('goes back to the previous filters with Back, and asks for them again', async () => {
    const { sent } = api()
    const { router } = renderAt('/photographers?category=wedding')
    await loaded()

    await userEvent.selectOptions(bar().getByRole('combobox', { name: 'District' }), 'Rubavu')
    await waitFor(() => expect(router.state.location.search).toBe('?category=wedding&district=rubavu'))

    await act(() => router.navigate(-1))

    expect(router.state.location.search).toBe('?category=wedding')
    await waitFor(() => expect(bar().getByRole('combobox', { name: 'District' })).toHaveValue(''))
    expect(searches(sent).at(-1)).toBe('/api/photographers?category=wedding')
  })

  it('offers the districts grouped by province', async () => {
    api()
    renderAt()
    await loaded()

    const district = bar().getByRole('combobox', { name: 'District' })
    await waitFor(() => expect(district.querySelectorAll('optgroup')).toHaveLength(2))
    expect(Array.from(district.querySelectorAll('optgroup')).map((group) => [group.label, group.querySelectorAll('option').length])).toEqual([
      ['Kigali City', 3],
      ['Western Province', 1],
    ])
    expect(within(district).getByRole('option', { name: 'Anywhere in Rwanda' })).toHaveValue('')
  })

  it('keeps a value from a link that is not on the list, so the field shows what was asked', async () => {
    api(() => json({ error: 'validation_failed', fields: ['category'] }, 422))
    renderAt('/photographers?category=retired-thing')

    await screen.findByRole('alert')
    expect(bar().getByRole('combobox', { name: 'Category' })).toHaveValue('retired-thing')
  })

  it('applies a price when the field is left, and only once', async () => {
    const { sent } = api()
    const { router } = renderAt()
    await loaded()

    await userEvent.type(bar().getByRole('textbox', { name: 'Lowest' }), '25000')
    expect(router.state.location.search).toBe('')
    await userEvent.tab()

    await waitFor(() => expect(router.state.location.search).toBe('?min=25000'))
    await waitFor(() => expect(searches(sent).filter((url) => url.includes('min='))).toEqual(['/api/photographers?min=25000']))
  })

  it('applies a price on Enter', async () => {
    api()
    const { router } = renderAt()
    await loaded()

    await userEvent.type(bar().getByRole('textbox', { name: 'Highest' }), '80000{Enter}')

    await waitFor(() => expect(router.state.location.search).toBe('?max=80000'))
  })

  it('refuses a price that is not whole digits, by its field, and sends nothing', async () => {
    const { sent } = api()
    const { router } = renderAt()
    await loaded()
    const before = searches(sent).length

    const lowest = bar().getByRole('textbox', { name: 'Lowest' })
    await userEvent.type(lowest, '25,000{Enter}')

    expect(await bar().findByText('Enter a whole number of RWF, digits only.')).toBeInTheDocument()
    expect(lowest).toHaveAttribute('aria-invalid', 'true')
    expect(lowest).toHaveAccessibleDescription('Enter a whole number of RWF, digits only.')
    expect(router.state.location.search).toBe('')
    expect(searches(sent)).toHaveLength(before)
  })

  it('applies a date at once, within today and a year ahead', async () => {
    api()
    const { router } = renderAt()
    await loaded()

    const date = bar().getByLabelText('Available on')
    expect(date).toHaveAttribute('min', '2026-10-22')
    expect(date).toHaveAttribute('max', '2027-10-22')

    await userEvent.type(date, '2026-11-07')

    await waitFor(() => expect(router.state.location.search).toBe('?date=2026-11-07'))
  })
})

describe('filter chips', () => {
  it('shows one removable chip per filter, the price range as one', async () => {
    api()
    renderAt('/photographers?category=wedding&district=gasabo&min=20000&max=80000&date=2026-11-07')
    await loaded()

    const chips = within(await screen.findByRole('list', { name: 'Active filters' }))
    await waitFor(() => expect(chips.getByRole('button', { name: 'Remove filter: Wedding' })).toBeInTheDocument())
    expect(chips.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Remove filter: Wedding',
      'Remove filter: Gasabo',
      'Remove filter: 20,000 RWF to 80,000 RWF',
      'Remove filter: Free on Saturday, 7 November 2026',
    ])
  })

  it('words a lowest or a highest price alone', async () => {
    api()
    const { router } = renderAt('/photographers?min=20000')
    await loaded()
    expect(screen.getByRole('button', { name: 'Remove filter: From 20,000 RWF' })).toBeInTheDocument()

    await act(() => router.navigate('/photographers?max=80000'))
    expect(await screen.findByRole('button', { name: 'Remove filter: Up to 80,000 RWF' })).toBeInTheDocument()
  })

  it('shows no chip and no “Clear filters” with no filter on', async () => {
    api()
    renderAt()
    await loaded()

    expect(screen.queryByRole('list', { name: 'Active filters' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
  })

  it('removes one filter, and hands focus to the chip that took its place', async () => {
    api()
    const { router } = renderAt('/photographers?category=wedding&district=gasabo')
    await loaded()

    await userEvent.click(await screen.findByRole('button', { name: 'Remove filter: Wedding' }))

    await waitFor(() => expect(router.state.location.search).toBe('?district=gasabo'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove filter: Gasabo' })).toHaveFocus())
  })

  it('hands focus to the results when the last chip goes, never to the page body', async () => {
    api()
    const { router } = renderAt('/photographers?district=gasabo')
    await loaded()

    await userEvent.click(await screen.findByRole('button', { name: 'Remove filter: Gasabo' }))

    await waitFor(() => expect(router.state.location.search).toBe(''))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Results' })).toHaveFocus())
  })

  it('clears every filter at once', async () => {
    api()
    const { router } = renderAt('/photographers?category=wedding&district=gasabo&date=2026-11-07&page=2')
    await loaded()

    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }))

    await waitFor(() => expect(router.state.location.search).toBe(''))
  })
})

describe('the 422, worded by each field', () => {
  async function refused(fields: string[], path: string) {
    api(() => json({ error: 'validation_failed', fields }, 422))
    const view = renderAt(path)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Some filters can't be used. Change the ones marked, or clear them.")
    return { ...view, alert }
  }

  it('words a category no longer offered under the category', async () => {
    await refused(['category'], '/photographers?category=retired')

    const field = bar().getByRole('combobox', { name: 'Category' })
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription("That category isn't offered any more. Choose another.")
  })

  it('words an unknown district under the district', async () => {
    await refused(['district'], '/photographers?district=atlantis')

    expect(bar().getByRole('combobox', { name: 'District' })).toHaveAccessibleDescription('Choose a district from the list.')
  })

  it('words the lowest above the highest once, on the price group, and marks both', async () => {
    await refused(['min', 'max'], '/photographers?min=90000&max=10000')

    expect(bar().getAllByText('The lowest price is above the highest.')).toHaveLength(1)
    expect(bar().getByRole('group', { name: 'Price (RWF)' })).toHaveAccessibleDescription('The lowest price is above the highest.')
    expect(bar().getByRole('textbox', { name: 'Lowest' })).toHaveAttribute('aria-invalid', 'true')
    expect(bar().getByRole('textbox', { name: 'Highest' })).toHaveAttribute('aria-invalid', 'true')
  })

  it('words an amount too large under its own field', async () => {
    await refused(['max'], '/photographers?max=99999999999')

    expect(bar().getByRole('textbox', { name: 'Highest' })).toHaveAccessibleDescription('That amount is too large.')
    expect(bar().getByRole('textbox', { name: 'Lowest' })).not.toHaveAttribute('aria-invalid')
  })

  it('words a date out of range under the date', async () => {
    await refused(['date'], '/photographers?date=2020-01-01')

    expect(bar().getByLabelText('Available on')).toHaveAccessibleDescription('Choose a date from today up to a year ahead.')
  })

  it('names several refused fields together', async () => {
    const { alert } = await refused(['category', 'date'], '/photographers?category=retired&date=2020-01-01')

    // Below `lg` the fields are in the closed sheet, so the alert repeats each sentence there.
    expect(within(alert).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      "That category isn't offered any more. Choose another.",
      'Choose a date from today up to a year ahead.',
    ])
  })

  it('marks the refused chip, and clears with “Clear filters”', async () => {
    const { alert, router } = await refused(['district'], '/photographers?district=atlantis&category=wedding')

    expect(screen.getByRole('button', { name: 'Remove filter: atlantis' })).toHaveClass('border-destructive')
    expect(screen.getByRole('button', { name: 'Remove filter: Wedding' })).not.toHaveClass('border-destructive')

    await userEvent.click(within(alert).getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(router.state.location.search).toBe(''))
  })

  it('drops a field’s complaint once the field is changed', async () => {
    await refused(['district'], '/photographers?district=atlantis')
    api()

    await userEvent.selectOptions(bar().getByRole('combobox', { name: 'District' }), 'Gasabo')

    await waitFor(() => expect(bar().queryByText('Choose a district from the list.')).not.toBeInTheDocument())
  })

  it('opens the sheet from “Edit filters”, with the sentence by the field there too', async () => {
    const { alert } = await refused(['district'], '/photographers?district=atlantis')

    await userEvent.click(within(alert).getByRole('button', { name: 'Edit filters' }))

    const sheet = within(await screen.findByRole('dialog', { name: 'Filters' }))
    expect(sheet.getByRole('combobox', { name: 'District' })).toHaveAccessibleDescription('Choose a district from the list.')
  })

  it('words a page out of range, with a way back to the first page that keeps the filters', async () => {
    api(() => json({ error: 'validation_failed', fields: ['page'] }, 422))
    renderAt('/photographers?category=wedding&page=5000')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("That page doesn't exist.")
    expect(within(alert).getByRole('link', { name: 'Back to the first page' })).toHaveAttribute('href', '/photographers?category=wedding')
  })
})

describe('a link the API cannot read (400)', () => {
  it('says so, and offers to clear the filters', async () => {
    api(() => json({ error: 'invalid_request' }, 400))
    const { router } = renderAt('/photographers?min=abc')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("This search link isn't valid.")

    await userEvent.click(within(alert).getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(router.state.location.search).toBe(''))
  })
})

describe('nothing found', () => {
  it('suggests removing the date and the price, and each removes only that', async () => {
    api((url) => json(directoryPage(url.searchParams.has('date') ? [] : PHOTOGRAPHERS)))
    const { router } = renderAt('/photographers?category=wedding&min=20000&date=2026-11-07')

    expect(await main().findByText('No photographers match these filters.')).toBeInTheDocument()
    expect(main().getByRole('button', { name: 'Remove the price range' })).toBeInTheDocument()

    await userEvent.click(main().getByRole('button', { name: 'Remove the date' }))

    await waitFor(() => expect(router.state.location.search).toBe('?category=wedding&min=20000'))
    expect(await main().findByRole('link', { name: 'Kigali Lens' })).toBeInTheDocument()
  })

  it('offers no date suggestion when no date is set', async () => {
    api(() => json(directoryPage([])))
    renderAt('/photographers?category=wedding')

    expect(await main().findByText('No photographers match these filters.')).toBeInTheDocument()
    expect(main().queryByRole('button', { name: 'Remove the date' })).not.toBeInTheDocument()
    expect(main().queryByRole('button', { name: 'Remove the price range' })).not.toBeInTheDocument()
  })

  it('under a date, counts nothing as “0 photographers”, for screen readers only, beside the callout', async () => {
    const page: DirectoryPage = directoryPage([])
    delete page.total
    api(() => json(page))
    renderAt('/photographers?date=2026-11-07')

    expect(await main().findByText('No photographers match these filters.')).toBeInTheDocument()
    expect(count()).toHaveTextContent(/^0 photographers$/)
    expect(count()).toHaveClass('sr-only')
  })

  it('says a page past the end is empty, with a way back to the first page', async () => {
    api(() => json(directoryPage([], { page: 3, total: 30 })))
    renderAt('/photographers?district=gasabo&page=3')

    expect(await main().findByText('There is nothing on this page.')).toBeInTheDocument()
    expect(main().getByRole('link', { name: 'Back to the first page' })).toHaveAttribute('href', '/photographers?district=gasabo')
  })
})

describe('pages', () => {
  function many(count: number, start = 0): PublicPhotographerSummary[] {
    return Array.from({ length: count }, (_, index) => summary({ handle: `p${start + index}`, displayName: `Photographer ${start + index}`, coverImageUrl: null }))
  }

  it('numbers the pages from the total, with Next only while there is more', async () => {
    api(() => json(directoryPage(many(24), { total: 30, hasMore: true })))
    renderAt('/photographers?category=wedding')

    const pages = within(await screen.findByRole('navigation', { name: 'Pages' }))
    expect(pages.getByText('Page 1 of 2')).toBeInTheDocument()
    expect(pages.queryByRole('link', { name: 'Previous' })).not.toBeInTheDocument()
    expect(pages.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/photographers?category=wedding&page=2')
  })

  it('offers Previous and no Next on the last page', async () => {
    api(() => json(directoryPage(many(6, 24), { page: 2, total: 30, hasMore: false })))
    renderAt('/photographers?page=2')

    const pages = within(await screen.findByRole('navigation', { name: 'Pages' }))
    expect(pages.getByText('Page 2 of 2')).toBeInTheDocument()
    expect(pages.getByRole('link', { name: 'Previous' })).toHaveAttribute('href', '/photographers')
    expect(pages.queryByRole('link', { name: 'Next' })).not.toBeInTheDocument()
  })

  it('shows no page navigation when everything fits on one page', async () => {
    api()
    renderAt()
    await loaded()

    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument()
  })

  it('moves focus to the results when Next is followed', async () => {
    api((url) => json(directoryPage(many(24, url.searchParams.get('page') === '2' ? 24 : 0), { page: Number(url.searchParams.get('page') ?? 1), total: 48, hasMore: url.searchParams.get('page') !== '2' })))
    const { router } = renderAt()

    await userEvent.click(within(await screen.findByRole('navigation', { name: 'Pages' })).getByRole('link', { name: 'Next' }))

    await waitFor(() => expect(router.state.location.search).toBe('?page=2'))
    expect(await main().findByRole('link', { name: 'Photographer 24' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Results' })).toHaveFocus())
  })

  it('under a date, with no total, shows the range while there is more, and pages by “hasMore” alone', async () => {
    const page: DirectoryPage = directoryPage(many(24), { hasMore: true })
    delete page.total
    api(() => json(page))
    renderAt('/photographers?date=2026-11-07')

    await waitFor(() => expect(count()).toHaveTextContent('Showing 1–24, free on Saturday, 7 November 2026'))
    const pages = within(screen.getByRole('navigation', { name: 'Pages' }))
    expect(pages.getByText('Page 1')).toBeInTheDocument()
    expect(pages.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/photographers?date=2026-11-07&page=2')
  })

  it('under a date, on a later page, shows the range', async () => {
    const page: DirectoryPage = directoryPage(many(3, 24), { page: 2, hasMore: false })
    delete page.total
    api(() => json(page))
    renderAt('/photographers?date=2026-11-07&page=2')

    await waitFor(() => expect(count()).toHaveTextContent('Showing 25–27, free on Saturday, 7 November 2026'))
  })

  it('under a date with one match on one page, says so in the singular', async () => {
    const page: DirectoryPage = directoryPage([summary()])
    delete page.total
    api(() => json(page))
    renderAt('/photographers?date=2026-11-07')

    await waitFor(() => expect(count()).toHaveTextContent('Showing 1 photographer free on Saturday, 7 November 2026'))
  })
})

describe('the mobile filter sheet', () => {
  function trigger() {
    return main().getByRole('button', { name: /^Filters/ })
  }

  it('says how many filters are on, in words', async () => {
    api()
    renderAt('/photographers?category=wedding&min=1&max=2')
    await loaded()

    expect(trigger()).toHaveAccessibleName('Filters, 2 active')
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('says no count with no filter on', async () => {
    api()
    renderAt()
    await loaded()

    expect(trigger()).toHaveAccessibleName('Filters')
  })

  it('applies nothing until “Show photographers”, then applies everything at once and closes', async () => {
    const { sent } = api()
    const { router } = renderAt()
    await loaded()
    const before = searches(sent).length

    await userEvent.click(trigger())
    const sheet = within(await screen.findByRole('dialog', { name: 'Filters' }))
    await waitFor(() => expect(sheet.getAllByRole('option', { name: 'Wedding' }).length).toBeGreaterThan(0))
    await userEvent.selectOptions(sheet.getByRole('combobox', { name: 'Category' }), 'Wedding')
    await userEvent.selectOptions(sheet.getByRole('combobox', { name: 'District' }), 'Kicukiro')
    await userEvent.type(sheet.getByRole('textbox', { name: 'Highest' }), '60000')
    expect(router.state.location.search).toBe('')
    expect(searches(sent)).toHaveLength(before)

    await userEvent.click(sheet.getByRole('button', { name: 'Show photographers' }))

    await waitFor(() => expect(router.state.location.search).toBe('?category=wedding&district=kicukiro&max=60000'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger()).toHaveFocus())
  })

  it('discards the draft on Escape, and returns focus to the button', async () => {
    api()
    const { router } = renderAt('/photographers?category=wedding')
    await loaded()

    await userEvent.click(trigger())
    const sheet = within(await screen.findByRole('dialog', { name: 'Filters' }))
    await userEvent.selectOptions(sheet.getByRole('combobox', { name: 'District' }), 'Gasabo')
    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(router.state.location.search).toBe('?category=wedding')
    expect(trigger()).toHaveFocus()

    // Opened again, it starts from the URL, not from what was discarded.
    await userEvent.click(trigger())
    expect(within(await screen.findByRole('dialog')).getByRole('combobox', { name: 'District' })).toHaveValue('')
  })

  it('keeps focus inside while open: Tab cycles through the sheet', async () => {
    api()
    renderAt()
    await loaded()

    await userEvent.click(trigger())
    const dialog = await screen.findByRole('dialog', { name: 'Filters' })
    for (let step = 0; step < 12; step++) {
      await userEvent.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('clears the draft with “Clear”, and applies that with “Show photographers”', async () => {
    api()
    const { router } = renderAt('/photographers?category=wedding&date=2026-11-07')
    await loaded()

    await userEvent.click(trigger())
    const sheet = within(await screen.findByRole('dialog', { name: 'Filters' }))
    await userEvent.click(sheet.getByRole('button', { name: 'Clear' }))
    expect(sheet.getByLabelText('Available on')).toHaveValue('')
    expect(router.state.location.search).toBe('?category=wedding&date=2026-11-07')

    await userEvent.click(sheet.getByRole('button', { name: 'Show photographers' }))
    await waitFor(() => expect(router.state.location.search).toBe(''))
  })

  it('refuses a price that is not digits in the sheet, and stays open', async () => {
    api()
    const { router } = renderAt()
    await loaded()

    await userEvent.click(trigger())
    const sheet = within(await screen.findByRole('dialog', { name: 'Filters' }))
    await userEvent.type(sheet.getByRole('textbox', { name: 'Lowest' }), '1.5')
    await userEvent.click(sheet.getByRole('button', { name: 'Show photographers' }))

    expect(await sheet.findByText('Enter a whole number of RWF, digits only.')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(router.state.location.search).toBe('')
  })
})

describe('the page title follows the filters (R6.6)', () => {
  it.each([
    ['/photographers', 'Find photographers across Rwanda · Bookly'],
    ['/photographers?category=wedding', 'Wedding photographers · Bookly'],
    ['/photographers?district=gasabo', 'Photographers in Gasabo · Bookly'],
    ['/photographers?category=wedding&district=gasabo', 'Wedding photographers in Gasabo · Bookly'],
  ])('%s is “%s”', async (path, title) => {
    api()
    renderAt(path)

    await waitFor(() => expect(document.title).toBe(title))
    expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute(
      'content',
      'Browse photographers across Rwanda by category, district, price and the date you need, and book a free time online.',
    )
  })
})
