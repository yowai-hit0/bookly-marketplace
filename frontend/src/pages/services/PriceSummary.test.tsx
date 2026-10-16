import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { PriceSummary } from './PriceSummary'

/**
 * The running total (plan.md Task 11; spec §3.1 steps 3 and 7, A-4b).
 *
 * What is proven: the two plan.md baskets render their total, booking fee with
 * its percentage and session fee; nothing is priced before a package is chosen;
 * the non-refundable notice is there in every state and precedes anything
 * rendered after it -- where a payment control will go; and no processing-fee
 * line appears in any state.
 */

const STANDARD = { id: 'p1', nameEn: 'Standard', priceRwf: 40_000 }
const EXTRA_HOUR = { id: 'a1', nameEn: 'Extra hour', priceRwf: 10_000 }
const RUSH_EDIT = { id: 'a2', nameEn: 'Rush edit', priceRwf: 5_000 }

const NOTICE = 'The booking fee is non-refundable if you cancel.'
const PROMPT = 'Choose a package to see your total.'

function summary(): HTMLElement {
  return screen.getByRole('region', { name: 'Price summary' })
}

/** The amount on the line whose term reads `label`. */
function amount(label: string | RegExp): string {
  const term = within(summary()).getByText(label, { selector: 'dt' })
  return term.nextElementSibling?.textContent ?? ''
}

/** Every term and its amount, in the order they render. */
function lines(): [string, string][] {
  return Array.from(summary().querySelectorAll('dt')).map((term) => [
    term.textContent ?? '',
    term.nextElementSibling?.textContent ?? '',
  ])
}

describe('PriceSummary', () => {
  it('shows a 40,000 package plus a 10,000 add-on at 40% as 50,000 total, 20,000 now and 30,000 after', () => {
    render(<PriceSummary pkg={STANDARD} addons={[EXTRA_HOUR]} bookingFeeRate={0.4} />)

    expect(lines()).toEqual([
      ['Standard', '40,000 RWF'],
      ['Extra hour', '10,000 RWF'],
      ['Total', '50,000 RWF'],
      ['Booking fee (40%), paid now to secure your date', '20,000 RWF'],
      ['Session fee, due after the shoot', '30,000 RWF'],
    ])
    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument()
  })

  it('shows 15,000 at 30% and 35,000 after on the same 50,000 basket for a service overriding the rate to 0.300', () => {
    render(<PriceSummary pkg={STANDARD} addons={[EXTRA_HOUR]} bookingFeeRate={0.3} />)

    expect(amount('Total')).toBe('50,000 RWF')
    expect(amount('Booking fee (30%), paid now to secure your date')).toBe('15,000 RWF')
    expect(amount('Session fee, due after the shoot')).toBe('35,000 RWF')
  })

  it('shows a fractional percentage and rounds the fee half-up in exact arithmetic', () => {
    // 92,500 × 37.5% is exactly 34,687.5: half-up is 34,688.
    render(<PriceSummary pkg={{ id: 'p', nameEn: 'Signature', priceRwf: 80_000 }} addons={[{ id: 'a', nameEn: 'Prints', priceRwf: 12_500 }]} bookingFeeRate={0.375} />)

    expect(amount('Booking fee (37.5%), paid now to secure your date')).toBe('34,688 RWF')
    expect(amount('Session fee, due after the shoot')).toBe('57,812 RWF')
  })

  it('prices the float-trap basket exactly: 5,500 at 17.5% is 963 now, not 962', () => {
    render(<PriceSummary pkg={{ id: 'p', nameEn: 'Mini', priceRwf: 5_000 }} addons={[{ id: 'a', nameEn: 'Print', priceRwf: 500 }]} bookingFeeRate={0.175} />)

    expect(amount('Total')).toBe('5,500 RWF')
    expect(amount('Booking fee (17.5%), paid now to secure your date')).toBe('963 RWF')
    expect(amount('Session fee, due after the shoot')).toBe('4,537 RWF')
  })

  it('shows a package alone, and lists several add-ons in the order given', () => {
    const { rerender } = render(<PriceSummary pkg={STANDARD} addons={[]} bookingFeeRate={0.4} />)

    expect(lines().map(([term]) => term)).toEqual([
      'Standard',
      'Total',
      'Booking fee (40%), paid now to secure your date',
      'Session fee, due after the shoot',
    ])
    expect(amount('Total')).toBe('40,000 RWF')

    rerender(<PriceSummary pkg={STANDARD} addons={[RUSH_EDIT, EXTRA_HOUR]} bookingFeeRate={0.4} />)

    expect(lines().slice(0, 3)).toEqual([
      ['Standard', '40,000 RWF'],
      ['Rush edit', '5,000 RWF'],
      ['Extra hour', '10,000 RWF'],
    ])
    expect(amount('Total')).toBe('55,000 RWF')
    expect(amount(/^Booking fee/)).toBe('22,000 RWF')
  })

  it('shows the prompt and no amounts before a package is chosen, even with add-ons ticked', () => {
    render(<PriceSummary pkg={null} addons={[EXTRA_HOUR]} bookingFeeRate={0.4} />)

    expect(within(summary()).getByText(PROMPT)).toBeInTheDocument()
    expect(summary().querySelectorAll('dt')).toHaveLength(0)
    expect(summary()).not.toHaveTextContent(/RWF/)
    expect(summary()).not.toHaveTextContent(/Total|Booking fee \(|Session fee/)
  })

  it('announces changes to the amounts politely', () => {
    render(<PriceSummary pkg={STANDARD} addons={[]} bookingFeeRate={0.4} />)

    const live = summary().querySelector('[aria-live]')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent('40,000 RWF')
  })
})

// --- The non-refundable notice (plan.md Task 11) ----------------------------------------------

describe('the non-refundable notice', () => {
  it.each([
    ['before a package is chosen', null, [], 0.4],
    ['with a package alone', STANDARD, [], 0.4],
    ['with a package and add-ons', STANDARD, [EXTRA_HOUR, RUSH_EDIT], 0.4],
    ['at a 0% booking fee', STANDARD, [EXTRA_HOUR], 0],
    ['at a 100% booking fee', STANDARD, [EXTRA_HOUR], 1],
  ] as const)('is shown %s', (_state, pkg, addons, bookingFeeRate) => {
    render(<PriceSummary pkg={pkg} addons={addons} bookingFeeRate={bookingFeeRate} />)

    expect(within(summary()).getByText(NOTICE)).toBeVisible()
  })

  it('comes after the amounts and before anything passed as children, such as a payment control', () => {
    render(
      <PriceSummary pkg={STANDARD} addons={[EXTRA_HOUR]} bookingFeeRate={0.4}>
        <button type="button">Pay booking fee</button>
      </PriceSummary>,
    )

    const notice = within(summary()).getByText(NOTICE)
    const pay = within(summary()).getByRole('button', { name: 'Pay booking fee' })
    const total = within(summary()).getByText('Total')

    expect(notice.compareDocumentPosition(pay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(pay.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(total.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Not nested: the notice is a sibling that ends before the control begins.
    expect(notice.contains(pay)).toBe(false)
  })

  it('precedes children in the no-package state too', () => {
    render(
      <PriceSummary pkg={null} addons={[]} bookingFeeRate={0.4}>
        <a href="#pay">Continue to payment</a>
      </PriceSummary>,
    )

    const notice = screen.getByText(NOTICE)
    const link = screen.getByRole('link', { name: 'Continue to payment' })
    expect(notice.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('is reached before a child control when tabbing through the page', () => {
    render(
      <PriceSummary pkg={STANDARD} addons={[]} bookingFeeRate={0.4}>
        <button type="button">Pay booking fee</button>
      </PriceSummary>,
    )

    // The child is the first focusable element: nothing interactive sits above
    // the notice that could lead past it. The "Questions?" contact links come
    // after it, at the very end of the panel (client-front.md §8.3; the
    // photographer's placeholder contact details render there, updated
    // 2026-09-27 for the restyle that added `<ContactLine />`).
    const focusable = summary().querySelectorAll('a[href], button, input, select, textarea, [tabindex]')
    expect(Array.from(focusable).map((element) => element.textContent)).toEqual([
      'Pay booking fee',
      '+250 700 000 000',
      '+250 700 000 000',
      'hello@example.com',
    ])
  })
})

// --- No processing fee (spec §3.1 step 7, A-4b) ----------------------------------------------

describe('processing fees', () => {
  it.each([
    ['no package', null, [], 0.4],
    ['the plan.md basket', STANDARD, [EXTRA_HOUR], 0.4],
    ['an overridden rate', STANDARD, [EXTRA_HOUR, RUSH_EDIT], 0.3],
  ] as const)('never appear, with %s', (_state, pkg, addons, bookingFeeRate) => {
    const { container } = render(<PriceSummary pkg={pkg} addons={addons} bookingFeeRate={bookingFeeRate} />)

    expect(container).not.toHaveTextContent(/processing/i)
    expect(container.innerHTML).not.toMatch(/processing/i)
    expect(container).not.toHaveTextContent(/gateway|transaction fee|service charge/i)
  })

  it('leave the total as the package plus add-ons, with nothing added on top', () => {
    render(<PriceSummary pkg={STANDARD} addons={[EXTRA_HOUR, RUSH_EDIT]} bookingFeeRate={0.4} />)

    expect(summary().querySelectorAll('dt')).toHaveLength(6)
    expect(amount('Total')).toBe('55,000 RWF')
  })
})
