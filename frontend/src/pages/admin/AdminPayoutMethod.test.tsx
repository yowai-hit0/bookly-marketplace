import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { PayoutMethod } from '@/admin/payouts'
import { readSession, saveSession } from '@/auth/session'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'
import { BANK_METHOD, MOMO_METHOD } from '@/test/payout-fixtures'
import { STUDIO_ME_URL, studioMe } from '@/test/studio-me'

/**
 * `/studio/payout-method` (marketplace spec R4.1, R4.5, T4.4), through the
 * real routes: the transfer-fee banner always on the page, the current method
 * or a prompt to add one, and the form -- MoMo (network, number with that
 * network's prefixes, account name) or bank (bank, account number, account
 * name), always with the current password. Every refusal is worded; a save
 * says the security email went.
 */

const SESSION = { token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }
const URL_ = '/api/studio/payout-method'
const TRANSFER_FEE =
  'Bookly sends your payouts by manual transfer. The transfer fee is deducted from what you receive, so you may want to include it in your prices.'
const SAVED_MOMO: PayoutMethod = { ...MOMO_METHOD, id: 'pm-new', momoNetwork: 'airtel', momoNumber: '+250722123456', accountName: 'Aline U.', createdAt: '2026-10-17T09:00:00.000Z' }

type Options = {
  current?: PayoutMethod | null
  load?: () => Response | Promise<Response>
  save?: (call: Sent) => Response | Promise<Response>
}

function api({ current = MOMO_METHOD, load, save }: Options = {}) {
  return stubApi((call) => {
    if (call.url === STUDIO_ME_URL) return studioMe()
    if (call.url === URL_ && call.method === 'GET') return load === undefined ? json({ payoutMethod: current }) : load()
    if (call.url === URL_ && call.method === 'PUT') return save === undefined ? json({ payoutMethod: SAVED_MOMO }) : save(call)
    return undefined
  })
}

function puts(sent: Sent[]) {
  return sent.filter((call) => call.method === 'PUT')
}

function renderAt(path = '/studio/payout-method') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

function banner() {
  return document.querySelector('[data-notice="transfer-fee"]')
}

async function loaded() {
  await screen.findByRole('heading', { level: 2, name: 'Current payout method' })
}

/** Opens the form from its button and answers the dialog. */
async function openForm(name: 'Change payout method' | 'Add a payout method' = 'Change payout method') {
  await user().click(await screen.findByRole('button', { name }))
  return within(screen.getByRole('dialog', { name }))
}

type Dialog = Awaited<ReturnType<typeof openForm>>

async function typeInto(dialog: Dialog, label: string, value: string) {
  const field = dialog.getByLabelText(label)
  await user().clear(field)
  if (value !== '') await user().type(field, value)
}

async function submit(dialog: Dialog) {
  await user().click(dialog.getByRole('button', { name: 'Save payout method' }))
}

/** The error worded under a field, through its `aria-describedby`. */
function fieldError(dialog: Dialog, label: string): string | null {
  const field = dialog.getByLabelText(label)
  if (field.getAttribute('aria-invalid') !== 'true') return null
  const ids = (field.getAttribute('aria-describedby') ?? '').split(' ')
  const error = ids.map((id) => document.getElementById(id)).find((element) => element?.id.endsWith('-error'))
  return error?.textContent ?? null
}

beforeEach(() => {
  saveSession('studio', SESSION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  delete document.documentElement.dataset.adminTheme
})

describe('the transfer-fee banner (R4.5)', () => {
  it('is on the page with its whole message once the method has loaded', async () => {
    api()
    renderAt()
    await loaded()

    expect(banner()).toHaveTextContent(TRANSFER_FEE)
    expect(banner()?.closest('main')).not.toBeNull()
  })

  it('is there while the method loads, and when that load fails', async () => {
    let answer: () => Response | Promise<Response> = () => new Promise<Response>(() => {})
    api({ load: () => answer() })
    const { unmount } = render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/studio/payout-method'] })} />)

    expect(await screen.findByRole('status')).toHaveTextContent('Loading your payout method…')
    expect(banner()).toHaveTextContent(TRANSFER_FEE)
    unmount()

    answer = () => json({ error: 'internal_error' }, 500)
    renderAt()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your payout method.')
    expect(banner()).toHaveTextContent(TRANSFER_FEE)
  })

  it('stays after a save, and is never inside a dialog that closes', async () => {
    api()
    renderAt()
    const dialog = await openForm()
    await typeInto(dialog, 'Your password', 'correct horse')
    await submit(dialog)

    await screen.findByText(/Payout method saved\./)
    expect(banner()).toHaveTextContent(TRANSFER_FEE)
    expect(banner()?.closest('[role="dialog"]')).toBeNull()
  })
})

describe('the current method', () => {
  it('reads it with the studio token, once', async () => {
    const { sent } = api()
    renderAt()
    await loaded()

    const gets = sent.filter((call) => call.url === URL_)
    expect(gets).toEqual([expect.objectContaining({ method: 'GET' })])
    expect(gets[0]?.headers.get('Authorization')).toBe('Bearer studio.jwt')
  })

  it('shows where payouts go and when it was saved, with a way to change it', async () => {
    api()
    renderAt()
    await loaded()

    const destination = document.querySelector('[data-slot="payout-destination"]')
    expect(destination).toHaveTextContent('MTN MoMo+250 788 123 456Name on the account: Aline Uwase')
    expect(screen.getByText('Saved 1 Oct 2026, 10:00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change payout method' })).toBeInTheDocument()
    expect(document.querySelector('[data-notice="no-payout-method"]')).toBeNull()
  })

  it('shows a bank account the same way', async () => {
    api({ current: BANK_METHOD })
    renderAt()
    await loaded()

    expect(document.querySelector('[data-slot="payout-destination"]')).toHaveTextContent('Bank of Kigali00040-0123456-78Name on the account: Kigali Lens Ltd')
  })

  it('prompts him to add one when there is none', async () => {
    api({ current: null })
    renderAt()
    await loaded()

    expect(document.querySelector('[data-notice="no-payout-method"]')).toHaveTextContent('You have no payout method yet. Add one so Bookly can pay you.')
    expect(document.querySelector('[data-slot="payout-destination"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add a payout method' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change payout method' })).not.toBeInTheDocument()
  })

  it('reads Admin > Earnings > Payout method, with Earnings current in the nav', async () => {
    api()
    renderAt()
    await loaded()

    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('listitem')
    expect(crumbs.map((item) => item.textContent)).toEqual(['Admin', 'Earnings', 'Payout method'])
    expect(within(screen.getByRole('navigation', { name: 'Admin' })).getByRole('link', { name: 'Earnings' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Payout method'])
  })

  it('loads again on retry after a failure', async () => {
    let calls = 0
    api({ load: () => (calls++ === 0 ? Promise.reject(new TypeError('Failed to fetch')) : json({ payoutMethod: MOMO_METHOD })) })
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your payout method. Check your connection and try again.')
    expect(screen.queryByRole('button', { name: 'Change payout method' })).not.toBeInTheDocument()
    await user().click(screen.getByRole('button', { name: 'Try again' }))

    await loaded()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('sends him to sign in when the API refuses the token', async () => {
    api({ load: () => json({ error: 'invalid_token' }, 401) })
    const router = renderAt()

    await waitFor(() => expect(router.state.location.pathname).toBe('/studio/login'))
    expect(readSession('studio')).toBeNull()
  })
})

describe('the form', () => {
  it('starts from the current method, on its kind and network, with an empty password', async () => {
    api()
    renderAt()
    const dialog = await openForm()

    expect(dialog.getByRole('radio', { name: 'Mobile money' })).toBeChecked()
    expect(dialog.getByRole('radio', { name: 'MTN MoMo' })).toBeChecked()
    expect(dialog.getByLabelText('Mobile number')).toHaveValue('0788 123 456')
    expect(dialog.getByLabelText('Name on the account')).toHaveValue('Aline Uwase')
    expect(dialog.getByLabelText('Your password')).toHaveValue('')
    expect(dialog.getByLabelText('Your password')).toHaveAttribute('type', 'password')
    expect(dialog.getByLabelText('Your password')).toHaveAttribute('autocomplete', 'current-password')
  })

  it('starts empty on MTN MoMo for a first method', async () => {
    api({ current: null })
    renderAt()
    const dialog = await openForm('Add a payout method')

    expect(dialog.getByRole('radio', { name: 'Mobile money' })).toBeChecked()
    expect(dialog.getByRole('radio', { name: 'MTN MoMo' })).toBeChecked()
    expect(dialog.getByLabelText('Mobile number')).toHaveValue('')
    expect(dialog.getByLabelText('Name on the account')).toHaveValue('')
  })

  it('gives the number the prefix hint of the network chosen', async () => {
    api()
    renderAt()
    const dialog = await openForm()

    expect(dialog.getByText('An MTN number starts 078 or 079, such as 0788 123 456.')).toBeInTheDocument()
    await user().click(dialog.getByRole('radio', { name: 'Airtel Money' }))
    expect(dialog.getByText('An Airtel number starts 072 or 073, such as 0722 123 456.')).toBeInTheDocument()
    expect(dialog.queryByText(/An MTN number/)).not.toBeInTheDocument()
  })

  it('switches to the bank fields, and back', async () => {
    api()
    renderAt()
    const dialog = await openForm()

    await user().click(dialog.getByRole('radio', { name: 'Bank account' }))
    expect(dialog.getByLabelText('Bank')).toBeInTheDocument()
    expect(dialog.getByLabelText('Account number')).toBeInTheDocument()
    expect(dialog.getByLabelText('Name on the account')).toBeInTheDocument()
    expect(dialog.queryByLabelText('Mobile number')).not.toBeInTheDocument()
    expect(dialog.queryByRole('radio', { name: 'MTN MoMo' })).not.toBeInTheDocument()

    await user().click(dialog.getByRole('radio', { name: 'Mobile money' }))
    expect(dialog.getByLabelText('Mobile number')).toBeInTheDocument()
    expect(dialog.queryByLabelText('Bank')).not.toBeInTheDocument()
  })

  it('closes on Cancel and sends nothing', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openForm()

    await user().click(dialog.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(puts(sent)).toEqual([])
  })
})

describe('saving', () => {
  it('saves a MoMo method as E.164 with the password, and says the security email went', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openForm()

    await user().click(dialog.getByRole('radio', { name: 'Airtel Money' }))
    await typeInto(dialog, 'Mobile number', '0722 123 456')
    await typeInto(dialog, 'Name on the account', '  Aline U. ')
    await typeInto(dialog, 'Your password', 'correct horse')
    await submit(dialog)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(puts(sent)).toEqual([
      expect.objectContaining({
        url: URL_,
        body: { kind: 'momo', momoNetwork: 'airtel', momoNumber: '+250722123456', accountName: 'Aline U.', currentPassword: 'correct horse' },
      }),
    ])
    expect(puts(sent)[0]?.headers.get('Authorization')).toBe('Bearer studio.jwt')
    expect(screen.getByRole('status')).toHaveTextContent(
      "Payout method saved. We've emailed your sign-in address about the change, so you'll know if it wasn't you.",
    )
    // The page shows what the API saved, not what was typed.
    expect(document.querySelector('[data-slot="payout-destination"]')).toHaveTextContent('Airtel Money+250 722 123 456Name on the account: Aline U.')
    expect(screen.getByText('Saved 17 Oct 2026, 11:00')).toBeInTheDocument()
  })

  it('saves a bank method with only the bank fields', async () => {
    const { sent } = api({ save: () => json({ payoutMethod: BANK_METHOD }) })
    renderAt()
    const dialog = await openForm()

    await user().click(dialog.getByRole('radio', { name: 'Bank account' }))
    await typeInto(dialog, 'Bank', 'Bank of Kigali')
    await typeInto(dialog, 'Account number', '00040-0123456-78')
    await typeInto(dialog, 'Name on the account', 'Kigali Lens Ltd')
    await typeInto(dialog, 'Your password', 'correct horse')
    await submit(dialog)

    await waitFor(() => expect(puts(sent)).toHaveLength(1))
    expect(puts(sent)[0]?.body).toEqual({
      kind: 'bank',
      bankName: 'Bank of Kigali',
      bankAccountNumber: '00040-0123456-78',
      accountName: 'Kigali Lens Ltd',
      currentPassword: 'correct horse',
    })
    expect(await screen.findByText('Bank of Kigali')).toBeInTheDocument()
  })

  it('adds a first method the same way, and then offers to change it', async () => {
    api({ current: null, save: () => json({ payoutMethod: MOMO_METHOD }) })
    renderAt()
    const dialog = await openForm('Add a payout method')

    await typeInto(dialog, 'Mobile number', '0788123456')
    await typeInto(dialog, 'Name on the account', 'Aline Uwase')
    await typeInto(dialog, 'Your password', 'correct horse')
    await submit(dialog)

    expect(await screen.findByRole('button', { name: 'Change payout method' })).toBeInTheDocument()
    expect(document.querySelector('[data-notice="no-payout-method"]')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(/We've emailed your sign-in address/)
  })

  it('opens again from what is now saved, with the success line cleared', async () => {
    api()
    renderAt()
    let dialog = await openForm()
    await typeInto(dialog, 'Your password', 'correct horse')
    await submit(dialog)
    await screen.findByText(/Payout method saved\./)

    dialog = await openForm()

    expect(dialog.getByRole('radio', { name: 'Airtel Money' })).toBeChecked()
    expect(dialog.getByLabelText('Mobile number')).toHaveValue('0722 123 456')
    expect(dialog.getByLabelText('Your password')).toHaveValue('')
    expect(screen.queryByText(/Payout method saved\./)).not.toBeInTheDocument()
  })
})

describe('what the form refuses before asking', () => {
  it('requires the current password', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openForm()

    await submit(dialog)

    expect(fieldError(dialog, 'Your password')).toBe('Enter your password.')
    expect(puts(sent)).toEqual([])
  })

  it.each([
    ['an MTN number on Airtel', 'Airtel Money', '0788 123 456', 'Enter an Airtel number: 10 digits starting 072 or 073.'],
    ['an Airtel number on MTN', 'MTN MoMo', '0722 123 456', 'Enter an MTN number: 10 digits starting 078 or 079.'],
    ['a number from another country', 'MTN MoMo', '+254 712 345 678', 'Enter an MTN number: 10 digits starting 078 or 079.'],
    ['a number too short', 'MTN MoMo', '0788 12', 'Enter an MTN number: 10 digits starting 078 or 079.'],
  ])('refuses %s, in the network’s own words', async (_label, network, number, message) => {
    const { sent } = api()
    renderAt()
    const dialog = await openForm()

    await user().click(dialog.getByRole('radio', { name: network }))
    await typeInto(dialog, 'Mobile number', number)
    await typeInto(dialog, 'Your password', 'correct horse')
    await submit(dialog)

    expect(fieldError(dialog, 'Mobile number')).toBe(message)
    expect(puts(sent)).toEqual([])
  })

  it('refuses an empty account name, bank name and account number together', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openForm()

    await user().click(dialog.getByRole('radio', { name: 'Bank account' }))
    await typeInto(dialog, 'Name on the account', '')
    await typeInto(dialog, 'Account number', 'ABCD')
    await submit(dialog)

    expect(fieldError(dialog, 'Bank')).toBe("Enter the bank's name, up to 100 characters.")
    expect(fieldError(dialog, 'Account number')).toBe(
      'Enter the account number: 5 to 40 letters, digits, spaces or dashes, with at least one digit.',
    )
    expect(fieldError(dialog, 'Name on the account')).toBe('Enter the name on the account, up to 120 characters.')
    expect(fieldError(dialog, 'Your password')).toBe('Enter your password.')
    expect(puts(sent)).toEqual([])
  })
})

describe('what the API refuses', () => {
  async function saveWith(answer: () => Response | Promise<Response>, kind: 'momo' | 'bank' = 'momo') {
    const result = api({ save: answer })
    renderAt()
    const dialog = await openForm()
    if (kind === 'bank') {
      await user().click(dialog.getByRole('radio', { name: 'Bank account' }))
      await typeInto(dialog, 'Bank', 'Bank of Kigali')
      await typeInto(dialog, 'Account number', '00040-0123456-78')
    }
    await typeInto(dialog, 'Your password', 'not my password')
    await submit(dialog)
    await waitFor(() => expect(puts(result.sent)).toHaveLength(1))
    return dialog
  }

  it('words a wrong password under the field, clears it, and keeps the form open', async () => {
    const dialog = await saveWith(() => json({ error: 'invalid_password' }, 403))

    await waitFor(() => expect(fieldError(dialog, 'Your password')).toBe('That password is not right. Too many wrong tries lock your account for a while.'))
    expect(dialog.getByLabelText('Your password')).toHaveValue('')
    expect(dialog.getByLabelText('Mobile number')).toHaveValue('0788 123 456')
    expect(screen.queryByText(/Payout method saved/)).not.toBeInTheDocument()
  })

  it('words a locked account', async () => {
    const dialog = await saveWith(() => json({ error: 'password_locked' }, 403))

    expect(await dialog.findByRole('alert')).toHaveTextContent('Too many wrong passwords: your account is locked for a few minutes. Wait, then try again.')
    expect(fieldError(dialog, 'Your password')).toBeNull()
  })

  it('words the rate limit', async () => {
    const dialog = await saveWith(() => json({ error: 'rate_limited' }, 429))

    expect(await dialog.findByRole('alert')).toHaveTextContent('Too many changes from here. Wait a while and try again.')
  })

  it.each([
    ['momoNumber', 'Mobile number', 'Enter an MTN number: 10 digits starting 078 or 079.'],
    ['accountName', 'Name on the account', 'Enter the name on the account, up to 120 characters.'],
  ])('marks the MoMo field a 422 names: %s', async (field, label, message) => {
    const dialog = await saveWith(() => json({ error: 'validation_failed', fields: [field] }, 422))

    await waitFor(() => expect(fieldError(dialog, label)).toBe(message))
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['bankName', 'Bank', "Enter the bank's name, up to 100 characters."],
    ['bankAccountNumber', 'Account number', 'Enter the account number: 5 to 40 letters, digits, spaces or dashes, with at least one digit.'],
  ])('marks the bank field a 422 names: %s', async (field, label, message) => {
    const dialog = await saveWith(() => json({ error: 'validation_failed', fields: [field] }, 422), 'bank')

    await waitFor(() => expect(fieldError(dialog, label)).toBe(message))
  })

  it('words a 422 that names no field of the form', async () => {
    const dialog = await saveWith(() => json({ error: 'validation_failed', fields: ['momoNetwork'] }, 422))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Check what you entered and try again.')
  })

  it('words a 400 invalid_request', async () => {
    const dialog = await saveWith(() => json({ error: 'invalid_request' }, 400))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Check what you entered and try again.')
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('words %s as a failure to save, and keeps what was typed', async (_label, answer) => {
    const dialog = await saveWith(answer)

    expect(await dialog.findByRole('alert')).toHaveTextContent('Could not save your payout method. Check your connection and try again.')
    expect(dialog.getByLabelText('Your password')).toHaveValue('not my password')
  })

  it('keeps the current method on screen after any refusal', async () => {
    await saveWith(() => json({ error: 'invalid_password' }, 403))
    await user().click(screen.getByRole('button', { name: 'Cancel' }))

    expect(document.querySelector('[data-slot="payout-destination"]')).toHaveTextContent('MTN MoMo+250 788 123 456')
  })

  it('sends him to sign in on a 401', async () => {
    const result = api({ save: () => json({ error: 'invalid_token' }, 401) })
    const router = renderAt()
    const dialog = await openForm()
    await typeInto(dialog, 'Your password', 'correct horse')
    await submit(dialog)

    await waitFor(() => expect(router.state.location.pathname).toBe('/studio/login'))
    expect(readSession('studio')).toBeNull()
    expect(puts(result.sent)).toHaveLength(1)
  })
})
