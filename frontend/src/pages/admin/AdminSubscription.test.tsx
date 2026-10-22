import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { SubscriptionPage } from '@/admin/subscription'
import { SubscriptionRefreshContext } from '@/admin/subscription-refresh'
import { readSession, saveSession } from '@/auth/session'
import { formatDateTime } from '@/lib/format'
import {
  OUR_REF,
  paidPeriod,
  paymentProgress,
  studioSubscription,
  subscriptionPage,
  subscriptionPayment,
  trialPeriod,
} from '@/test/subscription-fixtures'
import { AdminSubscription, POLL_GIVE_UP_MS, POLL_INTERVAL_MS } from './AdminSubscription'

/**
 * `/studio/subscription` (marketplace spec Phase 5: R5.2, R5.3, R5.5), with
 * `fetch` stubbed and the clock faked.
 *
 * What is proven: the status card's sentence for each status; both plans with
 * their prices and the yearly saving only when there is one; the note that
 * paying early adds on top (or starts now, once lapsed); the methods are the
 * API's, and none means online payment is unavailable; the phone is checked
 * before anything is sent; a payment posts the plan, method and phone and
 * never an amount, then is polled every 3 seconds until it settles -- "received"
 * with the API's new end date, or a worded failure -- and the page and the
 * layout's banner are read again; a payment already waiting (on load, or a
 * `409 payment_in_progress`) is followed instead of a second one started;
 * every refusal is worded; checks that fail say so after three, the wait gives
 * up after 10 minutes with "Check again"; a vanished payment is said; and the
 * periods history lists every period with the current one marked.
 */

const PAGE_URL = '/api/studio/subscription'
const PAY_URL = '/api/studio/subscription/payments'
const OTHER_REF = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'

const SESSION = { token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

type Call = { url: string; method: string; body: unknown }

/** A Response-shaped answer that needs no stream, so nothing but the faked clock decides timing. */
function answer(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

type Script = {
  /** The page: each load takes the next one; the last repeats. */
  pages?: (SubscriptionPage | Response)[]
  pay?: (call: Call) => Response | Promise<Response>
  /** Each poll of a payment takes the next answer; the last repeats. */
  polls?: (Response | (() => Response | Promise<Response>))[]
}

function stubApi(script: Script = {}) {
  const calls: Call[] = []
  const pages = script.pages ?? [subscriptionPage()]
  const polls = script.polls ?? [answer(paymentProgress())]
  let pageCall = 0
  let pollCall = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const call: Call = {
        url: String(input),
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      }
      calls.push(call)
      if (call.url === PAGE_URL) {
        const page = pages[Math.min(pageCall++, pages.length - 1)]
        return page instanceof Object && 'ok' in page ? (page as Response) : answer(page)
      }
      if (call.url === PAY_URL && call.method === 'POST') {
        return script.pay === undefined ? answer({ payment: { ourRef: OUR_REF, status: 'pending', planInterval: 'monthly', amountRwf: 10_000 } }, 201) : script.pay(call)
      }
      if (call.url.startsWith(`${PAY_URL}/`)) {
        const next = polls[Math.min(pollCall++, polls.length - 1)]
        return typeof next === 'function' ? next() : (next as Response)
      }
      return answer({ error: 'not_found' }, 404)
    }),
  )
  return calls
}

function polled(calls: Call[], ourRef = OUR_REF) {
  return calls.filter((call) => call.url === `${PAY_URL}/${ourRef}`)
}

function posts(calls: Call[]) {
  return calls.filter((call) => call.method === 'POST')
}

function pageLoads(calls: Call[]) {
  return calls.filter((call) => call.url === PAGE_URL)
}

function renderPage(refresh: () => void = () => {}) {
  return render(
    <SubscriptionRefreshContext.Provider value={refresh}>
      <AdminSubscription />
    </SubscriptionRefreshContext.Provider>,
  )
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

async function loaded(script: Script = {}, refresh?: () => void) {
  const calls = stubApi(script)
  renderPage(refresh)
  await settle()
  return calls
}

function card() {
  return screen.getByRole('region', { name: 'Status' })
}

function payButton() {
  return screen.getByRole('button', { name: /^Pay / })
}

function phone() {
  return screen.getByLabelText('Mobile Money number') as HTMLInputElement
}

async function pay(number = '0788123456') {
  fireEvent.change(phone(), { target: { value: number } })
  fireEvent.click(payButton())
  await settle()
}

const TRIAL_END = '2026-10-31T08:00:00.000Z'
const NEW_END = '2026-11-30T08:00:00.000Z'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-10-25T08:00:00.000Z'))
  saveSession('studio', SESSION)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

// --- Loading -------------------------------------------------------------------------------------

describe('loading the page', () => {
  it('draws placeholders and announces the wait, then the page, from one GET with the studio token', async () => {
    const calls = stubApi()
    renderPage()

    expect(screen.getByRole('heading', { level: 1, name: 'Subscription' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading your subscription…')
    await settle()

    expect(card()).toBeInTheDocument()
    expect(calls).toEqual([{ url: PAGE_URL, method: 'GET', body: undefined }])
    const init = vi.mocked(fetch).mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer studio.jwt')
  })

  it('says a failed load, and loads again on "Try again"', async () => {
    const calls = await loaded({ pages: [answer({ error: 'internal_error' }, 500), subscriptionPage()] })

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load your subscription. Check your connection and try again.')
    expect(screen.queryByRole('region', { name: 'Status' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()

    expect(card()).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(pageLoads(calls)).toHaveLength(2)
  })

  it('on a 401 drops the studio session and says nothing of a failure (the layout takes him to sign in)', async () => {
    await loaded({ pages: [answer({ error: 'invalid_token' }, 401)] })

    expect(readSession('studio')).toBeNull()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says a photographer never approved has nothing to pay yet, and offers no form', async () => {
    await loaded({ pages: [subscriptionPage({ subscription: null })] })

    expect(screen.getByText('Your subscription starts with a free trial when your profile is approved. There is nothing to pay until then.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'History' })).not.toBeInTheDocument()
  })
})

// --- Status --------------------------------------------------------------------------------------

describe('the status card', () => {
  it('on a trial says when the free trial ends', async () => {
    await loaded()

    expect(within(card()).getByText('Free trial')).toBeInTheDocument()
    expect(card()).toHaveTextContent(`Free trial ends ${formatDateTime(TRIAL_END)}.`)
  })

  it('once paid says it renews by payment, and until when it is paid', async () => {
    const period = paidPeriod()
    await loaded({
      pages: [subscriptionPage({ subscription: studioSubscription({ status: 'active', currentPeriodEndsAt: NEW_END, currentPeriod: period, periods: [period, trialPeriod()] }) })],
    })

    expect(within(card()).getByText('Active')).toBeInTheDocument()
    expect(card()).toHaveTextContent(`Renews by payment; paid until ${formatDateTime(NEW_END)}.`)
  })

  it('past due says when it ended, that clients cannot book, and when the profile is hidden', async () => {
    const ended = '2026-10-24T08:00:00.000Z'
    const hidden = '2026-10-31T08:00:00.000Z'
    await loaded({
      pages: [
        subscriptionPage({
          subscription: studioSubscription({ status: 'past_due', currentPeriodEndsAt: ended, graceEndsAt: hidden, takingBookings: false, currentPeriod: null }),
        }),
      ],
    })

    expect(within(card()).getByText('Past due')).toBeInTheDocument()
    expect(card()).toHaveTextContent(
      `Your subscription ended ${formatDateTime(ended)}. Clients can't book you; your profile is hidden after ${formatDateTime(hidden)}.`,
    )
  })

  it('expired says the profile is hidden, and to pay to come back', async () => {
    await loaded({
      pages: [subscriptionPage({ subscription: studioSubscription({ status: 'expired', currentPeriodEndsAt: '2026-10-01T08:00:00.000Z', takingBookings: false, currentPeriod: null }) })],
    })

    expect(within(card()).getByText('Expired')).toBeInTheDocument()
    expect(card()).toHaveTextContent('Your profile is hidden. Pay to come back.')
  })
})

// --- The plan --------------------------------------------------------------------------------------

describe('choosing a plan', () => {
  it('offers monthly and yearly with their prices, monthly chosen, and the button names the amount', async () => {
    await loaded()

    const monthly = screen.getByRole('radio', { name: /Monthly/ })
    const yearly = screen.getByRole('radio', { name: /Yearly/ })
    expect(monthly).toBeChecked()
    expect(yearly).not.toBeChecked()
    expect(screen.getByText('10,000 RWF a month')).toBeInTheDocument()
    expect(screen.getByText('100,000 RWF a year')).toBeInTheDocument()
    expect(payButton()).toHaveTextContent('Pay 10,000 RWF')

    fireEvent.click(yearly)

    expect(yearly).toBeChecked()
    expect(payButton()).toHaveTextContent('Pay 100,000 RWF')
  })

  it('shows the yearly saving when a year costs less than twelve months', async () => {
    await loaded()

    expect(screen.getByText('Save 20,000 RWF a year compared with paying monthly')).toBeInTheDocument()
  })

  it.each([
    [{ monthly: 10_000, yearly: 120_000 }],
    [{ monthly: 10_000, yearly: 130_000 }],
  ])('shows no saving for %j', async (prices) => {
    await loaded({ pages: [subscriptionPage({ prices })] })

    expect(document.querySelector('[data-yearly-saving]')).toBeNull()
    expect(screen.queryByText(/^Save /)).not.toBeInTheDocument()
  })

  it.each(['trialing', 'active'] as const)('while %s, says paying early adds the new period on top, from the current end', async (status) => {
    await loaded({ pages: [subscriptionPage({ subscription: studioSubscription({ status }) })] })

    expect(document.querySelector('[data-subscription="on-top"]')).toHaveTextContent(
      `Paying early adds the new period on top of the current one: it starts when your current period ends, on ${formatDateTime(TRIAL_END)}, so you lose no days.`,
    )
  })

  it.each(['past_due', 'expired'] as const)('once %s, says the new period starts when the payment arrives', async (status) => {
    await loaded({ pages: [subscriptionPage({ subscription: studioSubscription({ status, currentPeriodEndsAt: '2026-10-20T08:00:00.000Z', currentPeriod: null }) })] })

    expect(document.querySelector('[data-subscription="on-top"]')).toHaveTextContent('The new period starts as soon as the payment arrives.')
  })
})

// --- Methods ---------------------------------------------------------------------------------------

describe('the methods on offer', () => {
  it('offers the methods the API lists, the first chosen', async () => {
    await loaded()

    const methods = within(screen.getByRole('group', { name: 'How would you like to pay?' })).getAllByRole('radio')
    expect(methods.map((radio) => radio.closest('label')?.textContent)).toEqual(['MTN MoMo', 'Airtel Money'])
    expect(methods[0]).toBeChecked()
  })

  it('offers only what the API lists', async () => {
    await loaded({ pages: [subscriptionPage({ methods: ['momo_airtel'] })] })

    const methods = within(screen.getByRole('group', { name: 'How would you like to pay?' })).getAllByRole('radio')
    expect(methods.map((radio) => radio.closest('label')?.textContent)).toEqual(['Airtel Money'])
    expect(methods[0]).toBeChecked()
  })

  it('with no method, says online payment is unavailable and offers no form, keeping the status and history', async () => {
    const calls = await loaded({ pages: [subscriptionPage({ methods: [] })] })

    expect(screen.getByRole('alert')).toHaveTextContent("Online payment isn't available right now, so the subscription can't be paid here. Try again later.")
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Mobile Money number')).not.toBeInTheDocument()
    expect(card()).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument()
    expect(posts(calls)).toEqual([])
  })
})

// --- Paying ----------------------------------------------------------------------------------------

describe('paying', () => {
  it.each(['', '12', 'not a number', '0788 123 456 789 012 345'])('refuses the phone %j before anything is sent, and focuses it', async (number) => {
    const calls = await loaded()

    await pay(number)

    expect(screen.getByText('Enter the phone number of your Mobile Money account.')).toBeInTheDocument()
    expect(phone()).toHaveAttribute('aria-invalid', 'true')
    expect(phone()).toHaveFocus()
    expect(posts(calls)).toEqual([])
  })

  it('posts the plan, the method and the phone -- never an amount -- and follows the payment', async () => {
    const calls = await loaded()

    fireEvent.click(screen.getByRole('radio', { name: /Yearly/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'Airtel Money' }))
    await pay(' +250 788 123 456 ')

    expect(posts(calls)).toEqual([
      { url: PAY_URL, method: 'POST', body: { planInterval: 'yearly', method: 'momo_airtel', phone: '+250 788 123 456' } },
    ])
    expect(screen.getByText('Approve the payment on your phone')).toBeInTheDocument()
    // The form is gone while the payment waits: only one at a time.
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument()
  })

  it('polls every 3 seconds while the payment waits, and never says received', async () => {
    const calls = await loaded({ polls: [answer(paymentProgress({ status: 'initiated' })), answer(paymentProgress({ status: 'pending' }))] })
    await pay()

    expect(polled(calls)).toHaveLength(1)
    expect(screen.getByText('We have sent a request for 10,000 RWF to your phone. Enter your Mobile Money PIN to approve it.')).toBeInTheDocument()
    expect(screen.getByText('Mobile Money can take a minute to confirm. This page updates by itself.')).toBeInTheDocument()

    await advance(POLL_INTERVAL_MS - 1)
    expect(polled(calls)).toHaveLength(1)
    await advance(1)
    expect(polled(calls)).toHaveLength(2)
    await advance(POLL_INTERVAL_MS * 5)
    expect(polled(calls)).toHaveLength(7)

    expect(screen.queryByText('Payment received')).not.toBeInTheDocument()
    expect(screen.getByText('Approve the payment on your phone')).toBeInTheDocument()
  })

  it('says received with the end date the API answered, stops polling, and reads the page and the banner again', async () => {
    const refresh = vi.fn()
    const after = subscriptionPage({
      subscription: studioSubscription({ status: 'trialing', currentPeriodEndsAt: NEW_END, periods: [paidPeriod(), trialPeriod()] }),
    })
    const calls = await loaded(
      {
        pages: [subscriptionPage(), after],
        polls: [answer(paymentProgress()), answer(paymentProgress({ status: 'succeeded', settledAt: '2026-10-25T08:00:05.000Z' }, { currentPeriodEndsAt: NEW_END }))],
      },
      refresh,
    )
    await pay()
    await advance(POLL_INTERVAL_MS)

    const notice = document.querySelector('[data-outcome="succeeded"]')
    expect(notice).toHaveTextContent('Payment received')
    expect(notice).toHaveTextContent(`Thank you. You're paid until ${formatDateTime(NEW_END)}. A receipt is on its way by email.`)
    expect(notice).toHaveFocus()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(pageLoads(calls)).toHaveLength(2)

    const pollsSoFar = polled(calls).length
    await advance(POLL_INTERVAL_MS * 10)
    expect(polled(calls)).toHaveLength(pollsSoFar)

    // The page redraws from its second load: the new period is in the history, and he can pay again.
    expect(screen.getAllByRole('row').filter((row) => row.hasAttribute('data-period'))).toHaveLength(2)
    expect(payButton()).toBeInTheDocument()
  })

  it.each([
    ['declined', 'The payment was declined, or was not approved in time. Nothing was charged.'],
    ['unavailable', 'We could not reach Mobile Money to start the payment. Nothing was charged.'],
    [null, 'The payment was declined, or was not approved in time. Nothing was charged.'],
  ] as const)('says a failure (%s) in words, and offers the form again', async (failure, words) => {
    const refresh = vi.fn()
    const calls = await loaded({ polls: [answer(paymentProgress({ status: 'failed', failure }))] }, refresh)
    await pay()

    const notice = document.querySelector('[data-outcome="failed"]')
    expect(notice).toHaveTextContent('The payment did not go through')
    expect(notice).toHaveTextContent(words)
    expect(screen.queryByText('Payment received')).not.toBeInTheDocument()
    expect(payButton()).toBeInTheDocument()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(pageLoads(calls)).toHaveLength(2)
  })

  it('clears the last outcome when another payment starts', async () => {
    await loaded({ polls: [answer(paymentProgress({ status: 'failed', failure: 'declined' })), answer(paymentProgress())] })
    await pay()
    expect(document.querySelector('[data-outcome="failed"]')).not.toBeNull()

    await pay()

    expect(document.querySelector('[data-outcome]')).toBeNull()
    expect(screen.getByText('Approve the payment on your phone')).toBeInTheDocument()
  })

  it('sends one request for a double press', async () => {
    let release: (res: Response) => void = () => {}
    const calls = await loaded({ pay: () => new Promise<Response>((resolve) => (release = resolve)) })

    fireEvent.change(phone(), { target: { value: '0788123456' } })
    const button = payButton()
    fireEvent.click(button)
    await settle()
    expect(button).toHaveTextContent('Starting the payment…')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button)
    await settle()

    expect(posts(calls)).toHaveLength(1)
    release(answer({ payment: { ourRef: OUR_REF, status: 'pending', planInterval: 'monthly', amountRwf: 10_000 } }, 201))
    await settle()
    expect(screen.getByText('Approve the payment on your phone')).toBeInTheDocument()
  })
})

// --- A payment already waiting -------------------------------------------------------------------------

describe('a payment already in progress', () => {
  it('found on load, is followed at once instead of offering a second payment', async () => {
    const calls = await loaded({
      pages: [subscriptionPage({ subscription: studioSubscription({ paymentInProgress: subscriptionPayment({ amountRwf: 100_000, planInterval: 'yearly' }) }) })],
      // Held back, so what shows first is what the page already had.
      polls: [() => new Promise<Response>(() => {})],
    })

    expect(screen.getByText('A payment you started is still waiting for approval, so this page follows it. Another can start once it settles.')).toBeInTheDocument()
    expect(screen.getByText('We have sent a request for 100,000 RWF to your phone. Enter your Mobile Money PIN to approve it.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument()
    expect(polled(calls)).toHaveLength(1)
  })

  it('found on load but already settled, is not followed', async () => {
    const calls = await loaded({
      pages: [subscriptionPage({ subscription: studioSubscription({ paymentInProgress: subscriptionPayment({ status: 'failed' }) }) })],
    })

    expect(payButton()).toBeInTheDocument()
    expect(polled(calls)).toHaveLength(0)
  })

  it('named by a 409 payment_in_progress, is followed by its own reference, its amount from the first answer', async () => {
    const calls = await loaded({
      pay: () => answer({ error: 'payment_in_progress', payment: { ourRef: OTHER_REF } }, 409),
      polls: [answer(paymentProgress({ ourRef: OTHER_REF, amountRwf: 100_000 }))],
    })
    await pay()

    expect(polled(calls, OTHER_REF)).toHaveLength(1)
    expect(polled(calls, OUR_REF)).toHaveLength(0)
    expect(screen.getByText('A payment you started is still waiting for approval, so this page follows it. Another can start once it settles.')).toBeInTheDocument()
    expect(screen.getByText('We have sent a request for 100,000 RWF to your phone. Enter your Mobile Money PIN to approve it.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

// --- Refusals ----------------------------------------------------------------------------------------------

describe('a payment the API refuses', () => {
  it.each<[string, () => Response | Promise<Response>, string]>([
    ['400', () => answer({ error: 'invalid_request' }, 400), 'The payment did not start: the request could not be read. Reload the page and try again.'],
    [
      '409 photographer_not_approved',
      () => answer({ error: 'photographer_not_approved' }, 409),
      "Your profile isn't approved right now, so the subscription can't be paid. Bookings you already have carry on.",
    ],
    [
      '409 no_subscription',
      () => answer({ error: 'no_subscription' }, 409),
      'Your studio has no subscription yet. It starts, with a free trial, when your profile is approved.',
    ],
    [
      '422 on the method',
      () => answer({ error: 'validation_failed', fields: ['method'] }, 422),
      "That payment method isn't on offer any more. Reload the page and choose another.",
    ],
    ['429', () => answer({ error: 'rate_limited' }, 429), 'Too many payment attempts from this connection. Wait a minute, then try again.'],
    [
      '502 rejected',
      () => answer({ error: 'payment_not_started', reason: 'rejected', payment: { ourRef: OUR_REF, status: 'failed' } }, 502),
      'Mobile Money did not accept the request. Check that the number has a Mobile Money account, then try again.',
    ],
    [
      '502 unavailable',
      () => answer({ error: 'payment_not_started', reason: 'unavailable', payment: { ourRef: OUR_REF, status: 'failed' } }, 502),
      'We could not reach Mobile Money just now. Please try again in a moment.',
    ],
    ['500', () => answer({ error: 'internal_error' }, 500), 'The payment did not start. Check your connection and try again.'],
    ['a 422 naming no field the page has', () => answer({ error: 'validation_failed', fields: ['planInterval'] }, 422), 'The payment did not start. Check your connection and try again.'],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch')), 'The payment did not start. Check your connection and try again.'],
  ])('words %s, keeps the form, and follows nothing', async (_label, respond, words) => {
    const calls = await loaded({ pay: respond })
    await pay()

    expect(screen.getByRole('alert')).toHaveTextContent(words)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(payButton()).toBeInTheDocument()
    expect(polled(calls)).toHaveLength(0)
    expect(screen.queryByText('Approve the payment on your phone')).not.toBeInTheDocument()
  })

  it('marks and focuses the phone on a 422 naming it, without a second sentence', async () => {
    await loaded({ pay: () => answer({ error: 'validation_failed', fields: ['phone'] }, 422) })
    await pay()

    expect(screen.getByText('Enter the phone number of your Mobile Money account.')).toBeInTheDocument()
    expect(phone()).toHaveAttribute('aria-invalid', 'true')
    expect(phone()).toHaveFocus()
    expect(document.querySelector('[data-pay-error]')).toBeNull()
  })

  it('says both on a 422 naming the method and the phone', async () => {
    await loaded({ pay: () => answer({ error: 'validation_failed', fields: ['method', 'phone'] }, 422) })
    await pay()

    expect(phone()).toHaveAttribute('aria-invalid', 'true')
    expect(document.querySelector('[data-pay-error="method"]')).not.toBeNull()
  })

  it('clears an earlier refusal when he tries again', async () => {
    let call = 0
    await loaded({
      pay: () => (++call === 1 ? answer({ error: 'rate_limited' }, 429) : answer({ payment: { ourRef: OUR_REF, status: 'pending', planInterval: 'monthly', amountRwf: 10_000 } }, 201)),
    })
    await pay()
    expect(document.querySelector('[data-pay-error="rate_limited"]')).not.toBeNull()

    await pay()

    expect(document.querySelector('[data-pay-error]')).toBeNull()
  })

  it('on a 401 drops the session and says nothing', async () => {
    await loaded({ pay: () => answer({ error: 'invalid_token' }, 401) })
    await pay()

    expect(readSession('studio')).toBeNull()
    expect(document.querySelector('[data-pay-error]')).toBeNull()
  })
})

// --- Following ------------------------------------------------------------------------------------------------

describe('following a payment', () => {
  it('says after three failed checks in a row that it is having trouble, keeps trying, and settles', async () => {
    const down = () => Promise.reject(new TypeError('Failed to fetch'))
    const calls = await loaded({
      polls: [answer(paymentProgress()), down, down, down, answer(paymentProgress({ status: 'succeeded' }, { currentPeriodEndsAt: NEW_END }))],
    })
    await pay()

    await advance(POLL_INTERVAL_MS * 2)
    expect(screen.queryByText('We are having trouble checking on the payment. We will keep trying.')).not.toBeInTheDocument()
    await advance(POLL_INTERVAL_MS)
    expect(screen.getByText('We are having trouble checking on the payment. We will keep trying.')).toBeInTheDocument()

    await advance(POLL_INTERVAL_MS)
    expect(polled(calls)).toHaveLength(5)
    expect(document.querySelector('[data-outcome="succeeded"]')).not.toBeNull()
  })

  it('stops asking after 10 minutes, says so, and "Check again" resumes', async () => {
    const calls = await loaded({ polls: [answer(paymentProgress())] })
    await pay()

    await advance(POLL_GIVE_UP_MS + POLL_INTERVAL_MS)
    const asked = polled(calls).length
    expect(screen.getByText('We have not heard back yet. If you approved the payment, your subscription updates once it settles.')).toBeInTheDocument()

    await advance(POLL_INTERVAL_MS * 10)
    expect(polled(calls)).toHaveLength(asked)

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await settle()
    expect(polled(calls)).toHaveLength(asked + 1)
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument()
  })

  it('says a payment that vanished (404), and offers the form again', async () => {
    const refresh = vi.fn()
    const calls = await loaded({ polls: [answer({ error: 'not_found' }, 404)] }, refresh)
    await pay()

    expect(document.querySelector('[data-outcome="missing"]')).toHaveTextContent(
      'We could not find that payment. Check your subscription below, and pay again if it is not covered.',
    )
    expect(payButton()).toBeInTheDocument()
    await advance(POLL_INTERVAL_MS * 3)
    expect(polled(calls)).toHaveLength(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('stops polling when he leaves the page', async () => {
    const calls = stubApi({ polls: [answer(paymentProgress())] })
    const view = renderPage()
    await settle()
    await pay()
    const asked = polled(calls).length

    view.unmount()
    await advance(POLL_INTERVAL_MS * 5)

    expect(polled(calls)).toHaveLength(asked)
  })
})

// --- History ---------------------------------------------------------------------------------------------------

describe('the history', () => {
  it('lists every period newest first, each with its dates, its price and when it was paid, the current one marked', async () => {
    const yearly = paidPeriod({ id: 'per-yearly', planInterval: 'yearly', priceRwf: 100_000, startsAt: NEW_END, endsAt: '2027-11-30T08:00:00.000Z', paidAt: '2026-10-25T09:20:00.000Z' })
    const monthly = paidPeriod()
    const trial = trialPeriod()
    await loaded({
      pages: [subscriptionPage({ subscription: studioSubscription({ status: 'trialing', currentPeriod: trial, periods: [yearly, monthly, trial] }) })],
    })

    const rows = screen.getAllByRole('row').filter((row) => row.hasAttribute('data-period'))
    expect(rows.map((row) => row.getAttribute('data-period'))).toEqual(['per-yearly', 'per-paid', 'per-trial'])

    const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((cell) => cell.textContent)
    expect(cells(rows[0] as HTMLElement)).toEqual([
      'Yearly',
      `${formatDateTime(NEW_END)} to ${formatDateTime('2027-11-30T08:00:00.000Z')}`,
      '100,000 RWF',
      formatDateTime('2026-10-25T09:20:00.000Z'),
    ])
    expect(cells(rows[1] as HTMLElement)).toEqual([
      'Monthly',
      `${formatDateTime(monthly.startsAt)} to ${formatDateTime(monthly.endsAt)}`,
      '10,000 RWF',
      formatDateTime(monthly.paidAt as string),
    ])
    expect(cells(rows[2] as HTMLElement)).toEqual([
      'Free trialCurrent',
      `${formatDateTime(trial.startsAt)} to ${formatDateTime(trial.endsAt)}`,
      'Free',
      '',
    ])
    expect(within(rows[0] as HTMLElement).queryByText('Current')).not.toBeInTheDocument()
  })

  it('marks no row current once the last period has ended', async () => {
    await loaded({ pages: [subscriptionPage({ subscription: studioSubscription({ status: 'past_due', currentPeriod: null }) })] })

    expect(screen.queryByText('Current')).not.toBeInTheDocument()
  })

  it('says when there are no periods', async () => {
    await loaded({ pages: [subscriptionPage({ subscription: studioSubscription({ currentPeriod: null, periods: [] }) })] })

    expect(screen.getByText('No periods yet.')).toBeInTheDocument()
  })
})
