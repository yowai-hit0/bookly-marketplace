import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { serviceSummary } from '@/test/marketplace-fixtures'
import { ServiceCard, ServiceGridSkeleton } from './ServiceCard'

/** One service on a profile (R6.2, R6.5): one link, the "from" price or "Price on request", https-only cover. */

function renderCard(props: Partial<Parameters<typeof ServiceCard>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ServiceCard handle="kigali-lens" service={serviceSummary()} priority={false} {...props} />
    </MemoryRouter>,
  )
}

describe('ServiceCard', () => {
  it('is one link, to the service under its photographer, named by the service', () => {
    renderCard()

    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Portraits' })).toHaveAttribute('href', '/p/kigali-lens/portraits')
  })

  it('encodes the handle and slug as path segments', () => {
    renderCard({ handle: 'a b', service: serviceSummary({ slug: 'x/y' }) })

    expect(screen.getByRole('link')).toHaveAttribute('href', '/p/a%20b/x%2Fy')
  })

  it('shows the “from” price, and “Price on request” when there is none', () => {
    const { unmount } = renderCard()
    expect(screen.getByText('From 25,000 RWF')).toBeInTheDocument()
    unmount()

    renderCard({ service: serviceSummary({ fromPriceRwf: null }) })
    expect(screen.getByText('Price on request')).toBeInTheDocument()
    expect(screen.queryByText(/^From/)).not.toBeInTheDocument()
  })

  it('shows a free service as 0 RWF, not as on request', () => {
    renderCard({ service: serviceSummary({ fromPriceRwf: 0 }) })

    expect(screen.getByText('From 0 RWF')).toBeInTheDocument()
  })

  it('takes its heading level from where it sits', () => {
    const { unmount } = renderCard()
    expect(screen.getByRole('heading', { level: 2, name: 'Portraits' })).toBeInTheDocument()
    unmount()

    renderCard({ headingLevel: 3 })
    expect(screen.getByRole('heading', { level: 3, name: 'Portraits' })).toBeInTheDocument()
  })

  it('offers “Book” while bookings are open, “See details” when not', () => {
    const { unmount } = renderCard()
    expect(screen.getByText('Book')).toBeInTheDocument()
    unmount()

    renderCard({ takingBookings: false })
    expect(screen.getByText('See details')).toBeInTheDocument()
    expect(screen.queryByText('Book')).not.toBeInTheDocument()
  })

  it('offers “See details”, not “Book”, for a service with no package to book', () => {
    renderCard({ service: serviceSummary({ fromPriceRwf: null }) })

    expect(screen.getByText('See details')).toBeInTheDocument()
    expect(screen.queryByText('Book')).not.toBeInTheDocument()
  })

  it('puts an https cover in an src with no Referer, lazily unless it is the first', () => {
    const { container, unmount } = renderCard()
    const image = container.querySelector('img')
    expect(image).toHaveAttribute('src', 'https://images.example.com/portraits.jpg')
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(image).toHaveAttribute('loading', 'lazy')
    unmount()

    const first = renderCard({ priority: true })
    expect(first.container.querySelector('img')).toHaveAttribute('loading', 'eager')
  })

  it.each([null, 'http://images.example.com/a.jpg', 'javascript:alert(1)', '//images.example.com/a.jpg'])(
    'shows the camera block, never an src, for %j',
    (coverImageUrl) => {
      const { container } = renderCard({ service: serviceSummary({ coverImageUrl }) })

      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('[aria-hidden="true"].aspect-4\\/3')).not.toBeNull()
    },
  )

  it('leaves out an empty description', () => {
    const { container } = renderCard({ service: serviceSummary({ descriptionEn: '  ' }) })

    expect(container.querySelector('p.line-clamp-2')).toBeNull()
  })
})

describe('ServiceGridSkeleton', () => {
  it('draws the asked number of placeholder cards, hidden from assistive technology', () => {
    render(<ServiceGridSkeleton count={3} />)

    const grid = screen.getByTestId('service-skeletons')
    expect(grid).toHaveAttribute('aria-hidden', 'true')
    expect(grid.querySelectorAll('li')).toHaveLength(3)
  })
})
