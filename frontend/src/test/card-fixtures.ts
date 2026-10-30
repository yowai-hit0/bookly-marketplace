import { vi } from 'vitest'
import type { InlineCardConfig } from '@/lib/flutterwave-inline'

/**
 * The card answer of a pay route as the API builds it (backend
 * `payments/card-checkout.ts`, `InlineCardConfig`), and a stand-in for
 * Flutterwave's v3 Inline that records what it was opened with. No test talks
 * to Flutterwave: `window.FlutterwaveCheckout` is defined here, so the loader
 * finds it and appends no script.
 */

export function cardConfig(ourRef: string, overrides: Partial<InlineCardConfig> = {}): InlineCardConfig {
  return {
    public_key: 'FLWPUBK_TEST-0123456789abcdef-X',
    tx_ref: ourRef,
    amount: 19_500,
    currency: 'RWF',
    payment_options: 'card',
    redirect_url: `https://bookly.example/payments/${ourRef}`,
    customer: { email: 'aline@example.com', name: 'Aline Uwase', phone_number: '+250788123456' },
    customizations: { title: 'Bookly booking fee BKY-2610-7K3QX' },
    configurations: { session_duration: 15 },
    ...overrides,
  }
}

type Opened = { config: Record<string, unknown>; callback: (response: unknown) => void; onclose: (cancelled?: boolean) => void }

/**
 * Installs a fake `FlutterwaveCheckout`. `opened` lists every config it was
 * called with (callback and onclose split off), `close` counts `close()`, and
 * `pay`/`dismiss` play the payer completing a try or closing the modal.
 */
export function fakeFlutterwave() {
  const opened: Opened[] = []
  const close = vi.fn()
  const checkout = vi.fn((config: Record<string, unknown>) => {
    const { callback, onclose, ...rest } = config as Record<string, unknown> & Pick<Opened, 'callback' | 'onclose'>
    opened.push({ config: rest, callback, onclose })
    return { close }
  })
  window.FlutterwaveCheckout = checkout as unknown as typeof window.FlutterwaveCheckout
  return {
    opened,
    close,
    checkout,
    pay: (transactionId: unknown = 4_100_000_123) => opened.at(-1)?.callback({ status: 'successful', transaction_id: transactionId, tx_ref: 'x' }),
    dismiss: () => opened.at(-1)?.onclose(true),
  }
}

export function removeFakeFlutterwave(): void {
  delete window.FlutterwaveCheckout
}
