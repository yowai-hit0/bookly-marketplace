import { act, render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { RequireSession } from './RequireSession'
import { AREAS, type Area, clearSession, saveSession } from './session'

/**
 * Each area's routes are guarded by its own session (marketplace spec R2.6)
 * and send a signed-out visitor to that area's login, carrying where they
 * were going.
 */

const SESSION = { token: 'live.token.signature', expiresAt: '2099-01-01T00:00:00.000Z' }

function LoginProbe({ area }: { area: Area }) {
  const { search } = useLocation()
  return <h1>{`${area} login ${search}`}</h1>
}

function renderGuarded(area: Area, path: string) {
  const router = createMemoryRouter(
    [
      {
        path: `/${area}/*`,
        element: (
          <RequireSession area={area}>
            <h1>{`${area} page`}</h1>
          </RequireSession>
        ),
      },
      { path: `/${area}/login`, element: <LoginProbe area={area} /> },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

afterEach(() => {
  sessionStorage.clear()
})

describe('RequireSession', () => {
  it.each(AREAS)('renders the %s page while its session is live', (area) => {
    saveSession(area, SESSION)
    renderGuarded(area, `/${area}/somewhere`)

    expect(screen.getByRole('heading', { name: `${area} page` })).toBeInTheDocument()
  })

  it.each(AREAS)('sends a signed-out visitor to the %s login, carrying the path and query', (area) => {
    const router = renderGuarded(area, `/${area}/somewhere?x=1`)

    expect(router.state.location.pathname).toBe(`/${area}/login`)
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(`/${area}/somewhere?x=1`)
    // Replaced, so Back does not bounce off the guard again.
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it.each<[Area, Area]>([
    ['studio', 'platform'],
    ['platform', 'studio'],
    ['account', 'studio'],
    ['studio', 'account'],
  ])('does not open the %s area with only a %s session', (guarded, signedIn) => {
    saveSession(signedIn, SESSION)
    const router = renderGuarded(guarded, `/${guarded}/somewhere`)

    expect(router.state.location.pathname).toBe(`/${guarded}/login`)
  })

  it('treats an expired session as none', () => {
    saveSession('platform', { ...SESSION, expiresAt: '2000-01-01T00:00:00.000Z' })
    const router = renderGuarded('platform', '/platform/photographers')

    expect(router.state.location.pathname).toBe('/platform/login')
  })

  it('leaves for the login as soon as the session is dropped, as a 401 does', () => {
    saveSession('account', SESSION)
    const router = renderGuarded('account', '/account/somewhere')
    expect(screen.getByRole('heading', { name: 'account page' })).toBeInTheDocument()

    act(() => clearSession('account'))

    expect(router.state.location.pathname).toBe('/account/login')
  })

  it('never carries the fragment, where emailed links keep their tokens', () => {
    const router = renderGuarded('studio', '/studio/bookings#token=secret')

    expect(router.state.location.search).not.toContain('secret')
  })
})
