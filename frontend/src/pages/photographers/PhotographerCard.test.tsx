import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { summary } from '@/test/marketplace-fixtures'
import { PhotographerCard, PhotographerGridSkeleton } from './PhotographerCard'

/** One photographer on the directory and the landing page (R6.1, R6.3, R6.5). */

function renderCard(props: Partial<Parameters<typeof PhotographerCard>[0]> = {}) {
  return render(
    <MemoryRouter>
      <PhotographerCard photographer={summary()} priority={false} {...props} />
    </MemoryRouter>,
  )
}

describe('PhotographerCard', () => {
  it('is one link to the profile, named by the photographer', () => {
    renderCard()

    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Kigali Lens' })).toHaveAttribute('href', '/p/kigali-lens')
  })

  it('names where they work and what they shoot, and the “from” price', () => {
    renderCard()

    expect(screen.getByText('Gasabo')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Shoots' })).getByText('Wedding')).toBeInTheDocument()
    expect(screen.getByText('From 35,000 RWF')).toBeInTheDocument()
  })

  it('drops the district line and the category list when there are none', () => {
    renderCard({ photographer: summary({ districts: [], categories: [] }) })

    expect(screen.queryByText('Works in')).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Shoots' })).not.toBeInTheDocument()
  })

  it('shows the badge only for a photographer not taking bookings', () => {
    const { container, unmount } = renderCard()
    expect(container.querySelector('[data-not-taking-bookings]')).toBeNull()
    unmount()

    const past = renderCard({ photographer: summary({ takingBookings: false }) })
    expect(past.container.querySelector('[data-not-taking-bookings]')).toHaveTextContent('Not taking bookings')
  })

  it('takes its heading level from where it sits', () => {
    renderCard({ headingLevel: 3 })

    expect(screen.getByRole('heading', { level: 3, name: 'Kigali Lens' })).toBeInTheDocument()
  })

  it('puts an https cover in an src with no Referer, eager only for the first card', () => {
    const { container, unmount } = renderCard({ priority: true })
    const image = container.querySelector('img')
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(image).toHaveAttribute('loading', 'eager')
    expect(image).toHaveAttribute('fetchpriority', 'high')
    unmount()

    expect(renderCard().container.querySelector('img')).toHaveAttribute('loading', 'lazy')
  })

  it.each([null, 'http://images.example.com/a.jpg', 'javascript:alert(1)', 'ftp://images.example.com/a.jpg'])(
    'keeps %j out of every src, with the camera block in its place',
    (coverImageUrl) => {
      const { container } = renderCard({ photographer: summary({ coverImageUrl }) })

      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('[aria-hidden="true"].aspect-4\\/3')).not.toBeNull()
    },
  )
})

describe('PhotographerGridSkeleton', () => {
  it('draws the asked number of placeholder cards, hidden from assistive technology', () => {
    render(<PhotographerGridSkeleton count={6} />)

    const grid = screen.getByTestId('photographer-skeletons')
    expect(grid).toHaveAttribute('aria-hidden', 'true')
    expect(grid.querySelectorAll('li')).toHaveLength(6)
  })
})
