import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { readSession, saveSession } from '@/auth/session'
import type { PlatformSettings } from '@/platform/settings'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'

/**
 * `/platform/settings` (marketplace spec Phase 5: R5.1, R5.4, R9.3), through
 * the real routes with `fetch` stubbed: every setting in a field, checked
 * against the API's bounds before anything is sent; only the changed fields
 * sent; the API's refusals worded under their fields, an indexed reminder day
 * by its position and value; the page redrawn from what was stored; and the
 * placeholder-price note while either price is still the seed's.
 */

const URL_ = '/api/platform/settings'
const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

const STORED: PlatformSettings = {
  holdMinutes: 15,
  trialDays: 30,
  subscriptionMonthlyPriceRwf: 10_000,
  subscriptionYearlyPriceRwf: 100_000,
  subscriptionGraceDays: 7,
  subscriptionReminderDays: [7, 3, 1],
}

const REAL_PRICES = { subscriptionMonthlyPriceRwf: 12_000, subscriptionYearlyPriceRwf: 120_000 }

const LABELS = {
  holdMinutes: 'Checkout hold (minutes)',
  trialDays: 'Free trial (days)',
  subscriptionMonthlyPriceRwf: 'Monthly price (RWF)',
  subscriptionYearlyPriceRwf: 'Yearly price (RWF)',
  subscriptionGraceDays: 'Grace after a period ends (days)',
  subscriptionReminderDays: 'Reminders (days before a period ends)',
} as const

const PLACEHOLDER_NOTE =
  'The subscription prices are still the placeholders (10,000 RWF a month, 100,000 RWF a year). Set the real prices before launch.'

type Options = {
  loads?: (() => Response | Promise<Response>)[]
  save?: (call: Sent) => Response | Promise<Response>
}

function api({ loads = [() => json({ settings: STORED })], save }: Options = {}) {
  let load = 0
  return stubApi((call) => {
    if (call.url !== URL_) return undefined
    if (call.method === 'GET') return (loads[Math.min(load++, loads.length - 1)] as () => Response | Promise<Response>)()
    if (call.method === 'PATCH') return save === undefined ? json({ settings: { ...STORED, ...(call.body as object) } }) : save(call)
    return undefined
  })
}

function patches(sent: Sent[]) {
  return sent.filter((call) => call.method === 'PATCH')
}

function renderAt(path = '/platform/settings') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

function field(name: keyof typeof LABELS) {
  return screen.getByLabelText(LABELS[name]) as HTMLInputElement
}

async function loaded() {
  return screen.findByRole('form', { name: 'Settings' })
}

async function type(name: keyof typeof LABELS, value: string) {
  await user().clear(field(name))
  if (value !== '') await user().type(field(name), value)
}

async function save() {
  await user().click(screen.getByRole('button', { name: 'Save changes' }))
}

/** The error sentence under a field, read through its `aria-describedby`. */
function errorOf(name: keyof typeof LABELS): string | null {
  const ids = (field(name).getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id.endsWith('-error'))
  if (ids.length === 0) return null
  return document.getElementById(ids[0] as string)?.textContent ?? null
}

beforeEach(() => {
  saveSession('platform', SESSION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  delete document.documentElement.dataset.adminTheme
})

describe('loading', () => {
  it('announces the wait, then shows every setting in its field, from one GET with the platform token', async () => {
    const { sent } = api()
    renderAt()

    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading the settings…')
    await loaded()

    expect(field('holdMinutes').value).toBe('15')
    expect(field('trialDays').value).toBe('30')
    expect(field('subscriptionMonthlyPriceRwf').value).toBe('10000')
    expect(field('subscriptionYearlyPriceRwf').value).toBe('100000')
    expect(field('subscriptionGraceDays').value).toBe('7')
    expect(field('subscriptionReminderDays').value).toBe('7, 3, 1')
    expect(sent).toEqual([expect.objectContaining({ method: 'GET', url: URL_ })])
    expect(sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
  })

  it('groups the hold under Checkout and the rest under Subscription', async () => {
    api()
    renderAt()
    await loaded()

    const checkout = screen.getByRole('group', { name: 'Checkout' })
    const subscription = screen.getByRole('group', { name: 'Subscription' })
    expect(within(checkout).getAllByRole('textbox')).toHaveLength(1)
    expect(within(subscription).getAllByRole('textbox')).toHaveLength(5)
  })

  it('says a failed load, and loads again on "Try again"', async () => {
    const { sent } = api({ loads: [() => json({ error: 'internal_error' }, 500), () => json({ settings: STORED })] })
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the settings. Check your connection and try again.')
    await user().click(screen.getByRole('button', { name: 'Try again' }))

    await loaded()
    expect(sent.filter((call) => call.method === 'GET')).toHaveLength(2)
  })

  it('on a 401 drops the platform session and goes to its sign in', async () => {
    api({ loads: [() => json({ error: 'invalid_token' }, 401)] })
    const router = renderAt()

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
    expect(readSession('platform')).toBeNull()
  })
})

describe('the placeholder prices', () => {
  it('says to set the real prices before launch while they are the placeholders', async () => {
    api()
    renderAt()
    await loaded()

    expect(document.querySelector('[data-placeholder-prices]')).toHaveTextContent(PLACEHOLDER_NOTE)
  })

  it.each([
    [{ subscriptionMonthlyPriceRwf: 12_000 }],
    [{ subscriptionYearlyPriceRwf: 120_000 }],
  ])('still says it while one price is a placeholder: %j', async (prices) => {
    api({ loads: [() => json({ settings: { ...STORED, ...prices } })] })
    renderAt()
    await loaded()

    expect(document.querySelector('[data-placeholder-prices]')).not.toBeNull()
  })

  it('says nothing once both are set', async () => {
    api({ loads: [() => json({ settings: { ...STORED, ...REAL_PRICES } })] })
    renderAt()
    await loaded()

    expect(document.querySelector('[data-placeholder-prices]')).toBeNull()
    expect(screen.queryByText(/placeholders/)).not.toBeInTheDocument()
  })

  it('goes once the real prices are saved', async () => {
    api()
    renderAt()
    await loaded()

    await type('subscriptionMonthlyPriceRwf', '12000')
    await type('subscriptionYearlyPriceRwf', '120000')
    await save()

    await screen.findByText('Settings saved.')
    expect(document.querySelector('[data-placeholder-prices]')).toBeNull()
  })
})

describe('checking before saving', () => {
  it.each([
    ['holdMinutes', '0', 'Enter a whole number of minutes from 1 to 60.'],
    ['holdMinutes', '61', 'Enter a whole number of minutes from 1 to 60.'],
    ['trialDays', '0', 'Enter a whole number of days from 1 to 366.'],
    ['trialDays', '367', 'Enter a whole number of days from 1 to 366.'],
    ['subscriptionMonthlyPriceRwf', '0', 'Enter a whole number of RWF, 1 or more.'],
    ['subscriptionMonthlyPriceRwf', '10,000', 'Enter a whole number of RWF, 1 or more.'],
    ['subscriptionYearlyPriceRwf', '', 'Enter a whole number of RWF, 1 or more.'],
    ['subscriptionGraceDays', '367', 'Enter a whole number of days from 0 to 366.'],
    ['subscriptionGraceDays', '1.5', 'Enter a whole number of days from 0 to 366.'],
    ['subscriptionReminderDays', '7, 7', 'Enter at most 10 different whole numbers from 1 to 366, separated by commas.'],
    ['subscriptionReminderDays', '1,2,3,4,5,6,7,8,9,10,11', 'Enter at most 10 different whole numbers from 1 to 366, separated by commas.'],
    ['subscriptionReminderDays', '7, 0, 1', 'Reminder 2 (0) must be a whole number of days from 1 to 366.'],
    ['subscriptionReminderDays', '400', 'Reminder 1 (400) must be a whole number of days from 1 to 366.'],
  ] as const)('refuses %s = %j in words, sending nothing', async (name, value, words) => {
    const { sent } = api()
    renderAt()
    await loaded()

    await type(name, value)
    await save()

    await waitFor(() => expect(errorOf(name)).toBe(words))
    expect(field(name)).toHaveAttribute('aria-invalid', 'true')
    expect(patches(sent)).toEqual([])
  })

  it('names every bad reminder day at once', async () => {
    api()
    renderAt()
    await loaded()

    await type('subscriptionReminderDays', '0, 3, abc')
    await save()

    await waitFor(() =>
      expect(errorOf('subscriptionReminderDays')).toBe(
        'Reminder 1 (0) must be a whole number of days from 1 to 366. Reminder 3 (abc) must be a whole number of days from 1 to 366.',
      ),
    )
  })

  it('accepts the edges of every bound', async () => {
    const { sent } = api()
    renderAt()
    await loaded()

    await type('holdMinutes', '60')
    await type('trialDays', '366')
    await type('subscriptionGraceDays', '0')
    await type('subscriptionReminderDays', '366, 1')
    await save()

    await waitFor(() => expect(patches(sent)).toHaveLength(1))
    expect(patches(sent)[0]?.body).toEqual({ holdMinutes: 60, trialDays: 366, subscriptionGraceDays: 0, subscriptionReminderDays: [366, 1] })
  })

  it('clears the errors once the values are right', async () => {
    api()
    renderAt()
    await loaded()

    await type('holdMinutes', '0')
    await save()
    await waitFor(() => expect(errorOf('holdMinutes')).not.toBeNull())

    await type('holdMinutes', '20')
    await save()

    await screen.findByText('Settings saved.')
    expect(errorOf('holdMinutes')).toBeNull()
  })
})

describe('saving', () => {
  it('sends only the field that changed', async () => {
    const { sent } = api()
    renderAt()
    await loaded()

    await type('trialDays', '14')
    await save()

    await screen.findByText('Settings saved.')
    expect(patches(sent)).toEqual([expect.objectContaining({ url: URL_, body: { trialDays: 14 } })])
    expect(patches(sent)[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
  })

  it('sends nothing when nothing changed, and says so', async () => {
    const { sent } = api()
    renderAt()
    await loaded()

    await save()

    expect(await screen.findByText('Nothing has changed, so nothing was saved.')).toBeInTheDocument()
    expect(patches(sent)).toEqual([])
  })

  it('reads the same reminder days in another order as no change', async () => {
    const { sent } = api()
    renderAt()
    await loaded()

    await type('subscriptionReminderDays', '1 3 7')
    await save()

    expect(await screen.findByText('Nothing has changed, so nothing was saved.')).toBeInTheDocument()
    expect(patches(sent)).toEqual([])
  })

  it('sends emptied reminder days as an empty list', async () => {
    const { sent } = api()
    renderAt()
    await loaded()

    await type('subscriptionReminderDays', '')
    await save()

    await screen.findByText('Settings saved.')
    expect(patches(sent)[0]?.body).toEqual({ subscriptionReminderDays: [] })
  })

  it('redraws every field from what the API stored, not from what was typed', async () => {
    api({ save: () => json({ settings: { ...STORED, subscriptionReminderDays: [14, 7], holdMinutes: 20 } }) })
    renderAt()
    await loaded()

    await type('subscriptionReminderDays', '7,14')
    await save()

    await screen.findByText('Settings saved.')
    expect(field('subscriptionReminderDays').value).toBe('14, 7')
    expect(field('holdMinutes').value).toBe('20')
  })

  it('words each field the API refuses, an indexed reminder day by its position and the value sent', async () => {
    api({ save: () => json({ error: 'validation_failed', fields: ['trialDays', 'subscriptionReminderDays.1'] }, 422) })
    renderAt()
    await loaded()

    await type('trialDays', '45')
    await type('subscriptionReminderDays', '3, 10')
    await save()

    // Sent largest first, [10, 3]: position 2 is the 3.
    await waitFor(() => expect(errorOf('subscriptionReminderDays')).toBe('Reminder 2 (3) must be a whole number of days from 1 to 366.'))
    expect(errorOf('trialDays')).toBe('Enter a whole number of days from 1 to 366.')
    expect(screen.queryByText('Settings saved.')).not.toBeInTheDocument()
    // What was typed stays to be fixed.
    expect(field('trialDays').value).toBe('45')
  })

  it('words the whole reminder list when the API refuses it as a whole', async () => {
    api({ save: () => json({ error: 'validation_failed', fields: ['subscriptionReminderDays'] }, 422) })
    renderAt()
    await loaded()

    await type('subscriptionReminderDays', '5')
    await save()

    await waitFor(() =>
      expect(errorOf('subscriptionReminderDays')).toBe('Enter at most 10 different whole numbers from 1 to 366, separated by commas.'),
    )
  })

  it.each<[string, () => Response | Promise<Response>, string]>([
    ['a 400', () => json({ error: 'invalid_request' }, 400), 'The settings were not saved: the change could not be read. Reload the page and try again.'],
    ['a 422 naming no field the page has', () => json({ error: 'validation_failed', fields: ['other'] }, 422), 'The settings were not saved. Check your connection and try again.'],
    ['a 500', () => json({ error: 'internal_error' }, 500), 'The settings were not saved. Check your connection and try again.'],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch')), 'The settings were not saved. Check your connection and try again.'],
  ])('says %s in words, keeping what was typed', async (_label, respond, words) => {
    api({ save: respond })
    renderAt()
    await loaded()

    await type('holdMinutes', '25')
    await save()

    expect(await screen.findByRole('alert')).toHaveTextContent(words)
    expect(field('holdMinutes').value).toBe('25')
    expect(screen.queryByText('Settings saved.')).not.toBeInTheDocument()
  })

  it('on a 401 drops the session and goes to sign in', async () => {
    api({ save: () => json({ error: 'invalid_token' }, 401) })
    const router = renderAt()
    await loaded()

    await type('holdMinutes', '25')
    await save()

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
    expect(readSession('platform')).toBeNull()
  })
})
