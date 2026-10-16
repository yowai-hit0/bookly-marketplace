import { act, fireEvent, render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { PaymentProgress } from '@/catalogue/payments'
import { routes } from '@/routes'
import { POLL_GIVE_UP_MS, POLL_INTERVAL_MS } from './PaymentProgressPage'

/**
 * The confirmation page (plan.md Task 16; spec §3.1 step 10), rendered through
 * the real routes with `fetch` stubbed and the clock faked.
 *
 * What is proven: while the API says the payment is initiated or pending -- the
 * webhook held back -- the page stays pending however long it polls, and never
 * says the booking is confirmed; it says Mobile Money can take a minute and that
 * the confirmation email comes even if the page is closed. It says "confirmed"
 * only once the API reports the payment succeeded AND the booking no longer
 * waiting, and stops polling then, as on every settled answer: declined or
 * unreachable (with Try again back to the checkout), refunded because the slot
 * went, or a second payment owed back. It polls every 3 seconds, gives up after
 * 10 minutes with "Check again", which resumes; weathers network failures and
 * says so after three in a row; treats a 404 as an invalid link; stops when it is
 * left; and never shows one payment's answer for another.
 */

const REFERENCE = 'BKY-2610-7K3QX'
const TOKEN = 'aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJeLmNoPqRs'
const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'
const OTHER_REF = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
const PATH = `/checkout/${REFERENCE}/${TOKEN}/payments/${OUR_REF}`

const CONFIRMED = 'Your booking is confirmed'
const PENDING_TITLE = 'Approve the payment on your phone'
const WAIT = 'Mobile Money can take a minute to confirm. This page updates by itself.'
const LEAVE = 'If you close this page, we will still email your confirmation as soon as the payment arrives.'
const TROUBLE = 'We are having trouble checking on the payment. We will keep trying.'

function progress(paymentStatus: string, bookingStatus: string, failure: 'declined' | 'unavailable' | null = null): PaymentProgress {
  return {
    payment: { status: paymentStatus as PaymentProgress['payment']['status'], amountRwf: 19_500, failure },
    booking: {
      reference: REFERENCE,
      status: bookingStatus,
      serviceName: 'Portraits',
      packageName: 'Standard',
      startsAt: '2026-10-07T07:30:00.000Z',
      endsAt: '2026-10-07T09:00:00.000Z',
    },
  }
}

const PENDING = progress('pending', 'pending_payment')

/** A Response-shaped answer that needs no stream, so nothing but the faked clock decides timing. */
function answer(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

type Script = (url: string, call: number) => Response | Promise<Response>

/** Answers `/api/payments/:ourRef` by script; counts the calls per payment. */
function stubApi(script: Script) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      return script(url, calls.filter((call) => call === url).length)
    }),
  )
  return calls
}

function renderAt(path = PATH) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const view = render(<RouterProvider router={router} />)
  return { router, ...view }
}

/** Lets pending promises settle, with the clock still. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  })
}

/** Moves the faked clock on, running every poll that falls due, and lets them settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-10-01T06:05:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// --- Waiting -----------------------------------------------------------------------------------

describe('while the payment waits', () => {
  it('shows loading, then the pending state from the API, polling our_ref', async () => {
    const calls = stubApi(() => answer(PENDING))
    renderAt()

    expect(screen.getByRole('status')).toHaveTextContent('Loading your booking…')
    await settle()

    expect(screen.getByRole('heading', { level: 1, name: PENDING_TITLE })).toBeInTheDocument()
    expect(calls).toEqual([`/api/payments/${OUR_REF}`])
  })

  it('says what is happening, that Mobile Money can take a minute, and that the email comes if the page is closed', async () => {
    stubApi(() => answer(PENDING))
    renderAt()
    await settle()

    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('We have sent a request for 19,500 RWF to your phone. Enter your Mobile Money PIN to approve it.')
    expect(status).toHaveTextContent(WAIT)
    expect(status).toHaveTextContent(LEAVE)
  })

  it('shows the booking it is for, in Kigali time', async () => {
    stubApi(() => answer(PENDING))
    renderAt()
    await settle()

    const lines = Array.from(document.querySelectorAll('dt')).map((term) => [term.textContent, term.nextElementSibling?.textContent])
    expect(lines).toEqual([
      ['Booking reference', REFERENCE],
      ['Service', 'Portraits, Standard'],
      ['When', 'Wednesday, 7 October 2026, 09:30 to 11:00, Kigali time'],
    ])
  })

  it('stays pending, never saying confirmed, across 40 polls while the webhook is held back', async () => {
    const calls = stubApi((_url, call) => answer(call % 2 === 0 ? progress('initiated', 'pending_payment') : PENDING))
    renderAt()
    await settle()

    for (let poll = 1; poll <= 40; poll += 1) {
      await advance(POLL_INTERVAL_MS)
      expect(screen.queryByText(CONFIRMED)).not.toBeInTheDocument()
      expect(screen.queryByText(/confirmed|payment received/i)).not.toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 1, name: PENDING_TITLE })).toBeInTheDocument()
    }
    expect(calls).toHaveLength(41)
  })

  it('polls every 3 seconds, not sooner', async () => {
    const calls = stubApi(() => answer(PENDING))
    renderAt()
    await settle()

    await advance(POLL_INTERVAL_MS - 1)
    expect(calls).toHaveLength(1)
    await advance(1)
    expect(calls).toHaveLength(2)
    expect(POLL_INTERVAL_MS).toBe(3_000)
  })

  it('does not say confirmed while the booking is still waiting, even if the payment reads succeeded', async () => {
    stubApi(() => answer(progress('succeeded', 'pending_payment')))
    renderAt()
    await settle()

    expect(screen.queryByText(CONFIRMED)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Payment received' })).toBeInTheDocument()
    expect(screen.getByText('Thank you. Your payment of 19,500 RWF has arrived.')).toBeInTheDocument()
  })

  it('does not say confirmed while the payment is still pending, even if the booking reads confirmed', async () => {
    stubApi(() => answer(progress('pending', 'confirmed')))
    renderAt()
    await settle()

    expect(screen.queryByText(CONFIRMED)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: PENDING_TITLE })).toBeInTheDocument()
  })
})

// --- Settling ----------------------------------------------------------------------------------

describe('when the payment settles', () => {
  it('says confirmed only once the API answers succeeded, focuses the news, and stops polling', async () => {
    let settled = false
    const calls = stubApi(() => answer(settled ? progress('succeeded', 'confirmed') : PENDING))
    renderAt()
    await settle()
    await advance(POLL_INTERVAL_MS * 5)
    expect(screen.queryByText(CONFIRMED)).not.toBeInTheDocument()

    settled = true
    await advance(POLL_INTERVAL_MS)

    const heading = screen.getByRole('heading', { level: 1, name: CONFIRMED })
    expect(heading).toHaveFocus()
    expect(screen.getByText('Thank you. Your confirmation email, with a link to your booking, is on its way.')).toBeInTheDocument()
    expect(screen.queryByText(WAIT)).not.toBeInTheDocument()

    const count = calls.length
    await advance(POLL_INTERVAL_MS * 20)
    expect(calls).toHaveLength(count)
  })

  it.each([
    ['declined', 'The payment was declined, or was not approved in time.'],
    ['unavailable', 'We could not reach Mobile Money to start the payment.'],
  ] as const)('shows a %s failure with Try again back to the checkout, and stops polling', async (failure, words) => {
    const calls = stubApi(() => answer(progress('failed', 'pending_payment', failure)))
    renderAt()
    await settle()

    expect(screen.getByRole('heading', { level: 1, name: 'The payment did not go through' })).toHaveFocus()
    expect(screen.getByText(words)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', `/checkout/${REFERENCE}/${TOKEN}`)
    expect(screen.queryByText(CONFIRMED)).not.toBeInTheDocument()

    await advance(POLL_INTERVAL_MS * 10)
    expect(calls).toHaveLength(1)
  })

  it('reads a failure with no reason given as declined', async () => {
    stubApi(() => answer(progress('failed', 'pending_payment', null)))
    renderAt()
    await settle()

    expect(screen.getByText('The payment was declined, or was not approved in time.')).toBeInTheDocument()
  })

  it.each(['refund_due', 'refunded'])('says the time went to someone else and the %s payment will be refunded, when the booking expired', async (status) => {
    const calls = stubApi(() => answer(progress(status, 'expired')))
    renderAt()
    await settle()

    expect(screen.getByRole('heading', { level: 1, name: 'Your payment arrived after your hold ended' })).toHaveFocus()
    expect(screen.getByText('The time was booked by someone else before your payment arrived. The photographer has been told and will refund your 19,500 RWF.')).toBeInTheDocument()
    expect(screen.queryByText(CONFIRMED)).not.toBeInTheDocument()
    await advance(POLL_INTERVAL_MS * 5)
    expect(calls).toHaveLength(1)
  })

  it('says a second payment was not needed and will be refunded, when the booking was already paid', async () => {
    stubApi(() => answer(progress('refund_due', 'confirmed')))
    renderAt()
    await settle()

    expect(screen.getByRole('heading', { level: 1, name: 'Your booking was already paid' })).toBeInTheDocument()
    expect(screen.getByText('This second payment of 19,500 RWF was not needed. The photographer has been told and will refund it.')).toBeInTheDocument()
    expect(screen.queryByText(CONFIRMED)).not.toBeInTheDocument()
  })

  it('says payment received, not confirmed, for a success against an expired booking', async () => {
    stubApi(() => answer(progress('succeeded', 'expired')))
    renderAt()
    await settle()

    expect(screen.getByRole('heading', { level: 1, name: 'Payment received' })).toBeInTheDocument()
    expect(screen.queryByText(CONFIRMED)).not.toBeInTheDocument()
  })

  it('moves from pending to failed when the API says so', async () => {
    let failed = false
    stubApi(() => answer(failed ? progress('failed', 'pending_payment', 'declined') : PENDING))
    renderAt()
    await settle()
    expect(screen.getByRole('heading', { name: PENDING_TITLE })).toBeInTheDocument()

    failed = true
    await advance(POLL_INTERVAL_MS)
    expect(screen.getByRole('heading', { name: 'The payment did not go through' })).toBeInTheDocument()
  })
})

// --- Giving up and trouble ----------------------------------------------------------------------

describe('a long wait', () => {
  it('gives up after 10 minutes with Check again, and stops asking', async () => {
    const calls = stubApi(() => answer(PENDING))
    renderAt()
    await settle()

    await advance(POLL_GIVE_UP_MS - POLL_INTERVAL_MS)
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument()

    await advance(POLL_INTERVAL_MS)
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    expect(screen.getByText('We have not heard back yet. If you approved the payment, your confirmation email will arrive once it settles.')).toBeInTheDocument()
    // Still pending, and still saying the email comes.
    expect(screen.getByRole('heading', { name: PENDING_TITLE })).toBeInTheDocument()
    expect(screen.getByText(LEAVE)).toBeInTheDocument()
    expect(screen.queryByText(CONFIRMED)).not.toBeInTheDocument()

    const count = calls.length
    expect(count).toBe(POLL_GIVE_UP_MS / POLL_INTERVAL_MS + 1)
    await advance(POLL_INTERVAL_MS * 50)
    expect(calls).toHaveLength(count)
    expect(POLL_GIVE_UP_MS).toBe(600_000)
  })

  it('asks again at once on Check again, and keeps polling', async () => {
    let settled = false
    const calls = stubApi(() => answer(settled ? progress('succeeded', 'confirmed') : PENDING))
    renderAt()
    await settle()
    await advance(POLL_GIVE_UP_MS)
    const count = calls.length

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    })
    await settle()

    expect(calls).toHaveLength(count + 1)
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument()

    await advance(POLL_INTERVAL_MS)
    expect(calls).toHaveLength(count + 2)

    settled = true
    await advance(POLL_INTERVAL_MS)
    expect(screen.getByRole('heading', { name: CONFIRMED })).toBeInTheDocument()
  })

  it('keeps polling through network failures, saying so after three in a row, and recovers', async () => {
    let offline = false
    const calls = stubApi(() => (offline ? Promise.reject(new TypeError('Failed to fetch')) : answer(PENDING)))
    renderAt()
    await settle()

    offline = true
    await advance(POLL_INTERVAL_MS * 2)
    expect(screen.queryByText(TROUBLE)).not.toBeInTheDocument()
    await advance(POLL_INTERVAL_MS)
    expect(screen.getByText(TROUBLE)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: PENDING_TITLE })).toBeInTheDocument()
    expect(screen.queryByText(CONFIRMED)).not.toBeInTheDocument()

    offline = false
    await advance(POLL_INTERVAL_MS)
    expect(screen.queryByText(TROUBLE)).not.toBeInTheDocument()
    expect(calls).toHaveLength(5)
  })

  it('treats server errors as failures to check, not as an answer', async () => {
    stubApi((_url, call) => (call === 1 ? answer(PENDING) : answer({ error: 'internal_error' }, 500)))
    renderAt()
    await settle()

    await advance(POLL_INTERVAL_MS * 3)
    expect(screen.getByText(TROUBLE)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: PENDING_TITLE })).toBeInTheDocument()
  })

  it('says it is having trouble when it cannot reach the API from the start', async () => {
    stubApi(() => Promise.reject(new TypeError('Failed to fetch')))
    renderAt()
    await settle()

    expect(screen.getByRole('status')).toHaveTextContent('Loading your booking…')
    await advance(POLL_INTERVAL_MS * 2)
    expect(screen.getByRole('status')).toHaveTextContent(TROUBLE)
  })

  // Fails today: when no check has ever succeeded, the give-up after 10 minutes stops polling but
  // the page is still in its loading branch, which renders "We will keep trying" and never the
  // Check again button -- so it promises retries it has stopped making, with no way to resume.
  it('never claims to keep trying after it has stopped, when the API was unreachable for 10 minutes', async () => {
    const calls = stubApi(() => Promise.reject(new TypeError('Failed to fetch')))
    renderAt()
    await settle()

    await advance(POLL_GIVE_UP_MS + POLL_INTERVAL_MS)
    const before = calls.length
    await advance(POLL_INTERVAL_MS * 10)
    const stillTrying = calls.length > before

    if (screen.queryByText(/We will keep trying/) !== null) expect(stillTrying).toBe(true)
    else expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })
})

// --- Addressing -----------------------------------------------------------------------------------

describe('the payment it follows', () => {
  it('says the link is not valid for a payment the API does not know, and stops polling', async () => {
    const calls = stubApi(() => answer({ error: 'not_found' }, 404))
    renderAt()
    await settle()

    expect(screen.getByRole('heading', { level: 1, name: 'This payment link is not valid' })).toBeInTheDocument()
    await advance(POLL_INTERVAL_MS * 5)
    expect(calls).toHaveLength(1)
  })

  it('stops polling when the page is left', async () => {
    const calls = stubApi(() => answer(PENDING))
    const { unmount } = renderAt()
    await settle()

    unmount()
    await advance(POLL_INTERVAL_MS * 10)
    expect(calls).toHaveLength(1)
  })

  it('never shows one payment’s answer for another after moving between them', async () => {
    const calls = stubApi((url) => (url.endsWith(OUR_REF) ? answer(progress('succeeded', 'confirmed')) : new Promise<Response>(() => {})))
    const { router } = renderAt()
    await settle()
    expect(screen.getByRole('heading', { name: CONFIRMED })).toBeInTheDocument()

    await act(async () => {
      await router.navigate(`/checkout/${REFERENCE}/${TOKEN}/payments/${OTHER_REF}`)
    })
    await settle()

    expect(screen.queryByText(CONFIRMED)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading your booking…')
    expect(calls).toEqual([`/api/payments/${OUR_REF}`, `/api/payments/${OTHER_REF}`])
  })

  it('encodes our_ref into the request', async () => {
    const calls = stubApi(() => answer({ error: 'not_found' }, 404))
    renderAt(`/checkout/${REFERENCE}/${TOKEN}/payments/a%3Fb`)
    await settle()

    expect(calls).toEqual(['/api/payments/a%3Fb'])
  })
})
