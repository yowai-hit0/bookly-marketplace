import { z } from 'zod'
import { adminFetch } from './api'

/**
 * The five operating values the photographer can change (plan.md Task 8, spec
 * P-30). Everything else that looks like a setting is a constant in the API,
 * deliberately: a setting with no screen behind it is a value that drifts from
 * the code that reads it.
 *
 * Nothing already booked moves when these change. A booking snapshots its own
 * buffer and fee rate when it is created, so a new rate applies to new bookings
 * only -- which the page says in as many words.
 */

export type AdminSettings = {
  /** 0 to 1, three decimal places, as `numeric(4,3)` stores it. */
  bookingFeeRate: number
  minLeadTimeMinutes: number
  holdMinutes: number
  bufferMinutes: number
  deliveryExpiryDays: number
}

export type SettingsPayload = AdminSettings

export const settingsApi = {
  load: () => adminFetch<{ settings: AdminSettings }>('/admin/settings'),
  save: (body: SettingsPayload) =>
    adminFetch<{ settings: AdminSettings }>('/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
}

/** The largest `integer` PostgreSQL stores; past it a write raises 22003. */
const INT4_MAX = 2_147_483_647

/** A whole number typed into a form: digits only, so `1e3` and `40,000` are refused. */
const wholeNumber = (min: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,10}$/)
    .transform(Number)
    .refine((value) => value >= min && value <= INT4_MAX)

/**
 * Typed as a percentage with at most one decimal place, because a rate is
 * stored to three: 37.5% is 0.375 exactly, and 37.55% could not be stored
 * without rounding, so it is refused here rather than silently changed.
 */
const feePercent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d)?$/)
  .transform(Number)
  .refine((value) => value <= 100)

export const settingsFormSchema = z
  .object({
    bookingFeePercent: feePercent,
    minLeadTimeMinutes: wholeNumber(0),
    holdMinutes: wholeNumber(1),
    bufferMinutes: wholeNumber(0),
    deliveryExpiryDays: wholeNumber(1),
  })
  .transform(({ bookingFeePercent, ...rest }): SettingsPayload => ({
    ...rest,
    bookingFeeRate: Number((bookingFeePercent / 100).toFixed(3)),
  }))

export type SettingsFormValues = {
  bookingFeePercent: string
  minLeadTimeMinutes: string
  holdMinutes: string
  bufferMinutes: string
  deliveryExpiryDays: string
}

export function settingsFormValues(settings: AdminSettings): SettingsFormValues {
  return {
    bookingFeePercent: String(Number((settings.bookingFeeRate * 100).toFixed(1))),
    minLeadTimeMinutes: String(settings.minLeadTimeMinutes),
    holdMinutes: String(settings.holdMinutes),
    bufferMinutes: String(settings.bufferMinutes),
    deliveryExpiryDays: String(settings.deliveryExpiryDays),
  }
}

/** The five fields, in the order the page renders them. */
export const SETTINGS_FIELDS = [
  'bookingFeePercent',
  'minLeadTimeMinutes',
  'holdMinutes',
  'bufferMinutes',
  'deliveryExpiryDays',
] as const

export type SettingsField = (typeof SETTINGS_FIELDS)[number]

/** The API names the stored value; the form names what he types. */
export const FORM_FIELD_FOR: Record<string, SettingsField> = { bookingFeeRate: 'bookingFeePercent' }
