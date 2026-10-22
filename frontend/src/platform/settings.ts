import { apiFetch } from '@/auth/api'

/**
 * The platform's settings (marketplace spec Phase 5: R5.1, R5.4;
 * backend/openapi/paths/platform-settings.yaml): the checkout hold, the free
 * trial, the plan's two prices, the grace days and the reminder days. A save
 * sends only what changed, and the API answers every value as stored.
 *
 * The form's bounds mirror the API's, so a value the API would refuse is
 * caught before it is sent; the API's own `422 fields` is still what counts,
 * and is worded field by field, an indexed reminder day (`.2`) included.
 */

export type PlatformSettings = {
  holdMinutes: number
  trialDays: number
  subscriptionMonthlyPriceRwf: number
  subscriptionYearlyPriceRwf: number
  subscriptionGraceDays: number
  /** Largest first, as stored. Empty sends no reminders. */
  subscriptionReminderDays: number[]
}

export type PlatformSettingsUpdate = Partial<PlatformSettings>

export const platformSettingsApi = {
  load: async (): Promise<PlatformSettings> =>
    (await apiFetch<{ settings: PlatformSettings }>('platform', '/platform/settings', { cache: 'no-store' })).settings,
  save: async (update: PlatformSettingsUpdate): Promise<PlatformSettings> =>
    (
      await apiFetch<{ settings: PlatformSettings }>('platform', '/platform/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      })
    ).settings,
}

/** The seed's placeholder prices (backend `PLACEHOLDER_SUBSCRIPTION_PRICES`): to be set for real before launch. */
export const PLACEHOLDER_PRICES = { monthly: 10_000, yearly: 100_000 } as const

/** Whether either price is still the seed's placeholder. */
export function hasPlaceholderPrices(settings: Pick<PlatformSettings, 'subscriptionMonthlyPriceRwf' | 'subscriptionYearlyPriceRwf'>): boolean {
  return (
    settings.subscriptionMonthlyPriceRwf === PLACEHOLDER_PRICES.monthly || settings.subscriptionYearlyPriceRwf === PLACEHOLDER_PRICES.yearly
  )
}

/** The number fields, in the order the page shows them. */
export const NUMBER_FIELDS = [
  'holdMinutes',
  'trialDays',
  'subscriptionMonthlyPriceRwf',
  'subscriptionYearlyPriceRwf',
  'subscriptionGraceDays',
] as const

export type NumberField = (typeof NUMBER_FIELDS)[number]

export type SettingsField = NumberField | 'subscriptionReminderDays'

/** The largest `integer` PostgreSQL stores. */
const INT4_MAX = 2_147_483_647

/** Each number's bounds, as the API checks them. */
export const BOUNDS: Record<NumberField, { min: number; max: number }> = {
  holdMinutes: { min: 1, max: 60 },
  trialDays: { min: 1, max: 366 },
  subscriptionMonthlyPriceRwf: { min: 1, max: INT4_MAX },
  subscriptionYearlyPriceRwf: { min: 1, max: INT4_MAX },
  subscriptionGraceDays: { min: 0, max: 366 },
}

export const REMINDER_DAYS_MAX_COUNT = 10
export const REMINDER_DAY_BOUNDS = { min: 1, max: 366 } as const

/** What is typed, as text: the form keeps every value as the visitor wrote it. */
export type SettingsFormValues = Record<NumberField, string> & { subscriptionReminderDays: string }

export function settingsFormValues(settings: PlatformSettings): SettingsFormValues {
  return {
    holdMinutes: String(settings.holdMinutes),
    trialDays: String(settings.trialDays),
    subscriptionMonthlyPriceRwf: String(settings.subscriptionMonthlyPriceRwf),
    subscriptionYearlyPriceRwf: String(settings.subscriptionYearlyPriceRwf),
    subscriptionGraceDays: String(settings.subscriptionGraceDays),
    subscriptionReminderDays: settings.subscriptionReminderDays.join(', '),
  }
}

/**
 * One problem with what was typed, or with what the API refused: a whole field,
 * or one reminder day by its position (0-based) and the value at it.
 */
export type SettingsProblem = { field: SettingsField } | { field: 'subscriptionReminderDays'; index: number; value: string }

/** A whole number written in digits only, so `1e3`, `4.5` and `40,000` are refused. */
function wholeNumber(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,10}$/.test(trimmed)) return null
  return Number(trimmed)
}

/** The reminder days as typed: numbers separated by commas or spaces. Empty is no reminders. */
export function splitReminderDays(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

export type ParsedSettings = { ok: true; settings: PlatformSettings } | { ok: false; problems: SettingsProblem[] }

/** Checks every field against the API's bounds; on success, the settings as they would be stored. */
export function parseSettingsForm(values: SettingsFormValues): ParsedSettings {
  const problems: SettingsProblem[] = []
  const numbers = {} as Record<NumberField, number>
  for (const field of NUMBER_FIELDS) {
    const value = wholeNumber(values[field])
    const { min, max } = BOUNDS[field]
    if (value === null || value < min || value > max) problems.push({ field })
    else numbers[field] = value
  }

  const parts = splitReminderDays(values.subscriptionReminderDays)
  const days: number[] = []
  let wholeListBad = parts.length > REMINDER_DAYS_MAX_COUNT
  parts.forEach((part, index) => {
    const value = wholeNumber(part)
    if (value === null || value < REMINDER_DAY_BOUNDS.min || value > REMINDER_DAY_BOUNDS.max) {
      problems.push({ field: 'subscriptionReminderDays', index, value: part })
      return
    }
    if (days.includes(value)) wholeListBad = true
    days.push(value)
  })
  if (wholeListBad) problems.push({ field: 'subscriptionReminderDays' })

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, settings: { ...numbers, subscriptionReminderDays: sortReminderDays(days) } }
}

/** Largest first, as the API stores them. */
export function sortReminderDays(days: readonly number[]): number[] {
  return [...days].sort((a, b) => b - a)
}

/** Only what differs from what is stored. Reminder days compare as a set: order is the API's to keep. */
export function changedSettings(stored: PlatformSettings, next: PlatformSettings): PlatformSettingsUpdate {
  const update: PlatformSettingsUpdate = {}
  for (const field of NUMBER_FIELDS) if (next[field] !== stored[field]) update[field] = next[field]
  const before = sortReminderDays(stored.subscriptionReminderDays)
  const after = sortReminderDays(next.subscriptionReminderDays)
  if (before.length !== after.length || before.some((day, index) => day !== after[index])) update.subscriptionReminderDays = after
  return update
}

const SETTINGS_FIELDS: readonly string[] = [...NUMBER_FIELDS, 'subscriptionReminderDays']

/**
 * The API's `422 fields` as problems. `subscriptionReminderDays.<i>` names the
 * element at `i` of the list that was sent, so its value is read back from
 * `sent`; a field this page does not know is dropped (the caller says the save
 * failed when nothing is left).
 */
export function problemsFromFields(fields: readonly string[], sent: PlatformSettingsUpdate): SettingsProblem[] {
  const problems: SettingsProblem[] = []
  for (const field of fields) {
    const indexed = /^subscriptionReminderDays\.(\d+)$/.exec(field)
    if (indexed !== null) {
      const index = Number(indexed[1])
      const value = sent.subscriptionReminderDays?.[index]
      problems.push({ field: 'subscriptionReminderDays', index, value: value === undefined ? '' : String(value) })
      continue
    }
    if (SETTINGS_FIELDS.includes(field)) problems.push({ field: field as SettingsField })
  }
  return problems
}
