import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { saveSession } from '@/admin/session'
import type { AdminSettings as Settings } from '@/admin/settings'
import { routes } from '@/routes'

/**
 * The settings page (plan.md Task 8, spec P-30), rendered through the real
 * routes with `fetch` stubbed.
 *
 * What is proven: the five stored values arrive in the form; the fee is typed
 * as a percentage and sent as a rate; a value the column could not hold never
 * leaves the browser; the API's own refusal lands on the field it names; and a
 * save redraws the form from what was stored rather than what was typed.
 */

const NOW = new Date('2026-10-07T08:00:00.000Z')
const TOKEN = 'header.payload.signature'
const SETTINGS_API = '/api/admin/settings'

const STORED: Settings = {
  bookingFeeRate: 0.4,
  minLeadTimeMinutes: 120,
  holdMinutes: 30,
  bufferMinutes: 15,
  deliveryExpiryDays: 90,
}

type Sent = { method: string; url: string; body: unknown }
type Route = (sent: Sent) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubApi(overrides: Record<string, Route> = {}, stored: Settings = STORED) {
  const api = { settings: stored, sent: [] as Sent[] }
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const sent: Sent = {
      method: init.method ?? 'GET',
      url: String(input),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    }
    api.sent.push(sent)
    const route = overrides[`${sent.method} ${sent.url}`]
    if (route !== undefined) return route(sent)
    if (sent.method === 'GET' && sent.url === SETTINGS_API) return json({ settings: api.settings })
    if (sent.method === 'PATCH' && sent.url === SETTINGS_API) {
      api.settings = { ...api.settings, ...(sent.body as Partial<Settings>) }
      return json({ settings: api.settings })
    }
    return json({})
  })
  vi.stubGlobal('fetch', mock)
  return api
}

type Api = ReturnType<typeof stubApi>

const writes = (api: Api) => api.sent.filter((sent) => sent.method !== 'GET')

function renderPage() {
  saveSession({ token: TOKEN, expiresAt: '2026-10-07T16:00:00.000Z' })
  const router = createMemoryRouter(routes, { initialEntries: ['/admin/settings'] })
  render(<RouterProvider router={router} />)
  return router
}

const user = () => userEvent.setup({ delay: null })

const field = (name: string) => screen.getByLabelText(name)

async function retype(name: string, value: string) {
  const input = field(name)
  await user().clear(input)
  await user().type(input, value)
}

const save = () => user().click(screen.getByRole('button', { name: 'Save settings' }))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('AdminSettings', () => {
  it('fills the form from the stored settings, showing the fee as a percentage', async () => {
    stubApi()
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(field('Booking fee (%)')).toHaveValue('40')
    expect(field('Minimum notice (minutes)')).toHaveValue('120')
    expect(field('Hold time (minutes)')).toHaveValue('30')
    expect(field('Buffer between shoots (minutes)')).toHaveValue('15')
    expect(field('Photo link lasts (days)')).toHaveValue('90')
  })

  it('says the change applies to new bookings only', async () => {
    stubApi()
    renderPage()

    await screen.findByRole('heading', { name: 'Settings' })
    expect(screen.getByText(/anything already booked keeps the fee and buffer it was sold/i)).toBeInTheDocument()
  })

  it('sends all five values, the fee as a rate rather than a percentage', async () => {
    const api = stubApi()
    renderPage()

    await screen.findByRole('heading', { name: 'Settings' })
    await retype('Booking fee (%)', '37.5')
    await retype('Hold time (minutes)', '45')
    await save()

    await waitFor(() => expect(writes(api)).toHaveLength(1))
    expect(writes(api)[0]).toMatchObject({
      method: 'PATCH',
      url: SETTINGS_API,
      body: {
        bookingFeeRate: 0.375,
        minLeadTimeMinutes: 120,
        holdMinutes: 45,
        bufferMinutes: 15,
        deliveryExpiryDays: 90,
      },
    })
  })

  it('confirms the save and redraws the form from what the API stored', async () => {
    const api = stubApi({
      // The API answers with a value of its own, which is what must be shown.
      'PATCH /api/admin/settings': () => json({ settings: { ...STORED, holdMinutes: 25 } }),
    })
    renderPage()

    await screen.findByRole('heading', { name: 'Settings' })
    await retype('Hold time (minutes)', '45')
    await save()

    expect(await screen.findByText('Settings saved.')).toBeInTheDocument()
    expect(field('Hold time (minutes)')).toHaveValue('25')
    expect(writes(api)).toHaveLength(1)
  })

  it.each<[string, string, string, string]>([
    ['a fee above 100%', 'Booking fee (%)', '120', 'Enter a percentage from 0 to 100, with at most one decimal place.'],
    [
      'a second decimal place',
      'Booking fee (%)',
      '37.55',
      'Enter a percentage from 0 to 100, with at most one decimal place.',
    ],
    ['a hold of zero', 'Hold time (minutes)', '0', 'Enter a whole number of minutes, 1 or more.'],
    ['a fractional buffer', 'Buffer between shoots (minutes)', '15.5', 'Enter a whole number of minutes, 0 or more.'],
  ])('refuses %s in the browser, marking the field and sending nothing', async (_label, label, value, message) => {
    const api = stubApi()
    renderPage()

    await screen.findByRole('heading', { name: 'Settings' })
    await retype(label, value)
    await save()

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(field(label)).toHaveAttribute('aria-invalid', 'true')
    expect(writes(api)).toHaveLength(0)
  })

  it('marks the field a 422 names, mapping the stored rate back to the typed percentage', async () => {
    stubApi({
      'PATCH /api/admin/settings': () => json({ error: 'validation_failed', fields: ['bookingFeeRate'] }, 422),
    })
    renderPage()

    await screen.findByRole('heading', { name: 'Settings' })
    await save()

    await waitFor(() => expect(field('Booking fee (%)')).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByText('Enter a percentage from 0 to 100, with at most one decimal place.')).toBeInTheDocument()
  })

  it('says so when the save fails for a reason it cannot place on a field', async () => {
    stubApi({ 'PATCH /api/admin/settings': () => json({ error: 'internal_error' }, 500) })
    renderPage()

    await screen.findByRole('heading', { name: 'Settings' })
    await save()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the settings. Try again.')
  })

  it('offers a retry when the settings cannot be loaded, and shows them once it works', async () => {
    let fail = true
    stubApi({
      'GET /api/admin/settings': () => (fail ? json({ error: 'internal_error' }, 500) : json({ settings: STORED })),
    })
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the settings.')

    fail = false
    await user().click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByLabelText('Booking fee (%)')).toHaveValue('40')
  })

  it('sends him to sign in when the token has gone stale', async () => {
    stubApi({ 'GET /api/admin/settings': () => json({ error: 'unauthenticated' }, 401) })
    const router = renderPage()

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'))
    expect(sessionStorage.length).toBe(0)
  })
})
