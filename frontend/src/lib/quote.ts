/**
 * The quote: what a basket costs, what is paid now and what is left for after
 * the shoot (spec §3.1 step 7; data-model_v2.md §9.5, §6.2).
 *
 * The backend holds its own copy of this file (plan.md, Stack decisions: no
 * shared package); both are asserted against `docs/fixtures/quotes.json`, so a
 * divergence fails a test in both projects. This copy has no authority: it
 * prices the live total a visitor watches while choosing, and the API prices
 * the basket again from the catalogue before any money is taken.
 *
 * There is no processing-fee line. Gateway fees are absorbed by the
 * photographer and never reach checkout (spec §3.1 step 7, A-4b).
 */

export type Basket = {
  packagePriceRwf: number
  addonPricesRwf: readonly number[]
  /** 0 to 1, three decimal places at most: `numeric(4,3)`. */
  bookingFeeRate: number
}

export type Quote = {
  totalRwf: number
  /** Paid now to lock the date; non-refundable if the client cancels. */
  bookingFeeRwf: number
  /** Due after the shoot. */
  sessionFeeRwf: number
}

/** Thrown for a price or a rate the catalogue could never hold. */
export class QuoteInputError extends RangeError {
  override readonly name = 'QuoteInputError'
}

/** A rate is stored to three decimal places, so it is exact in thousandths. */
const RATE_SCALE = 1000

/**
 * Only the booking fee rounds -- half-up, to a whole franc -- and the session
 * fee is the remainder by subtraction, so the two always add back up to the
 * total (data-model_v2.md §6.2: rounding never loses a franc).
 *
 * The arithmetic is integer throughout. `Math.round(total * rate)` is a franc
 * short whenever the exact product ends in .5 but its floating-point rendering
 * lands just below: 5,500 × 0.175 is 962.5, computed as 962.4999….
 */
export function quoteBasket({ packagePriceRwf, addonPricesRwf, bookingFeeRate }: Basket): Quote {
  const prices = [packagePriceRwf, ...addonPricesRwf]
  for (const price of prices) {
    if (!Number.isSafeInteger(price) || price < 0) {
      throw new QuoteInputError(`A price must be a whole, non-negative number of RWF, received ${price}`)
    }
  }

  const totalRwf = prices.reduce((sum, price) => sum + price, 0)
  // `+ RATE_SCALE / 2` then truncating is half-up; `%` keeps the division exact.
  const scaled = totalRwf * rateInThousandths(bookingFeeRate) + RATE_SCALE / 2
  // Both checks: at a 0% rate `scaled` is always 500, so it alone would let a
  // total that has already lost a franc to rounding through.
  if (!Number.isSafeInteger(totalRwf) || !Number.isSafeInteger(scaled)) {
    throw new QuoteInputError(`A total of ${totalRwf} RWF is too large to price exactly`)
  }
  const bookingFeeRwf = (scaled - (scaled % RATE_SCALE)) / RATE_SCALE

  return { totalRwf, bookingFeeRwf, sessionFeeRwf: totalRwf - bookingFeeRwf }
}

/** `0.375` → `37.5`: the rate as the percentage a visitor reads. */
export function feePercent(rate: number): number {
  return Number((rate * 100).toFixed(1))
}

function rateInThousandths(rate: number): number {
  const thousandths = Math.round(rate * RATE_SCALE)
  // The tolerance absorbs float noise in a rate that is exact in decimal
  // (0.035 * 1000 is 35.00000000000001) while refusing a fourth decimal place.
  if (!Number.isFinite(rate) || rate < 0 || rate > 1 || Math.abs(rate * RATE_SCALE - thousandths) > 1e-9) {
    throw new QuoteInputError(`A booking-fee rate must be 0 to 1 with at most three decimal places, received ${rate}`)
  }
  return thousandths
}
