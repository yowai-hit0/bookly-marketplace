import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { BANK_METHOD, MOMO_METHOD } from '@/test/payout-fixtures'
import { PayoutDestination } from './PayoutDestination'

/** Where a payout goes, worded alike in the studio and the platform. */

function destination() {
  const element = document.querySelector('[data-slot="payout-destination"]')
  if (element === null) throw new Error('no destination')
  return element
}

describe('PayoutDestination', () => {
  it('names the MoMo network, the number spaced for reading, and the account name', () => {
    render(<PayoutDestination method={MOMO_METHOD} />)

    expect(destination()).toHaveAttribute('data-kind', 'momo')
    expect(destination()).toHaveTextContent('MTN MoMo+250 788 123 456Name on the account: Aline Uwase')
  })

  it('names an Airtel number as Airtel Money', () => {
    render(<PayoutDestination method={{ ...MOMO_METHOD, momoNetwork: 'airtel', momoNumber: '+250722123456' }} />)

    expect(destination()).toHaveTextContent('Airtel Money+250 722 123 456')
  })

  it('names the bank, the account number exactly, and the account name', () => {
    render(<PayoutDestination method={BANK_METHOD} />)

    expect(destination()).toHaveAttribute('data-kind', 'bank')
    expect(destination()).toHaveTextContent('Bank of Kigali00040-0123456-78Name on the account: Kigali Lens Ltd')
  })

  it('falls back to the kind when a field the API left empty is missing, rather than printing null', () => {
    render(<PayoutDestination method={{ ...MOMO_METHOD, momoNetwork: null, momoNumber: null }} />)
    expect(destination()).toHaveTextContent('Mobile moneyName on the account: Aline Uwase')
    expect(destination()).not.toHaveTextContent('null')
  })

  it('falls back to "Bank account" with no bank name', () => {
    render(<PayoutDestination method={{ ...BANK_METHOD, bankName: null, bankAccountNumber: null }} />)
    expect(destination()).toHaveTextContent('Bank accountName on the account: Kigali Lens Ltd')
  })

  it('shows a number it cannot format as it is', () => {
    render(<PayoutDestination method={{ ...MOMO_METHOD, momoNumber: '+254712345678' }} />)
    expect(destination()).toHaveTextContent('+254712345678')
  })

  it('keeps its icon decorative', () => {
    render(<PayoutDestination method={MOMO_METHOD} />)
    for (const svg of destination().querySelectorAll('svg')) expect(svg).toHaveAttribute('aria-hidden', 'true')
  })
})
