import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { routes } from '@/routes'

/**
 * `/my-booking` (docs/prompts/client-access-and-admin-polish.md, item 4).
 *
 * What is proven: it sits in the client shell with one `main` and one `h1`; a
 * valid email is posted and answered with the same "if we found a booking"
 * message whatever the API knows; a malformed one is marked on the field and
 * never sent; a failure says so and keeps the form; "Use a different address"
 * brings the form back.
 */

const SENT_TITLE = 'Check your inbox'
const SENT_BODY = 'If we found a current booking for that address, we have emailed you a link.'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stub(respond: () => Response | Promise<Response>) {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => respond())
  vi.stubGlobal('fetch', mock)
  return mock
}

function renderPage() {
  return render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/my-booking'] })} />)
}

function user() {
  return userEvent.setup({ delay: null })
}

async function submit(email: string) {
  await user().type(screen.getByLabelText('Email'), email)
  await user().click(screen.getByRole('button', { name: 'Email me my links' }))
}

describe('the My booking page', () => {
  it('is a client page with one main and one h1', () => {
    stub(() => new Response(null, { status: 202 }))
    const { container } = renderPage()

    expect(screen.getByRole('heading', { level: 1, name: 'Find your booking' })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(container.querySelectorAll('main')).toHaveLength(1)
    expect(screen.getByRole('banner')).toBeInTheDocument()
  })

  it('posts the email and says the same thing whatever the API found', async () => {
    const mock = stub(() => new Response(JSON.stringify({ sent: true }), { status: 202 }))
    renderPage()

    await submit('  aline@example.com ')

    expect(await screen.findByRole('status')).toHaveTextContent(SENT_TITLE)
    expect(screen.getByRole('status')).toHaveTextContent(SENT_BODY)
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toStrictEqual({ email: 'aline@example.com' })
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
  })

  it('marks a malformed address on the field and sends nothing', async () => {
    const mock = stub(() => new Response(null, { status: 202 }))
    renderPage()

    await submit('not-an-email')

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Email')).toHaveFocus()
    expect(mock).not.toHaveBeenCalled()
  })

  it('marks the field when the API refuses the address', async () => {
    stub(() => new Response(JSON.stringify({ error: 'validation_failed', fields: ['email'] }), { status: 422 }))
    renderPage()

    await submit('aline@example.com')

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says so when it could not send, keeping the form', async () => {
    stub(() => Promise.reject(new TypeError('network')))
    renderPage()

    await submit('aline@example.com')

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not send that.')
    expect(screen.getByLabelText('Email')).toHaveValue('aline@example.com')
  })

  it('brings the form back for another address', async () => {
    stub(() => new Response(null, { status: 202 }))
    renderPage()
    await submit('aline@example.com')
    await screen.findByRole('status')

    await user().click(screen.getByRole('button', { name: 'Use a different address' }))

    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
