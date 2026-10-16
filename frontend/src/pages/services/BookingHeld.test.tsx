import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import type { HeldBooking } from '@/catalogue/bookings'
import { BookingHeld } from './BookingHeld'

/**
 * The page a visitor lands on once their booking holds its slot (plan.md Task
 * 13, spec §3.1 step 8): the reference, what and when in Kigali time, the
 * package and add-on lines, and the amounts exactly as the API froze them --
 * never recomputed -- with the fee's percentage read off the booking's own
 * rate, how long the hold lasts, and the non-refundable notice. Focus moves to
 * its heading, since the form the visitor submitted is gone.
 *
 * With the payment adapter (plan.md Task 16): the way to pay is a link to the
 * booking’s checkout, addressed by the checkout token the API sent, and it is
 * absent when the API sent none.
 */

const HELD: HeldBooking = {
  reference: 'BKY-2610-7K3QX',
  status: 'pending_payment',
  startsAt: '2026-10-07T07:30:00.000Z',
  endsAt: '2026-10-07T09:00:00.000Z',
  holdExpiresAt: '2026-10-01T06:30:00.000Z',
  serviceName: 'Portraits',
  packageName: 'Standard',
  packagePriceRwf: 40_000,
  addons: [{ name: 'Extra hour', priceRwf: 10_000 }],
  totalRwf: 50_000,
  bookingFeeRate: 0.4,
  bookingFeeRwf: 20_000,
  sessionFeeRwf: 30_000,
}

const NOTICE = 'The booking fee is non-refundable if you cancel.'

/** Every term and its value, in the order they render. */
function lines(): [string, string][] {
  return Array.from(document.querySelectorAll('dt')).map((term) => [term.textContent ?? '', term.nextElementSibling?.textContent ?? ''])
}

describe('the held booking', () => {
  it('lists the reference, the service, when, each line and the amounts, in that order', () => {
    render(<BookingHeld booking={HELD} />)

    expect(lines()).toEqual([
      ['Booking reference', 'BKY-2610-7K3QX'],
      ['Service', 'Portraits, Standard'],
      ['When', 'Wednesday, 7 October 2026, 09:30 to 11:00, Kigali time'],
      ['Standard', '40,000 RWF'],
      ['Extra hour', '10,000 RWF'],
      ['Total', '50,000 RWF'],
      ['Booking fee (40%), paid now to secure your date', '20,000 RWF'],
      ['Session fee, due after the shoot', '30,000 RWF'],
    ])
  })

  it('has a level-1 heading that takes focus on arrival', () => {
    render(<BookingHeld booking={HELD} />)

    const heading = screen.getByRole('heading', { level: 1, name: 'Your time is held' })
    expect(heading).toHaveFocus()
    expect(heading).toHaveAttribute('tabindex', '-1')
  })

  it('shows the amounts the API sent, never its own arithmetic', () => {
    // Deliberately inconsistent: a browser recomputing anything would show other numbers.
    render(
      <BookingHeld
        booking={{ ...HELD, packagePriceRwf: 41_111, addons: [{ name: 'Extra hour', priceRwf: 2_222 }], totalRwf: 12_345, bookingFeeRwf: 6_789, sessionFeeRwf: 1_111 }}
      />,
    )

    expect(lines().slice(3)).toEqual([
      ['Standard', '41,111 RWF'],
      ['Extra hour', '2,222 RWF'],
      ['Total', '12,345 RWF'],
      ['Booking fee (40%), paid now to secure your date', '6,789 RWF'],
      ['Session fee, due after the shoot', '1,111 RWF'],
    ])
  })

  it.each([
    [0.375, '37.5%'],
    [0.3, '30%'],
    [0.175, '17.5%'],
    [0, '0%'],
    [1, '100%'],
  ])('reads the fee rate %s as %s', (bookingFeeRate, percent) => {
    render(<BookingHeld booking={{ ...HELD, bookingFeeRate }} />)

    expect(screen.getByText(`Booking fee (${percent}), paid now to secure your date`)).toBeInTheDocument()
  })

  it('lists every add-on, including two with the same name, and none when there are none', () => {
    const { unmount } = render(
      <BookingHeld
        booking={{ ...HELD, addons: [{ name: 'Print', priceRwf: 1_000 }, { name: 'Print', priceRwf: 2_000 }, { name: 'Rush edit', priceRwf: 5_000 }] }}
      />,
    )
    expect(lines().slice(3, 7)).toEqual([
      ['Standard', '40,000 RWF'],
      ['Print', '1,000 RWF'],
      ['Print', '2,000 RWF'],
      ['Rush edit', '5,000 RWF'],
    ])
    unmount()

    render(<BookingHeld booking={{ ...HELD, addons: [] }} />)
    expect(lines().map(([term]) => term)).toEqual([
      'Booking reference',
      'Service',
      'When',
      'Standard',
      'Total',
      'Booking fee (40%), paid now to secure your date',
      'Session fee, due after the shoot',
    ])
  })

  it('says until when the time is held, in Kigali time, and what to pay by then', () => {
    render(<BookingHeld booking={HELD} />)

    expect(
      screen.getByText(
        'We are holding this time for you until 08:30, Kigali time. Pay the booking fee of 20,000 RWF before then to confirm your booking; after that, the time is released for others to book.',
      ),
    ).toBeInTheDocument()
  })

  it('still says the time is held, without a clock time, when the API gives no expiry', () => {
    render(<BookingHeld booking={{ ...HELD, holdExpiresAt: null }} />)

    expect(
      screen.getByText('We are holding this time for you for a short while. Pay the booking fee of 20,000 RWF to confirm your booking.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/until/)).not.toBeInTheDocument()
  })

  it('states the booking fee is non-refundable', () => {
    render(<BookingHeld booking={HELD} />)

    expect(screen.getByText(NOTICE)).toBeInTheDocument()
  })

  it('reads the date on the Kigali calendar when the UTC date is still the day before', () => {
    // 22:30Z on the 7th is 00:30 on Thursday the 8th in Kigali.
    render(<BookingHeld booking={{ ...HELD, startsAt: '2026-10-07T22:30:00.000Z', endsAt: '2026-10-08T00:00:00.000Z', holdExpiresAt: '2026-10-07T21:50:00.000Z' }} />)

    expect(lines()[2]).toEqual(['When', 'Thursday, 8 October 2026, 00:30 to 02:00, Kigali time'])
    expect(screen.getByText(/until 23:50, Kigali time/)).toBeInTheDocument()
  })

  it('renders Kigali times whatever the browser’s own zone', () => {
    const original = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      render(<BookingHeld booking={HELD} />)

      expect(lines()[2]).toEqual(['When', 'Wednesday, 7 October 2026, 09:30 to 11:00, Kigali time'])
      expect(screen.getByText(/until 08:30, Kigali time/)).toBeInTheDocument()
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })
})

describe('the way to pay (plan.md Task 16)', () => {
  const TOKEN = 'aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJeLmNoPqRs'

  function renderInRouter(booking: HeldBooking) {
    const router = createMemoryRouter(
      [
        { path: '/services/portraits', element: <BookingHeld booking={booking} /> },
        { path: '/checkout/:reference/:token', element: <h1>Checkout page</h1> },
      ],
      { initialEntries: ['/services/portraits'] },
    )
    render(<RouterProvider router={router} />)
    return router
  }

  it('links to the booking’s checkout, /checkout/<reference>/<token>, when the API sent a checkout token', () => {
    renderInRouter({ ...HELD, checkoutToken: TOKEN })

    expect(screen.getByRole('link', { name: 'Pay the booking fee' })).toHaveAttribute('href', `/checkout/BKY-2610-7K3QX/${TOKEN}`)
  })

  it('offers no way to pay without a checkout token', () => {
    renderInRouter(HELD)

    expect(screen.queryByRole('link', { name: 'Pay the booking fee' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pay the booking fee' })).not.toBeInTheDocument()
  })

  it('opens the checkout page when followed', async () => {
    const router = renderInRouter({ ...HELD, checkoutToken: TOKEN })

    await userEvent.setup({ delay: null }).click(screen.getByRole('link', { name: 'Pay the booking fee' }))

    expect(await screen.findByRole('heading', { name: 'Checkout page' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(`/checkout/BKY-2610-7K3QX/${TOKEN}`)
  })

  it('encodes the reference and token into the link', () => {
    renderInRouter({ ...HELD, reference: 'BKY/2610', checkoutToken: 'a?b#c' })

    expect(screen.getByRole('link', { name: 'Pay the booking fee' })).toHaveAttribute('href', '/checkout/BKY%2F2610/a%3Fb%23c')
  })

  it('still states the fee is non-refundable beside the way to pay', () => {
    renderInRouter({ ...HELD, checkoutToken: TOKEN })

    expect(screen.getByText(NOTICE)).toBeInTheDocument()
  })
})
