import { describe, expect, it } from 'vitest'
import { SETTINGS_FIELDS, SETTINGS_TOGGLES, settingsFormSchema, settingsFormValues } from './settings'

/**
 * The settings form's own rules (plan.md Task 8, spec P-30). The API
 * revalidates every value, so what matters here is that a percentage typed by
 * the photographer becomes exactly the rate the column stores, and that a value
 * the column could not hold is refused before it is sent.
 */

const input = {
  bookingFeePercent: '40',
  minLeadTimeMinutes: '120',
  bufferMinutes: '15',
  deliveryExpiryDays: '90',
  clientCancelCutoffHours: '24',
  bookingFeeRefundableOnClientCancel: false,
}

function badFields(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  return result.success ? [] : [...new Set(result.error?.issues.map((issue) => String(issue.path[0])) ?? [])]
}

describe('the settings form schema', () => {
  it('turns the typed values into the payload the API takes, with no hold time in it', () => {
    const result = settingsFormSchema.safeParse(input)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      bookingFeeRate: 0.4,
      minLeadTimeMinutes: 120,
      bufferMinutes: 15,
      deliveryExpiryDays: 90,
      clientCancelCutoffHours: 24,
      bookingFeeRefundableOnClientCancel: false,
    })
  })

  it('passes the refund setting through as a boolean', () => {
    const result = settingsFormSchema.safeParse({ ...input, bookingFeeRefundableOnClientCancel: true })

    expect(result.data).toMatchObject({ bookingFeeRefundableOnClientCancel: true })
  })

  it.each([
    ['40', 0.4],
    ['37.5', 0.375],
    ['0', 0],
    ['100', 1],
    ['12.5', 0.125],
  ])('reads %s%% as the rate %s, which numeric(4,3) stores exactly', (percent, rate) => {
    const result = settingsFormSchema.safeParse({ ...input, bookingFeePercent: percent })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ bookingFeeRate: rate })
  })

  it('refuses a second decimal place rather than rounding it away silently', () => {
    const result = settingsFormSchema.safeParse({ ...input, bookingFeePercent: '37.55' })

    expect(result.success).toBe(false)
    expect(badFields(result)).toEqual(['bookingFeePercent'])
  })

  it.each<[string, Partial<typeof input>, string[]]>([
    ['a fee above 100%', { bookingFeePercent: '101' }, ['bookingFeePercent']],
    ['a negative fee', { bookingFeePercent: '-5' }, ['bookingFeePercent']],
    ['a blank fee', { bookingFeePercent: '' }, ['bookingFeePercent']],
    ['a negative cut-off', { clientCancelCutoffHours: '-1' }, ['clientCancelCutoffHours']],
    ['a fractional cut-off', { clientCancelCutoffHours: '2.5' }, ['clientCancelCutoffHours']],
    ['a blank cut-off', { clientCancelCutoffHours: '' }, ['clientCancelCutoffHours']],
    ['a delivery window of zero days', { deliveryExpiryDays: '0' }, ['deliveryExpiryDays']],
    ['exponent notation', { minLeadTimeMinutes: '1e3' }, ['minLeadTimeMinutes']],
    ['a thousands separator', { minLeadTimeMinutes: '40,000' }, ['minLeadTimeMinutes']],
    ['a decimal where only whole minutes fit', { bufferMinutes: '15.5' }, ['bufferMinutes']],
    ['a blank field', { bufferMinutes: '' }, ['bufferMinutes']],
    ['a value past int4', { clientCancelCutoffHours: '2147483648' }, ['clientCancelCutoffHours']],
  ])('refuses %s and blames that field', (_label, patch, expected) => {
    const result = settingsFormSchema.safeParse({ ...input, ...patch })

    expect(result.success).toBe(false)
    expect(badFields(result)).toEqual(expected)
  })

  it.each([
    ['minLeadTimeMinutes'],
    ['bufferMinutes'],
    ['clientCancelCutoffHours'],
  ])('allows %s to be zero, because no notice, no buffer and no cut-off are real choices', (field) => {
    const result = settingsFormSchema.safeParse({ ...input, [field]: '0' })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ [field]: 0 })
  })
})

describe('settings form values', () => {
  it('shows a stored rate as the percentage the photographer typed', () => {
    const values = settingsFormValues({
      bookingFeeRate: 0.375,
      minLeadTimeMinutes: 120,
      bufferMinutes: 15,
      deliveryExpiryDays: 90,
      clientCancelCutoffHours: 24,
      bookingFeeRefundableOnClientCancel: true,
    })

    expect(values).toEqual({
      bookingFeePercent: '37.5',
      minLeadTimeMinutes: '120',
      bufferMinutes: '15',
      deliveryExpiryDays: '90',
      clientCancelCutoffHours: '24',
      bookingFeeRefundableOnClientCancel: true,
    })
  })

  it('shows a round rate without a trailing decimal', () => {
    const values = settingsFormValues({
      bookingFeeRate: 0.4,
      minLeadTimeMinutes: 0,
      bufferMinutes: 0,
      deliveryExpiryDays: 1,
      clientCancelCutoffHours: 0,
      bookingFeeRefundableOnClientCancel: false,
    })

    expect(values.bookingFeePercent).toBe('40')
  })

  it('round-trips the stored settings through the form unchanged', () => {
    const stored = {
      bookingFeeRate: 0.375,
      minLeadTimeMinutes: 1440,
      bufferMinutes: 30,
      deliveryExpiryDays: 365,
      clientCancelCutoffHours: 72,
      bookingFeeRefundableOnClientCancel: true,
    }

    expect(settingsFormSchema.safeParse(settingsFormValues(stored)).data).toEqual(stored)
  })

  it('renders every field and checkbox the page asks for', () => {
    const values = settingsFormValues({
      bookingFeeRate: 0.4,
      minLeadTimeMinutes: 120,
      bufferMinutes: 15,
      deliveryExpiryDays: 90,
      clientCancelCutoffHours: 0,
      bookingFeeRefundableOnClientCancel: false,
    })

    expect(Object.keys(values).sort()).toEqual([...SETTINGS_FIELDS, ...SETTINGS_TOGGLES].sort())
  })
})
