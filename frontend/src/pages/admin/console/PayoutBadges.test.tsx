import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { PAYOUT_ITEM_STATES } from '@/admin/payouts'
import { PayoutItemBadge, PayoutStatusBadge } from './PayoutBadges'

/**
 * Payout lines and payouts in the console's status shapes
 * (admin-console.md section 5): the word every time, a shape that repeats it,
 * and no two states alike in greyscale.
 */

describe('PayoutItemBadge', () => {
  it.each([
    ['pending', 'Pending', 'waiting'],
    ['payable', 'Payable', 'earlier'],
    ['in_draft', 'Being paid out', 'waiting'],
    ['paid', 'Paid', 'current'],
    ['voided', 'Voided', 'failed'],
  ] as const)('words %s as "%s" with the %s shape', (state, word, shape) => {
    render(<PayoutItemBadge state={state} />)

    const badge = screen.getByText(word)
    expect(badge).toHaveAttribute('data-state', state)
    expect(badge.querySelector('[data-shape]')).toHaveAttribute('data-shape', shape)
    expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws every state differently, so none relies on colour alone', () => {
    const looks = PAYOUT_ITEM_STATES.map((state) => {
      const { unmount } = render(<PayoutItemBadge state={state} />)
      const badge = document.querySelector(`[data-state="${state}"]`) as HTMLElement
      const look = `${badge.querySelector('[data-shape]')?.getAttribute('data-shape')}|${badge.className}`
      unmount()
      return look
    })
    expect(new Set(looks).size).toBe(PAYOUT_ITEM_STATES.length)
  })
})

describe('PayoutStatusBadge', () => {
  it.each([
    ['draft', 'waiting'],
    ['paid', 'current'],
    ['cancelled', 'failed'],
  ] as const)('shows %s with the %s shape and the words it is given', (status, shape) => {
    render(<PayoutStatusBadge status={status}>Words for {status}</PayoutStatusBadge>)

    const badge = screen.getByText(`Words for ${status}`)
    expect(badge).toHaveAttribute('data-status', status)
    expect(badge.querySelector('[data-shape]')).toHaveAttribute('data-shape', shape)
  })

  it('has a larger size for a page header', () => {
    render(
      <>
        <PayoutStatusBadge status="paid">small</PayoutStatusBadge>
        <PayoutStatusBadge status="paid" size="md">
          large
        </PayoutStatusBadge>
      </>,
    )

    expect(screen.getByText('large')).toHaveClass('text-sm')
    expect(screen.getByText('small')).not.toHaveClass('text-sm')
  })
})
