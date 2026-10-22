import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import type { PayoutItem } from '@/admin/payouts'
import { payoutItem } from '@/test/payout-fixtures'
import { PayoutItems } from './PayoutItems'

/**
 * Payout lines as a table (marketplace spec R4.5): the booking, what the line
 * is, its state in words, its amount (a reversal negative) and when it was
 * added; in the studio each line links to its booking.
 */

const REVERSAL = payoutItem({
  id: 'pi-rev',
  kind: 'reversal',
  amountRwf: -20_000,
  state: 'payable',
  createdAt: '2026-10-12T10:00:00.000Z',
  payment: { ...payoutItem().payment, status: 'refunded' },
})

const VOIDED = payoutItem({
  id: 'pi-void',
  state: 'voided',
  voidedAt: '2026-10-06T08:00:00.000Z',
  payment: { ...payoutItem().payment, kind: 'session_fee' },
  booking: { ...payoutItem().booking, id: 'b-void', reference: 'BKY-2610-00099' },
})

function renderItems(items: PayoutItem[], linkBookings?: boolean) {
  render(
    <MemoryRouter>
      <PayoutItems items={items} caption="Lines" linkBookings={linkBookings} />
    </MemoryRouter>,
  )
  return screen.getByRole('table', { name: 'Lines' })
}

function rowOf(id: string) {
  const row = document.querySelector(`[data-item="${id}"]`)
  if (!(row instanceof HTMLElement)) throw new Error(`no row ${id}`)
  return row
}

describe('PayoutItems', () => {
  it('heads the columns in words', () => {
    const table = renderItems([payoutItem()])

    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Booking', 'Line', 'State', 'Amount', 'Added'])
  })

  it('shows one earning: the booking and its shoot, the fee, its state, the amount and when it was added', () => {
    renderItems([payoutItem()])

    const cells = within(rowOf(payoutItem().id)).getAllByRole('cell').map((td) => td.textContent)
    expect(cells).toEqual(['BKY-2610-00042Shoot 20 Oct 2026, 09:00', 'Booking fee', 'Payable', '20,000 RWF', '5 Oct 2026, 09:05'])
  })

  it('links each booking to its studio page when asked', () => {
    renderItems([payoutItem(), VOIDED], true)

    expect(screen.getByRole('link', { name: 'BKY-2610-00042' })).toHaveAttribute('href', '/studio/bookings/b0000001-0000-4000-8000-000000000001')
    expect(screen.getByRole('link', { name: 'BKY-2610-00099' })).toHaveAttribute('href', '/studio/bookings/b-void')
  })

  it('links nothing by default: the platform has no booking page', () => {
    renderItems([payoutItem()])

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('BKY-2610-00042')).toBeInTheDocument()
  })

  it('shows a reversal as the negative it is, and says what it reverses', () => {
    renderItems([REVERSAL])

    const row = rowOf('pi-rev')
    expect(row).toHaveAttribute('data-kind', 'reversal')
    expect(row).toHaveTextContent('Refunded after payout: booking fee')
    expect(within(row).getByText('-20,000 RWF')).toHaveClass('text-destructive')
  })

  it('keeps a voided line, worded and muted, with its kind', () => {
    renderItems([VOIDED])

    const row = rowOf('pi-void')
    expect(row).toHaveTextContent('Session fee')
    expect(row).toHaveTextContent('Voided')
    expect(within(row).getByText('20,000 RWF')).toHaveClass('text-muted-foreground')
  })

  it('shows a payment kind it has no words for as the API sent it', () => {
    renderItems([payoutItem({ id: 'pi-x', payment: { ...payoutItem().payment, kind: 'deposit' } })])

    expect(rowOf('pi-x')).toHaveTextContent('deposit')
  })

  it('keeps the order it was given (newest first, as the API sends it)', () => {
    renderItems([REVERSAL, VOIDED, payoutItem()])

    expect([...document.querySelectorAll('[data-item]')].map((row) => row.getAttribute('data-item'))).toEqual(['pi-rev', 'pi-void', payoutItem().id])
  })

  it('renders an empty table body for no lines; the page words the empty state', () => {
    const table = renderItems([])

    expect(within(table).getAllByRole('row')).toHaveLength(1)
  })
})
