import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { PublicPhotographerProfile } from '@/catalogue/api'
import { routes } from '@/routes'
import { json, stubApi } from '@/test/fetch'
import { profile, serviceSummary } from '@/test/marketplace-fixtures'

/**
 * A photographer's profile at `/p/:handle` (marketplace spec R6.2, R6.3,
 * R6.5, T6.4; `design-system/bookly/pages/photographer-profile.md`), rendered
 * through the real routes with `fetch` stubbed.
 *
 * What is proven: one anonymous request; the header, the bio as plain text
 * with its line breaks (a `<script>` shows as characters); https-only images
 * with no Referer; the services with their "from" prices or "Price on
 * request"; the portfolio and its lightbox by keyboard (arrows, Escape, the
 * focus trap, focus returned); the cancellation terms in words; only the
 * contact channels that are set; the not-taking-bookings, unavailable and
 * failed states; and the page's meta.
 */

const API = '/api/photographers/kigali-lens'

function api(answer: () => Response | Promise<Response>) {
  return stubApi(({ url }) => (url.startsWith('/api/photographers/') ? answer() : undefined))
}

function serve(overrides: Partial<PublicPhotographerProfile> = {}) {
  return api(() => json({ photographer: profile(overrides) }))
}

function renderAt(path = '/p/kigali-lens') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const view = render(<RouterProvider router={router} />)
  return { router, ...view }
}

function main() {
  return within(screen.getByRole('main'))
}

async function ready() {
  return screen.findByRole('heading', { level: 1, name: 'Kigali Lens' })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the profile', () => {
  it('loads from one anonymous request, and heads the page with the name', async () => {
    const { sent } = serve()
    renderAt()

    await ready()
    expect(sent.map(({ url }) => url)).toEqual([API])
    expect(sent[0]?.headers.has('Authorization')).toBe(false)
    expect(main().getByRole('link', { name: 'All photographers' })).toHaveAttribute('href', '/photographers')
  })

  it('says it is loading, with placeholder cards, until the profile arrives', async () => {
    let answer: (res: Response) => void = () => {}
    api(() => new Promise<Response>((resolve) => (answer = resolve)))
    renderAt()

    expect(await screen.findByRole('status')).toHaveTextContent('Loading…')
    expect(screen.getByTestId('service-skeletons')).toHaveAttribute('aria-hidden', 'true')

    answer(json({ photographer: profile() }))
    await ready()
    expect(screen.queryByTestId('service-skeletons')).not.toBeInTheDocument()
  })

  it('names every district and category', async () => {
    serve()
    renderAt()
    await ready()

    expect(main().getByText('Gasabo, Kicukiro')).toBeInTheDocument()
    expect(within(main().getByRole('list', { name: 'Shoots' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Wedding',
      'Portrait',
    ])
  })

  it('shows an https cover with no Referer', async () => {
    serve()
    const { container } = renderAt()
    await ready()

    const cover = container.querySelector('main header img')
    expect(cover).toHaveAttribute('src', 'https://images.example.com/kigali-cover.jpg')
    expect(cover).toHaveAttribute('referrerpolicy', 'no-referrer')
  })

  it.each(['http://images.example.com/c.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA'])(
    'shows no cover band at all for %s',
    async (coverImageUrl) => {
      serve({ coverImageUrl })
      const { container } = renderAt()
      await ready()

      expect(container.querySelector('main header img')).toBeNull()
      expect(container.querySelector('main header [aria-hidden="true"].aspect-video')).toBeNull()
    },
  )

  it('wraps a very long name inside the page', async () => {
    const displayName = 'K'.repeat(120)
    serve({ displayName })
    renderAt()

    expect(await screen.findByRole('heading', { level: 1, name: displayName })).toHaveClass('wrap-anywhere')
  })
})

describe('the bio, as plain text (R6.5, T6.4)', () => {
  it('keeps the photographer’s line breaks', async () => {
    serve({ bio: 'Portraits in natural light.\n\nWeddings across Rwanda.' })
    const { container } = renderAt()
    await ready()

    const bio = container.querySelector('[data-bio]')
    expect(bio?.textContent).toBe('Portraits in natural light.\n\nWeddings across Rwanda.')
    expect(bio).toHaveClass('whitespace-pre-line')
  })

  it('shows a <script> as the characters it is, and runs nothing', async () => {
    const bio = '<script>window.__pwned = true</script><b>bold</b> <img src=x onerror="window.__pwned = true">'
    serve({ bio })
    const { container } = renderAt()
    await ready()

    expect(container.querySelector('[data-bio]')?.textContent).toBe(bio)
    expect(container.querySelector('main script, main b, main img[src="x"]')).toBeNull()
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('treats markdown as text too', async () => {
    serve({ bio: '**Bold** and [a link](javascript:alert(1))' })
    const { container } = renderAt()
    await ready()

    expect(container.querySelector('[data-bio]')?.textContent).toBe('**Bold** and [a link](javascript:alert(1))')
    expect(within(container.querySelector('[data-bio]') as HTMLElement).queryByRole('link')).toBeNull()
  })

  it.each([null, '', '   '])('shows no bio paragraph for %j', async (value) => {
    serve({ bio: value })
    const { container } = renderAt()
    await ready()

    expect(container.querySelector('[data-bio]')).toBeNull()
  })

  it('wraps a long unbroken bio inside the page', async () => {
    serve({ bio: 'x'.repeat(2000) })
    const { container } = renderAt()
    await ready()

    expect(container.querySelector('[data-bio]')).toHaveClass('wrap-anywhere')
  })
})

describe('services', () => {
  it('links each service to its page under the handle, with its “from” price', async () => {
    serve()
    renderAt()
    await ready()

    const services = within(main().getByRole('region', { name: 'Services' }))
    expect(services.getByRole('link', { name: 'Portraits' })).toHaveAttribute('href', '/p/kigali-lens/portraits')
    expect(services.getByRole('link', { name: 'Weddings' })).toHaveAttribute('href', '/p/kigali-lens/weddings')
    expect(services.getByText('From 25,000 RWF')).toBeInTheDocument()
    expect(services.getByText('From 600,000 RWF')).toBeInTheDocument()
    expect(services.getAllByText('Book')).toHaveLength(2)
  })

  it('reads “Price on request” for a service with no active package', async () => {
    serve({ services: [serviceSummary({ fromPriceRwf: null })] })
    renderAt()
    await ready()

    const services = within(main().getByRole('region', { name: 'Services' }))
    expect(services.getByText('Price on request')).toBeInTheDocument()
    expect(services.queryByText(/^From /)).not.toBeInTheDocument()
    expect(services.getByText('See details')).toBeInTheDocument()
    expect(services.queryByText('Book')).not.toBeInTheDocument()
  })

  it('shows a service cover only when it is https, with no Referer', async () => {
    serve({
      coverImageUrl: null,
      services: [
        serviceSummary(),
        serviceSummary({ slug: 'b', nameEn: 'B', coverImageUrl: 'http://images.example.com/b.jpg' }),
        serviceSummary({ slug: 'c', nameEn: 'C', coverImageUrl: 'javascript:alert(1)' }),
      ],
    })
    const { container } = renderAt()
    await ready()

    const images = Array.from(container.querySelectorAll('section[aria-labelledby="profile-services"] img'))
    expect(images.map((image) => image.getAttribute('src'))).toEqual(['https://images.example.com/portraits.jpg'])
    expect(images[0]).toHaveAttribute('referrerpolicy', 'no-referrer')
  })

  it('says so when the photographer has no service', async () => {
    serve({ services: [] })
    renderAt()
    await ready()

    expect(main().getByText('No services are available to book right now.')).toBeInTheDocument()
  })
})

describe('a photographer not taking bookings (R5.5)', () => {
  it('shows the notice, keeps the services, and no card offers to book', async () => {
    serve({ takingBookings: false })
    const { container } = renderAt()
    await ready()

    expect(container.querySelector('[data-not-taking-bookings]')).toHaveTextContent('Not taking bookings right now')
    const services = within(main().getByRole('region', { name: 'Services' }))
    expect(services.getAllByText('See details')).toHaveLength(2)
    expect(services.queryByText('Book')).not.toBeInTheDocument()
  })

  it('shows no notice while bookings are open', async () => {
    serve()
    const { container } = renderAt()
    await ready()

    expect(container.querySelector('[data-not-taking-bookings]')).toBeNull()
  })
})

describe('cancellation terms, in words', () => {
  it('states a refundable policy with its cut-off, and the platform’s rule for a photographer who cancels', async () => {
    serve({ cancellationPolicy: { cutoffHours: 24, bookingFeeRefundable: true } })
    renderAt()
    await ready()

    const terms = within(main().getByRole('region', { name: 'Cancellation' }))
    expect(terms.getByText('The booking fee is refunded if you cancel at least 24 hours before the shoot.')).toBeInTheDocument()
    expect(terms.getByText('A photographer who cancels always refunds the booking fee in full.')).toBeInTheDocument()
  })

  it('states a non-refundable policy with no cut-off', async () => {
    serve({ cancellationPolicy: { cutoffHours: 0, bookingFeeRefundable: false } })
    renderAt()
    await ready()

    expect(within(main().getByRole('region', { name: 'Cancellation' })).getByText('The booking fee is non-refundable if you cancel.')).toBeInTheDocument()
  })
})

describe('contact (R6.2, R6.5)', () => {
  it('links phone, WhatsApp and email, WhatsApp in a new tab with no opener or referrer', async () => {
    serve()
    renderAt()
    await ready()

    const contact = within(main().getByRole('region', { name: 'Contact' }))
    expect(contact.getByRole('link', { name: '+250 788 000 000' })).toHaveAttribute('href', 'tel:+250788000000')
    const whatsapp = contact.getByRole('link', { name: '+250 788 111 222' })
    expect(whatsapp).toHaveAttribute('href', 'https://wa.me/250788111222')
    expect(whatsapp).toHaveAttribute('target', '_blank')
    expect(whatsapp).toHaveAttribute('rel', 'noopener noreferrer')
    expect(contact.getByRole('link', { name: 'hello@kigalilens.rw' })).toHaveAttribute('href', 'mailto:hello@kigalilens.rw')
  })

  it('shows only the channels that are set', async () => {
    serve({ contactPhone: null, email: null })
    renderAt()
    await ready()

    const contact = within(main().getByRole('region', { name: 'Contact' }))
    expect(contact.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['https://wa.me/250788111222'])
    expect(contact.queryByText('Phone')).not.toBeInTheDocument()
  })

  it('shows no contact panel, and no placeholder, when none is set', async () => {
    serve({ contactPhone: null, whatsappPhone: null, email: null })
    renderAt()
    await ready()

    expect(main().queryByRole('region', { name: 'Contact' })).not.toBeInTheDocument()
    expect(screen.queryByText(/example\.com|\+250 700 000 000|studio name/i)).not.toBeInTheDocument()
  })
})

describe('the portfolio and its lightbox', () => {
  function thumbnails() {
    return within(main().getByRole('region', { name: 'Portfolio' })).getAllByRole('button')
  }

  it('lists each https image as a thumbnail button, lazy, with no Referer, and its caption', async () => {
    serve()
    renderAt()
    await ready()

    const portfolio = within(main().getByRole('region', { name: 'Portfolio' }))
    expect(thumbnails().map((button) => button.getAttribute('aria-label'))).toEqual([
      'View photo 1 of 3',
      'View photo 2 of 3',
      'View photo 3 of 3',
    ])
    for (const image of portfolio.getAllByRole('presentation')) {
      expect(image).toHaveAttribute('loading', 'lazy')
      expect(image).toHaveAttribute('referrerpolicy', 'no-referrer')
    }
    expect(portfolio.getByText('Akagera at dawn')).toBeInTheDocument()
    expect(portfolio.getByText('A wedding in Rubavu')).toBeInTheDocument()
  })

  it('leaves out an image that is not https, and counts without it', async () => {
    serve({
      portfolio: [
        { url: 'https://images.example.com/p1.jpg', caption: null },
        { url: 'http://images.example.com/p2.jpg', caption: 'Plain http' },
        { url: 'javascript:alert(1)', caption: 'Script' },
      ],
    })
    renderAt()
    await ready()

    expect(thumbnails().map((button) => button.getAttribute('aria-label'))).toEqual(['View photo 1 of 1'])
    expect(main().queryByText('Plain http')).not.toBeInTheDocument()
  })

  it('has no portfolio section when there is no image to show', async () => {
    serve({ portfolio: [] })
    renderAt()
    await ready()

    expect(main().queryByRole('region', { name: 'Portfolio' })).not.toBeInTheDocument()
  })

  it('opens an image large, with its caption and its place', async () => {
    serve()
    renderAt()
    await ready()

    await userEvent.click(thumbnails()[0] as HTMLElement)

    const lightbox = within(await screen.findByRole('dialog'))
    expect(lightbox.getByRole('img', { name: 'Akagera at dawn' })).toHaveAttribute('src', 'https://images.example.com/p1.jpg')
    expect(lightbox.getByRole('img', { name: 'Akagera at dawn' })).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(lightbox.getByText('1 of 3')).toBeInTheDocument()
  })

  it('names an image with no caption by its place and the photographer', async () => {
    serve()
    renderAt()
    await ready()

    await userEvent.click(thumbnails()[1] as HTMLElement)

    expect(within(await screen.findByRole('dialog')).getByRole('img', { name: 'Photo 2 by Kigali Lens' })).toBeInTheDocument()
  })

  it('moves with the arrow keys, wrapping at both ends', async () => {
    serve()
    renderAt()
    await ready()
    await userEvent.click(thumbnails()[0] as HTMLElement)
    const lightbox = within(await screen.findByRole('dialog'))

    await userEvent.keyboard('{ArrowRight}')
    expect(lightbox.getByText('2 of 3')).toBeInTheDocument()
    await userEvent.keyboard('{ArrowRight}{ArrowRight}')
    expect(lightbox.getByText('1 of 3')).toBeInTheDocument()
    await userEvent.keyboard('{ArrowLeft}')
    expect(lightbox.getByText('3 of 3')).toBeInTheDocument()
    expect(lightbox.getByRole('img', { name: 'A wedding in Rubavu' })).toBeInTheDocument()
  })

  it('moves with the Previous and Next buttons too', async () => {
    serve()
    renderAt()
    await ready()
    await userEvent.click(thumbnails()[0] as HTMLElement)
    const lightbox = within(await screen.findByRole('dialog'))

    await userEvent.click(lightbox.getByRole('button', { name: 'Next photo' }))
    expect(lightbox.getByText('2 of 3')).toBeInTheDocument()
    await userEvent.click(lightbox.getByRole('button', { name: 'Previous photo' }))
    expect(lightbox.getByText('1 of 3')).toBeInTheDocument()
  })

  it('closes on Escape and returns focus to the thumbnail of the image last shown', async () => {
    serve()
    renderAt()
    await ready()
    await userEvent.click(thumbnails()[0] as HTMLElement)
    await screen.findByRole('dialog')

    await userEvent.keyboard('{ArrowRight}{ArrowRight}{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(thumbnails()[2]).toHaveFocus()
  })

  it('closes with its × button, named in words', async () => {
    serve()
    renderAt()
    await ready()
    await userEvent.click(thumbnails()[1] as HTMLElement)

    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close photo' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(thumbnails()[1]).toHaveFocus()
  })

  it('keeps focus inside while open', async () => {
    serve()
    renderAt()
    await ready()
    await userEvent.click(thumbnails()[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog')

    for (let step = 0; step < 6; step++) {
      await userEvent.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('opens from the keyboard alone', async () => {
    serve()
    renderAt()
    await ready()

    ;(thumbnails()[2] as HTMLElement).focus()
    await userEvent.keyboard('{Enter}')

    expect(within(await screen.findByRole('dialog')).getByText('3 of 3')).toBeInTheDocument()
  })

  it('offers no Previous or Next for a single image, and the arrows do nothing', async () => {
    serve({ portfolio: [{ url: 'https://images.example.com/p1.jpg', caption: 'Only one' }] })
    renderAt()
    await ready()
    await userEvent.click(thumbnails()[0] as HTMLElement)
    const lightbox = within(await screen.findByRole('dialog'))

    expect(lightbox.queryByRole('button', { name: 'Next photo' })).not.toBeInTheDocument()
    await userEvent.keyboard('{ArrowRight}')
    expect(lightbox.getByText('1 of 1')).toBeInTheDocument()
  })

  it('shows a caption as text, never markup', async () => {
    serve({ portfolio: [{ url: 'https://images.example.com/p1.jpg', caption: '<script>alert(1)</script>' }] })
    const { container } = renderAt()
    await ready()

    expect(main().getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(container.querySelector('main script')).toBeNull()
  })
})

describe('reading order', () => {
  it('puts the terms and contact before the portfolio, so a phone reaches them first', async () => {
    serve()
    renderAt()
    await ready()

    expect(main().getAllByRole('region').map((region) => region.getAttribute('aria-labelledby'))).toEqual([
      'profile-services',
      'profile-cancellation',
      'profile-contact',
      'profile-portfolio',
    ])
  })
})

describe('a profile with nothing optional', () => {
  it('is the header, the services and the terms: no bio, portfolio, contact or cover', async () => {
    serve({ bio: null, portfolio: [], contactPhone: null, whatsappPhone: null, email: null, coverImageUrl: null, districts: [], categories: [] })
    const { container } = renderAt()
    await ready()

    expect(container.querySelector('main img')).not.toBeNull() // the services' own covers only
    expect(container.querySelector('main header img')).toBeNull()
    expect(main().getAllByRole('region').map((region) => region.getAttribute('aria-labelledby'))).toEqual([
      'profile-services',
      'profile-cancellation',
    ])
  })
})

describe('unavailable and failed', () => {
  it('says the photographer is unavailable on a 404, and keeps the page out of search results', async () => {
    api(() => json({ error: 'not_found' }, 404))
    renderAt('/p/nobody')

    expect(await screen.findByRole('heading', { level: 1, name: 'This photographer is unavailable' })).toBeInTheDocument()
    await waitFor(() => expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex'))
    expect(document.title).toBe('Photographer unavailable · Bookly')
  })

  it('shows an alert when the API fails, and loads again on “Try again”', async () => {
    let calls = 0
    api(() => (++calls === 1 ? json({ error: 'internal_error' }, 500) : json({ photographer: profile() })))
    renderAt()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load this photographer. Check your connection and try again.')
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    await ready()
  })
})

describe('meta (R6.6)', () => {
  it('titles the page with the name, describes it with the bio, and previews the cover', async () => {
    serve({ bio: 'Portraits and weddings\nin natural light.' })
    renderAt()
    await ready()

    await waitFor(() => expect(document.title).toBe('Kigali Lens · Bookly'))
    expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute('content', 'Portraits and weddings in natural light.')
    expect(document.head.querySelector('meta[property="og:type"]')).toHaveAttribute('content', 'profile')
    expect(document.head.querySelector('meta[property="og:image"]')).toHaveAttribute('content', 'https://images.example.com/kigali-cover.jpg')
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull()
  })

  it('cuts a long bio to an excerpt', async () => {
    serve({ bio: 'Light '.repeat(100) })
    renderAt()
    await ready()

    const description = () => document.head.querySelector('meta[name="description"]')?.getAttribute('content') ?? ''
    await waitFor(() => expect(description().endsWith('…')).toBe(true))
    expect(description().length).toBeLessThanOrEqual(155)
  })

  it('describes a profile with no bio in words of its own', async () => {
    serve({ bio: null, coverImageUrl: null })
    renderAt()
    await ready()

    await waitFor(() =>
      expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute(
        'content',
        "See Kigali Lens's services, prices and free times, and book online.",
      ),
    )
    expect(document.head.querySelector('meta[property="og:image"]')).toBeNull()
  })
})
