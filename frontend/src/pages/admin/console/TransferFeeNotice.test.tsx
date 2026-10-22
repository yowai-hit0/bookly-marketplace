import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { TransferFeeNotice } from './TransferFeeNotice'

/**
 * The transfer-fee banner (marketplace spec R4.5): manual transfer, the fee
 * comes out of what the photographer receives, so he may want to price it in.
 */
describe('TransferFeeNotice', () => {
  it('says payouts are manual transfers, the fee is deducted, and to price it in', () => {
    render(<TransferFeeNotice />)

    const notice = document.querySelector('[data-notice="transfer-fee"]')
    expect(notice).not.toBeNull()
    expect(notice).toHaveTextContent(
      'Bookly sends your payouts by manual transfer. The transfer fee is deducted from what you receive, so you may want to include it in your prices.',
    )
  })

  it('is a console info banner with nothing to dismiss it', () => {
    render(<TransferFeeNotice />)

    const notice = document.querySelector('[data-notice="transfer-fee"]')
    expect(notice).toHaveAttribute('data-variant', 'console')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    // The icon only repeats the words.
    expect(notice?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('takes the caller’s spacing', () => {
    render(<TransferFeeNotice className="mt-4" />)

    expect(document.querySelector('[data-notice="transfer-fee"]')).toHaveClass('mt-4')
  })
})
