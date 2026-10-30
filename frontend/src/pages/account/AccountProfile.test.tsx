import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { fileSaver } from '@/account/dashboard'
import { type AccountUser, forgetAccountMe } from '@/auth/account'
import { readSession, saveSession } from '@/auth/session'
import { routes } from '@/routes'
import { GOOGLE_USER, SESSION, USER, signedIn } from '@/test/account-fixtures'
import { type Sent, json, stubApi } from '@/test/fetch'

/**
 * `/account/profile` (marketplace-spec R8.3, user decisions 1, 2 and 4): the
 * details that prefill the booking form, the password (changed, or added to a
 * Google-only account), the sign-in email (changed with the password; for a
 * Google-only account explained, not offered), the export download, and the
 * deletion, whose dialog says upcoming bookings carry on and is confirmed with
 * the password or the typed address.
 */

type Answers = { me?: () => AccountUser; [route: string]: ((sent: Sent) => Response) | (() => AccountUser) | undefined }

function api(answers: Answers = {}) {
  return stubApi((sent) => {
    if (sent.url === '/api/account/me') return json({ user: answers.me?.() ?? USER })
    if (sent.method === 'GET' && sent.url === '/api/account/profile') return json({ profile: { fullName: 'Aline Uwase', phone: '+250788123456' } })
    const answer = answers[`${sent.method} ${sent.url}`] as ((sent: Sent) => Response) | undefined
    return answer?.(sent)
  })
}

function renderAt(path = '/account/profile') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

async function loaded() {
  const router = renderAt()
  const main = within(screen.getByRole('main'))
  await main.findByRole('textbox', { name: 'Full name' })
  return { router, main }
}

function section(main: ReturnType<typeof within>, name: string) {
  return within(main.getByRole('heading', { level: 2, name }).closest('section')!)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  localStorage.clear()
  forgetAccountMe()
})

describe('your details', () => {
  it('shows the name and phone, and saves both with the account token', async () => {
    saveSession('account', SESSION)
    const stub = api({ 'PATCH /api/account/profile': (sent) => json({ profile: { fullName: 'Aline U.', phone: '+250788999000' }, sent }) })
    const { main } = await loaded()
    const details = section(main, 'Your details')
    const user = userEvent.setup({ delay: null })

    expect(details.getByRole('textbox', { name: 'Full name' })).toHaveValue('Aline Uwase')
    expect(details.getByRole('textbox', { name: 'Phone number' })).toHaveValue('+250788123456')
    expect(details.getByRole('textbox', { name: 'Phone number' })).toHaveAccessibleDescription(
      'Optional. A Rwandan number like 078 123 4567, or any number starting with + and the country code.',
    )

    await user.clear(details.getByRole('textbox', { name: 'Full name' }))
    await user.type(details.getByRole('textbox', { name: 'Full name' }), '  Aline U.  ')
    await user.clear(details.getByRole('textbox', { name: 'Phone number' }))
    await user.type(details.getByRole('textbox', { name: 'Phone number' }), '0788 999 000')
    await user.click(details.getByRole('button', { name: 'Save details' }))

    expect(await details.findByRole('status')).toHaveTextContent('Your details are saved.')
    // The API's normalised number is what the field then shows.
    expect(details.getByRole('textbox', { name: 'Phone number' })).toHaveValue('+250788999000')
    const patch = stub.sent.find((call) => call.method === 'PATCH')
    expect(patch?.body).toEqual({ fullName: 'Aline U.', phone: '0788 999 000' })
    expect(patch?.headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
    // The header and the booking form's prefill read the account again.
    await waitFor(() => expect(stub.sent.filter((call) => call.url === '/api/account/me').length).toBeGreaterThan(1))
  })

  it('a blank phone clears it (sent as null)', async () => {
    saveSession('account', SESSION)
    const stub = api({ 'PATCH /api/account/profile': () => json({ profile: { fullName: 'Aline Uwase', phone: null } }) })
    const { main } = await loaded()
    const details = section(main, 'Your details')
    const user = userEvent.setup({ delay: null })
    await user.clear(details.getByRole('textbox', { name: 'Phone number' }))
    await user.click(details.getByRole('button', { name: 'Save details' }))

    await details.findByRole('status')
    expect(stub.sent.find((call) => call.method === 'PATCH')?.body).toEqual({ fullName: 'Aline Uwase', phone: null })
  })

  it('a blank name is refused before anything is sent', async () => {
    saveSession('account', SESSION)
    const stub = api()
    const { main } = await loaded()
    const details = section(main, 'Your details')
    const user = userEvent.setup({ delay: null })
    await user.clear(details.getByRole('textbox', { name: 'Full name' }))
    await user.click(details.getByRole('button', { name: 'Save details' }))

    expect(details.getByRole('textbox', { name: 'Full name' })).toHaveAttribute('aria-invalid', 'true')
    expect(details.getByRole('textbox', { name: 'Full name' })).toHaveAccessibleDescription('Enter your name, up to 200 characters.')
    expect(details.getByRole('textbox', { name: 'Full name' })).toHaveFocus()
    expect(stub.sent.some((call) => call.method === 'PATCH')).toBe(false)
  })

  it('the API’s 422 on the phone marks the phone field', async () => {
    saveSession('account', SESSION)
    api({ 'PATCH /api/account/profile': () => json({ error: 'validation_failed', fields: ['phone'] }, 422) })
    const { main } = await loaded()
    const details = section(main, 'Your details')
    const user = userEvent.setup({ delay: null })
    await user.clear(details.getByRole('textbox', { name: 'Phone number' }))
    await user.type(details.getByRole('textbox', { name: 'Phone number' }), '12')
    await user.click(details.getByRole('button', { name: 'Save details' }))

    const phone = details.getByRole('textbox', { name: 'Phone number' })
    await waitFor(() => expect(phone).toHaveAttribute('aria-invalid', 'true'))
    expect(phone).toHaveFocus()
    expect(details.getByText('Enter a phone number like 078 123 4567, or one starting with + and the country code.')).toBeInTheDocument()
    expect(details.queryByRole('status')).toBeNull()
  })

  it('a failure to save keeps what was typed and says so', async () => {
    saveSession('account', SESSION)
    api({ 'PATCH /api/account/profile': () => json({ error: 'internal_error' }, 500) })
    const { main } = await loaded()
    const details = section(main, 'Your details')
    const user = userEvent.setup({ delay: null })
    await user.type(details.getByRole('textbox', { name: 'Full name' }), 'x')
    await user.click(details.getByRole('button', { name: 'Save details' }))

    expect(await details.findByRole('alert')).toHaveTextContent('Could not save your details.')
    expect(details.getByRole('textbox', { name: 'Full name' })).toHaveValue('Aline Uwasex')
  })
})

describe('password', () => {
  it('changes the password and carries on with the fresh token', async () => {
    saveSession('account', SESSION)
    const stub = api({ 'POST /api/account/password': () => json(signedIn('fresh.jwt')) })
    const { main } = await loaded()
    const password = section(main, 'Password')
    const user = userEvent.setup({ delay: null })

    await user.type(password.getByLabelText('Current password'), 'the old password')
    await user.type(password.getByLabelText('New password'), 'a much longer new one')
    await user.click(password.getByRole('button', { name: 'Change password' }))

    expect(await password.findByRole('status')).toHaveTextContent('Your password is changed. You are signed out on every other device.')
    expect(readSession('account')?.token).toBe('fresh.jwt')
    expect(stub.sent.find((call) => call.url === '/api/account/password')?.body).toEqual({
      currentPassword: 'the old password',
      newPassword: 'a much longer new one',
    })
    expect(password.getByLabelText('Current password')).toHaveValue('')
  })

  it('a short new password is refused before anything is sent', async () => {
    saveSession('account', SESSION)
    const stub = api()
    const { main } = await loaded()
    const password = section(main, 'Password')
    const user = userEvent.setup({ delay: null })
    await user.type(password.getByLabelText('Current password'), 'the old password')
    await user.type(password.getByLabelText('New password'), 'short')
    await user.click(password.getByRole('button', { name: 'Change password' }))

    expect(password.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true')
    expect(password.getByText('Use 12 to 1024 characters.')).toBeInTheDocument()
    expect(stub.sent.some((call) => call.url === '/api/account/password')).toBe(false)
  })

  it('a wrong current password marks that field, and the token is kept', async () => {
    saveSession('account', SESSION)
    api({ 'POST /api/account/password': () => json({ error: 'invalid_password' }, 403) })
    const { main } = await loaded()
    const password = section(main, 'Password')
    const user = userEvent.setup({ delay: null })
    await user.type(password.getByLabelText('Current password'), 'not it')
    await user.type(password.getByLabelText('New password'), 'a much longer new one')
    await user.click(password.getByRole('button', { name: 'Change password' }))

    await waitFor(() => expect(password.getByLabelText('Current password')).toHaveAttribute('aria-invalid', 'true'))
    expect(password.getByText('That is not your current password.')).toBeInTheDocument()
    expect(readSession('account')?.token).toBe(SESSION.token)
  })

  it.each([
    ['password_locked', 403, 'Too many wrong passwords.'],
    ['credentials_changed', 409, 'Your password was changed somewhere else just now.'],
    ['rate_limited', 429, 'Too many attempts from here.'],
  ])('%s is said', async (error, status, words) => {
    saveSession('account', SESSION)
    api({ 'POST /api/account/password': () => json({ error }, status) })
    const { main } = await loaded()
    const password = section(main, 'Password')
    const user = userEvent.setup({ delay: null })
    await user.type(password.getByLabelText('Current password'), 'the old password')
    await user.type(password.getByLabelText('New password'), 'a much longer new one')
    await user.click(password.getByRole('button', { name: 'Change password' }))

    expect(await password.findByRole('alert')).toHaveTextContent(words)
  })

  it('a Google-only account adds a password, and the section becomes the change form', async () => {
    saveSession('account', SESSION)
    let me = GOOGLE_USER
    const stub = api({
      me: () => me,
      'POST /api/account/password/set': () => {
        me = { ...GOOGLE_USER, hasPassword: true }
        return json(signedIn('added.jwt', { hasPassword: true, hasGoogle: true }))
      },
    })
    const { main } = await loaded()
    const password = section(main, 'Password')
    const user = userEvent.setup({ delay: null })

    expect(password.getByText('You sign in with Google. Add a password to sign in with your email and password too.')).toBeInTheDocument()
    expect(password.queryByLabelText('Current password')).toBeNull()
    await user.type(password.getByLabelText('New password'), 'a much longer new one')
    await user.click(password.getByRole('button', { name: 'Add password' }))

    expect(await password.findByRole('status')).toHaveTextContent('Password added.')
    expect(await password.findByLabelText('Current password')).toBeInTheDocument()
    expect(readSession('account')?.token).toBe('added.jwt')
    expect(stub.sent.find((call) => call.url === '/api/account/password/set')?.body).toEqual({ newPassword: 'a much longer new one' })
  })
})

describe('email', () => {
  it('asks for the change with the password, and says "if" whatever the address', async () => {
    saveSession('account', SESSION)
    const stub = api({ 'POST /api/account/email': () => json({ ok: true }, 202) })
    const { main } = await loaded()
    const email = section(main, 'Email')
    const user = userEvent.setup({ delay: null })

    expect(email.getByText('You sign in with aline@example.com.')).toBeInTheDocument()
    await user.type(email.getByRole('textbox', { name: 'New email' }), 'new@example.com')
    await user.type(email.getByLabelText('Your password'), 'my password')
    await user.click(email.getByRole('button', { name: 'Send the link' }))

    expect(await email.findByRole('status')).toHaveTextContent(
      "If new@example.com can be used, we've sent a link to it. Open it within 24 hours to finish the change.",
    )
    expect(stub.sent.find((call) => call.url === '/api/account/email')?.body).toEqual({ newEmail: 'new@example.com', password: 'my password' })
  })

  it('a pending change is shown while its link is live', async () => {
    saveSession('account', SESSION)
    api({ me: () => ({ ...USER, pendingEmail: 'new@example.com' }) })
    const { main } = await loaded()
    expect(
      section(main, 'Email').getByText('Waiting for you to confirm new@example.com from its inbox. Until then you sign in with aline@example.com.'),
    ).toBeInTheDocument()
  })

  it('its own address, a malformed one or no password is refused before anything is sent', async () => {
    saveSession('account', SESSION)
    const stub = api()
    const { main } = await loaded()
    const email = section(main, 'Email')
    const user = userEvent.setup({ delay: null })

    await user.type(email.getByRole('textbox', { name: 'New email' }), 'ALINE@example.com')
    await user.click(email.getByRole('button', { name: 'Send the link' }))
    expect(email.getByText('That is already your email.')).toBeInTheDocument()
    expect(email.getByText('Enter your password.')).toBeInTheDocument()

    await user.clear(email.getByRole('textbox', { name: 'New email' }))
    await user.type(email.getByRole('textbox', { name: 'New email' }), 'not an address')
    await user.type(email.getByLabelText('Your password'), 'pw')
    await user.click(email.getByRole('button', { name: 'Send the link' }))
    expect(email.getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(stub.sent.some((call) => call.url === '/api/account/email')).toBe(false)
  })

  it('a wrong password marks the password field', async () => {
    saveSession('account', SESSION)
    api({ 'POST /api/account/email': () => json({ error: 'invalid_password' }, 403) })
    const { main } = await loaded()
    const email = section(main, 'Email')
    const user = userEvent.setup({ delay: null })
    await user.type(email.getByRole('textbox', { name: 'New email' }), 'new@example.com')
    await user.type(email.getByLabelText('Your password'), 'wrong')
    await user.click(email.getByRole('button', { name: 'Send the link' }))

    await waitFor(() => expect(email.getByLabelText('Your password')).toHaveAttribute('aria-invalid', 'true'))
    expect(email.getByText('That is not your password.')).toBeInTheDocument()
  })

  it('a Google-only account is told why the change is not offered, and gets no form', async () => {
    saveSession('account', SESSION)
    api({ me: () => GOOGLE_USER })
    const { main } = await loaded()
    const email = section(main, 'Email')
    expect(email.getByText(/To change it here, add a password first/)).toBeInTheDocument()
    expect(email.queryByRole('textbox', { name: 'New email' })).toBeNull()
  })

  it('lands from the confirmation link with the new address said', async () => {
    saveSession('account', SESSION)
    api()
    const router = createMemoryRouter(routes, { initialEntries: [{ pathname: '/account/profile', state: { emailChanged: 'new@example.com' } }] })
    render(<RouterProvider router={router} />)
    expect(await screen.findByText('Your email is changed. You now sign in with new@example.com.')).toBeInTheDocument()
  })
})

describe('export', () => {
  it('downloads the export, saying it started', async () => {
    saveSession('account', SESSION)
    const save = vi.spyOn(fileSaver, 'save').mockImplementation(() => {})
    const stub = api({ 'GET /api/account/export': () => json({ format: 'bookly-account-export' }) })
    const { main } = await loaded()
    const data = section(main, 'Your data')

    await userEvent.setup({ delay: null }).click(data.getByRole('button', { name: 'Download my data' }))

    expect(await data.findByRole('status')).toHaveTextContent('Your download has started.')
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]?.[1]).toMatch(/^bookly-account-\d{4}-\d{2}-\d{2}\.json$/)
    expect(stub.sent.every((call) => !call.url.includes(SESSION.token))).toBe(true)
  })

  it('a rate-limited export says so and saves nothing', async () => {
    saveSession('account', SESSION)
    const save = vi.spyOn(fileSaver, 'save').mockImplementation(() => {})
    api({ 'GET /api/account/export': () => json({ error: 'rate_limited' }, 429) })
    const { main } = await loaded()
    const data = section(main, 'Your data')
    await userEvent.setup({ delay: null }).click(data.getByRole('button', { name: 'Download my data' }))

    expect(await data.findByRole('alert')).toHaveTextContent('Too many attempts from here.')
    expect(save).not.toHaveBeenCalled()
  })
})

describe('delete', () => {
  it('the dialog says upcoming bookings carry on; the password deletes, the session goes, and the page says so', async () => {
    saveSession('account', SESSION)
    const stub = api({ 'POST /api/account/delete': () => new Response(null, { status: 204 }) })
    const { router, main } = await loaded()
    const user = userEvent.setup({ delay: null })

    await user.click(section(main, 'Delete account').getByRole('button', { name: 'Delete my account' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Delete your account?' }))
    expect(dialog.getByText(/Upcoming bookings carry on\./)).toBeInTheDocument()
    expect(dialog.getByText('We send a confirmation to aline@example.com once it is done.')).toBeInTheDocument()
    const field = dialog.getByLabelText('Enter your password to confirm')
    expect(field).toHaveFocus()

    await user.type(field, 'my password')
    await user.click(dialog.getByRole('button', { name: 'Yes, delete my account' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/account/deleted'))
    // The deleted page forgets the session once it is on screen (so the
    // profile's guard can't race it to the login): wait for that page first.
    expect(await screen.findByRole('heading', { level: 1, name: 'Your account is deleted' })).toBeInTheDocument()
    expect(readSession('account')).toBeNull()
    expect(stub.sent.find((call) => call.url === '/api/account/delete')?.body).toEqual({ password: 'my password' })
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('a wrong password keeps the account and the dialog, and says so', async () => {
    saveSession('account', SESSION)
    api({ 'POST /api/account/delete': () => json({ error: 'invalid_password' }, 403) })
    const { router, main } = await loaded()
    const user = userEvent.setup({ delay: null })
    await user.click(section(main, 'Delete account').getByRole('button', { name: 'Delete my account' }))
    const dialog = within(await screen.findByRole('dialog'))
    await user.type(dialog.getByLabelText('Enter your password to confirm'), 'wrong')
    await user.click(dialog.getByRole('button', { name: 'Yes, delete my account' }))

    expect(await dialog.findByText('That is not your password.')).toBeInTheDocument()
    expect(readSession('account')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/account/profile')
  })

  it('Keep my account closes the dialog and sends nothing', async () => {
    saveSession('account', SESSION)
    const stub = api()
    const { main } = await loaded()
    const user = userEvent.setup({ delay: null })
    await user.click(section(main, 'Delete account').getByRole('button', { name: 'Delete my account' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep my account' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(stub.sent.some((call) => call.url === '/api/account/delete')).toBe(false)
  })

  it('a Google-only account confirms by typing its address; a different one is refused before sending', async () => {
    saveSession('account', SESSION)
    const stub = api({ me: () => GOOGLE_USER, 'POST /api/account/delete': () => new Response(null, { status: 204 }) })
    const { router, main } = await loaded()
    const user = userEvent.setup({ delay: null })
    await user.click(section(main, 'Delete account').getByRole('button', { name: 'Delete my account' }))
    const dialog = within(await screen.findByRole('dialog'))
    const field = dialog.getByRole('textbox', { name: 'Type your email to confirm' })
    expect(field).toHaveAccessibleDescription('Your email is aline@example.com.')

    await user.type(field, 'someone@example.com')
    await user.click(dialog.getByRole('button', { name: 'Yes, delete my account' }))
    expect(dialog.getByText("That is not this account's email.")).toBeInTheDocument()
    expect(stub.sent.some((call) => call.url === '/api/account/delete')).toBe(false)

    await user.clear(field)
    await user.type(field, '  Aline@Example.com ')
    await user.click(dialog.getByRole('button', { name: 'Yes, delete my account' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/account/deleted'))
    expect(stub.sent.find((call) => call.url === '/api/account/delete')?.body).toEqual({ confirmEmail: 'Aline@Example.com' })
  })

  it('an empty confirmation is refused before sending', async () => {
    saveSession('account', SESSION)
    const stub = api()
    const { main } = await loaded()
    const user = userEvent.setup({ delay: null })
    await user.click(section(main, 'Delete account').getByRole('button', { name: 'Delete my account' }))
    const dialog = within(await screen.findByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: 'Yes, delete my account' }))

    expect(dialog.getByText('Fill this in to confirm.')).toBeInTheDocument()
    expect(stub.sent.some((call) => call.url === '/api/account/delete')).toBe(false)
  })
})

describe('the page', () => {
  it('a failed account load says so, and Try again asks again', async () => {
    saveSession('account', SESSION)
    let fail = true
    stubApi((sent) =>
      sent.url === '/api/account/me'
        ? fail
          ? json({ error: 'internal_error' }, 500)
          : json({ user: USER })
        : sent.url === '/api/account/profile'
          ? json({ profile: { fullName: 'Aline Uwase', phone: null } })
          : undefined,
    )
    renderAt()
    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('alert')).toHaveTextContent('Could not load your profile.')
    fail = false
    await userEvent.setup({ delay: null }).click(main.getByRole('button', { name: 'Try again' }))
    expect(await main.findByRole('textbox', { name: 'Full name' })).toBeInTheDocument()
  })
})
