import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { forgetAccountMe } from '@/auth/account'
import { saveSession } from '@/auth/session'
import { FLUTTERWAVE_INLINE_SRC, resetFlutterwaveInlineForTests } from '@/lib/flutterwave-inline'
import { routes } from '@/routes'
import { cardConfig, fakeFlutterwave, removeFakeFlutterwave } from '@/test/card-fixtures'
import { CHECKOUT_PATH, CLIENT_BOOKING, OUR_REF, REFERENCE, SESSION, USER, detail } from '@/test/account-fixtures'
import { type Sent, json, stubApi } from '@/test/fetch'

/**
 * `/account/bookings/:reference` (marketplace-spec R8.1, T8.1, T8.2): the
 * guest page's parts under the session. What is proven: the booking renders
 * as the guest page renders it; the photographer is named, with the contact
 * channels they set and their profile; the session fee is paid through the
 * account's own endpoint and followed on the account's progress page, which
 * leads back; cancelling states the booking's own terms -- the fee kept or
 * refunded, both branches -- before anything is sent; a refusal is said; a
 * reference that is not the account's is "not found", naming nothing; a live
 * hold offers its checkout. Nothing on the page carries an access token.
 */

const API = `/api/account/bookings/${REFERENCE}`
const PATH = `/account/bookings/${REFERENCE}`

type Answers = {
  booking?: (sent: Sent) => Response
  cancel?: (sent: Sent) => Response
  pay?: (sent: Sent) => Response
  /** The methods on offer; MTN MoMo alone unless a test says otherwise. */
  methods?: string[]
}

function api(answers: Answers = {}) {
  return stubApi((sent) => {
    if (sent.url === '/api/account/me') return json({ user: USER })
    if (sent.url === '/api/payment-methods') return json({ methods: answers.methods ?? ['momo_mtn'] })
    if (sent.method === 'GET' && sent.url === API) return answers.booking?.(sent) ?? json(detail())
    if (sent.method === 'POST' && sent.url === `${API}/cancel`) {
      return answers.cancel?.(sent) ?? json(detail({ status: 'cancelled_by_client', stage: 'cancelled_by_client', canCancel: false, cancelledAt: '2026-10-01T06:00:00.000Z', sessionFee: null }))
    }
    if (sent.method === 'POST' && sent.url === `${API}/payments`) return answers.pay?.(sent) ?? json({ payment: { ourRef: OUR_REF, status: 'pending' } }, 201)
    // With or without a card try's `?transactionId=`.
    if (sent.url === `/api/payments/${OUR_REF}` || sent.url.startsWith(`/api/payments/${OUR_REF}?`)) {
      return json({
        payment: { status: 'pending', amountRwf: 30_000, failure: null },
        booking: { reference: REFERENCE, status: 'confirmed', serviceName: 'Portraits', packageName: 'Standard', startsAt: CLIENT_BOOKING.startsAt, endsAt: CLIENT_BOOKING.endsAt },
      })
    }
    return undefined
  })
}

function renderAt(path = PATH) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

async function loaded(path = PATH) {
  const router = renderAt(path)
  const main = within(screen.getByRole('main'))
  await main.findByRole('heading', { level: 1, name: 'Your booking' })
  return { router, main }
}

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  forgetAccountMe()
})

describe('one booking in the dashboard', () => {
  it('renders the booking with the guest page’s parts, behind a back link, with the account token', async () => {
    saveSession('account', SESSION)
    const stub = api()
    const { main } = await loaded()

    expect(main.getAllByRole('link')[0]).toHaveAccessibleName('All bookings')
    expect(main.getByRole('link', { name: 'All bookings' })).toHaveAttribute('href', '/account')
    expect(main.getByText(REFERENCE)).toBeInTheDocument()
    expect(main.getByText('Portraits, Standard')).toBeInTheDocument()
    expect(main.getByText('Wednesday, 7 October 2026, 09:30 to 11:00, Kigali time')).toBeInTheDocument()
    expect(main.getByText('Kigali Heights, KG 7 Ave')).toBeInTheDocument()
    expect(main.getByText('Confirmed')).toBeInTheDocument()
    expect(main.getByRole('button', { name: 'Pay 30,000 RWF' })).toBeInTheDocument()
    // The contact email belongs to the guest page alone.
    expect(main.queryByRole('heading', { name: 'Your email' })).toBeNull()
    expect(stub.sent.find((call) => call.url === API)?.headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
    // The Bookings section stays current in the account nav.
    expect(within(screen.getByRole('navigation', { name: 'Your account' })).getByRole('link', { name: 'Bookings' })).toHaveAttribute('aria-current', 'page')
  })

  it('names the photographer, with only the channels they set, and their profile', async () => {
    saveSession('account', SESSION)
    api()
    const { main } = await loaded()

    const panel = within(main.getByRole('heading', { level: 2, name: 'Your photographer' }).closest('section')!)
    expect(panel.getByText('Kigali Lens')).toBeInTheDocument()
    expect(panel.getByRole('link', { name: '+250788000111' })).toHaveAttribute('href', 'tel:+250788000111')
    const whatsapp = panel.getByRole('link', { name: '+250788000222' })
    expect(whatsapp).toHaveAttribute('href', 'https://wa.me/250788000222')
    expect(whatsapp).toHaveAttribute('rel', 'noopener noreferrer')
    expect(whatsapp).toHaveAttribute('target', '_blank')
    expect(panel.getByRole('link', { name: 'hello@kigalilens.rw' })).toHaveAttribute('href', 'mailto:hello@kigalilens.rw')
    expect(panel.getByRole('link', { name: 'See their profile' })).toHaveAttribute('href', '/p/kigali-lens')
  })

  it('a photographer with no contact details says so, and still links the profile', async () => {
    saveSession('account', SESSION)
    api({ booking: () => json({ ...detail(), photographer: { handle: 'kigali-lens', displayName: 'Kigali Lens', contactPhone: null, whatsappPhone: null, email: null } }) })
    const { main } = await loaded()

    expect(main.getByText('They have not shared contact details on Bookly yet. Their profile has their services and terms.')).toBeInTheDocument()
    expect(main.queryByRole('link', { name: /^\+250/ })).toBeNull()
    expect(main.getByRole('link', { name: 'See their profile' })).toBeInTheDocument()
  })

  it('pays the session fee through the account’s endpoint and follows it on the account’s progress page', async () => {
    saveSession('account', SESSION)
    const stub = api()
    const { router, main } = await loaded()
    const user = userEvent.setup({ delay: null })

    await user.type(main.getByRole('textbox', { name: 'Mobile Money number' }), '078 812 3456')
    await user.click(main.getByRole('button', { name: 'Pay 30,000 RWF' }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`${PATH}/payments/${OUR_REF}`))
    // The progress page brings its own <main>: wait for it, then read inside it,
    // rather than holding the booking page's, which the move replaces.
    expect(await screen.findByRole('heading', { level: 1, name: 'Approve the payment on your phone' })).toBeInTheDocument()
    const progress = within(screen.getByRole('main'))
    expect(progress.getByRole('heading', { level: 1, name: 'Approve the payment on your phone' })).toBeInTheDocument()
    expect(progress.getByRole('link', { name: 'Back to your booking' })).toHaveAttribute('href', PATH)
    expect(stub.sent.filter((call) => call.method === 'POST').map((call) => [call.url, call.body])).toEqual([
      [`${API}/payments`, { method: 'momo_mtn', phone: '078 812 3456' }],
    ])
  })

  it('an attempt already waiting is followed instead of a new one', async () => {
    saveSession('account', SESSION)
    api({ pay: () => json({ error: 'payment_in_progress', payment: { ourRef: OUR_REF, method: 'momo_mtn' } }, 409) })
    const { router, main } = await loaded()
    const user = userEvent.setup({ delay: null })
    await user.type(main.getByRole('textbox', { name: 'Mobile Money number' }), '0788123456')
    await user.click(main.getByRole('button', { name: 'Pay 30,000 RWF' }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`${PATH}/payments/${OUR_REF}`))
  })

  it('a provider refusal is said in the checkout’s words, and the page stays', async () => {
    saveSession('account', SESSION)
    api({ pay: () => json({ error: 'payment_not_started', reason: 'unavailable', payment: { ourRef: OUR_REF, status: 'failed' } }, 502) })
    const { router, main } = await loaded()
    const user = userEvent.setup({ delay: null })
    await user.type(main.getByRole('textbox', { name: 'Mobile Money number' }), '0788123456')
    await user.click(main.getByRole('button', { name: 'Pay 30,000 RWF' }))

    expect(await main.findByRole('alert')).toHaveTextContent('We could not reach Mobile Money just now. Please try again in a moment.')
    expect(router.state.location.pathname).toBe(PATH)
  })

  it('cancelling under a policy that keeps the fee warns first, then cancels through the account’s endpoint', async () => {
    saveSession('account', SESSION)
    const stub = api()
    const { main } = await loaded()
    const user = userEvent.setup({ delay: null })

    await user.click(main.getByRole('button', { name: 'Cancel this booking' }))
    expect(main.getByText('If you cancel, your booking fee of 20,000 RWF is not refunded, and the time is released for someone else to book.')).toBeInTheDocument()
    expect(stub.sent.some((call) => call.method === 'POST')).toBe(false)

    await user.click(main.getByRole('button', { name: 'Yes, cancel my booking' }))
    expect(await main.findByRole('heading', { level: 2, name: 'This booking is cancelled' })).toBeInTheDocument()
    expect(main.getByText('Cancelled by you')).toBeInTheDocument()
    expect(stub.sent.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([`${API}/cancel`])
  })

  it('cancelling under a policy that refunds the fee says it is refunded', async () => {
    saveSession('account', SESSION)
    api({ booking: () => json(detail({ cancellation: { ...CLIENT_BOOKING.cancellation, bookingFeeRefundable: true } })) })
    const { main } = await loaded()

    await userEvent.setup({ delay: null }).click(main.getByRole('button', { name: 'Cancel this booking' }))
    expect(main.getByText('If you cancel, your booking fee of 20,000 RWF is refunded to you, and the time is released for someone else to book.')).toBeInTheDocument()
  })

  it('a refusal (past the cut-off under the page) is said, with the booking as it now stands', async () => {
    saveSession('account', SESSION)
    api({ cancel: () => json({ error: 'not_cancellable', ...detail({ canCancel: false, cancellation: { deadline: null, bookingFeeRefundable: false } }) }, 409) })
    const { main } = await loaded()
    const user = userEvent.setup({ delay: null })
    await user.click(main.getByRole('button', { name: 'Cancel this booking' }))
    await user.click(main.getByRole('button', { name: 'Yes, cancel my booking' }))

    expect(await main.findByRole('alert')).toHaveTextContent('This booking can no longer be cancelled.')
    expect(main.queryByRole('button', { name: 'Cancel this booking' })).toBeNull()
  })

  it('a reference that is not the account’s is not found, naming nothing', async () => {
    saveSession('account', SESSION)
    api({ booking: () => json({ error: 'not_found' }, 404) })
    renderAt('/account/bookings/BKY-2612-OTHER')

    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('heading', { level: 1, name: 'Booking not found' })).toBeInTheDocument()
    expect(main.queryByText(/RWF|Portraits|Kigali Lens/)).toBeNull()
    expect(main.queryByRole('button')).toBeNull()
    expect(main.getByRole('link', { name: 'All bookings' })).toHaveAttribute('href', '/account')
  })

  it('a booking cancelled elsewhere since the page loaded turns into not found when the API says 404', async () => {
    saveSession('account', SESSION)
    api({ cancel: () => json({ error: 'not_found' }, 404) })
    const { main } = await loaded()
    const user = userEvent.setup({ delay: null })
    await user.click(main.getByRole('button', { name: 'Cancel this booking' }))
    await user.click(main.getByRole('button', { name: 'Yes, cancel my booking' }))

    expect(await main.findByRole('heading', { level: 1, name: 'Booking not found' })).toBeInTheDocument()
  })

  it('a live hold says it is not confirmed and offers its checkout', async () => {
    saveSession('account', SESSION)
    api({
      booking: () =>
        json(
          detail(
            { status: 'pending_payment', stage: 'awaiting_payment', canCancel: false, sessionFee: null },
            { checkoutPath: CHECKOUT_PATH, holdExpiresAt: '2026-11-02T08:30:00.000Z' },
          ),
        ),
    })
    const { main } = await loaded()

    expect(main.getByRole('heading', { level: 2, name: 'Not confirmed yet' })).toBeInTheDocument()
    expect(main.getByRole('link', { name: /Finish payment/ })).toHaveAttribute('href', CHECKOUT_PATH)
    // Until when, in Kigali time (UTC+2).
    expect(main.getByText(/^The hold ends .*10:30/)).toBeInTheDocument()
  })

  it('a live hold without its end time still offers its checkout, naming no time', async () => {
    saveSession('account', SESSION)
    api({
      booking: () =>
        json(detail({ status: 'pending_payment', stage: 'awaiting_payment', canCancel: false, sessionFee: null }, { checkoutPath: CHECKOUT_PATH })),
    })
    const { main } = await loaded()

    expect(main.getByRole('link', { name: /Finish payment/ })).toHaveAttribute('href', CHECKOUT_PATH)
    expect(main.queryByText(/^The hold ends/)).not.toBeInTheDocument()
  })

  it('a failed load offers Try again', async () => {
    saveSession('account', SESSION)
    let fail = true
    api({ booking: () => (fail ? json({ error: 'internal_error' }, 500) : json(detail())) })
    renderAt()

    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('alert')).toHaveTextContent('We could not load your booking.')
    fail = false
    await userEvent.setup({ delay: null }).click(main.getByRole('button', { name: 'Try again' }))
    expect(await main.findByRole('heading', { level: 1, name: 'Your booking' })).toBeInTheDocument()
  })

  it('a signed-out visitor is sent to sign in, carrying the booking as the return path', () => {
    stubApi(() => json({ google: false }))
    const router = renderAt()
    expect(router.state.location.pathname).toBe('/account/login')
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(PATH)
  })
})

// --- The session fee by card (Flutterwave v3 Inline, "Cards as built") ----------------------------

describe('paying the session fee by card from the account', () => {
  const CARD = cardConfig(OUR_REF, { amount: 30_000, redirect_url: `https://bookly.example/account/bookings/${REFERENCE}/payments/${OUR_REF}` })

  beforeEach(() => {
    resetFlutterwaveInlineForTests()
  })

  afterEach(() => {
    removeFakeFlutterwave()
    for (const script of document.querySelectorAll(`script[src="${FLUTTERWAVE_INLINE_SRC}"]`)) script.remove()
  })

  it('opens the modal with the config unchanged and, on its callback, follows the payment on the account progress page', async () => {
    saveSession('account', SESSION)
    const flutterwave = fakeFlutterwave()
    const stub = api({ methods: ['momo_mtn', 'card'], pay: () => json({ payment: { ourRef: OUR_REF, status: 'pending' }, card: CARD }, 201) })
    const { router, main } = await loaded()
    const user = userEvent.setup({ delay: null })

    await user.click(main.getByRole('radio', { name: 'Card' }))
    expect(main.queryByRole('textbox', { name: 'Mobile Money number' })).toBeNull()
    await user.click(main.getByRole('button', { name: 'Pay 30,000 RWF' }))

    await waitFor(() => expect(flutterwave.opened).toHaveLength(1))
    expect(flutterwave.opened[0]?.config).toStrictEqual(CARD)
    expect(stub.sent.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual([{ method: 'card' }])
    // No access token on the account page: nothing kept but the card mark.
    expect(Object.keys(sessionStorage).filter((key) => key.startsWith('bookly.cardBookingToken.'))).toEqual([])

    act(() => {
      flutterwave.pay(31)
    })
    await waitFor(() => expect(router.state.location.pathname).toBe(`${PATH}/payments/${OUR_REF}`))
    expect(await screen.findByRole('heading', { level: 1, name: 'Confirming your card payment' })).toBeInTheDocument()
    const progress = within(screen.getByRole('main'))
    expect(progress.getByRole('link', { name: 'Back to payment' })).toHaveAttribute('href', PATH)
    expect(progress.getByRole('link', { name: 'Back to your booking' })).toHaveAttribute('href', PATH)
    expect(stub.sent.map((call) => call.url)).toContain(`/api/payments/${OUR_REF}?transactionId=31`)
  })

  it('marks a waiting payment as a card, for its progress page, when the 409 names a card', async () => {
    saveSession('account', SESSION)
    api({ methods: ['momo_mtn', 'card'], pay: () => json({ error: 'payment_in_progress', payment: { ourRef: OUR_REF, method: 'card' } }, 409) })
    const { router, main } = await loaded()
    const user = userEvent.setup({ delay: null })

    await user.type(main.getByRole('textbox', { name: 'Mobile Money number' }), '0788123456')
    await user.click(main.getByRole('button', { name: 'Pay 30,000 RWF' }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`${PATH}/payments/${OUR_REF}`))
    expect(sessionStorage.getItem(`bookly.cardPayment.${OUR_REF}`)).toBe('1')
    expect(Object.keys(sessionStorage).filter((key) => key.startsWith('bookly.cardBookingToken.'))).toEqual([])
  })

  it('on onclose stays on the booking and says nothing was charged', async () => {
    saveSession('account', SESSION)
    const flutterwave = fakeFlutterwave()
    api({ methods: ['momo_mtn', 'card'], pay: () => json({ payment: { ourRef: OUR_REF, status: 'pending' }, card: CARD }, 200) })
    const { router, main } = await loaded()
    const user = userEvent.setup({ delay: null })

    await user.click(main.getByRole('radio', { name: 'Card' }))
    await user.click(main.getByRole('button', { name: 'Pay 30,000 RWF' }))
    await waitFor(() => expect(flutterwave.opened).toHaveLength(1))
    act(() => {
      flutterwave.dismiss()
    })

    expect(await main.findByRole('status')).toHaveTextContent('The card window was closed.')
    expect(router.state.location.pathname).toBe(PATH)
  })
})
