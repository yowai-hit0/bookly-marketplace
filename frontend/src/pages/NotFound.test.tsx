import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { NotFound } from './NotFound'

function renderNotFound() {
  const router = createMemoryRouter(
    [
      { path: '/', element: <p>home page</p> },
      { path: '/photographers', element: <p>photographers list</p> },
      { path: '*', element: <NotFound /> },
    ],
    { initialEntries: ['/nowhere'] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('NotFound', () => {
  it('renders its copy through i18next', () => {
    renderNotFound()

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByText('That page does not exist.')).toBeInTheDocument()
  })

  // client-front.md 8.5, 2026-09-27: the redesign replaces the old "All services"
  // back link with a Home / Browse pair, so nothing on this page is named "All
  // services" any more -- that name now belongs only to the service page's own
  // back link. The pair leads to the photographers since brief decision 9.
  it('offers a Home link and a Browse photographers link, and no button', async () => {
    const router = renderNotFound()

    expect(screen.queryByRole('link', { name: 'All services' })).not.toBeInTheDocument()
    const home = screen.getByRole('link', { name: 'Home' })
    const photographers = screen.getByRole('link', { name: 'Browse photographers' })
    expect(home).toHaveAttribute('href', '/')
    expect(photographers).toHaveAttribute('href', '/photographers')
    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    await userEvent.setup({ delay: null }).click(photographers)

    expect(router.state.location.pathname).toBe('/photographers')
    expect(screen.getByText('photographers list')).toBeInTheDocument()
  })
})
