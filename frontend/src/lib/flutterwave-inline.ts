/**
 * Flutterwave v3 Inline on our own pay pages (marketplace-spec.md Phase 3,
 * "Cards as built", user decisions 2026-10-30): the script is loaded on
 * demand, the first time a payer chooses a card, and the modal is opened with
 * the config the API built. Card numbers are typed into Flutterwave's own
 * frame, never into this page.
 *
 * What this relies on, from the public docs
 * (developer.flutterwave.com/docs/inline, read 2026-10-30) and the live
 * `https://checkout.flutterwave.com/v3.js` (last-modified 2026-10-27, read
 * 2026-10-30):
 *  - `FlutterwaveCheckout(config)` returns an object with `close()`. In v3.js,
 *    `close()` tears the frame down WITHOUT calling `onclose` (it calls its
 *    internal close with "not by the payer"); `onclose` runs only when the payer
 *    closes the modal (the frame's `closeiframe` message), with one boolean
 *    argument, "cancelled".
 *  - "The `redirect_url` has higher precedence than the `callback`": v3.js, on
 *    completion, navigates the whole tab to `redirect_url` with
 *    `?status=&tx_ref=&transaction_id=` appended and calls `callback` only when
 *    there is no `redirect_url`. The API always sends one (it is the 3-D Secure
 *    landing too), so on today's v3.js the progress page is usually reached by
 *    that redirect; `callback` is still handled in case that changes. Its
 *    argument carries `transaction_id` (the transaction's numeric `id`) and a
 *    `status` this page never reads.
 *  - The docs' callback example calls `modal.close()` itself, so it is closed here.
 *  - Without an `onclose`, v3.js reloads the page on close; one is always passed.
 *
 * The origins v3.js uses (vercel.json's CSP, `src/vercel-headers.test.ts`):
 *  - the script itself, allowed by its path: `https://checkout.flutterwave.com/v3.js`
 *    (it loads no other script);
 *  - its frame: `https://checkout-v3.flutterwave.com` (preloaded hidden as soon
 *    as the script runs, and used when the key's "upgrade" check says so or
 *    fails), or `https://checkout.flutterwave.com` (when it says not);
 *  - fetches, under `connect-src 'self' https:`: `https://api.ravepay.co/v2/checkout/upgrade`
 *    and `https://flw-events-ge.myflutterwave.com/event/create`.
 *
 * The config is handed over exactly as the API sent it, with only `callback`
 * and `onclose` added: the amount, currency, `tx_ref` and `redirect_url` are the
 * server's, and none of it is logged. Nothing the modal reports is a result:
 * only the progress page's poll says whether a payment went through (R3.3).
 */

export const FLUTTERWAVE_INLINE_SRC = 'https://checkout.flutterwave.com/v3.js'

/** Past this the script is taken as unreachable, so the page can say so instead of waiting forever. */
export const LOAD_TIMEOUT_MS = 20_000

/** The API's `card` answer (backend `InlineCardConfig`), passed to `FlutterwaveCheckout` unchanged. */
export type InlineCardConfig = {
  public_key: string
  tx_ref: string
  amount: number
  currency: string
  payment_options: 'card'
  redirect_url: string
  customer: { email: string; name: string; phone_number?: string }
  customizations: { title: string }
  configurations: { session_duration: number }
}

type InlineHandlers = { callback: (response: unknown) => void; onclose: (cancelled?: boolean) => void }
type FlutterwaveCheckoutFn = (config: InlineCardConfig & InlineHandlers) => { close?: () => void } | undefined

declare global {
  interface Window {
    FlutterwaveCheckout?: FlutterwaveCheckoutFn
  }
}

export class CardCheckoutLoadError extends Error {
  override readonly name = 'CardCheckoutLoadError'
}

let loading: Promise<FlutterwaveCheckoutFn> | null = null

/**
 * Loads v3.js once, by appending a `<script>` (no inline script: the CSP allows
 * none). Every caller shares one promise; a failed load forgets it, so the
 * next attempt tries again.
 */
export function loadFlutterwaveInline(): Promise<FlutterwaveCheckoutFn> {
  if (loading !== null) return loading
  const attempt = new Promise<FlutterwaveCheckoutFn>((resolve, reject) => {
    const ready = window.FlutterwaveCheckout
    if (typeof ready === 'function') {
      resolve(ready)
      return
    }
    const script = document.createElement('script')
    script.src = FLUTTERWAVE_INLINE_SRC
    script.async = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (reason: string) => {
      clearTimeout(timer)
      script.onload = null
      script.onerror = null
      // A dead tag would make the next attempt look loaded; it goes, so a retry appends a fresh one.
      script.remove()
      reject(new CardCheckoutLoadError(reason))
    }
    script.onload = () => {
      clearTimeout(timer)
      const checkout = window.FlutterwaveCheckout
      if (typeof checkout === 'function') resolve(checkout)
      else fail('flutterwave_checkout_missing')
    }
    script.onerror = () => fail('flutterwave_script_failed')
    timer = setTimeout(() => fail('flutterwave_script_timeout'), LOAD_TIMEOUT_MS)
    document.head.appendChild(script)
  })
  loading = attempt
  attempt.catch(() => {
    if (loading === attempt) loading = null
  })
  return attempt
}

/** For tests: forget a loaded or failed script. */
export function resetFlutterwaveInlineForTests(): void {
  loading = null
}

/** Only digits are ever passed on (`^\d{1,20}$`); anything else is no id at all. */
export function transactionIdOf(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value
  return typeof text === 'string' && /^\d{1,20}$/.test(text) ? text : null
}

export type CardCheckoutHandlers = {
  /** The modal reported a completed try. Not a result: follow the payment's progress page. */
  onCallback: (transactionId: string | null) => void
  /** The payer closed the modal without a callback. */
  onClose: () => void
}

export type CardCheckoutHandle = { close: () => void }

/**
 * Opens the modal. Rejects with `CardCheckoutLoadError` when the script cannot
 * be loaded or does not define `FlutterwaveCheckout`. Each handler runs at most
 * once, and neither after the other or after `close()`.
 */
export async function openCardCheckout(config: InlineCardConfig, handlers: CardCheckoutHandlers): Promise<CardCheckoutHandle> {
  const checkout = await loadFlutterwaveInline()
  let finished = false
  let modal: { close?: () => void } | undefined

  const closeModal = () => {
    try {
      modal?.close?.()
    } catch {
      // Already gone.
    }
  }

  modal = checkout({
    ...config,
    callback: (response) => {
      if (finished) return
      finished = true
      const id = transactionIdOf((response as { transaction_id?: unknown } | null | undefined)?.transaction_id)
      // Closing first, as the docs' example does; v3.js's close() does not call onclose.
      if (modal === undefined) queueMicrotask(closeModal)
      else closeModal()
      handlers.onCallback(id)
    },
    onclose: () => {
      if (finished) return
      finished = true
      handlers.onClose()
    },
  })

  return {
    close: () => {
      if (finished) return
      finished = true
      closeModal()
    },
  }
}
