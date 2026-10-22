import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnauthenticatedError } from '@/auth/api'
import { readSession, saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import {
  BOUNDS,
  type PlatformSettings,
  type SettingsFormValues,
  changedSettings,
  hasPlaceholderPrices,
  parseSettingsForm,
  platformSettingsApi,
  problemsFromFields,
  settingsFormValues,
  splitReminderDays,
} from './settings'

/**
 * The platform settings client (marketplace spec Phase 5: R5.1, R5.4): the
 * form's checks mirror the API's bounds exactly, a save sends only what
 * changed, and the API's `422 fields` -- an indexed reminder day included --
 * become problems the page can word.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

const STORED: PlatformSettings = {
  holdMinutes: 15,
  trialDays: 30,
  subscriptionMonthlyPriceRwf: 10_000,
  subscriptionYearlyPriceRwf: 100_000,
  subscriptionGraceDays: 7,
  subscriptionReminderDays: [7, 3, 1],
}

function form(overrides: Partial<SettingsFormValues> = {}): SettingsFormValues {
  return { ...settingsFormValues(STORED), ...overrides }
}

beforeEach(() => {
  saveSession('platform', SESSION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('platformSettingsApi', () => {
  it('loads with the platform token, never from the cache', async () => {
    const api = stubApi(() => json({ settings: STORED }))

    await expect(platformSettingsApi.load()).resolves.toEqual(STORED)
    expect(api.sent).toEqual([expect.objectContaining({ method: 'GET', url: '/api/platform/settings' })])
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
    expect(api.mock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' })
  })

  it('saves with a PATCH of exactly the update, and answers the stored settings', async () => {
    const api = stubApi(() => json({ settings: { ...STORED, trialDays: 14 } }))

    await expect(platformSettingsApi.save({ trialDays: 14 })).resolves.toMatchObject({ trialDays: 14 })
    expect(api.sent[0]).toMatchObject({ method: 'PATCH', url: '/api/platform/settings', body: { trialDays: 14 } })
    expect(api.sent[0]?.headers.get('Content-Type')).toBe('application/json')
  })

  it('carries the API refusal: the code and the fields', async () => {
    stubApi(() => json({ error: 'validation_failed', fields: ['holdMinutes', 'subscriptionReminderDays.2'] }, 422))

    await expect(platformSettingsApi.save({ holdMinutes: 61 })).rejects.toMatchObject({
      status: 422,
      message: 'validation_failed',
      fields: ['holdMinutes', 'subscriptionReminderDays.2'],
    })
  })

  it('on a 401 drops the platform session alone', async () => {
    saveSession('studio', SESSION)
    stubApi(() => json({ error: 'invalid_token' }, 401))

    await expect(platformSettingsApi.load()).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(readSession('platform')).toBeNull()
    expect(readSession('studio')).not.toBeNull()
  })
})

describe('settingsFormValues', () => {
  it('writes every value as text, the reminder days separated by commas', () => {
    expect(settingsFormValues(STORED)).toEqual({
      holdMinutes: '15',
      trialDays: '30',
      subscriptionMonthlyPriceRwf: '10000',
      subscriptionYearlyPriceRwf: '100000',
      subscriptionGraceDays: '7',
      subscriptionReminderDays: '7, 3, 1',
    })
  })

  it('writes no reminder days as an empty field', () => {
    expect(settingsFormValues({ ...STORED, subscriptionReminderDays: [] }).subscriptionReminderDays).toBe('')
  })
})

describe('parseSettingsForm: the bounds the API checks', () => {
  it('accepts what is stored, as it is stored', () => {
    expect(parseSettingsForm(form())).toEqual({ ok: true, settings: STORED })
  })

  it.each([
    ['holdMinutes', '1'],
    ['holdMinutes', '60'],
    ['trialDays', '1'],
    ['trialDays', '366'],
    ['subscriptionMonthlyPriceRwf', '1'],
    ['subscriptionMonthlyPriceRwf', '2147483647'],
    ['subscriptionYearlyPriceRwf', '1'],
    ['subscriptionYearlyPriceRwf', '2147483647'],
    ['subscriptionGraceDays', '0'],
    ['subscriptionGraceDays', '366'],
    ['holdMinutes', ' 30 '],
  ] as const)('accepts %s = %j, the edge of its bounds', (field, value) => {
    const parsed = parseSettingsForm(form({ [field]: value }))
    expect(parsed.ok).toBe(true)
  })

  it.each([
    ['holdMinutes', '0'],
    ['holdMinutes', '61'],
    ['trialDays', '0'],
    ['trialDays', '367'],
    ['subscriptionMonthlyPriceRwf', '0'],
    ['subscriptionMonthlyPriceRwf', '2147483648'],
    ['subscriptionYearlyPriceRwf', '0'],
    ['subscriptionGraceDays', '367'],
    ['subscriptionGraceDays', '-1'],
    ['holdMinutes', ''],
    ['holdMinutes', '1.5'],
    ['subscriptionMonthlyPriceRwf', '10,000'],
    ['subscriptionMonthlyPriceRwf', '1e4'],
    ['trialDays', 'thirty'],
  ] as const)('refuses %s = %j', (field, value) => {
    expect(parseSettingsForm(form({ [field]: value }))).toEqual({ ok: false, problems: [{ field }] })
  })

  it('says every field that is wrong at once', () => {
    const parsed = parseSettingsForm(form({ holdMinutes: '0', subscriptionGraceDays: '400' }))
    expect(parsed).toEqual({ ok: false, problems: [{ field: 'holdMinutes' }, { field: 'subscriptionGraceDays' }] })
  })

  it('mirrors the API bounds', () => {
    expect(BOUNDS).toEqual({
      holdMinutes: { min: 1, max: 60 },
      trialDays: { min: 1, max: 366 },
      subscriptionMonthlyPriceRwf: { min: 1, max: 2_147_483_647 },
      subscriptionYearlyPriceRwf: { min: 1, max: 2_147_483_647 },
      subscriptionGraceDays: { min: 0, max: 366 },
    })
  })
})

describe('parseSettingsForm: the reminder days', () => {
  it.each([
    ['7, 3, 1', [7, 3, 1]],
    ['1,3,7', [7, 3, 1]],
    ['1 3 7', [7, 3, 1]],
    [' 14 ,  7 ', [14, 7]],
    ['', []],
    ['  ,  ', []],
    ['366', [366]],
    ['1,2,3,4,5,6,7,8,9,10', [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]],
  ])('reads %j as %j, largest first', (text, days) => {
    const parsed = parseSettingsForm(form({ subscriptionReminderDays: text }))
    expect(parsed).toEqual({ ok: true, settings: { ...STORED, subscriptionReminderDays: days } })
  })

  it('names each bad day by its position and its value', () => {
    const parsed = parseSettingsForm(form({ subscriptionReminderDays: '7, 0, 3, 400, x' }))
    expect(parsed).toEqual({
      ok: false,
      problems: [
        { field: 'subscriptionReminderDays', index: 1, value: '0' },
        { field: 'subscriptionReminderDays', index: 3, value: '400' },
        { field: 'subscriptionReminderDays', index: 4, value: 'x' },
      ],
    })
  })

  it('refuses more than ten days as a whole', () => {
    expect(parseSettingsForm(form({ subscriptionReminderDays: '1,2,3,4,5,6,7,8,9,10,11' }))).toEqual({
      ok: false,
      problems: [{ field: 'subscriptionReminderDays' }],
    })
  })

  it('refuses a day given twice as a whole', () => {
    expect(parseSettingsForm(form({ subscriptionReminderDays: '7, 3, 7' }))).toEqual({
      ok: false,
      problems: [{ field: 'subscriptionReminderDays' }],
    })
  })

  it('splits on commas and spaces, dropping the empty parts', () => {
    expect(splitReminderDays(' 7,,3 ,1 ')).toEqual(['7', '3', '1'])
    expect(splitReminderDays('')).toEqual([])
  })
})

describe('changedSettings: only what changed is sent', () => {
  it('is empty when nothing changed', () => {
    expect(changedSettings(STORED, STORED)).toEqual({})
  })

  it('names one changed number alone', () => {
    expect(changedSettings(STORED, { ...STORED, subscriptionMonthlyPriceRwf: 12_000 })).toEqual({ subscriptionMonthlyPriceRwf: 12_000 })
  })

  it('names every change', () => {
    expect(changedSettings(STORED, { ...STORED, holdMinutes: 20, subscriptionGraceDays: 0, subscriptionReminderDays: [14] })).toEqual({
      holdMinutes: 20,
      subscriptionGraceDays: 0,
      subscriptionReminderDays: [14],
    })
  })

  it('reads the same days in another order as unchanged', () => {
    expect(changedSettings(STORED, { ...STORED, subscriptionReminderDays: [1, 7, 3] })).toEqual({})
  })

  it('sends an emptied list as an empty list', () => {
    expect(changedSettings(STORED, { ...STORED, subscriptionReminderDays: [] })).toEqual({ subscriptionReminderDays: [] })
  })
})

describe('problemsFromFields', () => {
  it('names each known field', () => {
    expect(problemsFromFields(['holdMinutes', 'trialDays', 'subscriptionReminderDays'], {})).toEqual([
      { field: 'holdMinutes' },
      { field: 'trialDays' },
      { field: 'subscriptionReminderDays' },
    ])
  })

  it('reads an indexed reminder day back from what was sent', () => {
    expect(problemsFromFields(['subscriptionReminderDays.0', 'subscriptionReminderDays.2'], { subscriptionReminderDays: [400, 7, 0] })).toEqual([
      { field: 'subscriptionReminderDays', index: 0, value: '400' },
      { field: 'subscriptionReminderDays', index: 2, value: '0' },
    ])
  })

  it('keeps an indexed day it did not send, with no value', () => {
    expect(problemsFromFields(['subscriptionReminderDays.5'], { subscriptionReminderDays: [7] })).toEqual([
      { field: 'subscriptionReminderDays', index: 5, value: '' },
    ])
  })

  it('drops a field the page does not know', () => {
    expect(problemsFromFields(['somethingElse', 'subscriptionReminderDays.x', 'holdMinutes.1'], {})).toEqual([])
  })
})

describe('hasPlaceholderPrices', () => {
  it.each([
    [10_000, 100_000, true],
    [10_000, 90_000, true],
    [12_000, 100_000, true],
    [12_000, 120_000, false],
  ])('monthly %s and yearly %s: %s', (monthly, yearly, placeholder) => {
    expect(hasPlaceholderPrices({ subscriptionMonthlyPriceRwf: monthly, subscriptionYearlyPriceRwf: yearly })).toBe(placeholder)
  })
})
