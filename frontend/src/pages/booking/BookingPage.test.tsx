import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { ClientBooking } from '@/catalogue/booking-access'
import { routes } from '@/routes'

/**
 * A client's own booking (plan.md Task 18; spec §3.9, §6.10, §6.20), rendered
 * through the real routes with `fetch` stubbed.
 *
 * What is proven: a live token renders that booking -- reference, service, time
 * in Kigali, location, photos, requests -- and an invalid, expired or replaced
 * one renders one generic "this link is not valid" page that says nothing about
 * any booking. Every amount on the page is the API's own: change the API's
 * numbers and the page follows, because nothing here adds anything up. A
 * booking with money outstanding shows the payment control and a fully paid one
 * does not. Cancelling takes two steps: the warning naming the forfeited
 * booking fee stands between the button and the request, backing out sends
 * nothing, and confirming shows the cancelled booking with any refund owed. The
 * delivery link appears once the photos are sent and turns into the expired
 * notice after its date. A failed load offers Try again; the session-fee form's
 * refusals are the checkout's, word for word.
 */

const TOKEN = 'aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJeLmNoPqRs'
const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'
const REFERENCE = 'BKY-2610-7K3QX'
const PATH = `/booking/${TOKEN}`
const BOOKING_API = `/api/booking/${TOKEN}`

const BOOKING: ClientBooking = {
  reference: REFERENCE,
  status: 'confirmed',
  stage: 'confirmed',
  clientName: 'Aline Uwase',
  maskedEmail: 'a•••••@example.com',
  pendingMaskedEmail: null,
  startsAt: '2026-10-07T07:30:00.000Z',
  endsAt: '2026-10-07T09:00:00.000Z',
  serviceName: 'Portraits',
  packageName: 'Standard',
  packagePriceRwf: 40_000,
  packagePhotoCount: 25,
  packageDurationMinutes: 90,
  locationText: 'Kigali Heights, KG 7 Ave',
  partySize: 3,
  specialRequests: 'Golden hour if possible.',
  addons: [{ name: 'Extra hour', priceRwf: 10_000, stage: 'at_booking' }],
  totals: { quotedTotalRwf: 50_000, grandTotalRwf: 50_000, collectedRwf: 20_000, refundDueRwf: 0, outstandingRwf: 30_000 },
  bookingFeeRwf: 20_000,
  payments: [{ kind: 'booking_fee', status: 'succeeded', amountRwf: 20_000, settledAt: '2026-10-01T06:05:00.000Z' }],
  canCancel: true,
  cancellationReason: null,
  cancelledAt: null,
  sessionFee: { outstandingRwf: 30_000, waitingPayment: null },
  delivery: null,
  notices: [],
}

/** The same booking, paid in full: nothing outstanding, so no payment control. */
const PAID: ClientBooking = {
  ...BOOKING,
  status: 'completed',
  stage: 'completed',
  totals: { ...BOOKING.totals, collectedRwf: 50_000, outstandingRwf: 0 },
  payments: [
    ...BOOKING.payments,
    { kind: 'session_fee', status: 'succeeded', amountRwf: 30_000, settledAt: '2026-10-08T09:00:00.000Z' },
  ],
  canCancel: false,
  sessionFee: null,
}

const CANCELLED: ClientBooking = {
  ...BOOKING,
  status: 'cancelled_by_client',
  stage: 'cancelled_by_client',
  totals: { ...BOOKING.totals, outstandingRwf: 0, refundDueRwf: 30_000, collectedRwf: 20_000 },
  canCancel: false,
  cancelledAt: '2026-10-01T06:00:00.000Z',
  sessionFee: null,
}

const PENDING_PROGRESS = {
  payment: { status: 'pending', amountRwf: 30_000, failure: null },
  booking: {
    reference: REFERENCE,
    status: 'confirmed',
    serviceName: 'Portraits',
    packageName: 'Standard',
    startsAt: BOOKING.startsAt,
    endsAt: BOOKING.endsAt,
  },
}

type Reply = Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type Api = {
  booking?: (call: number) => Reply
  methods?: () => Reply
  cancel?: (call: number) => Reply
  pay?: (body: unknown, call: number) => Reply
  email?: (body: unknown) => Reply
}

/** Answers the booking, the methods, a cancellation, a payment and a payment's progress. */
function stubApi(api: Api = {}) {
  const calls: string[] = []
  const payBodies: unknown[] = []
  const cancelRequests: RequestInit[] = []
  const emailBodies: unknown[] = []
  let bookingCalls = 0
  let cancelCalls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      if (method === 'GET' && url === BOOKING_API) {
        bookingCalls += 1
        return api.booking ? api.booking(bookingCalls) : json({ booking: BOOKING })
      }
      if (method === 'GET' && url === '/api/payment-methods') {
        return api.methods ? api.methods() : json({ provider: 'mtn_momo_direct', methods: ['momo_mtn'] })
      }
      if (method === 'POST' && url === `${BOOKING_API}/cancel`) {
        cancelCalls += 1
        cancelRequests.push(init ?? {})
        return api.cancel ? api.cancel(cancelCalls) : json({ booking: CANCELLED })
      }
      if (method === 'POST' && url === `${BOOKING_API}/payments`) {
        payBodies.push(JSON.parse(String(init?.body)))
        return api.pay ? api.pay(payBodies.at(-1), payBodies.length) : json({ payment: { ourRef: OUR_REF, status: 'pending' } }, 201)
      }
      if (method === 'POST' && url === `${BOOKING_API}/email`) {
        const body = JSON.parse(String(init?.body))
        emailBodies.push(body)
        return api.email ? api.email(body) : json({ booking: { ...BOOKING, pendingMaskedEmail: 'n\u2022\u2022\u2022\u2022\u2022@example.com' } }, 202)
      }
      if (method === 'GET' && url.startsWith('/api/payments/')) return json(PENDING_PROGRESS)
      return json({ error: 'not_found' }, 404)
    }),
  )
  return { calls, payBodies, cancelRequests, emailBodies }
}

function renderAt(path = PATH) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

async function renderLoaded(path = PATH) {
  const router = renderAt(path)
  await screen.findByRole('heading', { level: 1, name: 'Your booking' })
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

/** Every term/description pair on the page, in order. */
function lines(): [string, string][] {
  return Array.from(document.querySelectorAll('dt')).map((term) => [
    term.textContent ?? '',
    term.nextElementSibling?.textContent ?? '',
  ])
}

function valueOf(term: string): string | undefined {
  return lines().find(([name]) => name === term)?.[1]
}

function phoneField() {
  return screen.getByRole('textbox', { name: 'Mobile Money number' })
}

function payButton() {
  return screen.getByRole('button', { name: /^Pay / })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

// --- The booking ---------------------------------------------------------------------------

describe('a valid link', () => {
  it('shows loading, then the booking the token addresses, in Kigali time', async () => {
    const { calls } = stubApi()
    renderAt()

    expect(screen.getByRole('status')).toHaveTextContent('Loading your booking…')
    await screen.findByRole('heading', { level: 1, name: 'Your booking' })

    expect(valueOf('Booking reference')).toBe(REFERENCE)
    expect(valueOf('Service')).toBe('Portraits, Standard')
    expect(valueOf('When')).toBe('Wednesday, 7 October 2026, 09:30 to 11:00, Kigali time')
    expect(valueOf('Location')).toBe('Kigali Heights, KG 7 Ave')
    expect(valueOf('Number of people')).toBe('3')
    expect(valueOf('Photos')).toBe('25 photos')
    expect(valueOf('Special requests')).toBe('Golden hour if possible.')
    expect(screen.getByText('Confirmed')).toBeInTheDocument()
    expect(calls.sort()).toEqual([`GET ${BOOKING_API}`, 'GET /api/payment-methods'])
  })

  it('fetches only its own token’s booking: no reference, id or email is ever sent', async () => {
    const { calls } = stubApi()
    await renderLoaded()

    for (const call of calls) {
      expect(call).not.toContain('?')
      expect(call).not.toContain(REFERENCE)
    }
  })

  it('omits the lines the booking has nothing for', async () => {
    stubApi({ booking: () => json({ booking: { ...BOOKING, partySize: null, specialRequests: null } }) })
    await renderLoaded()

    expect(screen.queryByText('Number of people')).not.toBeInTheDocument()
    expect(screen.queryByText('Special requests')).not.toBeInTheDocument()
  })

  // The pill shows the display stage (2026-09-25); `status` is kept beside it as the API sends both.
  it.each([
    ['confirmed', 'in_progress', 'In progress'],
    ['completed', 'completed', 'Completed'],
    ['completed', 'closed', 'Closed'],
    ['no_show', 'no_show', 'Recorded as missed'],
    ['cancelled_by_admin', 'cancelled_by_admin', 'Cancelled by the photographer'],
    ['cancelled_by_client', 'cancelled_by_client', 'Cancelled by you'],
    ['expired', 'expired', 'Expired'],
  ])('names a %s booking at stage %s in words', async (status, stage, words) => {
    stubApi({ booking: () => json({ booking: { ...BOOKING, status, stage, canCancel: false, sessionFee: null } }) })
    await renderLoaded()

    expect(screen.getByText(words)).toBeInTheDocument()
  })

  it('explains every stage a client can meet, and never needs_review (2026-09-25)', async () => {
    stubApi()
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'What the statuses mean' }))

    const legend = await screen.findByRole('dialog')
    for (const words of ['Waiting for payment', 'In progress', 'Closed', 'Your photos have been sent to your email.']) {
      expect(legend).toHaveTextContent(words)
    }
    expect(legend).not.toHaveTextContent('Needs review')
  })
})

// --- Remembered on this device (2026-09-25) -------------------------------------------------

describe('remembering the link on this device', () => {
  it('keeps the token of a booking that opened, and the header leads back to it', async () => {
    stubApi()
    renderAt()

    await screen.findByText(REFERENCE)
    expect(localStorage.getItem('bookly.bookingToken')).toBe(TOKEN)
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'My booking' })).toHaveAttribute('href', PATH)
  })

  it('forgets a remembered token the API no longer knows', async () => {
    localStorage.setItem('bookly.bookingToken', TOKEN)
    stubApi({ booking: () => json({ error: 'not_found' }, 404) })
    renderAt()

    await screen.findByRole('heading', { level: 1, name: 'This link is not valid' })
    expect(localStorage.getItem('bookly.bookingToken')).toBeNull()
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'My booking' })).toHaveAttribute('href', '/my-booking')
  })

  it('leaves a different remembered booking alone when this link is dead', async () => {
    localStorage.setItem('bookly.bookingToken', 'another-token-0123456789abcdef')
    stubApi({ booking: () => json({ error: 'not_found' }, 404) })
    renderAt()

    await screen.findByRole('heading', { level: 1, name: 'This link is not valid' })
    expect(localStorage.getItem('bookly.bookingToken')).toBe('another-token-0123456789abcdef')
  })

  it('still shows the booking when storage cannot be written', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    stubApi()
    renderAt()

    expect(await screen.findByText(REFERENCE)).toBeInTheDocument()
  })
})

// --- Notices (2026-09-25) ------------------------------------------------------------------

describe('the notices', () => {
  const NOTICES: ClientBooking['notices'] = [
    { id: 'note:n1', kind: 'note', at: '2026-10-06T10:00:00.000Z', data: { body: 'Bring a jacket.\nIt gets cold <b>up there</b>.' } },
    { id: 'balance:30000', kind: 'balance_due', at: '2026-10-05T10:00:00.000Z', data: { amountRwf: 30_000 } },
    {
      id: 'outbox:o1',
      kind: 'reschedule',
      at: '2026-10-04T10:00:00.000Z',
      data: {
        startsAt: '2026-10-09T07:00:00.000Z',
        endsAt: '2026-10-09T08:30:00.000Z',
        previousStartsAt: '2026-10-07T07:30:00.000Z',
        previousEndsAt: '2026-10-07T09:00:00.000Z',
      },
    },
  ]

  function withNotices(notices = NOTICES) {
    return stubApi({ booking: () => json({ booking: { ...BOOKING, notices } }) })
  }

  function region() {
    return within(screen.getByRole('region', { name: 'Updates about your booking' }))
  }

  it('lists them newest first, in words, with the photographer\u2019s note as plain text', async () => {
    withNotices()
    await renderLoaded()

    const items = region().getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('From your photographer: Bring a jacket.'),
      expect.stringContaining('30,000 RWF is still to pay.'),
      expect.stringContaining('Your session was moved to Friday, 9 October 2026, 09:00 to 10:30 (Kigali time).'),
    ])
    // Typed markup stays text.
    expect(items[0]?.querySelector('b')).toBeNull()
    expect(items[0]).toHaveTextContent('It gets cold <b>up there</b>.')
    expect(region().getByRole('link', { name: 'Pay now' })).toHaveAttribute('href', '#pay')
  })

  it('hides one when closed, and remembers it on this device', async () => {
    withNotices()
    await renderLoaded()

    await user().click(within(region().getAllByRole('listitem')[2] as HTMLElement).getByRole('button', { name: 'Dismiss' }))

    expect(region().getAllByRole('listitem')).toHaveLength(2)
    expect(JSON.parse(localStorage.getItem(`bookly.notices.${REFERENCE}`) ?? '{}')['outbox:o1']).toMatchObject({ dismissed: true })
  })

  it('stops showing a notice a day after it was first seen here, but never the money still owed', async () => {
    const aDayAgo = Date.now() - 24 * 60 * 60_000 - 1000
    localStorage.setItem(
      `bookly.notices.${REFERENCE}`,
      JSON.stringify({ 'note:n1': { firstSeenAt: aDayAgo }, 'balance:30000': { firstSeenAt: aDayAgo }, 'outbox:o1': { firstSeenAt: aDayAgo } }),
    )
    withNotices()
    await renderLoaded()

    expect(region().getAllByRole('listitem').map((item) => item.textContent)).toEqual([expect.stringContaining('30,000 RWF is still to pay.')])
  })

  it('renders nothing when there is nothing to show', async () => {
    withNotices([])
    await renderLoaded()

    expect(screen.queryByRole('region', { name: 'Updates about your booking' })).not.toBeInTheDocument()
  })

  it('still shows them when storage cannot be used', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    withNotices()
    await renderLoaded()

    expect(region().getAllByRole('listitem')).toHaveLength(3)
  })
})

// --- The contact email (2026-09-25) ---------------------------------------------------------

describe('the contact email', () => {
  function card() {
    return within(screen.getByRole('heading', { level: 2, name: 'Your email' }).closest('section') as HTMLElement)
  }

  async function changeTo(email: string) {
    await user().click(card().getByRole('button', { name: 'Change email' }))
    await user().type(card().getByLabelText('New email'), email)
    await user().click(card().getByRole('button', { name: 'Send the link' }))
  }

  it('shows the address it writes to, masked as the API sends it', async () => {
    stubApi()
    await renderLoaded()

    expect(card().getByText('We write to a•••••@example.com about this booking.')).toBeInTheDocument()
  })

  it('asks the new address to confirm, and says so, keeping the old one until then', async () => {
    const { emailBodies } = stubApi()
    await renderLoaded()

    await changeTo('aline.new@example.com')

    expect(emailBodies).toEqual([{ email: 'aline.new@example.com' }])
    expect(await card().findByRole('status')).toHaveTextContent(
      'Check aline.new@example.com for our link to confirm the change. Until then we keep writing to a•••••@example.com.',
    )
    expect(card().queryByLabelText('New email')).not.toBeInTheDocument()
  })

  it('shows a change still waiting on its confirmation', async () => {
    stubApi({ booking: () => json({ booking: { ...BOOKING, pendingMaskedEmail: 'n\u2022\u2022\u2022\u2022\u2022@example.com' } }) })
    await renderLoaded()

    expect(card().getByText(/Waiting for you to confirm n\u2022\u2022\u2022\u2022\u2022@example\.com/)).toBeInTheDocument()
  })

  it('marks a malformed address and sends nothing', async () => {
    const { emailBodies } = stubApi()
    await renderLoaded()

    await changeTo('nope')

    expect(card().getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(card().getByLabelText('New email')).toHaveAttribute('aria-invalid', 'true')
    expect(emailBodies).toEqual([])
  })

  it('says when it is already the address, and when the day\u2019s limit is reached', async () => {
    stubApi({ email: (body) => ((body as { email: string }).email === 'same@example.com' ? json({ booking: BOOKING }) : json({ error: 'too_many_requests' }, 429)) })
    await renderLoaded()

    await changeTo('same@example.com')
    expect(await card().findByText('That is already the email we write to.')).toBeInTheDocument()

    await changeTo('other@example.com')
    expect(await card().findByRole('alert')).toHaveTextContent('You have asked to change the email three times today.')
  })

  it('keeps the address when the form is closed', async () => {
    const { emailBodies } = stubApi()
    await renderLoaded()

    await user().click(card().getByRole('button', { name: 'Change email' }))
    await user().click(card().getByRole('button', { name: 'Keep this email' }))

    expect(card().queryByLabelText('New email')).not.toBeInTheDocument()
    expect(emailBodies).toEqual([])
  })

  it('is not offered on a booking that no longer stands', async () => {
    stubApi({ booking: () => json({ booking: CANCELLED }) })
    await renderLoaded()

    expect(screen.queryByRole('heading', { level: 2, name: 'Your email' })).not.toBeInTheDocument()
  })
})

// --- An invalid link ------------------------------------------------------------------------

describe('a link that is not valid', () => {
  it('shows the generic page and nothing at all about a booking', async () => {
    stubApi({ booking: () => json({ error: 'not_found' }, 404) })
    renderAt()

    expect(await screen.findByRole('heading', { level: 1, name: 'This link is not valid' })).toBeInTheDocument()
    expect(
      screen.getByText('Check that you opened the whole link from your email. If it has been replaced, use the most recent email we sent you.'),
    ).toBeInTheDocument()

    expect(screen.queryByText(REFERENCE)).not.toBeInTheDocument()
    expect(screen.queryByText('Your booking')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/Portraits|Kigali Heights|Aline|RWF|Confirmed|Cancel/)
    // Scoped to the page, as client-booking.spec.ts is: the shell's theme button (2026-09-27) is chrome.
    expect(within(screen.getByRole('main')).queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers a way to get a new link by email, as a link (2026-09-25)', async () => {
    stubApi({ booking: () => json({ error: 'not_found' }, 404) })
    renderAt()

    await screen.findByRole('heading', { level: 1, name: 'This link is not valid' })
    const main = within(screen.getByRole('main'))
    expect(main.getByRole('link', { name: 'Get a new link by email' })).toHaveAttribute('href', '/my-booking')
  })

  it.each([
    ['an unknown token', `/booking/${TOKEN}`],
    ['an expired token', '/booking/expired-token-0123456789abcdef'],
    ['a token a resend replaced', '/booking/replaced-token-0123456789'],
  ])('is the same page for %s: the API says only 404', async (_case, path) => {
    stubApi({ booking: () => json({ error: 'not_found' }, 404) })
    renderAt(path)

    expect(await screen.findByRole('heading', { level: 1, name: 'This link is not valid' })).toBeInTheDocument()
    expect(screen.queryByText(REFERENCE)).not.toBeInTheDocument()
  })
})

// --- Amounts come from the server ------------------------------------------------------------

describe('the amounts (data-model_v2.md §6.1)', () => {
  it('are exactly what the API sent, line by line', async () => {
    stubApi()
    await renderLoaded()

    expect(valueOf('Standard')).toBe('40,000 RWF')
    expect(valueOf('Extra hour')).toBe('10,000 RWF')
    expect(valueOf('Total')).toBe('50,000 RWF')
    expect(valueOf('Paid')).toBe('20,000 RWF')
    expect(valueOf('Still to pay')).toBe('30,000 RWF')
    expect(screen.queryByText('Refund due to you')).not.toBeInTheDocument()
  })

  it('follow the API rather than any sum of their own: impossible numbers are printed as sent', async () => {
    // Nothing on this page could arrive at these by adding the lines up.
    stubApi({
      booking: () =>
        json({
          booking: {
            ...BOOKING,
            packagePriceRwf: 40_000,
            addons: [{ name: 'Extra hour', priceRwf: 10_000, stage: 'at_booking' }],
            totals: { quotedTotalRwf: 1, grandTotalRwf: 777, collectedRwf: 12_345, refundDueRwf: 99, outstandingRwf: 3 },
            sessionFee: { outstandingRwf: 3, waitingPayment: null },
          },
        }),
    })
    await renderLoaded()

    expect(valueOf('Total')).toBe('777 RWF')
    expect(valueOf('Paid')).toBe('12,345 RWF')
    expect(valueOf('Still to pay')).toBe('3 RWF')
    expect(valueOf('Refund due to you')).toBe('99 RWF')
    expect(payButton()).toHaveTextContent('Pay 3 RWF')
  })

  it('show nothing outstanding for a cancelled booking, as the API computes it', async () => {
    stubApi({ booking: () => json({ booking: CANCELLED }) })
    await renderLoaded()

    expect(valueOf('Still to pay')).toBe('0 RWF')
    expect(valueOf('Refund due to you')).toBe('30,000 RWF')
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument()
  })

  it('show nothing outstanding for a no-show, as the API computes it', async () => {
    stubApi({
      booking: () =>
        json({ booking: { ...BOOKING, status: 'no_show', stage: 'no_show', canCancel: false, sessionFee: null, totals: { ...BOOKING.totals, outstandingRwf: 0 } } }),
    })
    await renderLoaded()

    expect(valueOf('Still to pay')).toBe('0 RWF')
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument()
  })
})

// --- The payment control -------------------------------------------------------------------

describe('the session fee (plan.md Task 18)', () => {
  it('is offered while something is outstanding, naming the amount the API gave', async () => {
    stubApi()
    await renderLoaded()

    expect(screen.getByRole('heading', { level: 2, name: 'Pay the rest' })).toBeInTheDocument()
    expect(screen.getByText('30,000 RWF is still to pay for this shoot.')).toBeInTheDocument()
    expect(payButton()).toHaveTextContent('Pay 30,000 RWF')
    expect(screen.getByRole('radio', { name: 'MTN MoMo' })).toBeChecked()
  })

  it('is absent for a booking paid in full', async () => {
    stubApi({ booking: () => json({ booking: PAID }) })
    await renderLoaded()

    expect(screen.queryByRole('heading', { name: 'Pay the rest' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(valueOf('Still to pay')).toBe('0 RWF')
  })

  it('offers exactly the methods the API lists, and no others (spec §6.19)', async () => {
    stubApi()
    await renderLoaded()

    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect(screen.queryByRole('radio', { name: 'Airtel Money' })).not.toBeInTheDocument()
    expect(document.querySelector('input[value="momo_airtel"], input[value="card"]')).toBeNull()
  })

  it('says online payment is not available when the API lists no method it can name', async () => {
    stubApi({ methods: () => json({ methods: [] }) })
    await renderLoaded()

    expect(screen.getByRole('alert')).toHaveTextContent('Online payment is not available right now. Please try again later.')
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument()
  })

  it('links an attempt already waiting to its progress page, while still offering to pay', async () => {
    stubApi({ booking: () => json({ booking: { ...BOOKING, sessionFee: { outstandingRwf: 30_000, waitingPayment: { ourRef: OUR_REF } } } }) })
    await renderLoaded()

    expect(screen.getByText(/A payment request is already waiting on your phone\./)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Follow that payment' })).toHaveAttribute('href', `${PATH}/payments/${OUR_REF}`)
    expect(payButton()).toBeInTheDocument()
  })

  it('sends the method and the number, trimmed, and moves to the payment’s progress page', async () => {
    const { payBodies } = stubApi()
    const router = await renderLoaded()

    await user().type(phoneField(), '  078 812 3456 ')
    await user().click(payButton())

    expect(await screen.findByRole('heading', { level: 1, name: 'Approve the payment on your phone' })).toBeInTheDocument()
    expect(payBodies).toStrictEqual([{ method: 'momo_mtn', phone: '078 812 3456' }])
    expect(router.state.location.pathname).toBe(`${PATH}/payments/${OUR_REF}`)
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

  it.each(['', '   ', 'abc', '12345'])('marks and focuses an unreadable number "%s" without a request', async (typed) => {
    const { payBodies } = stubApi()
    await renderLoaded()

    if (typed !== '') await user().type(phoneField(), typed)
    await user().click(payButton())

    expect(phoneField()).toHaveAttribute('aria-invalid', 'true')
    expect(phoneField()).toHaveFocus()
    expect(screen.getByText('Enter the phone number of your Mobile Money account.')).toBeInTheDocument()
    expect(payBodies).toEqual([])
  })

  it('sends one request however often Pay is pressed', async () => {
    let answer: (res: Response) => void = () => {}
    const { payBodies } = stubApi({ pay: () => new Promise<Response>((resolve) => (answer = resolve)) })
    await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    const busy = screen.getByRole('button', { name: 'Sending the request…' })
    expect(busy).toHaveAttribute('aria-busy', 'true')
    await user().click(busy)
    await user().click(busy)
    expect(payBodies).toHaveLength(1)

    await act(async () => answer(json({ payment: { ourRef: OUR_REF } }, 201)))
    expect(await screen.findByRole('heading', { name: 'Approve the payment on your phone' })).toBeInTheDocument()
  })

  it.each([
    ['rejected', 'Mobile Money did not accept the request. Check that the number has a Mobile Money account, then try again.'],
    ['unavailable', 'We could not reach Mobile Money just now. Please try again in a moment.'],
  ])('shows the checkout’s own alert when the provider %s the request, and lets the client try again', async (reason, words) => {
    const { payBodies } = stubApi({
      pay: (_body, call) =>
        call === 1
          ? json({ error: 'payment_not_started', reason, payment: { ourRef: OUR_REF, status: 'failed' } }, 502)
          : json({ payment: { ourRef: OUR_REF } }, 201),
    })
    const router = await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(words)
    expect(router.state.location.pathname).toBe(PATH)
    expect(phoneField()).toHaveValue('0788123456')

    await user().click(payButton())
    await screen.findByRole('heading', { name: 'Approve the payment on your phone' })
    expect(payBodies).toHaveLength(2)
  })

  it('shows the connection alert when the API cannot be reached', async () => {
    stubApi({ pay: () => Promise.reject(new TypeError('Failed to fetch')) })
    await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('The payment did not start. Check your connection and try again.')
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

  it('reloads when the API says there is nothing left to pay, and the control goes', async () => {
    const { calls } = stubApi({
      booking: (call) => json({ booking: call === 1 ? BOOKING : PAID }),
      pay: () => json({ error: 'nothing_to_pay', booking: PAID }, 409),
    })
    await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    await vi.waitFor(() => expect(calls.filter((call) => call === `GET ${BOOKING_API}`)).toHaveLength(2))
    await screen.findByRole('heading', { level: 1, name: 'Your booking' })
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument()
    expect(valueOf('Still to pay')).toBe('0 RWF')
  })

  it('shows the invalid-link page when the API no longer knows the booking', async () => {
    stubApi({ pay: () => json({ error: 'not_found' }, 404) })
    await renderLoaded()

    await user().type(phoneField(), '0788123456')
    await user().click(payButton())

    expect(await screen.findByRole('heading', { level: 1, name: 'This link is not valid' })).toBeInTheDocument()
    expect(screen.queryByText(REFERENCE)).not.toBeInTheDocument()
  })
})

// --- Cancelling ------------------------------------------------------------------------------

describe('cancelling (spec §6.10)', () => {
  it('shows the non-refundable warning, naming the fee, before anything is sent', async () => {
    const { calls } = stubApi()
    await renderLoaded()

    expect(screen.queryByText(/not refunded/)).not.toBeInTheDocument()
    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))

    expect(
      screen.getByText('If you cancel, your booking fee of 20,000 RWF is not refunded, and the time is released for someone else to book.'),
    ).toBeInTheDocument()
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([])
    expect(screen.getByRole('button', { name: 'Yes, cancel my booking' })).toHaveFocus()
  })

  it('names the fee the API gave, not one of its own', async () => {
    stubApi({ booking: () => json({ booking: { ...BOOKING, bookingFeeRwf: 17_777 } }) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))

    expect(screen.getByText(/your booking fee of 17,777 RWF is not refunded/)).toBeInTheDocument()
  })

  it('can be backed out of, sending nothing', async () => {
    const { calls } = stubApi()
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))
    await user().click(screen.getByRole('button', { name: 'Keep my booking' }))

    expect(screen.queryByText(/is not refunded/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel this booking' })).toBeInTheDocument()
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([])
  })

  it('cancels on confirming, and then shows the cancelled booking with the refund owed', async () => {
    const { calls, cancelRequests } = stubApi()
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))
    await user().click(screen.getByRole('button', { name: 'Yes, cancel my booking' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'This booking is cancelled' })).toBeInTheDocument()
    expect(screen.getByText('You are owed 30,000 RWF back. The photographer will contact you to arrange it.')).toBeInTheDocument()
    expect(screen.getByText('Cancelled by you')).toBeInTheDocument()
    expect(valueOf('Still to pay')).toBe('0 RWF')
    expect(calls).toContain(`POST ${BOOKING_API}/cancel`)
    expect(cancelRequests[0]?.body).toBeUndefined()
    expect(screen.queryByRole('button', { name: 'Cancel this booking' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument()
  })

  // The confirm button is unmounted by its own success, so without this focus falls to the body
  // and a screen reader is told nothing at all: the page silently becomes a different page.
  it('moves focus to the heading of the section that replaces the cancel button', async () => {
    stubApi()
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))
    await user().click(screen.getByRole('button', { name: 'Yes, cancel my booking' }))

    const heading = await screen.findByRole('heading', { level: 2, name: 'This booking is cancelled' })
    expect(heading).toHaveFocus()
    expect(document.body).not.toHaveFocus()
  })

  it('shows no refund line when nothing is owed back', async () => {
    stubApi({ cancel: () => json({ booking: { ...CANCELLED, totals: { ...CANCELLED.totals, refundDueRwf: 0 } } }) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))
    await user().click(screen.getByRole('button', { name: 'Yes, cancel my booking' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'This booking is cancelled' })).toBeInTheDocument()
    expect(screen.queryByText(/You are owed/)).not.toBeInTheDocument()
  })

  it('shows the photographer’s reason when they were the one who cancelled', async () => {
    stubApi({
      booking: () =>
        json({ booking: { ...CANCELLED, status: 'cancelled_by_admin', stage: 'cancelled_by_admin', cancellationReason: 'The photographer is unwell.' } }),
    })
    await renderLoaded()

    expect(screen.getByText('The photographer is unwell.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'This booking is cancelled' })).toBeInTheDocument()
  })

  it('is not offered at all when the API says the booking can no longer be cancelled', async () => {
    stubApi({ booking: () => json({ booking: { ...BOOKING, canCancel: false } }) })
    await renderLoaded()

    expect(screen.queryByRole('button', { name: 'Cancel this booking' })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('is not refunded')
  })

  it('says so when the API refuses the cancellation and sends no booking back', async () => {
    stubApi({ cancel: () => json({ error: 'not_cancellable' }, 409) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))
    await user().click(screen.getByRole('button', { name: 'Yes, cancel my booking' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This booking can no longer be cancelled. Contact the photographer if you need to change it.',
    )
    expect(screen.getByText(REFERENCE)).toBeInTheDocument()
  })

  // Fails today: on a 409 the page calls `onCancelled(result.booking)` and then `setError`, but the
  // booking it was handed has `canCancel: false`, so `{booking.canCancel && <Cancel .../>}` unmounts
  // the whole section -- error and all -- in the same render. The client presses "Yes, cancel my
  // booking", the section silently disappears, and nothing says why the booking was not cancelled.
  it('says why when the API refuses the cancellation and returns the booking it refused', async () => {
    stubApi({ cancel: () => json({ error: 'not_cancellable', booking: { ...BOOKING, canCancel: false } }, 409) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))
    await user().click(screen.getByRole('button', { name: 'Yes, cancel my booking' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This booking can no longer be cancelled. Contact the photographer if you need to change it.',
    )
  })

  it('shows the invalid-link page when the API no longer knows the booking', async () => {
    stubApi({ cancel: () => json({ error: 'not_found' }, 404) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))
    await user().click(screen.getByRole('button', { name: 'Yes, cancel my booking' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'This link is not valid' })).toBeInTheDocument()
  })

  it('says the connection failed, and keeps the booking, when the API cannot be reached', async () => {
    stubApi({ cancel: () => Promise.reject(new TypeError('Failed to fetch')) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))
    await user().click(screen.getByRole('button', { name: 'Yes, cancel my booking' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not cancel your booking. Check your connection and try again.')
    expect(screen.getByText(REFERENCE)).toBeInTheDocument()
  })

  it('sends one request however often the confirmation is pressed', async () => {
    let answer: (res: Response) => void = () => {}
    const { calls } = stubApi({ cancel: () => new Promise<Response>((resolve) => (answer = resolve)) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))
    await user().click(screen.getByRole('button', { name: 'Yes, cancel my booking' }))

    const busy = screen.getByRole('button', { name: 'Cancelling…' })
    await user().click(busy)
    await user().click(busy)
    expect(calls.filter((call) => call === `POST ${BOOKING_API}/cancel`)).toHaveLength(1)

    await act(async () => answer(json({ booking: CANCELLED })))
    expect(await screen.findByRole('heading', { level: 2, name: 'This booking is cancelled' })).toBeInTheDocument()
  })
})

// --- Delivery ---------------------------------------------------------------------------------

describe('the photos (spec §6.20)', () => {
  it('offers the link, its date and the note once they are sent', async () => {
    stubApi({
      booking: () =>
        json({
          booking: {
            ...PAID,
            delivery: { url: 'https://photos.example-host.com/s/abc123', expiresOn: '2027-01-01', expired: false, note: 'Thank you!' },
          },
        }),
    })
    await renderLoaded()

    const link = screen.getByRole('link', { name: 'Open your photos' })
    expect(link).toHaveAttribute('href', 'https://photos.example-host.com/s/abc123')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
    expect(screen.getByText('This link works until Friday, 1 January 2027.')).toBeInTheDocument()
    expect(screen.getByText('Thank you!')).toBeInTheDocument()
  })

  it('shows the expired notice and no dead link once the API says it has expired', async () => {
    stubApi({
      booking: () => json({ booking: { ...PAID, delivery: { url: null, expiresOn: '2026-01-01', expired: true, note: null } } }),
    })
    await renderLoaded()

    expect(screen.getByText('This link has expired. Contact the photographer for a new one.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open your photos' })).not.toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain('photos.example-host.com')
  })

  it('shows nothing about photos before they are sent', async () => {
    stubApi({ booking: () => json({ booking: PAID }) })
    await renderLoaded()

    expect(screen.queryByRole('heading', { name: 'Your photos' })).not.toBeInTheDocument()
  })

  /**
   * The one link on this page that leaves the site: it opens the
   * photographer's own host (spec A-7), in its own tab, and carries neither the
   * referrer nor a handle back to this window.
   */
  it('opens the external host in a new tab, with no referrer and no opener', async () => {
    stubApi({
      booking: () =>
        json({
          booking: {
            ...PAID,
            delivery: { url: 'https://photos.example-host.com/s/abc123', expiresOn: '2027-01-01', expired: false, note: null },
          },
        }),
    })
    await renderLoaded()

    const link = screen.getByRole('link', { name: 'Open your photos' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer noopener')
  })

  it('states whatever expiry date the API sent, in words', async () => {
    stubApi({
      booking: () =>
        json({
          booking: {
            ...PAID,
            delivery: { url: 'https://photos.example-host.com/s/abc123', expiresOn: '2027-03-15', expired: false, note: null },
          },
        }),
    })
    await renderLoaded()

    expect(screen.getByText('This link works until Monday, 15 March 2027.')).toBeInTheDocument()
  })

  it('says nothing about a date the API did not set', async () => {
    stubApi({
      booking: () =>
        json({
          booking: {
            ...PAID,
            delivery: { url: 'https://photos.example-host.com/s/abc123', expiresOn: null, expired: false, note: null },
          },
        }),
    })
    await renderLoaded()

    expect(screen.getByRole('link', { name: 'Open your photos' })).toBeInTheDocument()
    expect(screen.queryByText(/This link works until/)).not.toBeInTheDocument()
  })

  it('keeps the photographer’s note beside the expired notice, so they know who to ask', async () => {
    stubApi({
      booking: () =>
        json({
          booking: { ...PAID, delivery: { url: null, expiresOn: '2026-01-01', expired: true, note: 'Ask me any time.' } },
        }),
    })
    await renderLoaded()

    const photos = screen.getByRole('heading', { name: 'Your photos' }).closest('section')
    expect(photos).toHaveTextContent('Ask me any time.')
    expect(photos).toHaveTextContent('This link has expired. Contact the photographer for a new one.')
  })

  /** The files live on someone else's host, so nothing here can count a download (data-model_v2.md §5.9). */
  it('never tells the client how many times the photos were downloaded', async () => {
    stubApi({
      booking: () =>
        json({
          booking: {
            ...PAID,
            delivery: { url: 'https://photos.example-host.com/s/abc123', expiresOn: '2027-01-01', expired: false, note: 'Thank you!' },
          },
        }),
    })
    await renderLoaded()

    const photos = screen.getByRole('heading', { name: 'Your photos' }).closest('section')
    expect(photos?.textContent ?? '').not.toMatch(/downloaded|downloads|times/i)
  })
})

// --- Failing to load ----------------------------------------------------------------------------

describe('a load that fails', () => {
  it('shows an alert and loads again on Try again', async () => {
    stubApi({ booking: (call) => (call === 1 ? json({ error: 'internal_error' }, 500) : json({ booking: BOOKING })) })
    renderAt()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('We could not load your booking. Check your connection and try again.')
    expect(screen.queryByRole('heading', { name: 'This link is not valid' })).not.toBeInTheDocument()

    await user().click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Your booking' })).toBeInTheDocument()
  })

  it('shows the alert when the API cannot be reached, and never the invalid-link page', async () => {
    stubApi({ booking: () => Promise.reject(new TypeError('Failed to fetch')) })
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load your booking.')
    expect(screen.queryByRole('heading', { name: 'This link is not valid' })).not.toBeInTheDocument()
  })

  it('still shows the booking when only the methods cannot be loaded, offering no payment form', async () => {
    stubApi({ methods: () => Promise.reject(new TypeError('Failed to fetch')) })
    await renderLoaded()

    expect(screen.getByText(REFERENCE)).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Online payment is not available right now.')
  })

  it('reports the failure with the token scrubbed out of it', async () => {
    const logged: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line))
    })
    stubApi({ booking: () => Promise.reject(new TypeError(`Failed to fetch /api/booking/${TOKEN}`)) })
    renderAt()

    await screen.findByRole('alert')

    expect(logged.join('\n')).not.toContain(TOKEN)
  })
})

// --- The address ---------------------------------------------------------------------------------

describe('the address', () => {
  it('has nothing below a payment page: a deeper path is not found', () => {
    stubApi()
    renderAt(`${PATH}/payments/${OUR_REF}/extra`)

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })

  it('follows a session-fee payment on the same progress page the checkout uses', async () => {
    stubApi()
    renderAt(`${PATH}/payments/${OUR_REF}`)

    await screen.findByRole('heading', { level: 1, name: 'Approve the payment on your phone' })
    expect(screen.getByText('We have sent a request for 30,000 RWF to your phone. Enter your Mobile Money PIN to approve it.')).toBeInTheDocument()
    expect(screen.queryByText('Your booking is confirmed')).not.toBeInTheDocument()
  })

  it('sends a failed session fee’s Try again back to the booking, never to a checkout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.startsWith('/api/payments/')) {
          return json({
            payment: { status: 'failed', amountRwf: 30_000, failure: 'declined' },
            booking: PENDING_PROGRESS.booking,
          })
        }
        return json({ error: 'not_found' }, 404)
      }),
    )
    renderAt(`${PATH}/payments/${OUR_REF}`)

    await screen.findByRole('heading', { level: 1, name: 'The payment did not go through' })

    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', PATH)
  })
})
