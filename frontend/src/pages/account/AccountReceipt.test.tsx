import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { printer } from '@/account/dashboard'
import { forgetAccountMe } from '@/auth/account'
import { saveSession } from '@/auth/session'
import { routes } from '@/routes'
import { OUR_REF, RECEIPT, REFERENCE, SESSION, USER } from '@/test/account-fixtures'
import { json, stubApi } from '@/test/fetch'

/**
 * `/account/payments/:ourRef/receipt` (marketplace-spec R8.2, T8.1): the
 * printable receipt, its Print button, refunds shown, and the two ways a
 * receipt is not there (the account's own payment that took no money, and a
 * payment that is not the account's).
 */

const PATH = `/account/payments/${OUR_REF}/receipt`

function api(reply: () => Response) {
  return stubApi((sent) =>
    sent.url === '/api/account/me' ? json({ user: USER }) : sent.url === `/api/account/payments/${OUR_REF}` ? reply() : undefined,
  )
}

function renderAt(path = PATH) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  forgetAccountMe()
})

describe('the receipt', () => {
  it('shows who paid whom, for what, how and when, every line as the API priced it, and the amount paid', async () => {
    saveSession('account', SESSION)
    const stub = api(() => json({ receipt: RECEIPT }))
    renderAt()

    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('heading', { level: 1, name: 'Payment receipt' })).toBeInTheDocument()
    const receipt = within(document.querySelector('[data-receipt]') as HTMLElement)
    expect(receipt.getByText(OUR_REF)).toBeInTheDocument()
    expect(receipt.getByText('Aline Uwase')).toBeInTheDocument()
    expect(receipt.getByText('Kigali Lens')).toBeInTheDocument()
    expect(receipt.getByText(REFERENCE)).toBeInTheDocument()
    expect(receipt.getByText('Portraits, Standard')).toBeInTheDocument()
    expect(receipt.getByText('Wednesday, 7 October 2026, 09:30 to 11:00, Kigali time')).toBeInTheDocument()
    expect(receipt.getByText('Booking fee')).toBeInTheDocument()
    expect(receipt.getByText('MTN MoMo')).toBeInTheDocument()
    expect(receipt.getByText('1 Oct 2026, 08:05')).toBeInTheDocument()

    const lines = within(receipt.getByRole('table'))
      .getAllByRole('row')
      .map((row) => row.textContent)
    expect(lines).toEqual([
      'Standard40,000 RWF',
      'Extra hour10,000 RWF',
      'Prints × 3Added after the shoot6,000 RWF',
      'Of which the booking fee, paid when booking20,000 RWF',
    ])
    expect(receipt.getByText('Amount paid')).toBeInTheDocument()
    expect(receipt.getAllByText('20,000 RWF')).toHaveLength(2)
    expect(receipt.queryByRole('heading', { name: 'Refund' })).toBeNull()
    expect(stub.sent.find((call) => call.url.includes(OUR_REF))?.headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
  })

  it('Print opens the browser’s print dialog; the controls are marked to stay off the paper', async () => {
    saveSession('account', SESSION)
    api(() => json({ receipt: RECEIPT }))
    const print = vi.spyOn(printer, 'print').mockImplementation(() => {})
    renderAt()

    const main = within(screen.getByRole('main'))
    const button = await main.findByRole('button', { name: 'Print' })
    expect(button).toHaveClass('print:hidden')
    expect(main.getByRole('link', { name: 'All payments' })).toHaveClass('print:hidden')
    expect(screen.getByRole('navigation', { name: 'Your account' })).toHaveAttribute('data-account-nav')
    await userEvent.setup({ delay: null }).click(button)
    expect(print).toHaveBeenCalledTimes(1)
  })

  it('a refunded payment’s receipt says so, with the transfer reference', async () => {
    saveSession('account', SESSION)
    api(() =>
      json({
        receipt: {
          ...RECEIPT,
          status: 'refunded',
          refund: { state: 'refunded', amountRwf: 20_000, refundedAt: '2026-10-03T09:00:00.000Z', reference: 'MOMO-TX-778' },
        },
      }),
    )
    renderAt()

    const receipt = await screen.findByRole('heading', { level: 2, name: 'Refund' })
    expect(receipt).toBeInTheDocument()
    expect(screen.getByText('Refunded')).toBeInTheDocument()
    expect(screen.getByText('20,000 RWF was refunded on Saturday, 3 October 2026.')).toBeInTheDocument()
    expect(screen.getByText('Transfer reference: MOMO-TX-778')).toBeInTheDocument()
  })

  it('a refund due and an overpayment are both shown', async () => {
    saveSession('account', SESSION)
    api(() =>
      json({
        receipt: {
          ...RECEIPT,
          status: 'refund_due',
          refund: { state: 'due', amountRwf: 20_000 },
          overpayment: { amountRwf: 1_000, refundedAt: '2026-10-04T09:00:00.000Z', reference: 'TX-9' },
        },
      }),
    )
    renderAt()

    expect(await screen.findByText('20,000 RWF is owed back to you.')).toBeInTheDocument()
    expect(screen.getByText('1,000 RWF more than was asked was paid, and was refunded on Sunday, 4 October 2026.')).toBeInTheDocument()
    expect(screen.getByText('Transfer reference: TX-9')).toBeInTheDocument()
  })

  it('the account’s own pending payment has no receipt yet, and says why', async () => {
    saveSession('account', SESSION)
    api(() => json({ error: 'no_receipt', payment: { status: 'pending' } }, 409))
    renderAt()

    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('heading', { level: 1, name: 'No receipt for this payment' })).toBeInTheDocument()
    expect(main.getByText('This payment is still waiting for approval. Its receipt appears here once the money arrives.')).toBeInTheDocument()
    expect(main.queryByRole('button', { name: 'Print' })).toBeNull()
  })

  it('a failed payment has no receipt because no money was taken', async () => {
    saveSession('account', SESSION)
    api(() => json({ error: 'no_receipt', payment: { status: 'failed' } }, 409))
    renderAt()
    expect(await screen.findByText('This payment did not go through, so no money was taken and there is no receipt.')).toBeInTheDocument()
  })

  it('a payment that is not the account’s is not found, naming nothing', async () => {
    saveSession('account', SESSION)
    api(() => json({ error: 'not_found' }, 404))
    renderAt()

    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('heading', { level: 1, name: 'Receipt not found' })).toBeInTheDocument()
    expect(main.queryByText(/RWF/)).toBeNull()
    expect(main.queryByRole('button')).toBeNull()
  })

  it('a failed load offers Try again', async () => {
    saveSession('account', SESSION)
    let fail = true
    api(() => (fail ? json({ error: 'internal_error' }, 500) : json({ receipt: RECEIPT })))
    renderAt()
    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('alert')).toHaveTextContent('Could not load the receipt.')
    fail = false
    await userEvent.setup({ delay: null }).click(main.getByRole('button', { name: 'Try again' }))
    expect(await main.findByRole('heading', { level: 1, name: 'Payment receipt' })).toBeInTheDocument()
  })
})
