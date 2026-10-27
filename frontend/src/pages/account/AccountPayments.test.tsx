import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { forgetAccountMe } from '@/auth/account'
import { saveSession } from '@/auth/session'
import { routes } from '@/routes'
import { LIGHT, OTHER_REFERENCE, OUR_REF, PAYMENT, REFERENCE, SESSION, USER, paymentsPage } from '@/test/account-fixtures'
import { type Sent, json, stubApi } from '@/test/fetch'

/**
 * `/account/payments` (marketplace-spec R8.2): each payment's kind, method,
 * amount, status, reference and date, the booking it was for, any refund or
 * overpayment in words, and a receipt link only for a payment that took money.
 */

function api(answer: (sent: Sent) => Response | undefined) {
  return stubApi((sent) => (sent.url === '/api/account/me' ? json({ user: USER }) : answer(sent)))
}
const payments = (sent: Sent) => sent.url.startsWith('/api/account/payments')

function renderAt(path = '/account/payments') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

async function rows() {
  const main = within(screen.getByRole('main'))
  return within(await main.findByRole('list', { name: 'Payments' })).getAllByRole('listitem').map((item) => within(item))
}

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  forgetAccountMe()
})

describe('the payments page', () => {
  it('lists each payment with what it was for, how much, how, when and where it stands', async () => {
    saveSession('account', SESSION)
    const stub = api((sent) => (payments(sent) ? json(paymentsPage([PAYMENT])) : undefined))
    renderAt()

    expect(await within(screen.getByRole('main')).findByRole('heading', { level: 1, name: 'Payments' })).toBeInTheDocument()
    const [row] = await rows()
    expect(row!.getByRole('heading', { level: 2, name: 'Booking fee' })).toBeInTheDocument()
    expect(row!.getByText('20,000 RWF')).toBeInTheDocument()
    expect(row!.getByText('Paid')).toBeInTheDocument()
    expect(row!.getByText('MTN MoMo')).toBeInTheDocument()
    expect(row!.getByText('1 Oct 2026, 08:05')).toBeInTheDocument()
    expect(row!.getByText(OUR_REF)).toBeInTheDocument()
    expect(row!.getByText(REFERENCE)).toBeInTheDocument()
    expect(row!.getByRole('link', { name: 'Portraits, Standard' })).toHaveAttribute('href', `/account/bookings/${REFERENCE}`)
    expect(row!.getByRole('link', { name: 'Kigali Lens' })).toHaveAttribute('href', '/p/kigali-lens')
    expect(row!.getByRole('link', { name: /View receipt/ })).toHaveAttribute('href', `/account/payments/${OUR_REF}/receipt`)
    expect(stub.sent.find(payments)?.headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
    expect(within(screen.getByRole('navigation', { name: 'Your account' })).getByRole('link', { name: 'Payments' })).toHaveAttribute('aria-current', 'page')
  })

  it('a failed payment says why and has no receipt; a pending one waits and has none either', async () => {
    saveSession('account', SESSION)
    api((sent) =>
      payments(sent)
        ? json(
            paymentsPage([
              { ...PAYMENT, ourRef: 'p-failed', status: 'failed', failure: 'declined', settledAt: null, hasReceipt: false },
              { ...PAYMENT, ourRef: 'p-pending', kind: 'session_fee', status: 'pending', settledAt: null, hasReceipt: false, method: 'momo_airtel' },
            ]),
          )
        : undefined,
    )
    renderAt()

    const [failed, pending] = await rows()
    expect(failed!.getByText('Did not go through')).toBeInTheDocument()
    expect(failed!.getByText('It was declined on the phone, or not approved in time.')).toBeInTheDocument()
    expect(failed!.queryByRole('link', { name: /View receipt/ })).toBeNull()
    expect(pending!.getByText('Waiting for approval')).toBeInTheDocument()
    expect(pending!.getByText('Session fee')).toBeInTheDocument()
    expect(pending!.getByText('Airtel Money')).toBeInTheDocument()
    expect(pending!.queryByRole('link', { name: /View receipt/ })).toBeNull()
  })

  it('shows refunds owed and made, with the transfer reference, and an overpayment', async () => {
    saveSession('account', SESSION)
    api((sent) =>
      payments(sent)
        ? json(
            paymentsPage([
              { ...PAYMENT, ourRef: 'p-due', status: 'refund_due', refund: { state: 'due', amountRwf: 20_000 } },
              {
                ...PAYMENT,
                ourRef: 'p-refunded',
                status: 'refunded',
                refund: { state: 'refunded', amountRwf: 20_000, refundedAt: '2026-10-03T09:00:00.000Z', reference: 'MOMO-TX-778' },
              },
              {
                ...PAYMENT,
                ourRef: 'p-over',
                amountRwf: 25_000,
                overpayment: { amountRwf: 5_000, refundedAt: null, reference: null },
                booking: { ...PAYMENT.booking, reference: OTHER_REFERENCE, photographer: LIGHT },
              },
            ]),
          )
        : undefined,
    )
    renderAt()

    const [due, refunded, over] = await rows()
    expect(due!.getByText('Refund due')).toBeInTheDocument()
    expect(due!.getByText('20,000 RWF is owed back to you.')).toBeInTheDocument()
    expect(refunded!.getByText('Refunded')).toBeInTheDocument()
    expect(refunded!.getByText('20,000 RWF was refunded on Saturday, 3 October 2026.')).toBeInTheDocument()
    expect(refunded!.getByText('Transfer reference: MOMO-TX-778')).toBeInTheDocument()
    expect(over!.getByText('5,000 RWF more than was asked was paid. It is being sent back to you.')).toBeInTheDocument()
    expect(over!.getByRole('link', { name: 'Light House Studio' })).toBeInTheDocument()
  })

  it('cash recorded by the photographer is named; no method recorded shows no method', async () => {
    saveSession('account', SESSION)
    api((sent) =>
      payments(sent) ? json(paymentsPage([{ ...PAYMENT, method: 'cash' }, { ...PAYMENT, ourRef: 'p-none', method: null }])) : undefined,
    )
    renderAt()
    const [cash, none] = await rows()
    expect(cash!.getByText('Paid to the photographer')).toBeInTheDocument()
    expect(none!.queryByText('Method')).toBeNull()
  })

  it('pages with links, the page in the URL', async () => {
    saveSession('account', SESSION)
    const stub = api((sent) => (payments(sent) ? json(paymentsPage([PAYMENT], { page: 2, pageCount: 2, total: 21 })) : undefined))
    renderAt('/account/payments?page=2')

    const pager = within(await within(screen.getByRole('main')).findByRole('navigation', { name: 'Pages' }))
    expect(pager.getByRole('link', { name: 'Previous page' })).toHaveAttribute('href', '/account/payments')
    expect(pager.queryByRole('link', { name: 'Next page' })).toBeNull()
    expect(stub.sent.find(payments)?.url).toBe('/api/account/payments?page=2')
  })

  it('no payments: says so', async () => {
    saveSession('account', SESSION)
    api((sent) => (payments(sent) ? json(paymentsPage([])) : undefined))
    renderAt()
    expect(await within(screen.getByRole('main')).findByRole('heading', { level: 2, name: 'No payments yet' })).toBeInTheDocument()
  })

  it('a failed load says so, and Try again asks again', async () => {
    saveSession('account', SESSION)
    let fail = true
    api((sent) => (payments(sent) ? (fail ? json({ error: 'internal_error' }, 500) : json(paymentsPage([PAYMENT]))) : undefined))
    renderAt()
    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('alert')).toHaveTextContent('Could not load your payments.')
    fail = false
    await userEvent.setup({ delay: null }).click(main.getByRole('button', { name: 'Try again' }))
    expect(await rows()).toHaveLength(1)
  })
})
