import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cardConfig, fakeFlutterwave, removeFakeFlutterwave } from '@/test/card-fixtures'
import {
  CardCheckoutLoadError,
  FLUTTERWAVE_INLINE_SRC,
  LOAD_TIMEOUT_MS,
  loadFlutterwaveInline,
  openCardCheckout,
  resetFlutterwaveInlineForTests,
  transactionIdOf,
} from './flutterwave-inline'

/**
 * The v3 Inline loader (marketplace-spec.md "Cards as built"). jsdom loads no
 * scripts, so each test plays the `<script>` tag's load or error itself: the
 * script is appended once however often it is asked for, a failure lets the
 * next attempt append a fresh one, a script that defines no
 * `FlutterwaveCheckout` (or never answers) is a load error, and the modal gets
 * the API's config unchanged with only `callback` and `onclose` added, each
 * handled at most once.
 */

const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'

function scripts(): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll<HTMLScriptElement>(`script[src="${FLUTTERWAVE_INLINE_SRC}"]`))
}

beforeEach(() => {
  resetFlutterwaveInlineForTests()
  removeFakeFlutterwave()
})

afterEach(() => {
  for (const script of scripts()) script.remove()
  removeFakeFlutterwave()
  vi.useRealTimers()
})

describe('loadFlutterwaveInline', () => {
  it('appends one script tag, from Flutterwave, however often it is asked, and shares one promise', async () => {
    const first = loadFlutterwaveInline()
    const second = loadFlutterwaveInline()
    expect(second).toBe(first)
    expect(scripts()).toHaveLength(1)
    expect(scripts()[0]?.async).toBe(true)
    // No inline script: the tag only names the file.
    expect(scripts()[0]?.textContent).toBe('')

    const checkout = fakeFlutterwave().checkout
    scripts()[0]?.dispatchEvent(new Event('load'))
    await expect(first).resolves.toBe(checkout)

    await expect(loadFlutterwaveInline()).resolves.toBe(checkout)
    expect(scripts()).toHaveLength(1)
  })

  it('uses a FlutterwaveCheckout already on the page without appending anything', async () => {
    const { checkout } = fakeFlutterwave()
    await expect(loadFlutterwaveInline()).resolves.toBe(checkout)
    expect(scripts()).toHaveLength(0)
  })

  it('rejects when the script fails to load, removes the dead tag, and tries afresh next time', async () => {
    const first = loadFlutterwaveInline()
    scripts()[0]?.dispatchEvent(new Event('error'))
    await expect(first).rejects.toBeInstanceOf(CardCheckoutLoadError)
    expect(scripts()).toHaveLength(0)

    const retry = loadFlutterwaveInline()
    expect(retry).not.toBe(first)
    expect(scripts()).toHaveLength(1)
    const { checkout } = fakeFlutterwave()
    scripts()[0]?.dispatchEvent(new Event('load'))
    await expect(retry).resolves.toBe(checkout)
  })

  it('rejects when the script loads but defines no FlutterwaveCheckout, and can be retried', async () => {
    const first = loadFlutterwaveInline()
    scripts()[0]?.dispatchEvent(new Event('load'))
    await expect(first).rejects.toThrow('flutterwave_checkout_missing')
    expect(scripts()).toHaveLength(0)

    loadFlutterwaveInline()
    expect(scripts()).toHaveLength(1)
  })

  it('gives up on a script that never answers, so the page can say so', async () => {
    vi.useFakeTimers()
    const first = loadFlutterwaveInline()
    const settled = expect(first).rejects.toThrow('flutterwave_script_timeout')
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS)
    await settled
    expect(scripts()).toHaveLength(0)
  })
})

describe('openCardCheckout', () => {
  it('hands the config over unchanged, adding only callback and onclose', async () => {
    const flutterwave = fakeFlutterwave()
    const config = cardConfig(OUR_REF)
    const before = structuredClone(config)

    await openCardCheckout(config, { onCallback: vi.fn(), onClose: vi.fn() })

    expect(flutterwave.opened).toHaveLength(1)
    expect(flutterwave.opened[0]?.config).toStrictEqual(before)
    expect(typeof flutterwave.opened[0]?.callback).toBe('function')
    expect(typeof flutterwave.opened[0]?.onclose).toBe('function')
    // The page's own copy is not touched either.
    expect(config).toStrictEqual(before)
  })

  it('on the callback closes the modal first and hands on the digits of transaction_id, never a status', async () => {
    const flutterwave = fakeFlutterwave()
    const onCallback = vi.fn()
    const onClose = vi.fn()
    await openCardCheckout(cardConfig(OUR_REF), { onCallback, onClose })

    flutterwave.pay(4_100_000_123)
    expect(flutterwave.close).toHaveBeenCalledTimes(1)
    expect(onCallback).toHaveBeenCalledWith('4100000123')
    expect(onCallback.mock.calls[0]).toHaveLength(1)

    // Each handler at most once, and neither after the other.
    flutterwave.pay(4_100_000_124)
    flutterwave.dismiss()
    expect(onCallback).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it.each<[string, unknown]>([
    ['letters', 'abc'],
    ['a query smuggled in', '123&status=successful'],
    ['too many digits', '1'.repeat(21)],
    ['null', null],
    ['a negative number', -5],
  ])('hands on no transaction id for %s', async (_label, value) => {
    const flutterwave = fakeFlutterwave()
    const onCallback = vi.fn()
    await openCardCheckout(cardConfig(OUR_REF), { onCallback, onClose: vi.fn() })

    flutterwave.pay(value)
    expect(onCallback).toHaveBeenCalledWith(null)
  })

  it('hands on no transaction id for a callback with no response at all', async () => {
    const flutterwave = fakeFlutterwave()
    const onCallback = vi.fn()
    await openCardCheckout(cardConfig(OUR_REF), { onCallback, onClose: vi.fn() })

    flutterwave.opened[0]?.callback(undefined)
    expect(onCallback).toHaveBeenCalledWith(null)
  })

  it('on onclose without a callback tells the page, once', async () => {
    const flutterwave = fakeFlutterwave()
    const onCallback = vi.fn()
    const onClose = vi.fn()
    await openCardCheckout(cardConfig(OUR_REF), { onCallback, onClose })

    flutterwave.dismiss()
    flutterwave.dismiss()
    flutterwave.pay()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCallback).not.toHaveBeenCalled()
  })

  it('close() closes the modal and silences both handlers', async () => {
    const flutterwave = fakeFlutterwave()
    const onCallback = vi.fn()
    const onClose = vi.fn()
    const handle = await openCardCheckout(cardConfig(OUR_REF), { onCallback, onClose })

    handle.close()
    flutterwave.dismiss()
    flutterwave.pay()
    expect(flutterwave.close).toHaveBeenCalledTimes(1)
    expect(onCallback).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('rejects with a load error, opening nothing, when the script cannot load', async () => {
    const opening = openCardCheckout(cardConfig(OUR_REF), { onCallback: vi.fn(), onClose: vi.fn() })
    scripts()[0]?.dispatchEvent(new Event('error'))
    await expect(opening).rejects.toBeInstanceOf(CardCheckoutLoadError)
  })

  it('never writes the config to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    const flutterwave = fakeFlutterwave()
    await openCardCheckout(cardConfig(OUR_REF), { onCallback: vi.fn(), onClose: vi.fn() })
    flutterwave.pay()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

describe('transactionIdOf', () => {
  it.each<[unknown, string | null]>([
    ['4100000123', '4100000123'],
    [4100000123, '4100000123'],
    ['1'.repeat(20), '1'.repeat(20)],
    ['1'.repeat(21), null],
    ['', null],
    [' 123', null],
    ['12.5', null],
    [12.5, null],
    [null, null],
    [{}, null],
  ])('reads %j as %j', (value, expected) => {
    expect(transactionIdOf(value)).toBe(expected)
  })
})
