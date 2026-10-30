import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { PaymentMethod } from '@/catalogue/payments'
import { PaymentFields } from './PaymentFields'

/**
 * The method choice shared by the checkout and both booking pages. With a
 * card chosen there is no phone field, one line says the card is typed into
 * a secure Flutterwave window (tied to the card radio for screen readers), and
 * no fee or logo is drawn; with MoMo chosen the line is gone and the phone is back.
 */

function renderWith(method: PaymentMethod | null, methods: PaymentMethod[] = ['momo_mtn', 'momo_airtel', 'card']) {
  return render(
    <PaymentFields methods={methods} method={method} onMethod={vi.fn()} phoneId="pay-phone" phoneRef={createRef()} phoneInvalid={false} />,
  )
}

describe('PaymentFields', () => {
  it('asks no number for a card, and says where the card details go', () => {
    renderWith('card')

    expect(screen.queryByRole('textbox', { name: 'Mobile Money number' })).not.toBeInTheDocument()
    const hint = screen.getByText('You will enter your card details in a secure Flutterwave window.')
    expect(screen.getByRole('radio', { name: 'Card' })).toHaveAttribute('aria-describedby', hint.id)
    expect(screen.getByRole('radio', { name: 'MTN MoMo' })).not.toHaveAttribute('aria-describedby')
    expect(document.querySelector('img')).toBeNull()
    expect(document.body.textContent).not.toMatch(/fee/i)
  })

  it.each<PaymentMethod>(['momo_mtn', 'momo_airtel'])('asks a number for %s, with no card line', (method) => {
    renderWith(method)

    expect(screen.getByRole('textbox', { name: 'Mobile Money number' })).toBeInTheDocument()
    expect(screen.queryByText('You will enter your card details in a secure Flutterwave window.')).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Card' })).not.toHaveAttribute('aria-describedby')
  })

  it('draws the card as the same text chip as the others', () => {
    renderWith('card', ['card'])

    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect(screen.getByRole('radio', { name: 'Card' })).toBeChecked()
  })
})
