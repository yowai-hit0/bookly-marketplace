import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { readSession, saveSession } from '@/auth/session'
import type { PayoutDue, PlatformPayout } from '@/platform/payouts'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'
import { ADMIN, BANK_METHOD, PHOTOGRAPHER, payoutDue, platformMethod, platformPayout, platformPayoutDetail } from '@/test/payout-fixtures'

/**
 * `/platform/payouts` (marketplace spec R4.1, R4.4, T4.3): the Due view
 * with each photographer's balance and destination, flagged when the
 * destination is new or missing; building a draft through a confirmation that
 * words every refusal; and the drafts, paid and cancelled lists.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

const OTHER = { ...PHOTOGRAPHER, id: 'ph-2', handle: 'nyamirambo-studio', displayName: 'Nyamirambo Studio', email: 'hi@nyamirambo.example' }
const NEW_METHOD = payoutDue({ photographer: OTHER, payableRwf: 30_000, itemCount: 1, methodChangedRecently: true, payoutMethod: platformMethod({ ...BANK_METHOD }) })
const NO_METHOD = payoutDue({ photographer: { ...OTHER, id: 'ph-3', displayName: 'Gisozi Pix', handle: 'gisozi-pix' }, payableRwf: 10_000, itemCount: 1, payoutMethod: null })
const HAS_DRAFT = payoutDue({ photographer: { ...OTHER, id: 'ph-4', displayName: 'Remera Shots', handle: 'remera-shots' }, payableRwf: 5_000, itemCount: 1, draftPayoutId: 'po-existing' })
const DUE: PayoutDue[] = [payoutDue(), NEW_METHOD, NO_METHOD, HAS_DRAFT]

const CREATED = platformPayoutDetail({ id: 'po-new' })

type Options = {
  due?: () => Response | Promise<Response>
  list?: (status: string | null) => Response | Promise<Response>
  build?: (call: Sent) => Response | Promise<Response>
}

function api({ due = () => json({ due: DUE }), list = () => json({ payouts: [] }), build = () => json({ payout: CREATED }, 201) }: Options = {}) {
  return stubApi((call) => {
    const url = new URL(call.url, 'http://test')
    if (url.pathname === '/api/platform/payouts/due') return due()
    if (url.pathname === '/api/platform/payouts' && call.method === 'GET') return list(url.searchParams.get('status'))
    if (url.pathname === '/api/platform/payouts' && call.method === 'POST') return build(call)
    if (url.pathname.startsWith('/api/platform/payouts/')) return json({ payout: CREATED })
    return undefined
  })
}

function renderAt(path = '/platform/payouts') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

function dueReads(sent: Sent[]) {
  return sent.filter((call) => call.url === '/api/platform/payouts/due')
}

function posts(sent: Sent[]) {
  return sent.filter((call) => call.method === 'POST')
}

async function dueTable() {
  return screen.findByRole('table', { name: 'Due' })
}

/** A row by the photographer id it carries; `hidden` reaches behind an open dialog. */
function row(attribute: string, id: string) {
  const element = document.querySelector(`[${attribute}="${id}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`no row ${id}`)
  return element
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

describe('the views', () => {
  it('opens on Due, read with the platform token, with Payouts current in the nav', async () => {
    const { sent } = api()
    renderAt()
    await dueTable()

    expect(screen.getByRole('tab', { name: 'Due' })).toHaveAttribute('aria-selected', 'true')
    expect(dueReads(sent)).toHaveLength(1)
    expect(dueReads(sent)[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
    expect(within(screen.getByRole('navigation', { name: 'Platform' })).getByRole('link', { name: 'Payouts' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Payouts'])
  })

  it('offers Due, Drafts, Paid and Cancelled', async () => {
    api()
    renderAt()
    await dueTable()

    expect(within(screen.getByRole('tablist', { name: 'Show' })).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Due', 'Drafts', 'Paid', 'Cancelled'])
  })

  it.each([
    ['Drafts', 'draft'],
    ['Paid', 'paid'],
    ['Cancelled', 'cancelled'],
  ])('switches to %s, keeping it in the address and asking for that status', async (tab, status) => {
    const { sent } = api()
    const router = renderAt()
    await dueTable()

    await user().click(screen.getByRole('tab', { name: tab }))

    expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true')
    expect(new URLSearchParams(router.state.location.search).get('view')).toBe(status)
    await waitFor(() => expect(sent.some((call) => call.url === `/api/platform/payouts?status=${status}`)).toBe(true))
  })

  it('opens the view the address names', async () => {
    const { sent } = api()
    renderAt('/platform/payouts?view=paid')

    await waitFor(() => expect(sent.map((call) => call.url)).toContain('/api/platform/payouts?status=paid'))
    expect(screen.getByRole('tab', { name: 'Paid' })).toHaveAttribute('aria-selected', 'true')
    expect(dueReads(sent)).toHaveLength(0)
  })

  it('reads an unknown view as Due', async () => {
    api()
    renderAt('/platform/payouts?view=everything')

    await dueTable()
    expect(screen.getByRole('tab', { name: 'Due' })).toHaveAttribute('aria-selected', 'true')
  })

  it('goes back to Due without a view in the address', async () => {
    api()
    const router = renderAt('/platform/payouts?view=draft')
    await screen.findByText('No draft payouts.')

    await user().click(screen.getByRole('tab', { name: 'Due' }))

    await dueTable()
    expect(router.state.location.search).toBe('')
  })
})

describe('payouts due', () => {
  it('lists each photographer with the balance, the line count and the destination', async () => {
    api()
    renderAt()
    const table = await dueTable()

    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Photographer', 'Payable', 'Payout method', 'Actions'])
    const cells = within(row('data-photographer', PHOTOGRAPHER.id)).getAllByRole('cell').map((td) => td.textContent)
    expect(cells.slice(0, 3)).toEqual([
      'Kigali Lens/p/kigali-lenslens@kigali.example',
      '45,000 RWF2 lines',
      'MTN MoMo+250 788 123 456Name on the account: Aline Uwase',
    ])
    expect(within(row('data-photographer', PHOTOGRAPHER.id)).getByRole('button', { name: 'Create payout for Kigali Lens' })).toBeInTheDocument()
  })

  it('flags a destination changed in the last 72 hours, prominently and in words', async () => {
    api()
    renderAt()
    await dueTable()

    const warning = row('data-photographer', OTHER.id).querySelector('[data-warning="changed-recently"]')
    expect(warning).toHaveTextContent('Payout method changed in the last 72 hours. Confirm it with the photographer before sending money.')
    expect(warning).toHaveAttribute('data-variant', 'console')
    expect(row('data-photographer', PHOTOGRAPHER.id).querySelector('[data-warning]')).toBeNull()
  })

  it('flags a photographer with no destination, and offers no payout to build', async () => {
    api()
    renderAt()
    await dueTable()

    const noMethod = row('data-photographer', 'ph-3')
    expect(noMethod.querySelector('[data-warning="no-method"]')).toHaveTextContent("No payout method saved. A payout can't be created until they add one.")
    expect(noMethod.querySelector('[data-slot="payout-destination"]')).toBeNull()
    expect(within(noMethod).queryByRole('button')).not.toBeInTheDocument()
  })

  it('links to a draft that already exists instead of offering another', async () => {
    api()
    renderAt()
    await dueTable()

    const drafted = row('data-photographer', 'ph-4')
    expect(within(drafted).getByRole('link', { name: 'Open the draft for Remera Shots' })).toHaveAttribute('href', '/platform/payouts/po-existing')
    expect(within(drafted).queryByRole('button', { name: /Create payout/ })).not.toBeInTheDocument()
  })

  it('says so when nobody is owed anything', async () => {
    api({ due: () => json({ due: [] }) })
    renderAt()

    expect(await screen.findByText('No photographer is owed a payout right now.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('says a failed load failed, and loads again on retry', async () => {
    let calls = 0
    const { sent } = api({ due: () => (calls++ === 0 ? json({ error: 'internal_error' }, 500) : json({ due: DUE })) })
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the payouts. Check your connection and try again.')
    await user().click(screen.getByRole('button', { name: 'Try again' }))

    await dueTable()
    expect(dueReads(sent)).toHaveLength(2)
  })

  it('shows placeholders while it loads', async () => {
    api({ due: () => new Promise<Response>(() => {}) })
    renderAt()

    expect(await screen.findByRole('status')).toHaveTextContent('Loading payouts…')
  })

  it('sends him to sign in when the API refuses the token', async () => {
    api({ due: () => json({ error: 'invalid_token' }, 401) })
    const router = renderAt()

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
    expect(readSession('platform')).toBeNull()
  })
})

describe('creating a payout', () => {
  async function openCreate(name = 'Kigali Lens') {
    await dueTable()
    await user().click(screen.getByRole('button', { name: `Create payout for ${name}` }))
    return within(screen.getByRole('dialog'))
  }

  it('confirms first: the amount, the lines and the destination, with nothing sent yet', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openCreate()

    expect(dialog.getByRole('heading', { name: 'Create a payout for Kigali Lens?' })).toBeInTheDocument()
    expect(dialog.getByText(/This puts every line payable now into a draft of 45,000 RWF \(2 lines\)\. Nothing is sent/)).toBeInTheDocument()
    expect(screen.getByRole('dialog').querySelector('[data-slot="payout-destination"]')).toHaveTextContent('MTN MoMo+250 788 123 456Name on the account: Aline Uwase')
    expect(screen.getByRole('dialog').querySelector('[data-warning="changed-recently"]')).toBeNull()
    expect(posts(sent)).toEqual([])
  })

  it('shows the 72-hour warning when the destination is new', async () => {
    api()
    renderAt()
    const dialog = await openCreate('Nyamirambo Studio')

    expect(dialog.getByText(/This payout method was saved in the last 72 hours\. Redirecting payouts is what an account takeover aims for/)).toBeInTheDocument()
    expect(screen.getByRole('dialog').querySelector('[data-slot="payout-destination"]')).toHaveTextContent('Bank of Kigali')
  })

  it('backs out without building anything', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openCreate()

    await user().click(dialog.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(posts(sent)).toEqual([])
  })

  it('builds the draft for that photographer and opens it', async () => {
    const { sent } = api()
    const router = renderAt()
    const dialog = await openCreate()

    await user().click(dialog.getByRole('button', { name: 'Create draft' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/payouts/po-new'))
    expect(posts(sent)).toEqual([expect.objectContaining({ url: '/api/platform/payouts', body: { photographerId: PHOTOGRAPHER.id } })])
    expect(posts(sent)[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
  })

  it('links to the draft that already exists on a 409 draft_exists, and reads the list again', async () => {
    const { sent } = api({ build: () => json({ error: 'draft_exists', payoutId: 'po-race' }, 409) })
    renderAt()
    const dialog = await openCreate()

    await user().click(dialog.getByRole('button', { name: 'Create draft' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent('A draft payout for this photographer already exists. Pay or cancel it before creating another.')
    expect(dialog.getByRole('link', { name: 'Open the draft' })).toHaveAttribute('href', '/platform/payouts/po-race')
    expect(dialog.queryByRole('button', { name: 'Create draft' })).not.toBeInTheDocument()
    await waitFor(() => expect(dueReads(sent)).toHaveLength(2))
  })

  it.each([
    [0, 'Nothing is payable: their balance is 0 RWF. No payout was created, and the balance carries forward.'],
    [-5_000, 'Nothing is payable: their balance is -5,000 RWF. No payout was created, and the balance carries forward.'],
  ])('words a 409 nothing_payable with the balance %s', async (payableRwf, message) => {
    const { sent } = api({ build: () => json({ error: 'nothing_payable', payableRwf }, 409) })
    renderAt()
    const dialog = await openCreate()

    await user().click(dialog.getByRole('button', { name: 'Create draft' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent(message)
    expect(dialog.queryByRole('button', { name: 'Create draft' })).not.toBeInTheDocument()
    await waitFor(() => expect(dueReads(sent)).toHaveLength(2))
  })

  it.each([
    [409, { error: 'no_payout_method' }, 'This photographer has no payout method saved, so no payout can be created.'],
    [404, { error: 'not_found' }, 'That photographer no longer exists.'],
  ])('words a %s %o', async (status, body, message) => {
    const { sent } = api({ build: () => json(body, status) })
    renderAt()
    const dialog = await openCreate()

    await user().click(dialog.getByRole('button', { name: 'Create draft' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent(message)
    await waitFor(() => expect(dueReads(sent)).toHaveLength(2))
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('words %s, and lets him try again', async (_label, answer) => {
    let calls = 0
    const { sent } = api({ build: () => (calls++ === 0 ? answer() : json({ payout: CREATED }, 201)) })
    const router = renderAt()
    const dialog = await openCreate()

    await user().click(dialog.getByRole('button', { name: 'Create draft' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Could not create the payout. Check your connection and try again.')
    expect(dueReads(sent)).toHaveLength(1)

    await user().click(dialog.getByRole('button', { name: 'Create draft' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/payouts/po-new'))
  })

  it('sends him to sign in on a 401', async () => {
    api({ build: () => json({ error: 'invalid_token' }, 401) })
    const router = renderAt()
    const dialog = await openCreate()

    await user().click(dialog.getByRole('button', { name: 'Create draft' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
  })
})

describe('the drafts, paid and cancelled lists', () => {
  const DRAFT = platformPayout({ id: 'po-d', payoutMethodIsCurrent: false, methodChangedRecently: true })
  const PAID = platformPayout({
    id: 'po-p',
    status: 'paid',
    transferReference: 'MP261016.0001',
    paidAt: '2026-10-16T10:00:00.000Z',
    paidBy: { id: 'u2', email: 'second@bookly.example', fullName: null },
    payoutMethodIsCurrent: false,
    methodChangedRecently: true,
  })
  const CANCELLED = platformPayout({ id: 'po-c', status: 'cancelled', itemCount: 0, cancelledAt: '2026-10-16T11:00:00.000Z', cancelledBy: null })

  function listApi(payouts: Record<string, PlatformPayout[]>) {
    return api({ list: (status) => json({ payouts: payouts[status ?? ''] ?? [] }) })
  }

  it('lists drafts with who built them, and warns of a destination since replaced or new', async () => {
    listApi({ draft: [DRAFT] })
    renderAt('/platform/payouts?view=draft')

    const table = await screen.findByRole('table', { name: 'Drafts' })
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Photographer', 'Amount', 'Payout method', 'Created', 'Actions'])
    const draft = row('data-payout', 'po-d')
    expect(draft).toHaveTextContent('45,000 RWF2 lines')
    expect(draft).toHaveTextContent('16 Oct 2026, 10:00by Grace Ops')
    expect(draft.querySelector('[data-warning="not-current"]')).toHaveTextContent('No longer their payout method: they saved a new one after this payout was created.')
    expect(draft.querySelector('[data-warning="changed-recently"]')).toHaveTextContent('Payout method changed in the last 72 hours.')
    expect(within(draft).getByRole('link', { name: 'Open the payout to Kigali Lens of 45,000 RWF' })).toHaveAttribute('href', '/platform/payouts/po-d')
  })

  it('lists paid payouts with when, by whom and the reference, and no send warnings', async () => {
    listApi({ paid: [PAID] })
    renderAt('/platform/payouts?view=paid')

    const table = await screen.findByRole('table', { name: 'Paid' })
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Photographer', 'Amount', 'Payout method', 'Created', 'Paid', 'Actions'])
    const paid = row('data-payout', 'po-p')
    expect(paid).toHaveTextContent('16 Oct 2026, 12:00by second@bookly.exampleMP261016.0001')
    expect(paid.querySelector('[data-warning]')).toBeNull()
  })

  it('lists cancelled payouts with when, and "an admin" when the canceller is unknown', async () => {
    listApi({ cancelled: [CANCELLED] })
    renderAt('/platform/payouts?view=cancelled')

    const table = await screen.findByRole('table', { name: 'Cancelled' })
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Photographer', 'Amount', 'Payout method', 'Created', 'Cancelled', 'Actions'])
    expect(row('data-payout', 'po-c')).toHaveTextContent('16 Oct 2026, 13:00by an admin')
    expect(row('data-payout', 'po-c')).toHaveTextContent('0 lines')
  })

  it.each([
    ['draft', 'No draft payouts.'],
    ['paid', 'No payouts have been paid yet.'],
    ['cancelled', 'No cancelled payouts.'],
  ])('says so when there are no %s payouts', async (status, message) => {
    listApi({})
    renderAt(`/platform/payouts?view=${status}`)

    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('says a failed list failed, and loads again on retry', async () => {
    let calls = 0
    api({ list: () => (calls++ === 0 ? Promise.reject(new TypeError('Failed to fetch')) : json({ payouts: [DRAFT] })) })
    renderAt('/platform/payouts?view=draft')

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the payouts.')
    await user().click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('table', { name: 'Drafts' })).toBeInTheDocument()
  })

  it('opens a payout from its row', async () => {
    listApi({ paid: [PAID] })
    const router = renderAt('/platform/payouts?view=paid')
    await screen.findByRole('table', { name: 'Paid' })

    await user().click(screen.getByRole('link', { name: 'Open the payout to Kigali Lens of 45,000 RWF' }))

    expect(router.state.location.pathname).toBe('/platform/payouts/po-p')
  })

  it('names the builder by email when the account has no name', async () => {
    listApi({ draft: [platformPayout({ id: 'po-e', createdBy: { ...ADMIN, fullName: null } })] })
    renderAt('/platform/payouts?view=draft')
    await screen.findByRole('table', { name: 'Drafts' })

    expect(row('data-payout', 'po-e')).toHaveTextContent('by ops@bookly.example')
  })
})
