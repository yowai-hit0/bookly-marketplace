import { z } from 'zod'
import { adminFetch } from './api'

/**
 * The operating values the photographer can change (plan.md Task 8, spec
 * P-30), and the cancellation policy their clients book under (R1.8).
 * Everything else that looks like a setting is a constant in the API,
 * deliberately: a setting with no screen behind it is a value that drifts from
 * the code that reads it. How long a checkout hold lasts is the platform's
 * (marketplace brief decision 5), so it is not here.
 *
 * Nothing already booked moves when these change. A booking snapshots its own
 * buffer, fee rate and cancellation policy when it is created, so a new value
 * applies to new bookings only -- which the page says in as many words.
 */

export type AdminSettings = {
  /** 0 to 1, three decimal places, as `numeric(4,3)` stores it. */
  bookingFeeRate: number
  minLeadTimeMinutes: number
  bufferMinutes: number
  deliveryExpiryDays: number
  /** A client may cancel until this many hours before the shoot; 0 = any time before it. */
  clientCancelCutoffHours: number
  /** Whether a client's own cancellation refunds the booking fee. The photographer cancelling always does. */
  bookingFeeRefundableOnClientCancel: boolean
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
    bufferMinutes: wholeNumber(0),
    deliveryExpiryDays: wholeNumber(1),
    clientCancelCutoffHours: wholeNumber(0),
    bookingFeeRefundableOnClientCancel: z.boolean(),
  })
  .transform(({ bookingFeePercent, ...rest }): SettingsPayload => ({
    ...rest,
    bookingFeeRate: Number((bookingFeePercent / 100).toFixed(3)),
  }))

export type SettingsFormValues = {
  bookingFeePercent: string
  minLeadTimeMinutes: string
  bufferMinutes: string
  deliveryExpiryDays: string
  clientCancelCutoffHours: string
  bookingFeeRefundableOnClientCancel: boolean
}

export function settingsFormValues(settings: AdminSettings): SettingsFormValues {
  return {
    bookingFeePercent: String(Number((settings.bookingFeeRate * 100).toFixed(1))),
    minLeadTimeMinutes: String(settings.minLeadTimeMinutes),
    bufferMinutes: String(settings.bufferMinutes),
    deliveryExpiryDays: String(settings.deliveryExpiryDays),
    clientCancelCutoffHours: String(settings.clientCancelCutoffHours),
    bookingFeeRefundableOnClientCancel: settings.bookingFeeRefundableOnClientCancel,
  }
}

/** The typed fields, in the order the page renders them. */
export const SETTINGS_FIELDS = [
  'bookingFeePercent',
  'minLeadTimeMinutes',
  'bufferMinutes',
  'deliveryExpiryDays',
  'clientCancelCutoffHours',
] as const

/** The yes/no settings, each a checkbox after the typed fields. */
export const SETTINGS_TOGGLES = ['bookingFeeRefundableOnClientCancel'] as const

export type SettingsField = (typeof SETTINGS_FIELDS)[number] | (typeof SETTINGS_TOGGLES)[number]

/** The API names the stored value; the form names what he types. */
export const FORM_FIELD_FOR: Record<string, SettingsField> = { bookingFeeRate: 'bookingFeePercent' }
