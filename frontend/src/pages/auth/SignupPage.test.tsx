import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { routes } from '@/routes'
import { json, stubApi } from '@/test/fetch'

/**
 * `/studio/signup` and `/account/signup` (marketplace spec R2.2, R2.3,
 * R2.1c). Whatever the address, a sent form says one thing: "if an account
 * needs it, we've sent an email". A taken handle is the one refusal about the
 * account worth wording, because handles are public.
 */

const SENT = 'If an account needs it, we\'ve sent an email with a link to confirm the address.'
const RESENT = 'If an account needs it, we\'ve sent an email with a new link.'
const PASSWORD = 'correct horse battery staple'

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

async function fillStudio(values: Partial<Record<'email' | 'password' | 'displayName' | 'handle', string>> = {}) {
  const u = user()
  const { email = 'lens@kigali.example', password = PASSWORD, displayName = 'Kigali Lens', handle = 'kigali-lens' } = values
  if (email !== '') await u.type(screen.getByLabelText('Email'), email)
  if (password !== '') await u.type(screen.getByLabelText('Password'), password)
  if (displayName !== '') await u.type(screen.getByLabelText('Display name'), displayName)
  if (handle !== '') await u.type(screen.getByLabelText('Handle'), handle)
  await u.click(screen.getByRole('button', { name: 'Create studio' }))
}

async function fillAccount(values: Partial<Record<'email' | 'password' | 'fullName', string>> = {}) {
  const u = user()
  const { email = 'aline@example.com', password = PASSWORD, fullName = 'Aline Uwase' } = values
  if (email !== '') await u.type(screen.getByLabelText('Email'), email)
  if (password !== '') await u.type(screen.getByLabelText('Password'), password)
  if (fullName !== '') await u.type(screen.getByLabelText('Full name'), fullName)
  await u.click(screen.getByRole('button', { name: 'Create account' }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

describe('the studio signup', () => {
  it('is a console panel with the four fields and a way back to sign in', () => {
    stubApi(() => undefined)
    renderAt('/studio/signup')

    expect(screen.getByRole('heading', { level: 1, name: 'Create your studio' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Display name')).toBeInTheDocument()
    expect(screen.getByLabelText('Handle')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Already have an account? Sign in' })).toHaveAttribute('href', '/studio/login')
    // Outside the client shell, like the studio's sign in.
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
  })

  it('is reached from the studio sign in', async () => {
    stubApi(() => undefined)
    const router = renderAt('/studio/login')

    await user().click(screen.getByRole('link', { name: 'New photographer? Create your studio' }))

    expect(router.state.location.pathname).toBe('/studio/signup')
  })

  it('posts the form, the handle normalised, and says check your inbox', async () => {
    const api = stubApi(({ url }) => (url === '/api/studio/auth/signup' ? json({ ok: true }, 202) : undefined))
    renderAt('/studio/signup')

    await fillStudio({ email: ' lens@kigali.example ', displayName: ' Kigali Lens ', handle: 'Kigali-Lens' })

    expect(await screen.findByRole('status')).toHaveTextContent('Check your inbox')
    expect(screen.getByRole('status')).toHaveTextContent(SENT)
    expect(api.sent).toHaveLength(1)
    expect(api.sent[0]).toMatchObject({
      method: 'POST',
      url: '/api/studio/auth/signup',
      body: { email: 'lens@kigali.example', password: PASSWORD, displayName: 'Kigali Lens', handle: 'kigali-lens' },
    })
    // The form is gone, so a second send cannot be used to probe addresses.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(sessionStorage.length).toBe(0)
  })

  it('shows the handle rule part by part as it is typed, with the profile address', async () => {
    stubApi(() => undefined)
    renderAt('/studio/signup')
    const field = screen.getByLabelText('Handle')
    const rule = (name: string) => document.querySelector(`[data-rule="${name}"]`)

    expect(rule('length')).toHaveAttribute('data-met', 'false')
    expect(screen.queryByText(/Your profile address/)).not.toBeInTheDocument()

    await user().type(field, '-a')
    expect(rule('length')).toHaveAttribute('data-met', 'false')
    expect(rule('chars')).toHaveAttribute('data-met', 'true')
    expect(rule('edges')).toHaveAttribute('data-met', 'false')
    expect(rule('edges')).toHaveTextContent('Not met yet:')

    await user().clear(field)
    await user().type(field, 'Kigali_Lens')
    expect(rule('length')).toHaveAttribute('data-met', 'true')
    expect(rule('chars')).toHaveAttribute('data-met', 'false')
    expect(screen.getByText('Your profile address: /p/kigali_lens')).toBeInTheDocument()

    await user().clear(field)
    await user().type(field, 'kigali-lens')
    for (const name of ['length', 'chars', 'edges']) expect(rule(name)).toHaveAttribute('data-met', 'true')
    expect(rule('edges')).toHaveTextContent('Met:')
    expect(screen.getByText('Your profile address: /p/kigali-lens')).toBeInTheDocument()
    // The rule describes the field, so it is heard with the label.
    const describedBy = field.getAttribute('aria-describedby') ?? ''
    expect(describedBy.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ')).toContain('3 to 30 characters')
  })

  it.each<[string, Parameters<typeof fillStudio>[0], string, string]>([
    ['a malformed email', { email: 'not-an-email' }, 'Email', 'Enter a valid email address.'],
    ['a short password', { password: 'short' }, 'Password', 'Use 12 to 1024 characters.'],
    ['no display name', { displayName: '' }, 'Display name', 'Enter a name of up to 80 characters.'],
    ['a handle that breaks the rule', { handle: '-bad' }, 'Handle', 'Use 3 to 30 lowercase letters, numbers and hyphens, with a letter or number at each end.'],
  ])('refuses %s before asking the API, and focuses the field', async (_label, values, label, message) => {
    const api = stubApi(() => json({ ok: true }, 202))
    renderAt('/studio/signup')

    await fillStudio(values)

    const field = screen.getByLabelText(label)
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription(expect.stringContaining(message))
    expect(field).toHaveFocus()
    expect(api.sent).toHaveLength(0)
  })

  it('says a taken or reserved handle is unavailable, on the handle', async () => {
    stubApi(() => json({ error: 'handle_taken' }, 409))
    renderAt('/studio/signup')

    await fillStudio({ handle: 'studio' })

    const field = screen.getByLabelText('Handle')
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'))
    expect(field).toHaveAccessibleDescription(expect.stringContaining('That handle is unavailable. Try another.'))
    expect(field).toHaveFocus()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('puts a 422 on the fields the API names', async () => {
    stubApi(() => json({ error: 'validation_failed', fields: ['displayName', 'email'] }, 422))
    renderAt('/studio/signup')

    await fillStudio()

    await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Handle')).not.toHaveAttribute('aria-invalid')
    expect(screen.getByLabelText('Email')).toHaveFocus()
  })

  it.each<[string, () => Response | Promise<Response>, string]>([
    ['a 400', () => json({ error: 'invalid_request' }, 400), 'Some details were not accepted. Check the form and try again.'],
    ['a 422 naming no field the form has', () => json({ error: 'validation_failed', fields: ['other'] }, 422), 'Some details were not accepted. Check the form and try again.'],
    ['a 429', () => json({ error: 'rate_limited' }, 429), 'Too many attempts from here. Wait a few minutes and try again.'],
    ['a 500', () => json({ error: 'internal_error' }, 500), 'Could not create the account. Check your connection and try again.'],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch')), 'Could not create the account. Check your connection and try again.'],
  ])('on %s says so and keeps the form', async (_label, respond, message) => {
    stubApi(respond)
    renderAt('/studio/signup')

    await fillStudio()

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.getByLabelText('Handle')).toHaveValue('kigali-lens')
  })

  it('sends the link again on request, saying the same thing whatever the address', async () => {
    const api = stubApi(() => json({ ok: true }, 202))
    renderAt('/studio/signup')
    await fillStudio()
    await screen.findByText('Check your inbox')

    await user().click(screen.getByRole('button', { name: 'Send the link again' }))

    expect(await screen.findByText(RESENT)).toBeInTheDocument()
    expect(api.sent.at(-1)).toMatchObject({ method: 'POST', url: '/api/studio/auth/verify/resend', body: { email: 'lens@kigali.example' } })
  })

  it('words a refused resend', async () => {
    stubApi(({ url }) => (url.endsWith('/resend') ? json({ error: 'rate_limited' }, 429) : json({ ok: true }, 202)))
    renderAt('/studio/signup')
    await fillStudio()
    await screen.findByText('Check your inbox')

    await user().click(screen.getByRole('button', { name: 'Send the link again' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts from here. Wait a few minutes and try again.')
  })
})

describe('the account signup', () => {
  it('wears the client shell, with email, password and full name', () => {
    stubApi(() => undefined)
    renderAt('/account/signup')

    expect(screen.getByRole('heading', { level: 1, name: 'Create an account' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(within(screen.getByRole('main')).queryByLabelText('Handle')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Already have an account? Sign in' })).toHaveAttribute('href', '/account/login')
  })

  it('posts the form and says check your inbox, signing nobody in', async () => {
    const api = stubApi(({ url }) => (url === '/api/account/auth/signup' ? json({ ok: true }, 202) : undefined))
    renderAt('/account/signup')

    await fillAccount({ fullName: ' Aline Uwase ' })

    expect(await within(screen.getByRole('main')).findByRole('status')).toHaveTextContent(SENT)
    expect(api.sent.find((call) => call.url === '/api/account/auth/signup')?.body).toEqual({
      email: 'aline@example.com',
      password: PASSWORD,
      fullName: 'Aline Uwase',
    })
    expect(sessionStorage.getItem('bookly.account.session')).toBeNull()
  })

  it('refuses a missing name before asking the API', async () => {
    const api = stubApi(() => json({ ok: true }, 202))
    renderAt('/account/signup')

    await fillAccount({ fullName: '' })

    expect(screen.getByLabelText('Full name')).toHaveAccessibleDescription(expect.stringContaining('Enter your name, up to 200 characters.'))
    expect(api.sent.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it.each<[string, () => Response, string]>([
    ['a 422 on the name', () => json({ error: 'validation_failed', fields: ['fullName'] }, 422), 'Full name'],
    ['a 422 on the password', () => json({ error: 'validation_failed', fields: ['password'] }, 422), 'Password'],
  ])('puts %s on its field', async (_label, respond, label) => {
    stubApi(({ method }) => (method === 'POST' ? respond() : undefined))
    renderAt('/account/signup')

    await fillAccount()

    await waitFor(() => expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true'))
  })

  it('says to wait on a 429', async () => {
    stubApi(({ method }) => (method === 'POST' ? json({ error: 'rate_limited' }, 429) : undefined))
    renderAt('/account/signup')

    await fillAccount()

    expect(await within(screen.getByRole('main')).findByRole('alert')).toHaveTextContent('Too many attempts from here.')
  })
})
