import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { routes } from '@/routes'

/**
 * `/email-confirm/:token` (docs/prompts/client-access-and-admin-polish.md, item 6).
 *
 * What is proven: opening the page sends nothing (a mail scanner that opens
 * the link changes nothing); the button posts the token in the path; a 200
 * says it is done, a 404 is one "not valid" page, and anything else keeps the
 * button with an alert.
 */

const TOKEN = 'Cf7mN2bV9cX4zL1kJ8hG5fD3sA6pO0iU'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stub(respond: () => Response | Promise<Response>) {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => respond())
  vi.stubGlobal('fetch', mock)
  return mock
}

function renderPage() {
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [`/email-confirm/${TOKEN}`] })} />)
}

function user() {
  return userEvent.setup({ delay: null })
}

describe('confirming a new contact email', () => {
  it('sends nothing until the button is pressed', () => {
    const mock = stub(() => new Response('{}', { status: 200 }))
    renderPage()

    expect(screen.getByRole('heading', { level: 1, name: 'Confirm your new email' })).toBeInTheDocument()
    expect(mock).not.toHaveBeenCalled()
  })

  it('posts the token and says it is done', async () => {
    const mock = stub(() => new Response(JSON.stringify({ confirmed: true }), { status: 200 }))
    renderPage()

    await user().click(screen.getByRole('button', { name: 'Confirm this email' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Done. We will write to your new address from now on.')
    const [url, init] = mock.mock.calls[0] ?? []
    expect([url, init?.method]).toEqual([`/api/email-confirmations/${TOKEN}`, 'POST'])
    expect(screen.queryByRole('button', { name: 'Confirm this email' })).not.toBeInTheDocument()
  })

  it('shows one not-valid page for a link the API does not know', async () => {
    stub(() => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
    renderPage()

    await user().click(screen.getByRole('button', { name: 'Confirm this email' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'This confirmation link is not valid' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm this email' })).not.toBeInTheDocument()
  })

  it('keeps the button, with an alert, when it could not confirm', async () => {
    stub(() => Promise.reject(new TypeError('network')))
    renderPage()

    await user().click(screen.getByRole('button', { name: 'Confirm this email' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not confirm that.')
    expect(screen.getByRole('button', { name: 'Confirm this email' })).toBeInTheDocument()
  })
})
