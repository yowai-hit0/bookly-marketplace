import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { Checkout } from '@/catalogue/payments'
import { routes } from '@/routes'

/**
 * The pay page (plan.md Task 16; spec §3.1 steps 9-10, §6.19), rendered through
 * the real routes with `fetch` stubbed.
 *
 * What is proven: the page offers exactly the methods the API's capability
 * endpoint lists -- with MTN MoMo direct, Airtel Money and card are not in the
 * DOM at all, not disabled -- and all three when the API lists three, with a
 * phone field only for Mobile Money; no methods is an alert, not an empty form.
 * It shows the booking, the fee from the API, the hold and the non-refundable
 * notice. A number the page cannot read is marked and focused without a request;
 * a good one is sent as typed, once however often Pay is pressed, and a started
 * or already-waiting payment moves to its progress page, where nothing claims
 * success. A paid, expired or closed booking, an invalid link and a failed load
 * each have their own words; the API's refusals (rejected, unreachable, a field,
 * the network) are alerts the payer can recover from; and a booking that
 * changed under the page is reloaded.
 */

const REFERENCE = 'BKY-2610-7K3QX'
const TOKEN = 'aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJeLmNoPqRs'
const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'
const PATH = `/checkout/${REFERENCE}/${TOKEN}`
const CHECKOUT_API = `/api/checkout/${REFERENCE}/${TOKEN}`

const CHECKOUT: Checkout = {
  reference: REFERENCE,
  serviceName: 'Portraits',
  packageName: 'Standard',
  startsAt: '2026-10-07T07:30:00.000Z',
  endsAt: '2026-10-07T09:00:00.000Z',
  holdExpiresAt: '2026-10-01T06:30:00.000Z',
  bookingFeeRwf: 19_500,
  state: 'payable',
  waitingPayment: null,
}

const PENDING_PROGRESS = {
  payment: { status: 'pending', amountRwf: 19_500, failure: null },
  booking: { reference: REFERENCE, status: 'pending_payment', serviceName: 'Portraits', packageName: 'Standard', startsAt: CHECKOUT.startsAt, endsAt: CHECKOUT.endsAt },
}

type Reply = Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type Api = {
  checkout?: (call: number) => Reply
  methods?: () => Reply
  pay?: (body: unknown, call: number) => Reply
}

/** Answers the checkout, the methods, starting a payment and following one; records every call. */
function stubApi(api: Api = {}) {
  const calls: string[] = []
  const payBodies: unknown[] = []
  let checkoutCalls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      if (method === 'GET' && url === CHECKOUT_API) {
        checkoutCalls += 1
        return api.checkout ? api.checkout(checkoutCalls) : json({ checkout: CHECKOUT })
      }
      if (method === 'GET' && url === '/api/payment-methods') return api.methods ? api.methods() : json({ provider: 'mtn_momo_direct', methods: ['momo_mtn'] })
      if (method === 'POST' && url === `${CHECKOUT_API}/payments`) {
        payBodies.push(JSON.parse(String(init?.body)))
        return api.pay ? api.pay(payBodies.at(-1), payBodies.length) : json({ payment: { ourRef: OUR_REF, status: 'pending' } }, 201)
      }
      if (method === 'GET' && url.startsWith('/api/payments/')) return json(PENDING_PROGRESS)
      return json({ error: 'not_found' }, 404)
    }),
  )
  return { calls, payBodies }
}

function renderAt(path = PATH) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

async function renderLoaded(path = PATH) {
  const router = renderAt(path)
  await screen.findByRole('heading', { level: 1, name: 'Pay the booking fee' })
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

function payButton() {
  return screen.getByRole('button', { name: /^Pay / })
}

function phoneField() {
  return screen.getByRole('textbox', { name: 'Mobile Money number' })
}

function lines(): [string, string][] {
  return Array.from(document.querySelectorAll('dt')).map((term) => [term.textContent ?? '', term.nextElementSibling?.textContent ?? ''])
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// --- The page ---------------------------------------------------------------------------------

describe('the pay page', () => {
  it('shows loading, then the booking, the fee the API gave, the hold and the non-refundable notice', async () => {
    const { calls } = stubApi()
    renderAt()

    expect(screen.getByRole('status')).toHaveTextContent('Loading your booking…')
    await screen.findByRole('heading', { level: 1, name: 'Pay the booking fee' })

    expect(lines()).toEqual([
      ['Booking reference', REFERENCE],
      ['Service', 'Portraits, Standard'],
      ['When', 'Wednesday, 7 October 2026, 09:30 to 11:00, Kigali time'],
      ['Booking fee', '19,500 RWF'],
    ])
    expect(screen.getByText('We are holding this time for you until 08:30, Kigali time.')).toBeInTheDocument()
    expect(screen.getByText('The booking fee is non-refundable if you cancel.')).toBeInTheDocument()
    expect(payButton()).toHaveTextContent('Pay 19,500 RWF')
    expect(calls.sort()).toEqual([`GET ${CHECKOUT_API}`, 'GET /api/payment-methods'])
  })

  it('never says the booking is confirmed or paid before a payment has even started', async () => {
    stubApi()
    await renderLoaded()
    expect(screen.queryByText(/confirmed|payment received|already paid/i)).not.toBeInTheDocument()
  })

  it('omits the hold line when the API gives no expiry', async () => {
    stubApi({ checkout: () => json({ checkout: { ...CHECKOUT, holdExpiresAt: null } }) })
    await renderLoaded()
    expect(screen.queryByText(/We are holding this time/)).not.toBeInTheDocument()
  })
})

// --- Method gating -----------------------------------------------------------------------------

describe('the methods on offer (spec §6.19)', () => {
  it('with MTN MoMo direct, offers MTN MoMo alone: Airtel Money and card are absent from the DOM, not disabled', async () => {
    stubApi({ methods: () => json({ provider: 'mtn_momo_direct', methods: ['momo_mtn'] }) })
    await renderLoaded()

    const group = screen.getByRole('group', { name: 'How would you like to pay?' })
    expect(within(group).getAllByRole('radio')).toHaveLength(1)
    expect(within(group).getByRole('radio', { name: 'MTN MoMo' })).toBeChecked()

    expect(screen.queryByRole('radio', { name: 'Airtel Money' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Card' })).not.toBeInTheDocument()
    expect(screen.queryByText('Airtel Money')).not.toBeInTheDocument()
    expect(screen.queryByText('Card')).not.toBeInTheDocument()
    expect(document.querySelector('input[value="momo_airtel"]')).toBeNull()
    expect(document.querySelector('input[value="card"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/airtel|card/i)
    expect(document.body.innerHTML).not.toMatch(/momo_airtel|value="card"/)
    expect(document.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0)
  })

  it('reads the methods from the API rather than a list of its own', async () => {
    const { calls } = stubApi()
    await renderLoaded()
    expect(calls).toContain('GET /api/payment-methods')
  })

  it('offers all three, MTN MoMo first, when the API lists three', async () => {
    stubApi({ methods: () => json({ provider: 'flutterwave', methods: ['card', 'momo_airtel', 'momo_mtn'] }) })
    await renderLoaded()

    expect(screen.getAllByRole('radio').map((radio) => radio.closest('label')?.textContent)).toEqual(['MTN MoMo', 'Airtel Money', 'Card'])
    expect(screen.getByRole('radio', { name: 'MTN MoMo' })).toBeChecked()
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeEnabled()
  })

  it('asks for a number for Mobile Money and not for a card', async () => {
    stubApi({ methods: () => json({ methods: ['momo_mtn', 'momo_airtel', 'card'] }) })
    await renderLoaded()

    expect(phoneField()).toHaveAttribute('type', 'tel')
    expect(screen.getByText('We will send a payment request to this phone. Approve it with your Mobile Money PIN.')).toBeInTheDocument()

    await user().click(screen.getByRole('radio', { name: 'Airtel Money' }))
    expect(phoneField()).toBeInTheDocument()

    await user().click(screen.getByRole('radio', { name: 'Card' }))
    expect(screen.queryByRole('textbox', { name: 'Mobile Money number' })).not.toBeInTheDocument()
  })

  it('offers only the methods it can name when the API lists one it cannot', async () => {
    stubApi({ methods: () => json({ methods: ['paypal', 'momo_mtn'] }) })
    await renderLoaded()

    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect(document.body.innerHTML).not.toMatch(/paypal/i)
  })

  it.each([
    ['none', []],
    ['only methods it cannot name', ['paypal']],
  ])('says online payment is not available, with no form, when the API lists %s', async (_case, methods) => {
    stubApi({ methods: () => json({ methods }) })
    await renderLoaded()

    expect(screen.getByRole('alert')).toHaveTextContent('Online payment is not available right now. Please try again later.')
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument()
  })
})

// --- Paying -----------------------------------------------------------------------------------

describe('paying', () => {
  it.each(['', '   ', 'abc', '12345', '+250 78x 123 456'])('marks and focuses an unreadable number "%s" without a request', async (typed) => {
    const { payBodies } = stubApi()
    await renderLoaded()

    if (typed !== '') await user().type(phoneField(), typed)
    await user().click(payButton())

    expect(phoneField()).toHaveAttribute('aria-invalid', 'true')
    expect(phoneField()).toHaveFocus()
    expect(screen.getByText('Enter the phone number of your Mobile Money account.')).toBeInTheDocument()
    expect(phoneField().getAttribute('aria-describedby')).toContain(screen.getByText('Enter the phone number of your Mobile Money account.').id)
    expect(payBodies).toEqual([])
  })

  it('sends the method and the number, trimmed, and moves to the payment’s progress page', async () => {
    const { payBodies } = stubApi()
    const router = await renderLoaded()

    await user().type(phoneField(), '  078 812 3456 ')
    await user().click(payButton())

    expect(await screen.findByRole('heading', { level: 1, name: 'Approve the payment on your phone' })).toBeInTheDocument()
    expect(payBodies).toStrictEqual([{ method: 'momo_mtn', phone: '078 812 3456' }])
    expect(router.state.location.pathname).toBe(`${PATH}/payments/${OUR_REF}`)
    expect(screen.queryByText('Your booking is confirmed')).not.toBeInTheDocument()
  })

  it('clears the mark once the number is good', async () => {
    let answer: (res: Response) => void = () => {}
    stubApi({ pay: () => new Promise<Response>((resolve) => (answer = resolve)) })
    await renderLoaded()

    await user().click(payButton())
    expect(phoneField()).toHaveAttribute('aria-invalid', 'true')
    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    expect(phoneField()).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByText('Enter the phone number of your Mobile Money account.')).not.toBeInTheDocument()
    await act(async () => answer(json({ payment: { ourRef: OUR_REF } }, 201)))
  })

  it('says it is sending while it waits, and sends one request however often Pay is pressed', async () => {
    let answer: (res: Response) => void = () => {}
    const { payBodies } = stubApi({ pay: () => new Promise<Response>((resolve) => (answer = resolve)) })
    await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    const busy = screen.getByRole('button', { name: 'Sending the request…' })
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    await user().click(busy)
    await user().click(busy)
    expect(payBodies).toHaveLength(1)

    await act(async () => answer(json({ payment: { ourRef: OUR_REF } }, 201)))
    expect(await screen.findByRole('heading', { name: 'Approve the payment on your phone' })).toBeInTheDocument()
  })

  it('sends the method chosen', async () => {
    const { payBodies } = stubApi({ methods: () => json({ methods: ['momo_mtn', 'momo_airtel'] }) })
    await renderLoaded()

    await user().click(screen.getByRole('radio', { name: 'Airtel Money' }))
    await user().type(phoneField(), '0731234567')
    await user().click(payButton())

    await screen.findByRole('heading', { name: 'Approve the payment on your phone' })
    expect(payBodies).toStrictEqual([{ method: 'momo_airtel', phone: '0731234567' }])
  })

  it('follows the attempt already waiting when the API says one is in progress', async () => {
    const waiting = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
    stubApi({ pay: () => json({ error: 'payment_in_progress', payment: { ourRef: waiting } }, 409) })
    const router = await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    await screen.findByRole('heading', { name: 'Approve the payment on your phone' })
    expect(router.state.location.pathname).toBe(`${PATH}/payments/${waiting}`)
  })

  it.each([
    ['rejected', 'Mobile Money did not accept the request. Check that the number has a Mobile Money account, then try again.'],
    ['unavailable', 'We could not reach Mobile Money just now. Please try again in a moment.'],
  ])('shows an alert when the provider %s the request, keeps the form, and lets the payer try again', async (reason, words) => {
    const { payBodies } = stubApi({
      pay: (_body, call) =>
        call === 1
          ? json({ error: 'payment_not_started', reason, payment: { ourRef: OUR_REF, status: 'failed' } }, 502)
          : json({ payment: { ourRef: 'b1b1b1b1-0000-4000-8000-000000000002' } }, 201),
    })
    const router = await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(words)
    expect(router.state.location.pathname).toBe(PATH)
    expect(phoneField()).toHaveValue('0788123456')
    expect(payButton()).toHaveTextContent('Pay 19,500 RWF')

    await user().click(payButton())
    await screen.findByRole('heading', { name: 'Approve the payment on your phone' })
    expect(payBodies).toHaveLength(2)
  })

  it('shows the connection alert when the API cannot be reached, and clears it on the next try', async () => {
    let offline = true
    stubApi({ pay: () => (offline ? Promise.reject(new TypeError('Failed to fetch')) : new Promise<Response>(() => {})) })
    await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('The payment did not start. Check your connection and try again.')

    offline = false
    await user().click(payButton())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('marks the number when the API refuses it', async () => {
    stubApi({ pay: () => json({ error: 'validation_failed', fields: ['phone'] }, 422) })
    await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    expect(await screen.findByText('Enter the phone number of your Mobile Money account.')).toBeInTheDocument()
    expect(phoneField()).toHaveAttribute('aria-invalid', 'true')
    expect(phoneField()).toHaveFocus()
  })

  it('shows the failure alert when the API refuses the method', async () => {
    stubApi({ pay: () => json({ error: 'validation_failed', fields: ['method'] }, 422) })
    await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('The payment did not start.')
  })

  // Fails today: with card chosen the phone field is not rendered, but the page still sends
  // `phone: ''` -- which the API's schema refuses for every method -- and on a 422 naming `phone`
  // it only sets a mark on a field that does not exist. The payer sees nothing happen.
  it('tells a card payer something when the API refuses a field the page is not showing', async () => {
    stubApi({
      methods: () => json({ methods: ['momo_mtn', 'momo_airtel', 'card'] }),
      pay: () => json({ error: 'validation_failed', fields: ['phone'] }, 422),
    })
    await renderLoaded()

    await user().click(screen.getByRole('radio', { name: 'Card' }))
    await user().click(payButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('The payment did not start.')
  })

  it('reloads and shows the paid notice when the API says the fee is already paid', async () => {
    const { calls } = stubApi({
      checkout: (call) => json({ checkout: { ...CHECKOUT, state: call === 1 ? 'payable' : 'paid' } }),
      pay: () => json({ error: 'already_paid' }, 409),
    })
    await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    expect(await screen.findByRole('heading', { level: 1, name: 'This booking is already paid' })).toBeInTheDocument()
    expect(calls.filter((call) => call === `GET ${CHECKOUT_API}`)).toHaveLength(2)
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('reloads and shows the expired notice when the API says the hold ended', async () => {
    stubApi({
      checkout: (call) => json({ checkout: { ...CHECKOUT, state: call === 1 ? 'payable' : 'expired' } }),
      pay: () => json({ error: 'hold_expired' }, 409),
    })
    await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    expect(await screen.findByRole('heading', { level: 1, name: 'Your hold on this time has ended' })).toBeInTheDocument()
  })

  it('shows the invalid link notice when the API no longer knows the checkout', async () => {
    stubApi({ pay: () => json({ error: 'not_found' }, 404) })
    await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    expect(await screen.findByRole('heading', { level: 1, name: 'This payment link is not valid' })).toBeInTheDocument()
  })
})

// --- States -------------------------------------------------------------------------------------

describe('a booking that cannot be paid', () => {
  it.each([
    ['paid', 'This booking is already paid', 'Your confirmation email, with a link to your booking, is on its way.'],
    ['expired', 'Your hold on this time has ended', 'The time was released because the booking fee was not paid in time. You are welcome to book again.'],
    ['closed', 'This booking cannot be paid online', 'Please contact the photographer about this booking.'],
  ])('shows its %s notice, focused, with no methods and no Pay', async (state, title, body) => {
    stubApi({ checkout: () => json({ checkout: { ...CHECKOUT, state } }) })
    renderAt()

    const heading = await screen.findByRole('heading', { level: 1, name: title })
    // The heading is focused in an effect after it renders; under a loaded full run the
    // lookup can win that race, so wait for the focus (2026-09-27, flaky, not a behaviour change).
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByText(body)).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument()
  })

  it('links an expired hold back to the services to book again', async () => {
    stubApi({ checkout: () => json({ checkout: { ...CHECKOUT, state: 'expired' } }) })
    renderAt()

    expect(await screen.findByRole('link', { name: 'Choose a time' })).toHaveAttribute('href', '/services')
  })

  it('says the link is not valid when the API does not know it', async () => {
    stubApi({ checkout: () => json({ error: 'not_found' }, 404) })
    renderAt()

    expect(await screen.findByRole('heading', { level: 1, name: 'This payment link is not valid' })).toHaveFocus()
    expect(screen.getByText('Check that you opened the whole link. If your booking has ended, you are welcome to book again.')).toBeInTheDocument()
  })

  it('shows an alert when the load fails, and loads again on Try again', async () => {
    stubApi({ checkout: (call) => (call === 1 ? json({ error: 'internal_error' }, 500) : json({ checkout: CHECKOUT })) })
    renderAt()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('We could not load your booking. Check your connection and try again.')
    expect(screen.queryByRole('heading', { name: 'This payment link is not valid' })).not.toBeInTheDocument()

    await user().click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Pay the booking fee' })).toBeInTheDocument()
  })

  it('shows the load alert when the methods cannot be loaded', async () => {
    stubApi({ methods: () => Promise.reject(new TypeError('Failed to fetch')) })
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load your booking.')
  })
})

describe('a payment already waiting on the payer', () => {
  it('says so and links to its progress page, while still offering to pay', async () => {
    const waiting = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
    stubApi({ checkout: () => json({ checkout: { ...CHECKOUT, waitingPayment: { ourRef: waiting } } }) })
    await renderLoaded()

    expect(screen.getByText(/A payment request is already waiting on your phone\./)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Follow that payment' })).toHaveAttribute('href', `${PATH}/payments/${waiting}`)
    expect(payButton()).toBeInTheDocument()
  })
})

describe('the address', () => {
  it('fetches the checkout named by the path, encoded, so a reload lands back on the same page', async () => {
    const { calls } = stubApi()
    renderAt()
    await screen.findByRole('heading', { level: 1, name: 'Pay the booking fee' })

    expect(calls).toContain(`GET ${CHECKOUT_API}`)
  })

  it('has nothing below a payment page -- a deeper path is not found', () => {
    stubApi()
    renderAt(`${PATH}/payments/${OUR_REF}/extra`)
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })
})
