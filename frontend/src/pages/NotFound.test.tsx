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
      { path: '/services', element: <p>services list</p> },
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
  // back link with a Home / Browse services pair, so nothing on this page is
  // named "All services" any more -- that name now belongs only to the service
  // page's own back link.
  it('offers a Home link and a Browse services link, and no button', async () => {
    const router = renderNotFound()

    expect(screen.queryByRole('link', { name: 'All services' })).not.toBeInTheDocument()
    const home = screen.getByRole('link', { name: 'Home' })
    const services = screen.getByRole('link', { name: 'Browse services' })
    expect(home).toHaveAttribute('href', '/')
    expect(services).toHaveAttribute('href', '/services')
    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    await userEvent.setup({ delay: null }).click(services)

    expect(router.state.location.pathname).toBe('/services')
    expect(screen.getByText('services list')).toBeInTheDocument()
  })
})
