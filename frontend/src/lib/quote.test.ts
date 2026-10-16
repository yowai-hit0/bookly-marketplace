import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type Basket, type Quote, QuoteInputError, feePercent, quoteBasket } from './quote'

/**
 * `quoteBasket()`, the browser's copy (plan.md Task 11; data-model_v2.md §6.2,
 * §9.5). It carries no authority -- the API prices the basket again -- but the
 * total a visitor watches must be the total they are charged, so this copy is
 * held to the same fixture as the backend's and the same exact oracle.
 */

type Case = Basket & { case: string }

/** The same file the backend suite reads. A divergence fails both projects. */
const fixture = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/fixtures/quotes.json'), 'utf8'),
) as {
  quotes: (Case & { expected: Quote })[]
  rejects: Case[]
}

/** The largest `integer` PostgreSQL stores; every catalogue price fits in it. */
const INT4_MAX = 2_147_483_647
/** The API's add-on ceiling, plus the package. */
const MAX_PRICES = 51

// --- An independent oracle ------------------------------------------------------

/**
 * The exact quote for a rate of `thousandths / 1000`, in BigInt: booking fee is
 * the quotient of total × thousandths by 1000, plus one when the remainder is
 * 500 or more (half-up, never half-to-even).
 */
function exactQuote(prices: readonly number[], thousandths: number): Quote {
  const total = prices.reduce((sum, price) => sum + BigInt(price), 0n)
  const product = total * BigInt(thousandths)
  const quotient = product / 1000n
  const remainder = product % 1000n
  const bookingFee = remainder * 2n >= 1000n ? quotient + 1n : quotient
  return { totalRwf: Number(total), bookingFeeRwf: Number(bookingFee), sessionFeeRwf: Number(total - bookingFee) }
}

/** mulberry32: small, seeded and deterministic, so a failure reproduces. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function integerBelow(random: () => number, bound: number): number {
  return Math.floor(random() * bound)
}

/** A price that is sometimes 0, sometimes round, sometimes anything up to INT4_MAX. */
function randomPrice(random: () => number): number {
  const shape = random()
  if (shape < 0.05) return 0
  if (shape < 0.5) return integerBelow(random, 5_000) * 500
  if (shape < 0.9) return integerBelow(random, 3_000_000)
  return integerBelow(random, INT4_MAX + 1)
}

// --- The shared fixture -----------------------------------------------------------

describe('the shared fixture', () => {
  it('holds exactly the 20 baskets plan.md Task 11 names', () => {
    expect(fixture.quotes).toHaveLength(20)
  })

  it('covers both plan.md cases and the three float traps', () => {
    const cases = fixture.quotes.map((quote) => quote.case)
    expect(cases.filter((name) => name.startsWith('plan.md Task 11'))).toHaveLength(2)
    expect(cases.filter((name) => name.startsWith('float trap'))).toHaveLength(3)
  })

  it.each(fixture.quotes)('agrees with the exact oracle: $case', ({ packagePriceRwf, addonPricesRwf, bookingFeeRate, expected }) => {
    // Guards the fixture itself: a hand-typed expectation that is a franc out
    // would otherwise pass against an implementation with the same mistake.
    expect(exactQuote([packagePriceRwf, ...addonPricesRwf], Math.round(bookingFeeRate * 1000))).toEqual(expected)
  })
})

describe('quoteBasket', () => {
  it.each(fixture.quotes)('$case', ({ packagePriceRwf, addonPricesRwf, bookingFeeRate, expected }) => {
    expect(quoteBasket({ packagePriceRwf, addonPricesRwf, bookingFeeRate })).toStrictEqual(expected)
  })

  it.each(fixture.rejects)('$case: rejects it', ({ packagePriceRwf, addonPricesRwf, bookingFeeRate }) => {
    expect(() => quoteBasket({ packagePriceRwf, addonPricesRwf, bookingFeeRate })).toThrow(QuoteInputError)
  })

  it('throws a RangeError subclass named QuoteInputError', () => {
    let thrown: unknown
    try {
      quoteBasket({ packagePriceRwf: -1, addonPricesRwf: [], bookingFeeRate: 0.4 })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RangeError)
    expect(thrown).toBeInstanceOf(QuoteInputError)
    expect((thrown as Error).name).toBe('QuoteInputError')
  })

  it('does not modify the add-on prices it was given', () => {
    const addonPricesRwf = [10_000, 5_000]
    quoteBasket({ packagePriceRwf: 40_000, addonPricesRwf, bookingFeeRate: 0.4 })
    expect(addonPricesRwf).toEqual([10_000, 5_000])
  })
})

// --- Values JSON cannot carry -------------------------------------------------------

describe('non-finite and unsafe inputs', () => {
  const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]

  it.each(NON_FINITE)('rejects a rate of %s', (bookingFeeRate) => {
    expect(() => quoteBasket({ packagePriceRwf: 40_000, addonPricesRwf: [], bookingFeeRate })).toThrow(QuoteInputError)
  })

  it.each(NON_FINITE)('rejects a package price of %s', (packagePriceRwf) => {
    expect(() => quoteBasket({ packagePriceRwf, addonPricesRwf: [], bookingFeeRate: 0.4 })).toThrow(QuoteInputError)
  })

  it.each(NON_FINITE)('rejects an add-on price of %s', (price) => {
    expect(() => quoteBasket({ packagePriceRwf: 40_000, addonPricesRwf: [10_000, price], bookingFeeRate: 0.4 })).toThrow(
      QuoteInputError,
    )
  })

  it('rejects a price past Number.MAX_SAFE_INTEGER, which is not a whole number it can trust', () => {
    expect(() =>
      quoteBasket({ packagePriceRwf: Number.MAX_SAFE_INTEGER + 1, addonPricesRwf: [], bookingFeeRate: 0.4 }),
    ).toThrow(QuoteInputError)
  })

  it('rejects rates just outside 0 to 1 by float noise, and a sub-thousandth rate', () => {
    for (const bookingFeeRate of [1.0000001, -0.0000001, 0.0005, 0.9999]) {
      expect(() => quoteBasket({ packagePriceRwf: 40_000, addonPricesRwf: [], bookingFeeRate })).toThrow(QuoteInputError)
    }
  })

  it('throws when the total is too large to price exactly', () => {
    expect(() =>
      quoteBasket({ packagePriceRwf: Number.MAX_SAFE_INTEGER, addonPricesRwf: [], bookingFeeRate: 0.4 }),
    ).toThrow(QuoteInputError)
    expect(() =>
      quoteBasket({ packagePriceRwf: 5_000_000_000_000, addonPricesRwf: [5_000_000_000_000], bookingFeeRate: 1 }),
    ).toThrow(QuoteInputError)
  })

  it.each([0, 0.001, 0.4, 1])('throws, rather than returning a rounded total, when the sum passes MAX_SAFE_INTEGER at rate %s', (bookingFeeRate) => {
    // 2^53 - 1 + 2 is 2^53 + 1, which a double cannot hold: it would come back as 2^53.
    expect(() =>
      quoteBasket({ packagePriceRwf: Number.MAX_SAFE_INTEGER, addonPricesRwf: [2], bookingFeeRate }),
    ).toThrow(QuoteInputError)
  })

  it('prices exactly the largest basket the catalogue can hold: 51 prices of INT4_MAX, at 100% and 99.9%', () => {
    const prices = Array.from({ length: MAX_PRICES }, () => INT4_MAX)
    const [packagePriceRwf = 0, ...addonPricesRwf] = prices
    for (const thousandths of [1000, 999, 500, 1]) {
      expect(quoteBasket({ packagePriceRwf, addonPricesRwf, bookingFeeRate: thousandths / 1000 })).toStrictEqual(
        exactQuote(prices, thousandths),
      )
    }
  })
})

// --- Properties ----------------------------------------------------------------------

describe('over many generated baskets', () => {
  it('matches the exact BigInt quote, and the two fees always add back up to the total', () => {
    const random = seeded(20_261_001)
    for (let run = 0; run < 5_000; run++) {
      const prices = Array.from({ length: 1 + integerBelow(random, 11) }, () => randomPrice(random))
      const [packagePriceRwf = 0, ...addonPricesRwf] = prices
      const thousandths = integerBelow(random, 1001)
      const bookingFeeRate = thousandths / 1000

      const quote = quoteBasket({ packagePriceRwf, addonPricesRwf, bookingFeeRate })
      const label = JSON.stringify({ prices, bookingFeeRate })

      expect(quote, label).toStrictEqual(exactQuote(prices, thousandths))
      expect(quote.bookingFeeRwf + quote.sessionFeeRwf, label).toBe(quote.totalRwf)
      expect(quote.bookingFeeRwf, label).toBeGreaterThanOrEqual(0)
      expect(quote.bookingFeeRwf, label).toBeLessThanOrEqual(quote.totalRwf)
      expect(Number.isSafeInteger(quote.bookingFeeRwf) && Number.isSafeInteger(quote.sessionFeeRwf), label).toBe(true)
    }
  })

  it('agrees with the exact quote at every one of the 1,001 rates', () => {
    const random = seeded(7)
    for (let thousandths = 0; thousandths <= 1000; thousandths++) {
      for (let run = 0; run < 5; run++) {
        const totalRwf = 1 + integerBelow(random, 3_000_000)
        const quote = quoteBasket({ packagePriceRwf: totalRwf, addonPricesRwf: [], bookingFeeRate: thousandths / 1000 })
        expect(quote, JSON.stringify({ totalRwf, thousandths })).toStrictEqual(exactQuote([totalRwf], thousandths))
      }
    }
  })

  it('rounds up every basket whose exact booking fee ends in .5 -- the ones float rounding gets wrong', () => {
    const random = seeded(42)
    let halves = 0
    for (let run = 0; run < 2_000; run++) {
      const thousandths = 1 + integerBelow(random, 999)
      // Walk forward from a random total to the next one whose product ends in
      // exactly 500 thousandths, if this rate has one at all.
      const start = integerBelow(random, 2_000_000)
      const totalRwf = Array.from({ length: 1000 }, (_, step) => start + step).find(
        (total) => (total * thousandths) % 1000 === 500,
      )
      if (totalRwf === undefined) continue
      halves++
      const quote = quoteBasket({ packagePriceRwf: totalRwf, addonPricesRwf: [], bookingFeeRate: thousandths / 1000 })
      const label = JSON.stringify({ totalRwf, thousandths })
      expect(quote.bookingFeeRwf, label).toBe((totalRwf * thousandths + 500) / 1000)
      expect(quote.bookingFeeRwf + quote.sessionFeeRwf, label).toBe(totalRwf)
    }
    // The walk above is only meaningful if it found halves to check.
    expect(halves).toBeGreaterThan(500)
  })

  it('is independent of the order the add-ons are listed in', () => {
    const random = seeded(99)
    for (let run = 0; run < 500; run++) {
      const addonPricesRwf = Array.from({ length: 2 + integerBelow(random, 8) }, () => randomPrice(random))
      const basket = { packagePriceRwf: randomPrice(random), bookingFeeRate: integerBelow(random, 1001) / 1000 }
      expect(quoteBasket({ ...basket, addonPricesRwf: [...addonPricesRwf].reverse() })).toStrictEqual(
        quoteBasket({ ...basket, addonPricesRwf }),
      )
    }
  })
})

// --- The rate as a visitor reads it -----------------------------------------------------

describe('feePercent', () => {
  it.each([
    [0.4, 40],
    [0.3, 30],
    [0.375, 37.5],
    [0.285, 28.5],
    [0.175, 17.5],
    [0.035, 3.5],
    [0.001, 0.1],
    [0, 0],
    [1, 100],
  ])('reads %s as %s%%', (rate, percent) => {
    expect(feePercent(rate)).toBe(percent)
  })

  it('reads every rate numeric(4,3) can hold as its exact tenth of a percent, with no float noise', () => {
    for (let thousandths = 0; thousandths <= 1000; thousandths++) {
      const percent = feePercent(thousandths / 1000)
      expect(percent, String(thousandths)).toBe(thousandths / 10)
      // What the summary interpolates: never 28.499999999999996 or 57.00000000000001.
      expect(String(percent), String(thousandths)).toMatch(/^\d{1,3}(\.\d)?$/)
    }
  })
})
