import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { readSession, saveSession } from '@/auth/session'
import type { PlatformPayoutDetail } from '@/platform/payouts'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'
import { BANK_METHOD, payoutItem, platformMethod, platformPayoutDetail } from '@/test/payout-fixtures'

/**
 * `/platform/payouts/:id` (marketplace spec R4.1, R4.4, T4.3): one payout,
 * its destination with the replaced and 72-hour warnings, its lines, and the
 * two ways a draft ends -- marked paid with a required, unique transfer
 * reference and an optional note, or cancelled after a confirmation. A change
 * someone else made first (`not_draft`) refreshes the page and says so.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }
const DRAFT = platformPayoutDetail()
const PATH = `/platform/payouts/${DRAFT.id}`
const API = `/api/platform/payouts/${DRAFT.id}`

const PAID: PlatformPayoutDetail = {
  ...DRAFT,
  status: 'paid',
  transferReference: 'MP261017.0042',
  note: 'Sent from the ops MoMo line.',
  paidAt: '2026-10-17T08:30:00.000Z',
  paidBy: { id: 'u2', email: 'second@bookly.example', fullName: 'Jean Ops' },
  items: DRAFT.items.map((item) => ({ ...item, state: 'paid' as const })),
}

const CANCELLED: PlatformPayoutDetail = {
  ...DRAFT,
  status: 'cancelled',
  itemCount: 0,
  items: [],
  cancelledAt: '2026-10-17T09:00:00.000Z',
  cancelledBy: null,
}

type Options = {
  get?: () => Response | Promise<Response>
  markPaid?: (call: Sent) => Response | Promise<Response>
  cancel?: (call: Sent) => Response | Promise<Response>
}

function api({ get = () => json({ payout: DRAFT }), markPaid = () => json({ payout: PAID }), cancel = () => json({ payout: CANCELLED }) }: Options = {}) {
  return stubApi((call) => {
    if (call.url === API && call.method === 'GET') return get()
    if (call.url === `${API}/mark-paid`) return markPaid(call)
    if (call.url === `${API}/cancel`) return cancel(call)
    return undefined
  })
}

function renderAt(path = PATH) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

function posts(sent: Sent[]) {
  return sent.filter((call) => call.method === 'POST')
}

function gets(sent: Sent[]) {
  return sent.filter((call) => call.method === 'GET')
}

async function loaded() {
  return screen.findByRole('heading', { level: 1, name: 'Payout to Kigali Lens' })
}

function header() {
  return screen.getByRole('heading', { level: 1 }).closest('header') as HTMLElement
}

function section(title: string): HTMLElement {
  const element = screen.getByRole('heading', { level: 2, name: title }).closest('section')
  if (element === null) throw new Error(`no section ${title}`)
  return element
}

/** The error worded under a field, through its `aria-describedby`. */
function fieldError(container: { getByLabelText: (label: string) => HTMLElement }, label: string): string | null {
  const field = container.getByLabelText(label)
  if (field.getAttribute('aria-invalid') !== 'true') return null
  const ids = (field.getAttribute('aria-describedby') ?? '').split(' ')
  return ids.map((id) => document.getElementById(id)).find((element) => element?.id.endsWith('-error'))?.textContent ?? null
}

beforeEach(() => {
  saveSession('platform', SESSION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  delete document.documentElement.dataset.adminTheme
})

describe('a draft payout', () => {
  it('reads it with the platform token', async () => {
    const { sent } = api()
    renderAt()
    await loaded()

    expect(gets(sent)).toEqual([expect.objectContaining({ url: API })])
    expect(gets(sent)[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
  })

  it('heads the page with the photographer, the status, the amount, the lines and who built it', async () => {
    api()
    renderAt()
    await loaded()

    expect(within(header()).getByText('Draft')).toHaveAttribute('data-status', 'draft')
    expect(header()).toHaveTextContent('45,000 RWF')
    expect(header()).toHaveTextContent('2 lines')
    expect(header()).toHaveTextContent('Created 16 Oct 2026, 10:00 by Grace Ops')
    expect(within(header()).getByRole('button', { name: 'Mark paid' })).toBeInTheDocument()
    expect(within(header()).getByRole('button', { name: 'Cancel draft' })).toBeInTheDocument()
  })

  it('shows the destination and the lines, the bookings as plain references', async () => {
    api()
    renderAt()
    await loaded()

    expect(section('Destination')).toHaveTextContent('MTN MoMo+250 788 123 456Name on the account: Aline Uwase')
    expect(section('Lines')).toHaveTextContent('BKY-2610-00042')
    expect(section('Lines')).toHaveTextContent('Being paid out')
    expect(within(section('Lines')).queryByRole('link')).not.toBeInTheDocument()
    expect(document.querySelector('[data-warning]')).toBeNull()
  })

  it('warns, before money moves, that the photographer has replaced the destination since', async () => {
    api({ get: () => json({ payout: { ...DRAFT, payoutMethodIsCurrent: false } }) })
    renderAt()
    await loaded()

    expect(document.querySelector('[data-warning="not-current"]')).toHaveTextContent(
      "The photographer has saved a new payout method since this draft was created. Don't send money to the destination below: cancel this draft and create a new one.",
    )
  })

  it('warns of a destination changed in the last 72 hours', async () => {
    api({ get: () => json({ payout: { ...DRAFT, methodChangedRecently: true } }) })
    renderAt()
    await loaded()

    expect(document.querySelector('[data-warning="changed-recently"]')).toHaveTextContent(
      "The photographer's payout method was changed in the last 72 hours. Confirm the destination with them, through a channel you already trust, before you send money.",
    )
  })

  it('shows both warnings together when both apply', async () => {
    api({ get: () => json({ payout: { ...DRAFT, payoutMethodIsCurrent: false, methodChangedRecently: true, payoutMethod: platformMethod({ ...BANK_METHOD, retiredAt: '2026-10-17T07:00:00.000Z' }) } }) })
    renderAt()
    await loaded()

    expect(document.querySelectorAll('[data-warning]')).toHaveLength(2)
    expect(section('Destination')).toHaveTextContent('Bank of Kigali')
  })

  it('goes back to all payouts, with Payouts current in the nav', async () => {
    api()
    const router = renderAt()
    await loaded()

    expect(within(screen.getByRole('navigation', { name: 'Platform' })).getByRole('link', { name: 'Payouts' })).toHaveAttribute('aria-current', 'page')
    await user().click(screen.getByRole('link', { name: 'All payouts' }))
    expect(router.state.location.pathname).toBe('/platform/payouts')
  })
})

describe('marking a draft paid', () => {
  async function openMarkPaid() {
    await loaded()
    await user().click(screen.getByRole('button', { name: 'Mark paid' }))
    return within(screen.getByRole('dialog', { name: 'Mark this payout paid' }))
  }

  it('asks for the reference and an optional note, after the transfer, naming the destination', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openMarkPaid()

    expect(dialog.getByText('Make the transfer of 45,000 RWF first. The photographer is emailed that it was sent.')).toBeInTheDocument()
    expect(dialog.getByLabelText('Transfer reference')).toBeInTheDocument()
    expect(dialog.getByLabelText('Note (optional)')).toBeInTheDocument()
    expect(dialog.getByText('Only platform admins see this. Up to 500 characters.')).toBeInTheDocument()
    expect(screen.getByRole('dialog').querySelector('[data-slot="payout-destination"]')).toHaveTextContent('+250 788 123 456')
    expect(posts(sent)).toEqual([])
  })

  it('requires the reference: a blank one is refused before asking', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openMarkPaid()

    await user().type(dialog.getByLabelText('Transfer reference'), '   ')
    await user().click(dialog.getByRole('button', { name: 'Mark paid' }))

    expect(fieldError(dialog, 'Transfer reference')).toBe('Enter the transfer reference, up to 100 characters.')
    expect(posts(sent)).toEqual([])
  })

  it('sends the reference and note trimmed, then shows the paid payout and says the photographer was emailed', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openMarkPaid()

    await user().type(dialog.getByLabelText('Transfer reference'), '  MP261017.0042 ')
    await user().type(dialog.getByLabelText('Note (optional)'), ' Sent from the ops MoMo line. ')
    await user().click(dialog.getByRole('button', { name: 'Mark paid' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts(sent)).toEqual([
      expect.objectContaining({ url: `${API}/mark-paid`, body: { transferReference: 'MP261017.0042', note: 'Sent from the ops MoMo line.' } }),
    ])
    expect(screen.getByRole('status')).toHaveTextContent('Marked paid. The photographer has been emailed.')
    expect(within(header()).getByText('Paid')).toHaveAttribute('data-status', 'paid')
    expect(header()).toHaveTextContent('Paid 17 Oct 2026, 10:30 by Jean Ops')
    expect(section('Transfer reference')).toHaveTextContent('MP261017.0042')
    expect(section('Transfer reference')).toHaveTextContent('Sent from the ops MoMo line.')
    expect(screen.queryByRole('button', { name: 'Mark paid' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel draft' })).not.toBeInTheDocument()
  })

  it('leaves the note out when there is none', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openMarkPaid()

    await user().type(dialog.getByLabelText('Transfer reference'), 'MP-1')
    await user().click(dialog.getByRole('button', { name: 'Mark paid' }))

    await waitFor(() => expect(posts(sent)).toHaveLength(1))
    expect(posts(sent)[0]?.body).toEqual({ transferReference: 'MP-1' })
  })

  it('words a duplicate reference under the field, and keeps the dialog open', async () => {
    api({ markPaid: () => json({ error: 'duplicate_transfer_reference' }, 409) })
    renderAt()
    const dialog = await openMarkPaid()

    await user().type(dialog.getByLabelText('Transfer reference'), 'MP-USED')
    await user().click(dialog.getByRole('button', { name: 'Mark paid' }))

    await waitFor(() =>
      expect(fieldError(dialog, 'Transfer reference')).toBe('That reference is already recorded on another payout. Check it and try again.'),
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(dialog.getByLabelText('Transfer reference')).toHaveValue('MP-USED')
  })

  it('marks the reference a 422 names', async () => {
    api({ markPaid: () => json({ error: 'validation_failed', fields: ['transferReference'] }, 422) })
    renderAt()
    const dialog = await openMarkPaid()

    await user().type(dialog.getByLabelText('Transfer reference'), 'x')
    await user().click(dialog.getByRole('button', { name: 'Mark paid' }))

    await waitFor(() => expect(fieldError(dialog, 'Transfer reference')).toBe('Enter the transfer reference, up to 100 characters.'))
  })

  it('marks the note a 422 names', async () => {
    api({ markPaid: () => json({ error: 'validation_failed', fields: ['note'] }, 422) })
    renderAt()
    const dialog = await openMarkPaid()

    await user().type(dialog.getByLabelText('Transfer reference'), 'MP-1')
    await user().type(dialog.getByLabelText('Note (optional)'), 'x')
    await user().click(dialog.getByRole('button', { name: 'Mark paid' }))

    await waitFor(() => expect(fieldError(dialog, 'Note (optional)')).toBe('Keep the note to 500 characters or fewer.'))
    expect(fieldError(dialog, 'Transfer reference')).toBeNull()
  })

  it('words a 400', async () => {
    api({ markPaid: () => json({ error: 'invalid_request' }, 400) })
    renderAt()
    const dialog = await openMarkPaid()

    await user().type(dialog.getByLabelText('Transfer reference'), 'MP-1')
    await user().click(dialog.getByRole('button', { name: 'Mark paid' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent('Check what you entered and try again.')
  })

  it('on a 409 not_draft, closes the dialog, shows the payout as it stands and says why', async () => {
    const { sent } = api({ markPaid: () => json({ error: 'not_draft', payout: CANCELLED }, 409) })
    renderAt()
    const dialog = await openMarkPaid()

    await user().type(dialog.getByLabelText('Transfer reference'), 'MP-1')
    await user().click(dialog.getByRole('button', { name: 'Mark paid' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('This payout is no longer a draft: it is cancelled now. The page shows it as it stands.')
    expect(within(header()).getByText('Cancelled')).toHaveAttribute('data-status', 'cancelled')
    expect(screen.queryByRole('button', { name: 'Mark paid' })).not.toBeInTheDocument()
    // The refusal carried the payout: nothing more was asked.
    expect(gets(sent)).toHaveLength(1)
  })

  it('reads the payout again when a not_draft arrives without it', async () => {
    let reads = 0
    const { sent } = api({
      get: () => json({ payout: reads++ === 0 ? DRAFT : PAID }),
      markPaid: () => json({ error: 'not_draft' }, 409),
    })
    renderAt()
    const dialog = await openMarkPaid()

    await user().type(dialog.getByLabelText('Transfer reference'), 'MP-1')
    await user().click(dialog.getByRole('button', { name: 'Mark paid' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('it is paid now')
    expect(gets(sent)).toHaveLength(2)
  })

  it('on a 404, says the payout no longer exists', async () => {
    api({ markPaid: () => json({ error: 'not_found' }, 404) })
    renderAt()
    const dialog = await openMarkPaid()

    await user().type(dialog.getByLabelText('Transfer reference'), 'MP-1')
    await user().click(dialog.getByRole('button', { name: 'Mark paid' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'This payout does not exist.' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('This payout no longer exists.')
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('words %s, keeping the dialog and what was typed', async (_label, answer) => {
    api({ markPaid: answer })
    renderAt()
    const dialog = await openMarkPaid()

    await user().type(dialog.getByLabelText('Transfer reference'), 'MP-1')
    await user().click(dialog.getByRole('button', { name: 'Mark paid' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent('Could not save the change. Check your connection and try again.')
    expect(dialog.getByLabelText('Transfer reference')).toHaveValue('MP-1')
  })

  it('closes on Cancel without sending', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openMarkPaid()

    await user().click(dialog.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(posts(sent)).toEqual([])
  })
})

describe('cancelling a draft', () => {
  async function openCancel() {
    await loaded()
    await user().click(screen.getByRole('button', { name: 'Cancel draft' }))
    return within(screen.getByRole('dialog', { name: 'Cancel this draft?' }))
  }

  it('confirms first, saying the lines go back to the balance', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openCancel()

    expect(dialog.getByText(/Its lines go back to the photographer's balance, for a later payout\./)).toBeInTheDocument()
    expect(posts(sent)).toEqual([])
  })

  it('keeps the draft on "Keep the draft"', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openCancel()

    await user().click(dialog.getByRole('button', { name: 'Keep the draft' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(posts(sent)).toEqual([])
    expect(within(header()).getByText('Draft')).toBeInTheDocument()
  })

  it('cancels with no body, then shows the cancelled payout with no lines', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openCancel()

    await user().click(dialog.getByRole('button', { name: 'Cancel the draft' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts(sent)).toEqual([expect.objectContaining({ url: `${API}/cancel`, body: undefined })])
    expect(screen.getByRole('status')).toHaveTextContent("Draft cancelled. Its lines are back in the photographer's balance.")
    expect(within(header()).getByText('Cancelled')).toHaveAttribute('data-status', 'cancelled')
    expect(header()).toHaveTextContent('Cancelled 17 Oct 2026, 11:00 by an admin')
    expect(section('Lines')).toHaveTextContent("No lines: a cancelled draft gives its lines back to the photographer's balance.")
  })

  it('on a 409 not_draft, shows the payout as it stands and says why', async () => {
    api({ cancel: () => json({ error: 'not_draft', payout: PAID }, 409) })
    renderAt()
    const dialog = await openCancel()

    await user().click(dialog.getByRole('button', { name: 'Cancel the draft' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('This payout is no longer a draft: it is paid now.')
    expect(within(header()).getByText('Paid')).toBeInTheDocument()
  })

  it('words a failure, and stays open to try again', async () => {
    api({ cancel: () => json({ error: 'internal_error' }, 500) })
    renderAt()
    const dialog = await openCancel()

    await user().click(dialog.getByRole('button', { name: 'Cancel the draft' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent('Could not save the change.')
    expect(dialog.getByRole('button', { name: 'Cancel the draft' })).toBeEnabled()
  })

  it('on a 404, says the payout no longer exists', async () => {
    api({ cancel: () => json({ error: 'not_found' }, 404) })
    renderAt()
    const dialog = await openCancel()

    await user().click(dialog.getByRole('button', { name: 'Cancel the draft' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'This payout does not exist.' })).toBeInTheDocument()
  })
})

describe('a paid or cancelled payout', () => {
  it('shows the reference, the note and who paid it, with no actions and no send warnings', async () => {
    api({ get: () => json({ payout: { ...PAID, payoutMethodIsCurrent: false, methodChangedRecently: true } }) })
    renderAt()
    await loaded()

    expect(header()).toHaveTextContent('Paid 17 Oct 2026, 10:30 by Jean Ops')
    expect(section('Transfer reference')).toHaveTextContent('MP261017.0042')
    expect(within(section('Transfer reference')).getByRole('heading', { level: 3, name: 'Note' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark paid' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel draft' })).not.toBeInTheDocument()
    expect(document.querySelector('[data-warning]')).toBeNull()
    expect(section('Destination')).toHaveTextContent('Since replaced by a new payout method.')
  })

  it('leaves the note out when there was none', async () => {
    api({ get: () => json({ payout: { ...PAID, note: null } }) })
    renderAt()
    await loaded()

    expect(within(section('Transfer reference')).queryByRole('heading', { name: 'Note' })).not.toBeInTheDocument()
  })

  it('shows a cancelled payout with who cancelled it and no lines', async () => {
    api({ get: () => json({ payout: CANCELLED }) })
    renderAt()
    await loaded()

    expect(header()).toHaveTextContent('Cancelled 17 Oct 2026, 11:00 by an admin')
    expect(screen.queryByRole('heading', { level: 2, name: 'Transfer reference' })).not.toBeInTheDocument()
    expect(section('Lines')).toHaveTextContent('No lines')
  })

  it('shows a paid payout’s lines', async () => {
    api({ get: () => json({ payout: { ...PAID, items: [payoutItem({ state: 'paid' }), payoutItem({ id: 'pi-r', kind: 'reversal', amountRwf: -5_000, state: 'paid' })] } }) })
    renderAt()
    await loaded()

    expect(section('Lines')).toHaveTextContent('-5,000 RWF')
  })
})

describe('a payout that cannot be shown', () => {
  it.each([
    [404, 'not_found'],
    [400, 'invalid_request'],
  ])('reads a %s as not existing', async (status, code) => {
    api({ get: () => json({ error: code }, status) })
    renderAt()

    expect(await screen.findByRole('heading', { level: 1, name: 'This payout does not exist.' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says a failed load failed, and loads again on retry', async () => {
    let calls = 0
    api({ get: () => (calls++ === 0 ? json({ error: 'internal_error' }, 500) : json({ payout: DRAFT })) })
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this payout. Check your connection and try again.')
    await user().click(screen.getByRole('button', { name: 'Try again' }))

    await loaded()
  })

  it('shows placeholders while it loads', async () => {
    api({ get: () => new Promise<Response>(() => {}) })
    renderAt()

    expect(await screen.findByRole('status')).toHaveTextContent('Loading payout…')
  })

  it('sends him to sign in on a 401', async () => {
    api({ get: () => json({ error: 'invalid_token' }, 401) })
    const router = renderAt()

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
    expect(readSession('platform')).toBeNull()
  })
})
