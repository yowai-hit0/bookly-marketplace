import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { readSession, saveSession } from '@/auth/session'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'
import { refundDue } from '@/test/payout-fixtures'

/**
 * `/platform/refunds` (marketplace spec R4.6, Phase 4 refund decision): every
 * online payment owed back -- booking, client contact, photographer, amount,
 * provider and references -- and recording one with its reference and an
 * optional time. A recorded refund leaves the list; every refusal is worded.
 *
 * Since the overpayment decision a row is a full refund or the return of an
 * overpaid part: the kind is shown in words, the amount to send is the figure
 * that matters (the payment's amount is context), and the kind is always sent
 * back so a row that changed meanwhile is refused and the list read again.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }
const MOMO = refundDue()
const CARD = refundDue({
  paymentId: 'pa-card',
  kind: 'session_fee',
  provider: 'flutterwave',
  method: 'card',
  amountRwf: 30_000,
  refundAmountRwf: 30_000,
  ourRef: 'ffff0000-0000-4000-8000-00000000ffff',
  providerRef: null,
  booking: { ...MOMO.booking, id: 'b-card', reference: 'BKY-2610-00051', contactName: 'Diane Ishimwe', contactEmail: 'diane@example.com', contactPhone: '+250722000222' },
  photographer: { id: 'ph-2', handle: 'nyamirambo-studio', displayName: 'Nyamirambo Studio' },
})
const RECORDED = {
  paymentId: MOMO.paymentId,
  kind: 'booking_fee',
  provider: 'mtn_momo_direct',
  amountRwf: 20_000,
  status: 'refunded',
  refundKind: 'full',
  refundAmountRwf: 20_000,
  overpaidRwf: 0,
  refundedAt: '2026-10-17T08:00:00.000Z',
  refundReference: 'RF-1',
  refundedByUserId: 'u-admin',
}

type Options = {
  list?: () => Response | Promise<Response>
  record?: (call: Sent) => Response | Promise<Response>
}

function api({ list = () => json({ refunds: [MOMO, CARD] }), record = () => json({ refund: RECORDED }) }: Options = {}) {
  return stubApi((call) => {
    if (call.url === '/api/platform/refunds' && call.method === 'GET') return list()
    if (call.url.startsWith('/api/platform/refunds/') && call.method === 'POST') return record(call)
    return undefined
  })
}

function renderAt(path = '/platform/refunds') {
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

async function table() {
  return screen.findByRole('table', { name: 'Refunds' })
}

function row(paymentId: string) {
  const element = document.querySelector(`[data-payment="${paymentId}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`no row ${paymentId}`)
  return element
}

async function openRecord(reference = 'BKY-2610-00050') {
  await table()
  await user().click(screen.getByRole('button', { name: `Record refund for ${reference}` }))
  return within(screen.getByRole('dialog', { name: `Record the refund for ${reference}` }))
}

type Dialog = Awaited<ReturnType<typeof openRecord>>

function fieldError(dialog: Dialog, label: string): string | null {
  const field = dialog.getByLabelText(label)
  if (field.getAttribute('aria-invalid') !== 'true') return null
  const ids = (field.getAttribute('aria-describedby') ?? '').split(' ')
  return ids.map((id) => document.getElementById(id)).find((element) => element?.id.endsWith('-error'))?.textContent ?? null
}

async function recordWith(dialog: Dialog, reference: string, at?: string) {
  if (reference !== '') await user().type(dialog.getByLabelText('Refund reference'), reference)
  if (at !== undefined) fireEvent.change(dialog.getByLabelText('Refunded at (Kigali time, optional)'), { target: { value: at } })
  await user().click(dialog.getByRole('button', { name: 'Record refund' }))
}

beforeEach(() => {
  saveSession('platform', SESSION)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  delete document.documentElement.dataset.adminTheme
})

describe('the refunds owed', () => {
  it('reads them with the platform token, with Refunds current in the nav', async () => {
    const { sent } = api()
    renderAt()
    await table()

    expect(sent).toEqual([expect.objectContaining({ method: 'GET', url: '/api/platform/refunds' })])
    expect(sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
    expect(within(screen.getByRole('navigation', { name: 'Platform' })).getByRole('link', { name: 'Refunds' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Refunds'])
  })

  it('says the money is in the platform’s account, and cash is the photographer’s', async () => {
    api()
    renderAt()
    await table()

    expect(screen.getByText(/It is in Bookly's account, so refund it from there, then record it here\. Cash refunds are the photographer's to make and record\./)).toBeInTheDocument()
  })

  it('shows each one: booking, client contact, photographer, amount, provider and references', async () => {
    api()
    renderAt()
    const refunds = await table()

    expect(within(refunds).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Booking',
      'Client',
      'Photographer',
      'Refund',
      'To send',
      'Paid with',
      'Actions',
    ])
    expect(within(row(MOMO.paymentId)).getAllByRole('cell').map((td) => td.textContent).slice(0, 6)).toEqual([
      'BKY-2610-00050Shoot 25 Oct 2026, 09:00',
      'Eric Mugishaeric@example.com+250788000111',
      'Kigali Lens/p/kigali-lens',
      'Full refund',
      '20,000 RWFof 20,000 RWF paidBooking fee',
      'MTN MoMoprovider ref 4100000123 · our ref a1b2c3d4-0000-4000-8000-00000000a1b2',
    ])
  })

  it('words Flutterwave, a session fee and a missing provider reference', async () => {
    api()
    renderAt()
    await table()

    const card = row('pa-card')
    expect(card).toHaveTextContent('Flutterwave')
    expect(card).toHaveTextContent('Session fee')
    expect(card).toHaveTextContent('provider ref — · our ref ffff0000')
    expect(card).not.toHaveTextContent('null')
  })

  it('keeps the order the API sent: oldest first', async () => {
    api({ list: () => json({ refunds: [CARD, MOMO] }) })
    renderAt()
    await table()

    expect([...document.querySelectorAll('[data-payment]')].map((tr) => tr.getAttribute('data-payment'))).toEqual(['pa-card', MOMO.paymentId])
  })

  it('says so when none are owed', async () => {
    api({ list: () => json({ refunds: [] }) })
    renderAt()

    expect(await screen.findByText('No refunds are owed.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('says a failed load failed, and loads again on retry', async () => {
    let calls = 0
    const { sent } = api({ list: () => (calls++ === 0 ? Promise.reject(new TypeError('Failed to fetch')) : json({ refunds: [MOMO] })) })
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the refunds. Check your connection and try again.')
    await user().click(screen.getByRole('button', { name: 'Try again' }))

    await table()
    expect(sent).toHaveLength(2)
  })

  it('shows placeholders while it loads', async () => {
    api({ list: () => new Promise<Response>(() => {}) })
    renderAt()

    expect(await screen.findByRole('status')).toHaveTextContent('Loading refunds…')
  })

  it('sends him to sign in when the API refuses the token', async () => {
    api({ list: () => json({ error: 'invalid_token' }, 401) })
    const router = renderAt()

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
    expect(readSession('platform')).toBeNull()
  })
})

describe('recording a refund', () => {
  it('asks for the reference and an optional time, saying the system moves no money', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openRecord()

    expect(dialog.getByText("The system moves no money. Refund 20,000 RWF to Eric Mugisha from Bookly's MTN MoMo account first, then record it here.")).toBeInTheDocument()
    expect(dialog.getByLabelText('Refund reference')).toBeInTheDocument()
    expect(dialog.getByLabelText('Refunded at (Kigali time, optional)')).toHaveAttribute('type', 'datetime-local')
    expect(posts(sent)).toEqual([])
  })

  it('records it with the reference, trimmed, and no time for "just now"; the row leaves the list', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, '  RF-1 ')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts(sent)).toEqual([expect.objectContaining({ url: `/api/platform/refunds/${MOMO.paymentId}`, body: { reference: 'RF-1', refundKind: 'full' } })])
    expect(posts(sent)[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
    expect(screen.getByRole('status')).toHaveTextContent('Refund of 20,000 RWF for BKY-2610-00050 recorded.')
    expect(document.querySelector(`[data-payment="${MOMO.paymentId}"]`)).toBeNull()
    expect(row('pa-card')).toBeInTheDocument()
  })

  it('sends a time he gives as Kigali time with its offset', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, 'RF-1', '2026-10-16T09:30')

    await waitFor(() => expect(posts(sent)).toHaveLength(1))
    expect(posts(sent)[0]?.body).toEqual({ reference: 'RF-1', refundKind: 'full', refundedAt: '2026-10-16T09:30:00+02:00' })
  })

  it('says so when the last refund is recorded', async () => {
    api({ list: () => json({ refunds: [MOMO] }) })
    renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, 'RF-1')

    expect(await screen.findByText('No refunds are owed.')).toBeInTheDocument()
  })

  it('requires the reference: a blank one is refused before asking', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, '   ')

    expect(fieldError(dialog, 'Refund reference')).toBe('Enter the refund reference, up to 100 characters.')
    expect(posts(sent)).toEqual([])
  })

  it('refuses a time in the future before asking', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T08:00:00.000Z'))
    const { sent } = api()
    renderAt()
    const dialog = await openRecord()

    // 10:01 Kigali is 08:01 UTC: a minute from now.
    await recordWith(dialog, 'RF-1', '2026-10-17T10:01')

    expect(fieldError(dialog, 'Refunded at (Kigali time, optional)')).toBe('Enter a time that is not in the future, or leave it blank.')
    expect(posts(sent)).toEqual([])
  })

  it('takes a time of exactly now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T08:00:00.000Z'))
    const { sent } = api()
    renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, 'RF-1', '2026-10-17T10:00')

    await waitFor(() => expect(posts(sent)).toHaveLength(1))
  })

  it('words a 409 cash_payment in the dialog, and keeps the row', async () => {
    api({ record: () => json({ error: 'cash_payment' }, 409) })
    renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, 'RF-1')

    expect(await dialog.findByRole('alert')).toHaveTextContent('This was a cash payment: the photographer refunds it and records it in their studio.')
    expect(row(MOMO.paymentId)).toBeInTheDocument()
  })

  it.each([
    [409, 'not_refundable', 'That payment is no longer owed back. It may have been recorded already.'],
    [404, 'not_found', 'That payment no longer exists.'],
  ])('on a %s %s, closes the dialog, drops the stale row and says why', async (status, code, message) => {
    api({ record: () => json({ error: code }, status) })
    renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, 'RF-1')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(document.querySelector(`[data-payment="${MOMO.paymentId}"]`)).toBeNull()
    expect(row('pa-card')).toBeInTheDocument()
  })

  it.each([
    ['reference', 'Refund reference', 'Enter the refund reference, up to 100 characters.'],
    ['refundedAt', 'Refunded at (Kigali time, optional)', 'Enter a time that is not in the future, or leave it blank.'],
  ])('marks the field a 422 names: %s', async (field, label, message) => {
    api({ record: () => json({ error: 'validation_failed', fields: [field] }, 422) })
    renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, 'RF-1')

    await waitFor(() => expect(fieldError(dialog, label)).toBe(message))
  })

  it.each<[string, () => Response | Promise<Response>, string]>([
    ['a 400', () => json({ error: 'invalid_request' }, 400), 'Check what you entered and try again.'],
    ['a 422 naming no field of the form', () => json({ error: 'validation_failed', fields: ['paymentId'] }, 422), 'Check what you entered and try again.'],
    ['a 500', () => json({ error: 'internal_error' }, 500), 'Could not record the refund. Check your connection and try again.'],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch')), 'Could not record the refund. Check your connection and try again.'],
  ])('words %s, keeping the dialog and the row', async (_label, answer, message) => {
    api({ record: answer })
    renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, 'RF-1')

    expect(await dialog.findByRole('alert')).toHaveTextContent(message)
    expect(dialog.getByLabelText('Refund reference')).toHaveValue('RF-1')
    expect(row(MOMO.paymentId)).toBeInTheDocument()
  })

  it('closes on Cancel without sending', async () => {
    const { sent } = api()
    renderAt()
    const dialog = await openRecord()

    await user().click(dialog.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(posts(sent)).toEqual([])
  })

  it('sends him to sign in on a 401', async () => {
    api({ record: () => json({ error: 'invalid_token' }, 401) })
    const router = renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, 'RF-1')

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
  })
})

// --- Overpayments (Phase 4 overpayment decision) -------------------------------------------------

describe('overpayment refunds', () => {
  /** A 30,000 RWF session fee paid as 35,000 RWF: only the 5,000 RWF extra goes back. */
  const OVERPAID = refundDue({
    paymentId: 'pa-over',
    kind: 'session_fee',
    amountRwf: 35_000,
    refundKind: 'overpayment',
    refundAmountRwf: 5_000,
    overpaidRwf: 5_000,
    booking: { ...MOMO.booking, id: 'b-over', reference: 'BKY-2610-00060', status: 'confirmed' },
  })
  /** The same payment later owed back whole, its 5,000 RWF extra already returned: 30,000 RWF to send. */
  const REDUCED = refundDue({
    paymentId: 'pa-reduced',
    kind: 'session_fee',
    amountRwf: 35_000,
    refundKind: 'full',
    refundAmountRwf: 30_000,
    overpaidRwf: 5_000,
    booking: { ...MOMO.booking, id: 'b-reduced', reference: 'BKY-2610-00061' },
  })

  function kindCell(paymentId: string) {
    return row(paymentId).querySelector('[data-cell="kind"]')
  }

  function toSendCell(paymentId: string) {
    return row(paymentId).querySelector('[data-cell="to-send"]')
  }

  it('words an overpayment as returning the extra, and says why', async () => {
    api({ list: () => json({ refunds: [OVERPAID] }) })
    renderAt()
    await table()

    expect(kindCell('pa-over')).toHaveTextContent(
      'Return the extra (overpayment)The client paid 5,000 RWF more than was due; the photographer earns only what was due.',
    )
    expect(row('pa-over').querySelector('[data-refund-kind="overpayment"]')).not.toBeNull()
  })

  it('shows the amount to send prominently, with the whole payment as context', async () => {
    api({ list: () => json({ refunds: [OVERPAID] }) })
    renderAt()
    await table()

    const send = within(toSendCell('pa-over') as HTMLElement)
    expect(send.getByText('5,000 RWF')).toHaveClass('font-medium')
    expect(send.getByText('of 35,000 RWF paid')).toBeInTheDocument()
    expect(toSendCell('pa-over')).toHaveTextContent('Session fee')
  })

  it('says a full refund is reduced when an overpayment was already returned', async () => {
    api({ list: () => json({ refunds: [REDUCED] }) })
    renderAt()
    await table()

    expect(kindCell('pa-reduced')).toHaveTextContent(
      'Full refund5,000 RWF of this payment was already returned as an overpayment, so the amount to send is reduced.',
    )
    expect(toSendCell('pa-reduced')).toHaveTextContent('30,000 RWFof 35,000 RWF paid')
  })

  it('adds no note to a full refund of an overpaid payment whose extra was never returned: the whole amount goes back', async () => {
    api({ list: () => json({ refunds: [{ ...REDUCED, refundAmountRwf: 35_000 }] }) })
    renderAt()
    await table()

    expect(kindCell('pa-reduced')?.textContent).toBe('Full refund')
    expect(toSendCell('pa-reduced')).toHaveTextContent('35,000 RWFof 35,000 RWF paid')
  })

  it('adds no note to a full refund of a payment that was never overpaid', async () => {
    api()
    renderAt()
    await table()

    expect(kindCell(MOMO.paymentId)?.textContent).toBe('Full refund')
  })

  it('asks to return only the extra in the dialog', async () => {
    api({ list: () => json({ refunds: [OVERPAID] }) })
    renderAt()
    const dialog = await openRecord('BKY-2610-00060')

    expect(
      dialog.getByText(
        "The system moves no money. Return 5,000 RWF to Eric Mugisha from Bookly's MTN MoMo account first, then record it here. Only the extra goes back: the payment itself stands.",
      ),
    ).toBeInTheDocument()
  })

  it('asks for the reduced amount on a reduced full refund', async () => {
    api({ list: () => json({ refunds: [REDUCED] }) })
    renderAt()
    const dialog = await openRecord('BKY-2610-00061')

    expect(dialog.getByText(/^The system moves no money\. Refund 30,000 RWF to Eric Mugisha/)).toBeInTheDocument()
  })

  it('records an overpayment with its kind, says the amount sent, and drops the row', async () => {
    const { sent } = api({
      list: () => json({ refunds: [OVERPAID, MOMO] }),
      record: () => json({ refund: { ...RECORDED, paymentId: 'pa-over', status: 'succeeded', refundKind: 'overpayment', refundAmountRwf: 5_000, overpaidRwf: 5_000, amountRwf: 35_000 } }),
    })
    renderAt()
    const dialog = await openRecord('BKY-2610-00060')

    await recordWith(dialog, 'OVR-1')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts(sent)).toEqual([expect.objectContaining({ url: '/api/platform/refunds/pa-over', body: { reference: 'OVR-1', refundKind: 'overpayment' } })])
    expect(screen.getByRole('status')).toHaveTextContent('Refund of 5,000 RWF for BKY-2610-00060 recorded.')
    expect(document.querySelector('[data-payment="pa-over"]')).toBeNull()
    expect(row(MOMO.paymentId)).toBeInTheDocument()
  })

  it('words a 409 duplicate_refund_reference under the reference, and keeps the dialog and the row', async () => {
    api({ record: () => json({ error: 'duplicate_refund_reference' }, 409) })
    renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, 'RF-USED')

    await waitFor(() =>
      expect(fieldError(dialog, 'Refund reference')).toBe('That reference is already recorded for another online refund. Check it and try again.'),
    )
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument()
    expect(dialog.getByLabelText('Refund reference')).toHaveValue('RF-USED')
    expect(row(MOMO.paymentId)).toBeInTheDocument()
  })

  it('clears the duplicate once a new reference goes through', async () => {
    let calls = 0
    api({ record: () => (calls++ === 0 ? json({ error: 'duplicate_refund_reference' }, 409) : json({ refund: RECORDED })) })
    renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, 'RF-USED')
    await waitFor(() => expect(fieldError(dialog, 'Refund reference')).not.toBeNull())
    await user().clear(dialog.getByLabelText('Refund reference'))
    await recordWith(dialog, 'RF-NEW')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it.each([
    ['full', 'That refund changed since the list was loaded: the whole payment is now owed back, as a full refund. The list below is up to date.'],
    ['overpayment', 'That refund changed since the list was loaded: only the overpaid part is now owed back. The list below is up to date.'],
  ])('on a 409 refund_kind_mismatch now pending %s, reads the list again and says what is pending', async (pending, message) => {
    // The booking was cancelled meanwhile: the overpayment row is now a full refund of the rest.
    let reads = 0
    const changed = { ...OVERPAID, refundKind: 'full' as const, refundAmountRwf: 35_000 }
    const { sent } = api({
      list: () => json({ refunds: [reads++ === 0 ? OVERPAID : changed] }),
      record: () => json({ error: 'refund_kind_mismatch', pending }, 409),
    })
    renderAt()
    const dialog = await openRecord('BKY-2610-00060')

    await recordWith(dialog, 'OVR-1')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    await waitFor(() => expect(kindCell('pa-over')?.textContent).toBe('Full refund'))
    expect(toSendCell('pa-over')).toHaveTextContent('35,000 RWFof 35,000 RWF paid')
    expect(sent.filter((call) => call.method === 'GET')).toHaveLength(2)
  })

  it('words a refund_kind_mismatch that names no kind it knows, and still reads the list again', async () => {
    const { sent } = api({ record: () => json({ error: 'refund_kind_mismatch', pending: 'partial' }, 409) })
    renderAt()
    const dialog = await openRecord()

    await recordWith(dialog, 'RF-1')

    expect(await screen.findByRole('alert')).toHaveTextContent('That refund changed since the list was loaded. The list below is up to date.')
    await waitFor(() => expect(sent.filter((call) => call.method === 'GET')).toHaveLength(2))
  })

  it('keeps the rows on screen when that second read fails', async () => {
    let reads = 0
    api({
      list: () => (reads++ === 0 ? json({ refunds: [OVERPAID] }) : json({ error: 'internal_error' }, 500)),
      record: () => json({ error: 'refund_kind_mismatch', pending: 'full' }, 409),
    })
    renderAt()
    const dialog = await openRecord('BKY-2610-00060')

    await recordWith(dialog, 'OVR-1')

    expect(await screen.findByRole('alert')).toHaveTextContent('the whole payment is now owed back')
    await waitFor(() => expect(reads).toBe(2))
    expect(row('pa-over')).toBeInTheDocument()
  })
})
